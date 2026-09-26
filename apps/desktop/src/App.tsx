import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import type {
  AgentCreateResult,
  AgentEventPayload,
  AgentListResult,
  AgentPersona,
  AgentTidyResult,
  AgentView,
  AuthSession,
  ChatHistoryResult,
  ChatSource,
  ChatStateResult,
  ConversationStateView,
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
import type { ChatMentionMeta, ChatSpeaker } from '@ai-workbench/shared';
/**
 * 批次 J · @点名（渲染进程这一侧）：裁决权在服务端，桌面只需要一道闸 ——
 * 服务端已经用「一句告知」答过的那两轮（R-A 忙 / 只写了 @名字），兜底不许再替用户发车。
 * 判定收在 `./mentionGate`（可单测），App.tsx 不在 3500 行的组件里散写规则。
 */
import { shouldFallbackLaunch } from './mentionGate';
/**
 * 批次 M · 逻辑抽离第 1 片：`API_BASE` / `TOKEN_KEY` / `authFetchJson` / `dbHint`
 * 原先写在本文件里（模块级、组件之外），被 30 多处逻辑用到。抽出 feature 时它们
 * 必须离开 App.tsx —— 否则每个 feature 都要反向依赖 App。现已原样搬到 `shared/api.ts`。
 */
import { API_BASE, TOKEN_KEY, authFetchJson } from './shared/api';
/** 批次 M-8'：首帧兜底配置（原写在本文件模块级）搬进 shared/settings.ts */
import { SETTINGS_FALLBACK } from './shared/settings';
import { useKnowledge } from './features/knowledge';
import { MemoryConfirmCard, useMemory } from './features/memory';
import {
  BrowserPanel,
  CONFIRM_ASK_RE,
  CONTINUE_STRONG_RE,
  CONTINUE_WEAK_RE,
  HOME_URL,
  HelpCard,
  /**
   * 收尾 7 | 批次 H 的电脑三级可见度**第一次真的挂进界面**。
   * 它以前只在 `browser/index.ts` 里 export 着、没人渲染（H 空转），
   * 而且自己 fetch 的路径是 `/api/agents/:id/visibility`（服务端没有 `/api` 前缀）、
   * token 摸的是 `localStorage.getItem('token')`（真实 key 是 `workbench.token`）—— 两处都错，从没存上。
   * 现在读写都走这两个导出的纯函数，地址与 JWT 由这边给（`API_BASE()` + `session.token`）。
   */
  ComputerVisibility,
  loadVisibility,
  saveVisibility,
  detectBrowseIntent,
  detectOpenUrl,
  detectStopIntent,
  detectUnknownOpenTarget,
  isPureOpenCommand,
  useBrowserWorkspace,
} from './browser';
import type { BrowserWorkspace, ComputerVisibilityLevel, EmbedRect } from './browser';
import { useResourceGuard } from './resources/useResourceGuard';
import { useBrowserGlue } from './app/browserGlue';
import { useBrowserColumn } from './app/useBrowserColumn';
import { useSidebarColumn } from './app/useSidebarColumn';
import { useProjects } from './features/projects';
import { AuthScreen, useAuth } from './features/auth';
import { useTasks } from './features/tasks';
import { CollabCard, PersonaChips, isCollabMessage, useChat } from './features/chat';
import type { AgentChat, Message, Role, PersonaChipsDraft, PersonaField } from './features/chat';
import type { CurrentTask } from './features/tasks';

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
 *   - **活页上限（全局，默认 4 张，设置可调大）**：不再「第 11 张顶掉最旧」，到上限拒新开并说明，绝不偷偷关旧页。
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

/**
 * 第 15 步：`Role` / `Message` / `AgentChat` / `EMPTY_MESSAGES` 的**定义**随片 7a 一起搬进
 * `features/chat`（那边是唯一 owner）；本文件只 import 类型用。
 */

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

/**
 * 第 8 步：`CurrentTask` 的**定义**随片 6 一起搬进 `features/tasks`（那边是唯一 owner）。
 */

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

/** 左栏头像里的那个字：小助固定「助」，自建智能体取名字首字（还没名字就是「新」） */
function agentGlyph(a: AgentView): string {
  if (a.kind === 'assistant') return '助';
  const n = (a.persona?.name || a.name || '').trim();
  return n ? n.slice(0, 1) : '新';
}

/** M2':头像块的品牌底色（按 id 确定性派生，纯呈现 —— AgentView 没有头像 URL，不造假图） */
function agentColor(a: AgentView): string {
  const hue = Math.round((a.id * 137.508 + 195) % 360);
  return `hsl(${hue} 62% 60%)`;
}

/** M3':第一列头像块的那一个字（真数据：会话对外号 / 打码手机号首字，都没有就 U） */
function userAvatarChar(u: { xyz_id?: string; phone_masked?: string | null }): string {
  return (u.xyz_id || u.phone_masked || 'U').slice(0, 1).toUpperCase();
}

/** M2':行第二行的真实状态人话（服务端 statusDetail 优先；否则沿用既有状态逻辑） */
function agentStatusLine(a: AgentView): string {
  if (a.statusDetail) return a.statusDetail;
  if (a.kind === 'assistant') return '在线';
  // 规格 C1 起新智能体建好即 ready（chips 只是可选精调）；'pending' 只剩旧数据兼容
  return a.personaStatus === 'pending' ? '等你定个样子' : '已就位';
}

export default function App() {
  /** 头像右上角红点：第 8 步起由服务端 tasks.unread 驱动（登录后拉 current，done 事件点亮，看完熄灭） */
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
  /**
   * ★ 这两个**留在 App**（不进 hook）：`curAgentId` 是左栏的选择，浏览器 / 记忆 / 胶水都要读；
   *   `curAgentRef` 是它的「最新值镜像」（异步回包里读它，闭包里的 state 是旧的）。
   *   片 7a 搬聊天状态时，**它们一个都没删**（用户点名的红线）。
   */
  /** 左栏选中的那个智能体；null = 还没拿到列表 */
  const [curAgentId, setCurAgentId] = useState<number | null>(null);
  /** 异步回调里读「此刻是哪个智能体」——直接用 state 会拿到挂载时的旧闭包值 */
  const curAgentRef = useRef<number | null>(null);
  /**
   * 收尾 7 | 电脑三级可见度（批次 H 的 `agents.computer_visibility`）：status / preview / takeover。
   * 默认 `status`（收起，不抢焦点）—— 这是批次 H 的设计前提，也是服务端那列的默认值。
   * 状态放在这里（不在组件里）有两个理由：① 切智能体要把那个智能体自己存的档位读回来；
   * ② 「接管」档要顺带把浏览器前置，那是 `browser.showFullscreen()`，只有这边够得着。
   */
  const [computerVisibility, setComputerVisibility] = useState<ComputerVisibilityLevel>('status');

  /** 第 1 步的 IPC 自检，留着当回归哨兵 */
  const [bridgeInfo, setBridgeInfo] = useState('检测中…');

  /**
   * 批次 M · 逻辑抽离第 5 片：**会话**（静默登录 / 改密码 / 登出）搬进 `features/auth`。
   *
   * ★ 依旧**只换来源、不改名字** → 下面 30 多处 `session?.token`、JSX 里的
   *   `pwOld/pwNew/pwMsg/onSubmitPassword/onLogout` 一个字都不用改。
   * ★ 登出被有意切成两半：会话那一半在 hook（`signOutSession`），
   *   跨 feature 清场那一半留在本文件的 `onLogout`（见那里的注释）。
   */
  const {
    session,
    setSession,
    checkingAuth,
    pwOld,
    setPwOld,
    pwNew,
    setPwNew,
    pwMsg,
    setPwMsg,
    submitPassword: onSubmitPassword,
    signOutSession,
  } = useAuth();
  /**
   * 多智能体编排 · 「内部频道」面板开没开。
   *
   * 只是个视图开关（与 `browser.view` 同一性质）：开了盖在中栏上面看智能体之间的
   * 委派对话，关掉就回到原来的样子 —— **不 start / 不 resume / 不碰任何一路驾驶**。
   */

  /**
   * ★ 批次 M · 逻辑抽离时**上移**：`sessionRef` 原先声明在下面（第 8 步任务快照那段），
   *   那时它只在函数体里被延迟引用（`memHeaders()` 之类），声明顺序无所谓；
   *   现在 memory feature 的 hook 调用要在**渲染期**读到它，必须声明在使用之前。
   *   移动 `useRef` 的位置不改变 hook 的**稳定性**（仍然无条件、每次渲染同一顺序）。
   */
  const sessionRef = useRef<AuthSession | null>(null);
  sessionRef.current = session;

  /**
   * 批次 M · 逻辑抽离第 6 片：任务快照 / 结果详情 / 文档下载搬进 `features/tasks`。
   * ★ 同名解构（连 setter 都同名）→ 主进程事件分发那几处 `setHasUnread(…)`、
   *   JSX 里的 `curTask` / `taskDetailOpen` / `docNote` 一个字都不用改。
   */
  const {
    curTask,
    setCurTask,
    taskDetailOpen,
    setTaskDetailOpen,
    docNote,
    setDocNote,
    hasUnread,
    setHasUnread,
    refreshTask,
    openTaskResult,
    downloadTaskDoc,
    resetTasks,
  } = useTasks({ sessionRef, session });

  /**
   * 静默登录（带已存 token 调 `/auth/me` 换回 profile）也搬进 `features/auth` 了 ——
   * 它和 session 是同一件事，分开写就会出现"两个地方各自决定登录态"。
   */
  // ---- 第 6 步：流式聊天状态（真聊天，不再是内存假数据）----
  /**
   * 第 13 步：这一轮的**用户原话**是不是「开网页指令」。
   * 是的话，即使模型仍回了「确认后我开始操作」那句老话，也不再挂确认按钮——
   * 网页已经在工作区里打开了，再要用户点确认就是自相矛盾。
   * 第 15 步：按智能体分别记（否则在 A 里开的网页会压掉 B 里的确认按钮）。
   */
  const lastUserWasOpenRef = useRef<Record<number, boolean>>({});
  /** 第 15 步：这轮流式是**哪个**智能体在打字——切走后不该在别的智能体里冒出打字气泡 */
  /** 打字机中的半截助手回复（done 之前只活在这里；库里只有完成的全文） */
  /** 聊天区一条可关闭的提示（未配置模型 / 出错 / 已先行暂停等），不冒充 AI 的话 */

  /**
   * 第 9 步：驾驶员在聊天里等用户回答普通资料（need_info）——回答后自动继续，不用点「继续」。
   * 第 15 步：驾驶员的循环是**全进程一个**（第 7 步的设计），但「这句答复该不该喂给它」要按智能体判——
   * agentAwaitAgent 记住这个提问是**哪个智能体**在等，别的智能体聊天里的回答不会串进去。
   */
  const [agentAwaitInfo, setAgentAwaitInfo] = useState(false);
  const [agentAwaitAgent, setAgentAwaitAgent] = useState<number | null>(null);
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
  /** 第 15 步 · 第一层：用户记忆库（账号级，所有智能体都能读，界面上也列出来） */
  /** 第 15 步 · 第二层：**当前智能体**的项目记忆（智能体级，切智能体就整块换掉） */
  /** 记忆合并第四批：待确认记忆（decision/fact 需用户确认才生效） */
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
  /** 建完能改人设：编辑态 */
  const [personaEditOpen, setPersonaEditOpen] = useState(false);
  const [personaEditAgentId, setPersonaEditAgentId] = useState<number | null>(null);
  const [personaEditDraft, setPersonaEditDraft] = useState<AgentPersona>({ name: '', who: '', tone: '', duty: '' });
  /** 第 19 步：正在删的那条资料 id（按钮显示「删除中…」并防连点），null = 没有删除在跑 */
  /** 第 7 步：主进程 'agent' 事件的镜像（步摘要/文档结论），权威循环在主进程 */



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
  /**
   * 批次 M · 逻辑抽离第 2 片：两层记忆 + 待确认记忆的逻辑搬进 `features/memory`。
   *
   * ★ 同样**只换来源、不改名字**（下面解构出来的名字与原变量完全一致），
   *   所以 JSX 与后面那些调用点（loadAgents / selectAgent / tidyCurrentAgent …）一个字都不用改。
   * ★ `sessionRef` / `curAgentRef` 是**注入**的：这两个"最新值镜像"ref 原样留在 App 里。
   * ★ `onNote` 传的是 `setChatNote`：提示文案仍写在聊天流里，但 memory feature 不依赖 chat 的 state。
   */
  /**
   * 批次 M · 逻辑抽离第 7b 片：**两个"定义在 useChat 之后"的依赖，用最新值镜像注入**。
   *
   *   · `browserRef` —— 浏览器工作区 `useBrowserWorkspace(...)` 排在 `useChat(...)` 之后
   *     （它自己要用 `setChatNote`），而 `sendChat` 要指挥它（开页 / 叫醒睡着的页 / 停 / 刷横幅）；
   *   · `loadAgentStateRef` —— 同理：`loadAgentState` 的定义在下面，一轮结束后要回刷状态行。
   *
   * 两个都是「渲染期赋值、调用期读取」，与 `chatsRef` / `agentsRef` / `curAgentRef` 同一条规矩：
   * 不新建 state、不加 React 依赖，闭包里永远不会拿到旧对象。
   */
  const browserRef = useRef<BrowserWorkspace | null>(null);
  const loadAgentStateRef = useRef<(agentId: number) => Promise<void>>(async () => undefined);

  /**
   * 产品交互规格 C1（2026-09-25）：三问 = **输入框上方一行 chips**（旧 AgentGuide 大表格已废）。
   * - draft = 当前值（答了哪个问题就更新哪个）；base = 创建时的默认人设（做 diff,没改就不多发请求）；
   * - touched = 哪些问题被答过（「全答完」判据）；
   * - 消失路径：全答完（onComplete）/ 跳过（onSkip）/ 用户开始打字（主输入框 onChange 触发 finishChips）。
   * - 只在「正在看那个智能体」时渲染（切到别人自然消失）。
   * 定义必须排在 useChat 之前（options.onNewAgent 引用本函数）；引用的 savePersona /
   * justAdded* 等都是「调用期」才用（渲染完成后），无 TDZ。
   */
  const [chipsDraft, setChipsDraft] = useState<PersonaChipsDraft | null>(null);
  const [chipsBase, setChipsBase] = useState<PersonaChipsDraft | null>(null);
  const [chipsTouched, setChipsTouched] = useState<Partial<Record<PersonaField, boolean>>>({});

  /** C1：chips 收尾（全答完 / 跳过 / 打字 三条路的唯一出口）：改过才落库,然后收起 */
  const finishChips = async (final: PersonaChipsDraft | null): Promise<void> => {
    const base = chipsBase;
    const d = final ?? chipsDraft;
    setChipsDraft(null);
    setChipsBase(null);
    setChipsTouched({});
    if (!d || !base) return;
    const changed =
      d.name !== base.name || d.who !== base.who || d.tone !== base.tone || d.duty !== base.duty || d.antiJobs !== base.antiJobs;
    if (!changed) return; // 什么都没改 → 默认人设创建时已落库,不多发请求
    try {
      await savePersona(d.agentId, { name: d.name, who: d.who, tone: d.tone, duty: d.duty, antiJobs: d.antiJobs });
    } catch (e) {
      setChatNote(`人设没存上：${(e as Error).message}`);
    }
  };

  /** C1：某个问题被答了（PersonaChips 上报 → App 更新 draft + touched） */
  const onChipsField = (k: PersonaField, v: string): void => {
    setChipsDraft((prev) => (prev ? { ...prev, [k]: v } : prev));
    setChipsTouched((prev) => ({ ...prev, [k]: true }));
  };

  /**
   * C1：对话式建好新智能体（服务端 meta 帧带回 newAgent）→
   * ① 左栏立刻现真名字（真数据 + 刚创建脉冲）② 切到它（「直接和TA聊就行」可执行）
   * ③ 输入框上方摆三问 chips（名字已在原话里,占位名 false）。
   */
  const onNewAgent = (a: AgentView): void => {
    setAgents((prev) => (prev.some((x) => x.id === a.id) ? prev : [...prev, a]));
    if (curProjectRef.current !== null) agentProjectRef.current.set(a.id, curProjectRef.current);
    historyLoadedRef.current.add(a.id);
    patchChat(a.id, () => ({ messages: [], convId: a.conversationId }));
    setJustAddedAgentId(a.id);
    if (justAddedTimerRef.current) clearTimeout(justAddedTimerRef.current);
    justAddedTimerRef.current = setTimeout(() => setJustAddedAgentId(null), 1600);
    curAgentRef.current = a.id;
    setCurAgentId(a.id);
    setProjMem([]);
    setProjMemOpen(false);
    const base: PersonaChipsDraft = {
      agentId: a.id,
      name: a.name,
      nameIsPlaceholder: false,
      who: a.persona?.who ?? '',
      tone: a.persona?.tone ?? '',
      duty: a.persona?.duty ?? '',
      antiJobs: a.persona?.antiJobs ?? '',
    };
    setChipsBase(base);
    setChipsDraft(base);
    setChipsTouched({});
  };

  /**
   * 批次 M · 逻辑抽离第 7a 片：**聊天这一侧的 state 与历史**搬进 `features/chat`。
   *
   * ★ 依旧**只换来源、不改名字** → 本文件 100 多处 `messages` / `setMessages` / `chatNote` /
   *   `agentSteps` / `streaming` … 以及 JSX 一个字都不用改。
   * ★ `setChatNote` 现在从 hook 出来，仍是**其它 feature 唯一往聊天里说话的通道**
   *   （浏览器工作区、记忆、胶水都拿它当 `onNote`）—— 所以这个 hook 必须排在它们之前。
   * ★ 片 7b 之后：`sendChat` / `onSend` / `startAgentTask` 也从这里出来（注入见上面的端口注释），
   *   本文件只留「组合层」的连线与 JSX。
   */
  const {
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
    /** 片 7b 搬进来的（JSX 里 `searchHint` / `runningLoopId` / `onSend` / `startAgentTask` 照旧同名） */
    searchHint,
    runningLoopId,
    sendChat,
    onSend,
    startAgentTask,
  } = useChat({
    sessionRef,
    curAgentId,
    curAgentRef,
    /**
     * ---- 片 7b：`sendChat` / `startAgentTask` 要的东西，一律由**组合层**在这里注入 ----
     * 「只换来源、不改名字」→ 那两个函数的正文可以逐字搬（只有 3 处白名单改动）。
     */
    session,
    input,
    setInput,
    browserRef,
    /** 任务侧：发车前熄红点（`features/tasks`） */
    setHasUnread,
    agentsRef,
    lastUserWasOpenRef,
    lastUserGoalBeforeConfirm,
    loadAgentStateRef,
    /** 「等继续」四件套（写它的那条事件分发 effect 在下面，留在 App） */
    resume: {
      awaitResume,
      awaitResumeAgent,
      awaitResumeWc,
      setAwaitResume,
      setAwaitResumeAgent,
      setAwaitResumeWc,
    },
    /** 「驾驶员问资料」四件套（同上） */
    askInfo: {
      agentAwaitInfo,
      agentAwaitAgent,
      agentAwaitWcId,
      setAgentAwaitInfo,
      setAgentAwaitAgent,
      setAgentAwaitWcId,
    },
    /** 批次 J 的兜底发车闸（纯函数，住在 `./mentionGate`） */
    shouldFallbackLaunch,
    /** 规格 C1：对话式建好新智能体（meta 帧 newAgent）→ 左栏现真名字 + 切到它 + 摆三问 chips */
    onNewAgent,
    /** 纯本地判定（开页 / 停 / 继续…）：单一实现住在 `browser/`，注入进来用 */
    intent: {
      detectStopIntent,
      detectOpenUrl,
      detectUnknownOpenTarget,
      isPureOpenCommand,
      CONTINUE_STRONG_RE,
      CONTINUE_WEAK_RE,
      CONFIRM_ASK_RE,
      HOME_URL,
    },
  });

  const {
    user: userMem,
    setUser: setUserMem,
    userOpen: userMemOpen,
    setUserOpen: setUserMemOpen,
    project: projMem,
    setProject: setProjMem,
    projectOpen: projMemOpen,
    setProjectOpen: setProjMemOpen,
    pending: pendingMem,
    setPending: setPendingMem,
    pendingOpen: pendingMemOpen,
    setPendingOpen: setPendingMemOpen,
    loadUser: loadUserMemory,
    loadProject: loadProjectMemory,
    loadPending: loadPendingMemory,
    forget: forgetEntry,
    confirm: confirmMemory,
    reject: rejectMemory,
    confirmAll: confirmAllPending,
    rejectAll: rejectAllPending,
  } = useMemory({ sessionRef, curAgentRef, onNote: setChatNote });

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
  /** ★ 片 7b：同上（`sendChat` 收尾要回刷状态行） */
  loadAgentStateRef.current = loadAgentState;

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
  /**
   * 进入某个项目：先把「新项目 id」和「它的名单」**一次性**写进 state，再补拉历史 / 项目记忆 /
   * 会话状态 / 资料列表。这样中间不会出现「项目已经换了、名单还是上一个项目的」那一帧。
   *
   * **绝不碰浏览器**：所有智能体、所有页的页宿主一直挂着（第 20 步的规矩，ADR-0002 起即 view-host 视图），
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

  /**
   * 批次 M · 逻辑抽离第 4 片：项目列表 / 切换 / 新建搬进 `features/projects`。
   * ★ **进入项目（enterProject）留在上面这一层** —— 它要同时动 chat / memory / knowledge 三块，
   *   属于跨 feature 协调，按拍板只能待在组合层；这里把它注入给 hook。
   * ★ 同名解构 → 下面 JSX（disabled={projectBusy} 等）一个字都不用改。
   */
  const {
    projects,
    projectsOpen,
    setProjectsOpen,
    projectBusy,
    projectNote,
    projectErr,
    newProjectName,
    setNewProjectName,
    loadProjects,
    switchProject,
    createProject,
    resetProjects,
  } = useProjects({
    sessionRef,
    curProjectRef,
    onCurrentProject: setCurProjectId,
    onEnterProject: enterProject,
  });

  /** 切智能体 = 换一份聊天：换消息列表、换项目记忆 */
  const selectAgent = (agent: AgentView) => {
    if (agent.id === curAgentRef.current) return;
    curAgentRef.current = agent.id; // 立刻生效，免得同一 tick 里的回调写错桶
    setCurAgentId(agent.id);
    // 第 20 步：切智能体 = 换一套浏览器（tab / 当前页 / cookie 都按智能体分开），
    // 但**只换「哪一桶可见」**——所有页的页宿主一直挂着不卸载，
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
    // G1（2026-09-25,规格 C1 收紧）：**只有小助（管家, kind='assistant'）能建智能体**。
    // 服务端闸同口径（POST /agents 只放 assistant）；前端只认小助,母鸡/普通智能体一律不挑（不猜）。
    return (
      list.find(
        (a) => a.kind === 'assistant' && a.canCreateAgents === true && (pid === null || a.projectId === undefined || a.projectId === pid),
      ) ?? null
    );
  };

  /**
   * 批次 E | 对话式建智能体、立刻建好不挡你
   * quickBuildAgent：从提议或对话里直接建一个带人设的智能体，不走 pending 引导表，立刻 ready
   */
  const quickBuildAgent = async (name: string, duty: string) => {
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
        setAgentNote('这个项目里没有小助（管家），建智能体得由管家来办。');
        return;
      }
      const r = await authFetchJson<AgentCreateResult>('/agents', {
        method: 'POST',
        body: JSON.stringify({ asAgentId: creator.id, name: name.slice(0, 24), duty: duty.slice(0, 120) }),
        headers: { authorization: `Bearer ${sess.token}` },
      });
      const a = r.agent;
      if (curProjectRef.current !== null) agentProjectRef.current.set(a.id, curProjectRef.current);
      setAgents((prev) => prev.concat(a));
      historyLoadedRef.current.add(a.id);
      patchChat(a.id, () => ({ messages: [], convId: a.conversationId }));
      curAgentRef.current = a.id;
      setCurAgentId(a.id);
      setProjMem([]);
      setProjMemOpen(false);
      setChatNote(`已建好「${a.name}」：${duty}。直接和TA聊就行。`);
    } catch (e) {
      setAgentNote(`快捷建没成：${(e as Error).message}`);
    } finally {
      setAgentBusy(false);
    }
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
        setAgentNote('这个项目里没有小助（管家），建智能体得由管家来办。');
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
      // M2':刚创建脉冲（真事件驱动；动画 1.4s，1.6s 后摘 class 防止卡住）
      setJustAddedAgentId(a.id);
      if (justAddedTimerRef.current) clearTimeout(justAddedTimerRef.current);
      justAddedTimerRef.current = setTimeout(() => setJustAddedAgentId(null), 1600);
      historyLoadedRef.current.add(a.id);
      patchChat(a.id, () => ({ messages: [], convId: a.conversationId }));
      curAgentRef.current = a.id;
      setCurAgentId(a.id);
      setProjMem([]);
      setProjMemOpen(false);
      setChatNote('');
      /**
       * 规格 C1：「＋添加」路径同样走 chips（不再是旧的大表格）—— 占位名「新智能体」
       * 多一个改名 chip（nameIsPlaceholder=true）；用户可点/可自己写/可跳过。
       */
      const addBase: PersonaChipsDraft = {
        agentId: a.id,
        name: a.name,
        nameIsPlaceholder: a.name === '新智能体',
        who: a.persona?.who ?? '',
        tone: a.persona?.tone ?? '',
        duty: a.persona?.duty ?? '',
        antiJobs: a.persona?.antiJobs ?? '',
      };
      setChipsBase(addBase);
      setChipsDraft(addBase);
      setChipsTouched({});
    } catch (e) {
      setAgentNote(`添加没成：${(e as Error).message}`);
    } finally {
      setAgentBusy(false);
    }
  };

  /** 引导表确认：存人设 → 这个智能体从这一刻起按这份描述干活（建完也能改） */
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
    setPersonaEditOpen(false);
    setPersonaEditAgentId(null);
  };

  const openPersonaEdit = (agent: AgentView) => {
    setPersonaEditAgentId(agent.id);
    setPersonaEditDraft({
      name: agent.persona?.name || agent.name || '',
      who: agent.persona?.who || '',
      tone: agent.persona?.tone || '',
      duty: agent.persona?.duty || '',
      antiJobs: agent.persona?.antiJobs || '',
      description: agent.persona?.description || '',
    });
    setPersonaEditOpen(true);
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

  /**
   * 记忆的 5 个写操作（忘掉 / 确认 / 拒绝 / 批量确认 / 批量拒绝）也搬进 `features/memory`，
   * 见上面的 useMemory 解构 —— 本文件只留调用点。
   */

  /**
   * 批次 M · 逻辑抽离第 1 片：资料（知识库）的逻辑搬进 `features/knowledge`。
   *
   * ★ 这里**只换来源，不改名字**：下面解构出来的 `knowledgeDocs` / `loadKnowledge` …
   *   与原变量同名，所以本文件 3714 行里的 JSX **一个字都不用改**（用户 2026-09-24 的叫停：
   *   设计语言未定稿前不搬 JSX/CSS，只抽逻辑）。
   * ★ `sessionRef` / `curProjectRef` 是**注入**进去的（hook 不自己持有真相）——
   *   这两个镜像 ref 一个都没删，见本文件里"最新值镜像"那条注释。
   */
  const {
    documents: knowledgeDocs,
    setDocuments: setKnowledgeDocs,
    open: knowledgeOpen,
    setOpen: setKnowledgeOpen,
    uploading: knowledgeUploading,
    note: knowledgeNote,
    deletingId: knowledgeDeletingId,
    fileRef: knowledgeFileRef,
    load: loadKnowledge,
    upload: uploadKnowledgeFile,
    onChooseFile: onChooseKnowledgeFile,
    remove: deleteKnowledgeDoc,
    reset: resetKnowledge,
  } = useKnowledge({ sessionRef, curProjectRef });

  /**
   * 任务三件套（`refreshTask` / `openTaskResult` / `downloadTaskDoc`）搬进 `features/tasks` 了，
   * 见上面的 useTasks 解构 —— 本文件只留调用点。
   */
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
    resetProjects();
    curProjectRef.current = null;
    // Phase 3：换号了就把「agentId → projectId」清掉（id 会跨账号复用，留着会把分区认错人）
    agentProjectRef.current.clear();
    setCurProjectId(null);
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

  /**
   * 登出 = **两半**（这一片有意切开的）：
   *   ① 会话那一半 → `signOutSession()`（清 token / 清主进程凭证 / 清分区白名单 / session 置空）；
   *   ② 跨 feature 清场那一半 → 下面这些 reset（聊天 / 名单 / 两层记忆 / 资料 / 任务 / 网页）。
   * 本函数只剩"顺序"，两半各归各位 —— 这也是它必须留在 App 的原因。
   */
  const onLogout = () => {
    signOutSession();
    // 第 6 步：聊天痕迹也清掉（历史本来就在服务端，重启登录后由 /chat/history 还原）
    // 聊天这一侧（提示 / 流式文本 / 所有智能体的聊天缓存 / 历史账本 / 步骤 / 文档）一次清干净
    resetChat();
    setCurAgentId(null);
    curAgentRef.current = null;
    setAgents([]);
    setAgentNote('');
    setUserMem([]);
    setUserMemOpen(false);
    setProjMem([]);
    setProjMemOpen(false);
    setPendingMem([]);
    setPendingMemOpen(false);
    // 子阶段 2-B：项目层也清掉（换号不该看见上一个号的项目名/名单）
    resetProjects();
    curProjectRef.current = null;
    setCurProjectId(null);
    setAgentStates({}); // 第 16 步：会话状态（当前任务/保活）不留在登录页
    setKeepaliveBusy(false);
    // 第 7 步：驾驶员循环和 token 一并停掉/清掉（主进程里也不留）
    void window.workbench?.agentStop();
    // 第 18 步：所有网页一并关掉（换号不该看见上一个号的网页）——由浏览器工作区自己清
    browser.closeAllTabs();
    resetTasks();
    setAgentAwaitInfo(false);
    setAgentAwaitAgent(null);
    // 资料（知识库）的清理收进 feature：documents / open / uploading / deletingId / note 一次清干净
    resetKnowledge();
  };

  // ---- 第 18 步：中栏浏览器工作区（第 20 步起：**每个智能体一套独立浏览器**，活页上限全局默认 4 张、设置可调大）----
  /**
   * 浏览器相关的**全部状态与动作**都在 apps/desktop/src/browser/ 里，这里只把它挂上：
   *   - 按智能体分桶的 tab 状态、开页/关页、同站复用、驾驶接口 → browser/useBrowserWorkspace.ts
   *   - URL 栏 / 页宿主（view-host 视图落位）/ 桌面侧协议闸 → browser/BrowserPanel.tsx、browser/url.ts
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
  /** ★ 片 7b：聊天侧要指挥浏览器工作区，而它的定义在这里 → 镜像给它（见上面 browserRef 的说明） */
  browserRef.current = browser;

  /**
   * 批次 M · 逻辑抽离第 3 片：跨 chat × browser 的胶水（求助卡 / 上下文没了确认卡 / 窗口几何）
   * 搬进 `app/browserGlue.ts`。★ 仍然**只换来源、不改名字** → 下面 4 处 JSX 一个字都不用改。
   */
  const {
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
  } = useBrowserGlue({ browser, curAgentId, onNote: setChatNote });

  /**
   * 批次 M-2 · 第四列(浏览器区):隐藏 / 第四列 / 覆盖(盖聊天、可拖到全宽)三形态。
   * 状态与交互在 app/useBrowserColumn.ts(左缘拖动 / 阈值 / 记忆宽度);
   * browser/ 的 view 三态原样驱动(showFullscreen ↔ 列可见, exitFullscreen ↔ 列隐藏)。
   */
  const col = useBrowserColumn();

  /**
   * ★★ 2026-09-26 修「浏览器空白」· ADR-0005:列的可见性以 `browser.view` 为**单一真相**。
   *
   * 症状(用户报的):聊天里说「打开抖音」→ 标签建了、页也真加载了,右侧却看不见。
   * 根因:第四列的可见性 = `col.colOpen && browser.view === 'fullscreen'`(见下方层 class),
   * 而 `browser.openUrl` 只写了 `setView('fullscreen')`(它自己的语义就是「用户明确要看浏览器」),
   * **没有任何人把这件事告诉外壳的列** —— 于是层落进 `--hidden`(transform 移出视野),
   * 页成了「已创建、已加载、但不在视野里」。
   *
   * 为什么在这里兜而不是在 `openUrl` 里补一句 `col.openColumn()`:
   *   · `browser/` 是 feature 层,不许反向依赖外壳的列状态(分层规则,见 app/browserGlue.ts 头注释);
   *   · 逐个调用点补 = 以后每加一个开页入口就再踩一次(真机上 `openFromMain` 那条就同样漏了)。
   * 所以:**任何让 view 变成 fullscreen 的路径,列自动打开** —— 一条 effect 兜住全部入口。
   *
   * 反向不受影响:「💬 对话」走 `exitFullscreen()`(view→background)+ `hideColumn()`,
   * 两者同进同退;`openFromPage`(AI 自己开页 / target=_blank)不碰 view,
   * 「AI 开页不抢用户视线」的第 28 步拍板原样保留。
   */
  useEffect(() => {
    if (browser.view === 'fullscreen') col.openColumn();
    // col.openColumn 是稳定引用(useCallback + setState),不参与依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browser.view]);

  /**
   * 批次 M-2':第二列宽度的拖动/记忆(app/useSidebarColumn),与第四列互不引用。
   * 侧栏三个纯 UI state:搜索词(真名单过滤)、＋弹层开合、刚创建脉冲(真事件驱动)。
   */
  const sb = useSidebarColumn();
  const [agentQuery, setAgentQuery] = useState('');
  const [showAgentPopup, setShowAgentPopup] = useState(false);
  const [justAddedAgentId, setJustAddedAgentId] = useState<number | null>(null);
  const justAddedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 第四列触发 ①:点会话内链接/HTML 卡片 → 内嵌浏览器打开 + 列弹出 */
  const openInBrowser = (url: string): void => {
    const agentId = curAgentRef.current;
    if (agentId !== null) void browser.openUrl(agentId, url);
    col.openColumn();
  };

  /**
   * 收尾 7 | 读回这个智能体自己存的可见度档位（切换智能体 / 登录态变化时各读一次）。
   *
   * ★ 读不到（未登录、网络、老后端没这条路由）就**保持当前档位不动**，绝不回落成 `status` 再写回去 ——
   *   那会把「读不到」变成「用户选了收起」，把人家存的偏好抹掉（与 R2 那条「不猜、不冒充」同一个道理）。
   * ★ `off` 标志防卸载/切人之后 setState（这条规矩在本文件里已经是既有做法）。
   */
  useEffect(() => {
    let off = false;
    const agentId = curAgentId;
    if (!agentId || !session?.token) return () => { off = true; };
    void loadVisibility({ apiBase: API_BASE(), token: session.token, agentId }).then((v) => {
      if (off || !v) return;
      // 读回来的档位如果是「接管」，也要把浏览器前置 —— 否则重开应用后档位说是接管、页却在后台
      setComputerVisibility(v);
      if (v === 'takeover') {
        browser.showFullscreen();
        col.openColumn();
      }
    });
    return () => { off = true; };
    // browser.showFullscreen 是 hook 里的稳定回调；这里只按「换人 / 换登录态」重读
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curAgentId, session?.token]);

  /**
   * 切档：本地立刻生效 + 存回服务端（fire-and-forget，失败只 warn 不弹错 —— 这是偏好，不是数据）。
   *
   * ★ 这里**只**碰视图：`showFullscreen()` 是既有的视图开关（「跟任务执行毫无耦合」是它自己的注释）。
   *   不调 loop 的 start/stop/pause、不调 throttle —— 「收起面板」绝不等于「停下任务」，
   *   这条由 `scripts/verify/panel-visibility-coupling-probe.py` 与 H 的验收一起钉着。
   */
  const onChangeComputerVisibility = (v: ComputerVisibilityLevel): void => {
    setComputerVisibility(v);
    if (v !== 'status') {
      browser.showFullscreen();
      col.openColumn();
    }
    const agentId = curAgentId;
    const token = session?.token ?? null;
    if (!agentId || !token) return;
    void saveVisibility({ apiBase: API_BASE(), token, agentId }, v).then((ok) => {
      if (!ok) console.warn('[visibility] 档位没能存回服务端（本地已生效，重开应用会回到上次的档位）');
    });
  };

  /**
   * 喂给可见度条的真实状态（不是写死的假数据）：
   * · `status` / `statusDetail` / `statusStep` 来自左栏那一行智能体（头像即状态那套，服务端广播来的）；
   * · 当前这一步干什么，用主进程报上来的**最后一条步摘要**（`agentSteps` 的尾巴）；
   * · 页面摘要用当前那张页的标题（没有标题就用地址）。
   * 拿不到就是 null —— 组件那边会显示「空闲 / 暂无页面摘要」，不猜、不编。
   */
  const visAgent = agents.find((a) => a.id === curAgentId) ?? null;
  const visLastStep = agentSteps.length > 0 ? agentSteps[agentSteps.length - 1] : null;
  const visPage = browser.active ? browser.active.title || browser.active.url || null : null;

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

    /**
     * ★ F3 修复（2026-09-24，用户点名提前修）：**状态机镜像绝不许把整页搞白屏**。
     *
     * 原来这里是 `bridge.getTaskState().then(setTask)`，三处都不设防：
     *   ① `setTask` 收到 `undefined`（桥给不出状态）→ 渲染期读 `task.phase` → `TypeError` → 白屏；
     *   ② `bridge.getTaskState` **根本不是个函数**（老 preload / 渲染层与 preload 版本不一致）
     *      → 同步 `TypeError`，比 ① 更直接；
     *   ③ 广播那条路只挡了空负载：`JSON.parse('null')` 得到 `null` 是**合法解析**，
     *      于是 `setTask(null)` → 同样白屏（`if (!payload)` 挡不住字符串 `"null"`）。
     *
     * 现在：**先校验形状，再落 state**；拿不到就保持上一次的值，并把兜底文案写在状态行上。
     * 注意这不是"猜一个状态"——权威始终在主进程，这里只是**不因为读不到而崩**。
     *
     * 顺带说明（用户第 2 条问的那件事）：`getTaskState` 走的是 IPC 到主进程
     * （`workbench:task:state` → `driver.getTaskState` → `aggregateState`，**永远有返回值**），
     * 所以"服务端重启"这条路上它**不会**返回 undefined；真正会白屏的是上面 ①②③ 三条。
     */
    const isTaskState = (v: unknown): v is TaskState =>
      !!v && typeof v === 'object' && typeof (v as TaskState).phase === 'string';
    try {
      const maybe = bridge.getTaskState?.();
      void Promise.resolve(maybe)
        .then((raw) => {
          if (isTaskState(raw)) setTask(raw);
          else setTask((s) => ({ ...s, detail: '拿不到主进程状态（桥返回了空值），状态行保持上一次的值' }));
        })
        .catch(() => setTask((s) => ({ ...s, detail: '读取主进程状态失败（preload 桥异常）' })));
    } catch {
      // `bridge.getTaskState` 不存在 / 不是函数：同步异常也要吃掉，绝不让 effect 抛出
      setTask((s) => ({ ...s, detail: 'preload 桥缺少 getTaskState（版本不一致？），状态行不可用' }));
    }
    const offState = bridge.on('state', (payload) => {
      if (!payload) return;
      try {
        const parsed: unknown = JSON.parse(payload);
        // ★ F3-③：解析成功不代表形状对（`'null'` / `'{}'` 都能解析）—— 形状不对就忽略，等下一次广播
        if (isTaskState(parsed)) setTask(parsed);
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
          showHelp({
            wcId: p.wcId as number,
            agentId: ownerAgent,
            helpKind: p.helpKind,
            question: p.question,
            hint: p.hint,
          });
          browser.enterEmbed(p.wcId);
        }
        void browser.refreshDriving();
      } else if (p.kind === 'help-clear') {
        // 求助已解除（自动感知到页面变化 / 用户点了按钮 / 任务收尾）→ 收卡片 + 退出该视图
        clearHelp(ownerAgent);
        clearEmbed();
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
        askLoopGone(p.wcId, p.question);
        void browser.refreshDriving();
      } else if (p.kind === 'done') {
        setAgentAwaitInfo(false);
        setAgentAwaitAgent(null);
        setAgentAwaitWcId(null);
        // 第 27 步：任务收尾了，求助卡就没有存在意义了（留着会是一张点不动的卡）
        clearHelp(ownerAgent);
        clearEmbed();
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



  // 批次 E：砍掉一切仪表盘，临时测试条已移除（暂停/继续走浏览器原生控制或输入「停」）

  /**
   * 上面这块（「这一轮的上下文没了」确认卡 / 求助卡分桶 / 窗口几何 / 切智能体同步视图 / 卡片两个按钮）
   * 已整体搬进 `app/browserGlue.ts`，见上面的 useBrowserGlue 解构。
   */
  // 批次 E：activeTabId 轮询已移除（仪表盘砍掉）

  // 批次 E：driveBarAct 已移除（仪表盘砍掉，暂停/继续走 detectStopIntent 或浏览器控制）

  // 第 5 步门控：未登录（或正在用存好的 JWT 换会话）时，工作台整体不渲染——不做“游客看假数据”
  if (checkingAuth) {
    return (
      // F4：占位页与真登录页各带修饰类（不再共用裸 .authWrap 一名两义）
      <div className="authWrap authWrap--checking">
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
  /**
   * G1（2026-09-25,规格 C1 收紧）：「＋ 添加」只在小助（管家）上下文生效。
   * xiaozhuId = 当前项目里的小助（kind='assistant'）；addEnabled = 正在跟小助聊 + 不忙。
   * 不在小助上下文 → 按钮置灰（服务端同样只放 assistant,双保险）。
   */
  const xiaozhuId = sidebarAgents.find((a) => a.kind === 'assistant')?.id ?? null;
  const addEnabled = !agentBusy && curAgentId !== null && curAgentId === xiaozhuId;
  /** M2':侧栏搜索 = 对真名单做实时过滤（空 = 全名单） */
  const filteredAgents = agentQuery.trim()
    ? sidebarAgents.filter((a) => a.name.toLowerCase().includes(agentQuery.trim().toLowerCase()))
    : sidebarAgents;
  /** 第 16 步：当前智能体的会话状态（服务端为准）——状态行与保活按钮都读它 */
  const curState = curAgentId === null ? undefined : agentStates[curAgentId];
  /**
   * 当前智能体这一轮用户原话**本身**就是确认（明确开页指令，或对确认提问回了「继续/可以」）。
   * 是的话就不再挂确认按钮——事情已经在做了，再要确认就是自相矛盾（第 13 步的规矩）。
   */
  const curConfirmed = curAgentId !== null && Boolean(lastUserWasOpenRef.current[curAgentId]);

  return (
    <div
      className={col.colOpen && browser.view === 'fullscreen' && col.colMode === 'column' ? 'app app--col' : 'app'}
      ref={col.frameRef}
      style={{ '--browser-w': `${col.colWidth}px`, '--sb-w': `${sb.sbWidth}px` } as React.CSSProperties}
    >
      {/*
        M3':第一列（玻璃栏）—— 结构跟设计基准 workbench-ui 的 Rail,内容全是真功能:
        顶部 = 用户头像块（真:登录会话对外号首字）;中段 = 两颗**真**视图开关
        （与旧顶栏按钮同源,第四列状态接线一字未动）+ 条件渲染的编辑人设;
        其下 = 真名单 chip（与第二列同数据源,点击 = 真切换）+ ＋ 真新建。
        微信 5 tab（假子视图）/ 汉堡（无真功能）不搬。
      */}
      <nav className="rail" aria-label="主导航">
        <div
          className="menu-btn"
          title={session ? (session.user.phone_masked || session.user.xyz_id || '已登录账号') : '未登录'}
        >
          <span className="user-avatar-ico" aria-hidden="true">
            {session ? userAvatarChar(session.user) : '·'}
          </span>
        </div>
        <button
          type="button"
          className={`tab tab--chat ${!col.colOpen || browser.view !== 'fullscreen' ? ' selected' : ''}`}
          style={{ top: 72 }}
          onClick={() => {
            browser.exitFullscreen();
            col.hideColumn();
          }}
          aria-label="对话模式"
          title="💬 对话"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M4 5.5h16v11H9l-5 4z" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          className={`tab tab--browser ${browser.view === 'fullscreen' && col.colOpen ? ' selected' : ''}`}
          style={{ top: 122 }}
          onClick={() => {
            if (browser.tabs.length === 0) {
              browser.openNewTab();
            }
            browser.showFullscreen();
            col.openColumn();
          }}
          aria-label="启用浏览器"
          title="🌐 启用内嵌浏览器工作台（没有标签页时自动打开主页）"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <circle cx="12" cy="12" r="8.5" />
            <path d="M3.5 12h17" />
            <path d="M12 3.5c2.5 2.3 3.8 5.2 3.8 8.5s-1.3 6.2-3.8 8.5c-2.5-2.3-3.8-5.2-3.8-8.5s1.3-6.2 3.8-8.5z" />
          </svg>
          {browser.tabCount > 0 && <span className="workbenchNav__badge">{browser.tabCount}</span>}
          {browser.drivingIds.length > 0 && <span className="workbenchNav__driving" title="AI 正在操作网页" />}
        </button>
        {curAgent && curAgent.kind !== 'assistant' && curAgent.personaStatus === 'ready' && (
          <button
            type="button"
            className="tab tab--persona"
            style={{ top: 172 }}
            onClick={() => openPersonaEdit(curAgent)}
            aria-label="编辑人设"
            title="编辑人设：名称 / 它是谁 / 怎么说话 / 干什么"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M14.5 5.5l4 4L8 20H4v-4z" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <div className="agent-list" aria-label="智能体">
          {sidebarAgents.map((a) => (
            <div
              key={a.id}
              role="button"
              tabIndex={0}
              className={`agent-chip${a.id === curAgentId ? ' selected' : ''}${justAddedAgentId === a.id ? ' agent-pop' : ''}`}
              title={a.name}
              aria-label={a.name}
              style={{ '--c1': agentColor(a) } as React.CSSProperties}
              onClick={() => selectAgent(a)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  selectAgent(a);
                }
              }}
            >
              {agentGlyph(a)}
            </div>
          ))}
          <button
            className="rail-quick-add"
            aria-label="快捷新建智能体"
            title={addEnabled ? '新建智能体' : '只有在小助（管家）这儿才能建智能体'}
            disabled={!addEnabled}
            onClick={() => void addAgent()}
            type="button"
          >
            <i className="qadd-h" />
            <i className="qadd-v" />
          </button>
        </div>
      </nav>

      {/*
        左侧：**智能体列表**（自带「小助」+ 用户点「添加」建的）。
        第 15 步起这里不再是一个写死的联系人——一个智能体一行，点一行就换一份聊天。
        「＋ 添加」不弹独立设置窗、不开新 BrowserWindow：服务端建好智能体 + 空会话，直接切过去。
      */}
      <aside className="sidebar">
        {/*
          M2':搜索胶囊 + 「＋」—— 过滤是对**真名单**实时做的、弹层里只有真操作（新建 / 删当前），
          设计基准里「添加联系人（占位）alert」那种假动作不搬。
        */}
        <div className="search-pill search-component" data-state={agentQuery ? 'filled' : 'default'}>
          <span className="search-ico" aria-hidden="true">
            <svg viewBox="0 0 18 18">
              <circle cx="7.4" cy="7.4" r="4.7" fill="none" stroke="rgba(255,255,255,0.58)" strokeWidth="1.8" />
              <path d="M10.9 10.9L15.2 15.2" fill="none" stroke="rgba(255,255,255,0.58)" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <input
            className="search-field"
            type="text"
            value={agentQuery}
            autoComplete="off"
            spellCheck={false}
            placeholder="搜索智能体"
            aria-label="搜索智能体"
            onChange={(e) => setAgentQuery(e.target.value)}
          />
          {agentQuery && (
            <button className="search-clear" aria-label="清空搜索" onClick={() => setAgentQuery('')} type="button" />
          )}
        </div>
        <button
          className="add-btn"
          aria-label="新建"
          onClick={() => setShowAgentPopup((v) => !v)}
          type="button"
        />
        <div className={`add-popup${showAgentPopup ? ' open' : ''}`}>
          <div
            className={`opt${addEnabled ? '' : ' opt--disabled'}`}
            title={addEnabled ? undefined : '只有在小助（管家）这儿才能建智能体'}
            onClick={() => { if (addEnabled) { setShowAgentPopup(false); void addAgent(); } }}
          >
            <span>{agentBusy ? '创建中…' : addEnabled ? '新建智能体' : '新建智能体（仅小助可建）'}</span>
          </div>
          {curAgent && curAgent.deletable && (
            <div className="opt opt--danger" onClick={() => { setShowAgentPopup(false); void deleteAgent(curAgent.id); }}>
              <span>删掉「{curAgent.name}」</span>
            </div>
          )}
        </div>
        <div className="sidebar__body">

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
            {/* F2-③：成功/失败两个槽 + 两套样式（失败槽 = 红，一眼看出坏没坏） */}
            {projectNote && <div className="small projectBox__note">{projectNote}</div>}
            {projectErr && <div className="small projectBox__note projectBox__note--err">{projectErr}</div>}
          </div>

          <div className="agentList">
            {/* M2':行结构换设计基准 .contact-item(头像块/名字/真实状态行),数据仍是真名单;
                新建/删除收进顶栏「＋」弹层(真操作),不再摆两个按钮 */}
            <div className="contact-list" role="list" aria-label="我的智能体">
              {filteredAgents.map((a) => (
                <button
                  type="button"
                  role="listitem"
                  key={a.id}
                  data-agent-id={a.id}
                  className={`contact-item${a.id === curAgentId ? ' active' : ''}${justAddedAgentId === a.id ? ' just-added' : ''}`}
                  onClick={() => selectAgent(a)}
                >
                  <span
                    className="contact-avatar"
                    style={{ '--c1': agentColor(a) } as React.CSSProperties}
                    aria-hidden="true"
                  >
                    {agentGlyph(a)}
                    {a.kind === 'assistant' && hasUnread && (
                      <span className="red-dot" title={curTask?.unreadHint || '任务结果待查看'} />
                    )}
                  </span>
                  <span className="contact-body">
                    <span className="contact-line">
                      <span className="contact-name">{a.name}</span>
                    </span>
                    <span className="contact-line">
                      <span className="contact-msg">{agentStatusLine(a)}</span>
                    </span>
                  </span>
                </button>
              ))}
              {filteredAgents.length === 0 && (
                <div className="small contact-list__empty">没有匹配「{agentQuery}」的智能体</div>
              )}
            </div>
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
            {/* 规格 C4（2026-09-25）：待确认记忆不再走侧栏面板 —— 确认卡进对话流（见聊天区 <MemoryConfirmCard/>）。
                这里只留两层记忆的**只读**查阅（用户记忆 / 项目记忆）。 */}
            <div className="buttons-row">
              <button type="button" className="btn" onClick={() => setUserMemOpen((v) => !v)}>
                用户记忆（{userMem.length}）
              </button>
              <button type="button" className="btn" onClick={() => setProjMemOpen((v) => !v)}>
                项目记忆（{projMem.length}）
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
            {/* 规格 C4（2026-09-25）：旧的侧栏「待确认」面板（抽屉式确认路径）已移除 ——
                待确认记忆的确认卡现在渲染在**对话流里**（聊天区 <MemoryConfirmCard/>）。 */}
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


        </div>
        <div className="sidebar__footer demoOnly">桥：{bridgeInfo}</div>
      </aside>

      {/*
        M2':第二↔三列可拖动分隔条 —— 拖动改 --sb-w(记忆 localStorage)、双击复位。
        第三列(chat/browserLayer)是 flex 流自动跟,不用单独改宽度;与第四列状态互不引用。
      */}
      <div
        className={`splitter${sb.dragging ? ' dragging' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="侧栏宽度"
        title="拖动调整侧栏宽度 · 双击复位"
        onPointerDown={sb.splitterDown}
        onPointerMove={sb.splitterMove}
        onPointerUp={sb.splitterUp}
        onDoubleClick={sb.resetSbWidth}
      />

      {/* 中间：**钉住的浏览器工作区**（tab + URL 栏 + 当前页）+ 聊天区 */}
      <main className="middle">
        {/* M3': 常驻顶栏已改为第一列 rail（见 .app 的第一个孩子）—— 视图开关同源迁移,第四列接线未动 */}

        {/*
          多智能体编排 · 内部频道面板（只读）。
          盖在中栏上面（面板自己 position:absolute + inset:0，.middle 是定位上下文）。
          ★ token 从 session 传下去，组件自己不碰 localStorage —— 切号时 sessionRef
            那套「晚到的响应丢掉」的逻辑也就自然覆盖到它。
        */}
        {personaEditOpen && personaEditAgentId !== null && (
          <div className="personaEditOverlay" role="dialog" aria-label="编辑人设">
            <div className="personaEditCard">
              <div className="guide__head">编辑人设（建完也能改）</div>
              <div className="small">改完点确认，立刻按新描述干活；不改就点取消。</div>
              <table className="guide__table">
                <tbody>
                  <tr>
                    <th>名称</th>
                    <td>
                      <input className="guide__input" value={personaEditDraft.name} maxLength={24} placeholder="它叫什么？" onChange={(e) => setPersonaEditDraft((p) => ({ ...p, name: e.target.value }))} />
                    </td>
                  </tr>
                  <tr>
                    <th>它是谁</th>
                    <td>
                      <input className="guide__input" value={personaEditDraft.who} maxLength={120} placeholder="例如：一个只懂电商运营的老手" onChange={(e) => setPersonaEditDraft((p) => ({ ...p, who: e.target.value }))} />
                    </td>
                  </tr>
                  <tr>
                    <th>怎么说话</th>
                    <td>
                      <input className="guide__input" value={personaEditDraft.tone} maxLength={120} placeholder="例如：短句、直接、别客套" onChange={(e) => setPersonaEditDraft((p) => ({ ...p, tone: e.target.value }))} />
                    </td>
                  </tr>
                  <tr>
                    <th>干什么</th>
                    <td>
                      <input className="guide__input" value={personaEditDraft.duty} maxLength={120} placeholder="例如：帮我盯店铺数据、写商品标题" onChange={(e) => setPersonaEditDraft((p) => ({ ...p, duty: e.target.value }))} />
                    </td>
                  </tr>
                  <tr>
                    <th>不干什么</th>
                    <td>
                      <input className="guide__input" value={personaEditDraft.antiJobs ?? ''} maxLength={240} placeholder="例如：不碰敏感操作、不抢别的专员的活" onChange={(e) => setPersonaEditDraft((p) => ({ ...p, antiJobs: e.target.value }))} />
                    </td>
                  </tr>
                  <tr>
                    <th>整份人设</th>
                    <td>
                      <input className="guide__input" value={personaEditDraft.description ?? ''} maxLength={600} placeholder="完整人设正文（路由燃料 + 审批边界），可留空" onChange={(e) => setPersonaEditDraft((p) => ({ ...p, description: e.target.value }))} />
                    </td>
                  </tr>
                </tbody>
              </table>
              <div className="buttons-row">
                <button type="button" className="btn btn--go" disabled={!personaEditDraft.name.trim()} onClick={() => void savePersona(personaEditAgentId, personaEditDraft)}>
                  确认保存
                </button>
                <button type="button" className="btn" onClick={() => { setPersonaEditOpen(false); setPersonaEditAgentId(null); }}>
                  取消
                </button>
              </div>
            </div>
          </div>
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
            const view = driveStateView(task as any);
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
            规格 C1（2026-09-25）：旧「引导表」AgentGuide 已废 —— 新智能体的三问改
            输入框上方一行 chips（见下方 .inputbar 前的 <PersonaChips/>）。建好即 ready
            （默认人设），chips 只是可选精调：可点 / 可自己写 / 可跳过,打字/跳过/答完即消失。
          */}
          {messages.length === 0 && !streaming && (
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
                    col.openColumn();
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
            <div key={m.id}>
              {/**
                * 批次 J · 发言人名字牌：**只在换人的那一句上挂**。
                *
                * · 每条助手气泡都挂名字 = 噪音（99% 的话都是同一个「当前智能体」说的）；
                *   用户真正要一眼看出的是「这段对话里换过人」，所以只在与**上一条助手气泡**
                *   不是同一个人时才挂（第一条有 speaker 的也会挂 —— 前面没有可比的）。
                * · speaker 缺失（老数据 / 服务端没给）→ 什么都不挂，**不拿当前智能体冒充**。
                * · 版式见 design/11-chat-bubbles.css 的 .msg__speaker（小字、半透明、右对齐）。
                */}
              {(() => {
                const sp = m.role === 'assistant' ? m.speaker : undefined;
                if (!sp || !sp.name) return null;
                let prevSpeakerId: number | null | undefined;
                for (let i = idx - 1; i >= 0; i--) {
                  const x = messages[i];
                  if (x && x.role === 'assistant') {
                    prevSpeakerId = x.speaker ? x.speaker.id : null;
                    break;
                  }
                }
                if (prevSpeakerId === sp.id) return null;
                return (
                  <div
                    className="msg__speaker"
                    data-agent-id={sp.id}
                    title={`这句话是「${sp.name}」说的（智能体 #${sp.id}）`}
                  >
                    {sp.name}
                  </div>
                );
              })()}
              {/*
                规格 C3（2026-09-25）：协同进对话流（折叠）。
                【协同·xxx】前缀的消息（服务端 collabChat/chiefOfStaff 写进主会话）
                渲染成默认收起的一行摘要卡,点开看全文 —— 无抽屉、无仪表盘、无指派板。
              */}
              {m.role === 'assistant' && isCollabMessage(m.text) ? (
                <CollabCard text={m.text} />
              ) : (
                <div className={`msg ${m.role}`}>{m.text}</div>
              )}
              {/* 批次 E：第一个智能体提议同事，快捷建按钮（对话式建智能体、立刻建好不挡你） */}
              {m.role === 'assistant' && m.text.includes('建议先建这几位同事') && (
                <div className="colleagueProposal" style={{ padding: '6px 8px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {(() => {
                    const matches = [...m.text.matchAll(/\d+\. \*\*([^*]+)\*\*：([^（\n]+)/g)];
                    return matches.map((mat, i) => {
                      const name = mat[1].trim();
                      const duty = mat[2].trim();
                      return (
                        <button key={i} type="button" className="btn btn--go" onClick={() => void quickBuildAgent(name, duty)} title={duty}>
                          ＋ 建「{name}」
                        </button>
                      );
                    });
                  })()}
                </div>
              )}
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
                        onClick={(e) => {
                          // 批次 M-2 · 第四列触发①:会话内链接在**内嵌浏览器**打开(不再跳系统浏览器)
                          e.preventDefault();
                          openInBrowser(src.url);
                        }}
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
            规格 C4（2026-09-25）：记忆确认在**对话流里**,不弹抽屉。
            待确认记忆（decision/fact）就是聊天流里的一个节点（跟着消息一起滚动,
            与求助卡同一模式）：「确认，生效」= 真 POST /memories/confirm 进真表,
            「不用」= 真 POST /memories/reject。旧的侧栏「待确认（N）」面板已移除。
          */}
          {pendingMem.length > 0 && (
            <div className="memConfirmFlow">
              {pendingMem.map((m) => (
                <MemoryConfirmCard
                  key={m.id}
                  item={m}
                  onConfirm={(id) => void confirmMemory(id)}
                  onReject={(id) => void rejectMemory(id)}
                />
              ))}
            </div>
          )}
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

        {/* 规格 C1：三问 = 输入框上方一行 chips（替代旧引导表大表单）。
             可点（快速选项）/ 可自己写（内联输入框）/ 可跳过；
             打字（主输入框一有字）/ 跳过 / 全答完 → 即消失（没改过就不落库）。 */}
        {chipsDraft && curAgentId === chipsDraft.agentId && (
          <PersonaChips
            draft={chipsDraft}
            touched={chipsTouched}
            onField={onChipsField}
            onComplete={(f) => void finishChips(f)}
            onSkip={() => void finishChips(null)}
          />
        )}
        {/* 底部输入栏 —— 批次 M-4'：视觉搬入 design/04-inputbar.css（设计基准
             workbench-ui 的 pill 式输入栏）。真数据接线原样保留：
             input / onSend（useChat → /chat/stream SSE）/ tidyCurrentAgent。
             data-state 由真状态推导（empty / typing / thinking=streaming）。
             基准的假功能（CL 额度环 / 模型弹层 / 附件弹层 / 语音）不搬。 */}
        <div
          className="inputbar"
          data-state={streaming ? 'thinking' : input ? 'typing' : 'empty'}
        >
          <input
            className="inputbar-field"
            placeholder={
              runningLoopId && streaming
                ? '任务进行中：输入补充指令/追问注入上下文，或输入「停」暂停任务…'
                : streaming
                  ? '正在打字…'
                  : awaitHere
                    ? '回复小助的提问即可，发出后自动继续…'
                    : `和${curAgent ? `「${curAgent.name}」` : '小助'}聊聊（说“创建小美”立刻建好,不挡你）`
            }
            value={input}
            onChange={(e) => {
              const v = e.target.value;
              setInput(v);
              // C1：开始打字 = 不再折腾人设 → chips 即消失（已答的部分照常落库）
              if (v && chipsDraft) void finishChips(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && onSend()}
            disabled={streaming && !runningLoopId}
          />
          {/* 真文案（不是基准的 sparkle 图标）：桌面没有真「停止」按钮
               （停 = 输入「停」走 detectStopIntent），文字态永远要保留 */}
          <button type="button" className="inputbar-btn send" onClick={onSend} disabled={streaming && !runningLoopId}>
            {runningLoopId && streaming ? '发送补充' : streaming ? '打字中…' : '发送'}
          </button>
          {/* 第 15 步：结束这轮 → 把这段聊天**总结**进两层记忆（用户库 + 本项目记忆） */}
          <button
            type="button"
            className="inputbar-btn end"
            title="结束这轮聊天，把这段总结进两层记忆"
            onClick={() => void tidyCurrentAgent()}
          >
            结束
          </button>
        </div>
      </main>
      {/*
        批次 M-2 · **第四列(浏览器区)** —— 用户 2026-09-25 定稿:
        三形态 隐藏 / 第四列 / 覆盖(盖聊天、可拖到全宽),状态与交互在 app/useBrowserColumn。

        ★ 有活页时层**恒挂载**(有意卸载路径只有一条:allTabs 归零,见 M0 冒烟网);
          隐藏态 = transform 移出视野 —— **绝不 display:none、绝不尺寸归零、绝不卸载**:
          驾驶点击坐标依赖 webview 的真实几何,归零坐标全废(同 .browserLayer 旧注释的红线)。
        ★ 与 main.middle 是兄弟(不再嵌在中列里)—— 祖先链有意变更,M0 golden 已按
          `--update-golden` 显式更新;节点身份与「不许卸载」的规矩照旧由冒烟网钉住。
        ★ embed(求助卡)态与本三态正交:几何由 HelpCard 每帧量、BrowserPanel 写进 webview
          内联样式,舞台移动后相对量自动跟上(影子层机制自适配)。
      */}
      {browser.allTabs.length > 0 && (
        <div
          className={
            // 可见性 = colOpen(外壳侧) 且 view==='fullscreen'(browser/ 内部态):
            // 面板自己的「退出全屏」按钮走 view→background,同样把列收走 —— 两条路同归隐藏,不绕状态。
            // ★ 两个状态同进同退由上面那条 effect 兜住(ADR-0005:view→fullscreen ⇒ 列必开),
            //   否则「view 说要给人看、列没开」= 层被移出视野 = 页已加载却空白。
            browser.view === 'embed'
              ? 'browserLayer browserLayer--embed'
              : col.colOpen && browser.view === 'fullscreen'
                ? col.layerClass
                : 'browserLayer browserLayer--hidden'
          }
        >
          {col.colOpen && browser.view !== 'embed' && (
            <div
              className="browserCol__resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="拖动调整浏览器列宽(向左拖宽,过阈值变覆盖;向右收回)"
              onPointerDown={col.onResizerPointerDown}
              onPointerMove={col.onResizerPointerMove}
              onPointerUp={col.onResizerPointerUp}
              onPointerCancel={col.onResizerPointerUp}
            />
          )}
            {/*
              阶段简报 · 方案 B：**临时测试条**（本阶段只用临时按钮，正式 UI 不在本阶段做）。
              作用对象是「当前切到前面的那张页」（按钮点名它的 wcId），
              所以暂停这一路 = 只停这一路，别的页、别的智能体照跑。
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
            {/*
              收尾 7 | 批次 H 的三级可见度**第一次真的渲染出来**（以前只 export 没人用）。

              ★ 它与 BrowserPanel 是**兄弟**节点，不是把面板塞进它的 children：
                children 一旦随档位换父节点，React 就会卸载重建那个 <webview> —— 正在跑的那张页当场没了，
                驾驶的点击坐标也全废（`design/14-browser-column.css` 里 `.browserLayer--hidden` 的注释写的就是这个坑）。
                组件内部也已经改成「children 恒在同一个宿主里」，这边再保守一层，两条一起保证。
              ★ 它只改**看得见多少**，绝不改跑不跑：切档不调 loop 的任何接口（见 onChangeComputerVisibility）。
            */}
            <ComputerVisibility
              agentId={curAgentId}
              loopStatus={visAgent?.status ?? (runningLoopId ? 'running' : 'idle')}
              statusDetail={visAgent?.statusDetail ?? null}
              step={visAgent?.statusStep ?? null}
              currentTool={visLastStep}
              pageSummary={visPage}
              visibility={computerVisibility}
              onChange={onChangeComputerVisibility}
              apiBase={API_BASE()}
              token={session?.token ?? null}
            />
            <BrowserPanel
              ws={browser}
              agentLabel={agents.find((a) => a.id === curAgentId)?.name}
              /*
               * 第 27 步：求助卡模式下的几何（wcId + 那块"窗口"的位置）。
               * 非 embed 态时 wcId 为 null，面板会完全按老逻辑渲染 —— 零影响。
               */
              embed={{ wcId: browser.embedWcId, rect: embedRect }}
            />        </div>
      )}

      {/*
        第 13/17 步：右栏整个撤掉 —— 驾驶台、调试区、**任务卡**一律不画。
        第 17 步验收第 1 条就是「右栏驾驶台/任务卡看不见」，所以这里不是隐藏，是根本不渲染；
        任务结果改挂在聊天顶部那一行（结论本身早就在聊天里以「✅ 任务完成」给出了），
        第 8 步的「下载文档」能力不丢，右栏也不再占地方、更不会被当浏览器用。
      */}
    </div>
  );
}
