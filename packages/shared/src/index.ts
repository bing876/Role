/**
 * @ai-workbench/shared
 *
 * 只放「类型」——渲染进程、Electron 主进程、以及未来的 apps/server 都从这里取契约。
 * 全部是 type-only 导出，编译后不产生任何运行时代码，任何环境引入都零成本。
 *
 * 阶段 0 补充：`tools.ts` 是本包第一份**运行时**代码（Tool Registry 定义侧，
 * 零依赖纯模块）。**只有服务端在运行时 import 它** —— 桌面打包产物里没有
 * node_modules，Electron 主进程只能 import 本包的**类型**，详见 tools.ts 文件头。
 * 不要在这里加任何带 Node/Electron 依赖的运行时代码。
 */

/** 一条消息的角色 */
export type ChatRole = 'system' | 'user' | 'assistant';

/** 单条聊天消息 */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** ISO 8601 时间戳，例如 2026-09-11T10:00:00.000Z */
  createdAt: string;
}

/** 一个会话（消息列表 + 元信息） */
export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: string;
}

/**
 * 内嵌浏览器区域可订阅的事件名
 * （state：第 4 步状态机广播，payload 为 TaskState 的 JSON；
 *   settings：第 22 步配置变更广播，payload 为 WorkbenchSettings 的 JSON；
 *   resources：Phase 4 资源守护者广播，payload 为 ResourceAlert 的 JSON；
 *   opentab：第 23 步 —— 内嵌页里 in-page 的 window.open / target=_blank，
 *            主进程推给渲染层去**新开一条 tab**（payload 是 OpenTabRequest 的 JSON）。
 *            以前是「让同一个 guest 导航」，用户看到「点了链接当前页被换走、顶部还没多 tab」。）
 */
export type BrowserEvent =
  | 'open'
  | 'show'
  | 'hide'
  | 'focus'
  | 'state'
  | 'agent'
  | 'settings'
  | 'resources'
  | 'opentab';

/**
 * 第 23 步：「内嵌页想开新标签」的请求体。
 *
 * - url：页面要打开的地址（主进程已确认是 http(s)）
 * - agentId：**开那张源页的智能体**（主进程从 webviewOwner 查的，可能为 null）。
 *   渲染层据此保证「A 的页里点出来的新 tab 仍属于 A」，不串到别的智能体。
 * - sourceWcId：哪张 guest 触发的（渲染层可用来把新 tab 放在源页旁边）
 */
export interface OpenTabRequest {
  url: string;
  agentId: number | null;
  sourceWcId: number;
}

// ---------------------------------------------------------------------------
// 第 4 步：任务状态机
//
// 权威状态只有一个：主进程 electron/driver.ts 里的 phase；
// 渲染层的横幅 / 状态行只是它的镜像（通过 'state' 事件广播同步）。
// 约束不变：不接大模型——"决定下一步"是基于 read_page 快照的规则判断，
// 且永远不重放暂停前的步骤（恢复时先读用户当前真实页面，再决定）。
// ---------------------------------------------------------------------------

/** 状态机：idle 待命 → running 驾驶中 ⇄ paused 用户接管 → done / failed 终止 */
export type TaskPhase = 'idle' | 'running' | 'paused' | 'done' | 'failed';

/** 主进程广播 / getTaskState 返回的状态快照 */
export interface TaskState {
  phase: TaskPhase;
  /** 人可读的进度或失败原因，直接展示在界面上 */
  detail: string;
  /** 本次运行段已执行的步数（调试用） */
  step: number;
  /** 自动 click / type 当前是否被拒（主进程 paused 门的镜像，调试区据此如实显示） */
  blocked: boolean;
  /**
   * 人工介入卡片（第 27 步）：这次 `paused` **是谁发起的**。
   *
   * 为什么必须单独一维：用户主动按「暂停」和 AI 自己走不下去来求助，
   * 落到的 `phase` 都是 `paused` —— 界面原来只按 phase 取文案，
   * 两种情况被压成同一句话「已暂停（页面归你操作）」，用户分不清是谁在等谁。
   * 现在 `phase` 管"停没停"、`pausedBy` 管"谁发起的"，颜色/图标/文案三者都跟着它走。
   *
   *   - `'user'`  = 用户主动接管（琥珀色 · ✋）
   *   - `'agent'` = AI 主动求助（蓝色 · 🤖）
   *   - `null` / 省略 = 不是暂停态，或分不清（界面按中立样式显示，不冒充任何一方）
   */
  pausedBy?: 'user' | 'agent' | null;
  /**
   * 第 22 步：这份状态属于**哪一张内嵌页**（guest webContents id）。
   *
   * 状态机本身已按 target 独立存储，所以每份状态都知道自己是谁的；
   * 左栏横幅拿到的**聚合视图**也会带上「代表性那一张」的 id（多路时可能省略）。
   */
  wcId?: number;
}

// ---------------------------------------------------------------------------
// 第 3 步：本地驾驶（遥控器先通，不接 AI）
//
// 一个动作进 → 在内嵌 webview 里执行 → 返回 { ok, pageSnapshot }。
// 这里只有类型，真正的执行在主进程 electron/driver.ts（webContents + CDP）。
// ---------------------------------------------------------------------------

/**
 * 可以在内嵌页上执行的动作。
 *
 * `ask_user` / `done` 本步**只定类型、不接业务**（第 3 步不接大模型），
 * 执行器遇到它们只会返回“未实现”，留着给后面的步骤填。
 */
export type BrowserAction =
  | { action: 'open_url'; url: string }
  | { action: 'click'; target: string }
  | { action: 'type'; target: string; text: string; submit?: boolean }
  | { action: 'scroll'; direction: 'up' | 'down' }
  | { action: 'wait'; seconds: number }
  | { action: 'read_page' }
  | { action: 'screenshot' }
  | { action: 'ask_user'; reason: string; question: string }
  | { action: 'done'; summary: string; document_title: string; document_outline: string[] }
  /**
   * 第 9 步：一次性代填【普通】字段（姓名/地址/搜索词…）。
   * 敏感字段（密码/验证码/支付/身份证）服务端与本地执行器都有硬闸，填了也会被拒。
   */
  | { action: 'fill_form'; fields: { target: string; text: string }[] }
  /** 第 9 步：定位敏感字段（不带任何值）：聚焦输入框 + 等用户输完自动恢复驾驶 */
  | { action: 'focus_sensitive_field'; target: string; fieldReason: string };

/** 动作名，便于日志与结果回执 */
export type BrowserActionType = BrowserAction['action'];

/**
 * 回执里可能出现的动作名：要么是一个合法动作，
 * 要么是 `'invalid'`（传进来的东西根本不是一个合法动作）。
 *
 * 为什么要单独给一个 `'invalid'`：`drive()` 现在会在执行前校验动作**形状**，
 * 形状不对时它连"这是哪个动作"都答不上来。与其硬塞一个假的动作名（会误导日志与调试区），
 * 不如如实说"这个入参不是合法动作"。
 */
export type DriveActionLabel = BrowserActionType | 'invalid';

/** 内嵌页当前状态的只读快照（read_page 的返回值） */
export interface PageSnapshot {
  /** 当前地址 */
  url: string;
  /** document.title */
  title: string;
  /** 可见按钮上的文字 */
  buttons: string[];
  /** 可见链接上的文字 */
  links: string[];
  /** 可见输入框的可读标识（placeholder / name / 当前值） */
  inputs: string[];
  /**
   * 第 21 步：可见正文片段（标题 / 段落 / 列表项上的文字，去重限长）。
   * 没有它，纯正文页（搜索结果、文章、列表）在模型眼里几乎是空的，
   * 「把这一页整理成列表」这类任务做不了。仍然只是片段，不是整页 HTML。
   */
  texts?: string[];
  /**
   * 第 9 步：字段分类标注（敏感字段不出现 value 的任何痕迹）。
   * 由本地 fieldClass.classifyField 生成——服务器只转述，不自己发明规则。
   */
  inputFields?: FieldClassInfo[];
  /**
   * 第 16 步：这一页像不像登录页（有 password 框，或标题/地址带登录字样）。
   * 工具层要能给出「失败原因 + 一个下一步」——「需要先登录」是最常见的真实原因之一。
   */
  loginLike?: boolean;
  /** 第 16 步：是否检测到疑似弹窗/遮罩（会挡住按钮，点击失败的常见原因） */
  overlay?: boolean;
  /**
   * 第 27 步：这一页像不像**验证码 / 滑块验证页**（页面级信号，不是字段级）。
   *
   * 与 `loginLike` 的分工：`loginLike` 管登录墙，这个管人机验证。
   * 只做"像不像"的保守判定（关键词 + 结构），**不保证是**；
   * 真正的求助触发还要叠加「AI 确实卡住了」这个条件（见 agent.ts 的保守触发闸），
   * 单凭它自己绝不弹卡片 —— 否则"路过一个登录页"也会打扰用户。
   */
  challengeLike?: boolean;
}

/** 一个输入框的分类信息（label 是给人和模型看的描述，绝不含敏感值） */
export interface FieldClassInfo {
  label: string;
  kind: 'sensitive' | 'normal';
  reason: string;
}

