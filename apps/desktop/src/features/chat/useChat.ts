import { useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AgentView, ChatHistoryResult, ChatMentionMeta, ChatSource, ChatSpeaker } from '@ai-workbench/shared';
import { API_BASE, authFetchJson } from '../../shared/api';

/**
 * 阶段 1① · 逻辑抽离第 7a 片：**聊天这一侧的 state 与历史**。
 * 阶段 1① · 逻辑抽离第 7b 片：**发送这一侧的动作**（`sendChat` 485 行 + `startAgentTask`）也搬进来了。
 *
 * 搬进来的：
 *   · 一个智能体一份聊天的 `chats`（+ 它的最新值镜像 `chatsRef`）、
 *     「哪个智能体在流式输出 / 流到哪了」、聊天区那一行提示 `chatNote`、
 *     步骤小字 `agentSteps`、结果文档信息 `agentDoc`、以及「这个智能体拉过历史没」的账本；
 *   · 「这一轮是哪条循环在跑」（`runningLoopId` / `runningLoopWcId` + 它们的最新值镜像）、
 *     联网搜索那行过程提示 `searchHint`；
 *   · `sendChat`（走 `/chat/stream` 读 SSE）、`onSend`、`startAgentTask`（把目标交给主进程 AI 循环）。
 *
 * ★ 这是**唯一**一片「跨 feature」的搬迁：`sendChat` 天然要同时指挥聊天 / 浏览器 / 任务。
 *   处理办法不是让它去 import 那些 feature（那会立刻产生双向依赖），
 *   而是把它们的**最新值镜像与纯函数**从 App（组合层）**注入**进来 —— 见 `UseChatOptions`。
 *
 * ★ `curAgentId` / `curAgentRef` 是**注入**的（"当前是哪个智能体"是左栏的选择，
 *   不属于聊天这一侧，浏览器与记忆也要读它）。
 *
 * ★ `sendChat` 正文是**逐字搬**的：注入的名字与原 App.tsx 里的名字完全一致
 *   （`session` / `input` / `awaitResume` / `agentAwaitInfo` / `detectOpenUrl` …），
 *   所以那 485 行只有 3 处白名单改动（见记录文档的"搬运动手清单"）。
 *
 * ★ 本片**只搬逻辑，不动一行 JSX / 一行 CSS**（同名解构回 App）。
 */

export type Role = 'user' | 'assistant';

export type Message = {
  id: number;
  role: Role;
  text: string;
  /**
   * 第 26 步：这条回复引用到的网页来源（本轮联网检索命中的）。
   * 只有走过搜索的助手回复才有；渲染成气泡下方的可点链接。
   */
  sources?: ChatSource[];
  /**
   * 批次 J：这句助手话是**哪个智能体**说的（@点名换人之后，同一条会话里会有不同人开口）。
   * undefined = 不知道（老数据 / 服务端没给）—— 界面就**不挂名字牌**，绝不拿当前智能体冒充。
   */
  speaker?: ChatSpeaker;
};

/** 第 15 步：一个智能体 = 一份聊天（自己的消息列表 + 自己的会话号） */
export type AgentChat = { messages: Message[]; convId: number | null };

/** 空列表用同一个常量：切智能体时引用稳定，不会每次渲染都造新数组 */
const EMPTY_MESSAGES: Message[] = [];

/**
 * 浏览器工作区的**只读端口**（`sendChat` / `startAgentTask` 真正用到的那 9 个成员）。
 *
 * 为什么不直接 `import type { BrowserWorkspace } from '../../browser'`：
 *   feature 只依赖 `shared/**`（阶段 1 定的方向），跨模块一律走注入 ——
 *   这里只声明"我要什么"，实现由 App（组合层）在调用点提供。
 *   形状写错/将来变形都会在**调用点**编译红（两边类型在那里相遇），所以不会悄悄漂移。
 *
 * ★ 它是**最新值镜像**（`{ current }`）而不是对象本身：`useBrowserWorkspace(...)`
 *   在 App 里的位置排在 `useChat(...)` **之后**（它自己还要用 `setChatNote`），
 *   两个 hook 互相需要 → 只能是"定义晚的那个用镜像注入"。用法见 `sendChat` 开头。
 */
export interface ChatBrowserPort {
  /** 当前可见的那张活页（没有就是 null） */
  active: { id: number; url: string } | null;
  /** 休眠深度：`undefined` = 清醒 */
  sleepOf: (tabId: number) => 'shallow' | 'deep' | undefined;
  /** 叫醒一张页（系统唤醒：不记宽限期） */
  wakeTab: (tabId: number) => void;
  /** 等 guest 真就绪（拿不到句柄就一直是 undefined） */
  awaitWebContentsId: (tabId: number) => Promise<number | undefined>;
  /** 开一张页（同站复用） */
  openUrl: (agentId: number, rawUrl: string) => Promise<number | null>;
  /** 把焦点给当前页 / 给地址栏 */
  focusActive: () => void;
  focusUrlBar: () => void;
  /** 「停」口令：当前这张页在跑就只停那一路，否则全停 */
  stopDriving: (tabId?: number) => void;
  /** 刷驾驶状态（横幅/圆点跟着主进程走） */
  refreshDriving: () => Promise<void>;
}

/**
 * 纯本地判定（"这一句是不是开页指令 / 是不是『停』 / 是不是『继续』"）。
 *
 * 它们现在住在 `browser/sites.ts` 与 `browser/intent.ts`（**单一实现**，不许抄第二份），
 * 由 App 在调用点注入 —— feature 不反向 import 那些模块，将来搬它们时只换这里的连线。
 */
export interface ChatIntentPort {
  detectStopIntent: (raw: string) => boolean;
  detectOpenUrl: (raw: string) => string | null;
  detectUnknownOpenTarget: (raw: string) => string | null;
  isPureOpenCommand: (raw: string) => boolean;
  CONTINUE_STRONG_RE: RegExp;
  CONTINUE_WEAK_RE: RegExp;
  CONFIRM_ASK_RE: RegExp;
  /** 起始页（认不出站点时开的那张） */
  HOME_URL: string;
}

/**
 * 「等用户说继续」的一组状态（步数上限自动停）。
 * 写它的地方是 App 里那条**主进程事件分发** effect（`kind === 'ask' && reason === 'step_budget'`），
 * 所以这组 state 留在 App，注入进来读/清。
 */
