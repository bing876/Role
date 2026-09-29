/**
 * P1 · WebContentsView guest 的原生键鼠事件时间戳。只记 wcId/单调时间，不采集键值、坐标或表单内容。
 *
 * Electron 的 before-input-event / before-mouse-event 不提供可信的“物理用户 vs CDP”来源位。
 * **保守选择不漏真人接管**：同一页/同一类/同一键在 CDP 未回包时照记时间戳，
 * 因此 CDP 回声若也进入这些事件，会触发最多 3 秒的多余让路/提示。
 * 这是可用性代价，不把“AI 同类输入在途”当忽略真人的理由；同类模拟事件
 * 已有验收，Win/mac 物理键盘/CDP 交错仍需真机验证。见 ADR-0011。
 */
import type { WebContents } from 'electron';

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
const expiryTimers = new Map<number, ReturnType<typeof setTimeout>>();
type InputChange = 'first' | 'renewed' | 'expired' | 'forgotten';
let listener: ((wcId: number, change: InputChange) => void) | null = null;
/** driver.ts 的状态镜像只有这一位订阅者；输入内容始终不进入广播。 */
export function setUserInputListener(fn: ((wcId: number, change: InputChange) => void) | null): void {
  listener = fn;
}
export const userInputRemainingMs = (wcId: number): number => guestInput.remaining(wcId);

export function recordUserInput(wcId: number): void {
  const wasActive = guestInput.remaining(wcId) > 0;
  guestInput.record(wcId);
  const old = expiryTimers.get(wcId);
  if (old) clearTimeout(old);
  expiryTimers.set(wcId, setTimeout(() => {
    expiryTimers.delete(wcId);
    if (guestInput.remaining(wcId) === 0) {
      guestInput.forget(wcId);
      listener?.(wcId, 'expired'); // 3 秒后把状态行还给先前的 running 详情
    }
  }, USER_INPUT_QUIET_MS + 1));
  listener?.(wcId, wasActive ? 'renewed' : 'first');
}

export function forgetUserInput(wcId: number): void {
  const old = expiryTimers.get(wcId);
  if (old) clearTimeout(old);
  expiryTimers.delete(wcId);
  guestInput.forget(wcId);
  listener?.(wcId, 'forgotten');
}

/** 主进程唯一 guest 创建口调用；抽出接线以便测试直接发原生回调，不复刻判断。 */
export function wireGuestInput(contents: WebContents): void {
  // Electron 的原生事件不含可信来源位。为保证同页同类的真人键不会被漏掉，
  // 这里不以“AI 的 CDP 正在输入同类键”为理由吞事件；代价是 CDP 回声可能也会
  // 触发保守让路。须在 Win/mac 真机确认 before-input-event 的具体触发路径。
  contents.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type === 'mouseMove' || mouse.type === 'mouseDown' || mouse.type === 'mouseUp' || mouse.type === 'mouseWheel') {
      recordUserInput(contents.id);
    }
  });
  contents.on('before-input-event', (_event, input) => {
    // 输入法可能只送 char，物理按键也可能送 rawKeyDown；不能只记 keyDown。
    if (input.type === 'rawKeyDown' || input.type === 'keyDown' || input.type === 'char' || input.type === 'keyUp') {
      recordUserInput(contents.id);
    }
  });
  contents.once('destroyed', () => { forgetUserInput(contents.id); });
}