/** 一次动作的执行结果 */
export interface DriveResult {
  /** 是否执行成功 */
  ok: boolean;
  /** 回执是哪个动作；形状不合法时是 `'invalid'`（见 DriveActionLabel） */
  action: DriveActionLabel;
  /** 补充说明（例如「点击了 BUTTON「百度一下」」、type 实际用了哪种写入方式） */
  detail?: string;
  /** 执行后的页面快照（open_url / click / type / scroll / read_page 都会带上） */
  pageSnapshot?: PageSnapshot;
  /** 失败原因（可读文本，直接贴给用户看） */
  error?: string;
  /**
   * 第 28 步：**高风险动作被守卫挡下**的标记（用户 2026-09-21 定的口径）。
   *
   * ★ 为什么不能只靠 `error` 文案：以前守卫命中只是回一句 `ok:false` 的失败，
   *   模型收到后自己看着办 —— 可能问用户，也可能换个说法再点一次、或者干脆放弃，
   *   **不确定**。用户要的是"遇到高风险**一定**停下来申报"，所以必须是结构化标记，
   *   由驾驶循环**确定性地**走暂停 + 申报那条路，不依赖模型自觉。
   *
   * - `'pay'`     —— 付款 / 下单 / 提交订单 / 确认支付：AI 不代点，必须由用户自己点
   * - `'sensitive'` —— 密码 / 验证码 / 支付信息 / 身份证：AI 不代填，必须由用户自己输
   *
   * 一级（普通资料、下一步、选类目）不设这个字段 —— 那些 AI 全权自主，不用报备。
   */
  risk?: 'pay' | 'sensitive';
  /**
   * 第 17 步：动作执行了，但页面看不出任何变化（地址/标题/节点数都没动）。
   * 用来兑现「点了 2~3 次仍无变化 → 给原因 + 一个下一步」这条，
   * 不是失败（ok 仍为 true），只是给驾驶循环一个「这次多半没点中」的信号。
   */
  noChange?: boolean;
  /** screenshot 动作的产物：data URL，只放内存，不落库 */
  screenshot?: string;
}

/**
 * preload 通过 contextBridge 暴露到 window.workbench 的能力白名单。
 * 渲染进程只能看到这里声明的方法，拿不到 ipcRenderer / require / process。
 */
export interface WorkbenchBridge {
  /** 运行平台，例如 win32 / darwin / linux */
  platform: string;
  /** 应用版本号 */
  appVersion: string;
  /**
   * 是否运行在真实 Electron 环境（preload 恒为 true；浏览器直测垫片恒为 false）。
   *
   * ★ 渲染层靠它决定后端地址：true → 走 http://127.0.0.1:8787；false → 走相对路径（Vite 代理）。
   * 这个字段**必须存在** —— 缺失时 `!undefined` 为真，会被误判成 web 直测模式，桌面端将永远连不上后端。
   */
  isElectron: boolean;
  /** 连通性自检：主进程返回 pong */
  ping: () => Promise<string>;
  /** 打开内嵌浏览器区域；url 省略时沿用当前地址 */
  openBrowser: (url?: string) => Promise<void>;
  /** 显示内嵌浏览器区域 */
  showBrowser: () => Promise<void>;
  /** 隐藏内嵌浏览器区域 */
  hideBrowser: () => Promise<void>;
  /** 聚焦内嵌浏览器区域（隐藏时先显示） */
  focusBrowser: () => Promise<void>;
  /**
   * 第 3 步：在内嵌 webview 上执行一个动作（open_url / click / type / scroll / wait / read_page …）。
   *
   * @param action 要执行的动作
   * @param targetWebContentsId 内嵌 webview 的 guest webContents id
   *        （渲染层用 `webview.getWebContentsId()` 拿）。
   *        ⚠️ 第 22 步起**必须显式给出**：多张页并存时主进程不再「自己找一张」，
   *        省略（或给了已失效的 id）会直接返回失败 —— 这是预期的 fail-fast，不是回归。
   */
  drive: (action: BrowserAction, targetWebContentsId?: number) => Promise<DriveResult>;
  /**
   * 只读一次当前页面（等价于 drive({ action: 'read_page' })）。
   * ⚠️ 同 drive：第 22 步起必须显式给出 targetWebContentsId。
   */
  readPage: (targetWebContentsId?: number) => Promise<DriveResult>;
  /** 暂停驾驶：之后 click / type 一律拒绝执行，把页面交还给用户手动操作 */
  pauseDriving: () => Promise<boolean>;
  /** 恢复驾驶：允许再次自动 click / type */
  resumeDriving: () => Promise<boolean>;

  // ---- 第 4 步：任务状态机（idle | running | paused | done | failed）----
  /**
   * 启动任务：主进程先 read_page 读当前真实页面，再决定下一步；running/paused 中调用不产生副作用。
   * @param targetWebContentsId 第 22 步：要驾驶**哪一张**页。必须显式给出（不再盲选）；
   *        省略时沿用上一次那张（「暂停 → 继续」场景）；从来没有目标则当场置 failed。
   */
  startTask: (targetWebContentsId?: number) => Promise<TaskState>;
  /** 暂停：立即停止自动 click/type，内嵌页交还用户手点（running 时中断任务循环） */
  pauseTask: (targetWebContentsId?: number) => Promise<TaskState>;
  /** 继续：先 read_page 读用户当前真实页面再决定下一步，禁止重放暂停前的步骤 */
  resumeTask: (targetWebContentsId?: number) => Promise<TaskState>;
  /**
   * ★ P0 止血（2026-09-21）：回应「这一轮的上下文没了」（`kind:'loop-gone'` 那张卡）。
   *
   *   `restart` —— 用户明确确认后才新建一轮。**这是唯一**允许丢掉历史重新开始的入口。
   *   `giveup`  —— 不重开：lane 清掉、目标清掉、界面回到「已停止」，不留半死不活的状态。
   *
   * 为什么必须显式回话而不是让主进程自己决定：
   *   历史归零后模型不知道自己做过什么，目标里若有提交/下单/发送这类动作可能被再做一遍。
   */
  loopGoneChoice: (
    targetWebContentsId: number,
    choice: 'restart' | 'giveup',
  ) => Promise<TaskState>;
  /** 复位：任意状态回到 idle，用于从 done / failed 重新开始 */
  resetTask: () => Promise<TaskState>;

  /**
   * 第 7 步：启动云端驾驶员循环（一次一步）。
   * @param goal   用户确认过的任务目标
   * @param apiBase 后端地址（http://127.0.0.1:8787）
   * @param token  第 5 步的 JWT——只递给主进程用于请求头，绝不打印
   * @param targetWebContentsId 第 17 步：这次驾驶**哪一张**内嵌页的 guest id。
   *        两路并行时主进程按它分路——同一张页上的新指令覆盖旧指令，
   *        不同页上的指令互不干扰（第二句不会把第一张废掉）。
   * @param opts 第 21 步：工具循环的两个身份——
   *        `agentId`（这一路属于哪个智能体，服务端据此挡住串到别的 bot 的页）
   *        与 `loopId`（/chat/stream 已经建好的那个循环；不带就由主进程自己建一个）。
   */
  agentStart: (
    goal: string,
    apiBase: string,
    token: string,
    targetWebContentsId?: number,
    opts?: { agentId?: number | null; loopId?: string },
  ) => Promise<TaskState>;
  /** 中止**所有**驾驶员循环并清 token（退出登录时也要调） */
  agentStop: () => Promise<void>;
  /**
   * 第 16 步：**放下**当前驾驶员任务但保留登录凭证。
   * 用户改口（例如「打开油管」）时用它：旧任务立刻作废，不再被「继续」重启，
   * 也不会在下一轮把旧目标重新捡起来。
   *
   * 第 17 步：带 targetWebContentsId 时只放下**那一路**（那张页），别路的任务照跑；
   * 不带则放下全部（登出 / 停止）。
   */
  agentDrop: (targetWebContentsId?: number) => Promise<void>;
  /**
   * 第 17 步：当前正在驾驶的 webview guest id 列表。
   * 开第 3 张页时用它挑「没在跑的那张」顶掉——跑着的那张不能动。
   */
  agentLanes: () => Promise<number[]>;

  /**
   * Phase 3：把「这张内嵌页（guest webContents id）是哪个智能体开的」告诉主进程。
   *
   * 为什么需要：分区粒度改成按项目之后，主进程从分区名里只读得到**项目**，
   * 读不到智能体；而下载记录必须能标出「这是哪个智能体触发的」。
   * 渲染层在页就绪时登记一次，主进程据此给下载记录打 owner 标记。
   */
  browserOwner: (webContentsId: number, agentId: number) => Promise<void>;

  /**
   * 第 24 步：浅休眠 —— 把内嵌页的后台节流拉开/收紧。
   *
   * `throttle=true`：省 **CPU**（后台视频不再解码、定时器降频），
   * **不卸载页面**，所以唤醒是瞬时的、不会白屏。
   *
   * 主进程会拒绝对**正在被驾驶**的页做节流（节流会让 CDP 的查找/点击失灵）：
   * 那种情况返回 `{ ok: false, error: 'driving' }`。
   */
  browserThrottle: (webContentsId: number, throttle: boolean) => Promise<{ ok: boolean; error?: string }>;

