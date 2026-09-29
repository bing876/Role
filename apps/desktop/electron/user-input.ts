/**
 * P1 · WebContentsView guest 的原生键鼠事件时间戳。只记 wcId/事件类型/单调时间，不采集键值、坐标或表单内容。
 *
 * Electron 的 before-input-event / before-mouse-event 不提供可信的“物理用户 vs CDP”来源位。
 * 主进程在发 CDP Input 命令前为本页登记**一次性、最多 150ms** 的同类回声标记；
 * 收到对应原生事件先消耗标记而不是把 AI 自己的回声当成真人，让 AI 自阻断。
 * 标记不保存键值/坐标；同类真人若恰好抢在回声前会被误吞，延迟 >150ms 的
 * CDP 回声也可能漏抑制。此算法不宣称已可靠区分来源，边界见 ADR-0011。
 */
import type { WebContents } from 'electron';

export const USER_INPUT_QUIET_MS = 3_000;
/** 最多容忍 CDP 命令的原生回声在派发后延迟这么久；不延长真人的 3 秒窗口。 */
export const CDP_ECHO_MS = 150;

type EchoKind = 'mouseMove' | 'mouseDown' | 'mouseUp' | 'mouseWheel' |
  'rawKeyDown' | 'keyDown' | 'char' | 'keyUp';
type EchoMark = { at: number; kinds: readonly EchoKind[] };
const pendingCdpEchoes = new Map<number, EchoMark[]>();

function activeEchoes(wcId: number, now: number): EchoMark[] {
  const marks = (pendingCdpEchoes.get(wcId) ?? []).filter((mark) => now - mark.at < CDP_ECHO_MS);
  if (marks.length) pendingCdpEchoes.set(wcId, marks);
  else pendingCdpEchoes.delete(wcId);
  return marks;
}

/** 只由 driver 的 CDP 统一出口在 raw sendCommand *前*调用；不是“AI 动作在途”全局禁闸。 */
export function noteAutomatedCdpInput(wcId: number, method: string, params: unknown): void {
  if (!params || typeof params !== 'object') return;
  const type = (params as { type?: unknown }).type;
  let kinds: readonly EchoKind[] | undefined;
  if (method === 'Input.dispatchMouseEvent') {
    switch (type) {
      case 'mouseMoved': kinds = ['mouseMove']; break;
      case 'mousePressed': kinds = ['mouseDown']; break;
      case 'mouseReleased': kinds = ['mouseUp']; break;
      case 'mouseWheel': kinds = ['mouseWheel']; break;
    }
  } else if (method === 'Input.insertText') {
    kinds = ['char'];
  } else if (method === 'Input.dispatchKeyEvent') {
    // 部分平台把同一按键报为 rawKeyDown，标记仍只消耗一条原生回声。
    if (type === 'keyDown' || type === 'rawKeyDown') kinds = ['keyDown', 'rawKeyDown'];
    else if (type === 'char' || type === 'keyUp') kinds = [type];
  }
  if (!kinds) return;
  const at = performance.now();
  const marks = activeEchoes(wcId, at);
  marks.push({ at, kinds }); // 一条 CDP 命令最多认领一条同类回声，其他真人事件照记。
  pendingCdpEchoes.set(wcId, marks);
}

function consumeAutomatedEcho(wcId: number, kind: EchoKind): boolean {
  const marks = activeEchoes(wcId, performance.now());
  const index = marks.findIndex((mark) => mark.kinds.includes(kind));
  if (index < 0) return false;
  marks.splice(index, 1);
  if (!marks.length) pendingCdpEchoes.delete(wcId);
  return true;
}

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
  pendingCdpEchoes.delete(wcId); // 页销毁/重用后不能继承上一页的 CDP 回声标记
  listener?.(wcId, 'forgotten');
}

/** 主进程唯一 guest 创建口调用；抽出接线以便测试直接发原生回调，不复刻判断。 */
export function wireGuestInput(contents: WebContents): void {
  // Electron 不给可信来源位。只能消耗「这张页刚派发的同类 CDP 命令」的一条短期回声；
  // 真人同类事件若抢先到达仍可能被误吞，绝不声称 150ms 内人不可能操作。
  contents.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type === 'mouseMove' || mouse.type === 'mouseDown' || mouse.type === 'mouseUp' || mouse.type === 'mouseWheel') {
      if (!consumeAutomatedEcho(contents.id, mouse.type)) recordUserInput(contents.id);
    }
  });
  contents.on('before-input-event', (_event, input) => {
    // 输入法可能只送 char，物理按键也可能送 rawKeyDown；不能只记 keyDown。
    if (input.type === 'rawKeyDown' || input.type === 'keyDown' || input.type === 'char' || input.type === 'keyUp') {
      if (!consumeAutomatedEcho(contents.id, input.type)) recordUserInput(contents.id);
    }
  });
  contents.once('destroyed', () => { forgetUserInput(contents.id); });
}
