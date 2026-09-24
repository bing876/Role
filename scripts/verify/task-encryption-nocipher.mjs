/**
 * 收尾 6 · 条件2 反证 M9（真服务端 / 真 Postgres 版）
 * =====================================================
 *
 * 要证的事（用户 2026-09-24 提的验收条件 2）：
 *   让 `POST /agent/task/start` 与 `POST /agent/loop/pause` 在**路由层拿不到 cipher**，断言
 *     ① 两个接口都回 **500**（不是 200 悄悄把目标明文写进库）；
 *     ② `tasks` 与 `task_pauses` **一行都没多**（对齐收尾 1 对 loop_checkpoints 的口径：「库里一行都不落」）。
 *
 * 怎么造这个故障：临时把 `apps/server/src/index.ts` 里注册路由时传的 `cipher` 改成 `null`。
 * 为什么非得改启动装配、不能像 pglite 那样直接 inject：
 *   真服务端这条路要验的是**用户机器上真会发生的那个瞬间**（DATA_KEY 没配 / cipher 构造失败 /
 *   将来有人重构把注入弄丢），必须从 `index.ts` → `registerAgentRoutes` → 路由处理函数整条真装配走过去，
 *   还要落到真 Postgres 上数行。pglite 那份（task-encryption-pglite.mts 第 ⑧ 段）是**常驻回归闸**，
 *   每次 `npm run verify` 都跑；这一份是**深度反证**，按批次手工跑并把输出贴进验收报告。
 *
 * ★ 安全设计（改生产代码的脚本必须做到）：
 *   · 起飞前检查 `git status --porcelain apps/server/src/index.ts` **必须是干净的** —— 脏就拒跑，
 *     绝不把用户没提交的改动搅进来，也绝不覆盖别人的手工变异；
 *   · 记 md5，`finally` + SIGINT/SIGTERM/uncaughtException 四条路都会还原，还原后再比一次 md5；
 *   · 还原后再起一个**正常**服务端做对照组：同一个 pause 这次要 200 并落出 gcm$ 密文，
 *     证明上面的 500 是「没钥匙」导致的，不是路由本来就坏（否则这个反证什么也没证）。
 *
 * 跑法：
 *   VERIFY_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55432/verifydb' \
 *     npm run verify:db:mutate-nocipher
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { Client } = require(require.resolve('pg', { paths: [path.join(ROOT, 'apps/server')] }));

const DB = process.env.VERIFY_DATABASE_URL;
if (!DB) {
  console.error('需要 VERIFY_DATABASE_URL（真库地址）。这份反证只在真 Postgres 上跑才有意义。');
  process.exit(2);
}
const PORT = Number(process.env.VERIFY_PORT || 18799);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_KEY = crypto.randomBytes(32).toString('hex');
const JWT_SECRET = crypto.randomBytes(24).toString('hex');
const INDEX_TS = path.join(ROOT, 'apps/server/src/index.ts');

const SENSITIVE = ['银行卡6222021234567890', '密码Zx9!secret'];
const NOKEY_GOAL = `没钥匙也必须拦下的目标：给 ${SENSITIVE[0]} 转账，登录密码 ${SENSITIVE[1]}`;

let failed = false;
function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failed = true;
}

// ------------------------------------------------------------------ 变异与还原
const ORIGINAL = fs.readFileSync(INDEX_TS, 'utf8');
const ORIGINAL_MD5 = crypto.createHash('md5').update(ORIGINAL).digest('hex');

const TARGETS = [
  {
    from: 'registerAgentRoutes(app, { pool, env, cipher });',
    to: 'registerAgentRoutes(app, { pool, env, cipher: null as never }); // VERIFY-M9 临时变异，脚本结束必还原',
  },
  {
    from: 'registerLoopRoutes(app, { pool, env, cipher });',
    to: 'registerLoopRoutes(app, { pool, env, cipher: null as never }); // VERIFY-M9 临时变异，脚本结束必还原',
  },
];

let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  try {
    fs.writeFileSync(INDEX_TS, ORIGINAL);
    const now = crypto.createHash('md5').update(fs.readFileSync(INDEX_TS)).digest('hex');
    console.log(`\n[还原] apps/server/src/index.ts md5 ${now} ${now === ORIGINAL_MD5 ? '== 变异前，逐字节还原' : '!! 与变异前不一致，请立刻 git diff 检查'}`);
    if (now !== ORIGINAL_MD5) failed = true;
  } catch (err) {
    console.error('[还原] 失败：', err.message, '—— 请手工执行： git checkout -- apps/server/src/index.ts');
    failed = true;
  }
}
process.on('exit', restore);
process.on('SIGINT', () => {
  restore();
  process.exit(130);
});
process.on('SIGTERM', () => {
  restore();
  process.exit(143);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err);
  restore();
  process.exit(1);
});

function gitDirty(file) {
  try {
    return execFileSync('git', ['status', '--porcelain', '--', file], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (err) {
    return `git 查询失败：${err.message}`;
  }
}

// ------------------------------------------------------------------ 服务端与库工具
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

/** 发请求但**不**把非 2xx 当异常（这份反证要的就是 500） */
async function raw(method, url, body, token) {
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
  return { status: r.status, body: data, text };
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

async function counts() {
  const t = (await q(`SELECT count(*)::int AS n FROM tasks`)).rows[0].n;
  const p = (await q(`SELECT count(*)::int AS n FROM task_pauses`)).rows[0].n;
  return { tasks: t, pauses: p };
}

function openGcm(payload, dataKey) {
  const key = /^[0-9a-fA-F]{64}$/.test(dataKey) ? Buffer.from(dataKey, 'hex') : crypto.createHash('sha256').update(dataKey).digest();
  const [tag, iv, auth, ct] = String(payload).split('$');
  if (tag !== 'gcm') throw new Error('not gcm');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(auth, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// ------------------------------------------------------------------ 主流程
let srv = null;
try {
  console.log('=== 收尾6 · 条件2 反证 M9：路由层拿不到 cipher（真服务端 + 真 Postgres）===');
  console.log(`      目标库：${DB.replace(/:[^:@/]*@/, ':***@')}`);

  const dirty = gitDirty('apps/server/src/index.ts');
  if (dirty) {
    console.error(`[拒跑] apps/server/src/index.ts 不是干净状态（${JSON.stringify(dirty)}）。`);
    console.error('        这份反证要临时改这个文件再还原，脏树会把你的改动搅进来。先提交或还原它再跑。');
    process.exit(2);
  }
  console.log(`[起飞前] index.ts 干净，md5=${ORIGINAL_MD5}`);
  for (const t of TARGETS) {
    const n = ORIGINAL.split(t.from).length - 1;
    if (n !== 1) throw new Error(`变异锚点在 index.ts 里出现 ${n} 次（应当正好 1 次）：${t.from}`);
  }

  // ---- 打上变异：路由层拿不到 cipher ----
  let mutated = ORIGINAL;
  for (const t of TARGETS) mutated = mutated.replace(t.from, t.to);
  fs.writeFileSync(INDEX_TS, mutated);
  console.log('[变异] 已把 registerAgentRoutes / registerLoopRoutes 的 cipher 注入改成 null（下面所有断言都在这份代码上跑）');
  console.log(`[变异] git diff --stat：`);
  console.log(execFileSync('git', ['diff', '--stat', '--', 'apps/server/src/index.ts'], { cwd: ROOT, encoding: 'utf8' }).trim());

  srv = startServer();
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 60_000, '变异服务端 /health');
  await waitFor(() => srv.getLog().includes('数据库表就绪'), 90_000, '变异服务端建表迁移');
  check(true, '变异后的服务端照样能起来（env 里有 DATA_KEY，故障是「路由层没拿到 cipher」，不是「服务起不来」）');

  const phone = `139${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const sent = await raw('POST', '/auth/sms/send', { phone });
  const login = await raw('POST', '/auth/login/sms', { phone, code: sent.body.mock_code });
  const token = login.body.token;
  check(typeof token === 'string' && token.length > 20, '真登录拿到 JWT（打接口要用）');

  const before = await counts();
  console.log(`\n--- 打之前：tasks=${before.tasks} task_pauses=${before.pauses} ---`);

  // ---- ① POST /agent/task/start ----
  console.log('\n--- ① POST /agent/task/start（路由层 cipher=null）---');
  const r1 = await raw('POST', '/agent/task/start', { goal: NOKEY_GOAL }, token);
  console.log(`      → ${r1.status} ${r1.text.slice(0, 200)}`);
  check(r1.status === 500, `★ M9-①：task/start 回 **500**（实际 ${r1.status}）`);
  check(r1.body?.code === 'goal_encrypt_failed', `★ M9-①：错误码是 goal_encrypt_failed（实际 ${JSON.stringify(r1.body?.code)}）`);
  check(
    typeof r1.body?.error === 'string' && r1.body.error.includes('没有建'),
    `★ M9-①：错误话术说清了「这条任务没有建」（用户不会以为建成功了）：${r1.body?.error}`,
  );

  // ---- ② POST /agent/loop/pause ----
  console.log('\n--- ② POST /agent/loop/start + pause（路由层 cipher=null）---');
  // loop/start 会校验智能体归属，所以先给这个用户备一只；否则打不到 pause，反证就落空了
  const me = await raw('GET', '/auth/me', null, token);
  const userId = Number(me.body?.user?.id ?? me.body?.id ?? 0);
  check(userId > 0, `本次反证收口到 user_id=${userId}`);
  let projectId = (await q(`SELECT id FROM projects WHERE user_id = $1 ORDER BY id LIMIT 1`, [userId])).rows[0]?.id;
  if (!projectId) {
    projectId = (
      await q(`INSERT INTO projects (user_id, name, is_default) VALUES ($1,'变异测试项目',true) RETURNING id`, [userId])
    ).rows[0].id;
  }
  const agentId = Number(
    (await q(`INSERT INTO agents (project_id, name, kind) VALUES ($1,'变异测试小助','assistant') RETURNING id`, [projectId]))
      .rows[0].id,
  );
  check(agentId > 0, `建了一只归属当前用户的智能体（project=${projectId}, agentId=${agentId}），loop/start 才放行`);

  const ls = await raw('POST', '/agent/loop/start', { agentId, goal: NOKEY_GOAL, pageUrl: 'https://bank.example/' }, token);
  console.log(`      loop/start → ${ls.status} ${ls.text.slice(0, 160)}`);
  check(ls.status === 200, `loop/start 仍然 200（它本身不落 goal 密文；记忆块拼装失败只 warn，不拦建循环）`);
  const loopId = ls.body?.loopId;
  check(typeof loopId === 'string' && loopId.length > 0, `拿到 loopId=${loopId}`);

  const infoBefore = await raw('GET', `/agent/loop/info?loopId=${loopId}`, null, token);
  const rp = await raw('POST', '/agent/loop/pause', { loopId, pausedBy: 'user' }, token);
  console.log(`      loop/pause → ${rp.status} ${rp.text.slice(0, 200)}`);
  check(rp.status === 500, `★ M9-②：loop/pause 回 **500**（实际 ${rp.status}）`);
  check(rp.body?.code === 'goal_encrypt_failed', `★ M9-②：错误码是 goal_encrypt_failed（实际 ${JSON.stringify(rp.body?.code)}）`);
  check(
    typeof rp.body?.error === 'string' && rp.body.error.includes('没有被挂起'),
    `★ M9-②：话术说清了「这一路没有被挂起」（用户不会以为已经暂停了）：${rp.body?.error}`,
  );

  // ---- ③ 库里一行都没多 ----
  const after = await counts();
  console.log(`\n--- 打之后：tasks=${after.tasks} task_pauses=${after.pauses} ---`);
  check(after.tasks === before.tasks, `★ M9-③：tasks 一行都没多（${before.tasks} → ${after.tasks}）`);
  check(after.pauses === before.pauses, `★ M9-③：task_pauses 一行都没多（${before.pauses} → ${after.pauses}）`);

  // ---- ④ 明文没从侧门落库 ----
  const pats = [`%${NOKEY_GOAL}%`, ...SENSITIVE.map((x) => `%${x}%`)];
  const leakT = (await q(`SELECT count(*)::int AS n FROM tasks t WHERE row_to_json(t)::text LIKE ANY($1)`, [pats])).rows[0].n;
  const leakP = (await q(`SELECT count(*)::int AS n FROM task_pauses t WHERE row_to_json(t)::text LIKE ANY($1)`, [pats])).rows[0].n;
  console.log(`      全库扫这次的目标串/敏感词 → tasks=${leakT} task_pauses=${leakP}`);
  check(leakT === 0, `★ M9-④：tasks 全表里搜不到这次的目标明文（${leakT} 行）`);
  check(leakP === 0, `★ M9-④：task_pauses 全表里搜不到这次的目标明文（${leakP} 行）`);

  // ---- ⑤ 内存状态也没被改（账实一致） ----
  const infoAfter = await raw('GET', `/agent/loop/info?loopId=${loopId}`, null, token);
  console.log(`      loop/info：打之前 status=${infoBefore.body?.status} → 打之后 status=${infoAfter.body?.status}`);
  check(
    infoAfter.body?.status === infoBefore.body?.status,
    `★ M9-⑤：循环内存状态没被改（${infoBefore.body?.status} → ${infoAfter.body?.status}）—— 不留「内存挂着、库里没台账」的半成品`,
  );
  check(infoAfter.body?.status !== 'paused', '★ M9-⑤：没落库却把循环标成 paused 的话就是账实不一致，这里必须不是 paused');
  const warnLine = srv.getLog().split('\n').find((l) => l.includes('暂停') && l.includes('被拒绝'));
  console.log(`      服务端 warn 原文：${warnLine ?? '（没有）'}`);
  check(!!warnLine, '★ M9-⑤：服务端把这次拒绝 warn 出来了（运维能看见，不是静默失败）');
  check(!warnLine?.includes(SENSITIVE[0]) && !warnLine?.includes(NOKEY_GOAL), '★ M9-⑤：那条 warn 里不含目标明文（日志不是第二个明文出口）');

  srv.child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));

  // ---- ⑥ 对照组：还原后同一条 pause 要 200 并落密文 ----
  restore();
  console.log('\n--- ⑥ 对照组：还原 index.ts 后重启，同一个 pause 必须成功（证明上面的 500 是「没钥匙」造成的）---');
  srv = startServer();
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 60_000, '对照组服务端 /health');
  await waitFor(() => srv.getLog().includes('数据库表就绪'), 90_000, '对照组服务端建表迁移');
  const rp2 = await raw('POST', '/agent/loop/pause', { loopId, pausedBy: 'user' }, token);
  console.log(`      loop/pause → ${rp2.status} ${rp2.text.slice(0, 160)}`);
  // 循环是内存态，重启后 loopId 已失效 → 这里重新建一条，比的是「同一份代码在有钥匙时的行为」
  if (rp2.status === 404) {
    const ls2 = await raw('POST', '/agent/loop/start', { agentId, goal: NOKEY_GOAL, pageUrl: 'https://bank.example/' }, token);
    const loopId2 = ls2.body?.loopId;
    const rp3 = await raw('POST', '/agent/loop/pause', { loopId: loopId2, pausedBy: 'user' }, token);
    console.log(`      重启后内存循环已失效（404，符合预期）→ 重新建 ${loopId2} 再暂停 → ${rp3.status} ${rp3.text.slice(0, 160)}`);
    check(rp3.status === 200, `对照组：有钥匙时 loop/pause 回 200（实际 ${rp3.status}）`);
    const row = (await q(`SELECT goal, goal_enc FROM task_pauses WHERE loop_id=$1`, [loopId2])).rows[0];
    check(row && row.goal === null, '对照组：task_pauses.goal 明文列是 NULL');
    check(row && String(row.goal_enc).startsWith('gcm$'), '对照组：goal_enc 落的是 gcm$ 密文');
    check(row && openGcm(row.goal_enc, DATA_KEY) === NOKEY_GOAL, '对照组：密文解回来正是那句目标（功能没坏）');
    const ts = await raw('POST', '/agent/task/start', { goal: NOKEY_GOAL }, token);
    check(ts.status === 200, `对照组：有钥匙时 task/start 回 200（实际 ${ts.status}）`);
    const trow = (await q(`SELECT title, payload, goal_enc FROM tasks WHERE id=$1`, [ts.body?.taskId])).rows[0];
    check(trow && trow.title === null && !('goal' in (trow.payload ?? {})), '对照组：tasks 只落密文（title NULL、payload 无 goal 键）');
    check(trow && openGcm(trow.goal_enc, DATA_KEY) === NOKEY_GOAL, '对照组：tasks.goal_enc 解回来正是那句目标');
    const after2 = await counts();
    check(after2.pauses === after.pauses + 1 && after2.tasks === after.tasks + 1, `对照组：两张表各多 1 行（pauses ${after.pauses}→${after2.pauses}、tasks ${after.tasks}→${after2.tasks}）`);
  } else {
    check(rp2.status === 200, `对照组：有钥匙时 loop/pause 回 200（实际 ${rp2.status}）`);
  }

  srv.child.kill('SIGTERM');
} catch (err) {
  console.error('FAIL  脚本异常：', err.message);
  if (srv) console.error(srv.getLog().split('\n').slice(-30).join('\n'));
  failed = true;
} finally {
  try {
    srv?.child?.kill('SIGTERM');
  } catch {}
  restore();
  const dirtyAfter = gitDirty('apps/server/src/index.ts');
  console.log(`[收尾] git status --porcelain apps/server/src/index.ts → ${JSON.stringify(dirtyAfter)}（必须是空串）`);
  if (dirtyAfter) failed = true;
}

console.log(failed ? '\n=== 条件2 反证 M9（真服务端）：FAIL ===' : '\n=== 条件2 反证 M9（真服务端）：全部 PASS ===');
process.exit(failed ? 1 : 0);
