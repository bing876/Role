/**
 * 闲置提取的「已处理切点」账本 —— 修 #6（2026-09-29）。
 *
 * ## 原状与它坏在哪
 *
 *     const done = new Set<string>();
 *     ...
 *     if (done.size > 800) done.clear();     // ← 整体清空
 *
 * 这是 `docs/待办清单-P2P3重排-20260920.md` §4 点名批评的**同一个模式**，
 * 和 #4（`if (ipHits.size > 5000) ipHits.clear()`）是同胞：
 *
 *   **「容量压力下整体清空集合」是一个会自我失效的防线。**
 *
 * #6 的具体后果：`done` 被清空的下一秒，那些**还落在 15~60 分钟闲置窗口内**的
 * 会话又变成"没处理过" → 下一轮扫描**再整理一次记忆**。同一切点重复喂模型，
 * 用户完全无感，但**计费**。而且——**越是会话多、越是压力大的账号，越容易撞上**，
 * 也就是说这条防线恰好在最需要它的时候失效。
 *
 * ## 修法（照 #4 的定案：永远不整体清空）
 *
 *   记 `{ key → at }`，超上限时**逐条淘汰**，而且**优先淘汰已经没用的**：
 *     ① 先淘汰**过期**的（切点早就过了 60 分钟窗口，永远不会再被扫到）；
 *     ② 仍超上限，按最旧逐条淘汰少量（兜底，正常不该走到）。
 *
 * 为什么①几乎让②变成不可达：`done` 的 key 是 `c{会话}:{最后消息号}`，
 * 一个会话只在**有新消息**时才产生新 key。所以稳态大小 ≈
 * "最近 90 分钟内被动过的切点数"，天然有界；TTL 一淘汰就回到低位。
 */

/** 账本上限（与原状的 800 同值，只换淘汰方式） */
export const DONE_MAX = 800;
/**
 * 一条记录活过这么久就没意义了：会话的闲置窗口上界是 60 分钟
 * （见 startIdleScheduler 里 `ago > 60 * 60_000` 就跳过），
 * 超过 90 分钟的切点**永远不可能再被扫到**，留着纯占地方。
 */
export const DONE_TTL_MS = 90 * 60 * 1000;

/** 账本本体：切点 key → 记入时刻（ms） */
export type DoneLedger = Map<string, number>;

export function makeDoneLedger(): DoneLedger {
  return new Map<string, number>();
}

/**
 * 记账：这个切点处理过了。
 * 返回 false 表示**之前就处理过**（调用方应跳过，别重复整理）。
 */
export function markDone(ledger: DoneLedger, key: string, now: number): boolean {
  if (ledger.has(key)) return false;
  ledger.set(key, now);
  return true;
}

/**
 * sweep 的结果。**分成两个计数是有意的**：
 * `expired` 是**常态**（每分钟都会有切点过了 90 分钟），拿来打日志会刷屏；
 * `capped` 是**异常**（热切点数量顶到上限了），它一出现就说明容量假设被打破，
 * 必须留痕。原状把两者混成一个返回值，于是每分钟都在打日志 —— 那就是噪音。
 */
export type SweepResult = { expired: number; capped: number };

/**
 * 逐条淘汰。**绝不整体清空**（那是 #4/#6 共同的自我失效模式）。
 *
 * @param now  当前时刻（ms）
 */
export function sweepDoneLedger(ledger: DoneLedger, now: number): SweepResult {
  let expired = 0;

  // ① 先淘汰过期的 —— 这些切点对应的会话早就过了 60 分钟窗口，永远扫不到
  for (const [key, at] of ledger) {
    if (now - at > DONE_TTL_MS) {
      ledger.delete(key);
      expired += 1;
    }
  }

  // ② 仍超上限 → 按最旧逐条淘汰少量（兜底；正常路径走不到这里）
  let capped = 0;
  if (ledger.size > DONE_MAX) {
    const oldest = [...ledger.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, ledger.size - DONE_MAX);
    for (const [key] of oldest) {
      ledger.delete(key);
      capped += 1;
    }
  }

  return { expired, capped };
}