  /**
   * 第 9 步：把用户对「补资料」提问的回答交给主进程（仅普通资料；敏感值别走这里）。
   * 第 17 步：带 targetWebContentsId 时只喂给**那一路**（那张页），别路不串。
   */
  agentAnswer: (text: string, targetWebContentsId?: number) => Promise<void>;

  /**
   * 第 8 步：下载任务结果文档（.md）。走主进程存盘对话框；内容里由主进程再做一道
   * 脱敏兜底（Bearer/sk-/手机号一律替换），绝不把 Key/JWT/手机号写进文件。
   *
   * ★ 本批次起**不再接收 `token`**：主进程一律用它自己内存里那份（`agentJwt`）。
   *   `apiBase` 仍可指定（本机换端口开发），但主进程只放行**回环地址** ——
   *   主进程发出的请求不受同源策略约束，接受任意地址等于把 JWT 交给渲染层带走。
   *   约束成立的前提是「登录成功后已经同步过一次」，见 `syncSession`。
   */
  downloadDoc: (
    taskId: number,
    apiBase: string,
  ) => Promise<{ saved: boolean; path?: string; canceled?: boolean; error?: string }>;

  /**
   * ★ 登录态**显式同步**：只在渲染层登录成功那一刻调用（含 F5 之后的静默恢复）。
   *
   * 主进程的 token 是纯内存变量，只在 `agentStart` 时被写入；而 F5 刷新后
   * 渲染层的登录态是从 localStorage 自己恢复的、**完全不经过主进程** ——
   * 于是会出现「渲染层已登录、主进程没凭证」，用户刷新后点下载会失败。
   * 这条通道就是为补这个缺口而存在的；`token` 传空串表示登出。
   *
   * ⚠️ 它是**会话级**的通道，不是给普通业务动作"顺手夹带凭证"用的。
   */
  syncSession: (apiBase: string, token: string) => Promise<{ ok: boolean; hasToken: boolean }>;

  /**
   * ★ 项目列表**显式同步**：渲染层拿到 `/projects` 结果后推给主进程，供**分区闸**判定归属。
   *
   * 为什么需要：`will-attach-webview` 是同步事件（`preventDefault()` 必须当场调用），
   * 主进程没机会在里面 await 一次 HTTP，所以只能由渲染层把
   * "这个账号有哪些项目"显式推过去。
   *
   * 传**空数组**是有意义的：表示"这个账号确实一个项目都没有"，
   * 与"还没同步过"（主进程放行 + 告警）是两种不同状态。
   * 登出时也应调一次（传空数组）把上一位用户的项目清掉。
   */
  syncProjects: (projectIds: number[]) => Promise<{ ok: boolean; count?: number; error?: string }>;

  /**
   * ★ 主进程拦下了一个分区不合法 / 跨账号的内嵌页。
   *
   * 渲染层应据此把那张页标成失败（而不是留一张永远空白的卡片 ——
   * 用户会以为"网页坏了"，而实际上是安全策略挡住了它）。
   * @returns 取消订阅的函数
   */
  onWebviewBlocked: (cb: (info: { partition: string; reason: string }) => void) => () => void;

  /**
   * ★ 开发模式（mock 短信）下，主进程把服务端打印的验证码转给登录页。
   *
   * 为什么必须有这条通道：应用会**自己**把服务端拉起来，而它的 stdout 被主进程接管
   * （`stdio: 'pipe'` → relay 到主进程日志）—— 验证码只进了那条管道，
   * 用户**看不到任何窗口**，也就无从知道验证码。没有它，
   * 「打开应用就能登录」实际上是不成立的（能连上后端，却拿不到码）。
   *
   * 只在 mock 模式触发：生产环境服务端根本不打印验证码，这条通道永远不响。
   * 返回取消订阅函数。
   */
  onSmsMockCode: (cb: (info: { masked: string; code: string }) => void) => () => void;

  /** 读取主进程权威状态（渲染进程挂载时初始同步用） */
  getTaskState: (targetWebContentsId?: number) => Promise<TaskState>;

  /**
   * 第 22 步：读可调配置。权威副本在主进程（userData 下的 JSON），
   * 渲染层启动时同步一次，之后跟随 'settings' 广播。
   */
  getSettings: () => Promise<WorkbenchSettings>;
  /**
   * 第 22 步：改配置（只传要改的字段即可）。主进程会夹到合法区间、落盘，并广播 'settings'，
   * 返回值是夹过之后的**完整**配置，调用方以它为准。
   */
  setSettings: (patch: Partial<WorkbenchSettings>) => Promise<WorkbenchSettings>;

  // ---- Phase 4：资源守护者（采集在主进程；渲染层只读 + 上报实例清单）----
  /**
   * 读资源守护者实时视图（最新采样 + 档位 + 阈值 + 去抖计数 + 落盘目录）。
   * 这是本阶段「数据可查」的正门：后续 UI 阶段做提示界面时用的就是它。
   */
  resourceSnapshot: () => Promise<ResourceGuardSnapshot>;
  /**
   * 读历史：最近 `minutes` 分钟内的**汇总点**（60s 粒度）。
   * 原始 5s 采样只在主进程内存里留最近 1 小时，落盘的只有汇总（不让监控自己变成磁盘负担）。
   */
  resourceHistory: (minutes?: number) => Promise<ResourceAggregate[]>;
  /** 读历史警戒事件（最近的在前？不是——按时间正序，取最后 `limit` 条） */
  resourceEvents: (limit?: number) => Promise<ResourceAlert[]>;
  /**
   * 上报当前浏览器实例清单（含每个实例的最后使用时间）——
   * 「最久未使用」排序靠它，主进程自己看不到标签页。
   * 只在**变化时**发（事件驱动），不做固定心跳。
   */
  resourceInstances: (list: BrowserInstanceInfo[]) => Promise<void>;

  /** 订阅主进程转发过来的 UI 指令，返回取消订阅函数 */
  on: (event: BrowserEvent, callback: (payload?: string) => void) => () => void;
}

// ---------------------------------------------------------------------------
// 第 5 步（重做版）：账号契约 —— XYZ 对外号 + 两套真登录 + 微信占位
//
// - 对外号 xyz_id：系统生成 `XYZ` + 数字（5 位起，用尽升 6/7 位），用户不能自选；
//   register/login 的成功 JSON 都带它。
// - 登录 A：手机号 + 短信验证码（未注册自动建号）；B：XYZ 号 + 密码（没设密码→明确失败）。
// - 微信本步只预留：status.enabled=false；login 直接 501，不发 JWT。
// - 没有邮箱主账号，没有 /chat/stream，不接大模型。
// ---------------------------------------------------------------------------

/** 登录用户对外可见的部分（不含任何密码/手机号明文；phone 只有打码形态） */
export interface AuthUser {
  id: number;
  /** 对外号：XYZ+数字，唯一，系统生成 */
  xyz_id: string;
  /** 是否已设置过密码（false 时 XYZ+密码登录会明确失败提示先设密码） */
  has_password: boolean;
  /** 打码手机号（1 开头 11 位显示为 138****0000 形态；未绑定手机则 null） */
  phone_masked: string | null;
}

/** 一个项目（注册时自动建的那条「默认项目」，以及子阶段 2-A 起用户自己建的项目） */
export interface ProjectSummary {
  id: number;
  name: string;
  /** 是不是「当前使用中的项目」。一个账号同一时刻只有一个 true（没有时回落到 is_default 那条） */
  isCurrent?: boolean;
  /** 是不是建号时自动建的那条默认项目（**不可删**，也是没有 current 时的兜底） */
  isDefault?: boolean;
  /** 子阶段 2-A：这个项目随项目一起创建的「母鸡」智能体 id（老项目/默认项目可能没有） */
  henAgentId?: number | null;
  createdAt?: string;
}

/** GET /projects —— 当前用户的项目列表 */
export interface ProjectListResult {
  projects: ProjectSummary[];
  /** 当前使用中的项目 id（= 列表里 isCurrent 为 true 的那条） */
  currentProjectId: number | null;
}

/** POST /projects 成功响应 */
export interface ProjectCreateResult {
  project: ProjectSummary;
}

/** PATCH /projects/:id（重命名）与 POST /projects/:id/activate（设为当前）成功响应 */
export interface ProjectUpdateResult {
  project: ProjectSummary;
}

/** 注册成功自动创建的 Agent「小助」 */
export interface AgentSummary {
  id: number;
  name: string;
}

/** 登录成功响应（桌面端存的就是这个；token 不许打印到控制台） */
export interface AuthSession {
  token: string;
  user: AuthUser;
  project: ProjectSummary;
  agents: AgentSummary[];
}

/** GET /auth/me 的响应（同 AuthSession 但不回显 token） */
export type AuthProfile = Omit<AuthSession, 'token'>;

