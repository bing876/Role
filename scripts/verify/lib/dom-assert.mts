import assert from 'node:assert/strict';

/**
 * 共享断言助手：**比较两个 DOM 节点是不是同一个**。
 *
 * 为什么要有它（真踩过两次，退出码 137）：
 *   `assert.equal(domEl, null)` / `assert.deepEqual(elA, elB)` 在**失败**时，
 *   Node 会去 `inspect` 这两个 jsdom 元素 —— jsdom 的元素图是环形巨图，
 *   于是内存爆掉、进程被 OOM 杀掉（退出码 137，连"哪条断言红了"都看不到）。
 *
 * ★ 所以全仓 `scripts/verify/**` 里：**DOM 元素一律不进断言库**，
 *   要比就用这个助手（内部是 `assert.ok(a === b, msg)`，失败时只打印你的话）。
 *   这条规矩由 `scripts/verify/gate-static-rules.py` 静态守着（不是靠记性）。
 */
export function sameNode<T>(a: T, b: T, msg: string): void {
  assert.ok(a === b, msg);
}
