/**
 * P1 · WebContentsView guest 的原生键鼠事件时间戳。只记 wcId/单调时间，不采集键值、坐标或表单内容。
 *
 * Electron 的 before-input-event / before-mouse-event 不提供可信的“物理用户 vs CDP”来源位。
 * 这一片先原样记录 guest 的事件；**不能**把“AI 同类输入在途”当成忽略所有同类
 * 事件的依据，否则用户同一瞬间在同一输入框打字会被静默漏掉。来源边界须在 P1
 * 同页同类验收中单独检验；此处不把模拟事件冒称真机来源证明。
 */
export const USER_INPUT_QUIET_MS = 3_000;

/** 注入时钟只用于精确测 2999/3000ms；生产始终用主进程单调钟。 */
export function createUserInputTracker(now: () => number = () => performance.now()) {
  const lastInputAt = new Map<number, number>();
  return {
    record(wcId: number): void { lastInputAt.set(wcId, now()); },
    remaining(wcId: number): number {
      const at = lastInputAt.get(wcId);
      return at === undefined ? 0 : Math.max(0, USER_INPUT_QUIET_MS - (now() - at));
    },
    forget(wcId: number): void { lastInputAt.delete(wcId); },
  };
}

const guestInput = createUserInputTracker();
export const recordUserInput = (wcId: number): void => guestInput.record(wcId);
export const userInputRemainingMs = (wcId: number): number => guestInput.remaining(wcId);
export const forgetUserInput = (wcId: number): void => guestInput.forget(wcId);