/** GET /auth/wechat/status —— 本步恒为未开通 */
export interface WechatStatus {
  enabled: boolean;
}

/** POST /auth/sms/send 的响应 —— 刻意不含验证码 */
export interface SmsSendResult {
  sent: boolean;
  /** 有效期（秒） */
  expires_in: number;
}

// ---------------------------------------------------------------------------
// 第 6 步：流式聊天契约（AI 只会说话，不指挥浏览器——那是第 7 步）
// 桌面用 fetch 读流（不用 EventSource：它带不了 Authorization 头）
// ---------------------------------------------------------------------------

/** 库里一条聊天消息（历史接口回传的形态；text 是服务端解密后的明文，库里只有密文）。
    顶部那个旧的 ChatMessage 是第 2 步假聊天的遗留壳，别看错。 */
/**
 * 第 26 步：一轮联网搜索命中的网页来源。
 *
 * 只带「标题 + 网址 + 域名」三样，**不带搜索词**（query 可能含用户隐私），
 * 也不带正文摘要（正文已经进了模型上下文，界面不需要）。
 * 界面把它渲染成气泡下方的可点链接；点开走系统默认浏览器。
 */
export interface ChatSource {
  title: string;
  url: string;
  /** 展示用的域名（www. 已剥掉），例如 `bbc.com` */
  domain: string;
}

export interface ChatRow {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  /**
   * 第 26 步：这条助手回复**引用到的网页来源**（本轮联网检索命中的）。
   * 只有走过搜索的回复才有；没搜过 / 老数据都是 undefined。
   */
  sources?: ChatSource[];
  created_at?: string;
}

/** GET /chat/history 的响应：没有会话时 conversationId 为 null、messages 为空数组 */
export interface ChatHistoryResult {
  conversationId: number | null;
  messages: ChatRow[];
}

/** /chat/stream 的 SSE 事件负载（data: 里的 JSON） */
export type ChatStreamEvent =
  | { conversationId: number; userMessageId: number; agentId?: number | null } // event: meta（流第一帧）
  | { delta: string } // 打字机：逐段追加
  | { conversationId: number; messageId: number; contentLength: number } // event: done（助手已落库）
  /**
   * 第 21 步：这一轮是「页面任务」，服务端已经为它建好工具循环。
   * 桌面拿 loopId 去 /agent/loop/next 要下一步工具，并在**这张页**上执行。
   */
  | { loopId: string; maxSteps: number; agentId?: number | null; pageUrl?: string }
  | { error: string }; // event: error（中断/失败：半截不算数）

// ---------------------------------------------------------------------------
// 第 7 步：云端驾驶员循环 —— 看页 → 只输出一步动作 → 本地执行
//
// 动作类型复用上面的 BrowserAction，不另起第二套。
// 桌面主进程把 read_page 快照 POST 给服务端，服务端只回【一个】动作。
// ---------------------------------------------------------------------------

/** POST /agent/next-action 的请求体（snapshot 就是 read_page 的 PageSnapshot） */
export interface AgentActionRequest {
  /** 服务端 tasks 表里的任务 id（start 之后带上来，用于记步） */
  taskId?: number;
  /** 用户确认过的目标（一句话） */
  goal: string;
  /** 已执行步骤的人话摘要（最近若干条，不含整页 HTML） */
  stepsSummary: string[];
  /** 当前页面快照（url/title/可见元素），继续时一定是最新的 */
  snapshot: PageSnapshot;
  /** true=用户接管中：服务端禁止返回 click/type/open_url */
  paused?: boolean;
}

/** POST /agent/next-action 的响应：单个动作 + 可选的人话备注 */
export interface AgentActionResponse {
  action: BrowserAction;
  note?: string;
}

/** 主进程 → 渲染进程 'agent' 事件负载（JSON 字符串） */
export type AgentEventPayload =
  | { kind: 'step'; step: number; summary: string; ok: boolean }
  | { kind: 'ask'; reason: string; question: string }
  | { kind: 'done'; summary: string; documentTitle: string; documentOutline: string[]; docReady?: boolean; unreadHint?: string }
  | { kind: 'note'; level: 'info' | 'error'; text: string }
  /** 第 9 步：敏感字段等待态——浏览器已前置并聚焦，人话提示在 message 里 */
  | { kind: 'sensitive'; fieldReason: string; message: string }
  /**
   * 第 27 步：**人工介入求助卡片** —— AI 自己走不下去了，要用户亲自处理。
   *
   * 与 `kind:'sensitive'` 的区别：`sensitive` 是「服务端挡下了 AI 的一次敏感输入」这个
   * **单点**信号；`help` 是「本地页面信号（验证码/登录墙）**且** AI 确实卡住了」这个
   * **复合**判定，它才是聊天流里那张卡片的触发源。
   *
   * ★ 安全红线：这个负载里**只有文案**，永远不带任何输入框、不带字段值、不带"代填"动作。
   *   卡片只负责"展示 + 提示 + 手动确认"，用户必须在**真实页面**上自己操作。
   */
  | { kind: 'help'; helpKind: 'captcha' | 'login'; question: string; hint: string }
  /** 第 27 步：求助已解除（用户处理完 / 任务收尾 / 用户接管），界面把卡片收掉 */
  | { kind: 'help-clear'; reason: string }
  /**
   * ★ P0 止血（2026-09-21）：**这一轮的上下文没了** —— 要用户拍板，不许自动重开。
   *
   * 触发条件（唯一的）：`/agent/loop/resume` 返回 `code:'loop_gone'`
   * （那条循环确实找不到了：等待超时被回收 / 服务端重启过）。
   *
   * ★ 这个负载里**只有一句问话**，主进程不会替用户做任何决定 ——
   *   因为"从头再来"意味着前面已经做过的动作可能被再做一遍，
   *   代价必须由用户承担、也必须由用户点头。
   *
   * 用户的选择通过 `WorkbenchBridge.loopGoneChoice` 回到主进程。
   */
  | { kind: 'loop-gone'; question: string };

// ---------------------------------------------------------------------------
// 第 10 步：用户档案记忆 ——「记住这个人」，确认后才注入执行
// ---------------------------------------------------------------------------

/** 一条记忆（服务端已解密成人话文本才下发；库里只有密文） */
export interface MemoryItem {
  id: number;
  type: 'preference' | 'decision' | 'fact';
  content: string;
  updatedAt: string;
}

/** GET /memories：active 进「我的记忆」列表，pending 上确认卡 */
export interface MemoryListResult {
  active: MemoryItem[];
  pending: MemoryItem[];
}

/** POST /memories/extract：preference 已静默入库；pending 才是卡片内容 */
export interface MemoryExtractResult {
  extracted: number;
  pending: MemoryItem[];
  skipped?: string;
}

// ---------------------------------------------------------------------------
// 第 11 步：知识库 —— 用户上传资料的原文片段（独立于 memories，绝不混表）
// ---------------------------------------------------------------------------

/** 一份资料的前端展示元信息。正文不下发；服务端库里文件名和片段正文都是 AES 密文。 */
export interface KnowledgeDocument {
  id: number;
  filename: string;
  kind: 'txt' | 'md' | 'pdf';
  byteSize: number;
  chunkCount: number;
  createdAt: string;
  /** 子阶段 2-A：这份资料归属哪个项目（列表与检索都按项目隔离） */
  projectId?: number;
}

/** GET /knowledge：当前登录用户自己的资料列表及每份资料的已入库段数。 */
export interface KnowledgeListResult {
  documents: KnowledgeDocument[];
}

/** POST /knowledge/upload 成功响应。 */
export interface KnowledgeUploadResult {
  document: KnowledgeDocument;
}

/**
 * 第 19 步 DELETE /knowledge/:id 成功响应。
 * 删除范围是「当前账号的这份资料 + 它的全部切块」；别人的资料删不到，只会得到 404。
 */
export interface KnowledgeDeleteResult {
  id: number;
  deleted: true;
  /** 这次一并删掉的切块数，用于桌面侧回一句人话 */
  removedChunks: number;
}

// ---------------------------------------------------------------------------
// 第 15 步：多智能体（添加 + 聊天内引导表）+ 两层记忆
//
// - 一个智能体 = 一份独立聊天（自己的 conversation）+ 一份项目记忆；
// - 人设（引导表那四格）是**智能体配置**，不是记忆条目；
// - 两层记忆：用户记忆库（账号级，所有智能体都读）/ 项目记忆（智能体级，绝不串）。
// ---------------------------------------------------------------------------

/** 引导表填出来的四格人设。字段名就是表里的行标题，别改名。 */
export interface AgentPersona {
  /** 名称：左栏和聊天里显示的名字 */
  name: string;
  /** 它是谁 */
  who: string;
  /** 怎么说话 */
  tone: string;
  /** 干什么 */
  duty: string;
}

