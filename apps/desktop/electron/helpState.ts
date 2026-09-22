/**
 * 第 27 步 · **人工介入（求助卡片）的状态机** —— 跑在 Electron 主进程，但**刻意不 import electron**：
 * 全部依赖注入（和 `agent.ts` 同一套路），所以这段接线可以直接单测。
 *
 * 为什么要单独一个文件（而不是塞在 main.ts 里）：
 *   1. main.ts 已经 1700+ 行，求助这块是一组有明确边界的"记账 + 定时器 + 回调"；
 *   2. 更重要的是 —— 它原本只能靠**读代码**确认对不对。而这里最容易错的地方恰恰是
 *      "时序"：卡片刚弹就被自己收掉、自动与手动同时触发恢复两次、观察窗没被停掉。
 *      抽出来之后这些都能用假依赖跑一遍（见 scripts/verify/help-card/help-state-verify.mjs）。
 *
 * ★ 安全红线（这个文件是"展示层"的一部分，不是输入层）：
 *   这里**只产生文案与事件**，不聚焦输入框、不带字段值、不代填、不代提交。
 *   卡片只负责"展示 + 提示 + 手动确认"，用户必须在**真实页面**上自己操作。
 */
import type { AgentEventPayload } from '@ai-workbench/shared';

/** 一次求助的内容（由 agent.ts 的保守触发闸判定后传进来） */
export interface HelpInfo {
  helpKind: 'captcha' | 'login';
  question: string;
  hint: string;
  /**
   * 求助那一刻页面上**有没有**敏感输入框。
   * 它决定自动恢复观察要不要只认「敏感框消失」这条信号 —— 滑块验证页上压根没有敏感框，
   * 若照老逻辑（"没框了 = 完成了"），卡片刚弹出来 1.2 秒就会被自己收掉。
   */
  hadSensitiveField: boolean;
}

/** 一张待处理求助卡的记录 */
export interface HelpRecord {
  wcId: number;
  agentId: number | null;
  helpKind: 'captcha' | 'login';
  question: string;
  hint: string;
  /** 用户处理完之后要接回的那个目标（循环已收尾，目标只在 pendingGoals / lane 里） */
  goal: string;
  at: number;
}

/** 求助模块依赖的外部能力（全部由 main.ts 注入，测试里喂假的） */
export interface HelpDeps {
  /** 往聊天区发事件（`help` / `help-clear` / `note`） */
  emit(payload: AgentEventPayload, wcId: number): void;
  /** 把这一路的状态记成「AI 发起的暂停」（界面靠它和"用户接管"区分） */
  markAgentPaused(wcId: number, detail: string): void;
  /**
   * 挂自动恢复观察；返回停止函数。
   * `requireSensitiveField` 的语义见 `HelpInfo.hadSensitiveField`。
   */
  startWatch(wcId: number, onDone: () => void, opts: { requireSensitiveField: boolean }): () => void;
  /** 走既有的「继续」链路把这一路接回来（读页 → 解挂 → 原地接上） */
  requestResume(wcId: number): void;
  /** 取这一路的目标（lane / pendingGoals 里那份） */
  goalOf(wcId: number): string;
  agentOf(wcId: number): number | null;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(t: ReturnType<typeof setTimeout>): void;
  log(msg: string): void;
}

/** 自动信号一直不来时，过这么久就在聊天里提示一句"还有手动按钮" */
export const HELP_MANUAL_HINT_MS = 120_000;

export interface HelpHub {
  /** AI 主动求助：记账 + 发事件 + 记成 AI 发起 + 挂自动恢复观察 + 挂手动兜底提示 */
  raise(wcId: number, info: HelpInfo): void;
  /** 收掉某张页的求助卡（默认会通知渲染层）；返回原本有没有 */
  clear(wcId: number, reason: string, notifyRenderer?: boolean): boolean;
  /** 全部收掉（登出 / 全局停手 / 复位） */
  clearAll(reason: string): void;
  /** 这张页现在有没有待处理的求助卡 */
  has(wcId: number): boolean;
  get(wcId: number): HelpRecord | null;
  /** 诊断/测试用：当前在册的求助卡数 */
  size(): number;
}

