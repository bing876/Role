import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import type {
  AgentCreateResult,
  AgentEventPayload,
  AgentListResult,
  AgentPersona,
  AgentTidyResult,
  AgentView,
  AuthProfile,
  AuthSession,
  ChatHistoryResult,
  ChatSource,
  ChatStateResult,
  ConversationStateView,
  KnowledgeDeleteResult,
  KnowledgeDocument,
  KnowledgeListResult,
  KnowledgeUploadResult,
  MemoryEntry,
  MemoryLayerList,
  MemoryItem,
  MemoryListResult,
  OpenTabRequest,
  ProjectCreateResult,
  ProjectListResult,
  ProjectSummary,
  ProjectUpdateResult,
  TaskState,
  WorkbenchSettings,
} from '@ai-workbench/shared';
import {
  BrowserPanel,
  CONFIRM_ASK_RE,
  CONTINUE_STRONG_RE,
  CONTINUE_WEAK_RE,
  HOME_URL,
  HelpCard,
  detectBrowseIntent,
  detectOpenUrl,
  detectStopIntent,
  detectUnknownOpenTarget,
  isPureOpenCommand,
  useBrowserWorkspace,
} from './browser';
import type { EmbedRect } from './browser';
import { ChannelsPanel } from './channels';
import { useResourceGuard } from './resources/useResourceGuard';

/**
 * 第 2 步（内嵌版）「脸和门」：
 *   - 脸：主窗口做成一个能看懂的简易聊天界面（假数据 + 内存状态）
 *   - 门：内嵌一个 <webview>，能直接显示真实网页（不再开独立窗口）
 *        —— 第 13 步起这块网页从右栏搬到了中栏聊天的浏览器卡片里
 *
 * 第 3 步「遥控器先通」：
 *   - 右栏底部加一块**很丑的调试区**，用几个按钮证明程序能驾驶这块内嵌页
 *   - 驾驶走 preload → 主进程 → 内嵌 webview 的 webContents（CDP），不接大模型
 *   - 调试区刻意不做美化，UI 统一留给前端会话
 *
 * 第 4 步「任务状态机」：
 *   - idle | running | paused | done | failed 的**权威状态在主进程 driver.ts**，
 *     这里只订阅它的 'state' 广播做镜像（大字横幅 / 状态行）
 *   - 「暂停 / 我来操作」、以及**左侧聊天发一句话**，都让主进程立刻停止自动 click/type
 *   - 「继续」= 主进程先 read_page 读你当前的真实页面再决定下一步（不重放暂停前步骤）
 *   - 不接大模型、不新开窗口、不加标签页、不动右栏宽度与整体 UI
 *
 * 第 5 步（重做版）「账号」：
 *   - 打开先见登录页（手机验证码 / XYZ号+密码 / 微信占位），登录成功才渲染原三栏工作台；
 *   - 注册/登录成功拿到系统分配的对外号 `XYZ+数字`（不可自选），左栏可见；
 *   - 登录后才谈密码：左栏小块可设置/修改（≥8 位，服务端只存哈希）。
 *
 * 第 6 步「真聊天」：
 *   - 中间聊天不再是内存假数据：发一句 → POST /chat/stream 带第 5 步 JWT，SSE 逐字打字机；
 *   - 用 fetch 读流（EventSource 加不了 Authorization 头，所以不用它）；
 *   - 刷新/重启仍登录时 GET /chat/history 还原（服务端从加密的 messages 表解密回传）；
 *   - 第 4 步规矩还在：running 时发这句 = 先让主进程 paused，聊天照发；
 *   - AI 只会说话：不指挥浏览器、不假装开过网页（服务端系统提示词也这么钉死）。
 *
 * 第 7 步「云端驾驶员」：
 *   - 聊天里模型说「这需要用工作台浏览器，确认后我开始操作」时，气泡下出现【确认按钮】；
 *     按钮只挂在**最后一条**确认回复上（旧按钮不再渲染），goal 取该确认之前最近的
 *     那句**用户原话**（例如「打开百度搜天气」）——不读输入框、不取更早的消息，取不到就不开车；
 *   - 循环在**主进程**：read_page → POST /agent/next-action（带 JWT）→ 拿【一个】动作 →
 *     走现有 driver 执行 → 记一步摘要 → 再读页……直到 done / ask_user / 你暂停；
 *   - 暂停语义沿用第 4 步：暂停立刻停手；
 *   - 渲染层只是镜像：聊天里的 ⚠️/✅ 都来自 'agent' 事件。
 *
 * 第 13 步「聊天内浏览器卡片 + 收干净右栏」：
 *   - 用户发**明确开网页指令**（打开百度 / 打开抖音 / 打开 https://… / 打开浏览器）时不再要确认：
 *     中栏聊天里直接插一张卡片，卡片里是**真实 <webview>**
 *     （第 20 步起按智能体分桶；Phase 3 起**登录态**按项目：persist:workbench-browser-project-{projectId}；第 18 步起已改挂在中栏工作区），
 *     能点、能在页面输入框打字；卡片上只有「展开 / 收起」一个按钮，不新开窗口、不做多标签；
 *   - 纯闲聊 / 问知识库 / 问「你是谁」：不弹网页、不加载（判定见 browser/sites.ts 的 detectOpenUrl）；
 *   - 右栏驾驶台（开始任务/暂停/继续/我来操作/复位/示例任务/黄框调试区/浏览器开关）全部撤掉，
 *     状态机保留在主进程内部，不在右栏画状态；右栏只在有任务结果时出现一张结果卡；
 *   - 驾驶目标改为**卡片里这张页**（第 22 步起必须**显式**给出该页的 webContentsId：
 *     原 `getWebviewId` 盲取已随 `findWebviewGuest` 一并删除，见 driver.ts 的 resolveTarget），流程没变；
 *   - 敏感闸没动：聊天输入框发 123456 仍被拦下、不落库、不代填；验证码/密码请在网页里自己打。
 *
 * 第 15 步「添加智能体 + 引导表 + 两层记忆」：
 *   - 左栏是**智能体列表**（自带「小助」+ 用户点「添加」建的），点「添加」不发弹窗、不开新窗口：
 *     服务端建一个智能体 + 立刻给它建一条空会话，界面直接切到那个新会话；
 *   - 新会话里第一张就是**引导表**（名称 / 它是谁 / 怎么说话 / 干什么，四行简单表格），
 *     确认后这个智能体才按这份描述干活；没填完也能留着这个会话，模型只引导、不空人设乱聊；
 *   - **会话隔离**：一个智能体一份聊天（各自的 conversation + 各自的消息列表），
 *     切智能体 = 换聊天；流式回包按**发起时那个智能体**落桶，绝不写进别的智能体；
 *   - 网页卡片仍是第 13 步那一张：谁当前在聊谁用，切换后旧卡片降级成一行占位（全窗口恒 1 个 webview）；
 *   - 两层记忆：用户记忆库（账号级，所有智能体都读）/ 项目记忆（智能体级，绝不串）。
 *
 * 第 16 步「智能体行为（最新指令优先 + 确认例外）」：
 *   - 确认是**例外**：用户回「继续 / 可以」且本会话确实有个待确认的浏览器任务时，
 *     桌面直接开卡片 + 立刻起任务（不再让用户点按钮、模型也不再问一遍）；
 *   - 改口立刻切换：running 中用户发明确开页指令（「打开油管」）→ 主进程 agentDrop 掉旧任务，
 *     旧目标不会被「继续」重新捡起来，也不会再问「现在到底是 A 还是 B」；
 *   - 会话状态（current_task / browser_confirmed / keepalive…）存在服务端现有会话表里，
 *     聊天顶部显示状态行，进程重启后据此恢复当前任务；
 *   - 「启动并保活」只标监听态：空闲时服务端一次模型都不调（看 /health 的 llmCalls），
 *     仍在这一个窗口里，不新开窗口、不起新进程。
 *
 * 第 18 步「浏览器模块 + 工作区框架」：
 *   - 浏览器相关的东西**全部收进 apps/desktop/src/browser/**（tab 状态、开/关页、
 *     URL 栏、webview 宿主、协议拦截、驾驶接口）；这个文件只挂载
 *     <BrowserPanel ws={browser} agentLabel={…} />，不再往里堆开页逻辑。
 *     主进程的协议拦截仍在 electron/，桌面侧的浏览器 UI/状态以 browser/ 为准。
 *   - 中栏是**钉住的浏览器工作区**（tab + URL + 当前页），它是 .chat 的兄弟节点，
 *     滚聊天滚不没；切智能体也不收起、不卸载（正在跑的驾驶因此不断）。
 *   - 聊天只说话和结论：开页成功只看 tab，不再每页一条记录；关页只从工作区消失，
 *     聊天里最多留一句人话（单条提示，不列「已关闭」清单）。
 *   - 闲聊不打断驾驶；只有明确的「停」口令才停手（见 browser/intent.ts 的 detectStopIntent）。
 *
 * 第 20 步「每智能体独立浏览器 + 取消活页硬顶」（Phase 3 只动了其中的**登录态粒度**）：
 *   - **标签页 / 当前页 / 滚动 / 任务** 仍按智能体分开：一个智能体 = 一桶；
 *   - **登录态粒度 = 项目**（Phase 3 起）：分区是 `persist:workbench-browser-project-{projectId}`
 *     （见 browser/url.ts 的 partitionFor）——**同项目的智能体共用一套 cookie / 登录态**，
 *     跨项目完全隔离；**标签页 / 任务 / 暂停继续仍然按 agentId 隔离**，没跟着合并。
 *   - 切智能体只换「哪一桶可见」：**所有页的 webview 一直挂着**，切回来页面和滚动都还在。
 *   - **取消活页上限**：开多少张都行，不再「第 11 张顶掉最旧」；页数多了只提示「开太多会卡」。
 *   - 驾驶只动当前智能体自己的页（点名的 tab 一定来自它自己那一桶）。
 *
 * 子阶段 2-B「项目层接进前端（最小化验证，不是最终 UI）」：
 *   - 左栏顶部加一个**最简项目入口**：能看全部项目、能新建、点一下切换当前项目
 *     （不做下拉动效 / 双击切换 / 全屏小圆圈这类正式交互，那是后面独立 UI 阶段的事）；
 *   - 切项目 = 换一份名单：`GET /agents?projectId=<当前项目>` 只画这个项目的智能体，
 *     知识库列表也按项目重拉（`GET /knowledge?projectId=`）；互不串；
 *   - **切项目绝不动浏览器**：所有智能体、所有页的 webview 一直挂着（第 20 步的规矩），
 *     项目 A 里正在跑的那一路驾驶在切到项目 B 之后照旧推进、切回来它还在 ——
 *     这正是本子阶段最关键的一条验收（用假模型时间戳 + 循环 step 证明，不靠嘴说）；
 *   - 「＋ 添加」不再发空 body（2-A 起 `asAgentId` 是必填，空 body 会被 400 挡回来）：
 *     前端从**当前项目**的名单里自动挑 `canCreateAgents === true` 的那个（母鸡；
 *     默认项目里没有母鸡，由自带小助承担这个角色）当调用者，用户不需要手动选身份。
 *     挑不到就明确报错、**绝不自作主张猜一个身份**（那等于绕开权限闸）。
 *   - 分区规则、母鸡调度、项目级记忆都不在本子阶段范围内。
 */

/** 第 18 步：聊天只剩这两种角色 —— 网页不再以消息形式出现在聊天里（看中栏工作区） */
type Role = 'user' | 'assistant';
type Message = {
  id: number;
  role: Role;
  text: string;
  /**
   * 第 26 步：这条回复引用到的网页来源（本轮联网检索命中的）。
   * 只有走过搜索的助手回复才有；渲染成气泡下方的可点链接。
   */
  sources?: ChatSource[];
};
/** 第 15 步：一个智能体 = 一份聊天（自己的消息列表 + 自己的会话号） */
type AgentChat = { messages: Message[]; convId: number | null };
/**
 * 第 27 步：一张**人工介入求助卡**（AI 主动求助）。
 *
 * ★ 这里刻意**只有文案与 id，没有任何输入字段** —— 卡片不承载输入能力，
 *   用户必须在上面那块**真实页面**里自己操作（安全红线，见 HelpCard.tsx 顶部注释）。
 */
type HelpCardView = {
  /** 触发求助的那张内嵌页（guest webContents id）—— 恢复时要点名它 */
  wcId: number;
  agentId: number;
  helpKind: 'captcha' | 'login';
  question: string;
  hint: string;
};
/** 空列表用同一个常量：切智能体时引用稳定，不会每次渲染都造新数组 */
const EMPTY_MESSAGES: Message[] = [];

/**
 * 阶段简报 · 方案 B：临时测试条用的相位中文名。
 *
 * 只是把主进程状态机的 `TaskPhase` 翻成人话显示，**不做二次判断**——
 * 真实权威状态始终在主进程（界面只是镜像），免得出现「界面说暂停、实际还在跑」。
 */
const DRIVE_PHASE_LABEL: Record<string, string> = {
  idle: '空闲',
  running: 'AI 驾驶中',
  paused: '已暂停',
  done: '已完成',
  failed: '失败',
};

/**
 * 第 27 步 · **「谁在等谁」的唯一口径**（本步的核心验收点之一）。
 *
 * 要解决的问题：用户主动按「暂停」和 AI 自己走不下去来求助，
 * 在状态机里**都是 `phase='paused'`** —— 界面原来只按 phase 取文案，
 * 于是两种情况被压成同一句话「已暂停（页面归你操作）」，用户根本分不清是谁在等谁。
 *
 * 现在把两件事拆开：
 *   · `phase`    管"停没停"；
 *   · `pausedBy` 管"**谁**发起的"。
 * 颜色 / 图标 / 文案**三者一律跟着 `pausedBy` 走**，绝不跟着 phase 走。
 *
 * ★ 分不清时（`pausedBy` 为空）走**中立灰**，如实说"没记下是谁发起的" ——
 *   绝不猜、也不冒充任何一方（猜错的代价是用户按错了按钮）。
 */
function driveStateView(
  state: TaskState | null | undefined,
): { cls: 'user' | 'agent' | 'none'; icon: string; text: string } | null {
  if (!state || state.phase !== 'paused') return null;
  if (state.pausedBy === 'agent') {
    return { cls: 'agent', icon: '🤖', text: `AI 主动求助 · 等你处理 — ${state.detail}` };
  }
  if (state.pausedBy === 'user') {
    return { cls: 'user', icon: '✋', text: `你主动接管 · 页面归你 — ${state.detail}` };
  }
  return { cls: 'none', icon: '⏸', text: `已暂停（未记录发起方）— ${state.detail}` };
}

/**
 * 第 16 步：确认是**例外**，不是默认。
 *
 * 模型只在「本会话第一次要用浏览器、且这句不是明确开页指令」时回那句固定话术；
 * 桌面靠 CONFIRM_ASK_RE（见 ./browser）识别「有一个待确认的浏览器任务」。
 * 用户回「继续 / 可以」= 同意 → **直接开页并起任务**，不再让他点按钮、也不再问一遍。
 * （和 server 端 promptPolicy.isContinueMarker 保持同一套词表。）
 */

/** 第 8 步：GET /agent/task/current 的形态（红点/结果都认这个，不信内存假数据） */
interface CurrentTask {
  id: number;
  status: string;
  goal: string;
  steps: string[];
  unread: boolean;
  summary?: string;
  docTitle?: string;
  unreadHint?: string;
  outline?: string[];
}

/**
 * 第 6 步：不再放写死的开场白。
 * 历史一律以服务端 `/chat/history` 为准（库里的密文解密回传）；
 * 一条都没有时中间区显示一句空态提示，而不是拿假对话冒充“聊过”。
 * 第 15 步：这份历史是**按智能体**分开的——每个智能体只拉自己那条会话。
 */

// ---------------------------------------------------------------------------
// 第 5 步（重做版）：先登录，再进工作台
//
// - 登录页三入口：① 手机号+短信验证码（未注册自动建号，会分到 XYZ 对外号）
//                ② XYZ号+密码（没设过密码会被服务端**明确拒绝**，提示先走手机号）
//                ③ 微信「即将开通」——点它只会出提示，**永远不会进工作台**（服务端 501，不发 token）
// - 登录成功把 JWT 存 localStorage（key: workbench.token）。**绝不往 console 打 token 全文**，
//   下面唯一的日志只输出长度。重开应用时用 /auth/me 静默续会话（effect 带 off 标志防卸载后 setState）。
// - 连不上后端 / 库没起：把服务端的“人话”直接贴给用户，别甩一堆 fetch 栈。
// - 未登录时整个工作台不渲染（登录门控在 App 的 return 处），不做“游客看假数据”那一套。
// ---------------------------------------------------------------------------