/** 一个智能体在前端可见的形态（GET /agents 的元素） */
export interface AgentView {
  id: number;
  name: string;
  /** 'assistant' = 自带的「小助」（不可删、不强制走引导表）；'custom' = 用户点「添加」新建的；
   *  'hen' = 子阶段 2-A 起「随项目一起创建的母鸡」（不可删、有建智能体的权限） */
  kind: string;
  /** 能不能删（小助与母鸡恒为 false） */
  deletable: boolean;
  /** 子阶段 2-A：这个智能体属于哪个项目 */
  projectId?: number;
  /** 子阶段 2-A：有没有「创建智能体」的权限（母鸡与小助为 true，普通智能体默认 false） */
  canCreateAgents?: boolean;
  /** 'pending' = 引导表还没填完；'ready' = 已按人设干活 */
  personaStatus: 'pending' | 'ready';
  persona: AgentPersona | null;
  /** 这个智能体自己的那条会话；null = 还没有（第一次发消息时服务端会建） */
  conversationId: number | null;
  /** 第 16 步：是否处于「启动并保活」监听态（挂在会话状态上；空闲不调模型） */
  listening?: boolean;
  /** 无感核心 Step2：头像即状态（GrokBot：idle/thinking/working/waiting/blocked/done），不做六个指示器，版式归用户 */
  status?: 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'done';
  /** 状态人话摘要（折叠一行，细节前端可展开） */
  statusDetail?: string;
  /** 状态对应的循环 id（调试/追踪用） */
  statusLoopId?: string | null;
  /** 当前步数（有循环时） */
  statusStep?: number;
  /** 批次 C | 路由升级：职责为空/通用时前端警告，description 为燃料 */
  dutyWarning?: string | null;
}

/** GET /agents */
export interface AgentListResult {
  agents: AgentView[];
}

/** POST /agents 成功响应：新智能体 + 已经为它建好的空会话 */
export interface AgentCreateResult {
  agent: AgentView;
}

/** 一条记忆（服务端解密成人话才下发；库里只有密文） */
export interface MemoryEntry {
  id: number;
  content: string;
  updatedAt: string;
}

/** GET /memory/user 与 GET /agents/:id/memory 的统一形态 */
export interface MemoryLayerList {
  items: MemoryEntry[];
}

/** POST /agents/:id/tidy：把这段聊天总结进两层记忆（不存整段聊天） */
export interface AgentTidyResult {
  userAdded: number;
  projectAdded: number;
  /** 跳过原因：llm_not_configured / nothing_worth_remembering / empty_transcript … */
  skipped?: string;
}

/** 记忆层：'user' = 账号级用户记忆库；'agent' = 该智能体的项目记忆 */
export type MemoryLayer = 'user' | 'agent';

// ---------------------------------------------------------------------------
// 第 16 步：轻量会话状态（随会话持久化在现有 Postgres 的 conversations 表上）
//
// 这些字段每轮都进模型上下文 —— 否则光改提示词是无效的。
//   current_task     当前任务（最新一句用户消息覆盖它，改口立刻切换）
//   browser_confirmed 本会话是否已确认过用浏览器（已确认 → 普通点击/搜索/滚动/读页不再问）
//   keepalive         「启动并保活」监听态；空闲**不调模型**，来消息才走 /chat/stream
// ---------------------------------------------------------------------------

/** 一个会话的轻量状态（GET /chat/state 回传；字段名与库里列名一致） */
export interface ConversationStateView {
  conversationId: number;
  current_task: string;
  latest_user_intent: string;
  browser_confirmed: boolean;
  login_required: boolean;
  sensitive_action: boolean;
  last_page_summary: string;
  already_told_user_login_themselves: boolean;
  keepalive: boolean;
}

/** GET /chat/state 与 POST /chat/state 的统一响应；还没有会话时 state 为 null */
export interface ChatStateResult {
  conversationId: number | null;
  state: ConversationStateView | null;
}

// ---------------------------------------------------------------------------
// 第 21 步：工具循环（**脑在服务端**，手在桌面主进程）
//
//   用户下任务 → 服务端用 DeepSeek 的 function call 选工具 → 桌面在**当前智能体**
//   的那张 webview 上执行 → 结果（URL / 读页摘要 / 点没点到）喂回模型 → 再选下一步，
//   直到 stop 或用户叫停。循环本体（消息历史、步数上限、prompt、工具表）只在服务端；
//   桌面只当「手」，不自己决定下一步，也不再另写一套 JSON 动作话术。
//
//   工具只有这 6 个，且**全部落在 apps/desktop/src/browser/ 那一套浏览器上**：
//   open_url / read_page / click / type / scroll / stop。
// ---------------------------------------------------------------------------

/** 循环里允许出现的工具名（就是这 6 个，不多不少） */
/**
 * 工具名。前 6 个是浏览器手（side='desktop'，桌面执行）；
 * 后 3 个是**多智能体编排**加的服务端工具（side='server'，服务端就地执行，
 * 桌面完全感知不到 —— 见 `apps/server/src/toolLoop.ts` 的 advanceInner 内循环）。
 *
 * ★ 为什么新名字必须进这个联合类型而不是靠 `as` 硬转：
 *   `sanitizeToolCall` 会把它 cast 成 LoopToolName，类型上是谎；
 *   加进来之后，桌面 `resolveBrowserAction` 查不到映射时**返回 null**（既有语义，
 *   不抛错），服务端则走 server 分支就地执行 —— 两侧都安全。
 */
export type LoopToolName =
  | 'open_url'
  | 'read_page'
  | 'click'
  | 'type'
  | 'scroll'
  | 'stop'
  | 'web_search'
  | 'spawn_workers'
  | 'delegate';

/** 模型选出来的一个工具调用 */
export interface LoopToolCall {
  /** 上游给的调用 id（回执要用它对应） */
  id: string;
  name: LoopToolName;
  args: Record<string, unknown>;
}

/** 桌面执行完一个工具后回给服务端的回执（只有人话摘要，不含整页 HTML） */
export interface LoopToolResult {
  ok: boolean;
  /** 执行细节（例如「点击了 BUTTON「百度一下」」） */
  detail?: string;
  /** 失败原因（人话，直接进模型上下文） */
  error?: string;
  /** 动作执行了但页面看不出变化（点没点中） */
  noChange?: boolean;
  /** 执行后的页面快照（read_page / open_url / click / type / scroll 都带） */
  page?: PageSnapshot;
  /** 工具压根没执行（被本地安全闸拦下）时的原因 */
  refused?: string;
  /** 用户在循环跑着的时候补的一句答复（只进上下文，不落库） */
  userAnswer?: string;
  /**
   * 多智能体编排 · **结构化结果**（可选，旧代码/旧桌面完全不感知）。
   *
   * 谁产生它：`side='server'` 的工具（`spawn_workers` 的临时工汇报、`delegate` 的委派结果、
   * `web_search` 的来源列表）。`detail` 仍是一句人话，`data` 是给模型看的**完整结构化事实**。
   *
   * ★ 两处必须同时改（改这里前先读）：
   *   ① `toolLoop.ts` 的 `describeToolResult` 要把 `data` 序列化进 tool 消息，
   *      否则模型**永远看不到**临时工汇报（只有那句 detail），整个并行机制等于白跑；
   *   ② `routes/loop.ts` 的 `/agent/loop/next` result 白名单**刻意不收** `data`
   *      —— 客户端注入不了它，也就伪造不了回执。投递只能走服务端进程内。
   */
  data?: unknown;
  /**
   * 多智能体编排 · **「这一格不阻塞，先把我挂起来」**（由服务端工具自己声明）。
   *
   * 为什么必须存在：临时工/委派要跑几十秒到 10 分钟，而桌面 `/next` 只有 90 秒硬超时、
   * 服务端单次模型调用也是 90 秒 —— 在 `advance()` 里 `await` 子任务必然把循环打成
   * `brain_failed`（R6 已证明传输出错就永久杀循环）。
   * 所以长耗时工具**立刻返回**并声明 park：循环转 `waiting_job`（不调模型、不烧 token），
   * 结果回来后由服务端把结构化结果当作**这一格工具的正式回执**注入历史并续跑。
   */
  park?: { jobId: string; kind: AgentJobKind; etaMs: number; note: string };
}

/** 服务端对循环的一次推进结果：要么给一个工具，要么收尾/提问 */
export type AgentLoopDecision =
  | { kind: 'tool'; call: LoopToolCall; step: number; text?: string }
  /**
   * ★ 多智能体编排：**「等子任务」复用 `ask`，不加新的 decision kind。**
   *
   * 为什么（改这里前先读）：已安装的旧桌面遇到未知 `kind` 会掉进 `tool` 分支、
   * 把垃圾回执喂回来 → 死循环自旋。复用 `ask` + 新 `reason='job_pending'` 之后：
   *   · 旧桌面：正常停下、把 `question` 显示给用户（不自旋，用户点「继续」即可）；
   *   · 新桌面：识别 `reason==='job_pending'` → ℹ️ 提示 + 轮询 → 自动续跑。
   * 后三个字段全是**可选**的，旧端读到 undefined 也不会有任何行为差。
   */
  | {
      kind: 'ask';
      reason: string;
      question: string;
      step: number;
      /** 这一格挂在哪个后台子任务上（`reason==='job_pending'` 时才有） */
      jobId?: string;
      jobKind?: AgentJobKind;
      /** 预计还要多久（毫秒），界面画倒计时用 */
      etaMs?: number;
    }
  | { kind: 'done'; summary: string; document_title: string; document_outline: string[]; step: number }
  | { kind: 'say'; text: string; step: number }
  | { kind: 'stopped'; reason: string; step: number }
  /**
   * 阶段简报 · 方案 B：这一路**正在被用户挂起**。
   *
   * 与 `stopped` 的本质区别：`stopped` 是**终态**（循环死了，再 `next` 永远回 stopped）；
   * `paused` 是**挂起态**（消息历史、步数、目标全都还在，解除挂起就能原地继续）。
   * 桌面收到它后必须立刻停手、把浏览器交还给用户，并且**不再**调 `/agent/loop/stop`
   * （那会把挂起变成终态，「继续」就永远接不回来了）。
   */
  | { kind: 'paused'; reason: string; step: number; pausedAt: number; pausedBy: string };