export interface ChatResumePort {
  awaitResume: boolean;
  awaitResumeAgent: number | null;
  awaitResumeWc: number | null;
  setAwaitResume: Dispatch<SetStateAction<boolean>>;
  setAwaitResumeAgent: Dispatch<SetStateAction<number | null>>;
  setAwaitResumeWc: Dispatch<SetStateAction<number | null>>;
}

/** 「驾驶员在聊天里问资料，等用户答」的那组状态（同上，写它的也在 App 的事件分发里） */
export interface ChatAskInfoPort {
  agentAwaitInfo: boolean;
  agentAwaitAgent: number | null;
  agentAwaitWcId: number | null;
  setAgentAwaitInfo: Dispatch<SetStateAction<boolean>>;
  setAgentAwaitAgent: Dispatch<SetStateAction<number | null>>;
  setAgentAwaitWcId: Dispatch<SetStateAction<number | null>>;
}

export interface UseChatOptions {
  /** 最新值镜像：会话（token 从这里面拿） */
  sessionRef: { current: { token: string } | null };
  /** 当前智能体 id（响应式，用于 `messages` 这类派生值） */
  curAgentId: number | null;
  /** 最新值镜像：当前智能体（异步回包里读它，闭包里的 state 是旧的） */
  curAgentRef: { current: number | null };
  /** 会话本身（响应式）：`sendChat` / `startAgentTask` 要 token；登录态一变它立刻是新值 */
  session: { token: string } | null;
  /** 输入框（组合层持有：左中栏共用的那个控件） */
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  /** 浏览器工作区（**最新值镜像**，见 `ChatBrowserPort` 的说明） */
  browserRef: { current: ChatBrowserPort | null };
  /** 任务侧：发车前把红点熄掉（`features/tasks`） */
  setHasUnread: (v: boolean | ((prev: boolean) => boolean)) => void;
  /** 最新值镜像：当前项目的智能体名单（给回复挂名字牌时要查"这句话是谁说的"） */
  agentsRef: { current: AgentView[] };
  /** 「这一轮用户原话本身就是开页确认」的账本（左栏/状态行也读它 → 留在 App） */
  lastUserWasOpenRef: { current: Record<number, boolean> };
  /** 「待确认任务的原始目标」取法（确认卡也读它 → 留在 App） */
  lastUserGoalBeforeConfirm: (agentId: number) => string;
  /**
   * 最新值镜像：拉某个智能体的服务端会话状态（一轮结束后回刷状态行用）。
   * 它的定义排在 `useChat(...)` 之后 → 只能镜像注入。
   */
  loadAgentStateRef: { current: (agentId: number) => Promise<void> };
  /** 「等继续」四件套 */
  resume: ChatResumePort;
  /** 「驾驶员问资料」四件套 */
  askInfo: ChatAskInfoPort;
  /** 批次 J 的兜底发车闸（纯函数，住在 `./mentionGate`，注入避免 feature 反向依赖 App） */
  shouldFallbackLaunch: (input: {
    pendingDrive: boolean;
    sawLoop: boolean;
    serverMentionKind?: string | null;
  }) => boolean;
  /** 纯本地判定（开页 / 停 / 继续 …），单一实现住在 `browser/` */
  intent: ChatIntentPort;
  /**
   * 产品交互规格 C1（2026-09-25）：对话式建智能体时，服务端在 meta 帧里带回 `newAgent`。
   * 组合层（App）收到它 → 左栏立刻出现真名字（并入 agents）+ 输入框上方摆三问 chips。
   * 可选：老调用方不传就不触发（行为不变）。
   */
  onNewAgent?: (a: AgentView) => void;
}

export interface ChatApi {
  /** 一个智能体一份聊天 */
  chats: Record<number, AgentChat>;
  setChats: Dispatch<SetStateAction<Record<number, AgentChat>>>;
  /** 异步回包里读最新 chats（闭包里拿 state 会拿到旧的） */
  chatsRef: { current: Record<number, AgentChat> };
  /** 已经拉过历史的智能体，来回切换不反复请求 */
  historyLoadedRef: { current: Set<number> };
  /** 当前智能体那一份（没有就是 undefined） */
  curChat: AgentChat | undefined;
  /** 当前要渲染的消息列表（没有就指向同一个空数组常量） */
  messages: Message[];
  /** 往「当前智能体」那份聊天里追加/替换消息（沿用第 6 步以来的调用点写法） */
  setMessages: (updater: Message[] | ((prev: Message[]) => Message[])) => void;
  /** 改某一份聊天（引用不变时原样返回，少一次无谓渲染） */
  patchChat: (agentId: number, patch: (c: AgentChat) => AgentChat) => void;
  /** 流式输出中 */
  streaming: boolean;
  setStreaming: Dispatch<SetStateAction<boolean>>;
  /** 正在流式输出的那个智能体（别的智能体的消息不该被这段文本染色） */
  streamingAgentId: number | null;
  setStreamingAgentId: Dispatch<SetStateAction<number | null>>;
  /** 这一轮流式文本 */
  streamText: string;
  setStreamText: Dispatch<SetStateAction<string>>;
  /** 聊天区那一行提示（**其它 feature 唯一往聊天里说话的通道**） */
  chatNote: string;
  setChatNote: Dispatch<SetStateAction<string>>;
  /** 主进程报上来的最后几步摘要（可见度条要用尾巴那一条） */
  agentSteps: string[];
  setAgentSteps: Dispatch<SetStateAction<string[]>>;
  /** 结果文档的标题与大纲 */
  agentDoc: { title: string; outline: string[] } | null;
  setAgentDoc: Dispatch<SetStateAction<{ title: string; outline: string[] } | null>>;
  /** 聊天里追加一条「小助之外」的系统泡（driver 循环的问话/结论/报错），只进内存展示 */
  pushChatLine: (text: string) => void;
  /**
   * 第 17 步：按智能体落桶的系统泡。
   * 两路驾驶可能分属两个智能体，事件里的 wcId 决定这条话进谁的聊天 ——
   * 绝不按「此刻正在看的那个智能体」乱写（那正是「聊天串了」）。
   */
  pushChatLineFor: (agentId: number, text: string) => void;
  /** 拉某个智能体的历史（切号期间晚到的响应丢掉） */
  loadAgentHistory: (agent: { id: number; conversationId: number | null }) => Promise<void>;
  /** 登出/换号：聊天这一侧一次清干净 */
  resetChat: () => void;
  /**
   * 第 26 步：联网搜索的**过程提示**（一行小字）。
   * 只在「发起这轮流式的那个智能体」里渲染，这一轮结束就收掉。
   */
  searchHint: string;
  /**
   * 服务端给的循环号（第 21 步：脑在服务端，桌面只当手）。
   * 非空 + 流式中 = 界面显示「AI 任务执行中」那张任务卡、输入框变成「发送补充」。
   */
  runningLoopId: string | null;
  /** 发送：走 `/chat/stream` 读 SSE（落桶 / 打字机 / 发车 / 收尾） */
  sendChat: () => Promise<void>;
  /** 输入框回车与「发送」按钮都走它 */
  onSend: () => void;
  /** 「继续 / 开始任务」那条路：把目标交给主进程的 AI 循环 */
  startAgentTask: (rawGoal?: string) => Promise<void>;
}