/** 后端地址：默认 127.0.0.1:8787；浏览器直测模式下自动使用相对路径走 Vite 代理 */
const API_BASE = () => {
  const custom = localStorage.getItem('workbench.apiBase');
  if (custom) return custom;
  if (typeof window !== 'undefined' && !(window as any).workbench?.isElectron) {
    return '';
  }
  return 'http://127.0.0.1:8787';
};
const TOKEN_KEY = 'workbench.token';

/**
 * 第 22 步：可调配置的**兜底值** —— `packages/shared` 里 `DEFAULT_SETTINGS` 的第二份。
 *
 * 只用于「主进程还没把配置同步过来」的那一瞬间（首帧）。正常路径永远以主进程为准
 * （挂载时 getSettings 拉一次，之后跟随 'settings' 广播）。
 * 之所以不复用 shared 的运行时值：渲染层至今只从 shared 取类型，不引入打包期依赖更稳。
 */
const SETTINGS_FALLBACK: WorkbenchSettings = {
  // ⚠️ 这几个数必须与 packages/shared 的 DEFAULT_SETTINGS 保持一致（权威值在主进程 settings.ts，
  // 这里只是首帧兜底）。之所以不复用 shared 的运行时值：渲染层至今只从 shared 取**类型**，
  // 不引入打包期依赖更稳 —— 代价就是**改默认值时要记得同步这一处**。
  // 当前：并发默认 20（子阶段 A 起）、开页上限默认 4；
  // Phase 4 新增的资源守护者字段（开关 / 频率 / 两档阈值 / 系统内存兜底）同样照抄一份。
  maxConcurrentAgentTasks: 20,
  maxBrowserInstances: 4,
  resourceGuardEnabled: 1,
  resourceSampleMs: 5000,
  resourceMemHealthMB: 3072,
  resourceMemWarnMB: 4096,
  resourceCpuHealthPct: 20,
  resourceCpuWarnPct: 35,
  resourceSysMemGuard: 0,
  resourceSysMemFloorMB: 1536,
};

async function authFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE()}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    // ★ 文案要指向本机真正可用的那个动作。
    // 这台机器上没有可用的 Docker（PG 是便携包），"npm run db:up" 是跑不通的；
    // 正确做法是双击仓库根的 start-dev.cmd（它清陈旧 pid → 起 PG → 等库真能查 → 起服务端）。
    throw new Error(`连不上后端 ${API_BASE()}：先双击仓库根目录的 start-dev.cmd 起库和服务端，再重试`);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(dbHint(data.error) ?? `HTTP ${res.status}`);
  return data;
}

/**
 * 把服务端那句「先跑 docker compose…」换成本机真正可用的指引。
 *
 * 服务端 8 个 route 都会回同一句 503 文案（docker / npm run db:up），
 * 但本机没有可用的 Docker —— 对着这句照做只会更困惑。
 * 这里统一在渲染层做一次替换，改动面最小、也不会漏掉某个 route。
 */
function dbHint(msg?: string): string | undefined {
  if (!msg) return msg;
  if (msg.includes('数据库连不上')) {
    return '数据库没连上：双击仓库根目录的 start-dev.cmd（它会起库 + 服务端并等到真正可用），再点一次';
  }
  return msg;
}

type AuthTab = 'sms' | 'xyz' | 'wechat';