/**
 * 阶段简报 · 方案 B：一条**暂停记录**（落 `task_pauses` 表，重启后能恢复显示）。
 *
 * `pausedBy` 就是为后续「人工介入卡片」预留的那一列 ——
 * 本次阶段**只有** `'user'`（用户手动点了暂停）会写进来；
 * 将来系统自动检测异常触发暂停时，写 `'system'` 或 `'guard:<规则名>'` 即可，表结构不用动。
 */
export interface TaskPauseRecord {
  id?: number;
  /** 服务端循环号（LoopSession.id） */
  loopId: string;
  /** 暂停期间是否已被解除（继续 / 作废） */
  resumed: boolean;
  /** 谁触发的暂停：本次恒为 'user'；后续人工介入卡片会写 'system' / 'guard:*' */
  pausedBy: string;
  pausedAt: number;
  resumedAt: number | null;
  /** 挂载它的浏览器任务信息（不带也能记，但带上才能在重启后还原到具体那一路） */
  userId?: number | null;
  agentId?: number | null;
  wcId?: number | null;
  /** 任务目标（恢复时告诉 AI 当初要干什么） */
  goal?: string;
  /**
   * 恢复时重新感知到的变化类型（unchanged / moved / edited / unknown）。
   * 它是**取证字段**：验收要证明「AI 确实发现了页面变了」，靠的就是这一列 + resumedAt 时间戳。
   */
  deltaKind?: string;
  /**
   * ★ 接口层补的字段之一：**这条暂停对应的循环，此刻还在不在服务端内存里**（字面事实）。
   *
   * 为什么单独给一个字段、而不复用 `resumed`：
   *   - `resumed=false` 只说明「库里还没闭合这条暂停」，**不代表循环还活着**。
   *     服务端重启过 / 循环 TTL（10 分钟）到期，库里那条 `resumed_at` 会永远停在 NULL，
   *     可内存里的 `loops` Map 早没这一条了 —— 这两种状态在库里长得一模一样。
   *   - `resumed` 的语义是「用户点没点过继续」（面向**历史结论**，不能改）；
   *     本字段的语义是「此刻在不在内存」（面向**实时事实**，会随时间自己变）。
   *     两者必须分开表达，否则要么历史被改写、要么把已死的循环报成活的。
   *
   * ⚠️ **别拿它当"能不能继续"用** —— 见下面的 `resumable`。
   *
   * ⚠️ 本字段**只在接口层产出**（`GET /agent/loop/pauses`）；本批次不动任何前端 UI 代码，
   *    前端消费它的改动留待前端重启开发时再做。
   */
  inMemory?: boolean;
  /**
   * ★ 接口层补的字段之二：**现在点「继续」还能不能真的接回来**（能不能用）。
   *
   * 判据 = `在内存里` **且** `处于挂起态(paused)`。
   *
   * 为什么不能只看 `inMemory`（这是回归测试实测出来的，不是推测）：
   *   `stopLoop()` 只把 `status` 置为 `'stopped'`（终态），
   *   **不会把会话从 `loops` Map 里删掉** —— 要等 TTL 到期才被 sweep 清走。
   *   于是「已经停掉、永远接不回来」的循环，`inMemory` 依然是 `true`。
   *   只认 `inMemory` 的界面会给出一个点了没反应的「继续」按钮。
   *
   * 三种状态的正确表达：
   *   | 情形                        | inMemory | resumable |
   *   | 挂起中（能继续）             | true     | **true**  |
   *   | 已停止 / 已结束（接不回来）   | true     | false     |
   *   | 服务端重启过 / TTL 已到期     | false    | false     |
   */
  resumable?: boolean;
}

/** POST /agent/loop/start 的响应 */
export interface AgentLoopStartResult {
  loopId: string;
  /** 这一路属于哪个智能体（服务端用它挡住「串到别的 bot 的页」） */
  agentId: number | null;
  /** 每轮最多几步（配置项，默认 10，允许 8~12） */
  maxSteps: number;
  step: number;
}

/**
 * GET /agent/loop/info 的响应 —— 一条循环的**权威身份**。
 *
 * 存在的理由：`/agent/loop/next` 的归属硬闸要求调用方自证 agentId 与建循环时一致，
 * 而循环不一定由桌面主进程创建（渲染层的 `/chat/stream` 任务轮也会建）。
 * 主进程那时只有一个 loopId、并不知道它属于哪个智能体，硬闸就会把合法调用判成不匹配。
 * 所以给它一个"拿 loopId 换权威身份"的读口，让硬闸可以保持严格而不误伤。
 */
export interface AgentLoopInfoResult {
  loopId: string;
  /** 建循环时记下的智能体（可能为 null —— 建的时候就不知道） */
  agentId: number | null;
  /** 建循环时记下的页（可能为 null） */
  wcId: number | null;
  /** running / paused / stopped / done 等 */
  status: string;
  step: number;
  maxSteps: number;
}

/** POST /agent/loop/next 的响应 */
export interface AgentLoopNextResult {
  decision: AgentLoopDecision;
}

// ---------------------------------------------------------------------------
// 多智能体编排（阶段 1 临时工 + 阶段 2 委派）· 共用类型
//
// 这一整块都是**新增**的，没有改任何既有类型 —— 旧桌面 / 旧服务端读到 undefined
// 就是「没有这回事」，行为零变化。
// ---------------------------------------------------------------------------

/** 后台子任务的两种：`workers` = 一批临时工并行；`delegate` = 委派给另一个智能体 */
export type AgentJobKind = 'workers' | 'delegate';

/** 一个临时工要干的活（发起方给的最小任务书） */
export interface WorkerTaskSpec {
  /** 这件事叫什么（≤60 字，汇报时原样带回，方便对上号） */
  title: string;
  /** 具体要做什么、要回什么（≤600 字，一件事） */
  instruction: string;
  /** 可选：发起方手上已有的资料（≤2000 字） */
  context?: string;
}

/**
 * 一个临时工的结构化汇报。
 *
 * ★ 为什么必须结构化、不能是一段自由文本：
 *   临时工**没有身份、没有记忆、用完即销毁**，发起方拿到的只有这份汇报。
 *   自由文本会让发起方分不清「哪个工人说的哪一句」，也没法在界面上画卡片。
 *   `status` 三态是硬要求：单个工人失败/超时**不影响**同批其他人（`allSettled` 语义），
 *   发起方看到的是「3 个里 1 个超时」，不是整批失败。
 */
export interface WorkerReport {
  /** 与入参顺序对应的稳定 id（`w1`/`w2`/…），不是随机 uuid */
  id: string;
  title: string;
  status: 'ok' | 'failed' | 'timeout';
  /** 结论（≤300 字） */
  summary: string;
  /** 要点（≤8 条，每条 ≤200 字） */
  findings: string[];
  /** 来源（≤5 条，复用既有 ChatSource 类型） */
  sources: ChatSource[];
  confidence: 'high' | 'medium' | 'low';
  /** status!='ok' 时的原因（人话，如实说） */
  error?: string;
  tookMs: number;
}

/** 一批临时工的汇总（`reports` 顺序与入参 `tasks` 严格一致，确定性可断言） */
export interface WorkerBatchResult {
  jobId: string;
  reports: WorkerReport[];
  okCount: number;
  failCount: number;
  tookMs: number;
}

/** 一次委派的状态机 */
export type DelegationStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'timeout'
  | 'need_user'
  | 'rejected';

/** 一条委派记录（UI 画状态徽标 + 超时熔断都靠它；跨进程重启仍可读） */
export interface DelegationView {
  id: number;
  channelId: number;
  fromAgentId: number;
  toAgentId: number;
  fromName: string;
  toName: string;
  task: string;
  status: DelegationStatus;
  createdAt: string;
  deadlineAt: string;
  finishedAt: string | null;
  /** 被委派方的结论（已脱敏） */
  summary?: string;
  outline?: string[];
  /** 失败/超时/被拒的原因（人话） */
  error?: string;
}

/** 频道里一条消息的类型 */
export type ChannelMessageKind =
  /** 发起方派活 */
  | 'task'
  /** 被委派方的过程注记（做了什么，例如「已搜索：xxx」） */
  | 'progress'
  /** 被委派方交活 */
  | 'reply'
  /** 系统留痕：被拒 / 超时 / 取消（附原因） */
  | 'system';

