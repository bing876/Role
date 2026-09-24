import { useCallback, useEffect, useState } from 'react';
import type { BrowserWorkspace, EmbedRect } from '../browser';

/**
 * 阶段 1① · 逻辑抽离第 3 片：**跨 chat × browser 的胶水**。
 *
 * 为什么单独一层（用户拍板）：这几样东西**同时**属于聊天与浏览器两侧 ——
 *   · 求助卡「AI 主动求助」既要在聊天流里长出卡片，又要把浏览器切到 embed 视图；
 *   · 「这一轮的上下文没了」确认卡来自浏览器侧的事件，却要画在聊天区上方；
 *   · 求助卡里那块窗口的几何（`embedRect`）由聊天侧的 HelpCard 每帧量、交给浏览器侧的 BrowserPanel 写进那个
 *     **一直挂着的** webview 的内联样式。
 * 放进任何一侧的 feature 都会形成 feature → feature 的横切依赖。
 *
 * ★ 分层规则（用户拍板）：这类胶水归 `app/`；`features/**` 只许依赖 `shared/**`，
 *   不许反向依赖 `app/**`；feature 之间只经各自 `index.ts` 互访。
 *
 * ★ 本片**只搬逻辑，不动一行 JSX / 一行 CSS**：所以对外给的是 hook（同名解构回 App），
 *   而不是包一层 Provider —— Provider 要在 JSX 里加一层包裹，那属于"动 JSX"。
 *   等阶段 2 允许动 JSX 时，这个 hook 可以原样翻成 `BrowserGlueProvider`（对外契约不变）。
 */

/**
 * 求助卡要显示的内容（`key = agentId`）。
 *
 * ★ 刻意**只有文案与 id，没有任何输入字段** —— 卡片不承载输入能力，
 *   用户必须在上面那块**真实页面**里自己操作（安全红线，见 `browser/HelpCard.tsx` 顶部注释）。
 */
export type HelpCardView = {
  /** 触发求助的那张内嵌页（guest webContents id）—— 恢复时要点名它 */
  wcId: number;
  agentId: number;
  helpKind: 'captcha' | 'login';
  question: string;
  hint: string;
};

/** 只有 id / 问题文案的确认卡（一次只可能有一张，按 `wcId` 记） */
export type LoopGoneCard = { wcId: number; question: string };

export interface BrowserGlueApi {
  /** 当前这张「这一轮的上下文没了」确认卡（没有则 null） */
  loopGone: LoopGoneCard | null;
  /** 点两颗按钮中的任意一颗：把决定送回主进程，然后收卡 */
  answerLoopGone: (choice: 'restart' | 'giveup') => void;
  /** 每个智能体当前有没有一张待处理的求助卡（key = agentId） */
  helpCards: Record<number, HelpCardView>;
  /** 当前这个对话有没有求助卡（聊天区只画当前智能体的那张） */
  curHelp: HelpCardView | null;
  /** 求助卡里那块"窗口"的几何（相对浏览器舞台左上角） */
  embedRect: EmbedRect | null;
  onEmbedRect: (r: EmbedRect | null) => void;
  /** 求助卡的两个按钮：走主进程既有通道（resumeTask / agentDrop） */
  helpCardAct: (kind: 'done' | 'stop', wcId: number) => Promise<void>;
  // ---- 给「主进程事件分发」用的写入口（App 的那条 effect 里调，名字保持好懂）----
  /** 挂一张求助卡到**触发它的那个智能体**名下 */
  showHelp: (card: HelpCardView) => void;
  /** 收掉某个智能体的求助卡（没有则原样返回，保证引用稳定） */
  clearHelp: (agentId: number | null | undefined) => void;
  /** 清掉那块窗口几何（收卡片时一起清） */
  clearEmbed: () => void;
  /** 主进程说「这一轮的上下文没了」→ 弹确认卡（`wcId` 不是数字就收卡） */
  askLoopGone: (wcId: unknown, question: string) => void;
}

export interface UseBrowserGlueOptions {
  /**
   * 浏览器工作区。这里只用三个方法，且它们都是稳定引用：
   * `enterEmbed` / `exitEmbed` / `refreshDriving`。
   */
  browser: Pick<BrowserWorkspace, 'enterEmbed' | 'exitEmbed' | 'refreshDriving'>;
  /** 当前智能体：卡片按对话分桶，聊天区只画当前这张 */
  curAgentId: number | null;
  /** 提示文案仍写在聊天流里（`setChatNote`）；胶水层不认识 chat 的 state */
  onNote: (text: string) => void;
}

