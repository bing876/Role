#!/usr/bin/env node
/**
 * 收尾 9 | 修 3 的真 `kill -9` 测试（驱动脚本，照收尾 2 的双进程做法）。
 *
 * 场景（用户 2026-09-25 拍板的原话）：**工具执行后、结果落库前 kill -9，重启确认工具没被执行第二次。**
 *
 *   进程 A（worker，run 模式，跑生产 toolLoop + checkpoint 代码 + 真 PGlite 文件库）
 *     → 循环拿到第一个工具调用 open_url → **执行它**（executed.log 记一行）
 *     → 写 marker（= "工具已执行、结果还没喂回服务端"）
 *   驱动等 marker 出现 → **对进程 A 发真 SIGKILL（kill -9）**
 *     → 验"真死了"（board-lock 的规矩：杀后 400ms 不许再有任何写入）
 *     → 驱动**直接打开那个库**（此刻没有任何进程持有它）确认 kill 确实落在
 *       「工具已执行、结果未落库」这个窗口：checkpoint 行 pending_call_id = 那个 callId，
 *       而 executed_tool_ids 里没有它
 *   进程 A'（worker，resume 模式，同一个库）
 *     → `restoreLoops` 恢复循环 → 把桌面手里那份结果喂回 → 必须**接得上**
 *       （回执的 tool_call_id = 原来的 callId，不是 `call_<step>` 孤儿）
 *     → 继续走完剩下两步（read_page → stop）
 *
 * 最终判据（端到端的"没被执行第二次"）：
 *   executed.log 里 **open_url 恰好一行**、总执行恰好两行（open_url + read_page）、
 *   没有任何 callId 出现两次。
 *
 * ★ 为什么必须是真 kill -9（而不是逻辑模拟）：修 3 保护的是**进程被硬杀**之后的
 *   checkpoint 状态。逻辑模拟（restart-recovery.mjs 那种 in-process 调函数）测不到
 *   "进程没了、内存全丢、只剩库里那一行"这件事 —— 收尾 2 当年就是这么踩出来的教训。
 * ★ worker 必须用 `node --import tsx` 起（board-lock 的同一条坑）：tsx CLI 会再 fork
 *   一层包装进程，SIGKILL 只打死外层、真正在跑的内层活得好好的。
 *
 * 反证：`scripts/verify/loop-kill9-revert-proof.py`（把修 3 的"下发前落库"或"恢复时读回"
 *   分别拆掉 → 本脚本必须红）。
 *
 * 用法：node scripts/verify/loop-kill9-db.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKER = path.join(ROOT, 'scripts/verify/loop-kill9-worker.mts');

let failed = false;
function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failed = true;
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-kill9-'));
const dbPath = path.join(workdir, 'db');
const executedLog = path.join(workdir, 'executed.log');
const markerPath = path.join(workdir, 'marker.json');

const CHILD_ENV = {
  ...process.env,
  DATABASE_URL: `pglite://${dbPath}`, // worker 自己按 workdir 建库；env.ts 要求这个变量存在
  JWT_SECRET: 'kill9-test-jwt-secret-0123456789',
  DATA_KEY: 'a'.repeat(64),
  PHONE_PEPPER: 'b'.repeat(64),
  ENABLE_DEV_MOCK_LLM: '1',
  PORT: '39999', // worker 不起 HTTP，只是 env.ts 要求一个合法端口
};

function spawnWorker(mode) {
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER, mode, workdir], {
    env: CHILD_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });
  return { child, out: () => out };
}

function waitForFile(p, timeoutMs) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    (function tick() {
      if (fs.existsSync(p)) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(tick, 100);
    })();
  });
}
const waitExit = (child, timeoutMs) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), timeoutMs);
    child.on('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('');
console.log('=== 收尾 9 · 修 3 真 kill -9：工具执行后、结果落库前杀进程，重启不许执行第二次 ===');
console.log(`（工作目录：${workdir}）`);

// ---------------------------------------------------------------- 进程 A
const A = spawnWorker('run');
const markerSeen = await waitForFile(markerPath, 60_000);
check(markerSeen, '进程 A 发出第一个工具调用并执行了（marker 出现）');
if (!markerSeen) {
  console.log('  A 的日志：\n' + A.out().split('\n').slice(-12).join('\n'));
  A.child.kill('SIGKILL');
  process.exit(1);
}
const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
const logBefore = fs.existsSync(executedLog) ? fs.readFileSync(executedLog, 'utf8') : '';
check(
  logBefore.includes(`${marker.callId}\topen_url\t`),
  `工具（open_url ${marker.url}）确实被执行过（executed.log 有记账）`,
);

// ---------------------------------------------------------------- 真 kill -9
const killedAt = Date.now();
A.child.kill('SIGKILL');
const aExit = await waitExit(A.child, 10_000);
check(aExit.signal === 'SIGKILL', `进程 A 被真 SIGKILL 杀死（signal=${aExit.signal ?? 'none'}，退出码=${aExit.code ?? '-'}）`);
// "真死了"硬校验：死掉的进程不可能再写入（board-lock 的同一条规矩，防"杀的是包装进程"）
await sleep(400);
const logAfterKill = fs.existsSync(executedLog) ? fs.readFileSync(executedLog, 'utf8') : '';
check(logAfterKill === logBefore, '杀后 400ms 没有任何新写入（进程真的死了，不是杀了个壳）');

// ---------------------------------------------------------------- kill 窗口落在哪（直接查库）
const pgliteMod = require(require.resolve('@electric-sql/pglite', { paths: [path.join(ROOT, 'apps/server')] }));
const pglite = new pgliteMod.PGlite(dbPath);
let cpRow = null;
try {
  const r = await pglite.query('SELECT * FROM loop_checkpoints WHERE id=$1', [marker.loopId]);
  cpRow = r.rows && r.rows[0] ? r.rows[0] : null;
} catch (err) {
  console.log(`  （读 checkpoint 行失败：${err.message}）`);
} finally {
  await pglite.close().catch(() => {});
}
const executedIds = Array.isArray(cpRow?.executed_tool_ids) ? cpRow.executed_tool_ids : [];
check(
  !!cpRow && cpRow.status === 'running',
  `kill 后库里还有这个循环（status=${cpRow?.status ?? '（行不存在）'}）—— 不是"循环丢了"`,
);
check(
  cpRow?.pending_call_id === marker.callId,
  `kill 时 pending_call_id 已落库 = ${marker.callId}（"下发前先落库"生效；实际=${cpRow?.pending_call_id ?? '（空）'}）`,
);
check(
  !executedIds.includes(marker.callId),
  `kill 落在"工具已执行、**结果未落库**"的窗口里（executed_tool_ids=${JSON.stringify(executedIds)}）`,
);
check(
  executedIds.every((x) => typeof x === 'string' && /^call_/.test(x)),
  `executed_tool_ids 列里存的全是 **call id**（实际=${JSON.stringify(executedIds)}；混进工具名 = 修 3 的列被污染，重启后去重比不中）`,
);

// ---------------------------------------------------------------- 进程 A'（重启）
console.log('');
console.log('--- 重启新进程，把桌面手里那份结果喂回去 ---');
const Ap = spawnWorker('resume');
const apExit = await waitExit(Ap.child, 90_000);
const apOut = Ap.out();
console.log(apOut.split('\n').filter((l) => l.trim()).slice(-6).join('\n'));
check(apExit.code === 0 && !apExit.timeout, `重启后的进程 A' 正常走完剩余步（退出码=${apExit.code ?? 'timeout'}）`);
check(!/RESUME-FAIL/.test(apOut), `A' 没有报恢复失败（${apOut.match(/RESUME-FAIL[^\n]*/)?.[0] ?? '无异常'}）`);
check(/RESUME-OK/.test(apOut), '重启进程报告恢复成功并走到 done（RESUME-OK）');
const execLine = apOut.match(/RESUME-EXECUTED (\[.*\])/)?.[1] ?? '[]';
const execArr = JSON.parse(execLine);
check(
  execArr.includes(marker.callId),
  `重启后喂回结果，executedToolIds 里记上了原来的 call id（实际=${execLine}）`,
);
check(
  !execArr.includes('open_url'),
  `executedToolIds 里没有工具名混进来（实际=${execLine}）`,
);

// ---------------------------------------------------------------- 端到端判据：没被执行第二次
const logFinal = fs.existsSync(executedLog) ? fs.readFileSync(executedLog, 'utf8').trim() : '';
const lines = logFinal ? logFinal.split('\n') : [];
const openUrlLines = lines.filter((l) => l.split('\t')[1] === 'open_url');
const callIds = lines.map((l) => l.split('\t')[0]);
const dupes = callIds.filter((c, i) => callIds.indexOf(c) !== i);
console.log('');
console.log(`executed.log（共 ${lines.length} 行）：`);
for (const l of lines) console.log(`  ${l}`);
check(lines.length === 2, `整个崩溃前后，工具一共只被执行了 2 次（open_url + read_page），实际 ${lines.length} 次`);
check(openUrlLines.length === 1, `open_url 恰好执行了 1 次（没有"重启后又打开一遍网页"），实际 ${openUrlLines.length} 次`);
check(dupes.length === 0, `没有任何 callId 被执行过两次${dupes.length ? `（重复：${dupes.join(', ')}）` : ''}`);
check(lines[0]?.startsWith(marker.callId), '第一次执行的就是 kill 前那次 open_url');

// ---------------------------------------------------------------- 结论
try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
console.log('');
console.log(`=== 结论：${failed ? '失败' : '通过'} ===`);
console.log('  （工作目录已清理）');
process.exit(failed ? 1 : 0);