export function useChat(options: UseChatOptions): ChatApi {
  const {
    sessionRef,
    curAgentId,
    curAgentRef,
    session,
    input,
    setInput,
    browserRef,
    setHasUnread,
    agentsRef,
    lastUserWasOpenRef,
    lastUserGoalBeforeConfirm,
    loadAgentStateRef,
    resume,
    askInfo,
    shouldFallbackLaunch,
    intent,
  } = options;

  /**
   * ★ 「只换来源、不改名字」（片 7b 的关键手法）：
   *   下面这几组注入进来的名字，与它们在原 `App.tsx` 里的名字**一字不差**，
   *   所以 `sendChat` 那 485 行可以逐字搬过来、再逐字比对 ——
   *   正文里只有 3 处白名单改动（两个 `browser` 取值 + 一处 `loadAgentStateRef.current`）。
   */
  const {
    awaitResume,
    awaitResumeAgent,
    awaitResumeWc,
    setAwaitResume,
    setAwaitResumeAgent,
    setAwaitResumeWc,
  } = resume;
  const {
    agentAwaitInfo,
    agentAwaitAgent,
    agentAwaitWcId,
    setAgentAwaitInfo,
    setAgentAwaitAgent,
    setAgentAwaitWcId,
  } = askInfo;
  const {
    detectStopIntent,
    detectOpenUrl,
    detectUnknownOpenTarget,
    isPureOpenCommand,
    CONTINUE_STRONG_RE,
    CONTINUE_WEAK_RE,
    CONFIRM_ASK_RE,
    HOME_URL,
  } = intent;

  const [chats, setChats] = useState<Record<number, AgentChat>>({});
  /** 异步回包里读最新 chats（闭包里拿 state 会拿到旧的） */
  const chatsRef = useRef<Record<number, AgentChat>>({});
  chatsRef.current = chats;
  /** 已经拉过历史的智能体，来回切换不反复请求 */
  const historyLoadedRef = useRef<Set<number>>(new Set());

  const [streaming, setStreaming] = useState(false);
  const [streamingAgentId, setStreamingAgentId] = useState<number | null>(null);
  const [streamText, setStreamText] = useState('');
  const [chatNote, setChatNote] = useState('');
  const [agentSteps, setAgentSteps] = useState<string[]>([]);
  const [agentDoc, setAgentDoc] = useState<{ title: string; outline: string[] } | null>(null);
  /**
   * 第 26 步：联网搜索的**过程提示**（一行小字，如「正在搜索：今天有什么新闻」）。
   *
   * 为什么要有：搜索是**轻量、无界面**的能力 —— 不打开任何网页、不出现浏览器卡片，
   * 如果界面上一点动静都没有，用户会以为「AI 卡住了 / 在瞎编」。
   * 所以这里只补一行纯文字状态，让它**看得见但不打扰**（不做动画、不做美化）。
   *
   * 注意：它跟浏览器那条链路毫无关系 —— 这里只读服务端推来的 `search` 事件，
   * 不碰任何开页判定、不碰驾驶循环、不碰浏览器面板的渲染。
   */
  const [searchHint, setSearchHint] = useState('');
  /** 任务模式状态机追踪（idle / running / paused / waiting_user） */
  const [runningLoopId, setRunningLoopId] = useState<string | null>(null);
  const [runningLoopWcId, setRunningLoopWcId] = useState<number | null>(null);
  /** 最新值镜像：异步回包里读「这一轮是哪条循环」（闭包里的 state 是旧的） */
  const runningLoopIdRef = useRef<string | null>(null);
  const runningLoopWcIdRef = useRef<number | null>(null);
  runningLoopIdRef.current = runningLoopId;
  runningLoopWcIdRef.current = runningLoopWcId;

  const patchChat = (agentId: number, patch: (c: AgentChat) => AgentChat) => {
    setChats((prev) => {
      const cur = prev[agentId] ?? { messages: [], convId: null };
      const next = patch(cur);
      return next === cur ? prev : { ...prev, [agentId]: next };
    });
  };

  const curChat = curAgentId === null ? undefined : chats[curAgentId];
  const messages = curChat?.messages ?? EMPTY_MESSAGES;
  /** 往「当前智能体」那份聊天里追加/替换消息（沿用第 6 步以来的调用点写法） */
  const setMessages = (updater: Message[] | ((prev: Message[]) => Message[])) => {
    const id = curAgentRef.current;
    if (id === null) return;
    patchChat(id, (c) => ({ ...c, messages: typeof updater === 'function' ? updater(c.messages) : updater }));
  };

  /** 聊天里追加一条「小助之外」的系统泡（driver 循环的问话/结论/报错），只进内存展示 */
  const pushChatLine = (text: string) => {
    setMessages((prev) => prev.concat({ id: Date.now() + Math.floor(Math.random() * 1000), role: 'assistant', text }));
  };

  const pushChatLineFor = (agentId: number, text: string) => {
    patchChat(agentId, (c) => ({
      ...c,
      messages: c.messages.concat({ id: Date.now() + Math.floor(Math.random() * 1000), role: 'assistant', text }),
    }));
  };

  const loadAgentHistory = async (agent: { id: number; conversationId: number | null }) => {
    const sess = sessionRef.current;
    if (!sess) return;
    const q = agent.conversationId !== null ? `?conversationId=${agent.conversationId}` : `?agentId=${agent.id}`;
    try {
      const h = await authFetchJson<ChatHistoryResult>(`/chat/history${q}`, {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (sessionRef.current?.token !== sess.token) return; // 切号期间晚到的响应丢掉
      historyLoadedRef.current.add(agent.id);
      patchChat(agent.id, () => ({
        // 批次 J：历史里的发言人一并带过来（服务端 speaker_agent_id → {id,name}）；
        // 老行没有这一列 → undefined → 气泡不挂名字牌（不猜、不拿当前智能体冒充）
        messages: h.messages.map((m) => ({ id: m.id, role: m.role, text: m.text, sources: m.sources, speaker: m.speaker })),
        convId: h.conversationId,
      }));
    } catch (e) {
      setChatNote(`拉取历史失败：${(e as Error).message}`);
    }
  };

  /**
   * 登出/换号：聊天这一侧一次清干净（原来在 `onLogout` 里散着写）。
   *
   * ★ F5 修复（2026-09-25，用户拍板「现在修」）：**这一轮的残留也要清**——
   *   `searchHint` / `runningLoopId` / `runningLoopWcId` / `streaming` / `streamingAgentId`。
   *
   *   原来这五个是**有意**不清的（抽 hook 时逐字保留了既有行为，记成了 F5）。
   *   真踩到的场景：**流式进行中登出/换号**（长任务时 `/chat/stream` 会开着好几分钟，
   *   服务端那一路还在跑），这五个值会留到下一次登录，界面上露出三处：
   *     · 「🚀 AI 任务执行中」卡片回来（判据 `runningLoopId && streaming`）—— 上一轮的活早没了；
   *     · 输入框变成「打字中…」**且被禁用**（判据 `streaming`）—— 用户想说话说不出来；
   *     · 联网搜索那行「正在搜索：…」（判据 `streaming && streamingAgentId === curAgentId`）。
   *   ★ 说清一处**比原报告多出来的**：F5 原报告只写了那三个值，实现时发现
   *     `streaming` / `streamingAgentId` 是**同一批残留**（不清它，输入框会被锁住，
   *     等于只修了一半）—— 所以这里一并清，并在验收网里给"按钮/禁用"单独一条断言
   *     （反证 C4 专门拆这两个值）。
   *   清了之后新会话开局就是"这一轮不存在"；服务端真在跑的任务由 `/chat/state` 的
   *   `current_task` 那行如实显示（权威在服务端，桌面不猜）。
   */
  const resetChat = () => {
    setChatNote('');
    setStreamText('');
    setChats({});
    historyLoadedRef.current = new Set();
    setAgentSteps([]);
    setAgentDoc(null);
    /** F5：这一轮的残留（见上面那段说明；顺序与 `sendChat` 的 finally 一致，便于对照） */
    setSearchHint('');
    setRunningLoopId(null);
    setRunningLoopWcId(null);
    setStreaming(false);
    setStreamingAgentId(null);
  };
  /**
   * 第 6 步：发送 = 走 /chat/stream（带 JWT，fetch 读 SSE；EventSource 加不了 Authorization 所以不用它）。
   * 第 4 步规矩保留：running 时先让主进程暂停（权威横幅由 'state' 广播改回「你正在控制」），聊天照发。
   */
  const sendChat = async () => {
    /**
     * ★ 白名单改动 ①：`browser` 由注入的**最新值镜像**在调用时取出。
     *   为什么必须是镜像：`useBrowserWorkspace(...)` 排在 `useChat(...)` 之后
     *   （它自己要用 `setChatNote`），两个 hook 互相需要，只能这样解环。
     *   取不到（还没挂上）就什么都不做 —— 与"浏览器工作区没起来"同义。
     */
    const browser = browserRef.current;
    if (!browser) return;
    if (!session) return;
    const value = input.trim();
    if (!value) return;
    // 普通聊天流式中（非运行中任务）阻止重复发送
    if (streaming && !runningLoopIdRef.current) return;
    /**
     * 第 15 步：**这轮消息属于哪个智能体，在发起时就钉死**。
     * 后面所有写入（用户句、流式半截、助手全文）都用这个 id 落桶——
     * 中途切到别的智能体，也绝不会把 A 的话写进 B 的聊天里。
     */
    const myAgent = curAgentRef.current;
    if (myAgent === null) return;
    setChatNote('');

    // ★ 问题 4 核心修复：任务执行期间中途发送消息的锁与意图分类机制
    // 不新建任何冲突并发 Loop，区分为中断指令或补充追问
    if (runningLoopIdRef.current && streaming && streamingAgentId === myAgent) {
      const loopId = runningLoopIdRef.current;
      const wcId = runningLoopWcIdRef.current;

      // 分支 A：中断指令（停、别动、取消、算了、不用了、stop等）—— 优雅中断并保存现场
      if (detectStopIntent(value)) {
        patchChat(myAgent, (c) => ({
          ...c,
          messages: c.messages.concat({ id: Date.now(), role: 'user', text: value }),
        }));
        setInput('');
        setChatNote('好，已为您暂停当前任务。现场状态已完整保留，输入「继续」可原地接上。');
        if (typeof wcId === 'number') {
          void window.workbench?.pauseTask(wcId);
        }
        void fetch(`${API_BASE()}/agent/loop/pause`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
          body: JSON.stringify({ loopId, reason: 'user_paused' }),
        }).catch(() => undefined);
        return;
      }

      // 分支 B：补充指令/追问（如"顺便看一下价格"、"现在什么情况了"）—— 动态注入当前 Loop 上下文
      patchChat(myAgent, (c) => ({
        ...c,
        messages: c.messages.concat({ id: Date.now(), role: 'user', text: value }),
      }));
      setInput('');
      setChatNote(`已将补充指令注入当前任务上下文：「${value}」`);
      void fetch(`${API_BASE()}/agent/loop/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ loopId, message: value }),
      }).catch((e) => {
        setChatNote(`补充指令递交失败：${(e as Error).message}`);
      });
      return;
    }
    // 第 9 步本地闸：聊天里出现「密码/验证码：xxx」这类赋值就拦下——不发送、不落库、
    // 让敏感值只走浏览器输入框（服务端聊天与代填执行层各有自己的闸，这是第一道）。
    // 形态判定：敏感关键词后面跟着「像值的串」（≥6 位字母数字符号），或整句就是 4~8 位纯数字；
    // 只是提到关键词（“验证码一般几位”）不会被拦——宁可拦赋值、不问句误伤。
    if (/(密码|口令|password|passcode|验证码|校验码|captcha|otp|cvv|银行卡|卡号|身份证)[\s:：=是为]{0,3}[A-Za-z0-9*#@$%&+=.-]{6,}/i.test(value)
      || /^\s*\d{4,8}\s*$/.test(value)) {
      setChatNote('这看起来像密码/验证码/卡号：请不要发到聊天里。直接点在中栏工作区那张页的输入框上自己打（我把焦点给这张页面），我不会代填、也不会留存。');
      // 第 15 步：顺手把输入框清空——否则这串敏感值会一直留在框里，
      // 下一次输入变成「123456打开百度」这种拼串，既难查也等于没拦住。
      setInput('');
      try {
        browser.focusActive();
      } catch {
        /* 聚焦失败不碍事 */
      }
      return;
    }
    /**
     * 第 18 步：**只有明确的「停」才停手**。
     * 闲聊（你好 / 谢谢 / 你是谁）绝不打断正在跑的驾驶；「停 / 停下来 / 别动了 / 暂停」才停——
     * 当前这张页在跑就只停那一路，否则全停（判定见 browser/intent.ts 的 detectStopIntent）。
     */
    if (detectStopIntent(value)) {
      browser.stopDriving();
      setChatNote('好，停手了——这一路不再动作。要它接着干，直接说下一步就行。');
    }
    // 第 13 步：明确的开网页指令 → 不再要确认，中栏浏览器工作区直接开一张真实网页。
    // 判定纯本地（不联网、不问模型），所以后端/模型没起来时页面照样打开。
    const openUrl = detectOpenUrl(value);
    /**
     * ★ 第 24 步：认不出的开页指令 —— 必须**拦住模型**，并给用户一张起始页自己输。
     *
     * 用户报的原始症状：「消息里说打开了，浏览器里没有」。
     * 根因是：站点不在登记表 → `detectOpenUrl` 返回 null → 页没开、`browserOpened` 也没带上去，
     * 但**用户那句话照样发给了模型**，模型看到「打开」这个动词就自己编了一句「已为你打开」。
     *
     * 用户拍板（2026-09-19）的处理方式：
     *   **开一张空白起始页 + 把焦点给地址栏**，让用户直接打网址 ——
     *   "认不出"不该是死路，得给一条能走下去的路。
     *
     * 关键：这句话**不再**走 /chat/stream。发过去模型还会继续编，用户就被骗两次。
     */
    const unknownTarget = openUrl === null ? detectUnknownOpenTarget(value) : null;
    if (unknownTarget) {
      patchChat(myAgent, (c) => ({
        ...c,
        messages: c.messages.concat({ id: Date.now(), role: 'user', text: value }),
      }));
      // 开一张起始页，并把焦点交给地址栏
      const startTabId = await browser.openUrl(myAgent, HOME_URL);
      if (startTabId !== null) {
        browser.focusUrlBar();
      }
      setChatNote(
        `我认不出「${unknownTarget}」是哪个网站，所以**没有替你打开任何真实网站** —— 刚才没开就是没开，不糊弄你。\n\n` +
          `我在中栏给你开了一张新标签页，**地址栏已经选中**：直接打网址就行（比如 ${unknownTarget}.com）。\n\n` +
          `（说明：我靠一张**内置站点表**认站点名，表里没有的名字我就认不出。` +
          `这张表是我写的，漏了谁就是这种情况——你说一声我就补上。）`,
      );
      setInput('');
      setHasUnread(false);
      lastUserWasOpenRef.current[myAgent] = false;
      return;
    }
    /**
     * 第 16 步缺项修复：**已经有打开的网页**时，「普通浏览指令」（在这个页面搜一下 AI / 读一下当前页 /
     * 往下滚…）必须交给**驾驶员**去动**当前切到前面的那张**页 —— 不能再只回一句口头「稍等」。
     *
     * 判定纯本地（不联网、不问模型）：一张页都没开就不发车（不开第二张、不新窗口），
     * 闲聊（你好 / 谢谢 / 你是谁）也不发车。
     */
    const activeTab = browser.active;
    let targetWcId: number | undefined;
    if (activeTab) {
      const slept = browser.sleepOf(activeTab.id);
      if (slept) {
        browser.wakeTab(activeTab.id);
        await new Promise((r) => window.setTimeout(r, slept === 'deep' ? 650 : 180));
      }
      const wcId = await browser.awaitWebContentsId(activeTab.id);
      if (typeof wcId === 'number') targetWcId = wcId;
    }
    const browseGoal = openUrl === null && activeTab ? value : null;
    /**
     * 第 16 步：确认是**例外**不是默认。
     * 「继续 / 可以」这类回答只有在**本会话确实有一个待确认的浏览器任务**时才算同意：
     * 判定只看**这个智能体**自己那份聊天里最后一条助手回复是不是在要确认。
     * 一旦算同意 → 直接开页 + 立刻起任务，不再让用户点按钮、也不再问一遍。
     */
    const pendingConfirm =
      openUrl === null &&
      (CONTINUE_STRONG_RE.test(value) || CONTINUE_WEAK_RE.test(value)) &&
      (() => {
        const list = chatsRef.current[myAgent]?.messages ?? [];
        for (let i = list.length - 1; i >= 0; i -= 1) {
          if (list[i].role === 'assistant') return CONFIRM_ASK_RE.test(list[i].text);
        }
        return false;
      })();
    /** 待确认任务的原始目标 = 那条确认之前最近的一句用户原话（沿用第 7/8 步的取法） */
    const pendingGoal = pendingConfirm ? lastUserGoalBeforeConfirm(myAgent) : '';
    const goNow = pendingConfirm && Boolean(pendingGoal);
    /** 这句话本身就算「已确认」：明确开页指令、对确认提问回「继续/可以」、或已在当前页面上干活 */
    const confirmedByThisMessage = openUrl !== null || goNow || browseGoal !== null;
    lastUserWasOpenRef.current[myAgent] = confirmedByThisMessage;

    /**
     * 第 17 步（用户拍板）：**纯闲聊不打断两路驾驶**。
     *
     * 旧行为是「发一句话就把驾驶员暂停」，但本步要求任务能在你聊别的事时继续跑、
     * 不用你盯着点「继续」——所以这里不再全局 pauseTask。
     * 第 18 步起，唯一让驾驶停下来的入口是明确的「停」口令（见上面的 detectStopIntent）；
     * 同一张页再来一条新指令 → 主进程 agentStart 让那一路的旧循环作废（最新指令优先），
     * 别的页上正在跑的那一路完全不动。
     */
    // 用户这句话先落桶（按发起时的智能体）
    patchChat(myAgent, (c) => ({ ...c, messages: c.messages.concat({ id: Date.now(), role: 'user', text: value }) }));

    /**
     * ★★ 步数上限停住后的「继续」：**接回原来那条循环**，绝不发给聊天。
     *
     * 为什么必须在这里短路（这就是本轮要修的 bug 的根因）：
     *   服务端一轮走满（默认 10 步）会自己停下来问「要我接着做就点『继续』」，
     *   但用户这句「继续」—— 不是开页指令（`openUrl` 空）、前面也没有一条**开页确认**提问
     *   （`CONFIRM_ASK_RE` 那张正则是给「要不要我用浏览器帮你打开」用的，匹配不上那句提示）、
     *   更没有动作动词（`browseGoal` 空）—— 于是下面三条发车判定**全空**，
     *   `taskMode` 不带 ⇒ 走 `/chat/stream` 的**普通聊天**分支。
     *   而普通聊天那一支按设计只有 `web_search` 一个工具，**结构上就不可能操作浏览器**，
     *   表现正是用户说的「嘴上答应了、手上不动」。
     *
     *   正确做法是把它接到**已验收的恢复链路**上：主进程 `resumeTask(wcId)` 会
     *   「先读当前真实页 → 服务端 `/agent/loop/resume` 解挂并把步数归零 → 原地接上」，
     *   于是「恢复前重新感知、不盲目跳回旧地址」那套设计自动生效，这里不用重造第二套。
     */
    if (awaitResume && awaitResumeAgent === myAgent && CONTINUE_STRONG_RE.test(value)) {
      const wcId = awaitResumeWc;
      setAwaitResume(false);
      setAwaitResumeAgent(null);
      setAwaitResumeWc(null);
      if (wcId === null) {
        setChatNote('刚才那一轮已经收尾了 —— 直接说你要做什么就行。');
      } else {
        void window.workbench?.resumeTask(wcId);
        pushChatLineFor(myAgent, '好，我接着刚才那一步往下做 —— 先重新看一眼你现在这个页面。');
        // 让主进程把状态刷上来（横幅从「等你继续」回到「AI 驾驶中」）
        window.setTimeout(() => void browser.refreshDriving(), 400);
      }
      setInput('');
      setHasUnread(false);
      return;
    }
    /**
     * 等「继续」期间用户说的是**别的话**（比如「先点第一个结果」）：
     * 等待态解除，这句话照正常路径处理（该发车发车、该聊天聊天）。
     * 只在**同一个智能体**说话时解除 —— 别的智能体聊天不该把这一路的等待态清掉。
     */
    if (awaitResume && awaitResumeAgent === myAgent) {
      setAwaitResume(false);
      setAwaitResumeAgent(null);
      setAwaitResumeWc(null);
    }

    /**
     * 在**某一张**页上发车（第 17 步：必须点名哪张页；主进程不再自己瞎挑一张）。
     * 别路不动 —— 这就是「第二句不会把第一张降级成不能动的占位」。
     *
     * 第 21 步：这里**不再自己发车**。先只记下「哪张页 + 目标」，等服务端把
     * loopId（工具循环号）发下来再发车 —— 脑在服务端，桌面只当手。
     */
    let drive: { wcId: number; goal: string; note: string; pageUrl: string } | null = null;
    /**
     * 读「待发车」的那份信息。用函数读是为了绕开 TS 的控制流收窄：
     * 赋值发生在异步闭包里，直接读变量会被收窄成 null（编译期看不到那次赋值）。
     */
    const pendingDrive = (): { wcId: number; goal: string; note: string; pageUrl: string } | null => drive;

    const prepareDrive = async (tabId: number, goal: string, note: string, pageUrl: string): Promise<void> => {
      /*
       * ★ 第 24 步：与 startAgentTask 同一道保险 —— **派任务前先把睡着的页叫醒**。
       *
       * 这里是主聊天路径（用户说一句话 → AI 在这张页上干活），
       * 命中率比"继续"按钮那条路高得多，所以这道拦截更不能少：
       * 深休眠的页不在 DOM 里，`awaitWebContentsId` 拿不到句柄，
       * 就会变成「我说了话 AI 没反应」。
       */
      const slept = browser.sleepOf(tabId);
      if (slept) {
        browser.wakeTab(tabId);
        await new Promise((r) => window.setTimeout(r, slept === 'deep' ? 650 : 180));
      }
      const wcId = await browser.awaitWebContentsId(tabId);
      if (typeof wcId !== 'number') {
        setChatNote('这张页还没准备好（拿不到内嵌页句柄），没有发车。');
        return;
      }
      drive = { wcId, goal, note, pageUrl };
      setAgentSteps([]);
      setAgentDoc(null);
      setChatNote(note);
    };

    /** 真正发车：带 loopId（服务端已建好的循环）时直接用；没带就让主进程自己建一个 */
    const launch = (loopId?: string, forceWcId?: number): void => {
      const d = pendingDrive();
      const effectiveWcId = forceWcId ?? d?.wcId ?? targetWcId;
      if (typeof effectiveWcId !== 'number') return;
      const goal = d?.goal || value;
      // token 递给主进程只用于请求头；不打印
      void window.workbench?.agentStart(goal, API_BASE(), session.token, effectiveWcId, { agentId: myAgent, loopId });
      window.setTimeout(() => {
        void browser.refreshDriving();
      }, 400);
    };

    if (openUrl) {
      // 明确开页指令 → 打开（同站则复用）那张页。
      const tabId = await browser.openUrl(myAgent, openUrl);
      if (tabId !== null && !isPureOpenCommand(value)) {
        await prepareDrive(tabId, value, '已把这条指令交给驾驶员，在刚打开的那张页上执行（不新开窗口）。', openUrl);
        const newWcId = await browser.awaitWebContentsId(tabId);
        if (typeof newWcId === 'number') targetWcId = newWcId;
      }
    } else if (goNow) {
      // 「继续」= 直接执行：打开目标站点后立刻把目标交给驾驶员循环
      const url = detectOpenUrl(pendingGoal) ?? HOME_URL;
      const tabId = await browser.openUrl(myAgent, url);
      if (tabId !== null) {
        await prepareDrive(tabId, pendingGoal, '按你的确认开始执行。', url);
        const newWcId = await browser.awaitWebContentsId(tabId);
        if (typeof newWcId === 'number') targetWcId = newWcId;
      }
    } else if (activeTab) {
      // 无论是否匹配旧白名单动词，只要有活跃页面，均预先准备驾驶员
      await prepareDrive(
        activeTab.id,
        value,
        '已把这条指令交给驾驶员，在当前这张网页上执行。',
        activeTab.url,
      );
    }
    setInput('');
    setHasUnread(false);
    setStreaming(true);
    setStreamingAgentId(myAgent);
    setStreamText('');
    let sawLoop = false;
    try {
      const res = await fetch(`${API_BASE()}/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
        // 所有用户输入统一发送到服务端，服务端自主判定是否进入任务模式，不依赖本地正则白名单
        body: JSON.stringify({
          conversationId: chatsRef.current[myAgent]?.convId ?? undefined,
          agentId: myAgent,
          message: value,
          ...(openUrl || (activeTab?.url) ? { browserOpened: openUrl ?? activeTab?.url } : {}),
          pageUrl: pendingDrive()?.pageUrl || activeTab?.url,
          wcId: pendingDrive()?.wcId ?? targetWcId,
        }),
      });
      if (!res.ok || !res.body) {
        // 服务端在开流前给的 JSON 人话（503 未配置模型 / 400 / 401…）原样贴出来
        let msg = `HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { error?: string; code?: string };
          if (j.code === 'llm_not_configured') msg = '未配置模型：在 apps/server/.env 填 DEEPSEEK_API_KEY 后重启 npm run dev:server';
          else if (j.error) msg = j.error;
        } catch {
          /* 非 JSON 错误体，维持 HTTP 状态码 */
        }
        // 第 13 步：开网页指令即使这句没发给小助，页也已经开好了——先说清楚，
        // 免得用户以为「开网页」也失败了（后端/模型没起是另一回事，照实说）。
        setChatNote(`${openUrl ? '网页已经打开在中栏浏览器工作区里；' : ''}没发出去：${msg}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let acc = '';
      let sawDone = false;
      /** 第 26 步：服务端在 done 里给的来源（已去重）；空数组 = 这轮没搜过 */
      let sawSources: ChatSource[] = [];
      /** 批次 J：服务端对这一轮 @点名 的裁决（老后端不给 → null，按「没点名」渲染） */
      let sawMention: ChatMentionMeta | null = null;
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        buf += decoder.decode(chunk, { stream: true });
        const blocks = buf.split(/\r?\n\r?\n/);
        buf = blocks.pop() ?? '';
        for (const block of blocks) {
          const lines = block.split(/\r?\n/);
          const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() ?? '';
          const dl = lines.find((l) => l.startsWith('data:'));
          if (!dl) continue;
          let j: {
            delta?: string;
            error?: string;
            conversationId?: number;
            loopId?: string;
            maxSteps?: number;
            wcId?: number;
            /** 第 26 步：search 事件的载荷（{phase, query, results}） */
            phase?: string;
            query?: string;
            results?: number;
            /** 第 26 步：done 事件带来的来源列表（本轮联网检索命中的网页） */
            sources?: ChatSource[];
            /** 批次 J：meta 帧带来的点名裁决（谁开口、点到了谁、为什么没换人） */
            mention?: ChatMentionMeta;
            /** 规格 C1：对话式建智能体时，服务端在 meta 帧带回新建的智能体（左栏数据源） */
            newAgent?: AgentView;
          };
          try {
            j = JSON.parse(dl.slice(5).trim());
          } catch {
            continue; // 坏帧忽略，等下一条
          }
          if (ev === 'meta' && typeof j.conversationId === 'number') {
            // 会话号写回**发起时那个智能体**的桶（不是「此刻正在看的」那个）
            const cid = j.conversationId;
            patchChat(myAgent, (c) => (c.convId === cid ? c : { ...c, convId: cid }));
            /**
             * 批次 J：服务端的裁决到了。
             * · 换人轮：正在打字的那个头像要跟着换（否则「研究员在答」却闪着「小助」的正在输入）；
             * · 会话**不搬家**：这轮仍然显示在当前这条会话里，只是气泡上多一块名字牌 ——
             *   用户要的是「叫另一个人就这段话说两句」，不是被甩到另一个聊天窗口去。
             */
            if (j.mention) {
              sawMention = j.mention;
              if (j.mention.speakerAgentId !== null) setStreamingAgentId(j.mention.speakerAgentId);
            }
            /**
             * 规格 C1：对话式建好新智能体。
             * 聊天桶这一侧先落好（它自己的空会话,历史标记已拉过,切过去不会闪请求）,
             * 再通知组合层（App）：左栏现真名字 + 切到它 + 输入框上方摆三问 chips。
             */
            if (j.newAgent) {
              const na = j.newAgent;
              historyLoadedRef.current.add(na.id);
              patchChat(na.id, () => ({ messages: [], convId: na.conversationId }));
              options.onNewAgent?.(na);
            }
          } else if (ev === 'loop' && typeof j.loopId === 'string') {
            // 第 21 步：服务端已经建好工具循环 —— 现在才发车，带着这个循环号
            sawLoop = true;
            const effectiveWc = typeof j.wcId === 'number' && j.wcId >= 0 ? j.wcId : targetWcId;
            setRunningLoopId(j.loopId);
            setRunningLoopWcId(effectiveWc ?? null);
            launch(j.loopId, effectiveWc);
          } else if (ev === 'search') {
            /**
             * 第 26 步：联网搜索的过程提示。
             * 只认服务端推来的这个事件，**不推断**任何东西：
             * 服务端说"开始搜了"就显示，说"搜完了/搜失败了"就换一句，本轮结束就收掉。
             */
            if (j.phase === 'start') setSearchHint(`正在搜索：${j.query ?? ''}`);
            else if (j.phase === 'done')
              setSearchHint(`已搜索「${j.query ?? ''}」（${j.results ?? 0} 条结果），正在整理…`);
            else if (j.phase === 'error') setSearchHint(`搜索没成功：${j.query ?? ''}（AI 会如实说明）`);
          } else if (ev === 'error') setChatNote(`出错了：${j.error ?? '未知原因'}`);
          else if (ev === 'done') {
            sawDone = true;
            sawSources = Array.isArray(j.sources) ? j.sources : [];
          }
          else if (j.delta) {
            acc += j.delta;
            setStreamText(acc); // 打字机：逐段追加到助手气泡
          }
        }
      }
      /**
       * 第 21 步兜底：任务轮没拿到 loopId（老后端 / 流被掐）也要发车 ——
       * 主进程会自己调 /agent/loop/start 建一个（同一条引擎，不是第二套）。
       *
       * 批次 J 加了一道闸（决策2 之后的口径）：服务端**已经用一句告知答过**的那两轮
       * （R-A 被点名者正忙 / 整条只写了 @名字）不兜底发车 —— 那两轮服务端既没派活也没调模型，
       * 桌面再发一次就等于把用户的一句「@某人」变成一次浏览器操作。
       * 换人轮（switch）与 @ 自己（self）**照旧可以发车**：按决策2，循环归会话主人。
       */
      if (
        shouldFallbackLaunch({
          pendingDrive: Boolean(pendingDrive()),
          sawLoop,
          serverMentionKind: sawMention?.kind ?? null,
        })
      )
        launch();
      if (acc) {
        /**
         * 批次 J：这句是**谁**说的。
         * · 服务端给了裁决 → 用它（换人轮就是被点名者）；
         * · 老后端没给 mention → 退回「发起这轮的那个智能体」：那一轮本来只有它会答，不是猜；
         * · 连名字都查不到 → speaker 留 undefined，气泡**不挂名字牌**（宁可不显示，不显示错的）。
         * 之后切会话/刷新会由 /chat/history 的 speaker 覆盖成库里的真值。
         */
        const nameOfAgent = (id: number | null): string | null =>
          agentsRef.current.find((a) => a.id === id)?.name ?? null;
        const spokenBy: ChatSpeaker | undefined = sawMention
          ? sawMention.speakerAgentId === null
            ? undefined
            : { id: sawMention.speakerAgentId, name: sawMention.speakerName || nameOfAgent(sawMention.speakerAgentId) }
          : myAgent === null
            ? undefined
            : { id: myAgent, name: nameOfAgent(myAgent) };
        patchChat(myAgent, (c) => ({
          ...c,
          messages: c.messages.concat({
            id: Date.now() + 1,
            role: 'assistant',
            text: acc,
            /** 第 26 步：来源跟着这条回复走，渲染在气泡下方（没搜过就是 undefined） */
            sources: sawSources.length > 0 ? sawSources : undefined,
            speaker: spokenBy,
          }),
        }));
      } else if (!sawDone) {
        setChatNote((n) => n || '这轮没拿到回复（未完成，服务端不会把半截存进历史）。');
      }
    } catch (e) {
      setChatNote(`${openUrl ? '网页已经打开在中栏浏览器工作区里；' : ''}连不上后端：${(e as Error).message}`);
    } finally {
      setRunningLoopId(null);
      setRunningLoopWcId(null);
      setStreaming(false);
      setStreamingAgentId(null);
      setStreamText('');
      // 第 26 步：这一轮结束，搜索提示跟着收掉（它只在这一轮里有效）
      setSearchHint('');
      // 第 16 步：这轮服务端已经更新过会话状态（current_task / browser_confirmed）——
      // 拉回来刷新界面上的状态行，改口后这里显示的就是新任务了。
      void loadAgentStateRef.current(myAgent);
    }
    // 第 9 步：刚才是回答驾驶员的「补资料」提问 → 把答案递给主进程并自动恢复循环
    // 第 15/17 步：只有「正在等的那个智能体 + 那一张页」的回答才转给它；别处的话不串过去。
    if (agentAwaitInfo && agentAwaitAgent === myAgent) {
      setAgentAwaitInfo(false);
      setAgentAwaitAgent(null);
      setChatNote('已把答复转给小助，继续驾驶中…');
      void window.workbench?.agentAnswer(value, agentAwaitWcId ?? undefined);
      setAgentAwaitWcId(null);
    }
  };

  const onSend = () => {
    void sendChat();
  };

  /**
   * 第 7 步 + 第 13/17 步：把目标交给主进程的 AI 循环。
   * 驾驶目标就是**某一张打开的页**；还没开过就先按目标里的站点开一张（拿不到站点才用默认主页），
   * 然后等 guest 真就绪再发车，否则主进程会「没有找到内嵌 webview 的 webContents」。
   * 第 17 步：别路（别的页）不动 —— 两路可以同时跑。
   */
  const startAgentTask = async (rawGoal?: string) => {
    /** 同上：`browser` 在调用时从注入的最新值镜像里取 */
    const browser = browserRef.current;
    if (!browser) return;
    const goal = (rawGoal ?? '').trim();
    if (!goal || !session) return;
    const cur = browser.active;
    const owner = curAgentRef.current;
    if (owner === null) return;
    const tabId = cur ? cur.id : await browser.openUrl(owner, detectOpenUrl(goal) ?? HOME_URL);
    if (tabId === null) return;
    /*
     * ★ 第 24 步：**AI 要用的页如果正睡着，先把它叫醒**。
     *
     * 为什么必须在这儿拦：深休眠的页**已经从 DOM 里卸载了**，
     * `awaitWebContentsId` 会一直拿不到句柄 → 走到下面那句
     * 「这张页还没准备好（拿不到内嵌页句柄）」→ 任务根本没发出去。
     * 用户看到的是「我说了话，AI 没动」，而他并不知道是休眠导致的 ——
     * 这是最难排查的一类问题，所以必须在源头处理掉。
     *
     * 唤醒用的是**系统唤醒**（manual=false）：不记宽限期，
     * 活干完了该睡还是照常睡回去。
     */
    const slept = browser.sleepOf(tabId);
    if (slept) {
      browser.wakeTab(tabId);
      setChatNote(
        slept === 'deep'
          ? '先把那张睡着的页叫醒（它在后台待久了、内存被收走了），加载完就开始。'
          : '先把那张打盹的页叫回来（它刚才在后台省电），马上开始。',
      );
      // 深休眠唤醒要真的重新加载一次，给 React 挂载 + dom-ready 留时间；
      // 浅休眠是瞬时的，这点等待也不亏（下面 awaitWebContentsId 本来就会轮询）。
      await new Promise((r) => window.setTimeout(r, slept === 'deep' ? 650 : 180));
    }
    const wcId = await browser.awaitWebContentsId(tabId);
    if (typeof wcId !== 'number') {
      setChatNote('这张页还没准备好（拿不到内嵌页句柄），没有发车。');
      return;
    }
    setAgentSteps([]);
    setAgentDoc(null);
    // token 递给主进程只用于请求头；不打印
    // 第 21 步：这条路径（「继续 / 开始任务」按钮）没有 loopId —— 主进程会自己
    // 调 /agent/loop/start 建一个（同一条服务端引擎）；agentId 仍然要带上，别串 bot。
    void window.workbench?.agentStart(goal, API_BASE(), session.token, wcId, { agentId: owner });
    window.setTimeout(() => {
      void browser.refreshDriving();
    }, 400);
  };

  return {
    chats,
    setChats,
    chatsRef,
    historyLoadedRef,
    curChat,
    messages,
    setMessages,
    patchChat,
    streaming,
    setStreaming,
    streamingAgentId,
    setStreamingAgentId,
    streamText,
    setStreamText,
    chatNote,
    setChatNote,
    agentSteps,
    setAgentSteps,
    agentDoc,
    setAgentDoc,
    pushChatLine,
    pushChatLineFor,
    loadAgentHistory,
    resetChat,
    searchHint,
    runningLoopId,
    sendChat,
    onSend,
    startAgentTask,
  };
}

