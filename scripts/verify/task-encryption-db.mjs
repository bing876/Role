#!/usr/bin/env node
/**
 * 收尾 6 | 复验 task_pauses.goal / tasks.payload.goal 加密 —— **真服务端 + 真 PostgreSQL + 直连 SELECT**。
 *
 * 为什么要真库（这是上一轮用丢失代码换来的口径）：只读源码永远发现不了
 * 「DO $$ 写成 DO $」「saveCheckpoint 拿不到 cipher 会回退明文」这类真 bug。
 * 所以这里跑的是**完整生产链路**，一处都不打桩：
 *
 *   真服务端（tsx 跑 apps/server/src/index.ts，含真 DDL 迁移与启动回填）
 *   → 真登录（/auth/sms/send + /auth/login/sms）
 *   → POST /agent/task/start（goal 里带银行卡号/密码/身份证）
 *   → POST /agent/task/step、/agent/task/finish、GET /agent/task/doc、GET /agent/task/current
 *   → POST /agent/loop/start + /agent/loop/pause、GET /agent/loop/pauses
 *   → 用 pg **直连真库** SELECT 原始行，断言：
 *       · tasks.payload 里没有 goal 键、title 为 NULL、goal_enc 是 gcm$ 密文
 *       · task_pauses.goal 为 NULL、goal_enc 是 gcm$ 密文
 *       · 两张表整行 row_to_json 里搜不到任何一个敏感词
 *       · 同一把 DATA_KEY 能把密文解回**原目标**（证明是真加密，不是把内容丢了）
 *       · 接口层用户照样拿得到目标（task/current、task/doc、loop/pauses）——「用户能感知」的那一半
 *   → 再插两条**历史明文行**，kill 掉服务端、用同一把 DATA_KEY 重启，
 *     确认启动时的 migrateTaskGoalEncryption 真把它们回填成了密文并清掉明文
 *     （这一段验的是 index.ts 的接线，不是函数本身：函数在 pglite 自检里已经验过）。
 *
 * 用法：
 *   VERIFY_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/db node scripts/verify/task-encryption-db.mjs
 *   （库需要是一个**可以随便写的测试库**：脚本会建表、插用户，不删别人的数据；
 *     所有断言都按本次登录出来的 user_id 收口，不受库里既有数据影响）
 *
 * 反证（必须做，做法见 docs/acceptance/收尾6-goal加密-验收报告.md）：
 *   把生产代码改坏（例如让 task/start 回到明文 payload、让 pause 写 session.goal、
 *   让启动回填直接 return），本脚本必须变红。只跑绿不跑红不算验收。
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { Client } = require(require.resolve('pg', { paths: [path.join(ROOT, 'apps/server')] }));

const DB = process.env.VERIFY_DATABASE_URL;
if (!DB) {
  console.error('需要 VERIFY_DATABASE_URL（指向一个可写的测试库）');
  process.exit(2);
}
const PORT = Number(process.env.VERIFY_PORT || 18788);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_KEY = crypto.randomBytes(32).toString('hex');
// ★ JWT_SECRET 必须**三次启动共用一把**：真实部署里它是稳定配置，而本脚本要验
//   「重启后接口层还读得到老目标」—— 每次启动随机换一把的话，重启后旧 token 直接 401，
//   验的就成了鉴权而不是加密（第一版就栽在这里）。
const JWT_SECRET = crypto.randomBytes(24).toString('hex');
const SENSITIVE = ['银行卡6222021234567890', '密码Zx9!secret', '身份证110101199003071234'];
const GOAL = `帮我查一下 ${SENSITIVE[0]} 的余额，登录用 ${SENSITIVE[1]}，实名 ${SENSITIVE[2]}`;
const LEGACY_PAUSE_GOAL = `老挂起：把 ${SENSITIVE[2]} 的资料下载下来`;
const LEGACY_TASK_GOAL = `老任务：给 ${SENSITIVE[0]} 转账，密码 ${SENSITIVE[1]}`;

let failed = false;
function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failed = true;
}

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), 'apps/server/src/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: DB,
      JWT_SECRET,
      DATA_KEY,
      PHONE_PEPPER: crypto.randomBytes(32).toString('hex'),
      NODE_ENV: 'development',
      SMS_MOCK: '1',
      DEEPSEEK_API_KEY: 'mock',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  return { child, getLog: () => log };
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await fn()) return;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function j(method, url, body, token) {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    const e = new Error(`${method} ${url} → ${r.status} ${text.slice(0, 300)}`);
    e.status = r.status;
    e.body = data;
    throw e;
  }
  return data;
}

function openGcm(payload, dataKey) {
  const key = /^[0-9a-fA-F]{64}$/.test(dataKey) ? Buffer.from(dataKey, 'hex') : crypto.createHash('sha256').update(dataKey).digest();
  const [tag, iv, auth, ct] = String(payload).split('$');
  if (tag !== 'gcm') throw new Error('not gcm');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(auth, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

/** 自己封一份合法密文（造「残行」用：goal_enc 有值 + 明文也在） */
function sealGcm(text, dataKey) {
  const key = /^[0-9a-fA-F]{64}$/.test(dataKey) ? Buffer.from(dataKey, 'hex') : crypto.createHash('sha256').update(dataKey).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(text, 'utf8')), c.final()]);
  return ['gcm', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('$');
}