function AuthScreen({ onSession }: { onSession: (s: AuthSession) => void }) {
  const [tab, setTab] = useState<AuthTab>('sms');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [xyz, setXyz] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  /** 获取验证码后的 60 秒冷却（和服务端 60 秒防连发对齐） */
  const [cooldown, setCooldown] = useState(0);
  /** 后端就绪状态：checking 首次探测 / waiting 正在自愈 / ready 可用 */
  const [backend, setBackend] = useState<'checking' | 'waiting' | 'ready'>('checking');
  /** 已经等了多久（秒），给用户一个"在动"的反馈 */
  const [waited, setWaited] = useState(0);
  /** 自增即可重新触发下面的探测 effect（请求失败时用它"重新排队等后端"） */
  const [probeKey, setProbeKey] = useState(0);
  /** mock 模式下的验证码（应用自己拉起的服务端，用户看不到任何窗口 —— 由主进程转过来） */
  const [mockCode, setMockCode] = useState<{ masked: string; code: string } | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  /**
   * ★★ 等后端自己就绪（2026-09-20 补，修的就是"明明在自愈、界面却甩红字"）。
   *
   * 背景：应用启动时会在后台**自己拉起 PostgreSQL + 服务端**（见 server-supervisor）。
   * 冷启动最坏要 ~40 秒（PG 崩溃恢复 + 建表重试）。而登录页原来一发现 fetch 失败
   * 就写死一句「连不上后端 … 再重试」，**而且不会自己重试** ——
   * 用户看到的是一句吓人的红字，其实后端半分钟后就自己好了。
   * 这就是"功能明明修好了、用户却还是进不去"的真正来源：**报错报早了，且不撤销**。
   *
   * 现在：不通就每 2 秒自己重探，期间只显示"正在准备"，探到就**自动把红字撤掉**继续。
   * 探测口径与主进程一致：认 `/health` 的 `service` 标识，不认"有东西回 200"。
   */
  useEffect(() => {
    let off = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const r = await fetch(`${API_BASE()}/health`, { signal: AbortSignal.timeout(2500) });
        const j = (await r.json()) as { service?: string };
        if (off) return;
        if (j?.service === 'ai-workbench-server') {
          setBackend('ready');
          setErr('');   // ★ 后端自己好了 → 必须把之前那句红字撤掉，否则用户以为还坏着
          setWaited(0);
          return;
        }
      } catch {
        /* 还没起来，继续等 */
      }
      if (off) return;
      setBackend('waiting');
      setWaited((w) => w + 2);
      timer = window.setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => { off = true; if (timer) window.clearTimeout(timer); };
  }, [probeKey]);

  /** 主进程转来的 mock 验证码（只有应用自己拉起服务端时才会有） */
  useEffect(() => {
    const off = window.workbench?.onSmsMockCode?.((info) => {
      setMockCode(info);
      setCode(info.code);
    });
    return () => { off?.(); };
  }, []);

  const smsCodeSent = async () => {
    setErr('');
    setHint('');
    setBusy(true);
    try {
      await authFetchJson('/auth/sms/send', { method: 'POST', body: JSON.stringify({ phone: phone.trim() }) });
      setCooldown(60);
      setHint(
        '验证码已发送（开发模式不发真短信）。'
        + '下面会直接显示 6 位码；万一没显示，说明服务端是你手动起的 —— '
        + '去「AI工作台-服务端」窗口找 [sms:mock] 那行。',
      );
    } catch (e) {
      // 429 是限流（服务端每分钟每个 IP 有上限）——直接说清楚，别让用户以为是自己输错了。
      const msg = (e as Error).message;
      // 连不上 = 后端还在自愈 → 不甩红字，改成"重新排队等后端"（见上面的探测 effect）
      if (msg.includes('连不上后端')) { setProbeKey((k) => k + 1); }
      else setErr(msg.includes('太频繁') ? `${msg}（这是防刷限制，等一会儿再点就好，不是你的手机号有问题）` : msg);
    } finally {
      setBusy(false);
    }
  };

  const login = async (path: string, body: Record<string, string>) => {
    setErr('');
    setHint('');
    setBusy(true);
    try {
      const sess = await authFetchJson<AuthSession>(path, { method: 'POST', body: JSON.stringify(body) });
      localStorage.setItem(TOKEN_KEY, sess.token);
      /**
       * ★ 登录成功 → 显式把登录态同步给主进程一次。
       * 主进程的 token 是纯内存的，只有这一条通道能让它"知道"用户已登录，
       * 供下载文档等**主进程自己发请求**的场景使用（详见 preload 的 syncSession 注释）。
       */
      void window.workbench?.syncSession?.(API_BASE(), sess.token);
      console.info(`[auth] 登录成功：${sess.user.xyz_id}（token 已保存 ${sess.token.length} 字符，全文不打印）`);
      onSession(sess);
    } catch (e) {
      const msg = (e as Error).message;
      // 同上：连不上后端不是"错误"，是"还在自愈中"—— 别写红字，重新排队等它
      if (msg.includes('连不上后端')) setProbeKey((k) => k + 1);
      // 「该账号还没设置过密码…」这类服务端人话原样显示，不吞
      else setErr(msg);
    } finally {
      setBusy(false);
    }
  };

  const tabBtn = (id: AuthTab, label: string) => (
    <button type="button" className={tab === id ? 'authTab authTab--on' : 'authTab'} onClick={() => { setTab(id); setErr(''); setHint(''); }}>
      {label}
    </button>
  );

  return (
    <div className="authWrap">
      <div className="authCard">
        <h3>登录 AI 工作台</h3>
        <div className="authTabs">
          {tabBtn('sms', '手机验证码')}
          {tabBtn('xyz', 'XYZ号+密码')}
          {tabBtn('wechat', '微信')}
        </div>

        {/*
          ★ 后端还在自愈时**只显示"正在准备"**，绝不写红字。
          应用启动会在后台自己拉起数据库 + 服务端，冷启动最坏 ~40 秒；
          这段时间里甩一句"连不上后端"会让人以为坏了（这正是之前反复被报的问题）。
        */}
        {backend !== 'ready' && (
          <div className="small" style={{ color: '#8a6d3b', padding: '6px 0' }}>
            正在准备后端…（应用会自动拉起数据库和服务端，首次启动最长约 1 分钟
            {waited > 0 ? `，已等 ${waited} 秒` : ''}）
          </div>
        )}

        {/* ★ mock 模式下直接把验证码摆出来：服务端是应用自己起的，用户看不到任何窗口 */}
        {mockCode && (
          <div className="small" style={{ padding: '6px 0' }}>
            本次验证码：<b style={{ fontSize: 16, letterSpacing: 2 }}>{mockCode.code}</b>
            <span style={{ opacity: 0.65 }}>（开发模式 · {mockCode.masked}）</span>
          </div>
        )}

        {tab === 'sms' && (
          <>
            <input className="authInput" placeholder="大陆手机号（11 位）" value={phone} maxLength={11}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} />
            <div className="authRow">
              <input className="authInput" style={{ flex: 1 }} placeholder="6 位验证码" value={code} maxLength={6}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              <button type="button" className="btn" disabled={busy || backend !== 'ready' || cooldown > 0 || phone.length !== 11} onClick={() => void smsCodeSent()}>
                {cooldown > 0 ? `${cooldown}s 后可重发` : '获取验证码'}
              </button>
            </div>
            <button type="button" className="btn btn--go" disabled={busy || backend !== 'ready' || phone.length !== 11 || code.length !== 6}
              onClick={() => void login('/auth/login/sms', { phone: phone.trim(), code })}>
              登录 / 注册
            </button>
            <div className="small">未注册的手机号会自动建号，并分配对外号 XYZ+数字（不能自选）。</div>
            <div style={{ marginTop: 12, borderTop: '1px dashed #e0e0e0', paddingTop: 10 }}>
              <button
                type="button"
                className="btn"
                style={{ width: '100%', background: '#f0f7ff', color: '#0284c7', borderColor: '#bae6fd', fontWeight: 600, padding: '8px 12px' }}
                onClick={async () => {
                  setErr('');
                  setBusy(true);
                  try {
                    const testPhone = '1380013' + String(Date.now()).slice(-4);
                    setPhone(testPhone);
                    const s = await authFetchJson<{ sent: boolean; mock_code?: string }>('/auth/sms/send', {
                      method: 'POST',
                      body: JSON.stringify({ phone: testPhone }),
                    });
                    const c = s.mock_code || '123456';
                    setCode(c);
                    await login('/auth/login/sms', { phone: testPhone, code: c });
                  } catch (e) {
                    setErr((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                ⚡ 快捷登录：一键演示账号进入
              </button>
            </div>
          </>
        )}

        {tab === 'xyz' && (
          <>
            <input className="authInput" placeholder="XYZ 号（如 XYZ10001，也可只输数字）" value={xyz}
              onChange={(e) => setXyz(e.target.value)} />
            <input className="authInput" type="password" placeholder="密码（≥8 位）" value={password}
              onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="btn btn--go" disabled={busy || backend !== 'ready' || !xyz || !password}
              onClick={() => void login('/auth/login/xyz', { xyz, password })}>
              登录
            </button>
            <div className="small">没设置过密码的号会在这里被明确拒绝：先用手机号验证码登录后到左栏设密码。</div>
          </>
        )}

        {tab === 'wechat' && (
          <>
            <div className="small" style={{ padding: '8px 0' }}>
              微信登录「即将开通」：本步只在数据库预留了 openid/unionid 字段，未接入真实微信。
            </div>
            <button type="button" className="btn btn--go" onClick={() => setHint('微信登录即将开通，本步点它没有用——请走手机号或 XYZ号+密码。')}>
              用微信登录（即将开通）
            </button>
          </>
        )}

        {hint && <div className="small">{hint}</div>}
        {err && <div className="authErr">{err}</div>}
      </div>
    </div>
  );
}

/** 左栏头像里的那个字：小助固定「助」，自建智能体取名字首字（还没名字就是「新」） */
function agentGlyph(a: AgentView): string {
  if (a.kind === 'assistant') return '助';
  const n = (a.persona?.name || a.name || '').trim();
  return n ? n.slice(0, 1) : '新';
}

/**
 * 第 15 步：聊天里的「引导表」。
 *
 * 用户点「添加」后，**新会话里先摆这张表**（不是先弹一个独立设置窗、更不是后台配置页）：
 * 四行简单表格——名称 / 它是谁 / 怎么说话 / 干什么，加一个确认按钮。
 * 确认 → 服务端存人设 → personaStatus 变 ready，这个智能体才按这份描述干活；
 * 没填完也可以先留着这个会话（服务端这时只让模型引导用户填表，不空人设乱聊）。
 */
function AgentGuide({
  agent,
  onSave,
  onDelete,
}: {
  agent: AgentView;
  onSave: (p: AgentPersona) => Promise<void>;
  onDelete: () => void;
}) {
  const [name, setName] = useState(agent.persona?.name ?? '');
  const [who, setWho] = useState(agent.persona?.who ?? '');
  const [tone, setTone] = useState(agent.persona?.tone ?? '');
  const [duty, setDuty] = useState(agent.persona?.duty ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const rows: Array<{ label: string; value: string; ph: string; set: (v: string) => void; max: number }> = [
    { label: '名称', value: name, ph: '它叫什么？', set: setName, max: 24 },
    { label: '它是谁', value: who, ph: '例如：一个只懂电商运营的老手', set: setWho, max: 120 },
    { label: '怎么说话', value: tone, ph: '例如：短句、直接、别客套', set: setTone, max: 120 },
    { label: '干什么', value: duty, ph: '例如：帮我盯店铺数据、写商品标题', set: setDuty, max: 120 },
  ];

  const submit = async () => {
    if (!name.trim() || busy) return;
    setErr('');
    setBusy(true);
    try {
      await onSave({ name: name.trim(), who: who.trim(), tone: tone.trim(), duty: duty.trim() });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="guide">
      <div className="guide__head">先给这个智能体定个样子</div>
      <div className="small">填完点确认，它才按这份描述干活；没填完也能先留着这个会话。</div>
      <table className="guide__table">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th>{r.label}</th>
              <td>
                <input
                  className="guide__input"
                  value={r.value}
                  placeholder={r.ph}
                  maxLength={r.max}
                  onChange={(e) => r.set(e.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="buttons-row">
        <button type="button" className="btn btn--go guide__ok" disabled={busy || !name.trim()} onClick={() => void submit()}>
          {busy ? '保存中…' : '确认，就按这个来'}
        </button>
        <button type="button" className="btn guide__del" onClick={onDelete}>
          删掉这个智能体
        </button>
      </div>
      {err && <div className="authErr">{err}</div>}
    </div>
  );
}

export default function App() {
  /** 头像右上角红点：第 8 步起由服务端 tasks.unread 驱动（登录后拉 current，done 事件点亮，看完熄灭） */
  const [hasUnread, setHasUnread] = useState(false);
  const [curTask, setCurTask] = useState<CurrentTask | null>(null);
  const [taskDetailOpen, setTaskDetailOpen] = useState(false);
  const [docNote, setDocNote] = useState('');
  /**
   * 第 4 步：任务状态机的镜像。
   * 权威状态在主进程（driver.ts），挂载时取一次 + 之后靠 'state' 广播同步；
   * 大字横幅「AI 正在控制 / 你正在控制」由它推导，不再用本地 state 猜测。
   */
  const [task, setTask] = useState<TaskState>({
    phase: 'idle',
    detail: '等待主进程同步…',
    step: 0,
    blocked: false,
  });
  /**
   * 第 22 步：可调配置的镜像（权威副本在主进程 userData 下的 JSON）。
   * 挂载时拉一次 + 跟随 'settings' 广播；`settingsRef` 给开页等同步逻辑取「此刻」的值。
   */
  const [settings, setSettings] = useState<WorkbenchSettings>(SETTINGS_FALLBACK);
  const settingsRef = useRef<WorkbenchSettings>(settings);
  settingsRef.current = settings;
  const [input, setInput] = useState('');
  /**
   * 第 15 步：**一个智能体一份聊天**。
   * chats[agentId] = { messages, convId }；切换智能体只是换渲染哪一份，
   * 绝不把两个智能体的消息揉成一条时间线。
   */
  const [chats, setChats] = useState<Record<number, AgentChat>>({});
  /** 异步回包里读最新 chats（闭包里拿 state 会拿到旧的） */
  const chatsRef = useRef<Record<number, AgentChat>>({});
  chatsRef.current = chats;
  /** 左栏选中的那个智能体；null = 还没拿到列表 */
  const [curAgentId, setCurAgentId] = useState<number | null>(null);
  /** 异步回调里读「此刻是哪个智能体」——直接用 state 会拿到挂载时的旧闭包值 */
  const curAgentRef = useRef<number | null>(null);
  curAgentRef.current = curAgentId;
  /** 已经拉过历史的智能体，来回切换不反复请求 */
  const historyLoadedRef = useRef<Set<number>>(new Set());

  /** 只改**某一个**智能体的那份聊天。异步回包（尤其是流式）必须用它，别用下面的 setMessages */
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
  /** 第 1 步的 IPC 自检，留着当回归哨兵 */
  const [bridgeInfo, setBridgeInfo] = useState('检测中…');

  // ---- 第 5 步：会话。JWT 从 localStorage 读回后只放内存 state；绝不 console 打全文 ----
  const [session, setSession] = useState<AuthSession | null>(null);
  /**
   * 多智能体编排 · 「内部频道」面板开没开。
   *
   * 只是个视图开关（与 `browser.view` 同一性质）：开了盖在中栏上面看智能体之间的
   * 委派对话，关掉就回到原来的样子 —— **不 start / 不 resume / 不碰任何一路驾驶**。
   */
  const [showChannels, setShowChannels] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(() => Boolean(localStorage.getItem(TOKEN_KEY)));
  const [pwOld, setPwOld] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwMsg, setPwMsg] = useState('');

  /** 带已存 token 调 /auth/me：能换回 profile 就静默登录，换不回来就清 token 回登录页 */
  useEffect(() => {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (!saved) return;
    let off = false; // 卸载标志：慢回来的响应不再 setState
    authFetchJson<AuthProfile>('/auth/me', { headers: { authorization: `Bearer ${saved}` } })
      .then((p) => {
        if (off) return;
        /**
         * ★ F5 后的静默恢复 —— **必须**同步给主进程。
         * 这条路径完全不经过主进程（token 是从 localStorage 直接读出来的），
         * 不同步的话就会出现「渲染层已登录、主进程没凭证」，
         * 用户刷新后立刻点下载文档就会报"没有登录凭证"。
         */
        void window.workbench?.syncSession?.(API_BASE(), saved);
        setSession({ ...p, token: saved });
      })
      .catch(() => {
        localStorage.removeItem(TOKEN_KEY);
        // 登录态失效 → 顺手把主进程那份也清掉，别留着一份过期的还能发请求
        void window.workbench?.syncSession?.(API_BASE(), '');
        if (!off) setSession(null);
      })
      .finally(() => { if (!off) setCheckingAuth(false); });
    return () => { off = true; };
  }, []);

  // ---- 第 6 步：流式聊天状态（真聊天，不再是内存假数据）----
  /**
   * 第 13 步：这一轮的**用户原话**是不是「开网页指令」。
   * 是的话，即使模型仍回了「确认后我开始操作」那句老话，也不再挂确认按钮——
   * 网页已经在工作区里打开了，再要用户点确认就是自相矛盾。
   * 第 15 步：按智能体分别记（否则在 A 里开的网页会压掉 B 里的确认按钮）。
   */
  const lastUserWasOpenRef = useRef<Record<number, boolean>>({});
  const [streaming, setStreaming] = useState(false);
  /** 第 15 步：这轮流式是**哪个**智能体在打字——切走后不该在别的智能体里冒出打字气泡 */
  const [streamingAgentId, setStreamingAgentId] = useState<number | null>(null);
  /** 打字机中的半截助手回复（done 之前只活在这里；库里只有完成的全文） */
  const [streamText, setStreamText] = useState('');
  /** 聊天区一条可关闭的提示（未配置模型 / 出错 / 已先行暂停等），不冒充 AI 的话 */
  const [chatNote, setChatNote] = useState('');
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

  /**
   * 第 9 步：驾驶员在聊天里等用户回答普通资料（need_info）——回答后自动继续，不用点「继续」。
   * 第 15 步：驾驶员的循环是**全进程一个**（第 7 步的设计），但「这句答复该不该喂给它」要按智能体判——
   * agentAwaitAgent 记住这个提问是**哪个智能体**在等，别的智能体聊天里的回答不会串进去。
   */
  const [agentAwaitInfo, setAgentAwaitInfo] = useState(false);
  const [agentAwaitAgent, setAgentAwaitAgent] = useState<number | null>(null);
  /** 任务模式状态机追踪（idle / running / paused / waiting_user） */
  const [runningLoopId, setRunningLoopId] = useState<string | null>(null);
  const [runningLoopWcId, setRunningLoopWcId] = useState<number | null>(null);
  const runningLoopIdRef = useRef<string | null>(null);
  const runningLoopWcIdRef = useRef<number | null>(null);
  runningLoopIdRef.current = runningLoopId;
  runningLoopWcIdRef.current = runningLoopWcId;
  /** 第 17 步：提问来自**哪一张页**（答复只喂给那一路，不串到另一路） */
  const [agentAwaitWcId, setAgentAwaitWcId] = useState<number | null>(null);
  /**
   * ★ 步数上限自动停（服务端 reason='step_budget'）——「继续」的**第二种**等待态。
   *
   * 与上面那组 `agentAwait*` 的区别必须写清楚：两种等待长得像，但「继续」该做的事完全不同。
   *   · `need_info`：AI 在问**资料**，用户回答的那句话要**当上下文喂进循环**；
   *   · `step_budget`：AI 只是**走满一轮停下来了**，用户的「继续」不是新信息，
   *     而是一条「把原来那条循环接回去」的指令 —— 所以要走主进程的 resumeTask，
   *     **绝不能发给聊天**（聊天那条路上没有浏览器工具，发出去就变成「嘴上答应、手上不动」）。
   */
  const [awaitResume, setAwaitResume] = useState(false);
  const [awaitResumeAgent, setAwaitResumeAgent] = useState<number | null>(null);
  const [awaitResumeWc, setAwaitResumeWc] = useState<number | null>(null);
  /** 当前这个智能体在等驾驶员提问吗（切到别的智能体就不提示） */
  const awaitHere = agentAwaitInfo && agentAwaitAgent === curAgentId;
  /** 第 15 步：左栏智能体列表（服务端为准）。personaStatus==='pending' 时聊天里摆引导表 */
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentNote, setAgentNote] = useState('');
  /**
   * 子阶段 2-B：项目层（**最小化验证版**，不做正式 UI）。
   *   - `projects` / `curProjectId` 一律以服务端 `/projects` 为准；
   *   - 两个 ref 是给异步回调读**最新值**用的（闭包会拿到旧的，切项目在异步里最容易串）；
   *   - `agents` 与 `curProjectId` **永远一起更新**（见 enterProject），
   *     所以「名单里挑母鸡」不会挑到别的项目的人。
   */
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [curProjectId, setCurProjectId] = useState<number | null>(null);
  const curProjectRef = useRef<number | null>(null);
  const agentsRef = useRef<AgentView[]>([]);
  agentsRef.current = agents;
  /**
   * Phase 3：`agentId → projectId`（**只喂浏览器的分区**，不参与任何 UI 分桶）。
   *
   * 为什么要单独一份：`agents` 里只有**当前项目**的名单，切过项目就查不到别的项目的智能体了；
   * 而浏览器分区要在「这张页属于哪个项目」这件事上永远答得准（答不准就会把登录态串到别的项目）。
   * 每次拿到名单（`fetchAgentsFor`）就补进来；实在没有的**不猜** —— 返回 null，
   * 那张页落到兜底分区 `…-project-none`，宁可让它登出，也绝不让它跟真项目混。
   */
  const agentProjectRef = useRef<Map<number, number>>(new Map());
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectNote, setProjectNote] = useState('');
  /** 第 15 步 · 第一层：用户记忆库（账号级，所有智能体都能读，界面上也列出来） */
  const [userMem, setUserMem] = useState<MemoryEntry[]>([]);
  const [userMemOpen, setUserMemOpen] = useState(false);
  /** 第 15 步 · 第二层：**当前智能体**的项目记忆（智能体级，切智能体就整块换掉） */
  const [projMem, setProjMem] = useState<MemoryEntry[]>([]);
  const [projMemOpen, setProjMemOpen] = useState(false);
  /** 记忆合并第四批：待确认记忆（decision/fact 需用户确认才生效） */
  const [pendingMem, setPendingMem] = useState<MemoryItem[]>([]);
  const [pendingMemOpen, setPendingMemOpen] = useState(false);
  /**
   * 第 16 步：每个智能体的**会话状态**（服务端现有 Postgres 的 conversations 表为准）。
   * current_task / browser_confirmed / keepalive 都从这里来；进程重启后靠它恢复「当前任务」。
   * 异步回包里要用 ref 读最新值（闭包会拿到旧的）。
   */
  const [agentStates, setAgentStates] = useState<Record<number, ConversationStateView>>({});
  const agentStatesRef = useRef<Record<number, ConversationStateView>>({});
  agentStatesRef.current = agentStates;
  /** 保活开关正在请求中（防连点） */
  const [keepaliveBusy, setKeepaliveBusy] = useState(false);
  /** 第 11 步：知识库资料独立于 memories；只展示当前账号的文件元信息和已入库段数。 */
  const [knowledgeDocs, setKnowledgeDocs] = useState<KnowledgeDocument[]>([]);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [knowledgeUploading, setKnowledgeUploading] = useState(false);
  const [knowledgeNote, setKnowledgeNote] = useState('');
  /** 第 19 步：正在删的那条资料 id（按钮显示「删除中…」并防连点），null = 没有删除在跑 */
  const [knowledgeDeletingId, setKnowledgeDeletingId] = useState<number | null>(null);
  const knowledgeFileRef = useRef<HTMLInputElement | null>(null);
  /** 第 7 步：主进程 'agent' 事件的镜像（步摘要/文档结论），权威循环在主进程 */
  const [agentSteps, setAgentSteps] = useState<string[]>([]);
  const [agentDoc, setAgentDoc] = useState<{ title: string; outline: string[] } | null>(null);

  /** 聊天里追加一条「小助之外」的系统泡（driver 循环的问话/结论/报错），只进内存展示 */
  const pushChatLine = (text: string) => {
    setMessages((prev) => prev.concat({ id: Date.now() + Math.floor(Math.random() * 1000), role: 'assistant', text }));
  };

  /**
   * 第 17 步：按智能体落桶的系统泡。
   * 两路驾驶可能分属两个智能体，事件里的 wcId 决定这条话进谁的聊天 ——
   * 绝不按「此刻正在看的那个智能体」乱写（那正是「聊天串了」）。
   */
  const pushChatLineFor = (agentId: number, text: string) => {
    patchChat(agentId, (c) => ({
      ...c,
      messages: c.messages.concat({ id: Date.now() + Math.floor(Math.random() * 1000), role: 'assistant', text }),
    }));
  };

  /**
   * 第 22 步：改可调配置（并发数 / 多实例上限）。
   *
   * 主进程是权威：它会夹到合法区间、落盘，并广播 'settings'。
   * 所以这里**不本地猜结果**，用返回/广播的值回填（手输越界会立刻被纠正回来）。
   */
  const onSettingsChange = async (patch: Partial<WorkbenchSettings>): Promise<void> => {
    const bridge = window.workbench;
    if (!bridge) return;
    try {
      setSettings(await bridge.setSettings(patch));
    } catch {
      setChatNote('改配置没成功（preload 桥异常），数值保持原样。');
    }
  };

  /**
   * 第 16 步：找到「最近一次要确认」之前那句用户原话 —— 它就是用户回「继续」时要执行的目标。
   * 取法沿用第 7/8 步（不读输入框、不拿更早的消息）：从该智能体最后一条助手消息往前找，
   * 是确认话术就继续往前找最近一条用户消息；找不到就返回空（那就明确不执行，绝不拿空目标开车）。
   */
  const lastUserGoalBeforeConfirm = (agentId: number): string => {
    const list = chatsRef.current[agentId]?.messages ?? [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].role !== 'assistant' || !CONFIRM_ASK_RE.test(list[i].text)) continue;
      for (let j = i - 1; j >= 0; j -= 1) {
        if (list[j].role === 'user') return list[j].text.trim();
      }
      return '';
    }
    return '';
  };

  // ---- 第 15 步：两层记忆 + 智能体列表（一切以服务端为准，界面只做展示） ----
  const memHeaders = () => ({ authorization: `Bearer ${sessionRef.current?.token ?? ''}` });

  /** 第一层：用户记忆库（账号级）——任何智能体都读得到，界面也一样列出来 */
  const loadUserMemory = async () => {
    if (!sessionRef.current) return;
    try {
      const r = await authFetchJson<MemoryLayerList>('/memory/user', { headers: memHeaders() });
      setUserMem(r.items);
    } catch {
      /* 后端/库没起就不打扰 */
    }
  };
  /** 第二层：某个智能体的项目记忆（智能体级）——切智能体就整块换成它自己的 */
  const loadProjectMemory = async (agentId: number) => {
    if (!sessionRef.current) return;
    try {
      const r = await authFetchJson<MemoryLayerList>(`/agents/${agentId}/memory`, { headers: memHeaders() });
      // 切走之后晚到的响应不能覆盖当前智能体的那份
      if (curAgentRef.current !== agentId) return;
      setProjMem(r.items);
    } catch {
      /* 同上 */
    }
  };
  /** 记忆合并第四批：待确认记忆（账号级+智能体级+会话级，三级合并） */
  const loadPendingMemory = async (agentId?: number | null, conversationId?: number | null) => {
    if (!sessionRef.current) return;
    try {
      const params = new URLSearchParams();
      if (agentId) params.set('agentId', String(agentId));
      if (conversationId) params.set('conversationId', String(conversationId));
      const qs = params.toString() ? `?${params.toString()}` : '';
      const r = await authFetchJson<MemoryListResult>(`/memories${qs}`, { headers: memHeaders() });
      setPendingMem(r.pending);
    } catch {
      /* 后端/库没起就不打扰 */
    }
  };

  /**
   * 第 16 步：拉某个智能体的会话状态（当前任务 / 是否已同意用浏览器 / 是否保活）。
   * 进程重启后靠它把「当前任务」恢复出来，而不是假装任务从未开始。
   */
  const loadAgentState = async (agentId: number) => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      const r = await authFetchJson<ChatStateResult>(`/chat/state?agentId=${agentId}`, {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (sessionRef.current?.token !== sess.token) return;
      if (r.state) setAgentStates((prev) => ({ ...prev, [agentId]: r.state as ConversationStateView }));
    } catch {
      /* 后端/库没起就不打扰 */
    }
  };

  /**
   * 「启动并保活」：只把该会话标成监听态（服务端 conversations.keepalive）。
   * 空闲时服务端**一次模型都不调**（看 /health 的 llmCalls），有新消息才走 /chat/stream；
   * 不新开窗口、不起新进程、不做 7×24 集群。
   */
  const toggleKeepalive = async () => {
    const sess = sessionRef.current;
    const agentId = curAgentRef.current;
    if (!sess || agentId === null || keepaliveBusy) return;
    const on = !agentStatesRef.current[agentId]?.keepalive;
    setKeepaliveBusy(true);
    try {
      const r = await authFetchJson<ChatStateResult>('/chat/state', {
        method: 'POST',
        body: JSON.stringify({ agentId, keepalive: on }),
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (r.state) setAgentStates((prev) => ({ ...prev, [agentId]: r.state as ConversationStateView }));
      setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, listening: on } : a)));
      setChatNote(
        on
          ? '已启动并保活：这个智能体进入监听态，空闲时不调模型，有新消息才处理（仍在这一个窗口里）。'
          : '已停止保活。',
      );
    } catch (e) {
      setChatNote(`保活开关没成：${(e as Error).message}`);
    } finally {
      setKeepaliveBusy(false);
    }
  };

  /** 拉某个智能体自己的那条会话历史（一个智能体一份聊天，不串） */
  const loadAgentHistory = async (agent: AgentView) => {
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
        messages: h.messages.map((m) => ({ id: m.id, role: m.role, text: m.text, sources: m.sources })),
        convId: h.conversationId,
      }));
    } catch (e) {
      setChatNote(`拉取历史失败：${(e as Error).message}`);
    }
  };

  /**
   * 子阶段 2-B：按项目取智能体名单（**纯取，不动 state**）。
   *
   * 拆出来是为了让「切项目」能先把新名单拿到手、再和新项目 id **一次性**写进 state ——
   * 中间不存在「项目已换、名单还是旧的」那一帧（那种帧里「＋ 添加」会挑到别的项目的母鸡）。
   * `projectId` 为 null（列表还没回来）时不带参数，保持 2-A 的旧语义（这个账号的全部智能体）。
   */
  const fetchAgentsFor = async (projectId: number | null): Promise<AgentListResult | null> => {
    const sess = sessionRef.current;
    if (!sess) return null;
    const qs = projectId === null ? '' : `?projectId=${projectId}`;
    const r = await authFetchJson<AgentListResult>(`/agents${qs}`, {
      headers: { authorization: `Bearer ${sess.token}` },
    });
    if (sessionRef.current?.token !== sess.token) return null; // 切号期间晚到的响应丢掉
    /**
     * Phase 3：顺手登记「这些智能体分别属于哪个项目」（浏览器分区要用它）。
     * 服务端已经在每条 AgentView 上带 projectId；老响应没带就退回这次查询用的 pid，
     * 两个都没有 → 不记（那台页会落兜底分区，不跟任何真项目混）。
     */
    for (const a of r.agents) {
      const pid = Number(a.projectId ?? projectId);
      if (Number.isInteger(pid) && pid > 0) agentProjectRef.current.set(a.id, pid);
    }
    return r;
  };

  /** 拉智能体列表（按当前项目）；当前选中的那个不在了就回到第一个 */
  const loadAgents = async (projectId?: number | null) => {
    const sess = sessionRef.current;
    if (!sess) return;
    const pid = projectId === undefined ? curProjectRef.current : projectId;
    try {
      const r = await fetchAgentsFor(pid);
      if (!r) return;
      setAgents(r.agents);
      setAgentNote('');
      const cur = curAgentRef.current;
      const stillThere = cur !== null && r.agents.some((a) => a.id === cur);
      if (stillThere) {
        void loadProjectMemory(cur as number);
        void loadAgentState(cur as number);
        void loadPendingMemory(cur as number, chatsRef.current[cur as number]?.convId ?? null);
      } else if (r.agents.length > 0) {
        const first = r.agents[0];
        curAgentRef.current = first.id;
        setCurAgentId(first.id);
        void loadProjectMemory(first.id);
        void loadAgentHistory(first);
        void loadAgentState(first.id);
        void loadPendingMemory(first.id, first.conversationId);
      }
    } catch (e) {
      setAgentNote(`读不到智能体列表：${(e as Error).message}`);
    }
  };

  // ---- 子阶段 2-B：项目层（最小化验证版；不做正式 UI 交互）----
  /** 读项目列表；把「当前使用中的项目」同步到 state 与 ref，并返回它 */
  const loadProjects = async (): Promise<number | null> => {
    const sess = sessionRef.current;
    if (!sess) return null;
    try {
      const r = await authFetchJson<ProjectListResult>('/projects', {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (sessionRef.current?.token !== sess.token) return null;
      setProjects(r.projects);
      /**
       * ★ 把项目列表推给主进程 —— 分区闸（`will-attach-webview`）靠它判定归属。
       * 主进程那个事件是**同步**的，没法自己去拉，所以必须在这里显式同步一次。
       * 拿不到列表时（上面 catch）不同步，主进程会保持"还没同步过"的宽松状态。
       */
      void window.workbench?.syncProjects?.(r.projects.map((p) => p.id));
      curProjectRef.current = r.currentProjectId;
      setCurProjectId(r.currentProjectId);
      setProjectNote('');
      return r.currentProjectId;
    } catch (e) {
      setProjectNote(`读不到项目列表：${(e as Error).message}`);
      return null;
    }
  };

  /**
   * 进入某个项目：先把「新项目 id」和「它的名单」**一次性**写进 state，再补拉历史 / 项目记忆 /
   * 会话状态 / 资料列表。这样中间不会出现「项目已经换了、名单还是上一个项目的」那一帧。
   *
   * **绝不碰浏览器**：所有智能体、所有页的 webview 一直挂着（第 20 步的规矩），
   * 项目 A 里正在跑的那一路驾驶切到 B 之后照旧推进 —— 这是本子阶段最关键的一条验收。
   */
  const enterProject = async (id: number): Promise<void> => {
    const listed = await fetchAgentsFor(id);
    if (!listed) return;
    curProjectRef.current = id;
    setCurProjectId(id);
    setAgents(listed.agents);
    setAgentNote('');
    setChatNote('');
    setProjMem([]);
    setProjMemOpen(false);
    setKnowledgeDocs([]); // 资料按项目隔离：先清空，等新项目的列表回来
    const first = listed.agents[0] ?? null;
    curAgentRef.current = first ? first.id : null;
    setCurAgentId(first ? first.id : null);
    if (first) {
      void loadProjectMemory(first.id);
      void loadAgentHistory(first);
      void loadAgentState(first.id);
      void loadPendingMemory(first.id, first.conversationId);
    }
    void loadKnowledge(id);
  };

  /** 切换当前项目：服务端 activate 先落地，再进这个项目（名单与资料一起换） */
  const switchProject = async (id: number) => {
    const sess = sessionRef.current;
    if (!sess || projectBusy || id === curProjectRef.current) return;
    setProjectBusy(true);
    setProjectNote('');
    try {
      await authFetchJson<ProjectUpdateResult>(`/projects/${id}/activate`, {
        method: 'POST',
        body: '{}',
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (sessionRef.current?.token !== sess.token) return;
      await enterProject(id);
      await loadProjects();
    } catch (e) {
      setProjectNote(`切换项目没成：${(e as Error).message}`);
    } finally {
      setProjectBusy(false);
    }
  };

  /** 新建项目（服务端连带建一只母鸡并设为当前项目）→ 直接进这个新项目 */
  const createProject = async () => {
    const sess = sessionRef.current;
    const name = newProjectName.trim();
    if (!sess || projectBusy || !name) return;
    setProjectBusy(true);
    setProjectNote('');
    try {
      const r = await authFetchJson<ProjectCreateResult>('/projects', {
        method: 'POST',
        body: JSON.stringify({ name }),
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (sessionRef.current?.token !== sess.token) return;
      setNewProjectName('');
      setProjectNote(`项目「${r.project.name}」建好了（自带一只母鸡），已经切过去。`);
      await enterProject(r.project.id);
      await loadProjects();
    } catch (e) {
      setProjectNote(`建项目没成：${(e as Error).message}`);
    } finally {
      setProjectBusy(false);
    }
  };

  /** 切智能体 = 换一份聊天：换消息列表、换项目记忆 */
  const selectAgent = (agent: AgentView) => {
    if (agent.id === curAgentRef.current) return;
    curAgentRef.current = agent.id; // 立刻生效，免得同一 tick 里的回调写错桶
    setCurAgentId(agent.id);
    // 第 20 步：切智能体 = 换一套浏览器（tab / 当前页 / cookie 都按智能体分开），
    // 但**只换「哪一桶可见」**——所有页的 webview 一直挂着不卸载，
    // 所以切回来页面和滚动都还在，原来在跑的那几路驾驶也不会断。
    setProjMem([]);
    setChatNote('');
    setAgentNote('');
    void loadProjectMemory(agent.id);
    void loadPendingMemory(agent.id, chatsRef.current[agent.id]?.convId ?? agent.conversationId ?? null);
    if (!historyLoadedRef.current.has(agent.id)) void loadAgentHistory(agent);
  };

  /**
   * 子阶段 2-B：从一份名单里挑出**当前项目**里「有建智能体权限」的那个调用者。
   *
   * 规矩：只认 `canCreateAgents` 这个**字段**，不按 kind / 名字猜 —— 闸门就在服务端认这个字段，
   * 前端这边必须和它同一套口径。默认项目里没有母鸡，由自带小助承担（它也是 true）。
   * 名单本身已经是按当前项目过滤过的；再加一道 projectId 比对，防止拿到过期的名单。
   */
  const pickCreator = (list: AgentView[]): AgentView | null => {
    const pid = curProjectRef.current;
    return (
      list.find(
        (a) => a.canCreateAgents === true && (pid === null || a.projectId === undefined || a.projectId === pid),
      ) ?? null
    );
  };

  /**
   * 点「添加」：服务端建一个智能体 + 立刻给它建一条空会话，界面直接切到那个新会话。
   * 不弹独立设置窗、不开新 BrowserWindow —— 引导表就摆在这个新会话里。
   *
   * 子阶段 2-B：`asAgentId` 从「当前项目里 canCreateAgents=true 的那个」**自动推断**（母鸡 / 小助），
   * 用户不需要选身份。名单没到位就现拉一次再挑；**挑不到就明确报错，绝不猜一个身份发出去**
   * （2-A 起 asAgentId 必填、无回落，猜身份 == 绕过权限闸）。
   */
  const addAgent = async () => {
    const sess = sessionRef.current;
    if (!sess || agentBusy) return;
    setAgentBusy(true);
    setAgentNote('');
    try {
      let creator = pickCreator(agentsRef.current);
      if (!creator) {
        const fresh = await fetchAgentsFor(curProjectRef.current);
        if (!fresh) return;
        setAgents(fresh.agents);
        creator = pickCreator(fresh.agents);
      }
      if (!creator) {
        setAgentNote('这个项目里没有能建智能体的角色（母鸡 / 自带小助），先新建一个项目再试。');
        return;
      }
      const r = await authFetchJson<AgentCreateResult>('/agents', {
        method: 'POST',
        body: JSON.stringify({ asAgentId: creator.id }),
        headers: { authorization: `Bearer ${sess.token}` },
      });
      const a = r.agent;
      // 归属兜底：万一拿到的是过期名单（那就会落到别的项目），**不要**把它塞进当前列表误导用户。
      if (curProjectRef.current !== null && a.projectId !== undefined && a.projectId !== curProjectRef.current) {
        setAgentNote(`新智能体落到了别的项目（项目 ${a.projectId}），这里不显示它；列表已重拉。`);
        await loadAgents(curProjectRef.current);
        return;
      }
      // Phase 3：把新智能体也登记进「agentId → projectId」（它马上就可能开页，分区要算对）
      if (curProjectRef.current !== null) agentProjectRef.current.set(a.id, curProjectRef.current);
      setAgents((prev) => prev.concat(a));
      historyLoadedRef.current.add(a.id);
      patchChat(a.id, () => ({ messages: [], convId: a.conversationId }));
      curAgentRef.current = a.id;
      setCurAgentId(a.id);
      setProjMem([]);
      setProjMemOpen(false);
      setChatNote('');
    } catch (e) {
      setAgentNote(`添加没成：${(e as Error).message}`);
    } finally {
      setAgentBusy(false);
    }
  };

  /** 引导表确认：存人设 → 这个智能体从这一刻起按这份描述干活 */
  const savePersona = async (agentId: number, persona: AgentPersona) => {
    const sess = sessionRef.current;
    if (!sess) throw new Error('还没登录');
    const r = await authFetchJson<AgentCreateResult>(`/agents/${agentId}/persona`, {
      method: 'POST',
      body: JSON.stringify(persona),
      headers: { authorization: `Bearer ${sess.token}` },
    });
    setAgents((prev) => prev.map((x) => (x.id === agentId ? r.agent : x)));
    setChatNote(`好，${r.agent.name} 已就位——从现在起它按你填的这份描述干活。`);
  };

  /** 删自建智能体（「小助」服务端会拒）：它的聊天与项目记忆一并清掉，不碰别的智能体 */
  const deleteAgent = async (agentId: number) => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      await authFetchJson(`/agents/${agentId}`, {
        method: 'DELETE',
        body: '{}',
        headers: { authorization: `Bearer ${sess.token}` },
      });
      const next = agents.filter((x) => x.id !== agentId);
      setAgents(next);
      setChats((prev) => {
        const copy = { ...prev };
        delete copy[agentId];
        return copy;
      });
      historyLoadedRef.current.delete(agentId);
      setAgentStates((prev) => {
        const copy = { ...prev };
        delete copy[agentId];
        return copy;
      });
      if (curAgentRef.current === agentId) {
        const first = next[0];
        curAgentRef.current = first ? first.id : null;
        setCurAgentId(first ? first.id : null);
        setProjMem([]);
        if (first && !historyLoadedRef.current.has(first.id)) void loadAgentHistory(first);
      }
      // 第 18 步：这个智能体开的那些网页一并关掉（它那几路驾驶也一起放下）
      browser.closeTabsOfAgent(agentId);
      setChatNote('已删掉这个智能体（它的聊天和项目记忆一并清掉，没碰别的智能体）。');
    } catch (e) {
      setChatNote(`删除没成：${(e as Error).message}`);
    }
  };

  /**
   * 「结束」：把这段聊天**总结**进两层记忆（不是把整段聊天当记忆存）。
   * 服务端按「偏口味/习惯 → 用户库；偏这个项目的业务/资料 → 该智能体项目记忆」分类，
   * 敏感信息在写入前一律整条丢弃。
   */
  const tidyCurrentAgent = async () => {
    const sess = sessionRef.current;
    const agentId = curAgentRef.current;
    if (!sess || agentId === null) return;
    const convId = chatsRef.current[agentId]?.convId ?? null;
    setChatNote('正在把这段聊天总结进两层记忆…');
    try {
      const r = await authFetchJson<AgentTidyResult>(`/agents/${agentId}/tidy`, {
        method: 'POST',
        body: JSON.stringify({ conversationId: convId ?? undefined }),
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (r.skipped === 'llm_not_configured') setChatNote('没配 DEEPSEEK_API_KEY，这次没整理记忆。');
      else if (r.skipped === 'empty_transcript') setChatNote('还没聊过天，没有可整理的。');
      else setChatNote(`整理完了：用户记忆库 +${r.userAdded} 条，本项目记忆 +${r.projectAdded} 条。`);
      void loadUserMemory();
      void loadProjectMemory(agentId);
      void loadPendingMemory(agentId, convId);
    } catch (e) {
      setChatNote(`整理记忆没成：${(e as Error).message}`);
    }
  };

  /** 忘掉一条：user = 账号级用户记忆库；agent = 当前智能体的项目记忆 */
  const forgetEntry = async (layer: 'user' | 'agent', id: number) => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      await authFetchJson('/memory/forget', {
        method: 'POST',
        body: JSON.stringify({ layer, id }),
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (layer === 'user') void loadUserMemory();
      else if (curAgentRef.current !== null) void loadProjectMemory(curAgentRef.current);
    } catch (e) {
      setChatNote(`忘掉失败：${(e as Error).message}`);
    }
  };

  /** 记忆合并第四批：确认/拒绝待确认记忆 */
  const confirmMemory = async (id: number) => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      await authFetchJson('/memories/confirm', {
        method: 'POST',
        body: JSON.stringify({ ids: [id] }),
        headers: { authorization: `Bearer ${sess.token}` },
      });
      setPendingMem((prev) => prev.filter((m) => m.id !== id));
      void loadUserMemory();
      if (curAgentRef.current !== null) void loadProjectMemory(curAgentRef.current);
      setChatNote('已确认一条记忆，今后会按它执行。');
    } catch (e) {
      setChatNote(`确认失败：${(e as Error).message}`);
    }
  };
  const rejectMemory = async (id: number) => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      await authFetchJson('/memories/reject', {
        method: 'POST',
        body: JSON.stringify({ ids: [id] }),
        headers: { authorization: `Bearer ${sess.token}` },
      });
      setPendingMem((prev) => prev.filter((m) => m.id !== id));
      setChatNote('已忽略一条记忆。');
    } catch (e) {
      setChatNote(`忽略失败：${(e as Error).message}`);
    }
  };
  const confirmAllPending = async () => {
    const sess = sessionRef.current;
    if (!sess || pendingMem.length === 0) return;
    try {
      await authFetchJson('/memories/confirm', {
        method: 'POST',
        body: JSON.stringify({ all: true }),
        headers: { authorization: `Bearer ${sess.token}` },
      });
      setPendingMem([]);
      void loadUserMemory();
      if (curAgentRef.current !== null) void loadProjectMemory(curAgentRef.current);
      setChatNote(`已确认全部 ${pendingMem.length} 条记忆。`);
    } catch (e) {
      setChatNote(`批量确认失败：${(e as Error).message}`);
    }
  };
  const rejectAllPending = async () => {
    const sess = sessionRef.current;
    if (!sess || pendingMem.length === 0) return;
    try {
      await authFetchJson('/memories/reject', {
        method: 'POST',
        body: JSON.stringify({ all: true }),
        headers: { authorization: `Bearer ${sess.token}` },
      });
      setPendingMem([]);
      setChatNote(`已忽略全部 ${pendingMem.length} 条待确认记忆。`);
    } catch (e) {
      setChatNote(`批量忽略失败：${(e as Error).message}`);
    }
  };

  /** 第 8 步：任务快照（状态/未读/结果）——红点的唯一事实源。
   *  用 ref 拿会话：agent 订阅 effect 是挂载时建的闭包，直接引用 session 会拿到旧的 null。 */
  const sessionRef = useRef<AuthSession | null>(null);
  sessionRef.current = session;

  // ---- 第 11 步：资料上传/列表。文件直接由当前渲染进程 POST 到本机服务端，
  // 不经过 preload，不开新窗口；multipart 的 Content-Type 必须让浏览器自己带 boundary。 ----
  /**
   * 子阶段 2-B：资料列表**按项目**拉（`?projectId=`）。
   * 不传就走服务端的「当前使用中的项目」——两条路都以服务端为准，前端不自己过滤。
   */
  const loadKnowledge = async (projectId?: number | null) => {
    const sess = sessionRef.current;
    if (!sess) return;
    const pid = projectId === undefined ? curProjectRef.current : projectId;
    try {
      const r = await authFetchJson<KnowledgeListResult>(pid === null ? '/knowledge' : `/knowledge?projectId=${pid}`, {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      // 切号期间晚到的 A 号响应不能覆盖 B 号列表。
      if (sessionRef.current?.token !== sess.token) return;
      setKnowledgeDocs(r.documents);
    } catch {
      /* 资料列表属于辅助入口，后端暂不可达时不打扰已登录界面 */
    }
  };
  const uploadKnowledgeFile = async (file: File) => {
    const sess = sessionRef.current;
    if (!sess || knowledgeUploading) return;
    const supported = /\.(txt|md|pdf)$/i.test(file.name);
    if (!supported) {
      setKnowledgeNote('只支持 .txt、.md、.pdf 文件。');
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      setKnowledgeNote('文件超过 12 MB，本版请拆分后上传。');
      return;
    }
    setKnowledgeNote('');
    setKnowledgeUploading(true);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      let res: Response;
      try {
        res = await fetch(`${API_BASE()}/knowledge/upload`, {
          method: 'POST',
          headers: { authorization: `Bearer ${sess.token}` },
          body: form,
        });
      } catch {
        throw new Error(`连不上后端 ${API_BASE()}：先双击仓库根目录的 start-dev.cmd 起库和服务端，再重试`);
      }
      const data = (await res.json().catch(() => ({}))) as KnowledgeUploadResult & { error?: string };
      if (!res.ok) throw new Error(dbHint(data.error) ?? `HTTP ${res.status}`);
      // 若用户在上传过程中退出/切换账号，不把旧账号的成功提示带到新账号界面。
      if (sessionRef.current?.token !== sess.token) return;
      const doc = data.document;
      setKnowledgeNote(`《${doc.filename}》已入库，共 ${doc.chunkCount} 个片段。`);
      await loadKnowledge(curProjectRef.current);
    } catch (e) {
      setKnowledgeNote(`上传没有入库：${(e as Error).message}`);
    } finally {
      setKnowledgeUploading(false);
    }
  };
  const onChooseKnowledgeFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    // 清空值后，用户选择同一份文件也会再次触发 change。
    event.currentTarget.value = '';
    if (file) void uploadKnowledgeFile(file);
  };

  /**
   * 第 19 步：删掉当前账号的一条资料（服务端连它的切块一起删）。
   *
   * 一点就删、只回一句人话 —— 不做二次确认弹窗，也不做回收站/重命名（本步明确不做）。
   * 删除权限完全由服务端的 JWT 决定：这里只传资料 id，删不到别人的资料（会得到 404）。
   * 本地列表用「过滤掉这条」而不是整表重拉，避免删完闪烁；刷新页面时以服务端为准。
   */
  const deleteKnowledgeDoc = async (doc: KnowledgeDocument) => {
    const sess = sessionRef.current;
    if (!sess || knowledgeDeletingId !== null) return;
    setKnowledgeNote('');
    setKnowledgeDeletingId(doc.id);
    try {
      const r = await authFetchJson<KnowledgeDeleteResult>(`/knowledge/${doc.id}`, {
        method: 'DELETE',
        // 空 body 会被 fastify 判 400，这里明确送一个 JSON 空对象。
        body: '{}',
        headers: { authorization: `Bearer ${sess.token}` },
      });
      // 删除期间切了账号：不要拿 A 号的结果去动 B 号的列表/提示。
      if (sessionRef.current?.token !== sess.token) return;
      setKnowledgeDocs((prev) => prev.filter((d) => d.id !== doc.id));
      setKnowledgeNote(`《${doc.filename}》已删除${r.removedChunks ? `（连同 ${r.removedChunks} 个片段）` : ''}。`);
    } catch (e) {
      if (sessionRef.current?.token !== sess.token) return;
      setKnowledgeNote(`删除失败：${(e as Error).message}`);
      void loadKnowledge(curProjectRef.current); // 服务端说没有这份资料时，用真实列表把界面拉回来
    } finally {
      setKnowledgeDeletingId(null);
    }
  };

  const refreshTask = async () => {
    const sess = sessionRef.current;
    if (!sess) return;
    try {
      const r = await authFetchJson<{ task: CurrentTask | null }>('/agent/task/current', {
        headers: { authorization: `Bearer ${sess.token}` },
      });
      if (r.task) {
        setCurTask(r.task);
        setHasUnread(r.task.status === 'done' && r.task.unread);
      }
    } catch {
      /* 后端/库没起时红点保持原样，不打扰 */
    }
  };

  /** 看完结果 → 服务端标记已读、红点熄灭 */
  const openTaskResult = async () => {
    if (!curTask) return;
    setTaskDetailOpen(true);
    if (curTask.unread) {
      const sess = sessionRef.current;
      try {
        await authFetchJson('/agent/task/read', {
          method: 'POST',
          body: JSON.stringify({ taskId: curTask.id }),
          headers: { authorization: `Bearer ${sess?.token ?? ''}` },
        });
        setCurTask({ ...curTask, unread: false });
        setHasUnread(false);
      } catch {
        /* 标已读失败就留着红点，下次再点 */
      }
    }
  };

  /** 下载 .md：主进程弹“另存为”+写盘，内容经脱敏兜底 */
  const downloadTaskDoc = async () => {
    if (!curTask || !session) return;
    setDocNote('正在准备文档…');
    const r = await window.workbench?.downloadDoc(curTask.id, API_BASE());
    if (!r) return;
    if (r.saved) setDocNote(`已保存：${r.path}`);
    else if (r.canceled) setDocNote('已取消保存');
    else setDocNote(`下载失败：${r.error ?? '未知原因'}`);
  };

  /**
   * 会话变了：把**所有**智能体的聊天缓存清掉，重新拉智能体列表 / 用户记忆库 / 任务快照 / 资料列表。
   * 具体某个智能体的历史由 loadAgents → loadAgentHistory 拉（一个智能体一份聊天，互不干扰）。
   */
  useEffect(() => {
    setChats({});
    setCurAgentId(null);
    curAgentRef.current = null;
    historyLoadedRef.current = new Set();
    setAgents([]);
    setAgentNote('');
    setUserMem([]);
    setProjMem([]);
    setPendingMem([]);
    setProjects([]);
    curProjectRef.current = null;
    // Phase 3：换号了就把「agentId → projectId」清掉（id 会跨账号复用，留着会把分区认错人）
    agentProjectRef.current.clear();
    setCurProjectId(null);
    setProjectsOpen(false);
    setNewProjectName('');
    setProjectNote('');
    if (!session) return;
    void refreshTask();
    void loadUserMemory();
    /**
     * 子阶段 2-B：顺序不能反 —— **先**拿到「当前使用中的项目」，再按它拉智能体名单与资料列表。
     * 反过来的话首帧会打一次不带 projectId 的 `/agents`（= 老语义：这个账号的全部智能体），
     * 界面上就会闪一下别的项目的智能体。
     */
    void (async () => {
      const pid = await loadProjects();
      await Promise.all([loadAgents(pid), loadKnowledge(pid)]);
    })();
  }, [session]);

  const onSubmitPassword = async () => {
    if (!session) return;
    setPwMsg('');
    try {
      const body: Record<string, string> = { new_password: pwNew };
      if (session.user.has_password) body.old_password = pwOld;
      const r = await authFetchJson<{ ok: boolean; message: string }>('/auth/password/set', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { authorization: `Bearer ${session.token}` },
      });
      setPwMsg(r.message);
      setPwOld('');
      setPwNew('');
      setSession((s) => (s ? { ...s, user: { ...s.user, has_password: true } } : s));
    } catch (e) {
      setPwMsg((e as Error).message);
    }
  };

  const onLogout = () => {
    localStorage.removeItem(TOKEN_KEY);
    // ★ 登出 → 把主进程那份凭证也清掉（它是内存里的，不主动清就得等进程退出）
    void window.workbench?.syncSession?.(API_BASE(), '');
    /**
     * ★ 登出 → 分区闸的项目集合也要清空。
     * 不清的话下一位登录者会**继承上一位的项目白名单**，分区闸就等于没装。
     */
    void window.workbench?.syncProjects?.([]);
    setSession(null);
    setPwMsg('');
    // 第 6 步：聊天痕迹也清掉（历史本来就在服务端，重启登录后由 /chat/history 还原）
    setChatNote('');
    setStreamText('');
    // 第 15 步：所有智能体的聊天、列表、两层记忆全部清掉（会话 effect 也会兜一遍）
    setChats({});
    setCurAgentId(null);
    curAgentRef.current = null;
    historyLoadedRef.current = new Set();
    setAgents([]);
    setAgentNote('');
    setUserMem([]);
    setUserMemOpen(false);
    setProjMem([]);
    setProjMemOpen(false);
    setPendingMem([]);
    setPendingMemOpen(false);
    // 子阶段 2-B：项目层也清掉（换号不该看见上一个号的项目名/名单）
    setProjects([]);
    curProjectRef.current = null;
    setCurProjectId(null);
    setProjectsOpen(false);
    setNewProjectName('');
    setProjectNote('');
    setProjectBusy(false);
    setAgentStates({}); // 第 16 步：会话状态（当前任务/保活）不留在登录页
    setKeepaliveBusy(false);
    // 第 7 步：驾驶员循环和 token 一并停掉/清掉（主进程里也不留）
    void window.workbench?.agentStop();
    // 第 18 步：所有网页一并关掉（换号不该看见上一个号的网页）——由浏览器工作区自己清
    browser.closeAllTabs();
    setAgentSteps([]);
    setAgentDoc(null);
    setCurTask(null);
    setTaskDetailOpen(false);
    setDocNote('');
    setHasUnread(false);
    setAgentAwaitInfo(false);
    setAgentAwaitAgent(null);
    setKnowledgeDocs([]);
    setKnowledgeOpen(false);
    setKnowledgeUploading(false);
    setKnowledgeDeletingId(null);
    setKnowledgeNote('');
  };

  // ---- 第 18 步：中栏浏览器工作区（第 20 步起：**每个智能体一套独立浏览器**，无活页上限）----
  /**
   * 浏览器相关的**全部状态与动作**都在 apps/desktop/src/browser/ 里，这里只把它挂上：
   *   - 按智能体分桶的 tab 状态、开页/关页、同站复用、驾驶接口 → browser/useBrowserWorkspace.ts
   *   - URL 栏 / webview 宿主 / 桌面侧协议闸 → browser/BrowserPanel.tsx、browser/url.ts
   *   - 「打开百度」→ URL、「在这张页面上做事」/「停」→ browser/sites.ts、browser/intent.ts
   *
   * currentAgentId 是**响应式**的：切智能体就换「哪一桶可见」（页本身一张都不卸载，
   * 所以切回来页面和滚动都还在，原来在跑的那几路也不会断）。
   * onNote 是它唯一往聊天里说话的通道：**只有「关页 / 页开太多」才说一句**，
   * 开页成功一个字都不写（看顶栏多出来的那个 tab 就是结果）。
   * getCurrentAgent 让主进程发来的「打开某网址」落给此刻正在聊的那个智能体。
   */
  const browser = useBrowserWorkspace({
    onNote: setChatNote,
    currentAgentId: curAgentId,
    getCurrentAgent: () => curAgentRef.current,
    // 第 22 步 · D：多实例上限由主进程的配置说了算（改配置立刻生效，不用重建 hook）
    getMaxInstances: () => settingsRef.current.maxBrowserInstances,
    /**
     * Phase 3：**这个智能体属于哪个项目** —— 只用来算这张页的分区（登录态粒度）。
     * 桶键（标签页归属）仍然是 agentId，不经过这里，所以「同项目共享登录态」不会
     * 顺带把标签页也合并了。查不到就返回 null（落兜底分区，不跟任何真项目混）。
     */
    getProjectOfAgent: (agentId: number) => agentProjectRef.current.get(agentId) ?? null,
  });

  /**
   * Phase 4：资源守护者（持续资源监控）。
   *
   * 采集与判定全在主进程（那边才有 app.getAppMetrics 与 lanes 的权威视图），
   * 这边只做两件事：把**浏览器实例清单 + 最后使用时间**报上去（「最久未使用」排序要用），
   * 以及收到警戒提示时**复用既有的单行人话通道**说一句 —— 本阶段不新增任何 UI 元素与样式。
   *
   * 红线照旧：它不关任何页、不限开页、不插进驾驶循环；关掉它（配置 resourceGuardEnabled=0）
   * 也只是不再采集与提示，浏览器行为一模一样。
   */
  const resources = useResourceGuard({
    ws: browser,
    onAlert: (alert) => setChatNote(alert.text),
  });

  /**
   * 配置一变（阈值 / 采集频率 / 开关）就把快照重拉一次。
   *
   * 主进程那边本来就按新配置在算，这里只是让**读出来的那份视图**跟上 ——
   * 否则界面上还挂着旧阈值，看着像"改了没用"。本阶段没有资源相关的 UI，
   * 这一步是为 UI 阶段准备的（也让验收里"改阈值立刻生效"这件事有据可查）。
   */
  useEffect(() => {
    void resources.refresh();
  }, [settings, resources.refresh]);

  useEffect(() => {
    const bridge = window.workbench;

    if (!bridge) {
      setBridgeInfo('未检测到 preload 桥');
      return;
    }

    bridge
      .ping()
      .then((reply) => setBridgeInfo(`${bridge.platform} · ${reply}`))
      .catch(() => setBridgeInfo('preload 桥调用失败'));
  }, []);

  // 订阅主进程转发过来的 UI 指令（open / show / hide / focus / state）
  useEffect(() => {
    const bridge = window.workbench;
    if (!bridge) return;

    // 第 4 步：状态机镜像 = 初始拉取一次 + 订阅广播（主进程是权威，这里只跟随）
    bridge
      .getTaskState()
      .then(setTask)
      .catch(() => setTask((s) => ({ ...s, detail: '读取主进程状态失败（preload 桥异常）' })));
    const offState = bridge.on('state', (payload) => {
      if (!payload) return;
      try {
        setTask(JSON.parse(payload) as TaskState);
      } catch {
        /* 坏负载忽略，等下一次广播 */
      }
    });

    // 第 22 步：可调配置同样「初始拉一次 + 跟随广播」，主进程是权威
    bridge
      .getSettings()
      .then((s) => setSettings(s))
      .catch(() => undefined); // 拉不到就先用兜底值，不打断界面
    const offSettings = bridge.on('settings', (payload) => {
      if (!payload) return;
      try {
        setSettings(JSON.parse(payload) as WorkbenchSettings);
      } catch {
        /* 坏负载忽略，等下一次广播 */
      }
    });

    // 第 18 步：主进程的浏览器指令交给**浏览器工作区**处理（它才知道 tab 的事）。
    // 'open' 开/复用一张页；'focus'（敏感字段等待时会发）确保那张页存在并把焦点给它。
    // 'show' / 'hide' 不再有对应界面（网页始终在中栏工作区里），保留订阅只是不炸。
    const offOpen = bridge.on('open', (url) => {
      if (url) browser.openFromMain(url);
    });
    /**
     * ★ 第 23 步：内嵌页里点 `target=_blank` / `window.open` → **真开一条 tab**。
     *
     * 老行为是主进程让同一个 guest 导航，渲染层的 tabs 数组不会新增，
     * 用户看到「点了标题没反应 / 没开新 tab」（截图里 AI 自己说「能真的打开了新标签，
     * 只是工作台没切换」就是这个）。现在由渲染层开一条新 tab —— 与点「＋」同一条路。
     *
     * agentId 由主进程按「哪张 guest 触发的」查出，落回**那个智能体**的桶，
     * 绝不用「此刻正在聊的那个」——否则 A 的页里点出来的 tab 会跑到 B 名下。
     */
    const offOpenTab = bridge.on('opentab', (payload) => {
      if (!payload) return;
      try {
        const req = JSON.parse(payload) as OpenTabRequest;
        if (req?.url) browser.openFromPage(req.url, req.agentId);
      } catch {
        /* 坏负载忽略 */
      }
    });
    const offShow = bridge.on('show', () => undefined);
    const offHide = bridge.on('hide', () => undefined);
    // 第 17 步：主进程发来的 focus 带 guest id —— 焦点要给**那一张**页（多路并行时不能瞎给）
    const offFocus = bridge.on('focus', (payload) => {
      const wcId = Number(payload);
      if (Number.isInteger(wcId)) browser.focusByWebContents(wcId);
      else browser.focusActive();
    });

    return () => {
      offOpen();
      offOpenTab();
      offShow();
      offHide();
      offFocus();
      offState();
      offSettings();
    };
  }, []);

  // 订阅主进程驾驶员事件：ask/done/note 进聊天区
  useEffect(() => {
    const bridge = window.workbench;
    if (!bridge) return;
    let off = false;
    const offAgent = bridge.on('agent', (payload) => {
      if (!payload) return;
      let p: AgentEventPayload & { wcId?: number };
      try {
        p = JSON.parse(payload) as AgentEventPayload & { wcId?: number };
      } catch {
        return;
      }
      if (off) return;
      /**
       * 第 17 步：事件里带着 guest id —— 先认它属于**哪张页**、那张页是**哪个智能体**开的，
       * 再把话落回那个智能体的聊天里。两路分属两个智能体时，绝不把 A 的步摘要写进 B。
       */
      const tabId = typeof p.wcId === 'number' ? browser.tabIdOfWebContents(p.wcId) : null;
      // Phase 4：主进程报事件 = 这张页刚被驾驶员推进一步 = 它刚被用过
      //（「最久未使用」排序靠这条；正在跑任务的实例因此不会被排到最前面去挨关）
      if (tabId !== null) browser.touchTab(tabId);
      const ownerAgent = (tabId !== null ? browser.ownerOf(tabId) : undefined) ?? curAgentRef.current;
      const say = (text: string) => {
        if (ownerAgent !== null && ownerAgent !== undefined) pushChatLineFor(ownerAgent, text);
      };
      const here = ownerAgent === curAgentRef.current;
      if (p.kind === 'step') {
        setAgentSteps((prev) => prev.concat(`${p.summary}${p.ok ? '' : ' ❌'}`).slice(-6));
      } else if (p.kind === 'ask') {
        setAgentSteps([]);
        say(`⚠️ ${p.question}`);
        const needInfo = p.reason === 'need_info';
        setAgentAwaitInfo(needInfo);
        // 第 15 步：记下「是哪个智能体在等这句话」，答复才不会串到别的智能体
        setAgentAwaitAgent(needInfo ? (ownerAgent ?? null) : null);
        // 第 17 步：再记下「是哪张页在等」，答复只喂给那一路
        setAgentAwaitWcId(needInfo && typeof p.wcId === 'number' ? p.wcId : null);
        if (needInfo && here) setChatNote('小助在等你答这句话——直接在下面输入框回答即可，发出后会自动继续（不用点「继续」）。');
        /**
         * ★ 步数上限（step_budget）：记成「等你说继续」。
         *
         * 这一步之前缺的就是这一行 —— 上面三行只在 `need_info` 时置等待态，
         * 于是步数上限停下来时界面只多了一句 ⚠️ 文本，系统**没有任何地方记得**
         * 「这张页正停在半路、下一句『继续』是要接回它」。
         * 后果：用户说「继续」掉进普通聊天，AI 只能嘴上答应。
         *
         * 只记**哪一个智能体 + 哪一张页**，和 need_info 同一套口径，不会串到别路。
         */
        if (p.reason === 'step_budget' && typeof p.wcId === 'number') {
          setAwaitResume(true);
          setAwaitResumeAgent(ownerAgent ?? null);
          setAwaitResumeWc(p.wcId);
        }
        void browser.refreshDriving();
      } else if (p.kind === 'sensitive') {
        say(`🔒 ${p.message}`);
        void browser.refreshDriving();
      } else if (p.kind === 'help') {
        /**
         * 第 27 步 · **AI 主动求助** —— 在聊天流里长出那张卡片。
         *
         * 判定（保守触发闸）已经在主进程做完了，这里只负责"呈现"：
         *   ① 把卡片挂到**触发它的那个智能体**名下（聊天只画当前智能体的，不跨对话提醒）；
         *   ② 如果那张页正属于当前会话，**自动切到求助卡视图** ——
         *      用户很可能正开着全屏浏览器，不切的话卡片弹了也被盖住、根本看不见。
         *
         * ★ 注意这里**没有任何"把焦点给页面"的动作**：不聚焦、不滚动到输入框、不带值。
         *   用户自己在那块真实页面上操作，AI 只负责"把页面递到眼前 + 说明白"。
         */
        if (typeof p.wcId === 'number' && ownerAgent !== null && ownerAgent !== undefined) {
          setHelpCards((prev) => ({
            ...prev,
            [ownerAgent]: {
              wcId: p.wcId as number,
              agentId: ownerAgent,
              helpKind: p.helpKind,
              question: p.question,
              hint: p.hint,
            },
          }));
          browser.enterEmbed(p.wcId);
        }
        void browser.refreshDriving();
      } else if (p.kind === 'help-clear') {
        // 求助已解除（自动感知到页面变化 / 用户点了按钮 / 任务收尾）→ 收卡片 + 退出该视图
        if (ownerAgent !== null && ownerAgent !== undefined) {
          setHelpCards((prev) => {
            if (!(ownerAgent in prev)) return prev;
            const next = { ...prev };
            delete next[ownerAgent];
            return next;
          });
        }
        setEmbedRect(null);
        browser.exitEmbed();
        void browser.refreshDriving();
      } else if (p.kind === 'loop-gone') {
        /**
         * ★ P0 止血（2026-09-21）：**这一轮的上下文没了** —— 弹一张要用户拍板的卡。
         *
         * 主进程在 `/agent/loop/resume` 拿到 `code:'loop_gone'` 时**不会**自动重开，
         * 只把这句问话送过来；「重新开始 / 算了」两颗按钮由用户点，
         * 决定通过 `loopGoneChoice` 回主进程。
         *
         * ★ 为什么必须问：历史归零后模型不知道自己做过什么，从头再来意味着
         *   前面已经做过的动作**可能**被再做一遍 —— 这个代价只能由用户承担。
         *
         * ★ 这里同样**不碰页面**：不聚焦、不代点，与求助卡同一条安全红线。
         */
        setLoopGone(
          typeof p.wcId === 'number'
            ? { wcId: p.wcId as number, question: p.question }
            : null,
        );
        void browser.refreshDriving();
      } else if (p.kind === 'done') {
        setAgentAwaitInfo(false);
        setAgentAwaitAgent(null);
        setAgentAwaitWcId(null);
        // 第 27 步：任务收尾了，求助卡就没有存在意义了（留着会是一张点不动的卡）
        if (ownerAgent !== null && ownerAgent !== undefined) {
          setHelpCards((prev) => {
            if (!(ownerAgent in prev)) return prev;
            const next = { ...prev };
            delete next[ownerAgent];
            return next;
          });
        }
        setEmbedRect(null);
        browser.exitEmbed();
        // 任务已经收尾：不再等「继续」（否则下一条「继续」会去 resume 一条已经 done 的循环）
        setAwaitResume(false);
        setAwaitResumeAgent(null);
        setAwaitResumeWc(null);
        say(`✅ 任务完成：${p.summary}${p.docReady ? ` · ${p.unreadHint ?? '结果文档已生成'}` : '（文档未就绪：后端未配置模型或库未起，见后端日志）'}`);
        setAgentDoc({ title: p.documentTitle, outline: p.documentOutline });
        // 第 8 步：红点由服务端确认（finish 已置 unread=true），这里点亮并刷新卡片
        setHasUnread(true);
        void refreshTask();
        void browser.refreshDriving();
      } else if (p.kind === 'note') {
        say(`${p.level === 'error' ? '⚠️' : 'ℹ️'} ${p.text}`);
        if (/继续|恢复驾驶/.test(p.text)) {
          setAgentAwaitInfo(false);
          setAgentAwaitAgent(null);
          setAgentAwaitWcId(null);
        }
        if (p.level === 'error') void browser.refreshDriving();
      }
      /**
       * 第 17 步：循环收尾时主进程是「**先把事件发出来、再从运行表里摘掉这一路**」，
       * 所以收到事件这一刻 agentLanes() 往往还看得到它 —— 标签上那个「● 正在驾驶」
       * 就会一直亮着（明明已经没有一路在跑了）。
       * 隔一拍再刷一次，圆点才会跟着灭。step 事件太频繁，不参与这次补刷。
       */
      if (p.kind !== 'step') {
        window.setTimeout(() => {
          void browser.refreshDriving();
        }, 1200);
      }
    });
    return () => {
      off = true;
      offAgent();
    };
    // pushChatLine/setMessages 都是稳定 setState，无需入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  /**
   * 第 6 步：发送 = 走 /chat/stream（带 JWT，fetch 读 SSE；EventSource 加不了 Authorization 所以不用它）。
   * 第 4 步规矩保留：running 时先让主进程暂停（权威横幅由 'state' 广播改回「你正在控制」），聊天照发。
   */
  const sendChat = async () => {
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
       */
      if (pendingDrive() && !sawLoop) launch();
      if (acc) {
        patchChat(myAgent, (c) => ({
          ...c,
          messages: c.messages.concat({
            id: Date.now() + 1,
            role: 'assistant',
            text: acc,
            /** 第 26 步：来源跟着这条回复走，渲染在气泡下方（没搜过就是 undefined） */
            sources: sawSources.length > 0 ? sawSources : undefined,
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
      void loadAgentState(myAgent);
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

  // ---- 阶段简报 · 方案 B：临时测试条（暂停 / 继续）----------------------------
  /**
   * 为什么要有这条：**正式的暂停/继续 UI 不在本阶段做**（右栏驾驶台已经在 UI-1.6
   * 回滚里整块撤掉了，源码里没有任何可点的入口），但方案 B 的核心体验是
   * 「点暂停 → 自己到浏览器里手动操作 → 点继续 → AI 重新感知、不覆盖你刚才的动作」——
   * 没有可点的按钮，这条链就亲手验不了。
   *
   * 所以这里只补一条**最小临时条**：两个按钮直接走主进程已有的 per-target IPC
   * （`workbench:task:pause` / `:resume`，点名当前这张页的 wcId），
   * 因此「暂停这一路」不会碰到别的页、也不会碰到别的智能体。
   */
  const [driveBar, setDriveBar] = useState<TaskState | null>(null);
  const [driveNote, setDriveNote] = useState('');

  // ---- ★ P0 止血（2026-09-21）·「这一轮的上下文没了」确认卡 ------------------
  /**
   * 主进程在 `/agent/loop/resume` 拿到 `code:'loop_gone'` 时**不会**自动重开，
   * 只把一句问话送过来；这里那张卡就是用户拍板的唯一入口。
   *
   * ★ 一次只可能有一张（按 wcId 记），点完就清空 —— 绝不留一张点不动的卡。
   */
  const [loopGone, setLoopGone] = useState<{ wcId: number; question: string } | null>(null);
  /** 点两颗按钮中的任意一颗：把决定送回主进程，然后收卡 */
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
   * 第 27 步：求助卡的两个按钮。
   *
   * ★ 两个动作**都走主进程既有的通道**，不新开机制：
   *   · 「我处理好了，继续」= `resumeTask`（就是「继续」按钮那条路：
   *     读当前真实页面 → 服务端算 delta → 同一条历史原地接上）；
   *   · 「不用了，停手」= `agentDrop`（就是「停」那条路）。
   */
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

  const helpCardAct = async (kind: 'done' | 'stop', wcId: number) => {
    try {
      if (kind === 'done') {
        await window.workbench?.resumeTask?.(wcId);
      } else {
        await window.workbench?.agentDrop?.(wcId);
      }
    } catch (e) {
      setChatNote(`没成功：${e instanceof Error ? e.message : String(e)}`);
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
  /** 当前切到前面的那张页（tabId）——切页就换一路，测试条跟着换 */
  const activeTabId = browser.active?.id ?? null;

  useEffect(() => {
    if (activeTabId === null) {
      setDriveBar(null);
      return;
    }
    let off = false;
    const tick = async () => {
      const wcId = browser.webContentsIdOf(activeTabId);
      if (typeof wcId !== 'number') return;
      try {
        const st = await window.workbench?.getTaskState?.(wcId);
        if (!off && st) setDriveBar(st);
      } catch {
        /* 读不到就保留上一次的显示，不打断用户操作 */
      }
    };
    void tick();
    // 1.2s 轮询：只为了让人肉眼看到相位在变（idle → running → paused），
    // 真正的暂停/继续是由按钮触发的主进程动作，不依赖这个轮询。
    const timer = window.setInterval(() => void tick(), 1200);
    return () => {
      off = true;
      window.clearInterval(timer);
    };
    // 只认「当前这张页」：切页就重新起一轮
  }, [activeTabId]);

  /** 临时测试条的两个动作：都点名当前这张页的 wcId */
  const driveBarAct = async (kind: 'pause' | 'resume') => {
    const tabId = browser.active?.id;
    if (typeof tabId !== 'number') {
      setDriveNote('还没有打开的网页——先让 AI 开一张页再点。');
      return;
    }
    const wcId = await browser.awaitWebContentsId(tabId);
    if (typeof wcId !== 'number') {
      setDriveNote('这张页还没准备好（拿不到内嵌页句柄）。');
      return;
    }
    try {
      const st =
        kind === 'pause'
          ? await window.workbench?.pauseTask(wcId)
          : await window.workbench?.resumeTask(wcId);
      if (st) setDriveBar(st);
      setDriveNote(
        kind === 'pause'
          ? `已暂停（wcId ${wcId}）：现在你可以在这张页里自己点、自己跳转，AI 不会再动一下。改完点「继续」。`
          : `已继续（wcId ${wcId}）：AI 会先重新读一遍**当前**这张页再接着干，不会重放暂停前的旧动作。`,
      );
    } catch (e) {
      setDriveNote(`没成功：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // 第 5 步门控：未登录（或正在用存好的 JWT 换会话）时，工作台整体不渲染——不做“游客看假数据”
  if (checkingAuth) {
    return (
      <div className="authWrap">
        <div className="authCard">
          <h3>正在恢复登录状态…</h3>
        </div>
      </div>
    );
  }
  if (!session) {
    return <AuthScreen onSession={setSession} />;
  }

  /**
   * 左栏要显示的智能体列表。
   * 正常情况以服务端 /agents 为准；刚登录还没拉回来时先用登录响应里的 agents 顶上，
   * 免得首屏左栏是空的（那种「点了没反应」的错觉最难查）。
   */
  // 已经进了某个项目就不再拿登录响应兜底 —— 否则会拿登录时那份（默认项目的）名单冒充当前项目。
  const loginAgentsFallback: AgentView[] = (session.agents ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    kind: 'assistant',
    deletable: false,
    personaStatus: 'ready' as const,
    persona: null,
    conversationId: null,
  }));
  const sidebarAgents: AgentView[] = agents.length > 0 ? agents : curProjectId !== null ? [] : loginAgentsFallback;
  const curAgent = sidebarAgents.find((a) => a.id === curAgentId) ?? null;
  /** 第 16 步：当前智能体的会话状态（服务端为准）——状态行与保活按钮都读它 */
  const curState = curAgentId === null ? undefined : agentStates[curAgentId];
  /**
   * 当前智能体这一轮用户原话**本身**就是确认（明确开页指令，或对确认提问回了「继续/可以」）。
   * 是的话就不再挂确认按钮——事情已经在做了，再要确认就是自相矛盾（第 13 步的规矩）。
   */
  const curConfirmed = curAgentId !== null && Boolean(lastUserWasOpenRef.current[curAgentId]);

  return (
    <div className="app">
      {/*
        左侧：**智能体列表**（自带「小助」+ 用户点「添加」建的）。
        第 15 步起这里不再是一个写死的联系人——一个智能体一行，点一行就换一份聊天。
        「＋ 添加」不弹独立设置窗、不开新 BrowserWindow：服务端建好智能体 + 空会话，直接切过去。
      */}
      <aside className="sidebar">
        {/*
          子阶段 2-B：**最简项目入口**（看得见全部项目 / 新建 / 点一下切换当前项目）。

          刻意不做下拉动效、双击切换、全屏小圆圈那套正式交互 —— 那些留给后面独立的 UI 阶段；
          这里只在功能上把「项目层」跑通，用既有的 .contact / .btn / .authInput 拼出来，不加新视觉。
          切换只换「看不见的项目视角 + 名单 + 资料列表」，**浏览器一张页都不动**（见 enterProject）。
        */}
        <div className="projectBox">
          <div className="small projectBox__cur">
            当前项目：{projects.find((p) => p.id === curProjectId)?.name ?? '（还没读到）'}
          </div>
          <div className="buttons-row">
            <button
              type="button"
              className="btn projectBox__toggle"
              disabled={projectBusy}
              onClick={() => setProjectsOpen((v) => !v)}
            >
              {projectsOpen ? '收起项目' : `切换项目（${projects.length}）`}
            </button>
          </div>
          {projectsOpen && (
            <div className="projectBox__list" role="list" aria-label="我的项目">
              {projects.map((p) => (
                <button
                  type="button"
                  role="listitem"
                  key={p.id}
                  data-project-id={p.id}
                  disabled={projectBusy}
                  className={p.id === curProjectId ? 'contact projectBox__row contact--on' : 'contact projectBox__row'}
                  onClick={() => void switchProject(p.id)}
                >
                  <div className="contact__meta">
                    <div className="contact__name">{p.name}</div>
                    <div className="small">
                      {p.id === curProjectId ? '使用中' : '点击切到这里'}
                      {p.henAgentId ? ' · 有母鸡' : ' · 默认项目'}
                    </div>
                  </div>
                </button>
              ))}
              <input
                className="authInput projectBox__name"
                placeholder="新项目名字（≤24 字）"
                value={newProjectName}
                maxLength={24}
                onChange={(e) => setNewProjectName(e.target.value)}
              />
              <div className="buttons-row">
                <button
                  type="button"
                  className="btn projectBox__create"
                  disabled={projectBusy || !newProjectName.trim()}
                  onClick={() => void createProject()}
                >
                  {projectBusy ? '处理中…' : '新建项目'}
                </button>
              </div>
            </div>
          )}
          {projectNote && <div className="small projectBox__note">{projectNote}</div>}
        </div>

        <div className="agentList" role="list" aria-label="我的智能体">
          {sidebarAgents.map((a) => (
            <button
              type="button"
              role="listitem"
              key={a.id}
              data-agent-id={a.id}
              className={a.id === curAgentId ? 'contact contact--on' : 'contact'}
              onClick={() => selectAgent(a)}
            >
              <div className="avatar">
                <span className="avatar__face" aria-hidden="true">
                  {agentGlyph(a)}
                </span>
                {a.kind === 'assistant' && hasUnread && (
                  <span className="red-dot" title={curTask?.unreadHint || '任务结果待查看'} />
                )}
              </div>
              <div className="contact__meta">
                <div className="contact__name">{a.name}</div>
                <div className="small">
                  {a.kind === 'assistant' ? '在线' : a.personaStatus === 'pending' ? '等你填引导表' : '已就位'}
                </div>
              </div>
            </button>
          ))}
          <button type="button" className="btn agentList__add" disabled={agentBusy} onClick={() => void addAgent()}>
            {agentBusy ? '添加中…' : '＋ 添加'}
          </button>
          {/* 自建智能体可以删（「小助」是自带的，服务端也会拒）；它自己的聊天与项目记忆一并清掉 */}
          {curAgent && curAgent.deletable && (
            <button type="button" className="btn agentList__del" onClick={() => void deleteAgent(curAgent.id)}>
              删掉「{curAgent.name}」
            </button>
          )}
          {agentNote && <div className="small agentList__note">{agentNote}</div>}
        </div>

        {/*
          第 16 步「启动并保活」最小闭环：
          只把这个智能体的会话标成监听态（仍在这一个窗口里，不新开窗口、不起新进程）。
          空闲时服务端一次模型都不调——有新消息才走 /chat/stream。
        */}
        {curAgent && (
          <div className="keepalive">
            <button type="button" className="btn keepalive__btn" disabled={keepaliveBusy} onClick={() => void toggleKeepalive()}>
              {keepaliveBusy ? '切换中…' : curState?.keepalive ? '停止保活' : '启动并保活'}
            </button>
            <div className="small">
              {curState?.keepalive
                ? `「${curAgent.name}」监听中：空闲不调模型，来消息才处理`
                : '未保活：只在你说一句话时才处理'}
            </div>
          </div>
        )}

        {/* 第 5 步：我的账号（XYZ 对外号 + 设置/修改密码；退出回登录页） */}
        <div className="account">
          <div className="small">我的号：{session.user.xyz_id}{session.user.phone_masked ? ` · ${session.user.phone_masked}` : ''}</div>
          <div className="small">{session.user.has_password ? '密码：已设置' : '密码：未设置（XYZ+密码登录会明确失败）'}</div>
          {session.user.has_password && (
            <input className="authInput" type="password" placeholder="原密码" value={pwOld} onChange={(e) => setPwOld(e.target.value)} />
          )}
          <input className="authInput" type="password" placeholder="新密码（≥8 位）" value={pwNew} onChange={(e) => setPwNew(e.target.value)} />
          <div className="buttons-row">
            <button className="btn" type="button" disabled={pwNew.length < 8} onClick={() => void onSubmitPassword()}>
              {session.user.has_password ? '修改密码' : '设置密码'}
            </button>
            <button className="btn" type="button" onClick={onLogout}>
              退出登录
            </button>
          </div>
          {pwMsg && <div className="small">{pwMsg}</div>}
          {/*
            第 22 步：浏览器可调配置（A1.5 的并发数 / D 的多实例上限）。
            不弹独立设置窗、不开新 BrowserWindow —— 就摆在这儿（沿用既有设计）。
            主进程是权威：输入越界会被夹回来，改完立刻生效并落盘到 userData。
          */}
          <div className="small">浏览器设置</div>
          <div className="settingsRow">
            <label className="small" htmlFor="setConcurrency">
              同时驾驶路数
            </label>
            <input
              id="setConcurrency"
              className="authInput settingsRow__num"
              type="number"
              min={1}
              // 上限与 packages/shared 的 SETTINGS_RANGE.maxConcurrentAgentTasks 一致（改一处要改两处）
              max={20}
              value={settings.maxConcurrentAgentTasks}
              onChange={(e) => void onSettingsChange({ maxConcurrentAgentTasks: Number(e.target.value) })}
            />
          </div>
          <div className="settingsRow">
            <label className="small" htmlFor="setMaxPages">
              最多同时开页
            </label>
            <input
              id="setMaxPages"
              className="authInput settingsRow__num"
              type="number"
              min={1}
              // 上限与 packages/shared 的 SETTINGS_RANGE.maxBrowserInstances 一致
              max={20}
              value={settings.maxBrowserInstances}
              onChange={(e) => void onSettingsChange({ maxBrowserInstances: Number(e.target.value) })}
            />
          </div>
          <div className="small">
            并发默认 20：调小可临时限流、调大即解锁更多并行（状态本就按页独立存储，改这个数不用动数据结构）。
            开页上限默认 4：到顶只拒绝新开，绝不关掉已有页。
          </div>
          {/* 第 15 步：两层记忆分开展示——上面那份是「这个人」的，下面那份是当前智能体的 */}
          {/* 记忆合并第四批：待确认记忆确认卡 */}
          <div className="buttons-row">
            <button type="button" className="btn" onClick={() => setUserMemOpen((v) => !v)}>
              用户记忆（{userMem.length}）
            </button>
            <button type="button" className="btn" onClick={() => setProjMemOpen((v) => !v)}>
              项目记忆（{projMem.length}）
            </button>
            <button type="button" className={pendingMem.length > 0 ? 'btn btn--pending' : 'btn'} onClick={() => setPendingMemOpen((v) => !v)}>
              待确认（{pendingMem.length}）
            </button>
          </div>
          {userMemOpen && (
            <div className="memList" role="list" aria-label="用户记忆库">
              <div className="small memList__title">账号级 · 所有智能体都读得到</div>
              {userMem.length === 0 && <div className="small">还没有记过东西。</div>}
              {userMem.map((m) => (
                <div className="memList__row" key={m.id}>
                  <span className="small">{m.content}</span>
                  <button type="button" className="memList__forget" onClick={() => void forgetEntry('user', m.id)}>
                    忘掉这条
                  </button>
                </div>
              ))}
            </div>
          )}
          {projMemOpen && (
            <div className="memList" role="list" aria-label="当前智能体的项目记忆">
              <div className="small memList__title">
                {curAgent ? `${curAgent.name} 专属 · 别的智能体看不到` : '智能体级'}
              </div>
              {projMem.length === 0 && <div className="small">这个智能体还没有项目记忆。</div>}
              {projMem.map((m) => (
                <div className="memList__row" key={m.id}>
                  <span className="small">{m.content}</span>
                  <button type="button" className="memList__forget" onClick={() => void forgetEntry('agent', m.id)}>
                    忘掉这条
                  </button>
                </div>
              ))}
            </div>
          )}
          {pendingMemOpen && (
            <div className="memList memList--pending" role="list" aria-label="待确认记忆">
              <div className="small memList__title">待确认 · 需你确认后才生效（decision/fact）</div>
              {pendingMem.length === 0 && <div className="small">没有待确认的记忆。</div>}
              {pendingMem.length > 0 && (
                <div className="buttons-row" style={{ marginBottom: 8 }}>
                  <button type="button" className="btn btn--go" onClick={() => void confirmAllPending()}>
                    全部确认
                  </button>
                  <button type="button" className="btn" onClick={() => void rejectAllPending()}>
                    全部忽略
                  </button>
                </div>
              )}
              {pendingMem.map((m) => (
                <div className="memList__row memList__row--pending" key={m.id}>
                  <span className="small">
                    <b>[{m.type === 'decision' ? '决定' : m.type === 'fact' ? '事实' : '偏好'}]</b> {m.content}
                  </span>
                  <div className="memList__actions">
                    <button type="button" className="btn btn--go memList__confirm" onClick={() => void confirmMemory(m.id)}>
                      确认
                    </button>
                    <button type="button" className="btn memList__reject" onClick={() => void rejectMemory(m.id)}>
                      不用
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* 第 11 步：同一主窗口左栏入口；标准文件选择器后 POST 到本机服务端，不创建 Electron 窗口。 */}
          <div className="buttons-row">
            <button
              type="button"
              className="btn knowledgePanel__toggle"
              onClick={() => setKnowledgeOpen((v) => !v)}
            >
              知识库（{knowledgeDocs.length}）
            </button>
          </div>
          {knowledgeOpen && (
            <div className="knowledgePanel">
              <div className="small">
                上传 .txt / .md / .pdf；资料原文片段会加密入库。
                资料只属于<b>当前项目</b>（{projects.find((p) => p.id === curProjectId)?.name ?? '…'}）：切到别的项目看不到这里的资料。
              </div>
              <input
                ref={knowledgeFileRef}
                className="knowledgePanel__file"
                type="file"
                accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf"
                onChange={onChooseKnowledgeFile}
              />
              <div className="buttons-row">
                <button
                  type="button"
                  className="btn knowledgePanel__upload"
                  // 子阶段 2-B：切项目过程中不许上传 —— 服务端的「当前项目」正在变，
                  // 这一瞬间传上去会落到上一个项目（归属由服务端按当前项目写）。
                  disabled={knowledgeUploading || projectBusy}
                  onClick={() => knowledgeFileRef.current?.click()}
                >
                  {knowledgeUploading ? '上传中…' : '上传资料'}
                </button>
              </div>
              {knowledgeNote && <div className="small knowledgePanel__note">{knowledgeNote}</div>}
              <div className="knowledgePanel__list" role="list" aria-label="已入库资料">
                {knowledgeDocs.length === 0 && <div className="small">还没有上传资料。</div>}
                {knowledgeDocs.map((doc) => (
                  <div className="knowledgePanel__row" role="listitem" key={doc.id} title={doc.filename}>
                    {/* 第 19 步：每条资料一行 + 一个「删除」。一点就删，删完在下面回一句人话。 */}
                    <div className="knowledgePanel__line">
                      <span className="knowledgePanel__name">{doc.filename}</span>
                      <button
                        type="button"
                        className="knowledgePanel__del"
                        title={`删除《${doc.filename}》`}
                        aria-label={`删除 ${doc.filename}`}
                        disabled={knowledgeDeletingId !== null}
                        onClick={() => void deleteKnowledgeDoc(doc)}
                      >
                        {knowledgeDeletingId === doc.id ? '删除中…' : '删除'}
                      </button>
                    </div>
                    <span className="small">{doc.kind.toUpperCase()} · {doc.chunkCount} 段</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 第 18 步：左栏这两个是纯演示 / 自检痕迹，用样式藏掉（.demoOnly，DOM 保留） */}
        <div className="buttons-row demoOnly">
          <button className="btn" type="button" onClick={() => setHasUnread((v) => !v)}>
            切换红点（演示）
          </button>
        </div>

        <div className="sidebar__footer demoOnly">桥：{bridgeInfo}</div>
      </aside>

      {/* 中间：**钉住的浏览器工作区**（tab + URL 栏 + 当前页）+ 聊天区 */}
      <main className="middle">
        {/* 常驻工作台顶栏：随时随地切换【对话模式】与【浏览器工作台】 */}
        <header className="workbenchNav">
          <div className="workbenchNav__meta">
            <span className="workbenchNav__name">
              {curAgent ? `🤖 ${curAgent.name}` : 'AI 工作台'}
            </span>
            <span className="workbenchNav__status">在线</span>
            {curState?.current_task && (
              <span className="small" style={{ color: '#6b7280', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={curState.current_task}>
                · {curState.current_task}
              </span>
            )}
          </div>
          <div className="workbenchNav__views">
            <button
              type="button"
              className={`workbenchNav__btn ${browser.view !== 'fullscreen' ? 'workbenchNav__btn--active' : ''}`}
              onClick={() => browser.exitFullscreen()}
            >
              💬 对话
            </button>
            <button
              type="button"
              className={`workbenchNav__btn ${browser.view === 'fullscreen' ? 'workbenchNav__btn--active' : ''}`}
              onClick={() => {
                if (browser.tabs.length === 0) {
                  browser.openNewTab();
                }
                browser.showFullscreen();
              }}
              title="切换到内嵌浏览器工作台（没有标签页时自动打开主页）"
            >
              🌐 浏览器
              {browser.tabCount > 0 && <span className="workbenchNav__badge">{browser.tabCount}</span>}
              {browser.drivingIds.length > 0 && <span className="workbenchNav__driving" title="AI 正在操作网页" />}
            </button>
            {/*
              多智能体编排 · 内部频道入口。
              ★ 只是视图开关，不影响任何一路驾驶（与上面两个按钮同一性质）。
            */}
            <button
              type="button"
              className={`workbenchNav__btn ${showChannels ? 'workbenchNav__btn--active' : ''}`}
              onClick={() => setShowChannels((v) => !v)}
              title="看智能体之间的委派与回复（只读）"
            >
              🗂 内部频道
            </button>
          </div>
        </header>

        {/*
          多智能体编排 · 内部频道面板（只读）。
          盖在中栏上面（面板自己 position:absolute + inset:0，.middle 是定位上下文）。
          ★ token 从 session 传下去，组件自己不碰 localStorage —— 切号时 sessionRef
            那套「晚到的响应丢掉」的逻辑也就自然覆盖到它。
        */}
        {showChannels && session && (
          <ChannelsPanel apiBase={API_BASE()} token={session.token} onClose={() => setShowChannels(false)} />
        )}

        {browser.allTabs.length > 0 && (
          <div
            className={
              // 第 27 步：第三种态 —— 求助卡模式（层透明、只露出求助的那一张页）
              browser.view === 'embed'
                ? 'browserLayer browserLayer--embed'
                : browser.view === 'fullscreen'
                  ? 'browserLayer'
                  : 'browserLayer browserLayer--bg'
            }
          >
            {/*
              阶段简报 · 方案 B：**临时测试条**（本阶段只用临时按钮，正式 UI 不在本阶段做）。
              作用对象是「当前切到前面的那张页」（按钮点名它的 wcId），
              所以暂停这一路 = 只停这一路，别的页、别的智能体照跑。
            */}
            <div className="driveBar">
              {/*
                ★ P0 止血（2026-09-21）：**「上下文没了」的确认卡**。
                放在驾驶条里是因为它本来就是驾驶态的一部分 —— 用户刚点了「继续」，
                视线就在这里；放别处等于弹了看不见。
              */}
              {loopGone && (
                <div className="loopGone">
                  <span className="loopGone__q">{loopGone.question}</span>
                  <button className="btn loopGone__warn" type="button" onClick={() => answerLoopGone('restart')}>
                    重新开始
                  </button>
                  <button className="btn loopGone__giveup" type="button" onClick={() => answerLoopGone('giveup')}>
                    算了
                  </button>
                </div>
              )}
              <span className="driveBar__tag">临时测试条</span>
              <button className="btn" type="button" onClick={() => void driveBarAct('pause')}>
                暂停
              </button>
              <button className="btn driveBar__go" type="button" onClick={() => void driveBarAct('resume')}>
                继续
              </button>
              <span className="small">
                当前页：
                <b>
                  {driveStateView(driveBar)?.icon} {DRIVE_PHASE_LABEL[driveBar?.phase ?? 'idle'] ?? driveBar?.phase ?? '空闲'}
                </b>
                {/* 第 27 步：谁发起的，在测试条上也一眼看得出来（不再只写一句"已暂停"） */}
                {driveBar?.phase === 'paused' && driveBar.pausedBy && (
                  <b> · {driveBar.pausedBy === 'agent' ? 'AI 发起' : '你发起'}</b>
                )}
                {driveBar?.wcId != null && ` · wcId ${driveBar.wcId}`}
              </span>
              {driveNote && <span className="small driveBar__note">{driveNote}</span>}
            </div>
            <BrowserPanel
              ws={browser}
              agentLabel={agents.find((a) => a.id === curAgentId)?.name}
              /*
               * 第 27 步：求助卡模式下的几何（wcId + 那块"窗口"的位置）。
               * 非 embed 态时 wcId 为 null，面板会完全按老逻辑渲染 —— 零影响。
               */
              embed={{ wcId: browser.embedWcId, rect: embedRect }}
            />
          </div>
        )}
        {/*
          第 25 步：**后台运行小图标**。
          只在「有页 + 用户已退出全屏」时出现 —— 点它回到全屏，看到实时执行状态。
          它只是个视图开关，跟任务执行毫无耦合（点了不 start / 不 resume / 不改 sleep）。
        */}
        {browser.allTabs.length > 0 && browser.view === 'background' && (
          <button
            type="button"
            className="browserFloating"
            title="浏览器正在后台运行（任务没有中断）。点这里回到全屏"
            onClick={() => browser.showFullscreen()}
          >
            <span aria-hidden="true">🌐</span> 浏览器后台运行中
          </button>
        )}
        <div className="chat">
          {/*
            任务进行中明确状态指示：贯穿前后端状态机
          */}
          {runningLoopId && streaming && (
            <div className="taskState" style={{ background: '#e6f7ff', borderColor: '#91d5ff', color: '#0050b3' }}>
              <span>🚀 <b>AI 任务执行中</b> · 正在自主操作浏览器</span>
              <span className="small" style={{ marginLeft: 8 }}>（可在下方输入补充指令或问答注入上下文，或输入「停」暂停任务）</span>
            </div>
          )}
          {/*
            第 16 步：会话状态行（服务端 conversations 表为准）。
            进程重启后靠它把「当前任务」恢复出来，而不是假装任务从未开始；
            保活态也在这里标出来，让人一眼看出「挂着监听但没在烧模型」。
          */}
          {curState && (curState.current_task || curState.keepalive || curState.browser_confirmed) && (
            <div className="taskState">
              <span>{curState.keepalive ? '● 监听中（保活：空闲不调模型）' : '○ 未保活'}</span>
              {curState.current_task && <span> · 当前任务：{curState.current_task}</span>}
              {curState.browser_confirmed && <span> · 本会话已同意用浏览器</span>}
            </div>
          )}
          {/*
            第 27 步 · **「谁在等谁」状态条**（本步的核心验收点）。
            它渲染在**聊天区里**（不是浏览器层里）—— 这样求助卡模式下也照样看得见。
            颜色/图标/文案全部跟着 `pausedBy` 走：蓝=AI 求助、琥珀=你接管、灰=分不清。
          */}
          {(() => {
            const view = driveStateView(driveBar);
            if (!view) return null;
            return (
              <div className={`driveState driveState--${view.cls}`} role="status">
                <span className="driveState__icon" aria-hidden="true">
                  {view.icon}
                </span>
                <span>{view.text}</span>
              </div>
            );
          })()}
          {/*
            第 17 步：任务结果从右栏搬到这里（右栏整栏不渲染了）。
            只留「查看结果 / 下载文档」两个动作——结论正文在聊天里以「✅ 任务完成」给出。
          */}
          {curTask && (
            <div className="taskResult">
              <div className="small">
                任务 #{curTask.id} · {curTask.status}
                {curTask.unread ? <span className="unreadTag"> ● 未读</span> : <span className="readTag"> ✓ 已读</span>}
                {curTask.goal ? ` · 目标：${curTask.goal}` : ''}
              </div>
              {taskDetailOpen && curTask.summary && <div className="small taskSummary">{curTask.summary}</div>}
              {taskDetailOpen && curTask.outline && curTask.outline.length > 0 && (
                <div className="small">
                  📄 {curTask.docTitle || '任务记录'} · {curTask.outline.slice(0, 4).join(' / ')}
                </div>
              )}
              <div className="buttons-row">
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    if (taskDetailOpen) setTaskDetailOpen(false);
                    else void openTaskResult();
                  }}
                >
                  {taskDetailOpen ? '收起结果' : '查看结果'}
                </button>
                {/* 第 8 步：任务 done 后的「下载文档」——不经过右栏，也不必先点「查看结果」 */}
                {(task.phase === 'done' || curTask.status === 'done') && (
                  <button className="btn docDownload" type="button" onClick={() => void downloadTaskDoc()}>
                    下载文档（.md）
                  </button>
                )}
              </div>
              {docNote && <div className="small">{docNote}</div>}
            </div>
          )}
          {/*
            第 15 步：新智能体的**引导表**就摆在这个会话里（不是独立设置窗、不是后台配置页）。
            填完确认 → 服务端存人设 → personaStatus 变 ready，它才按这份描述干活。
          */}
          {curAgent && curAgent.personaStatus === 'pending' && (
            <AgentGuide
              key={curAgent.id}
              agent={curAgent}
              onSave={(p) => savePersona(curAgent.id, p)}
              onDelete={() => void deleteAgent(curAgent.id)}
            />
          )}
          {messages.length === 0 && !streaming && !(curAgent && curAgent.personaStatus === 'pending') && (
            <div className="welcomeCard">
              <h4 className="welcomeCard__title">
                <span>🤖</span> 欢迎使用 AI 自主浏览器工作台
              </h4>
              <div className="welcomeCard__desc">
                当前智能体 <b>「{curAgent?.name ?? '小助'}」</b> 已准备就绪。AI 驾驶员可在内嵌浏览器中为您自主执行检索、阅读并提取核心知识。
              </div>
              <div className="welcomeCard__actions">
                <button
                  type="button"
                  className="welcomeCard__btn welcomeCard__btn--primary"
                  onClick={() => {
                    if (browser.tabs.length === 0) {
                      browser.openNewTab();
                    }
                    browser.showFullscreen();
                  }}
                >
                  🌐 立即打开内嵌浏览器
                </button>
                <button
                  type="button"
                  className="welcomeCard__btn"
                  onClick={() => {
                    setInput('帮我打开百度搜索最新的人工智能发展历史');
                  }}
                >
                  🔍 帮我打开百度搜索最新 AI 进展
                </button>
                <button
                  type="button"
                  className="welcomeCard__btn"
                  onClick={() => {
                    setInput('在当前网页上查阅内容并总结核心要点');
                  }}
                >
                  📄 查阅网页并生成要点报告
                </button>
              </div>
            </div>
          )}
          {messages.map((m, idx) => (
            /**
             * 第 18 步：聊天里**只有话和结论**——不再有「网页行」芯片。
             * 开页成功看中栏工作区的 tab；关页只从工作区消失（最多留一句人话在下面的提示条里）。
             * 这样连续开百度/必应/知乎、再关掉几张，聊天也不会被一串「已关闭」刷屏。
             */
            <div key={m.id}>
              <div className={`msg ${m.role}`}>{m.text}</div>
              {/*
                第 26 步：来源标注 —— 这条回答是从哪些网页查到的。
                点一条就跳原始网页：`target="_blank"` 会走到主进程第 17 步就装好的
                `setWindowOpenHandler` → `shell.openExternal`（系统默认浏览器），
                所以这里**零主进程改动、不碰浏览器驾驶那条链路**。
                没搜过的回复（sources 为空）整块不渲染，不占地方。
              */}
              {m.role === 'assistant' && m.sources && m.sources.length > 0 && (
                <div className="sources">
                  <span className="sources__label">来源</span>
                  <div className="sources__list">
                    {m.sources.map((src, si) => (
                      <a
                        key={`${m.id}-${si}`}
                        className="sources__item"
                        href={src.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={src.url}
                      >
                        <span className="sources__title">{src.title}</span>
                        <span className="sources__domain">{src.domain}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}
              {/* 第 8 步：确认按钮只挂在「最后一条」确认回复上——旧确认按钮不再渲染，
                  免得用户点到老按钮、拿旧目标开新任务（例如用「打开百度」去搜天气）。
                  目标一律取这条确认之前最近的那句用户原话（例如「打开百度搜天气」）：
                  既不读输入框，也不用更早的消息；取不到就明确提示，不拿空 goal 去开车。
                  第 13 步：本轮用户原话就是「开网页指令」时不再挂这个按钮——
                  网页已经打开了，再要确认就是自相矛盾。
                  第 15 步：这个「本轮」是按**当前智能体**判的，别的智能体开过网页不算。 */}
              {m.role === 'assistant' &&
                CONFIRM_ASK_RE.test(m.text) &&
                idx === messages.length - 1 &&
                !streaming &&
                !curConfirmed && (
                  <div style={{ padding: '2px 4px' }}>
                    <button
                      type="button"
                      className="btn"
                      disabled={task.phase === 'running'}
                      onClick={() => {
                        const goal = (
                          [...messages.slice(0, idx)].reverse().find((x) => x.role === 'user')?.text ?? ''
                        ).trim();
                        if (!goal) {
                          setChatNote('这条确认没有对应的用户原话，我没有开始。请把目标再发一遍（例如「打开百度搜天气」）。');
                          return;
                        }
                        void startAgentTask(goal);
                      }}
                    >
                      确认 · 用工作台浏览器开始
                    </button>
                  </div>
                )}
            </div>
          ))}
          {/*
            第 27 步 · **人工介入求助卡**（AI 主动求助）。

            它就是聊天流里的一个普通节点 —— 所以它**跟着消息一起滚动**，
            而不是像浏览器面板那样钉在聊天区外面。这正是本次要的"嵌进对话流"。

            卡片内部**只有展示与两个按钮**，没有任何输入能力：
            中间那块"窗口"里显示的是**同一张真实页面**（webview 没被搬动过，
            只是几何跟着这块占位区走），用户直接在真实页面上操作。
          */}
          {curHelp && (
            <HelpCard
              key={`${curHelp.agentId}-${curHelp.wcId}-${curHelp.helpKind}`}
              helpKind={curHelp.helpKind}
              question={curHelp.question}
              hint={curHelp.hint}
              onRect={onEmbedRect}
              onDone={() => void helpCardAct('done', curHelp.wcId)}
              onStop={() => void helpCardAct('stop', curHelp.wcId)}
            />
          )}
          {/* 第 26 步：联网搜索的过程提示 —— 一行小字，说明"AI 正在联网查资料" */}
          {streaming && streamingAgentId === curAgentId && searchHint && (
            <div className="searchHint" role="status" aria-live="polite">
              {searchHint}
            </div>
          )}
          {/* 第 15 步：只在「发起这轮流式的那个智能体」里显示打字气泡，切走就不显示 */}
          {streaming && streamingAgentId === curAgentId && (
            <div className="msg assistant">
              {streamText || <span className="small">正在想…</span>}
              <span className="caret" aria-hidden="true">
                ▍
              </span>
            </div>
          )}
          {chatNote && (
            <div className="chatNote">
              <span>{chatNote}</span>
              <button type="button" className="chatNote__x" aria-label="关闭提示" onClick={() => setChatNote('')}>
                ✕
              </button>
            </div>
          )}
        </div>

        <div className="inputBar">
          <input
            placeholder={
              runningLoopId && streaming
                ? '任务进行中：输入补充指令/追问注入上下文，或输入「停」暂停任务…'
                : streaming
                  ? '正在打字…'
                  : awaitHere
                    ? '回复小助的提问即可，发出后自动继续…'
                    : `和${curAgent ? `「${curAgent.name}」` : '小助'}聊聊（消息加密存服务端，刷新后还在）`
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSend()}
            disabled={streaming && !runningLoopId}
          />
          <button type="button" onClick={onSend} disabled={streaming && !runningLoopId}>
            {runningLoopId && streaming ? '发送补充' : streaming ? '打字中…' : '发送'}
          </button>
          {/* 第 15 步：结束这轮 → 把这段聊天**总结**进两层记忆（用户库 + 本项目记忆） */}
          <button
            type="button"
            className="inputBar__end"
            title="结束这轮聊天，把这段总结进两层记忆"
            onClick={() => void tidyCurrentAgent()}
          >
            结束
          </button>
        </div>
      </main>

      {/*
        第 13/17 步：右栏整个撤掉 —— 驾驶台、调试区、**任务卡**一律不画。
        第 17 步验收第 1 条就是「右栏驾驶台/任务卡看不见」，所以这里不是隐藏，是根本不渲染；
        任务结果改挂在聊天顶部那一行（结论本身早就在聊天里以「✅ 任务完成」给出了），
        第 8 步的「下载文档」能力不丢，右栏也不再占地方、更不会被当浏览器用。
      */}
    </div>
  );
}
