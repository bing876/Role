#!/usr/bin/env node
/**
 * 收尾 2 | board.md 落库锁 —— 反证：模拟进程重启后并发写，必须不丢数据。
 *
 * 场景（每种锁各跑一遍，同一套剧本）：
 *   进程 A（旧进程）开始并发追加 → 写到一半被 kill -9（模拟崩溃 / 重启）
 *   → 进程 A'（重启后的新进程）和进程 B（另一路，比如恢复出来的循环）**同时**追加
 *   → 数 board.md 里的条目：每一条「子进程报告写成功（WROTE）」的条目都必须在文件里。
 *
 *   * db 锁（生产实现 board_locks 行锁）：必须 0 丢失、无重复、文件结构完整；
 *     被 kill -9 时持有的行锁必须被 PG 自动释放（否则 A'/B 会卡到 lock_timeout）。
 *   * memory 锁（修 5 之前的进程内 Promise 链）：必须能复现丢失 —— 否则说明这个测试
 *     根本没制造出跨进程竞态，db 锁的 PASS 也就不可信。
 *   * db-prod：直接调生产入口 appendBoardWithLock（不插人为延迟），3 个进程并发，也必须 0 丢失。
 *
 * 用法：
 *   VERIFY_DATABASE_URL=postgres://... node scripts/verify/board-lock-db.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pg = require(require.resolve('pg', { paths: [path.join(ROOT, 'apps/server')] }));
// ★ 必须用 `node --import tsx`（单进程），不能用 tsx/dist/cli.mjs：
//   cli.mjs 会再 fork 一个子进程跑脚本，SIGKILL 只打到外层包装进程，真正在写的那个活得好好的 ——
//   第一版验收就栽在这里（A「被杀」后还继续写了 48 条）。下面还有一条「真死了」的硬校验兜底。
const TSX_IMPORT = 'tsx';
const WORKER = path.join(ROOT, 'scripts/verify/board-lock-worker.mts');

const DB = process.env.VERIFY_DATABASE_URL;
if (!DB) {
  console.error('需要 VERIFY_DATABASE_URL（指向一个可写的测试库）');
  process.exit(2);
}

let failed = false;
function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failed = true;
}

const pool = new pg.Pool({ connectionString: DB });

async function ensureSchema() {
  // 迁移由服务端做；这里只保证验收能单独跑（与 db.ts 中的 DDL 一致）
  await pool.query(`CREATE TABLE IF NOT EXISTS board_locks (
    project_id BIGINT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    version BIGINT NOT NULL DEFAULT 0, last_writer TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
}

async function makeProject() {
  const u = await pool.query(
    `INSERT INTO users (xyz_id) VALUES ($1) RETURNING id`,
    [`verify-board-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`],
  );
  const p = await pool.query(`INSERT INTO projects (user_id, name) VALUES ($1, 'board-lock-verify') RETURNING id`, [
    u.rows[0].id,
  ]);
  return { userId: Number(u.rows[0].id), projectId: Number(p.rows[0].id) };
}

function runWorker({ mode, projectId, tag, count, handoffRoot, hold = 15, conc = 4 }) {
  const child = spawn(process.execPath, ['--import', TSX_IMPORT, WORKER], {
    cwd: ROOT,
    env: {
      ...process.env,
      HANDOFF_ROOT: handoffRoot,
      BOARD_MODE: mode,
      BOARD_PROJECT_ID: String(projectId),
      BOARD_TAG: tag,
      BOARD_COUNT: String(count),
      BOARD_HOLD_MS: String(hold),
      BOARD_CONCURRENCY: String(conc),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const acked = new Set();
  let err = '';
  let buf = '';
  const listeners = [];
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const m = /^WROTE (\S+) (\d+)$/.exec(line);
      if (m) acked.add(`entry-${m[1]}-${m[2].padStart(3, '0')}`);
      for (const l of listeners) l(acked.size);
    }
  });
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise((res) => child.on('exit', (code, sig) => res({ code, sig })));
  return {
    child,
    acked,
    exited,
    getErr: () => err,
    onAck: (fn) => listeners.push(fn),
  };
}

function entriesIn(file) {
  const txt = fs.readFileSync(file, 'utf8');
  return txt.split('\n').filter((l) => l.startsWith('- ['));
}

async function scenario(mode) {
  const { projectId } = await makeProject();
  const handoffRoot = fs.mkdtempSync(path.join(os.tmpdir(), `board-${mode}-`));
  const board = path.join(handoffRoot, String(projectId), 'board.md');
  const t0 = Date.now();

  // 1) 旧进程 A 开始写，写够 6 条就 kill -9（此刻它大概率正持有锁 / 正处在读写窗口里）
  const A = runWorker({ mode, projectId, tag: 'A', count: 60, handoffRoot });
  // 等 A 把 tsx 编译完、真正开写再计时（首条 WROTE 之前的时间不算竞态窗口）
  await new Promise((res) => A.onAck((n) => n >= 6 && res()));
  A.child.kill('SIGKILL');
  const aExit = await A.exited;
  const ackedAtKill = A.acked.size;
  // 杀完再等 400ms：真死了的进程不可能再报 WROTE（这条挡住「杀的是包装进程」那种假 kill）
  await new Promise((r) => setTimeout(r, 400));
  const aReallyDead = A.acked.size === ackedAtKill && A.acked.size < 60;

  // 2) 「重启」：新进程 A2 与另一路 B 同时启动、同时写
  const A2 = runWorker({ mode, projectId, tag: 'A2', count: 25, handoffRoot });
  const B = runWorker({ mode, projectId, tag: 'B', count: 25, handoffRoot });
  const [a2Exit, bExit] = await Promise.all([A2.exited, B.exited]);
  const ms = Date.now() - t0;

  const acked = new Set([...A.acked, ...A2.acked, ...B.acked]);
  const lines = entriesIn(board);
  const present = new Set(lines.map((l) => l.replace(/^- \[\S+\] /, '')));
  const lost = [...acked].filter((e) => !present.has(e));
  const dup = lines.length - present.size;
  const version = mode === 'memory' ? null : Number(
    (await pool.query('SELECT version FROM board_locks WHERE project_id=$1', [projectId])).rows[0]?.version ?? 0,
  );
  const leftovers = fs.readdirSync(path.dirname(board)).filter((f) => f.endsWith('.tmp'));
  return { projectId, board, aExit, aReallyDead, ackedAtKill, a2Exit, bExit, acked, lines, lost, dup, version, ms, leftovers,
    errs: [A.getErr(), A2.getErr(), B.getErr()].join('').trim() };
}

try {
  await ensureSchema();

  console.log('=== 收尾 2 | board.md 落库锁：进程重启 + 跨进程并发写 ===\n');

  // ---------------- 生产实现：db 行锁 ----------------
  const d = await scenario('db');
  console.log(`[db 锁] A 被 ${d.aExit.sig ?? d.aExit.code} 杀掉前写成 ${[...d.acked].filter((e) => e.includes('-A-')).length} 条；` +
    `重启后 A2/B 退出码 ${d.a2Exit.code}/${d.bExit.code}；文件共 ${d.lines.length} 条；耗时 ${d.ms}ms`);
  check(d.aExit.sig === 'SIGKILL' && d.aReallyDead,
    `db：进程 A 被 kill -9 在第 ${d.ackedAtKill}/60 条处真正杀死（杀后不再有任何写入）`);
  check(d.a2Exit.code === 0 && d.bExit.code === 0, `db：重启后的 A2 与并发的 B 都正常写完（没被 A 遗留的锁卡死）${d.errs ? ' — ' + d.errs.slice(0, 200) : ''}`);
  check(d.lost.length === 0, `db：所有报告写成功的条目都在 board.md 里（丢失 ${d.lost.length} 条${d.lost.length ? '：' + d.lost.slice(0, 5).join(', ') : ''}）`);
  check(d.dup === 0, `db：没有重复条目（重复 ${d.dup}）`);
  check(d.lines.length === d.acked.size || d.lines.length === d.acked.size + 1,
    `db：文件条目数 ${d.lines.length} = 确认写成功的 ${d.acked.size}（+1 容许：A 在 COMMIT 后、报 WROTE 前被杀）`);
  check(d.version === d.lines.length, `db：board_locks.version = ${d.version}，恰好等于文件条目数（每次追加一次提交）`);
  check(fs.readFileSync(d.board, 'utf8').startsWith('# 项目 '), 'db：文件头完整（原子替换，没有半截文件）');

  // ---------------- 生产入口原样调用：3 进程并发 ----------------
  {
    const { projectId } = await makeProject();
    const handoffRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'board-prod-'));
    const ws = ['P1', 'P2', 'P3'].map((tag) => runWorker({ mode: 'db-prod', projectId, tag, count: 30, handoffRoot, conc: 5 }));
    const exits = await Promise.all(ws.map((w) => w.exited));
    const acked = new Set(ws.flatMap((w) => [...w.acked]));
    const lines = entriesIn(path.join(handoffRoot, String(projectId), 'board.md'));
    check(exits.every((e) => e.code === 0) && acked.size === 90 && lines.length === 90,
      `db-prod：生产入口 appendBoardWithLock，3 进程 × 30 条并发 → 文件 ${lines.length}/90 条`);
  }

  // ---------------- 反证：修 5 之前的进程内锁 ----------------
  const m = await scenario('memory');
  console.log(`\n[进程内锁·对照组] A 在第 ${m.ackedAtKill}/60 条处被杀；确认写成功 ${m.acked.size} 条，文件里只有 ${m.lines.length} 条`);
  check(m.aExit.sig === 'SIGKILL' && m.aReallyDead, '对照组：进程 A 同样被真正杀死（两组剧本一致）');
  check(m.lost.length > 0, `反证：换回进程内 Promise 链锁，同一剧本丢了 ${m.lost.length} 条（测试确实制造出了跨进程竞态）`);
} catch (err) {
  console.error('FAIL  脚本异常：', err.stack || err.message);
  failed = true;
} finally {
  await pool.end();
}
console.log(failed ? '\n=== 收尾 2：FAIL ===' : '\n=== 收尾 2：全部 PASS ===');
process.exit(failed ? 1 : 0);
