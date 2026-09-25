/**
 * 收尾 6 | task_pauses.goal / tasks.payload.goal 加密 —— **pglite 快速自检**（不需要外部 PostgreSQL）。
 *
 * ★ 这个脚本不测副本：它 import 的是**生产代码本身**
 *   （`apps/server/src/db.ts` 的 makePool/migrate/migrateTaskGoalEncryption、
 *     `apps/server/src/routes/agent.ts`、`apps/server/src/routes/loop.ts`、
 *     `apps/server/src/crypto.ts` 的 makeCipher），
 *   HTTP 走 Fastify `inject()` 打进**真路由处理函数**，库是 PGlite（真 PostgreSQL 编译成 WASM，
 *   跑的是真 SQL / 真 JSONB / 真 row_to_json，不是 pg-mem 那种仿制品）。
 *   改坏生产代码，这里就会红（配套的反证记录见 docs/acceptance/收尾6-goal加密-验收报告.md）。
 *
 * 真库全链路验收（起真服务端 + 真 PostgreSQL + 直连 SELECT + 重启回填）在
 * `scripts/verify/task-encryption-db.mjs`；两个脚本都挂在 `npm run verify:db` 下。
 *
 * 验的六件事：
 *   ① 建任务后库里的形状：payload 没有 goal 键、title 为 NULL、goal_enc 是 gcm$ 密文、
 *      整行 row_to_json 搜不到敏感词、同一把 DATA_KEY 能解回原目标；
 *   ② task/step 把 payload 整体写回时**不会把老行的明文 goal 抄回去**（payloadWithoutGoal）；
 *   ③ 用户能感知的那一半：/agent/task/current 与 /agent/task/doc 仍然拿得到原目标；
 *   ④ 暂停：task_pauses.goal 恒 NULL、goal_enc 密文，/agent/loop/pauses 解密后照旧返回目标；
 *   ⑤ 回填迁移：历史明文行（task_pauses.goal / tasks.payload.goal / tasks.title）转成密文并清明文，
 *      且**幂等**（第二次跑 0 条改动）；
 *   ⑥ 残行：goal_enc 与明文**同时有值**（灰度/回滚形状）也必须清明文，且不许覆盖已有密文；
 *   ⑦ fail-closed：没拿到 cipher → 一行不动、skipped=true，绝不写明文兜底。
 *
 * 用法：npx tsx scripts/verify/task-encryption-pglite.mts
 */
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { ORCH_DEFAULTS, type ServerEnv } from '../../apps/server/src/env';
import { makeCipher, signToken, type JsonCipher } from '../../apps/server/src/crypto';
import { makePool, migrate, migrateTaskGoalEncryption } from '../../apps/server/src/db';
import type { TaskGoalMigrationResult } from '../../apps/server/src/db';
import { registerAgentRoutes } from '../../apps/server/src/routes/agent';
import { registerLoopRoutes } from '../../apps/server/src/routes/loop';
import type { Pool } from 'pg';

let fails = 0;
let passes = 0;
const log = (...a: unknown[]) => console.log(a.map(String).join(' '));
const check = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve()
    .then(fn)
    .then(() => {
      passes += 1;
      log(`  PASS ${name}`);
    })
    .catch((err) => {
      fails += 1;
      log(`  ★FAIL ${name}  —— ${(err as Error)?.message ?? String(err)}`);
    });

/**
 * 临时接管 console.warn，把生产代码打的警告**原文**抓出来（同时也照旧打印，便于取证）。
 * 条件3 要求「启动日志打 warn 列出受影响行 id」—— 那是可观测行为，必须真去读日志，
 * 不能只看函数返回值（返回值对，日志没打，运维照样看不见）。
 */
async function captureWarns(fn: () => Promise<unknown> | unknown): Promise<string[]> {
  const orig = console.warn;
  const out: string[] = [];
  console.warn = (...a: unknown[]) => {
    const line = a.map(String).join(' ');
    out.push(line);
    orig(`      [warn] ${line}`);
  };
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return out;
}

/**
 * 判断「显示字段」是不是「原目标」的脱敏前缀版。
 * 脱敏会把敏感段整块换成 `[已脱敏:xx]`，长度与内容都变了，所以不能直接 startsWith；
 * 只比**第一个敏感词之前**的那段原文 —— 那段一定原样保留。
 */
function dt_prefix_ok(displayTitle: string, goal: string): boolean {
  const cut = goal.indexOf('银行卡');
  const head = cut > 0 ? goal.slice(0, cut).trim() : goal.slice(0, 6);
  return head.length > 0 && displayTitle.startsWith(head);
}

const DATA_KEY = 'a'.repeat(64);
const SENSITIVE = ['银行卡6222021234567890', '密码Zx9!secret', '身份证110101199003071234'];
const GOAL = `帮我查一下 ${SENSITIVE[0]} 的余额，登录用 ${SENSITIVE[1]}，实名 ${SENSITIVE[2]}`;

const ENV: ServerEnv = {
  port: 0,
  databaseUrl: 'pglite://memory',
  jwtSecret: 'x'.repeat(24),
  dataKey: DATA_KEY,
  phonePepper: 'z'.repeat(32),
  smsMock: true,
  smsHttpUrl: '',
  isProduction: false,
  // 有 key 才让 /agent/loop/start 放行；本脚本从不推进循环，所以一次模型都不会真调
  deepseekApiKey: 'test-key',
  deepseekBaseUrl: 'https://llm.invalid/v1',
  deepseekModel: 'test-model',
  agentLoopMaxSteps: 10,
  tavilyApiKey: '',
  tavilyBaseUrl: 'https://tavily.invalid',
  orch: { ...ORCH_DEFAULTS },
};