/**
 * 建一个求助中心。
 *
 * 所有状态都**按 wcId 独立存在**（不是挂在 Lane 上）—— 因为求助是在循环**收尾那一下**
 * 发出来的，紧接着 `finishLane` 就会 `notifyResume(lane)` 把 lane 的观察窗停掉、
 * 并从表里摘掉这一路。卡片要在循环结束之后继续留着，所以生命周期必须独立。
 */
export function createHelpHub(deps: HelpDeps): HelpHub {
  const byWc = new Map<number, HelpRecord>();
  const watches = new Map<number, () => void>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  const clear = (wcId: number, reason: string, notifyRenderer = true): boolean => {
    const had = byWc.delete(wcId);
    const stop = watches.get(wcId);
    if (stop) {
      stop();
      watches.delete(wcId);
    }
    const timer = timers.get(wcId);
    if (timer) {
      deps.clearTimeout(timer);
      timers.delete(wcId);
    }
    if (had && notifyRenderer) deps.emit({ kind: 'help-clear', reason }, wcId);
    return had;
  };

  const raise = (wcId: number, info: HelpInfo): void => {
    // 同一张页重复求助：先收掉旧的（**不通知渲染层**，马上会用新的那张盖上去）
    clear(wcId, 'superseded', false);
    byWc.set(wcId, {
      wcId,
      agentId: deps.agentOf(wcId),
      helpKind: info.helpKind,
      question: info.question,
      hint: info.hint,
      goal: deps.goalOf(wcId),
      at: Date.now(),
    });
    deps.markAgentPaused(wcId, `AI 在等你处理（${info.helpKind === 'captcha' ? '验证码 / 滑块' : '登录'}）`);
    deps.emit({ kind: 'help', helpKind: info.helpKind, question: info.question, hint: info.hint }, wcId);
    deps.log(`第 ${wcId} 路发出人工介入求助（${info.helpKind}）`);

    // 自动感知（双保险的**主**信号）：页面一变就当作"用户处理完了"
    const stop = deps.startWatch(
      wcId,
      () => {
        deps.log(`第 ${wcId} 路求助自动感知到页面变化 → 接着做`);
        /**
         * ★ 先收卡、**只有真的收掉了才请求恢复**。
         *
         * 为什么要看返回值：`clear` 是幂等的，但"自动感知"与"用户手动点按钮"
         * 完全可能几乎同时到（用户刚点完、页面刚好也变了）。只看"回调被调了"就恢复，
         * 就会出现**同一张页被恢复两次** —— 两路 `runToolLoop` 抢同一条服务端循环，
         * 服务端抛 LoopBusyError，用户看到的是"任务突然失败"（这个坑第 22 步踩过）。
         */
        if (clear(wcId, 'page_changed')) deps.requestResume(wcId);
      },
      { requireSensitiveField: !info.hadSensitiveField },
    );
    watches.set(wcId, stop);

    // 手动兜底提示：自动信号没来时告诉用户"还有按钮"
    const timer = deps.setTimeout(() => {
      if (!byWc.has(wcId)) return;
      deps.emit(
        { kind: 'note', level: 'info', text: '还没检测到页面变化。若你已经处理好了，点卡片上的「我处理好了，继续」即可恢复。' },
        wcId,
      );
    }, HELP_MANUAL_HINT_MS);
    timers.set(wcId, timer);
  };

  const clearAll = (reason: string): void => {
    for (const wcId of [...byWc.keys()]) clear(wcId, reason);
  };

  return {
    raise,
    clear,
    clearAll,
    has: (wcId) => byWc.has(wcId),
    get: (wcId) => {
      const r = byWc.get(wcId);
      return r ? { ...r } : null;
    },
    size: () => byWc.size,
  };
}