export function useBrowserGlue({ browser, curAgentId, onNote }: UseBrowserGlueOptions): BrowserGlueApi {
  // ---- ★ P0 止血（2026-09-21）·「这一轮的上下文没了」确认卡 ------------------
  /**
   * 主进程在 `/agent/loop/resume` 拿到 `code:'loop_gone'` 时**不会**自动重开，
   * 只把一句问话送过来；下面那张卡就是用户拍板的唯一入口。
   *
   * ★ 一次只可能有一张（按 wcId 记），点完就清空 —— 绝不留一张点不动的卡。
   */
  const [loopGone, setLoopGone] = useState<LoopGoneCard | null>(null);
  const answerLoopGone = (choice: 'restart' | 'giveup'): void => {
    const cur = loopGone;
    setLoopGone(null);
    if (!cur) return;
    void window.workbench?.loopGoneChoice(cur.wcId, choice).then(() => {
      void browser.refreshDriving();
    });
  };

  // ---- 第 27 步 · 人工介入求助卡片 ------------------------------------------
  /**
   * 每个智能体当前有没有一张待处理的求助卡（key = agentId）。
   *
   * 为什么按**智能体**分桶（不是按页、也不是全局一张）：
   *   聊天区本来就只显示当前智能体的内容，卡片必须落在"触发它的那个对话"里 ——
   *   这正是本步的要求（**不做跨对话提醒**，只在当前对话显示）。
   */
  const [helpCards, setHelpCards] = useState<Record<number, HelpCardView>>({});
  /**
   * 求助卡里那块"窗口"的几何（相对浏览器舞台左上角）。
   *
   * ★ 它**不是**状态机的一部分，也不进任何持久化：纯粹是"这一帧卡片在哪"的临时量。
   *   由 HelpCard 每帧量一次、变了才上报，交给 BrowserPanel 写进那个**一直挂着的**
   *   webview 的内联样式 —— 元素本身从头到尾没动过位置（影子层方案）。
   */
  const [embedRect, setEmbedRect] = useState<EmbedRect | null>(null);
  const onEmbedRect = useCallback((r: EmbedRect | null) => setEmbedRect(r), []);
  /** 当前这个对话有没有求助卡（聊天区只画当前智能体的那张） */
  const curHelp = curAgentId !== null ? helpCards[curAgentId] ?? null : null;

  /**
   * 第 27 步：**切智能体时跟着切换求助卡视图**。
   *
   * 为什么必须显式管：卡片是按智能体分桶的，而 `browser.view` 是全局的。
   * 不做这一步会出现两种错位：
   *   · 切到另一个对话 → 浏览器层还停在 embed 态，那一层是透明的，
   *     用户会看到"聊天正常，但屏幕上多出一块别人的网页"；
   *   · 切回有求助卡的那个对话 → 卡片回来了，但页没跟着回来（白框）。
   */
  useEffect(() => {
    const h = curAgentId !== null ? helpCards[curAgentId] : null;
    if (h) {
      browser.enterEmbed(h.wcId);
      return;
    }
    /*
     * ★★ 这里**不要**写 `else if (browser.view === 'embed')`（2026-09-21 真机踩出来的问题）。
     *
     * `browser.view` 是**这一次渲染的闭包快照**，而这个 effect 的依赖只有
     * `[curAgentId, helpCards]` —— 不包含 `view`。于是有一条时序破口：
     *   ① 求助卡刚弹出 → `setView('embed')`；
     *   ② 用户紧接着切到别的对话 → `curAgentId` 变 → 本 effect 重跑；
     *   ③ 若此刻 React 还没把「view='embed'」那次渲染提交完，
     *      闭包里的 `browser.view` 仍是 `'fullscreen'` ⇒ 那道 `if` 为假
     *      ⇒ **exitEmbed() 根本没被调用** ⇒ 浏览器层停在 embed，
     *      聊天旁边露出一块**别人的网页**（真机上实测到的现象：
     *      `切到别的对话` 后 20 秒仍停在 `browserLayer--embed`）。
     *
     * 正解：**恒调 `exitEmbed()`** —— 它内部用的是函数式更新
     * （`setView(v => v === 'embed' ? … : v)`），永远读到最新值；
     * 不在 embed 态时它本来就是个安全的 no-op（顺手把 `embedWcId` 清成 null 也对）。
     * 换句话说：**判断该由"知道最新值的那一层"做，而不是由拿着快照的调用方做。**
     */
    browser.exitEmbed();
    // browser 的方法是稳定引用（只读 ref + setState），无需进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curAgentId, helpCards]);

  /**
   * 第 27 步：求助卡的两个按钮。
   *
   * ★ 两个动作**都走主进程既有的通道**，不新开机制：
   *   · 「我处理好了，继续」= `resumeTask`（就是「继续」按钮那条路：
   *     读当前真实页面 → 服务端算 delta → 同一条历史原地接上）；
   *   · 「不用了，停手」= `agentDrop`（就是「停」那条路）。
   */
  const helpCardAct = async (kind: 'done' | 'stop', wcId: number) => {
    try {
      if (kind === 'done') {
        await window.workbench?.resumeTask?.(wcId);
      } else {
        await window.workbench?.agentDrop?.(wcId);
      }
    } catch (e) {
      onNote(`没成功：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // 本地先收卡片，别等主进程的事件回来（事件会再收一次，幂等）
      if (curAgentId !== null) {
        setHelpCards((prev) => {
          const next = { ...prev };
          delete next[curAgentId];
          return next;
        });
      }
      setEmbedRect(null);
      browser.exitEmbed();
    }
  };

  // ---- 主进程事件那侧的写入口（App 的分发 effect 调这三个）--------------------
  const showHelp = useCallback((card: HelpCardView) => {
    setHelpCards((prev) => ({ ...prev, [card.agentId]: card }));
  }, []);

  const clearHelp = useCallback((agentId: number | null | undefined) => {
    if (agentId === null || agentId === undefined) return;
    setHelpCards((prev) => {
      if (!(agentId in prev)) return prev; // ★ 没有就别造新对象（引用稳定，少一次无谓渲染）
      const next = { ...prev };
      delete next[agentId];
      return next;
    });
  }, []);

  const clearEmbed = useCallback(() => setEmbedRect(null), []);

  const askLoopGone = useCallback((wcId: unknown, question: string) => {
    setLoopGone(typeof wcId === 'number' ? { wcId, question } : null);
  }, []);

  return {
    loopGone,
    answerLoopGone,
    helpCards,
    curHelp,
    embedRect,
    onEmbedRect,
    helpCardAct,
    showHelp,
    clearHelp,
    clearEmbed,
    askLoopGone,
  };
}
