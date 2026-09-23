/**
 * 收尾 2 反证用的「一个服务进程」：往同一项目的 board.md 追加 N 条。
 *
 * 由 scripts/verify/board-lock-db.mjs 以**独立子进程**方式拉起多份（模拟重启前后新旧进程并存），
 * 不要单独跑。
 *
 *   BOARD_MODE=db    → 用生产代码 appendBoardWithLock（board_locks 行锁）
 *   BOARD_MODE=memory → 用修 5 之前的进程内 Promise 链锁（原样复刻），作为反证对照组
 *
 * 为了让竞态稳定复现，两种模式都在「读」和「写」之间插了同样的 BOARD_HOLD_MS 延迟
 * （模拟慢盘 / 大文件）。db 模式的延迟通过导出的 withBoardDbLock 插在**同一个行锁内**，
 * 所以它测的就是生产用的那把锁本身。
 */
import fs from 'node:fs';
import pg from 'pg';
import {
  appendBoardWithLock,
  withBoardDbLock,
  ensureHandoffDir,
  getBoardPath,
} from '../../apps/server/src/orchestrator/handoff';

const MODE = process.env.BOARD_MODE ?? 'db';
const PROJECT_ID = Number(process.env.BOARD_PROJECT_ID);
const TAG = process.env.BOARD_TAG ?? `p${process.pid}`;
const COUNT = Number(process.env.BOARD_COUNT ?? 20);
const HOLD_MS = Number(process.env.BOARD_HOLD_MS ?? 15);
const CONCURRENCY = Number(process.env.BOARD_CONCURRENCY ?? 4);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 对照组：修 5 之前的进程内锁（原样复刻：Map<projectId, Promise> 链） ----
const memLocks = new Map<number, Promise<void>>();
async function withMemLock<T>(projectId: number, fn: () => Promise<T>): Promise<T> {
  const prev = memLocks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => (release = res));
  memLocks.set(projectId, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function slowAppend(boardPath: string, entry: string): Promise<void> {
  const current = fs.readFileSync(boardPath, 'utf8');
  await sleep(HOLD_MS); // 读与写之间的窗口：别的写者若能插进来就会被覆盖
  const tmp = `${boardPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, current + entry + '\n', 'utf8');
  fs.renameSync(tmp, boardPath);
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.VERIFY_DATABASE_URL, max: CONCURRENCY + 1 });
  ensureHandoffDir(PROJECT_ID);
  const boardPath = getBoardPath(PROJECT_ID);

  let nextIdx = 0;
  let written = 0;
  async function lane(): Promise<void> {
    for (;;) {
      const i = nextIdx++;
      if (i >= COUNT) return;
      const entry = `- [${TAG}] entry-${TAG}-${String(i).padStart(3, '0')}`;
      if (MODE === 'memory') {
        await withMemLock(PROJECT_ID, () => slowAppend(boardPath, entry));
      } else if (MODE === 'db-prod') {
        // 生产入口原样调用（无人为延迟）：证明 delegation.ts 实际走的这条路也不丢
        await appendBoardWithLock(pool, PROJECT_ID, 1, entry);
      } else {
        await withBoardDbLock(pool, PROJECT_ID, `verify-${TAG}`, () => slowAppend(boardPath, entry));
      }
      written += 1;
      // 每写完一条报一次，父进程靠它决定何时 kill -9
      process.stdout.write(`WROTE ${TAG} ${i}\n`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => lane()));
  process.stdout.write(`DONE ${TAG} ${written}\n`);
  await pool.end();
}

main().catch((err) => {
  process.stderr.write(`WORKER_ERR ${TAG} ${(err as Error).message}\n`);
  process.exit(1);
});