/** 内部频道的一条消息（正文在服务端是密文，下发前解密） */
export interface AgentChannelMessage {
  id: number;
  kind: ChannelMessageKind;
  fromAgentId: number;
  toAgentId: number;
  fromName: string;
  toName: string;
  text: string;
  /** 结构化附加数据（已脱敏：状态码/计数/来源网址/耗时） */
  payload?: unknown;
  delegationId?: number;
  at: string;
}

/** 频道列表的一项（一对智能体一条） */
export interface AgentChannelSummary {
  id: number;
  peerAgentId: number;
  peerName: string;
  lastAt: string;
  /** 最后一句的预览（解密后截 60 字） */
  lastPreview: string;
  messageCount: number;
  /** 此刻这条频道上有没有在跑的委派（界面画「进行中」徽标） */
  liveDelegationId?: number;
  liveStatus?: DelegationStatus;
}

/** GET /agents/channels */
export interface ChannelListResult {
  channels: AgentChannelSummary[];
}

/** GET /agents/channels/:id/messages */
export interface ChannelMessagesResult {
  channel: AgentChannelSummary;
  messages: AgentChannelMessage[];
}

/** GET /agents/delegations */
export interface DelegationListResult {
  delegations: DelegationView[];
}

/**
 * GET /agent/loop/job?loopId= —— 「这一路挂在哪个子任务上、好了没」。
 *
 * 只读、不含任何内容（只有状态与时间戳），所以它既给桌面轮询用，
 * 也给验收脚本取证用。
 */
export interface LoopJobStateResult {
  loopId: string;
  status: string;
  job:
    | null
    | {
        jobId: string;
        kind: AgentJobKind;
        /** true = 还在跑；false = 已有结果（或已被取消） */
        pending: boolean;
        startedAt: number;
        deadlineAt: number;
        resultReady: boolean;
      };
}

// ---------------------------------------------------------------------------
// 第 22 步（浏览器多实例融合）：可调配置
//
// 两条都是**设置里可调**的，绝不写死在代码里：
//   - maxConcurrentAgentTasks —— A1.5 的「同时几路 active agent task」。
//     数据结构按 target 独立设计（见 electron/driver.ts），所以调大这个数就能
//     解锁真并行，**不需要重新设计数据结构**；
//     **子阶段 A 起默认值 = 20**（原来 1）：本阶段要验证的是「技术上真并发没问题」，
//     动态资源限制是后面的子阶段 B。这个开关**本身保留**（继续用它做压力测试 / 临时限流）。
//   - maxBrowserInstances —— D 的多实例上限（默认 4，不是 6）。每张内嵌页 = 一个独立
//     渲染进程 + 一块 session 存储，所以必须有上限防内存失控。
// ---------------------------------------------------------------------------

/** 主进程持久化的可调配置（权威副本在主进程 userData 下的 JSON 里） */
export interface WorkbenchSettings {
  /** 同时最多几路 agent 任务在跑（子阶段 A 起默认 20；调小即临时限流，调大即解锁更多并行） */
  maxConcurrentAgentTasks: number;
  /** 最多同时开几张内嵌页（默认 4；**只拒绝新开，绝不偷偷关掉已有页**） */
  maxBrowserInstances: number;

  // ---- Phase 4：资源守护者（阈值与采集频率都在这里，**绝不写死在代码里**）----
  /**
   * 资源守护者开关：**1 = 开（默认）**，0 = 关。
   *
   * 关掉只影响「采集 + 判定 + 提示」，**不影响任何浏览器行为**（不关页、不限开）。
   * 存在的意义有两个：① 验收时做「开监控 / 关监控」的对照测量；
   * ② 万一监控自己出问题，用户/我们有一个开关能立刻让它闭嘴（而不是去改代码）。
   */
  resourceGuardEnabled: number;
  /** 采集间隔（毫秒，默认 5000）。见 electron/resource-guard.ts 顶部对频率取舍的说明。 */
  resourceSampleMs: number;
  /** 内存健康线（MB，默认 3072）：在这条线以下**完全不打扰用户** */
  resourceMemHealthMB: number;
  /** 内存警戒线（MB，默认 4096）：越过它（连续 3 个采样点）触发一次提示 */
  resourceMemWarnMB: number;
  /** CPU 健康线（**全机口径**百分比，默认 20） */
  resourceCpuHealthPct: number;
  /** CPU 警戒线（**全机口径**百分比，默认 35） */
  resourceCpuWarnPct: number;
  /**
   * 「系统可用内存」兜底信号：**1 = 开，0 = 关（默认关）**。
   *
   * 它看的不是本应用占了多少，而是**整机还剩多少**——别的程序先把内存吃掉时，
   * 本应用占用很正常却照样会卡死，这个信号就是为那种情况准备的。
   * 默认关是因为它天然更吵（聊的是整机，不只是我们自己）。
   */
  resourceSysMemGuard: number;
  /** 兜底信号的底线（MB，默认 1536）：系统可用内存低于它 → 也算越线 */
  resourceSysMemFloorMB: number;
}

/**
 * 配置的取值范围。主进程读写时一律夹到这个区间里 ——
 * 防止有人手改 JSON 改出负数或 0（那会让功能直接不可用）。
 */
export const SETTINGS_RANGE = {
  /**
   * 子阶段 A：上限从 8 放宽到 20 —— 默认值 20 必须落在合法区间里，
   * 否则「夹到区间」这一步会把默认值本身改回 8。
   */
  maxConcurrentAgentTasks: { min: 1, max: 20 },
  maxBrowserInstances: { min: 1, max: 20 },

  // Phase 4：资源守护者（开关类的用 0/1 —— 本套配置全是数值字段，保持同一形态）
  resourceGuardEnabled: { min: 0, max: 1 },
  resourceSampleMs: { min: 1000, max: 60000 },
  resourceMemHealthMB: { min: 256, max: 65536 },
  resourceMemWarnMB: { min: 512, max: 131072 },
  resourceCpuHealthPct: { min: 1, max: 100 },
  resourceCpuWarnPct: { min: 2, max: 100 },
  resourceSysMemGuard: { min: 0, max: 1 },
  resourceSysMemFloorMB: { min: 128, max: 32768 },
} as const;

/**
 * 默认值（子阶段 A：并发默认 **20**；D：多实例上限默认 **4**；Phase 4：资源阈值见下）。
 *
 * Phase 4 这几个数的依据（本机 15.82 GB / 12 逻辑核，子阶段 A 实测 8 页 ≈ 0.67~1.04 GB）：
 *   - 单页边际 ≈ 123 MB → 4 GB ≈ 30 页，是本机内存的 25%；
 *   - 空闲 CPU 基线只有 0.03~0.23%（全机口径），35% = 约 4.2 个核在满载；
 *   - 3072/4096 之间留一段「灰区」，避免阈值抖动导致反复提示。
 * 这三个数**都是可调的**（见上），改配置即可，不需要改代码。
 */
