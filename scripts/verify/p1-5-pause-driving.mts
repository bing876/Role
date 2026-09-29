/**
 * P1-5 验收：`pauseDriving` / `resumeDriving` 不再"撒谎式成功"。
 *
 * 背景（BUG_LIST P1-5）：
 *   `preload.ts` 暴露了 `pauseDriving()` / `resumeDriving()`，但渲染层零调用；
 *   而 `webBridge.ts`（浏览器预览用的垫片）里这两个是 `async () => true` ——
 *   **无条件返回成功，却什么都没做**。调用方拿到 `true` 会以为"暂停门按住了"，
 *   于是预览模式里点暂停，自动操作照旧跑。
 *
 * 本轮查证后发现 P1-5 的主诉已经过时，必须把话说准：
 *   · 渲染层**有**暂停入口 —— `useChat.ts:499` 调 `pauseTask(wcId)`，
 *     `browserGlue.ts:165` 调 `resumeTask(wcId)`，它们走 `workbench:task:pause`
 *     → `applyPaused(wcId, true)` → `t.paused = true`；
 *   · `drive()` 里真有一闸：`pausedOf(wcId) && PAUSED_BLOCKED.has(actionName)`
 *     （click / type / fill_form 会被拒）。所以"用户没有暂停入口"不成立。
 *   · 真正剩下的 residue 是两条：① 这两个是 `pauseTask` 的**重复死接口**；
 *     ② 垫片的返回值撒谎。本轮修 ②。
 *
 * 为什么"返回值必须可信"值得单独立测试：
 *   主进程的 `setDrivingPaused()` 返回的是 `pausedOf(wcId)` —— **门的真实状态**。
 *   垫片却返回写死的 `true`。同一个接口在两种环境下语义不一致，
 *   调用方没法根据返回值判断"到底按没按住"，这是隐性 bug 温床。
 *
 * 跑法：`npx tsx scripts/verify/p1-5-pause-driving.mts`
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (p: string): string => readFileSync(path.join(ROOT, p), 'utf8');

let bad = 0;
const log = (...a: unknown[]): void => console.log(a.map(String).join(' '));
const ok = (cond: boolean, msg: string): void => {
  log(`  ${cond ? 'PASS' : '★FAIL'} ${msg}`);
  if (!cond) bad += 1;
};

const wb = read('apps/desktop/src/webBridge.ts');
const drv = read('apps/desktop/electron/driver.ts');
const pre = read('apps/desktop/electron/preload.ts');

log('');
log('=== P1-5 · pauseDriving / resumeDriving 不再撒谎 ===');
log('');

// ---- ① 垫片不再无条件返回 true -------------------------------------------
log('--- ① webBridge 垫片：返回值从状态里读，不是写死的 true ---');
{
  const pauseIdx = wb.indexOf('pauseDriving: async');
  const resumeIdx = wb.indexOf('resumeDriving: async');
  ok(pauseIdx >= 0 && resumeIdx > pauseIdx, '两个实现都还在（接口只增不破，没删）');

  const pauseBody = wb.slice(pauseIdx, resumeIdx);
  ok(
    !/async\s*\([^)]*\)\s*=>\s*true/.test(pauseBody),
    'pauseDriving 不再是 `async (...) => true`（无条件成功）',
  );
  ok(
    /drivingPaused\[wcId\]\s*=\s*true/.test(pauseBody),
    'pauseDriving 真的落了暂停位（不是只返回个 true）',
  );
  ok(
    /return drivingPaused\[wcId\]\s*===\s*true/.test(pauseBody),
    'pauseDriving 的返回值**从暂停位读**，与主进程 pausedOf() 同语义',
  );
  ok(
    /taskStates\[wcId\]\s*=\s*st/.test(pauseBody) && /emit\('state'/.test(pauseBody),
    'pauseDriving 改了任务状态并广播（预览模式里看得见"已暂停"）',
  );

  const resumeBody = wb.slice(resumeIdx, wb.indexOf('startTask: async'));
  ok(
    !/async\s*\([^)]*\)\s*=>\s*true/.test(resumeBody),
    'resumeDriving 也不再是 `async (...) => true`',
  );
  ok(
    /drivingPaused\[wcId\]\s*=\s*false/.test(resumeBody),
    'resumeDriving 真的清了暂停位',
  );
  ok(
    /return drivingPaused\[wcId\]\s*===\s*false/.test(resumeBody),
    'resumeDriving 的返回值从暂停位读',
  );

  // 两份返回值判据必须不同：暂停看 true、恢复看 false。
  // 写成一样就是"反向也返回成功"，比写死 true 更糟。
  ok(
    /=== true/.test(pauseBody) && /=== false/.test(resumeBody),
    '两个方向的判据相反（暂停判 true、恢复判 false），不是同一个表达式',
  );
}

// ---- ② 主进程那一闸必须还在（垫片修了不等于真机有理）---------------------
log('');
log('--- ② 主进程 drive() 的暂停门仍在（真机的拦截在这） ---');
{
  // ★ 正则必须锚在 `if (` 上。首版写的是
  //    /pausedOf\(wcId\)\s*&&\s*PAUSED_BLOCKED\.has\(actionName\)/
  //    结果把 `if (false && pausedOf(wcId) && ...)` 也算通过 ——
  //    门被 `false &&` 禁用了，测试照样绿。反证 ③ 抓到的。
  //    锚定之后，`(` 后紧跟 pausedOf 才认；前面塞任何字面量都匹配不上。
  ok(
    /if\s*\(\s*pausedOf\(wcId\)\s*&&\s*PAUSED_BLOCKED\.has\(actionName\)\s*\)/.test(drv),
    'drive() 里仍是 `if (pausedOf(wcId) && PAUSED_BLOCKED.has(actionName))` —— 没被 false && 之类禁用',
  );
  ok(
    /const PAUSED_BLOCKED[^=]*=\s*new Set[^\[]*\[\s*'click'\s*,\s*'type'\s*,\s*'fill_form'\s*\]/.test(drv),
    'PAUSED_BLOCKED 仍覆盖 click / type / fill_form',
  );
  ok(
    /export function setDrivingPaused\(/.test(drv),
    'setDrivingPaused 仍导出（IPC 还在用）',
  );
  // setDrivingPaused 的返回值必须是真实状态，不能是写死的
  const fn = drv.slice(drv.indexOf('export function setDrivingPaused('));
  const fnEnd = fn.indexOf('\n}');
  ok(
    /return pausedOf\(wcId\)/.test(fn.slice(0, fnEnd)),
    'setDrivingPaused 返回 pausedOf(wcId)（真实门状态，与垫片对齐的依据）',
  );
}

// ---- ③ 渲染层的暂停入口确实存在（纠正 BUG_LIST 的过时主诉）--------------
log('');
log('--- ③ 渲染层暂停入口：BUG_LIST 说"零调用"，实测是有 ---');
{
  const chat = read('apps/desktop/src/features/chat/useChat.ts');
  const glue = read('apps/desktop/src/app/browserGlue.ts');
  ok(
    /window\.workbench\?\.pauseTask\(wcId\)/.test(chat),
    'useChat.ts 调了 pauseTask(wcId) —— 暂停入口存在',
  );
  ok(
    /window\.workbench\?\.resumeTask/.test(chat) || /window\.workbench\?\.resumeTask/.test(glue),
    'resumeTask 也有调用点（继续入口存在）',
  );
  ok(
    /workbench:pause-driving/.test(pre) && /pauseDriving:/.test(pre),
    'preload 仍暴露 pauseDriving / resumeDriving（接口只增不破，没删）',
  );
}

// ---- ④ 诚实的边界：本轮没做什么 -----------------------------------------
log('');
log('--- ④ 没做的部分（别让测试看起来像全修完了） ---');
{
  ok(
    !/最近一次用户真实输入|userActivity|lastUserInput/.test(drv),
    '★ 主进程仍没有"用户正在用鼠标就自动停"的检测 —— 那是 Q5 的新功能，需拍板',
  );
  ok(
    /pauseDriving/.test(wb) && /pauseTask/.test(wb),
    '两套接口仍并存（pauseDriving 与 pauseTask）—— 收敛要拍板，本轮只修撒谎',
  );
}

log('');
log(`=== 结论：${bad} 个问题 ===`);
log('  （本测试证明"返回值不再撒谎"；不证明"用户能被自动检测到并停下来" —— 见 ④）');
process.exit(bad > 0 ? 1 : 0);