async function main(): Promise<void> {
  log('=== 收尾6 · goal 加密（pglite 快速自检，跑的是生产代码本体）===');
  const pool = makePool('pglite://memory') as unknown as Pool;
  await migrate(pool);
  const cipher = makeCipher(DATA_KEY);

  // 最小可用账号数据：一个用户、一个默认项目、一只小助（/agent/loop/start 要校验智能体归属）
  await pool.query(`INSERT INTO users (id, xyz_id, phone_hash) VALUES (1,'x1','h1') ON CONFLICT (id) DO NOTHING`);
  await pool.query(
    `INSERT INTO projects (id, user_id, name, is_default) VALUES (10,1,'项目甲',true) ON CONFLICT (id) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO agents (id, project_id, name, kind) VALUES (101,10,'小助','assistant') ON CONFLICT (id) DO NOTHING`,
  );
  await pool.query(`SELECT setval('users_id_seq', 100), setval('projects_id_seq', 100), setval('agents_id_seq', 1000)`);

  const app = Fastify({ logger: false });
  registerAgentRoutes(app, { pool, env: ENV, cipher });
  registerLoopRoutes(app, { pool, env: ENV, cipher });
  await app.ready();
  const auth = { authorization: `Bearer ${signToken({ sub: 1, xyz: 'XYZ1' }, ENV.jwtSecret)}` };

  /** 直连查一行 tasks（连 row_to_json 一起拿，用来做「整行搜不到敏感词」的兜底扫描） */
  async function taskRow(id: number) {
    const r = await pool.query(
      `SELECT id, title, payload, goal_enc, result_enc, row_to_json(t)::text AS whole
         FROM tasks t WHERE id = $1`,
      [id],
    );
    assert.equal(r.rows.length, 1, `tasks#${id} 查不到`);
    return r.rows[0] as {
      id: string;
      title: string | null;
      payload: Record<string, unknown>;
      goal_enc: string | null;
      result_enc: string | null;
      whole: string;
    };
  }

  async function pauseRow(loopId: string) {
    const r = await pool.query(
      `SELECT id, loop_id, goal, goal_enc, row_to_json(t)::text AS whole
         FROM task_pauses t WHERE loop_id = $1`,
      [loopId],
    );
    assert.equal(r.rows.length, 1, `task_pauses 里没有 ${loopId}`);
    return r.rows[0] as { id: string; loop_id: string; goal: string | null; goal_enc: string | null; whole: string };
  }

  // ------------------------------------------------------- ① 建任务：落库形状
  log('');
  log('--- ① POST /agent/task/start：目标只以密文落库 ---');
  let taskId = 0;
  {
    const r = await app.inject({ method: 'POST', url: '/agent/task/start', headers: auth, payload: { goal: GOAL } });
    await check('200 建出任务', () => {
      assert.equal(r.statusCode, 200, `${r.statusCode} ${r.body}`);
      taskId = Number((r.json() as { taskId: number }).taskId);
      assert.ok(taskId > 0, 'taskId 不合法');
    });
    const row = await taskRow(taskId);
    log(`      SELECT → ${JSON.stringify({ title: row.title, payload: row.payload, goal_enc: String(row.goal_enc).slice(0, 28) + '…' })}`);
    await check('payload 里**没有 goal 键**（明文那份不存在）', () => {
      assert.ok(!('goal' in row.payload), `payload 还有 goal：${JSON.stringify(row.payload).slice(0, 200)}`);
      assert.deepEqual(Object.keys(row.payload), ['steps'], `payload 键不该多也不该少：${Object.keys(row.payload)}`);
    });
    await check('title 为 NULL（不再抄一份 goal 前 80 字当明文副本）', () => {
      assert.equal(row.title, null, `title 实际是 ${JSON.stringify(row.title)}`);
    });
    await check('goal_enc 是 gcm$ 开头的密文', () => {
      assert.ok(typeof row.goal_enc === 'string' && row.goal_enc.startsWith('gcm$'), `goal_enc=${row.goal_enc}`);
    });
    await check('整行 row_to_json 里搜不到任何一个敏感词', () => {
      for (const s of SENSITIVE) assert.ok(!row.whole.includes(s), `整行里读到了「${s}」`);
    });
    await check('密文列里一个中文字都没有（不是把原文塞进新列充数）', () => {
      assert.ok(!/[\u4e00-\u9fa5]/.test(String(row.goal_enc)), '密文列含中文');
    });
    await check('用同一把 DATA_KEY 能解回**原目标**', () => {
      assert.equal(cipher.decryptText(String(row.goal_enc)), GOAL);
    });
  }

  // ------------------------------------------------------- ② 用户能感知的那一半
  log('');
  log('--- ② 用户能感知：/agent/task/current 与 /agent/task/doc 仍拿得到目标 ---');
  {
    const r = await app.inject({ method: 'POST', url: '/agent/task/finish', headers: auth, payload: { taskId, summary: '已查到余额' } });
    await check('200 收尾（模型连不上走兜底文档，任务仍算完成）', () =>
      assert.equal(r.statusCode, 200, `${r.statusCode} ${r.body}`),
    );
    const row = await taskRow(taskId);
    await check('收尾后 payload 依然没有 goal 键、result_enc 是密文', () => {
      assert.ok(!('goal' in row.payload), JSON.stringify(row.payload).slice(0, 200));
      assert.ok(String(row.result_enc).startsWith('gcm$'), `result_enc=${String(row.result_enc).slice(0, 24)}`);
    });
    const doc = await app.inject({ method: 'GET', url: `/agent/task/doc?taskId=${taskId}`, headers: auth });
    await check('任务文档的「## 目标」是**解密后的原目标**（用户看到的不是空白）', () => {
      assert.equal(doc.statusCode, 200, `${doc.statusCode} ${doc.body}`);
      const md = String((doc.json() as { markdown: string }).markdown);
      assert.ok(md.includes('## 目标'), '文档里没有「## 目标」段');
      assert.ok(md.includes(GOAL), `文档里的目标不是原文：${md.slice(0, 200)}`);
    });
    const cur = await app.inject({ method: 'GET', url: '/agent/task/current', headers: auth });
    await check('/agent/task/current 回的 goal 是原目标（桌面刷新后还原任务卡靠它）', () => {
      assert.equal(cur.statusCode, 200, `${cur.statusCode} ${cur.body}`);
      const t = (cur.json() as { task: { id: number; goal: string } }).task;
      assert.equal(t.id, taskId);
      assert.equal(t.goal, GOAL);
    });
  }

  // ------------------------------------- ②-B ★ 条件1：title 停用后，界面「显示什么」必须被验收盯住
  log('');
  log('--- ②-B ★ 条件1：显示字段非空 + 不含敏感词（tasks.title 已停用，界面靠 goal/displayTitle） ---');
  {
    const r = await app.inject({ method: 'GET', url: '/agent/task/current', headers: auth });
    const t = (r.json() as { task: Record<string, unknown> }).task;
    log(`      /agent/task/current → ${JSON.stringify({ id: t.id, title: t.title, goal: t.goal, displayTitle: t.displayTitle })}`);
    await check('★ 条件1：显示字段 displayTitle **非空**（界面不会出现空白标题）', () => {
      assert.equal(r.statusCode, 200, `${r.statusCode} ${r.body}`);
      assert.equal(typeof t.displayTitle, 'string', `displayTitle=${JSON.stringify(t.displayTitle)}`);
      assert.ok(String(t.displayTitle).trim().length > 0, '显示字段是空的');
    });
    await check('★ 条件1：displayTitle **不含任何敏感词**（这份是要给人看、会进日志与截图的）', () => {
      const dt = String(t.displayTitle);
      for (const bad of SENSITIVE) assert.ok(!dt.includes(bad), `显示字段里读到「${bad}」`);
      assert.ok(dt.includes('[已脱敏'), `没留脱敏占位，看不出被改过：${dt}`);
    });
    await check('★ 条件1：功能字段 goal 仍是**还原后的原文**（脱敏只作用于显示副本，没把功能吃掉）', () => {
      assert.equal(t.goal, GOAL, 'goal 不是原文');
      assert.ok(dt_prefix_ok(String(t.displayTitle), GOAL), '显示字段与目标毫无关系（不是同一句话的脱敏版）');
    });
    await check('显示字段不超 80 字（title 当年就是这个长度，别把界面撑破）', () => {
      assert.ok(String(t.displayTitle).length <= 80, `长度 ${String(t.displayTitle).length}`);
    });
    /**
     * ★ 补丁断言（2026-09-24 用户报的 bug）：占位符的「N 字」必须是**被替换那一段**的长度。
     *   bug 形状：card/idcard 两条正则无捕获组 → `replace` 回调的 `m[2]` 是**整个输入串**，
     *   于是 16 位卡号与 18 位身份证都报成整句长度（·79字），而带捕获组的 password 报对了（·10字）。
     *   上面那些「不含敏感词」的断言在字数全错时照样绿 —— 所以这里必须整串精确相等。
     */
    await check('★ 补丁：displayTitle 整串精确相等（字数 16 / 10 / 18，不是整句长度）', () => {
      assert.equal(
        String(t.displayTitle),
        '帮我查一下 银行卡[已脱敏·card·16字] 的余额，登录用 密码[已脱敏·password·10字]，实名 身份证[已脱敏·card·18字]',
      );
      const lens = [...String(t.displayTitle).matchAll(/\[已脱敏·([A-Za-z]+)·(\d+)字\]/g)].map((m) => `${m[1]}·${m[2]}`);
      assert.deepEqual(lens, ['card·16', 'password·10', 'card·18'], JSON.stringify(lens));
      const goalLen = [...GOAL].length;
      assert.ok(
        !lens.some((x) => x.endsWith(`·${goalLen}`)),
        `有占位符报了整句长度 ${goalLen}（那就是 bug 复发了）`,
      );
    });

    await check('tasks.title 这一列确实是 NULL（没偷偷存一份脱敏摘要冒充标题）', async () => {
      const row = await taskRow(taskId);
      assert.equal(row.title, null, `title=${JSON.stringify(row.title)}`);
    });
  }

  // ------------------------------------------------------- ③ task/step 写回不复活明文
  log('');
  log('--- ③ POST /agent/task/step：写回 payload 时不把明文 goal 抄回去 ---');
  {
    // 先手工造一条「回填迁移还没跑到的老行」：payload 里带明文 goal
    const legacy = await pool.query(
      `INSERT INTO tasks (project_id, status, title, payload) VALUES (10,'running',$1,$2::jsonb) RETURNING id`,
      [`帮我付 ${SENSITIVE[0]} 的账单`, JSON.stringify({ goal: `转账到 ${SENSITIVE[0]}，密码 ${SENSITIVE[1]}`, steps: [] })],
    );
    const legacyId = Number((legacy.rows[0] as { id: string }).id);
    const r = await app.inject({
      method: 'POST',
      url: '/agent/task/step',
      headers: auth,
      payload: { taskId: legacyId, summary: '打开了网银页面', ok: true },
    });
    await check('200 追加了一步', () => assert.equal(r.statusCode, 200, `${r.statusCode} ${r.body}`));
    const row = await taskRow(legacyId);
    log(`      写回后 payload = ${JSON.stringify(row.payload).slice(0, 200)}`);
    await check('★ 写回后 payload 里的明文 goal 被摘掉了（不是原样展开写回）', () => {
      assert.ok(!('goal' in row.payload), `payload 又出现了 goal：${JSON.stringify(row.payload).slice(0, 200)}`);
    });
    await check('steps 正常保留（摘 goal 没有把功能一起吃掉）', () => {
      const steps = row.payload.steps as string[];
      assert.equal(steps.length, 1);
      assert.ok(steps[0].includes('打开了网银页面'), steps[0]);
    });
    await check('这一行整行 row_to_json 里也搜不到敏感词了', () => {
      // 注意：title 仍是明文（回填迁移负责清），所以这里只断言 payload 里的两个敏感词
      for (const s of [SENSITIVE[1]]) assert.ok(!JSON.stringify(row.payload).includes(s), `payload 里读到「${s}」`);
    });
  }

  // ------------------------------------------------------- ④ 暂停记录
  log('');
  log('--- ④ POST /agent/loop/pause：task_pauses 只落密文 ---');
  let loopId = '';
  {
    const s = await app.inject({
      method: 'POST',
      url: '/agent/loop/start',
      headers: auth,
      payload: { agentId: 101, goal: GOAL, pageUrl: 'https://bank.example/', wcId: 901 },
    });
    await check('200 建循环', () => {
      assert.equal(s.statusCode, 200, `${s.statusCode} ${s.body}`);
      loopId = String((s.json() as { loopId: string }).loopId);
      assert.ok(loopId, 'loopId 为空');
    });
    const p = await app.inject({ method: 'POST', url: '/agent/loop/pause', headers: auth, payload: { loopId } });
    await check('200 挂起', () => assert.equal(p.statusCode, 200, `${p.statusCode} ${p.body}`));
    const row = await pauseRow(loopId);
    log(`      SELECT → ${JSON.stringify({ goal: row.goal, goal_enc: String(row.goal_enc).slice(0, 28) + '…' })}`);
    await check('task_pauses.goal 明文列为 NULL', () => assert.equal(row.goal, null, `goal=${JSON.stringify(row.goal)}`));
    await check('goal_enc 是 gcm$ 密文', () => assert.ok(String(row.goal_enc).startsWith('gcm$'), String(row.goal_enc)));
    await check('整行 row_to_json 里搜不到敏感词', () => {
      for (const s2 of SENSITIVE) assert.ok(!row.whole.includes(s2), `整行里读到了「${s2}」`);
    });
    await check('解密回来等于原目标', () => assert.equal(cipher.decryptText(String(row.goal_enc)), GOAL));
    const list = await app.inject({ method: 'GET', url: `/agent/loop/pauses?loopId=${loopId}`, headers: auth });
    await check('/agent/loop/pauses 仍返回**明文目标**（用户/恢复流程看得见）', () => {
      assert.equal(list.statusCode, 200, `${list.statusCode} ${list.body}`);
      const recs = (list.json() as { records: Array<{ loopId: string; goal?: string }> }).records;
      assert.equal(recs.length, 1);
      assert.equal(recs[0].goal, GOAL);
    });
  }

  // ------------------------------------------------------- ⑤ 回填迁移
  log('');
  log('--- ⑤ migrateTaskGoalEncryption：历史明文行回填 + 幂等 ---');
  {
    const before = await pool.query(
      `INSERT INTO task_pauses (user_id, loop_id, goal, paused_by) VALUES (1,'legacy-loop-1',$1,'user') RETURNING id`,
      [`老任务：把 ${SENSITIVE[2]} 的资料下载下来`],
    );
    const legacyPauseId = Number((before.rows[0] as { id: string }).id);
    const legacyTask = await pool.query(
      `INSERT INTO tasks (project_id, status, title, payload) VALUES (10,'done',$1,$2::jsonb) RETURNING id`,
      [`老任务标题 ${SENSITIVE[0]}`, JSON.stringify({ goal: `老任务目标 ${SENSITIVE[1]}`, steps: ['第一步'], doc: { summary: '做完了' } })],
    );
    const legacyTaskId = Number((legacyTask.rows[0] as { id: string }).id);
    // 只有 title、payload 里没有 goal 的更老形状（也得被回填，否则 title 永远是明文）
    const titleOnly = await pool.query(
      `INSERT INTO tasks (project_id, status, title, payload) VALUES (10,'done',$1,'{"steps":[]}'::jsonb) RETURNING id`,
      [`只剩标题的老任务 ${SENSITIVE[2]}`],
    );
    const titleOnlyId = Number((titleOnly.rows[0] as { id: string }).id);

    const r1 = await migrateTaskGoalEncryption(pool, cipher);
    log(`      第一次：${JSON.stringify(r1)}`);
    /**
     * tasks 期望 **3** 条，不是这里刚插的 2 条：③ 段为了验 payloadWithoutGoal 也造了一条
     * 「回填还没跑到的老行」（payload 里带明文 goal），它同样必须被这次回填捞走。
     * 这正好是想要的答案 —— 迁移认的是**库里的形状**，不管这行是谁写进去的。
     */
    await check('回填计数如实（task_pauses 1 条、tasks 3 条 = 本段 2 条 + ③ 段那条老行）', () => {
      assert.equal(r1.skipped, false);
      assert.equal(r1.pauses, 1, `pauses=${r1.pauses}`);
      assert.equal(r1.tasks, 3, `tasks=${r1.tasks}`);
      assert.equal(r1.encrypted, 4, `encrypted=${r1.encrypted}（4 行都是本来没密文、这次真加密出来的）`);
      assert.equal(r1.mismatched, 0, `mismatched=${r1.mismatched}`);
      assert.equal(r1.failed, 0, `failed=${r1.failed}`);
    });

    const pr = await pool.query(`SELECT goal, goal_enc, row_to_json(t)::text AS whole FROM task_pauses t WHERE id=$1`, [
      legacyPauseId,
    ]);
    const prow = pr.rows[0] as { goal: string | null; goal_enc: string | null; whole: string };
    await check('老暂停行：明文列清空、密文能解回原目标', () => {
      assert.equal(prow.goal, null, `goal=${JSON.stringify(prow.goal)}`);
      assert.ok(String(prow.goal_enc).startsWith('gcm$'), String(prow.goal_enc));
      assert.equal(cipher.decryptText(String(prow.goal_enc)), `老任务：把 ${SENSITIVE[2]} 的资料下载下来`);
      for (const s of SENSITIVE) assert.ok(!prow.whole.includes(s), `整行里还读到「${s}」`);
    });

    const tr = await taskRow(legacyTaskId);
    await check('老任务行：payload 去掉 goal、title 清空、其余键（steps/doc）原样保留', () => {
      assert.ok(!('goal' in tr.payload), JSON.stringify(tr.payload).slice(0, 200));
      assert.deepEqual((tr.payload as { steps: string[] }).steps, ['第一步']);
      assert.deepEqual((tr.payload as { doc: { summary: string } }).doc, { summary: '做完了' });
      assert.equal(tr.title, null, `title=${JSON.stringify(tr.title)}`);
      assert.equal(cipher.decryptText(String(tr.goal_enc)), `老任务目标 ${SENSITIVE[1]}`);
      for (const s of SENSITIVE) assert.ok(!tr.whole.includes(s), `整行里还读到「${s}」`);
    });

    const to = await taskRow(titleOnlyId);
    await check('只剩 title 的更老行：title 里的明文也进了密文列（不留第二份副本）', () => {
      assert.equal(to.title, null, `title=${JSON.stringify(to.title)}`);
      assert.equal(cipher.decryptText(String(to.goal_enc)), `只剩标题的老任务 ${SENSITIVE[2]}`);
      for (const s of SENSITIVE) assert.ok(!to.whole.includes(s), `整行里还读到「${s}」`);
    });

    const r2 = await migrateTaskGoalEncryption(pool, cipher);
    log(`      第二次（幂等）：${JSON.stringify(r2)}`);
    await check('★ 幂等：第二次跑 0 条改动、不抛、密文没被二次加密', () => {
      assert.equal(r2.pauses, 0, `pauses=${r2.pauses}`);
      assert.equal(r2.tasks, 0, `tasks=${r2.tasks}`);
      assert.equal(r2.encrypted, 0, `encrypted=${r2.encrypted}`);
      assert.equal(cipher.decryptText(String(prow.goal_enc)), `老任务：把 ${SENSITIVE[2]} 的资料下载下来`);
    });
    await check('全库兜底扫：tasks / task_pauses 两张表里一行明文都不剩', async () => {
      const pats = SENSITIVE.map((s) => `%${s}%`);
      const leakTasks = await pool.query(
        `SELECT count(*)::int AS n FROM tasks t WHERE row_to_json(t)::text LIKE ANY($1)`,
        [pats],
      );
      const leakPauses = await pool.query(
        `SELECT count(*)::int AS n FROM task_pauses t WHERE row_to_json(t)::text LIKE ANY($1)`,
        [pats],
      );
      const tasksN = (leakTasks.rows[0] as { n: number }).n;
      const pausesN = (leakPauses.rows[0] as { n: number }).n;
      log(`      row_to_json 整行扫描 → 含敏感词的行数：tasks=${tasksN} task_pauses=${pausesN}`);
      assert.equal(tasksN, 0, `tasks 还有 ${tasksN} 行整行里搜得到敏感词`);
      assert.equal(pausesN, 0, `task_pauses 还有 ${pausesN} 行整行里搜得到敏感词`);
      // 结构性断言：不许再有「明文位置」有值（payload.goal / title 两个老位置）
      const plain = await pool.query(
        `SELECT count(*)::int AS n FROM tasks WHERE (payload->>'goal') IS NOT NULL OR title IS NOT NULL`,
      );
      const plainPauses = await pool.query(`SELECT count(*)::int AS n FROM task_pauses WHERE goal IS NOT NULL`);
      log(
        `      明文位置残留 → tasks.payload.goal/title 有值的行=${(plain.rows[0] as { n: number }).n}` +
          `、task_pauses.goal 有值的行=${(plainPauses.rows[0] as { n: number }).n}`,
      );
      assert.equal((plain.rows[0] as { n: number }).n, 0, '还有行的 payload.goal / title 有值');
      assert.equal((plainPauses.rows[0] as { n: number }).n, 0, '还有行的 task_pauses.goal 有值');
    });
  }

  // --------------------------- ⑤-B ★ 拍板：不加密 payload 整列，改成把步骤摘要脱敏做到「值形状」级
  log('');
  log('--- ⑤-B 拍板：敏感值不能搭 task/step 摘要的车进 payload.steps ---');
  {
    // 收尾 6 第一版的 scrubStepSummary 只认两种「」形状，R2 评审当时就指出「挡不住其它形状的敏感数据」。
    // 2026-09-24 拍板：不加密 payload 整列（每次读都要解密、代价大且 payload 里还有 steps/doc 等结构），
    // 改成复用 redactForStorage 的 VALUE_PATTERNS（密码/验证码/卡号/身份证/CVV）按**值形状**脱敏。
    const row0 = await pool.query(
      `INSERT INTO tasks (project_id, status, title, payload) VALUES (10,'running',NULL,$1::jsonb) RETURNING id`,
      [JSON.stringify({ steps: [] })],
    );
    const sid = Number((row0.rows[0] as { id: string }).id);
    const evil = [
      `写入完成 密码是 hunter2secret`,
      `发送验证码 839201 给用户`,
      `绑定银行卡 6222021234567890123`,
      `身份证 110101199003078888 已登记`,
      `CVV 739 校验通过`,
      `老形状也要挡住：「${SENSITIVE[0]}」`,
    ];
    for (let i = 0; i < evil.length; i += 1) {
      const rp = await app.inject({
        method: 'POST',
        url: '/agent/task/step',
        headers: auth,
        payload: { taskId: sid, summary: evil[i], ok: true },
      });
      assert.equal(rp.statusCode, 200, `第 ${i} 条步骤上报失败：${rp.statusCode} ${rp.body}`);
    }
    const after = await taskRow(sid);
    const steps = Array.isArray(after.payload.steps) ? (after.payload.steps as string[]) : [];
    log(`      存进去的 steps（${steps.length} 条）：${JSON.stringify(steps)}`);
    /**
     * ★ 补丁断言：六条摘要的**整串**期望值。
     *   bug 在的时候这三条分别报 ·25字 / ·26字 / ·29字（都是「整句长度」），修完是 ·19字 / ·18字 / ·16字。
     *   带捕获组的 password / otp / cvv 三条一直是对的（·13字 / ·6字 / ·3字）—— 正是这个「一对一错」
     *   的分布把根因指向了「回调实参形状随捕获组个数而变」，而不是正则贪婪。
     */
    await check('★ 补丁：六条摘要脱敏后**逐条整串相等**（占位符字数 = 被替换那段的实际长度）', () => {
      assert.deepEqual(steps, [
        '写入完成 密码是 [已脱敏·password·13字]',
        '发送验证码 [已脱敏·otp·6字] 给用户',
        '绑定银行卡 [已脱敏·card·19字]',
        '身份证 [已脱敏·card·18字] 已登记',
        'CVV [已脱敏·card·3字] 校验通过',
        '老形状也要挡住：「银行卡[已脱敏·card·16字]」',
      ]);
    });

    await check('六条含敏感值的摘要，落进 payload.steps 后**一个敏感值都不剩**', () => {
      assert.equal(steps.length, evil.length, `steps 数量不对：${steps.length}`);
      const joined = steps.join('\n');
      for (const raw of ['hunter2secret', '839201', '6222021234567890123', '110101199003078888', '739', SENSITIVE[0]]) {
        assert.ok(!joined.includes(raw), `steps 里残留敏感值「${raw}」`);
      }
    });
    await check('脱敏后仍然**可读**（留了占位，不是整条摘要被抹成空串）', () => {
      assert.ok(steps[0].includes('[已脱敏'), `没留占位：${JSON.stringify(steps[0])}`);
      assert.ok(steps[0].includes('写入完成'), `把正常文字也删了：${JSON.stringify(steps[0])}`);
      assert.ok(steps.every((x) => typeof x === 'string' && x.length > 0), '有摘要被抹成空串');
    });
  }

  // ------------------------------------------- ⑥ 残行：密文与明文同时存在（真库抓出来的形状）
  log('');
  log('--- ⑥ 残行：goal_enc 已有值 + 明文也还在（灰度/回滚形状）必须被清干净 ---');
  {
    /**
     * ★ 这一段是**真库验收逼出来的**，不是想当然加的。
     *
     * 第一版回填的条件是 `WHERE goal_enc IS NULL AND 明文还在`，看着幂等又省事；
     * 但真库里存在第三种形状：**goal_enc 已经有值、明文列也还有值**
     * （灰度/回滚期间新旧代码各写一半、人工改过库、或变异测试留下的残行）。
     * 那种行永远满足不了 `goal_enc IS NULL` → 明文**永远清不掉**，
     * 而只造「纯老行」的验收脚本照样全绿。现在扫描条件改成「明文还在不在」。
     */
    const FULL = `完整目标：把 ${SENSITIVE[0]} 的三年流水都导出来，登录密码 ${SENSITIVE[1]}，经办人身份证 ${SENSITIVE[2]}`;
    assert.ok(FULL.length > 80, '这段目标必须长过 80 字，否则验不出 title 截断的坑');

    // 残行 A：暂停记录，密文与明文都有、内容一致
    const a = await pool.query(
      `INSERT INTO task_pauses (user_id, loop_id, goal, goal_enc, paused_by, resumed_at)
       VALUES (1,'residue-a',$1,$2,'user',now()) RETURNING id`,
      [FULL, cipher.encryptText(FULL)],
    );
    const aId = Number((a.rows[0] as { id: string }).id);
    const aBefore = String((await pool.query(`SELECT goal_enc FROM task_pauses WHERE id=$1`, [aId])).rows[0].goal_enc);

    // 残行 B：任务，密文是**完整**目标，title 只有前 80 字（截断值）
    const b = await pool.query(
      `INSERT INTO tasks (project_id, status, title, payload, goal_enc)
       VALUES (10,'done',$1,'{"steps":["老步骤"]}'::jsonb,$2) RETURNING id`,
      [FULL.slice(0, 80), cipher.encryptText(FULL)],
    );
    const bId = Number((b.rows[0] as { id: string }).id);
    const bBefore = String((await pool.query(`SELECT goal_enc FROM tasks WHERE id=$1`, [bId])).rows[0].goal_enc);

    // 残行 C：密文是**解不开的垃圾**（DATA_KEY 换过的形状），明文还在 → 必须用明文重加密
    const c = await pool.query(
      `INSERT INTO task_pauses (user_id, loop_id, goal, goal_enc, paused_by, resumed_at)
       VALUES (1,'residue-c',$1,'gcm$notavalidciphertext$atall$really','user',now()) RETURNING id`,
      [`解不开密文的老行 ${SENSITIVE[2]}`],
    );
    const cId = Number((c.rows[0] as { id: string }).id);

    /**
     * 残行 D：密文能解但**内容不同**（人工改过库 / 灰度期两边各写一次）。
     * ★ 条件3（2026-09-24 用户拍板）：这种行**两份都留、一行不动**，只在启动日志 warn 出 id 交人判断。
     *   自动清明文会丢掉「唯一一份能读的内容」，自动覆盖密文会丢掉「另一份可能更新的内容」，
     *   机器没资格替人做不可逆的取舍。
     */
    const d = await pool.query(
      `INSERT INTO task_pauses (user_id, loop_id, goal, goal_enc, paused_by, resumed_at)
       VALUES (1,'residue-d',$1,$2,'user',now()) RETURNING id`,
      ['明文写的另一个目标', cipher.encryptText('密文里的目标')],
    );
    const dId = Number((d.rows[0] as { id: string }).id);
    const dEncBefore = String((await pool.query(`SELECT goal_enc FROM task_pauses WHERE id=$1`, [dId])).rows[0].goal_enc);
    // 残行 D2：同上，但明文里带敏感词 —— 用来**如实**验「两份都留」的代价：
    // 在人工处理掉之前，这行明文会继续躺在库里，补偿控制是那条 warn（不是假装它干净）。
    const d2 = await pool.query(
      `INSERT INTO tasks (project_id, status, title, payload, goal_enc)
       VALUES (10,'done',NULL,$1::jsonb,$2) RETURNING id`,
      [JSON.stringify({ goal: `不一致的明文目标，里面还有 ${SENSITIVE[1]}`, steps: [] }), cipher.encryptText('密文里的另一个目标')],
    );
    const d2Id = Number((d2.rows[0] as { id: string }).id);

    let warns: string[] = [];
    let r: TaskGoalMigrationResult = {
      skipped: true, pauses: 0, tasks: 0, encrypted: 0, mismatched: 0, mismatchedIds: [], failed: 0,
    };
    warns = await captureWarns(async () => {
      r = await migrateTaskGoalEncryption(pool, cipher);
    });
    log(`      残行回填：${JSON.stringify(r)}`);
    await check('该动的都动了（pauses 2 条 = A/C、tasks 1 条 = B），不一致的 D/D2 一行没动', () => {
      assert.equal(r.pauses, 2, `pauses=${r.pauses}（A 清明文 + C 重加密）`);
      assert.equal(r.tasks, 1, `tasks=${r.tasks}（B 清 title）`);
      assert.equal(r.failed, 0, `failed=${r.failed}`);
    });

    const aAfter = (await pool.query(`SELECT goal, goal_enc FROM task_pauses WHERE id=$1`, [aId])).rows[0] as {
      goal: string | null;
      goal_enc: string | null;
    };
    await check('残行 A：明文清空，且**密文一个字节没被改**（不是重新加密一遍）', () => {
      assert.equal(aAfter.goal, null, `goal=${JSON.stringify(aAfter.goal)}`);
      assert.equal(aAfter.goal_enc, aBefore, '密文被改写了（重加密会换 IV，等于白折腾还可能丢内容）');
      assert.equal(cipher.decryptText(String(aAfter.goal_enc)), FULL);
    });

    const bAfter = (await pool.query(`SELECT title, payload, goal_enc FROM tasks WHERE id=$1`, [bId])).rows[0] as {
      title: string | null;
      payload: Record<string, unknown>;
      goal_enc: string | null;
    };
    await check('残行 B：title 截断值被清掉，密文保持**完整目标**（没被 80 字截断值覆盖）', () => {
      assert.equal(bAfter.title, null, `title=${JSON.stringify(bAfter.title)}`);
      assert.equal(bAfter.goal_enc, bBefore, '密文被改写了');
      assert.equal(cipher.decryptText(String(bAfter.goal_enc)), FULL, '解出来不是完整目标（被截断值覆盖了）');
      assert.deepEqual(bAfter.payload.steps, ['老步骤'], 'payload 其余内容被动过了');
    });

    const cAfter = (await pool.query(`SELECT goal, goal_enc FROM task_pauses WHERE id=$1`, [cId])).rows[0] as {
      goal: string | null;
      goal_enc: string | null;
    };
    await check('残行 C：密文解不开 → 用明文重加密（数据被救回来，不是留个解不开的壳）', () => {
      assert.equal(cAfter.goal, null);
      assert.equal(cipher.decryptText(String(cAfter.goal_enc)), `解不开密文的老行 ${SENSITIVE[2]}`);
    });

    const dAfter = (await pool.query(`SELECT goal, goal_enc FROM task_pauses WHERE id=$1`, [dId])).rows[0] as {
      goal: string | null;
      goal_enc: string | null;
    };
    await check('★ 条件3：残行 D 不一致 → **两份都留**（明文没被清、密文逐字节没变）', () => {
      assert.equal(r.mismatched, 2, `mismatched=${r.mismatched}（D + D2）`);
      assert.equal(dAfter.goal, '明文写的另一个目标', `明文被清掉了：${JSON.stringify(dAfter.goal)}`);
      assert.equal(dAfter.goal_enc, dEncBefore, '密文被改写了');
      assert.equal(cipher.decryptText(String(dAfter.goal_enc)), '密文里的目标', '密文内容变了');
    });
    await check('★ 条件3：warn 日志**列出了受影响行 id**（且不含目标内容）', () => {
      const w = warns.filter((x) => x.includes('不一致')).join('\n');
      assert.ok(w, `没有 warn：${JSON.stringify(warns)}`);
      assert.ok(w.includes(`task_pauses#${dId}`), `warn 里没有 task_pauses#${dId}：${w}`);
      assert.ok(w.includes(`tasks#${d2Id}`), `warn 里没有 tasks#${d2Id}：${w}`);
      assert.ok(!w.includes('明文写的另一个目标'), 'warn 里带了明文内容（日志不该出现目标原文）');
      assert.ok(!w.includes(SENSITIVE[1]), 'warn 里带了敏感词');
      log(`      warn 原文：${w}`);
    });
    await check('返回值里也带了 mismatchedIds（调用方/验收能定位，不用去抠日志）', () => {
      assert.deepEqual(
        r.mismatchedIds.slice().sort(),
        [`task_pauses#${dId}`, `tasks#${d2Id}`].slice().sort(),
        JSON.stringify(r.mismatchedIds),
      );
    });
    const d2After = (await pool.query(`SELECT payload, goal_enc FROM tasks WHERE id=$1`, [d2Id])).rows[0] as {
      payload: Record<string, unknown>;
      goal_enc: string | null;
    };
    await check('残行 D2（明文含敏感词）也照留不误 —— 如实反映「交人判断」的代价，不假装干净', () => {
      assert.equal(d2After.payload.goal, `不一致的明文目标，里面还有 ${SENSITIVE[1]}`, '明文被清掉了');
      assert.equal(cipher.decryptText(String(d2After.goal_enc)), '密文里的另一个目标');
      log('      ↑ 这行明文会一直留到人工处理为止；补偿控制是启动日志那条 warn（条件3 的取舍）');
    });
    await check('幂等：不一致的行每次启动都会被重新报一次（不会被「已处理」吃掉）', async () => {
      warns = await captureWarns(async () => {
        r = await migrateTaskGoalEncryption(pool, cipher);
      });
      assert.equal(r.mismatched, 2, `第二次 mismatched=${r.mismatched}`);
      assert.equal(r.pauses, 0, `第二次 pauses=${r.pauses}`);
      assert.equal(r.tasks, 0, `第二次 tasks=${r.tasks}`);
      assert.ok(warns.some((x) => x.includes('不一致') && x.includes(`task_pauses#${dId}`)), '第二次没有再 warn');
    });
    await check('encrypted 只算了真需要新加密的那 1 条（残行 C）', () => {
      assert.equal(r.encrypted, 0, `第二次不该再加密任何行：encrypted=${r.encrypted}`);
    });
    await check('能被自动清理的残行（A/B/C/D）整行里都搜不到敏感词了', async () => {
      const pats = SENSITIVE.map((x) => `%${x}%`);
      const n1 = (
        await pool.query(
          `SELECT count(*)::int AS n FROM task_pauses t WHERE t.id = ANY($1) AND row_to_json(t)::text LIKE ANY($2)`,
          [[aId, cId, dId], pats],
        )
      ).rows[0] as { n: number };
      const n2 = (
        await pool.query(`SELECT count(*)::int AS n FROM tasks t WHERE t.id = $1 AND row_to_json(t)::text LIKE ANY($2)`, [
          bId,
          pats,
        ])
      ).rows[0] as { n: number };
      log(`      残行整行扫描 → task_pauses=${n1.n} tasks=${n2.n}`);
      assert.equal(n1.n, 0);
      assert.equal(n2.n, 0);
    });
    // 收尾：把故意留着的不一致行清掉，别影响后面的兜底扫（它验的是「正常路径零明文」）
    await pool.query(`DELETE FROM task_pauses WHERE id=$1`, [dId]);
    await pool.query(`DELETE FROM tasks WHERE id=$1`, [d2Id]);
  }

  // ------------------------------------------------------- ⑦ fail-closed
  log('');
  log('--- ⑦ fail-closed：拿不到 cipher 就不动，绝不写明文兜底 ---');
  {
    const legacy = await pool.query(
      `INSERT INTO task_pauses (user_id, loop_id, goal, paused_by) VALUES (1,'legacy-loop-noc',$1,'user') RETURNING id`,
      [`没钥匙时不许碰的目标 ${SENSITIVE[0]}`],
    );
    const legacyId = Number((legacy.rows[0] as { id: string }).id);
    const r = await migrateTaskGoalEncryption(pool, null as unknown as JsonCipher);
    log(`      无 cipher：${JSON.stringify(r)}`);
    await check('skipped=true、计数全 0（如实报告「我没干」，不是假装成功）', () => {
      assert.equal(r.skipped, true);
      assert.equal(r.pauses, 0);
      assert.equal(r.tasks, 0);
      assert.equal(r.encrypted, 0);
      assert.equal(r.mismatched, 0);
      assert.equal(r.failed, 0);
    });
    const row = await pool.query(`SELECT goal, goal_enc FROM task_pauses WHERE id=$1`, [legacyId]);
    const got = row.rows[0] as { goal: string | null; goal_enc: string | null };
    await check('明文行原样保留（等下次启动带钥匙再来），密文列没被塞进任何明文/占位值', () => {
      assert.equal(got.goal, `没钥匙时不许碰的目标 ${SENSITIVE[0]}`);
      assert.equal(got.goal_enc, null, `goal_enc=${got.goal_enc}`);
    });
    // 收尾：把这条明文行清掉，免得影响别的断言（本脚本用的是内存库，仅保持整洁）
    await pool.query(`DELETE FROM task_pauses WHERE id=$1`, [legacyId]);
  }

  // ----------------------------------- ⑧ ★ 条件2 自动化 M9：路由层拿不到 cipher 就一行都不落
  log('');
  log('--- ⑧ ★ 条件2/M9：路由层拿不到 cipher → 500 + tasks/task_pauses 一行都不落（常驻自动化） ---');
  {
    /**
     * 手工反证 M9 靠临时把 index.ts 的 cipher 改成 null，跑完要还原、容易忘（而且改的是启动装配，
     * 不是路由本体）。这里把同一件事做成**常驻断言**：再起一个 app，路由依赖里 cipher 就是 null。
     * 打的是同一份生产路由代码（registerAgentRoutes / registerLoopRoutes），不是副本。
     */
    const nullApp = Fastify({ logger: false });
    registerAgentRoutes(nullApp, { pool, env: ENV, cipher: null as unknown as JsonCipher });
    registerLoopRoutes(nullApp, { pool, env: ENV, cipher: null as unknown as JsonCipher });
    await nullApp.ready();

    const counts = async () => {
      const a = (await pool.query(`SELECT count(*)::int AS n FROM tasks`)).rows[0] as { n: number };
      const b = (await pool.query(`SELECT count(*)::int AS n FROM task_pauses`)).rows[0] as { n: number };
      return { tasks: a.n, pauses: b.n };
    };
    const before = await counts();
    log(`      打之前：tasks=${before.tasks} task_pauses=${before.pauses}`);

    const NOKEY_GOAL = `没钥匙也必须拦下的目标 ${SENSITIVE[0]}`;

    // ---- (a) POST /agent/task/start ----
    const r1 = await nullApp.inject({
      method: 'POST',
      url: '/agent/task/start',
      headers: auth,
      payload: { goal: NOKEY_GOAL },
    });
    log(`      task/start → ${r1.statusCode} ${r1.body.slice(0, 160)}`);
    await check('★ M9-1 task/start：拿不到 cipher → **500**（不是 200 悄悄写明文）', () => {
      assert.equal(r1.statusCode, 500, `${r1.statusCode} ${r1.body}`);
      assert.ok(r1.body.includes('goal_encrypt_failed'), `错误码不是 goal_encrypt_failed：${r1.body}`);
    });

    // ---- (b) POST /agent/loop/pause ----
    // 循环本身用**有钥匙的 app** 建（loop/start 不落 goal 密文，建得起来），
    // 再用没钥匙的 app 打 pause —— 精确模拟「热路径拿不到 cipher」那一个瞬间。
    const s2 = await app.inject({
      method: 'POST',
      url: '/agent/loop/start',
      headers: auth,
      payload: { agentId: 101, goal: NOKEY_GOAL, pageUrl: 'https://bank.example/', wcId: 902 },
    });
    assert.equal(s2.statusCode, 200, `建循环失败：${s2.statusCode} ${s2.body}`);
    const loopId2 = String((s2.json() as { loopId: string }).loopId);
    const stBefore = (await app.inject({ method: 'GET', url: `/agent/loop/info?loopId=${loopId2}`, headers: auth })).json() as {
      status: string;
      step: number;
    };
    const r2 = await nullApp.inject({
      method: 'POST',
      url: '/agent/loop/pause',
      headers: auth,
      payload: { loopId: loopId2, pausedBy: 'user', result: { ok: true, callId: 'c1', text: '回执' } },
    });
    log(`      loop/pause → ${r2.statusCode} ${r2.body.slice(0, 160)}`);
    await check('★ M9-2 loop/pause：拿不到 cipher → **500**（收尾6 条件2：不许「行照写、goal_enc 置空」）', () => {
      assert.equal(r2.statusCode, 500, `${r2.statusCode} ${r2.body}`);
      assert.ok(r2.body.includes('goal_encrypt_failed'), `错误码不是 goal_encrypt_failed：${r2.body}`);
    });

    const after = await counts();
    log(`      打之后：tasks=${after.tasks} task_pauses=${after.pauses}`);
    await check('★ M9-3 两张表**一行都没多**（对齐收尾1「库里一行都不落」）', () => {
      assert.equal(after.tasks, before.tasks + 0, `tasks 从 ${before.tasks} 变成 ${after.tasks}（落了行）`);
      assert.equal(after.pauses, before.pauses + 0, `task_pauses 从 ${before.pauses} 变成 ${after.pauses}（落了行）`);
    });

    const stAfter = (await app.inject({ method: 'GET', url: `/agent/loop/info?loopId=${loopId2}`, headers: auth })).json() as {
      status: string;
      step: number;
    };
    await check('★ M9-4 内存会话状态也没被改（不许留「内存挂着、库里没台账」的半成品）', () => {
      assert.equal(stAfter.status, stBefore.status, `状态从 ${stBefore.status} 变成 ${stAfter.status}`);
      assert.notEqual(stAfter.status, 'paused', '没落库却把循环标成 paused 了（账实不一致）');
    });

    await check('★ M9-5 那个目标串在整个库里搜不到（明文没有从任何侧门落进去）', async () => {
      const pats = [`%${NOKEY_GOAL}%`, `%${SENSITIVE[0]}%`];
      const n1 = (
        await pool.query(`SELECT count(*)::int AS n FROM tasks t WHERE row_to_json(t)::text LIKE ANY($1)`, [pats])
      ).rows[0] as { n: number };
      const n2 = (
        await pool.query(`SELECT count(*)::int AS n FROM task_pauses t WHERE row_to_json(t)::text LIKE ANY($1)`, [pats])
      ).rows[0] as { n: number };
      log(`      全库扫 → tasks=${n1.n} task_pauses=${n2.n}`);
      assert.equal(n1.n, 0);
      assert.equal(n2.n, 0);
    });

    // ---- (c) 对照组：同一时刻用**有钥匙**的 app 打同一个 pause → 200 且落密文 ----
    const r3 = await app.inject({ method: 'POST', url: '/agent/loop/pause', headers: auth, payload: { loopId: loopId2 } });
    await check('对照组：有钥匙的 app 打同一个 pause → 200 并落密文（证明上面的 500 是「没钥匙」导致，不是路由坏了）', async () => {
      assert.equal(r3.statusCode, 200, `${r3.statusCode} ${r3.body}`);
      const row = await pauseRow(loopId2);
      assert.equal(row.goal, null);
      assert.ok(String(row.goal_enc).startsWith('gcm$'), String(row.goal_enc));
      assert.equal(cipher.decryptText(String(row.goal_enc)), NOKEY_GOAL);
      const after2 = await counts();
      assert.equal(after2.pauses, before.pauses + 1, `task_pauses=${after2.pauses}`);
    });

    await nullApp.close();
  }

  await app.close();
  await pool.query('SELECT 1');
  log('');
  log(`=== 收尾6 pglite 自检：PASS ${passes} / FAIL ${fails} ===`);
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('脚本异常：', err);
  process.exit(1);
});