export const DEFAULT_SETTINGS: WorkbenchSettings = {
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

// ---------------------------------------------------------------------------
// Phase 4：资源守护者（持续资源监控）
//
// 产品理念：**不写死浏览器数量上限**，而是「接近资源极限时才友好提示」。
// 所以这一层只做三件事，**任何一件都不改浏览器行为**：
//   1. 持续采集本应用整体的内存 / CPU（主进程 app.getAppMetrics()，不与任务抢线程）；
//   2. 两档阈值：健康线以内完全不打扰；越过警戒线触发**一次**提示（不阻止任何操作）；
//   3. 把数据落盘 + 经 IPC 暴露，供后续 UI 阶段渲染提示界面（本阶段不做正式 UI）。
//
// 三条红线（与本阶段边界一一对应）：
//   - 不设任何写死的实例数量上限（上限仍只有 maxBrowserInstances 那一个可调配置）；
//   - **绝不自动关闭任何浏览器**，决定权永远在用户手里；
//   - 提示里必须标出「正在跑任务」的实例，否则用户可能照着列表关掉正在干活的页。
// ---------------------------------------------------------------------------

/** 资源档位：ok 健康 / elevated 灰区（不提示，只记录）/ warning 警戒（触发提示） */
export type ResourceLevel = 'ok' | 'elevated' | 'warning';

/** 越线原因（可同时成立）：内存 / CPU / 系统可用内存兜底 */
export type ResourceReason = 'mem' | 'cpu' | 'sys-mem';

/** 单个 Electron 进程的资源明细（与任务管理器逐进程对齐用） */
export interface ResourceProcInfo {
  pid: number;
  /** Electron 给的进程类型：Browser / Tab / GPU / Utility … */
  type: string;
  name?: string;
  /** 工作集（MB）—— 与 tasklist / 任务管理器的「内存」同口径 */
  memMB: number;
  /**
   * 这个进程占**整机** CPU 的百分比（= Electron `percentCPUUsage` 原值）。
   *
   * ⚠️ 别看见它就除以核数：Electron 源码里已经除过了 ——
   * `cpu_dict.Set("percentCPUUsage", GetPlatformIndependentCPUUsage() / processor_count)`
   * （`shell/browser/api/electron_api_app.cc`）。所以 12 核机器上一个核满载，这个值读出来是
   * **8.33**（= 100/12），不是 100。整机口径 100% = 所有逻辑核一起跑满。
   */
  cpuPct: number;
}

/**
 * 一条资源采样（主进程算好，渲染层只读 —— 采集口径只有一份，避免两边算得不一样）。
 */
export interface ResourceSample {
  /** epoch 毫秒 */
  at: number;
  atIso: string;
  /** 本应用**全部进程**的工作集之和（MB）。判定用的就是它。 */
  memMB: number;
  /**
   * 本应用**全部进程**占整机 CPU 的百分比 = 各进程 `percentCPUUsage` 之和。
   *
   * **判定与展示都用它**，且**不要再除核数**：Electron 给的每个进程读数已经是整机口径
   * （源码里除过 `processor_count` 了），再加总就是"本应用占整机多少"，
   * 与任务管理器 / `typeperf \Process(*)\% Processor Time` 逐进程求和**同一口径、可直接对比**
   * （100% = 所有逻辑核跑满）。
   *
   * 第一版这里犯的错：把"各进程之和"当成"占一个核的百分比"又除以一次核数 ——
   * 12 核机器上把 CPU 判定灵敏度整整缩小 12 倍（20% 的警戒线实际要等 240% 才可能触发）。
   * 真机取证时发现：一个内嵌页跑满一个核，单进程读数 8.25 ≈ 100/12，正是这个口径的证据。
   */
  cpuPct: number;
  /** 把 cpuPct 换算成"相当于几个核"（`cpuPct/100*logicalCores`）—— 只用于文案，不参与判定 */
  cpuCoresUsed: number;
  /** 逻辑核数（随样本一起给出，便于复核 cpuPct ↔ 核数之间的换算关系） */
  logicalCores: number;
  procCount: number;
  procs: ResourceProcInfo[];
  /** 系统可用内存（MB）；**兜底信号关闭时为 null**（不采集就不假装知道） */
  sysFreeMB: number | null;
  /** 本机物理内存总量（MB），用于把阈值换算成"占整机多少"给人看 */
  sysTotalMB: number;
  /**
   * 这一点所属的**状态档位**（已去抖，与 ResourceGuardSnapshot.level 同一口径）：
   * `ok` 健康 / `elevated` 灰区（只记录、不提示）/ `warning` 已进入警戒。
   */
  level: ResourceLevel;
  /**
   * **这一点自己**的越线原因（**未去抖**；没越线就是空数组）。
   * 所以会出现「reasons 非空但 level=ok」的采样点 —— 那正是一次还没凑够
   * 连续 3 点的毛刺，如实记录而不当成问题。
   */
  reasons: ResourceReason[];
}

/** 一个浏览器实例（给「最久未使用」排序用）——由渲染层上报（它才掌握标签页生命周期） */
export interface BrowserInstanceInfo {
  /** guest webContents id（实例的唯一身份） */
  wcId: number;
  /** 开这张页的智能体（标签页/任务归属仍按它，Phase 3 起没变） */
  agentId: number;
  /** 这张页所属项目（登录态归属，Phase 3 起） */
  projectId: number | null;
  /** 标签显示名（标题优先，兜底域名） */
  title: string;
  url: string;
  /** 建页时间 */
  createdAt: number;
  /** 最后一次「有用」的时间：切到它 / 导航 / 标题变化 / 被驾驶员推进 */
  lastActiveAt: number;
  /** **正在被驾驶员操作** —— 提示里必须标出来（别让用户把在干活的页关掉） */
  driving: boolean;
}

/** 阈值快照（提示事件里存一份：事后能复核"当时是按哪套阈值判的"） */
export interface ResourceThresholds {
  memHealthMB: number;
  memWarnMB: number;
  cpuHealthPct: number;
  cpuWarnPct: number;
  sysMemGuard: number;
  sysMemFloorMB: number;
}

/** 一次警戒提示（主进程拼装好；本阶段只落盘 + 广播，正式样式留给 UI 阶段） */
export interface ResourceAlert {
  /** 事件号（同一次警戒只发一个） */
  id: string;
  at: number;
  atIso: string;
  level: 'warning';
  /** 触发那一刻的采样 */
  sample: ResourceSample;
  reasons: ResourceReason[];
  thresholds: ResourceThresholds;
  /**
   * **最久未使用的排在最前**（按 lastActiveAt 升序）。
   * 含全部实例；`driving=true` 的实例**不从列表里剔除**，只做标记 ——
   * 关不关是用户的决定，我们的责任是把"这个正在干活"如实说清楚。
   */
  idleRanking: BrowserInstanceInfo[];
  /** 人话文案（本阶段复用既有单行提示通道显示，UI 阶段可换成正式组件） */
  text: string;
}

/**
 * 一条**汇总**采样（60s 粒度，落盘的就是这个）。
 *
 * 为什么落盘的不是原始 5s 点：5s × 86400 = 17280 条/天 ≈ 3.5MB/天，
 * 而 60s 汇总只要 1440 条/天 ≈ 290KB/天。监控**不能自己变成新的负担**，
 * 所以落盘只留汇总；原始 5s 点留在主进程内存的环形缓冲里（最近 1 小时）。
 */
export interface ResourceAggregate {
  /** 这个汇总窗口的起点（epoch 毫秒，按 60s 对齐） */
  windowAt: number;
  windowAtIso: string;
  /** 窗口内的点数 */
  count: number;
  memAvgMB: number;
  memMaxMB: number;
  cpuAvgPct: number;
  cpuMaxPct: number;
  /** 窗口内出现过的最高档位 */
  maxLevel: ResourceLevel;
}

/** 资源守护者的实时视图（IPC `workbench:resources:snapshot` 的返回） */
export interface ResourceGuardSnapshot {
  enabled: boolean;
  sampleMs: number;
  /**
   * 主进程自己的 pid。
   *
   * 有了它，"监控自身的开销"才能被**单独**量出来（只看这一个进程的 CPU，
   * 而不是把整个应用的进程一起算）—— 那正是验收标准③要的那个数。
   */
  mainPid: number;
  level: ResourceLevel;
  /** 最新一次采样（还没采到时为 null） */
  sample: ResourceSample | null;
  thresholds: ResourceThresholds;
  /** 连续越线计数（去抖用，暴露出来便于验收核对"连续 3 点"这条） */
  overStreak: number;
  underStreak: number;
  lastAlertAt: number | null;
  /** 同类提示的冷却（毫秒） */
  cooldownMs: number;
  /** 落盘位置（数据可查处，供后续 UI / 排查用） */
  dir: string;
  /** 内存环形缓冲里现有多少点（默认保留最近 1 小时） */
  buffered: number;
}

/**
 * 阶段 0 · Tool Registry 定义侧（本包唯一的运行时模块，服务端专用）。
 * 桌面端只允许 import 上面的类型 —— 打包产物里没有这个包的运行时，详见 tools.ts 文件头。
 */
/** 定时/事件触发（Routines）：描述=长期规矩，对话=一次活 */
export type RoutineTriggerType = 'interval' | 'cron' | 'event';
export interface RoutineView {
  id: number;
  projectId: number;
  agentId: number;
  agentName?: string;
  name: string;
  description: string;
  triggerType: RoutineTriggerType;
  triggerConfig: any;
  taskTemplate: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}
export interface RoutineListResult {
  routines: RoutineView[];
}
export interface RoutineCreateResult {
  routine: RoutineView;
}

/** 批次 B | 项目共享白板：项目简报，所有成员自动注入；贴白板=待确认记忆卡 */
export interface WhiteboardView {
  id: number;
  projectId: number;
  agentId: number | null;
  content: string;
  status: 'active' | 'pending' | 'archived';
  needsConfirm: boolean;
  source: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface WhiteboardListResult {
  projectId: number;
  whiteboard: WhiteboardView[];
}
export interface WhiteboardPostResult {
  ok: boolean;
  whiteboard: WhiteboardView;
}

export * from './tools';

/**
 * 批次 J（2026-09-24）：`@点名` 的确定性解析器。
 *
 * ★ 这是本包**第二份**运行时代码（第一份是 tools.ts），但两者能被谁 import 的口径不同：
 *   · 服务端：走包名运行时 import（与 `SENSITIVE_TARGET_RE` 同一条路，需要 `npm run build -w @ai-workbench/shared`）；
 *   · 桌面**渲染层**：直接 import 本包的**源文件**（相对路径），Vite 会把它内联进产物，
 *     不依赖 dist 有没有 build 过；
 *   · 桌面 **Electron 主进程**：**永远不要**运行时 import 本包（tsc 直出、打包产物里没有
 *     node_modules，启动即崩）—— 见 tools.ts 文件头那条警告。点名解析只在渲染层用，不需要进主进程。
 * 全仓只许有一份实现，`npm run verify:mention` 的第 ⑧ 段会扫全仓钉住这件事。
 */
export * from './mention';