async function q(sql, params) {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

let srv = startServer();
try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 40_000, '服务端 /health');
  await waitFor(() => srv.getLog().includes('数据库表就绪'), 90_000, '建表迁移完成');

  // ------------------------------------------------------------------ 登录
  const phone = `138${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const sent = await j('POST', '/auth/sms/send', { phone });
  const login = await j('POST', '/auth/login/sms', { phone, code: sent.mock_code });
  const token = login.token;
  check(typeof token === 'string' && token.length > 20, '真登录拿到 JWT');
  const me = await j('GET', '/auth/me', null, token).catch(() => null);
  const userId = Number(me?.user?.id ?? me?.id ?? 0);
  check(userId > 0, `本次验收收口到 user_id=${userId}（所有断言只看这个用户的行）`);

  // ------------------------------------------------- ① 任务：真链路建 → 直连查
  console.log('\n--- ① POST /agent/task/start + step：tasks 表只落密文 ---');
  const started = await j('POST', '/agent/task/start', { goal: GOAL }, token);
  const taskId = Number(started.taskId);
  check(Number.isInteger(taskId) && taskId > 0, `建出任务 #${taskId}`);
  await j('POST', '/agent/task/step', { taskId, summary: '打开了网银首页', ok: true }, token);

  const taskRow = (
    await q(
      `SELECT id, status, title, payload, goal_enc, result_enc, row_to_json(t)::text AS whole
         FROM tasks t WHERE id = $1`,
      [taskId],
    )
  ).rows[0];
  console.log(
    `\n--- SELECT id, status, title, payload, goal_enc FROM tasks WHERE id = ${taskId} ---\n` +
      JSON.stringify(
        {
          id: taskRow.id,
          status: taskRow.status,
          title: taskRow.title,
          payload: taskRow.payload,
          goal_enc: taskRow.goal_enc ? taskRow.goal_enc.slice(0, 32) + '…' : taskRow.goal_enc,
        },
        null,
        0,
      ) + '\n',
  );
  check(taskRow.title === null, `tasks.title 为 NULL（不再抄 goal 前 80 字当明文副本）；实际 ${JSON.stringify(taskRow.title)}`);
  check(
    taskRow.payload && typeof taskRow.payload === 'object' && !('goal' in taskRow.payload),
    `tasks.payload 里没有 goal 键；实际键 = ${JSON.stringify(Object.keys(taskRow.payload ?? {}))}`,
  );
  check(Array.isArray(taskRow.payload?.steps) && taskRow.payload.steps.length === 1, 'payload.steps 正常记了一步（功能没被吃掉）');
  check(typeof taskRow.goal_enc === 'string' && taskRow.goal_enc.startsWith('gcm$'), 'tasks.goal_enc 以 gcm$ 开头');
  for (const s of SENSITIVE) check(!taskRow.whole.includes(s), `tasks 整行 row_to_json 里读不到「${s}」`);
  check(!/[\u4e00-\u9fa5]/.test(String(taskRow.goal_enc)), 'goal_enc 密文列里一个中文字都没有');
  let goalBack = '';
  try {
    goalBack = openGcm(taskRow.goal_enc, DATA_KEY);
  } catch (err) {
    goalBack = `<解密失败 ${err.message}>`;
  }
  check(goalBack === GOAL, '用 DATA_KEY 解 tasks.goal_enc 能还原原始 goal');

  // ------------------------------------------------- ② 暂停：task_pauses 只落密文
  console.log('\n--- ② POST /agent/loop/start + pause：task_pauses 表只落密文 ---');
  const agents = await j('GET', '/agents', null, token);
  const agentList = agents.agents ?? agents.items ?? agents;
  const agentId = Array.isArray(agentList) && agentList[0] ? Number(agentList[0].id) : null;
  const loop = await j('POST', '/agent/loop/start', { goal: GOAL, agentId, wcId: 11 }, token);
  const loopId = loop.loopId;
  check(typeof loopId === 'string' && loopId.length > 0, `建循环 ${loopId}`);
  const paused = await j('POST', '/agent/loop/pause', { loopId }, token);
  check(paused.ok === true && paused.recordId !== null, `挂起成功，暂停记录 #${paused.recordId}`);

  const pauseRow = (
    await q(
      `SELECT id, loop_id, goal, goal_enc, paused_by, row_to_json(t)::text AS whole
         FROM task_pauses t WHERE loop_id = $1`,
      [loopId],
    )
  ).rows[0];
  console.log(
    `\n--- SELECT id, loop_id, goal, goal_enc, paused_by FROM task_pauses WHERE loop_id = '${loopId}' ---\n` +
      JSON.stringify(
        {
          id: pauseRow.id,
          loop_id: pauseRow.loop_id,
          goal: pauseRow.goal,
          goal_enc: pauseRow.goal_enc ? pauseRow.goal_enc.slice(0, 32) + '…' : pauseRow.goal_enc,
          paused_by: pauseRow.paused_by,
        },
        null,
        0,
      ) + '\n',
  );
  check(pauseRow.goal === null, `task_pauses.goal 明文列为 NULL；实际 ${JSON.stringify(pauseRow.goal)}`);
  check(typeof pauseRow.goal_enc === 'string' && pauseRow.goal_enc.startsWith('gcm$'), 'task_pauses.goal_enc 以 gcm$ 开头');
  for (const s of SENSITIVE) check(!pauseRow.whole.includes(s), `task_pauses 整行 row_to_json 里读不到「${s}」`);
  let pauseGoalBack = '';
  try {
    pauseGoalBack = openGcm(pauseRow.goal_enc, DATA_KEY);
  } catch (err) {
    pauseGoalBack = `<解密失败 ${err.message}>`;
  }
  check(pauseGoalBack === GOAL, '用 DATA_KEY 解 task_pauses.goal_enc 能还原原始 goal');

  // ------------------------------------------------- ③ 用户能感知的那一半
  console.log('\n--- ③ 用户能感知：接口层照样拿得到目标（加密不能把功能吃掉）---');
  const pauses = await j('GET', `/agent/loop/pauses?loopId=${loopId}`, null, token);
  const rec = (pauses.records ?? []).find((x) => x.loopId === loopId);
  check(!!rec, '/agent/loop/pauses 里有这条记录');
  check(rec?.goal === GOAL, 'GET /agent/loop/pauses 返回的 goal 是解密后的原文');

  const finished = await j('POST', '/agent/task/finish', { taskId, summary: '余额已查到' }, token);
  check(finished.ok === true, '任务收尾成功（unread 红点已置）');
  const doc = await j('GET', `/agent/task/doc?taskId=${taskId}`, null, token);
  check(typeof doc.markdown === 'string' && doc.markdown.includes(GOAL), 'GET /agent/task/doc 的「## 目标」是解密后的原文');
  const cur = await j('GET', '/agent/task/current', null, token);
  check(cur.task && Number(cur.task.id) === taskId, `GET /agent/task/current 回到任务 #${cur.task?.id}`);
  check(cur.task?.goal === GOAL, 'GET /agent/task/current 的 goal 是解密后的原文（桌面刷新后还原任务卡靠它）');

  /**
   * ★ 收尾 6 条件1（2026-09-24 用户要求）：`tasks.title` 停用之后，「界面到底显示什么」必须被验收盯住。
   *   查清的事实：服务端**没有**任何任务列表接口（grep 全仓只有 `/agent/task/current` 一个读单条的口子），
   *   桌面 apps/desktop/src/App.tsx 那行渲染读的是 curTask.goal：
   *       {curTask.goal ? ' · 目标：' + curTask.goal : ''}
   *   tasks.title 从来没有被返回给任何客户端 → 停用它**不会**让界面出现空白标题，
   *   所以用户给的条件（「如果列表标题会空白才改存脱敏摘要」）不触发，title 保持 NULL。
   *   但「显示字段非空 + 不含敏感词」仍然要有断言，所以服务端多回一个 displayTitle：
   *   同一句 goal 过 scrubTaskText 脱敏、截 80 字，专门给「要落日志/截图/列表」的场景用。
   */
  const dt = cur.task?.displayTitle;
  console.log(
    '--- GET /agent/task/current 的显示字段 ---\n' +
      JSON.stringify({ id: cur.task?.id, title: cur.task?.title, displayTitle: dt, goal: cur.task?.goal }) + '\n',
  );
  check(typeof dt === 'string' && dt.trim().length > 0, '★ 条件1：显示字段 displayTitle 非空（实际 ' + JSON.stringify(dt) + '）');
  check(dt.length <= 80, '★ 条件1：显示字段不超 80 字（实际 ' + dt.length + ' 字，跟当年 title 一个量级，不撑破界面）');
  for (const sen of SENSITIVE) check(!dt.includes(sen), '★ 条件1：显示字段里读不到「' + sen + '」');
  check(dt.includes('[已脱敏'), '★ 条件1：显示字段留了脱敏占位（看得出被改过，不是悄悄截断）：' + dt);
  check(GOAL.startsWith(dt.slice(0, 6)), '★ 条件1：显示字段确实是那句目标的脱敏版（不是随便填的占位文字）');
  check(cur.task?.title === null || cur.task?.title === undefined, '★ 条件1：title 没有偷偷存一份脱敏摘要（实际 ' + JSON.stringify(cur.task?.title) + '）');
  check(cur.task?.goal === GOAL, '★ 条件1：功能字段 goal 仍是还原后的原文（脱敏只作用于显示副本，没把功能吃掉）');

  const afterFinish = (
    await q(`SELECT title, payload, result_enc, row_to_json(t)::text AS whole FROM tasks t WHERE id = $1`, [taskId])
  ).rows[0];
  check(!('goal' in (afterFinish.payload ?? {})), '收尾写回 payload 后依然没有 goal 键（payloadWithoutGoal 生效）');
  check(afterFinish.title === null, '收尾后 title 仍然是 NULL');
  check(typeof afterFinish.result_enc === 'string' && afterFinish.result_enc.startsWith('gcm$'), 'result_enc（任务文档）仍是密文');
  for (const s of SENSITIVE) check(!afterFinish.whole.includes(s), `收尾后 tasks 整行里读不到「${s}」`);

  // ------------------------------------------------- ④ 重启回填（验 index.ts 接线）
  console.log('\n--- ④ 历史明文行 + 真重启：启动时的 migrateTaskGoalEncryption 有没有真跑 ---');
  // 直接用 SQL 造「收尾 6 之前形状」的历史行：明文在 task_pauses.goal / tasks.payload.goal / tasks.title
  const projectId = (
    await q(`SELECT id FROM projects WHERE user_id = $1 ORDER BY id LIMIT 1`, [userId])
  ).rows[0].id;
  const legacyPause = await q(
    `INSERT INTO task_pauses (user_id, loop_id, goal, paused_by, resumed_at)
     VALUES ($1, 'legacy-loop-verify6', $2, 'user', now()) RETURNING id`,
    [userId, LEGACY_PAUSE_GOAL],
  );
  const legacyPauseId = Number(legacyPause.rows[0].id);
  const legacyTask = await q(
    `INSERT INTO tasks (project_id, status, title, payload)
     VALUES ($1, 'done', $2, $3::jsonb) RETURNING id`,
    [projectId, LEGACY_TASK_GOAL.slice(0, 80), JSON.stringify({ goal: LEGACY_TASK_GOAL, steps: ['老步骤'], doc: { summary: '老的结论' } })],
  );
  const legacyTaskId = Number(legacyTask.rows[0].id);
  /**
   * ★ 残行（真库验收抓出来的第三种形状）：**goal_enc 已有值 + 明文列也还有值**。
   * 灰度/回滚期间新旧代码各写一半、人工改过库，都会留下这种行。
   * 第一版回填的条件是 `WHERE goal_enc IS NULL`，这种行**永远**轮不到 → 明文永远清不掉，
   * 而只造「纯老行」的验收照样全绿。现在扫描条件是「明文还在不在」。
   */
  const RESIDUE_FULL =
    `完整目标：先把 ${SENSITIVE[0]} 最近三年的流水全部导出来存成本地表格，` +
    `登录时用 ${SENSITIVE[1]}，经办人实名信息是 ${SENSITIVE[2]}，导出完成后把汇总表发到工作群`;
  if (RESIDUE_FULL.length <= 80) throw new Error('残行目标必须长过 80 字，否则验不出 title 截断的坑');
  const residuePause = await q(
    `INSERT INTO task_pauses (user_id, loop_id, goal, goal_enc, paused_by, resumed_at)
     VALUES ($1,'residue-loop-verify6',$2,$3,'user',now()) RETURNING id`,
    [userId, RESIDUE_FULL, sealGcm(RESIDUE_FULL, DATA_KEY)],
  );
  const residuePauseId = Number(residuePause.rows[0].id);
  const residueTask = await q(
    `INSERT INTO tasks (project_id, status, title, payload, goal_enc)
     VALUES ($1,'done',$2,'{"steps":["残行步骤"]}'::jsonb,$3) RETURNING id`,
    [projectId, RESIDUE_FULL.slice(0, 80), sealGcm(RESIDUE_FULL, DATA_KEY)],
  );
  const residueTaskId = Number(residueTask.rows[0].id);
  const residuePauseEncBefore = (await q(`SELECT goal_enc FROM task_pauses WHERE id=$1`, [residuePauseId])).rows[0].goal_enc;
  const residueTaskEncBefore = (await q(`SELECT goal_enc FROM tasks WHERE id=$1`, [residueTaskId])).rows[0].goal_enc;
  /**
   * ★ 收尾 6 条件3（2026-09-24 用户拍板）：**密文与明文不一致**的行不许自动清明文。
   *   这里造两条「人工改过库」形状的行：goal_enc 能解、但解出来跟明文不是一句话。
   *   期望：重启（回填真跑）之后**两份都还在、一个字节没动**，且启动日志 warn 出这两行的 id。
   *   明文里故意带敏感词 —— 如实反映这个取舍的代价：人工处理掉之前它确实会躺在库里，
   *   补偿控制是那条 warn（所以第 ⑤ 段的兜底扫按 id 排除这两行，并断言排除数正好是 2）。
   */
  const MISMATCH_PAUSE_GOAL = `不一致的明文暂停目标，里面还有 ${SENSITIVE[1]}`;
  const MISMATCH_TASK_GOAL = `不一致的明文任务目标，里面还有 ${SENSITIVE[0]}`;
  const mismatchPause = await q(
    `INSERT INTO task_pauses (user_id, loop_id, goal, goal_enc, paused_by, resumed_at)
     VALUES ($1,'mismatch-loop-verify6',$2,$3,'user',now()) RETURNING id`,
    [userId, MISMATCH_PAUSE_GOAL, sealGcm('密文里是完全不同的另一句话', DATA_KEY)],
  );
  const mismatchPauseId = Number(mismatchPause.rows[0].id);
  const mismatchTask = await q(
    `INSERT INTO tasks (project_id, status, title, payload, goal_enc)
     VALUES ($1,'done',NULL,$2::jsonb,$3) RETURNING id`,
    [projectId, JSON.stringify({ goal: MISMATCH_TASK_GOAL, steps: ['不一致行的步骤'] }), sealGcm('密文里的另一句目标', DATA_KEY)],
  );
  const mismatchTaskId = Number(mismatchTask.rows[0].id);
  const mismatchPauseEncBefore = (await q(`SELECT goal_enc FROM task_pauses WHERE id=$1`, [mismatchPauseId])).rows[0].goal_enc;
  const mismatchTaskEncBefore = (await q(`SELECT goal_enc FROM tasks WHERE id=$1`, [mismatchTaskId])).rows[0].goal_enc;

  console.log(
    `      造历史明文行：task_pauses#${legacyPauseId}、tasks#${legacyTaskId}；` +
      `造残行：task_pauses#${residuePauseId}、tasks#${residueTaskId}（密文与明文同时有值）；` +
      `造不一致行：task_pauses#${mismatchPauseId}、tasks#${mismatchTaskId}（密文能解但与明文不同）`,
  );
  const beforeRestart = (await q(`SELECT goal, goal_enc FROM task_pauses WHERE id=$1`, [legacyPauseId])).rows[0];
  check(
    beforeRestart.goal === LEGACY_PAUSE_GOAL && beforeRestart.goal_enc === null,
    '重启前它是明文形状（goal 有值、goal_enc 为 NULL）—— 否则这段验收是自欺',
  );

  // 真重启：kill 掉再起一个（同一把 DATA_KEY，模拟用户机器上的服务重启）
  srv.child.kill('SIGTERM');
  await waitFor(() => srv.child.exitCode !== null || srv.child.killed, 15_000, '旧服务端退出').catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  srv = startServer();
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 40_000, '重启后 /health');
  await waitFor(() => srv.getLog().includes('数据库表就绪'), 90_000, '重启后建表迁移');
  await waitFor(() => srv.getLog().includes('goal 密文回填完成'), 90_000, '启动日志出现 goal 密文回填完成');
  const backfillLog = srv
    .getLog()
    .split('\n')
    .filter((l) => l.includes('goal 密文回填'))
    .join('\n');
  console.log(`\n--- 重启后的服务端日志（回填那几行）---\n${backfillLog}\n`);
  check(/task_pauses \d+ 条、tasks \d+ 条/.test(backfillLog), '启动日志如实报了回填条数');

  const legacyPauseAfter = (
    await q(`SELECT goal, goal_enc, row_to_json(t)::text AS whole FROM task_pauses t WHERE id=$1`, [legacyPauseId])
  ).rows[0];
  console.log(
    `--- SELECT goal, goal_enc FROM task_pauses WHERE id = ${legacyPauseId} ---\n` +
      JSON.stringify({ goal: legacyPauseAfter.goal, goal_enc: String(legacyPauseAfter.goal_enc).slice(0, 32) + '…' }) + '\n',
  );
  check(legacyPauseAfter.goal === null, '重启后 task_pauses.goal 明文被清成 NULL');
  check(String(legacyPauseAfter.goal_enc).startsWith('gcm$'), '重启后 task_pauses.goal_enc 是密文');
  check(openGcm(legacyPauseAfter.goal_enc, DATA_KEY) === LEGACY_PAUSE_GOAL, '重启后密文能解回那条老目标');
  for (const s of SENSITIVE) check(!legacyPauseAfter.whole.includes(s), `重启后老暂停行整行里读不到「${s}」`);

  const legacyTaskAfter = (
    await q(`SELECT title, payload, goal_enc, row_to_json(t)::text AS whole FROM tasks t WHERE id=$1`, [legacyTaskId])
  ).rows[0];
  console.log(
    `--- SELECT title, payload, goal_enc FROM tasks WHERE id = ${legacyTaskId} ---\n` +
      JSON.stringify({
        title: legacyTaskAfter.title,
        payload: legacyTaskAfter.payload,
        goal_enc: String(legacyTaskAfter.goal_enc).slice(0, 32) + '…',
      }) + '\n',
  );
  check(legacyTaskAfter.title === null, '重启后 tasks.title 里的明文副本被清掉');
  check(!('goal' in (legacyTaskAfter.payload ?? {})), '重启后 tasks.payload 里的明文 goal 键被摘掉');
  check(
    JSON.stringify(legacyTaskAfter.payload?.steps) === JSON.stringify(['老步骤']) &&
      legacyTaskAfter.payload?.doc?.summary === '老的结论',
    'payload 的其余内容（steps/doc）一个字节没动 —— 回填不是「清空重写」',
  );
  check(openGcm(legacyTaskAfter.goal_enc, DATA_KEY) === LEGACY_TASK_GOAL, '重启后 tasks.goal_enc 能解回那条老目标');
  for (const s of SENSITIVE) check(!legacyTaskAfter.whole.includes(s), `重启后老任务行整行里读不到「${s}」`);

  // 重启后接口层还读得到老目标吗（解密优先 + 回填后的老行）
  const oldDoc = await j('GET', `/agent/task/doc?taskId=${legacyTaskId}`, null, token);
  check(
    typeof oldDoc.markdown === 'string' && oldDoc.markdown.includes('老任务'),
    '重启后 GET /agent/task/doc 仍能给出老任务的目标（回填没有把老数据变成读不出来）',
  );

  const residuePauseAfter = (
    await q(`SELECT goal, goal_enc FROM task_pauses WHERE id=$1`, [residuePauseId])
  ).rows[0];
  const residueTaskAfter = (
    await q(`SELECT title, payload, goal_enc FROM tasks WHERE id=$1`, [residueTaskId])
  ).rows[0];
  console.log(
    `--- SELECT goal, goal_enc FROM task_pauses WHERE id = ${residuePauseId}（残行）---\n` +
      JSON.stringify({ goal: residuePauseAfter.goal, goal_enc: String(residuePauseAfter.goal_enc).slice(0, 32) + '…' }) + '\n',
  );
  console.log(
    `--- SELECT title, payload, goal_enc FROM tasks WHERE id = ${residueTaskId}（残行）---\n` +
      JSON.stringify({
        title: residueTaskAfter.title,
        payload: residueTaskAfter.payload,
        goal_enc: String(residueTaskAfter.goal_enc).slice(0, 32) + '…',
      }) + '\n',
  );
  check(residuePauseAfter.goal === null, '残行（密文+明文同时有值）重启后明文列被清掉 —— 没有因为「已有密文」被跳过');
  check(
    residuePauseAfter.goal_enc === residuePauseEncBefore,
    '残行 task_pauses.goal_enc **逐字节没变**（保留已有密文，不是重加密换 IV）',
  );
  check(residueTaskAfter.title === null, '残行 tasks.title 的截断明文被清掉');
  check(
    residueTaskAfter.goal_enc === residueTaskEncBefore,
    '残行 tasks.goal_enc **逐字节没变**（没被 title 的 80 字截断值覆盖）',
  );
  check(
    openGcm(residueTaskAfter.goal_enc, DATA_KEY) === RESIDUE_FULL,
    '残行密文解出来仍是**完整**目标（长过 80 字，证明没被截断值污染）',
  );
  check(
    JSON.stringify(residueTaskAfter.payload?.steps) === JSON.stringify(['残行步骤']) && !('goal' in (residueTaskAfter.payload ?? {})),
    '残行 payload 其余内容原样、且没有 goal 键',
  );

  /**
   * ★ 条件3 的正题：**跨真重启**之后，不一致行的两份内容都还在，且日志 warn 出了行 id。
   *   必须放在重启之后 —— 回填是启动时跑的，只有在真启动里没被清掉才算数。
   */
  const mmPauseAfter = (
    await q(`SELECT goal, goal_enc, row_to_json(t)::text AS whole FROM task_pauses t WHERE id=$1`, [mismatchPauseId])
  ).rows[0];
  const mmTaskAfter = (
    await q(`SELECT title, payload, goal_enc, row_to_json(t)::text AS whole FROM tasks t WHERE id=$1`, [mismatchTaskId])
  ).rows[0];
  console.log(
    `--- SELECT goal, goal_enc FROM task_pauses WHERE id = ${mismatchPauseId}（不一致行）---\n` +
      JSON.stringify({ goal: mmPauseAfter.goal, goal_enc: String(mmPauseAfter.goal_enc).slice(0, 32) + '…' }) + '\n',
  );
  console.log(
    `--- SELECT title, payload, goal_enc FROM tasks WHERE id = ${mismatchTaskId}（不一致行）---\n` +
      JSON.stringify({ title: mmTaskAfter.title, payload: mmTaskAfter.payload, goal_enc: String(mmTaskAfter.goal_enc).slice(0, 32) + '…' }) + '\n',
  );
  check(mmPauseAfter.goal === MISMATCH_PAUSE_GOAL, '★ 条件3：不一致的 task_pauses 行**明文还在**（没被自动清掉）');
  check(mmPauseAfter.goal_enc === mismatchPauseEncBefore, '★ 条件3：不一致的 task_pauses 行**密文逐字节没变**（没被明文覆盖）');
  check(openGcm(mmPauseAfter.goal_enc, DATA_KEY) === '密文里是完全不同的另一句话', '★ 条件3：那份密文仍能解出它自己的内容（两份都可读，人才有的判）');
  check(mmTaskAfter.payload?.goal === MISMATCH_TASK_GOAL, '★ 条件3：不一致的 tasks 行 payload.goal **还在**');
  check(mmTaskAfter.goal_enc === mismatchTaskEncBefore, '★ 条件3：不一致的 tasks 行密文逐字节没变');
  check(
    JSON.stringify(mmTaskAfter.payload?.steps) === JSON.stringify(['不一致行的步骤']),
    '★ 条件3：不一致行的 payload 其余内容也没被动过（整行原样，不是只留一半）',
  );
  const mismatchWarn = srv
    .getLog()
    .split('\n')
    .filter((l) => l.includes('不一致'))
    .join('\n');
  console.log(`--- 重启后的服务端日志（不一致行 warn 原文）---\n${mismatchWarn}\n`);
  check(mismatchWarn.length > 0, '★ 条件3：启动日志**打了 warn**（不是只在返回值里记个数）');
  check(mismatchWarn.includes(`task_pauses#${mismatchPauseId}`), `★ 条件3：warn 里列出了受影响行 id task_pauses#${mismatchPauseId}`);
  check(mismatchWarn.includes(`tasks#${mismatchTaskId}`), `★ 条件3：warn 里列出了受影响行 id tasks#${mismatchTaskId}`);
  check(mismatchWarn.includes('人工'), '★ 条件3：warn 说清了「交人判断」，不是含糊的一句「有异常」');
  check(
    !mismatchWarn.includes(MISMATCH_PAUSE_GOAL) && !mismatchWarn.includes(MISMATCH_TASK_GOAL),
    '★ 条件3：warn 里**不含目标内容**（只报 id，日志不该变成第二个明文出口）',
  );
  for (const sen of SENSITIVE) check(!mismatchWarn.includes(sen), `★ 条件3：warn 里读不到敏感词「${sen}」`);
  const srvWarnLine = srv.getLog().split('\n').find((l) => l.includes('[server] goal 回填有'));
  check(!!srvWarnLine && srvWarnLine.includes('2 行'), `★ 条件3：index.ts 那层也如实报了不一致行数（实际：${srvWarnLine ?? '（没有）'}）`);

  // ------------------------------------------------- ⑤ 全表兜底扫（按本次用户收口）
  console.log('\n--- ⑤ 兜底扫：本次用户名下两张表不许有任何明文目标 ---');
  const pats = SENSITIVE.map((s) => `%${s}%`);
  /**
   * 排除口径说清楚：mismatchPauseId / mismatchTaskId 是条件3**故意留着**的不一致行
   * （两份都在、等人判断），它们的明文按设计就还在库里。兜底扫要验的是「正常路径零明文」，
   * 所以按 id 排掉这两行，并且**断言排除数正好是 2** —— 免得将来「排除名单」悄悄变长。
   */
  const EXCLUDED_PAUSE = mismatchPauseId;
  const EXCLUDED_TASK = mismatchTaskId;
  const leakTasks = (
    await q(
      `SELECT count(*)::int AS n FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE p.user_id = $1 AND t.id <> $3 AND row_to_json(t)::text LIKE ANY($2)`,
      [userId, pats, EXCLUDED_TASK],
    )
  ).rows[0].n;
  const leakPauses = (
    await q(
      `SELECT count(*)::int AS n FROM task_pauses t WHERE t.user_id = $1 AND t.id <> $3 AND row_to_json(t)::text LIKE ANY($2)`,
      [userId, pats, EXCLUDED_PAUSE],
    )
  ).rows[0].n;
  const plainTasks = (
    await q(
      `SELECT count(*)::int AS n FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE p.user_id = $1 AND t.id <> $2 AND ((t.payload->>'goal') IS NOT NULL OR t.title IS NOT NULL)`,
      [userId, EXCLUDED_TASK],
    )
  ).rows[0].n;
  const plainPauses = (
    await q(`SELECT count(*)::int AS n FROM task_pauses WHERE user_id = $1 AND id <> $2 AND goal IS NOT NULL`, [userId, EXCLUDED_PAUSE])
  ).rows[0].n;
  console.log(
    `      row_to_json 含敏感词：tasks=${leakTasks} task_pauses=${leakPauses}；` +
      `明文位置有值：tasks(payload.goal/title)=${plainTasks} task_pauses(goal)=${plainPauses}`,
  );
  check(leakTasks === 0, `tasks 里含敏感词的行数 = ${leakTasks}`);
  check(leakPauses === 0, `task_pauses 里含敏感词的行数 = ${leakPauses}`);
  check(plainTasks === 0, `tasks 里明文位置（payload.goal / title）有值的行数 = ${plainTasks}`);
  check(plainPauses === 0, `task_pauses 里明文 goal 有值的行数 = ${plainPauses}`);
  const excludedNow = (
    await q(
      `SELECT (SELECT count(*)::int FROM task_pauses WHERE id = $1 AND goal IS NOT NULL)
            + (SELECT count(*)::int FROM tasks WHERE id = $2 AND (payload->>'goal') IS NOT NULL) AS n`,
      [EXCLUDED_PAUSE, EXCLUDED_TASK],
    )
  ).rows[0].n;
  console.log(`      兜底扫排除的「故意留着的不一致行」= ${excludedNow} 行（条件3 的取舍，上面已单独断言两份都在）`);
  check(excludedNow === 2, `排除名单只该有那 2 行（实际 ${excludedNow}）—— 多了说明别的行也在留明文，得查`);

  // 幂等：回填已经跑过一次，重启第二次不该再改任何行（用日志里没有「回填完成」证明）
  console.log('\n--- ⑥ 幂等：再重启一次，不该重复回填 ---');
  srv.child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  srv = startServer();
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 40_000, '第三次启动 /health');
  await waitFor(() => srv.getLog().includes('数据库表就绪'), 90_000, '第三次启动建表');
  await new Promise((r) => setTimeout(r, 2500));
  const thirdLog = srv.getLog();
  check(!thirdLog.includes('goal 密文回填完成'), '第三次启动没有再报回填（0 行可改 = 幂等，不是又加密了一遍）');
  check(
    thirdLog.split('\n').some((l) => l.includes('不一致') && l.includes(`task_pauses#${mismatchPauseId}`)),
    '★ 条件3：第三次启动**仍然**报这两行不一致（不会被「已处理过」吃掉 —— 人不来看它就一直吵）',
  );
  const mmStill = (await q(`SELECT goal FROM task_pauses WHERE id=$1`, [mismatchPauseId])).rows[0];
  check(mmStill.goal === MISMATCH_PAUSE_GOAL, '★ 条件3：第三次启动后明文依旧原样（多次重启也不会被清）');
  const stillOk = (await q(`SELECT goal_enc FROM task_pauses WHERE id=$1`, [legacyPauseId])).rows[0];
  check(openGcm(stillOk.goal_enc, DATA_KEY) === LEGACY_PAUSE_GOAL, '多次重启后密文仍能解回原目标（没被二次加密）');
} catch (err) {
  console.error('FAIL  脚本异常：', err.message);
  console.error(srv.getLog().split('\n').slice(-30).join('\n'));
  failed = true;
} finally {
  try {
    srv.child.kill('SIGTERM');
  } catch {}
}
console.log(failed ? '\n=== 收尾6 goal 加密真库复验：FAIL ===' : '\n=== 收尾6 goal 加密真库复验：全部 PASS ===');
process.exit(failed ? 1 : 0);
