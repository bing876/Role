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

    // 残行 D：密文能解但**内容不同**（人工改过库）→ 保留密文、清明文、如实计入 mismatched
    const d = await pool.query(
      `INSERT INTO task_pauses (user_id, loop_id, goal, goal_enc, paused_by, resumed_at)
       VALUES (1,'residue-d',$1,$2,'user',now()) RETURNING id`,
      ['明文写的另一个目标', cipher.encryptText('密文里的目标')],
    );
    const dId = Number((d.rows[0] as { id: string }).id);

    const r = await migrateTaskGoalEncryption(pool, cipher);
    log(`      残行回填：${JSON.stringify(r)}`);
    await check('四条残行都被处理了（pauses 3 条 + tasks 1 条），没有一条因为「已有密文」被跳过', () => {
      assert.equal(r.pauses, 3, `pauses=${r.pauses}`);
      assert.equal(r.tasks, 1, `tasks=${r.tasks}`);
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
    await check('残行 D：密文与明文不一致 → 保留密文、清明文、mismatched 计数 +1', () => {
      assert.equal(r.mismatched, 1, `mismatched=${r.mismatched}`);
      assert.equal(dAfter.goal, null, '明文没被清掉');
      assert.equal(cipher.decryptText(String(dAfter.goal_enc)), '密文里的目标', '密文被明文覆盖了');
    });
    await check('encrypted 只算了真需要新加密的那 1 条（残行 C）', () => {
      assert.equal(r.encrypted, 1, `encrypted=${r.encrypted}`);
    });
    await check('四条残行整行里都搜不到敏感词了', async () => {
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
