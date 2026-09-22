/**
 * P0 止血 —— 改动点 3（`/agent/loop/resume` 返回**可区分的语义原因**）的 HTTP 级探针
 *
 * ## 它在守什么
 * 桌面端以前是笼统 `catch`：只要「继续」这一步失败（网络抖一下、服务端忙一下、
 * 循环真过期了），都走同一条兜底 —— 静默新开一轮。
 *
 * 用户（2026-09-21 调整 4）的理由值得原样记下来：
 *   不区分原因的话，只要网络抖动也会弹「上下文没了，要重新开始吗」。
 *   这种误报的代价不是"多一次打扰"，而是**用户会被训练成不看内容就点「重新开始」**，
 *   等真丢了历史的那次照样无脑点下去 —— 安全网直接失效。
 *   所以「能区分原因」不是顺手优化，它是让那个确认弹窗**可信**的前提条件。
 *
 * 因此本探针不只验"过期时会带码"，还验"**非过期**的失败**不**带码"——
 * 后者才是防止误报的关键，只验前者等于守不住这条设计。
 *
 * ## 三条断言
 *   ① 循环不存在 → 404，且 body.code === 'loop_gone'      （该弹确认）
 *   ② loopId 缺失 → 400，且 body.code **不是** loop_gone    （不该弹确认）
 *   ③ 没带 token   → 401，且 body.code **不是** loop_gone    （不该弹确认）
 *
 * ## 为什么自己起服务端、自己收尾
 * 本机 agent 沙箱会在每次工具调用结束时回收派生进程，所以"这次起、下次验"必然失败。
 * 本脚本把「起服务端 → 断言 → 杀服务端」放在同一个进程里跑完。
 *
 * 用法：
 *     node scripts/verify/p0-loop-ttl/loop-gone-probe.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const SERVER_DIR = path.join(REPO, 'apps', 'server');
const NODE =
  fs.existsSync('C:/Users/bing/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe')
    ? 'C:/Users/bing/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe'
    : 'node';
const PORT = 8799; // ★ 不跟日常开发抢 8787（也避免撞上"上次留下的服务端"）
const BASE = `http://127.0.0.1:${PORT}`;

// ── 读 .env 拿 JWT_SECRET（密钥只存在 apps/server/.env，代码里没有兜底） ──
function readEnvSecret() {
  const raw = fs.readFileSync(path.join(SERVER_DIR, '.env'), 'utf8');
  const m = raw.match(/^\s*JWT_SECRET\s*=\s*(.+?)\s*$/m);
  if (!m) throw new Error('.env 里没有 JWT_SECRET');
  return m[1].replace(/^["']|["']$/g, '');
}

async function waitHealth(timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('服务端在 60 秒内没起来');
}

const results = [];
function check(n, title, ok, detail) {
  results.push({ n, title, ok: !!ok, detail: detail ?? '' });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${n}. ${title}${detail ? ` —— ${detail}` : ''}`);
}

const child = spawn(NODE, [path.join(SERVER_DIR, 'dist', 'index.js')], {
  cwd: SERVER_DIR, // ★ dotenv 从 cwd 读 .env，cwd 必须是 apps/server
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d.toString(); });
child.stderr.on('data', (d) => { serverLog += d.toString(); });

let exitCode = 0;
try {
  const health = await waitHealth();
  console.log(`服务端已就绪：/health db=${health?.db ?? '未知'}\n`);

  const token = jwt.sign({ sub: 1 }, readEnvSecret(), { algorithm: 'HS256', expiresIn: '1h' });

  // ① 循环不存在（= 过期被回收 / 服务端重启过）→ 必须带 loop_gone
  const r1 = await fetch(`${BASE}/agent/loop/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ loopId: 'loop_根本不存在' }),
  });
  const b1 = await r1.json().catch(() => ({}));
  check(
    1,
    '① 循环不存在 → 404 且带 code=loop_gone（桌面端据此才弹「要重新开始吗」）',
    r1.status === 404 && b1.code === 'loop_gone',
    `HTTP ${r1.status}，body=${JSON.stringify(b1)}`,
  );

  // ② 缺 loopId（参数错，不是过期）→ 绝不能带 loop_gone
  const r2 = await fetch(`${BASE}/agent/loop/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  const b2 = await r2.json().catch(() => ({}));
  check(
    2,
    '② 缺 loopId → 400 且**不带** loop_gone（参数错不是"上下文没了"，不许误报）',
    r2.status === 400 && b2.code !== 'loop_gone',
    `HTTP ${r2.status}，body=${JSON.stringify(b2)}`,
  );

  // ③ 未登录 → 绝不能带 loop_gone
  const r3 = await fetch(`${BASE}/agent/loop/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loopId: 'loop_x' }),
  });
  const b3 = await r3.json().catch(() => ({}));
  check(
    3,
    '③ 未登录 → 401 且**不带** loop_gone',
    r3.status === 401 && b3.code !== 'loop_gone',
    `HTTP ${r3.status}，body=${JSON.stringify(b3)}`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 条，通过 ${results.length - failed.length} 条，失败 ${failed.length} 条`);
  if (failed.length) {
    console.log('失败：' + failed.map((r) => r.n).join(', '));
    exitCode = 1;
  }
} catch (err) {
  console.log(`FAIL 探针自身出错：${err?.message ?? err}`);
  console.log('── 服务端日志尾部 ──\n' + serverLog.split('\n').slice(-25).join('\n'));
  exitCode = 2;
} finally {
  child.kill('SIGKILL');
  console.log('\n已关闭服务端');
}

process.exit(exitCode);
