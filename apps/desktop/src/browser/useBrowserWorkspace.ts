import { useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserInstanceInfo } from '@ai-workbench/shared';
import { HOME_URL, isStartPage } from './sites';
import { SOFT_TAB_HINT, hostLabel, sameSite, toHttpUrl } from './url';
import { DEFAULT_SLEEP_OPTIONS, decideSleep } from './sleepPolicy';
import type { BrowserPageInfo, BrowserTabView } from './types';

/**
 * 第 20 步 · 浏览器模块：**按智能体分桶的工作区状态机**（tab 状态 + 开页/关页 + 驾驶接口）。
 *
 * 硬约束（本步钉死，别推翻）：
 *   - 仍是 Electron 的 <webview>，**不套 Edge / Chrome / CEF，不用 Playwright**；
 *   - 每张页的分区是 `partitionFor(projectId)` —— **一个项目一套 cookie / 登录态**，
 *     同项目的多个智能体共用这一套（Phase 3 改的粒度），不同项目之间完全隔离；
 *     绝不再用全局的 `persist:workbench-browser`，也绝不再按 agentId 分（那是第 20 步的旧口径）；
 *   - **活页上限由配置项 `maxBrowserInstances` 决定**（第 22 步起，默认 4，设置里可调）：
 *     到顶只**拒绝新开**并说一句人话，**绝不偷偷关页、也绝不顶掉最旧那张**
 *     （第 20 步取消的是写死的 `MAX_LIVE_PAGES = 10`，不是「有上限」这件事本身）；
 *   - 切 tab = 把对应那张 webview 放到最前面（z-index），**不为每个 tab 开 BrowserWindow**；
 *   - 收起不是把页面藏没：舞台仍留一块高度（webview 尺寸为 0 会让驾驶点不中任何元素）。
 *
 * ⚠️ **Phase 3 的红线（别改过头）**：分区合并**只发生在登录态这一层**。
 *    下面所有桶（`pages` / `active`）、`openUrl(agentId, …)`、`closeTabsOfAgent(agentId)`、
 *    驾驶接口、`stopDriving` 全部**仍然按 agentId**：同项目的两个智能体
 *    共用一套 cookie，但**各有各的标签页、各有各的任务**，不合并显示、不共享执行状态。
 *
 * 状态是**窗口级 + 按智能体分桶**的：
 *   - 一个智能体 = 一套独立的标签页（自己的 tab、自己的当前页）；登录态与同项目的兄弟共享；
 *   - 切智能体只换「哪一桶可见」，**所有页的 webview 一直挂着不卸载** ——
 *     这样切到别的智能体去聊别的时，原来那几路驾驶不会断，切回来页面和滚动都还在。
 *
 * 第 18 步起的「治混乱」规矩照旧：
 *   - **开页成功不往聊天里写东西**（看 tab 就行，不再每页一条「已打开」）；
 *   - 关 tab 只从工作区消失，聊天里最多留**一句**人话（单条提示，不累加、不列关闭清单）。
 */

interface BrowserWorkspaceOptions {
  /** 往聊天区说**一句**人话（单条提示，不累加）。开页成功不报——看 tab 就行。 */
  onNote?: (text: string) => void;
  /** 此刻正在聊的那个智能体（**响应式**：一变就换可见的那一桶） */
  currentAgentId: number | null;
  /** 同上，给异步流程取「此刻」的值（回调里读，避免闭包拿到过期的） */
  getCurrentAgent: () => number | null;
  /**
   * 第 22 步 · D：**多实例上限**（默认 4，设置里可调）的取值函数。
   * 传函数而不是数值：配置随时可能被改，用函数才能永远读到最新值，
   * 也避免「改了配置 → 整个 hook 重建 → 页的引用全换一遍」。
   */
  getMaxInstances?: () => number;
  /**
   * Phase 3：**某个智能体属于哪个项目**。
   *
   * 只用来算这张页的**分区**（登录态那一层，同项目共享）；不用来分桶 ——
   * 桶键永远是 agentId（标签页/任务按智能体隔离，这条没变）。
   * 传函数而不是映射对象：智能体是活数据（新建/切换项目会变），用函数才读得到最新值。
   * 返回 null = 认不出 → 落兜底分区（`-none`），**不跟任何真项目混**。
   */
  getProjectOfAgent?: (agentId: number) => number | null;
}

/**
 * 第 22 步：多实例上限的兜底值。
 *
 * ⚠️ 这是 `packages/shared` 里 `DEFAULT_SETTINGS.maxBrowserInstances` 的**第二份**。
 * 正常路径下上限永远由主进程的配置经 `getMaxInstances` 给到，这里只在
 * 「配置还没同步过来 / 桥异常」时兜底 —— 宁可兜一个保守值，也不要静默变成无上限。
 */
const FALLBACK_MAX_INSTANCES = 4;

export interface BrowserWorkspace {
  /** 此刻正在聊的那个智能体（舞台靠它决定「谁的页该露出来」） */
  currentAgentId: number | null;
  /** **当前智能体自己**的活页（顶栏显示的就是这些 —— 同项目兄弟智能体的页不在这儿） */
  tabs: BrowserTabView[];
  /** **所有智能体**的活页（舞台要把它们全挂着——切走的那些页也必须活着） */
  allTabs: BrowserTabView[];
  /** 当前智能体切到前面的那张 */
  activeId: number | null;
  active: BrowserTabView | null;
  /**
   * 第 25 步 · 浏览器视图（**只影响"要不要看"，不影响任务跑不跑**）：
   *   - `'fullscreen'`：浏览器占满中栏会话区；
   *   - `'background'`：用户退出了全屏 —— 面板**照旧挂载、webview 照旧真实尺寸**，
   *     只是整层不可见（opacity 0 + 不接收指针），任务继续跑，右下角留一个小图标可随时回来。
   *   - `'embed'`（第 27 步）：求助卡模式 —— 层透明且不吃指针事件，
   *     **只有求助的那一张页**按聊天卡片里的占位几何显示出来（其余页照旧活着、照旧不露脸）。
   */
  view: 'fullscreen' | 'background' | 'embed';
  /** 正在被驾驶员操作的那几张（tabId，跨智能体）：标签上点一个小圆点 */
  drivingIds: number[];
  /** 当前智能体的页数（没有上限，只用来显示与提示） */
  tabCount: number;
  /** 页数偏多（≥ SOFT_TAB_HINT）：UI 上提示「开太多会卡」，**不关页** */
  softHint: boolean;
  /**
   * 第 24 步：向地址栏发一次「请聚焦」的请求（自增计数）。
   *
   * 为什么是计数而不是布尔：认不出站点时可能连续来两次，
   * 布尔值第二次不变化 → useEffect 不触发 → 用户第二次看不到聚焦。
   */
  urlBarFocusTick: number;
  /** 第 24 步：请求把焦点交给地址栏（BrowserPanel 监听到计数变化后执行） */
  focusUrlBar: () => void;
  /**
   * 第 25 步：回到全屏浏览器视图。
   *
   * 触发点：用户点右下角小图标 / 用户明确开页 / 敏感字段等待需要用户操作。
   * ★ 它**只是换视图**，不碰任何驾驶状态（不 start / 不 resume / 不改 sleep）。
   */
  showFullscreen: () => void;
  /**
   * 第 25 步：退出全屏 → 浏览器转入后台继续运行。
   *
   * ★ 退出 ≠ 关闭 ≠ 暂停：面板不卸载、webview 尺寸不变、驾驶循环照跑。
   *   界面只是把可视区域让给聊天，并亮起"后台运行中"小图标。
   */
  exitFullscreen: () => void;
  /**
   * 第 27 步（人工介入卡片）：**求助卡模式** —— 让某一张页"嵌"进聊天流里显示。
   *
   * ★ 它**不搬 DOM、不卸载 webview、不动 guest 生命周期**（这是本步的硬约束）：
   *   只是把浏览器层的可见方式换成「除了这一张，别的都不露脸 + 这一张的几何跟着
   *   聊天流里那块占位区走」。所以 `wcId` 不变、驾驶链路一秒都不受影响。
   *
   * 为什么必须由它来切视图：用户很可能正开着全屏浏览器 —— 那时候聊天区整个被盖住，
   * 卡片弹出来了也看不见。所以求助一触发就自动切到这里（"自动切回聊天视图"）。
   */
  enterEmbed: (wcId: number) => void;
  /** 退出求助卡模式（用户关掉卡片 / 处理完了 / 卡片被收掉） */
  exitEmbed: () => void;
  /** 此刻"嵌"在聊天流里的是哪一张页（null = 不在求助卡模式） */
  embedWcId: number | null;

  /** <webview> 宿主：元素挂上/摘下时登记（驾驶要靠它拿 guest webContents id） */
  registerWebview: (tabId: number, el: HTMLElement | null) => void;
  /** 页面自己改了地址/标题（点链接、SPA 跳转）时回报，用来更新标签与 URL 栏 */
  notePageInfo: (tabId: number, info: BrowserPageInfo) => void;
  /**
   * Phase 3：把「这张页的 guest webContents id 属于哪个智能体」告诉主进程。
   *
   * 主进程从分区名里只能读到**项目**，读不到智能体；而下载记录要能标出
   * 「这是哪个智能体触发的」，所以由这边在页就绪时登记一次。
   */
  noteOwner: (tabId: number) => void;

  /**
   * Phase 4：记一次「这个实例刚被用过」（用户切到它 / 它导航了 / 它被驾驶员推进一步）。
   *
   * 只有时间戳，不产生任何副作用，也不触发渲染 —— 它就是「最久未使用」排序的原料。
   * 驾驶员推进时由 App.tsx 代调（那边才收得到主进程的 step 事件）。
   */
  touchTab: (tabId: number) => void;
  /**
   * Phase 4：把当前**所有**浏览器实例（含最后使用时间）摘一份给资源守护者。
   *
   * ⚠️ 只报「已经拿到 guest id」的页 —— 还没 dom-ready 的页在主进程那边
   *    也对应不到进程，报上去只会让排序里多一条对不上的记录。
   */
  instanceList: () => BrowserInstanceInfo[];

  /**
   * 给**某个智能体**开页（同站复用只在它自己那些页里找）。
   * 第 20 步：没有上限、没有排队、没有顶掉最旧 —— 一定能开出新页，返回它的 tabId。
   */
  openUrl: (agentId: number, rawUrl: string) => Promise<number | null>;
  openHome: (agentId: number) => Promise<number | null>;
  /** 用户点「＋」：给此刻正在聊的智能体开一张默认主页（不自动发车，等他给指令） */
  openNewTab: () => void;
  /** 用户点 ✕ 关掉一张（聊天里最多留一句人话） */
  closeTab: (tabId: number) => void;
  /** 某个智能体开的那些页一起关掉（删智能体 / 登出时用；不单独刷聊天） */
  closeTabsOfAgent: (agentId: number) => void;
  closeAllTabs: () => void;
  activate: (tabId: number) => void;
  navigate: (tabId: number, url: string) => void;
  /** 把焦点交给当前智能体那张页（它还没开过就先开一张默认主页） */
  focusActive: () => void;

  /** 驾驶接口：这张 tab 的 guest webContents id（还没 dom-ready 时为 undefined） */
  webContentsIdOf: (tabId: number) => number | undefined;
  /** 驾驶接口：等这张页就绪并拿到 guest id（webview 没 dom-ready 时 getWebContentsId 会抛错） */
  awaitWebContentsId: (tabId: number) => Promise<number | undefined>;
  /** 驾驶接口：主进程报的 guest id → 是哪张 tab（跨智能体找，事件才落得回正确的聊天） */
  tabIdOfWebContents: (wcId: number) => number | null;
  /** 这张 tab 是哪个智能体开的（驾驶事件按它落回正确的聊天） */
  ownerOf: (tabId: number) => number | undefined;
  /** 主进程说「把焦点给这张页」 */
  focusByWebContents: (wcId: number) => void;
  /** 主进程说「打开这个网址」（落给此刻正在聊的那个智能体） */
  openFromMain: (url: string) => void;
  /**
   * 第 23 步：内嵌页里的 target=_blank / window.open → 开一条**新 tab**。
   * 与 openFromMain 的差别：按 preferAgentId 归属、且**不复用同站页**（强制新开）。
   */
  openFromPage: (url: string, preferAgentId: number | null) => void;
  /** 同步「到底哪几张在跑」 */
  refreshDriving: () => Promise<void>;
  /** 「停」：点名就只停那一路；没点名且当前页没在跑 → 全停 */
  stopDriving: (tabId?: number) => void;

  /**
   * 第 24 步：**唤醒**一张休眠的页。
   *
   * 三种调用点：
   *   1. 用户切到那张 tab（Chrome 就是自动唤醒的）；
   *   2. AI 要给那张页派任务（**必须先醒再派**，否则 AI 面对一张空页）；
   *   3. 那张页自己有了活动（导航/标题变化）。
   *
   * 唤醒是**同步标记 + 异步重载**：立刻把 `sleep` 清掉让 UI 变回正常，
   * 深休眠那张的 `<webview>` 由 React 重新挂载（浏览器的加载进度条自己会表现）。
   */
  wakeTab: (tabId: number) => void;
  /** 这张页现在是不是休眠态（含深度）—— 派任务前要用它判断"要不要先叫醒" */
  sleepOf: (tabId: number) => 'shallow' | 'deep' | undefined;
  /**
   * 这张页已经闲置多久（毫秒）。给 tooltip 用（「已休眠 12 分钟」比只写「已休眠」让人安心）。
   * 读的是时间线 ref，**不触发渲染** —— 它只在上层重渲染时顺带被读一次。
   */
  idleMsOf: (tabId: number) => number;
  /** 用户点「唤醒」占位卡时用：等价于 wakeTab，但会把这张页切到前台 */
  wakeAndActivate: (tabId: number) => void;
  /** 休眠总开关（用户能一键关掉 —— 做需要多页同时活着的事时，休眠只会碍事） */
  sleepEnabled: boolean;
  setSleepEnabled: (next: boolean) => void;
}

export function useBrowserWorkspace(options: BrowserWorkspaceOptions): BrowserWorkspace {
  // 回调放进 ref：hook 里一堆异步流程要用最新值，但不该因为它们变化重建所有函数
  const onNoteRef = useRef(options.onNote);
  onNoteRef.current = options.onNote;
  const getAgentRef = useRef(options.getCurrentAgent);
  getAgentRef.current = options.getCurrentAgent;
  /** 第 22 步：多实例上限的取值函数（同样是每次调用时读最新配置） */
  const getMaxInstancesRef = useRef(options.getMaxInstances);
  getMaxInstancesRef.current = options.getMaxInstances;
  /**
   * Phase 3：agentId → projectId 的解析（**只喂分区**）。
   * 同样每次调用时现读 —— 新建智能体 / 切项目后要立刻能认出来。
   */
  const getProjectOfAgentRef = useRef(options.getProjectOfAgent);
  getProjectOfAgentRef.current = options.getProjectOfAgent;
  /** 当前可见的智能体：切它只换「哪一桶可见」，页本身一张都不卸载 */
  const visibleAgentId = options.currentAgentId;
  const visibleAgentRef = useRef<number | null>(visibleAgentId);
  visibleAgentRef.current = visibleAgentId;

  /**
   * 桶是**按智能体**分的：`{ [agentId]: 这个智能体自己的活页[] }`。
   * ref 是权威副本（同步读写，避免同一 tick 里连续开页时读到过期的 state）。
   */
  const pagesRef = useRef<Record<number, BrowserTabView[]>>({});
  const [pages, setPages] = useState<Record<number, BrowserTabView[]>>({});
  const commitPages = (next: Record<number, BrowserTabView[]>): void => {
    pagesRef.current = next;
    setPages(next);
  };

  /** 每个智能体自己「切到前面的是哪张」 */
  const activeRef = useRef<Record<number, number | null>>({});
  const [activeByAgent, setActiveByAgent] = useState<Record<number, number | null>>({});
  const commitActive = (next: Record<number, number | null>): void => {
    activeRef.current = next;
    setActiveByAgent(next);
  };

  /**
   * 第 25 步：浏览器视图（全屏 / 后台）。
   *
   * ★ 与第 19~24 步的"收起"最大的区别：**后台态不改变面板的任何布局尺寸**。
   *   老实现是"收起 = 舞台高度压到 180px"，仍然占地方；新实现是整层挪出可视区
   *   （见 browser/styles.css 的 `.browserLayer--bg`），会话区完全还给聊天。
   *   两种实现都**不动 webview 的挂载与尺寸** —— 这是硬约束：
   *   驾驶的点击坐标来自页内 getBoundingClientRect，尺寸归零会让坐标全部失效。
   */
  /**
   * 第 27 步：多出第三种视图 `'embed'`（求助卡模式）。
   *
   * 三态的语义边界（别混）：
   *   · `fullscreen` —— 浏览器铺满中栏会话区（聊天被盖住）；
   *   · `background` —— 整层 opacity:0 挪到后台，聊天完全露出来（页照样活着）；
   *   · `embed`      —— 层透明且不吃指针事件，**只有求助的那一张页**按聊天卡片里的
   *                    占位几何显示出来（其余页与全屏一样不露脸，但全部照旧活着）。
   */
  /**
   * ★ 第 28 步（用户 2026-09-21 定的交互模型）：**默认 `background`，不是 `fullscreen`**。
   *
   * 为什么改：以前一开页（哪怕只是 AI 自己在后台干活）浏览器就铺满中栏、把会话盖住，
   * 用户看到的是"会话不见了"。新口径是「**会话就是会话，浏览器是 AI 的地盘**」：
   *   · **用户**明确要看浏览器（说"打开 XX"、点「＋」）→ `openUrl` 里会 `setView('fullscreen')`，照旧弹出；
   *   · **AI 自己**开页（`openFromPage`，例如"帮我注册抖音店铺"）→ 不调 `setView`，
   *     于是落在这个初始值上 = **后台跑，会话一动不动**；用户想看随时点右下角小图标。
   *
   * ⚠️ 别把这个初始值改回 `'fullscreen'`：那等于让 AI 每开一张新页就把用户的聊天顶掉一次。
   */
  const [view, setView] = useState<'fullscreen' | 'background' | 'embed'>('background');
  /** 求助卡模式里"嵌"的是哪一张页（按 guest id，和主进程的 wcId 同一套 id） */
  const [embedWcId, setEmbedWcId] = useState<number | null>(null);
  /**
   * `embedWcId` 的 ref 镜像。
   *
   * 为什么需要它（**这是第 27 步最容易踩的一个坑，实测踩过**）：
   *   `activate()` 里有一句"切到某张页 = 回到全屏"，而 `activate` 会被主进程的
   *   `workbench:browser:focus` 走到 —— 敏感字段等待（第 9 步）就发它。
   *   于是求助卡刚把视图切到 embed，紧接着那条 focus 消息一到，
   *   `activate()` 又把它切回全屏，**卡片当场被盖住**（表现：卡片在，但看不见页面那一块）。
   *   `activate` 是普通函数、不是 effect，拿不到最新的 state，只能读 ref。
   */
  const embedWcIdRef = useRef<number | null>(null);
  embedWcIdRef.current = embedWcId;
  /**
   * 进求助卡模式**之前**用户在哪一态（`fullscreen` / `background`）。
   *
   * 为什么要记它：求助处理完之后不能一律回全屏 ——
   * 用户如果是**自己主动退出全屏**在聊天里看消息的，你把他切到全屏就等于
   * 把他正在看的聊天盖住了（他得再点一次「退出全屏」才能回来）。
   * 正确的做法是**从哪来回哪去**：原来是后台就回后台。
   */
  const viewBeforeEmbedRef = useRef<'fullscreen' | 'background' | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [drivingIds, setDrivingIds] = useState<number[]>([]);
  /** 第 24 步：地址栏聚焦请求的计数（见接口注释：用计数不用布尔） */
  const [urlBarFocusTick, setUrlBarFocusTick] = useState(0);
  const drivingIdsRef = useRef<number[]>([]);
  drivingIdsRef.current = drivingIds;

  /** tabId → <webview> 元素 */
  const webviewRefs = useRef<Record<number, HTMLElement | null>>({});

  /**
   * Phase 4：每个浏览器实例的时间线 —— 「最久未使用」排序的依据。
   *
   * 刻意只放 **ref** 不放 state：`lastActiveAt` 每次用时都要变，若走 state 会让
   * 整块浏览器 UI 跟着重渲染（监控不该成为新的性能负担）。它只在**上报给主进程**时被读，
   * 而"需要真实时刻"的那几处（授权 / 隔离 / 提示）本来就是事件驱动，不用它触发渲染。
   *
   * ★ 第 24 步起它多了一个用途：**休眠判定的输入**。
   *   但"读它来判定"这件事发生在**定时器**里（每 30 秒一次），
   *   不是每次 touch 都读 —— 所以上面"不触发渲染"这条性质仍然成立。
   */
  const createdRef = useRef<Record<number, number>>({});
  const lastActiveRef = useRef<Record<number, number>>({});

  /**
   * 第 24 步：**休眠开关**（用户能一键关掉）。
   *
   * 为什么要给开关：休眠是有代价的（深休眠唤醒要重新加载）。用户如果在做
   * 需要多页同时活着的事（比如对着三个页面抄数据），休眠只会碍事。
   * 默认开 —— 因为"长时间不用自己收起来、不占内存"是用户明确要的行为。
   */
  const [sleepEnabled, setSleepEnabled] = useState(true);
  const sleepEnabledRef = useRef(true);
  sleepEnabledRef.current = sleepEnabled;
  /**
   * 被用户**手工唤醒**过的页：在 `wakeGraceMs` 内不再被自动判定去睡。
   *
   * 为什么需要"宽限"：唤醒后如果立刻又被判成浅休眠（因为它本来就闲置了很久），
   * 用户会看到图标闪一下又回去 —— 像坏了。
   * 手工唤醒 = 明确的"我要用这张"，就该让它清醒一阵子。
   */
  const wakeGraceRef = useRef<Record<number, number>>({});
  const WAKE_GRACE_MS = 2 * 60 * 1000;

  /**
   * Phase 4：记一次「这个实例刚被用过」。
   *
   * 触发点 = 用户切到这张 tab / 这张页导航或标题变化 / 这张页被驾驶员推进一步。
   * 不做「页面内鼠标点击」级别的追踪：那需要往 guest 页里注入监听（侵入别人的页面），
   * 而上面四个触发点已经足够回答"哪几个实例最该被关掉"这个问题。
   */
  const touchTab = (tabId: number): void => {
    if (!findTab(tabId)) return;
    lastActiveRef.current[tabId] = Date.now();
  };

  const note = (text: string): void => onNoteRef.current?.(text);

  /** 标签上显示什么：标题优先，兜底域名 */
  const label = (t: BrowserTabView): string => t.title || hostLabel(t.url) || t.bootUrl;

  /** 渲染用：所有智能体的页摊平（舞台要全挂着）；找页一律走 pagesRef，别用这个 */
  const allTabs = useMemo(() => Object.values(pages).flat(), [pages]);

  const tabs = visibleAgentId !== null ? pages[visibleAgentId] ?? [] : [];
  const activeId = visibleAgentId !== null ? activeByAgent[visibleAgentId] ?? null : null;
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;

  /** 摊平所有桶（**以 ref 为准**，同一 tick 里刚开的页也能立刻找到） */
  const flatTabs = (): BrowserTabView[] => Object.values(pagesRef.current).flat();

  const findTab = (tabId: number): BrowserTabView | undefined => {
    for (const list of Object.values(pagesRef.current)) {
      const t = list.find((x) => x.id === tabId);
      if (t) return t;
    }
    return undefined;
  };
  const bucketOf = (agentId: number): BrowserTabView[] => pagesRef.current[agentId] ?? [];

  const setBucket = (agentId: number, next: BrowserTabView[]): void => {
    commitPages({ ...pagesRef.current, [agentId]: next });
  };

  const setActiveFor = (agentId: number, tabId: number | null): void => {
    commitActive({ ...activeRef.current, [agentId]: tabId });
  };

  // ---- 驾驶接口：tab ↔ guest webContents id ----

  const webContentsIdOf = (tabId: number): number | undefined => {
    const el = webviewRefs.current[tabId] as unknown as { getWebContentsId?: () => number } | null;
    try {
      return el?.getWebContentsId?.();
    } catch {
      return undefined;
    }
  };

  /**
   * 等某张 tab 里的 <webview> 就绪并拿 guest webContents id。
   * webview 还没 dom-ready 时 getWebContentsId() 会抛错，所以重试几轮。
   * 第 17 步起**必须点名是哪张页**——主进程不会再自己瞎挑一张。
   */
  const awaitWebContentsId = async (tabId: number): Promise<number | undefined> => {
    for (let i = 0; i < 25; i += 1) {
      const id = webContentsIdOf(tabId);
      if (typeof id === 'number' && id >= 0) return id;
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
    return undefined;
  };

  /** 反过来：主进程报的 guest id → 是哪张 tab（跨智能体找） */
  const tabIdOfWebContents = (wcId: number): number | null => {
    for (const t of flatTabs()) if (webContentsIdOf(t.id) === wcId) return t.id;
    return null;
  };

  const ownerOf = (tabId: number): number | undefined => findTab(tabId)?.agentId;

  /**
   * Phase 3：把这张页的 guest id ↔ 智能体告诉主进程（下载记录要标「哪个智能体触发的」）。
   * 拿不到 guest id（还没 dom-ready）时什么都不做——等下一次（did-navigate / 切换）再报。
   */
  const noteOwner = (tabId: number): void => {
    const t = findTab(tabId);
    const wcId = webContentsIdOf(tabId);
    if (!t || typeof wcId !== 'number') return;
    void window.workbench?.browserOwner?.(wcId, t.agentId);
  };

  /**
   * 第 24 步：把 `sleep` 落进 tab 数据（复用 commitPages，不额外开 state）。
   *
   * 为什么不做成独立的 `sleepState` map：
   *   休眠态本来就是**那张页的属性**（它此刻睡没睡），放进 `BrowserTabView` 里
   *   渲染层直接读得到，不用再维护"tabId → 状态"的第二份映射去对账。
   */
  const applySleep = (plan: Record<number, 'shallow' | 'deep'>): void => {
    const current = pagesRef.current;
    let changed = false;
    const next: Record<number, BrowserTabView[]> = {};
    for (const [agentId, list] of Object.entries(current)) {
      next[Number(agentId)] = list.map((t) => {
        const want = plan[t.id];
        /*
         * 三种情况一起处理：
         *   - plan 里没有 + 当前是休眠 → 该唤醒（时间到了 / 被驾驶了 / 到前台了）；
         *   - plan 里有 + 深度不同 → 升级（浅→深）；
         *   - plan 里有 + 深度相同 → 原样返回（避免每次扫描都产出新数组、把 UI 全刷一遍）。
         */
        if (want === t.sleep) return t;
        changed = true;
        return want ? { ...t, sleep: want } : { ...t, sleep: undefined };
      });
    }
    // 什么都没变就**不 commit** —— 每 30 秒一次的无谓重渲染要避免
    if (changed) commitPages(next);
  };

  /**
   * 第 24 步：跑一次休眠判定（定时器每 30 秒调一次）。
   *
   * 判定逻辑全在 `sleepPolicy.decideSleep` 那个**纯函数**里（可拨时钟、可穷举红线），
   * 这里只负责"喂数据 + 落结果"。
   */
  const sweepSleep = (): void => {
    if (!sleepEnabledRef.current) return;
    const now = Date.now();
    // 宽限期内的页，把它当成"刚刚用过"（否则刚唤醒又被判睡，图标会闪）
    const cands = flatTabs().map((t) => {
      const grace = wakeGraceRef.current[t.id];
      const lastActiveAt =
        grace !== undefined && now - grace < WAKE_GRACE_MS ? now : lastActiveRef.current[t.id] ?? 0;
      return { id: t.id, lastActiveAt, createdAt: createdRef.current[t.id] ?? 0 };
    });
    if (cands.length === 0) return;
    const plan = decideSleep({
      tabs: cands,
      drivingIds: drivingIdsRef.current,
      activeTabId: activeRef.current[getAgentRef.current() ?? -1] ?? null,
      now,
    });
    applySleep(plan);
  };

  /** 这张页现在睡没睡（派任务前要用它判断"要不要先叫醒"） */
  const sleepOf = (tabId: number): 'shallow' | 'deep' | undefined => findTab(tabId)?.sleep;

  /** 这张页闲置了多久（给 tooltip 用）。没有任何记录时按「刚用过」算，避免显示成天文数字。 */
  const idleMsOf = (tabId: number): number => {
    const grace = wakeGraceRef.current[tabId];
    if (grace !== undefined) return Date.now() - grace;
    const last = lastActiveRef.current[tabId] ?? createdRef.current[tabId] ?? Date.now();
    return Math.max(0, Date.now() - last);
  };

  /**
   * 唤醒一张页。
   *
   * `manual = true`（用户主动）会记一个宽限期，让它在 `WAKE_GRACE_MS` 内不再被判定去睡；
   * `manual = false`（系统内部：派任务前唤醒）不记宽限 —— 那是"干活需要它醒"，
   * 干完就该照常睡回去。
   */
  const wakeTab = (tabId: number, manual = true): void => {
    const t = findTab(tabId);
    if (!t) return;
    lastActiveRef.current[tabId] = Date.now();
    if (manual) wakeGraceRef.current[tabId] = Date.now();
    if (!t.sleep) return;
    // 只改这一张：把它从休眠态摘出来，React 会据此重新挂载 <webview>（深休眠）
    const next: Record<number, BrowserTabView[]> = {};
    for (const [agentId, list] of Object.entries(pagesRef.current)) {
      next[Number(agentId)] = list.map((x) => (x.id === tabId ? { ...x, sleep: undefined } : x));
    }
    commitPages(next);
  };

  /** 占位卡上的「唤醒」按钮：唤醒 + 把这张切到前台 */
  const wakeAndActivate = (tabId: number): void => {
    wakeTab(tabId, true);
    activate(tabId);
  };

  /**
   * Phase 4：当前所有浏览器实例（资源守护者排序用）。
   * `driving` 这里只是初值 —— 主进程会用自己 lanes 的权威值覆盖它（见 resource-guard.ts）。
   */
  const instanceList = (): BrowserInstanceInfo[] => {
    const out: BrowserInstanceInfo[] = [];
    for (const t of flatTabs()) {
      const wcId = webContentsIdOf(t.id);
      if (typeof wcId !== 'number') continue;
      const created = createdRef.current[t.id] ?? Date.now();
      out.push({
        wcId,
        agentId: t.agentId,
        projectId: t.projectId,
        title: label(t),
        url: t.url || t.bootUrl,
        createdAt: created,
        lastActiveAt: lastActiveRef.current[t.id] ?? created,
        driving: drivingIdsRef.current.includes(t.id),
      });
    }
    return out;
  };

  /** 主进程当前在驾驶哪几张页 → 映射成 tabId（标签圆点） */
  const refreshDriving = async (): Promise<void> => {
    const list = await window.workbench?.agentLanes?.();
    if (!list) return;
    const ids: number[] = [];
    for (const t of flatTabs()) {
      const wcId = webContentsIdOf(t.id);
      if (typeof wcId === 'number' && list.includes(wcId)) ids.push(t.id);
    }
    setDrivingIds(ids);
  };

  // ---- 切页 / 导航 / 关页 ----

  const activate = (tabId: number): void => {
    const t = findTab(tabId);
    if (!t) return;
    setActiveFor(t.agentId, tabId);
    // 第 25 步：切到某张页 = 要把这张页给人看 → 回到全屏。
    /*
     * ★ 2026-09-20（用户拍板·决定1）：这条**保留**。它只被三种情况走到：
     *   ① 用户自己点 tab（面板可见时才点得到）；
     *   ② 主进程说「把视线给这张页」(`workbench:browser:focus`，**敏感字段等待就走它**)；
     *   ③ 用户把验证码/密码打进聊天被本地闸拦下后，我们主动把那张页给他看。
     * 三种都属于「需要用户亲自处理」——所以这里继续拉回全屏是对的。
     *
     * ★★ 第 27 步的**唯一例外**：求助卡模式（embed）下**不许抢视图**。
     *   求助卡本身就是"把这一小块页面递到眼前"，再切回全屏会把刚弹出的卡片整个盖住。
     *   实测：主进程 `sensitiveNotice` 发的那条 `browser:focus` 会把 embed 冲回 fullscreen，
     *   于是"卡片弹出来了、但页面那一块是空的、状态条还显示 AI 求助"。
     *   注意**只跳视图、不跳聚焦** —— 用户还是要能直接敲键盘。
     */
    const keepEmbed =
      embedWcIdRef.current !== null && webContentsIdOf(tabId) === embedWcIdRef.current;
    if (!keepEmbed) setView('fullscreen');
    // Phase 4：切到这张页 = 它刚被用过（「最久未使用」的排序依据）
    touchTab(tabId);
    /*
     * 第 24 步：**切过去自动唤醒**（Chrome 就是这样的）。
     *
     * 深休眠那张的 `<webview>` 此刻**根本没挂载**，所以下面那句 focus 是点不到东西的；
     * 必须先唤醒让它重新挂载，React 重渲染之后再聚焦才有意义 ——
     * 所以这里重算一次「唤醒后」的元素，而不是沿用上面那个 60ms 的时序。
     */
    if (t.sleep) {
      wakeTab(tabId, true);
      // 深休眠唤醒要重新加载，给页面一点时间再聚焦（浅休眠是瞬时的，也会走到这里但不亏）
      window.setTimeout(() => {
        const el = webviewRefs.current[tabId] as unknown as { focus?: () => void } | null;
        el?.focus?.();
      }, 260);
      return;
    }
    window.setTimeout(() => {
      const el = webviewRefs.current[tabId] as unknown as { focus?: () => void } | null;
      el?.focus?.();
    }, 60);
  };

  /** 导航某张页（URL 栏回车 / 同站改道）：走 <webview>.loadURL，不经过主进程 */
  const navigate = (tabId: number, url: string): void => {
    const el = webviewRefs.current[tabId] as unknown as { loadURL?: (u: string) => void } | null;
    try {
      el?.loadURL?.(url);
    } catch {
      /* 页面还没就绪，等它自己加载 */
    }
    const t = findTab(tabId);
    if (!t) return;
    touchTab(tabId); // Phase 4：导航也是「用过」
    setBucket(
      t.agentId,
      bucketOf(t.agentId).map((x) => (x.id === tabId ? { ...x, url, title: hostLabel(url) } : x)),
    );
  };

  /**
   * 真正把一张页摘掉（不刷聊天）。用户点 ✕ 走 closeTab，删智能体走 closeTabsOfAgent。
   * 这张页上如果正有一路在跑，先**只**放下那一路——别路照跑（「第二句不废第一张」）。
   */
  const removeTab = (tabId: number): void => {
    const t = findTab(tabId);
    if (!t) return;
    const wcId = webContentsIdOf(tabId);
    if (typeof wcId === 'number') void window.workbench?.agentDrop?.(wcId);
    delete webviewRefs.current[tabId];
    // Phase 4：实例没了，它的时间线也一起清掉（否则 tabId 复用时会认错）
    delete createdRef.current[tabId];
    delete lastActiveRef.current[tabId];
    setBucket(
      t.agentId,
      bucketOf(t.agentId).filter((x) => x.id !== tabId),
    );
    if ((activeRef.current[t.agentId] ?? null) === tabId) setActiveFor(t.agentId, null);
    window.setTimeout(() => {
      void refreshDriving();
    }, 150);
  };

  /** 用户点 ✕：只从工作区消失，聊天里最多留**一句**人话（不列关闭清单） */
  const closeTab = (tabId: number): void => {
    const t = findTab(tabId);
    if (!t) return;
    const rest = bucketOf(t.agentId).length - 1;
    removeTab(tabId);
    note(rest > 0 ? `已关掉「${label(t)}」这张页，这个智能体还剩 ${rest} 张。` : '已关掉它最后一张页，这个智能体的浏览器空了。');
  };

  /** 删智能体 / 登出：把它开的那些页一起摘掉（不单独刷聊天，调用方自己给一句话） */
  const closeTabsOfAgent = (agentId: number): void => {
    for (const t of bucketOf(agentId)) removeTab(t.id);
  };

  const closeAllTabs = (): void => {
    for (const t of flatTabs()) removeTab(t.id);
    commitPages({});
    commitActive({});
    setDrivingIds([]);
    // 第 25 步：一张页都不剩 → 浏览器层整体卸载。
    // ★ 第 28 步：这里**不再**回 `fullscreen` —— 否则"用户开过一次页（全屏）→ 关掉 →
    //   AI 再自己开页"时，残留的旧视图会让它又铺满一次，把会话顶掉。
    //   回到 `background` 才对：用户要看浏览器走 `openUrl`，那里会显式拉回全屏。
    viewBeforeEmbedRef.current = null;
    setEmbedWcId(null);
    setView('background');
  };

  /**
   * 给某个智能体开一张页：
   *   1. **只在这个智能体自己的页里**找同站 → 有就复用那张改道，不新开（复用不占额度）；
   *   2. 没有就新开一张 —— 不排队、不顶掉最旧；**第 22 步起受配置项
   *      `maxBrowserInstances`（默认 4）约束**：到顶就拒绝新开并说一句人话，返回 null；
   *   3. 页数刚跨过 SOFT_TAB_HINT 时说一句「开太多会卡」，**但绝不关页**。
   *
   * ⚠️ 成功开页**不往聊天里写任何东西**——工作区顶栏多出一个 tab 就是结果。
   *    （只有「到上限被拒」「开太多会卡」这两种情况才说话。）
   */
  const openUrl = async (agentId: number, rawUrl: string): Promise<number | null> => {
    /**
     * ★ 第 24 步：起始页（`data:` URL）**直通**，不走 toHttpUrl。
     *
     * `toHttpUrl` 只认 http(s)（那是桌面侧的协议闸，故意的），
     * 所以起始页会被判成 null 再回落到 HOME_URL —— 结果是"起始页又变成起始页"，
     * 看着像没生效。这里先放过起始页，其余仍然只允许 http(s)。
     */
    const url = isStartPage(rawUrl) ? rawUrl : toHttpUrl(rawUrl) ?? HOME_URL;
    const bucket = bucketOf(agentId);
    /**
     * 同站复用。
     *
     * ⚠️ 起始页**不参与复用** —— 否则点「＋」永远只会把已有的起始页切到前面，
     * 用户点十次还是那一张（这也是老行为的一个坑：原来主页是百度，
     * 点「＋」会落在"本来就在百度"的那张页上，而不是真的新开一张）。
     * 起始页本来就是"还没去过任何地方"的空页，每次点「＋」都该给一张新的。
     */
    const same = isStartPage(url)
      ? undefined
      : bucket.find((t) => sameSite(t.url, url) || sameSite(t.bootUrl, url));
    if (same) {
      activate(same.id);
      if (same.url !== url) navigate(same.id, url);
      return same.id;
    }
    const id = Date.now() + Math.floor(Math.random() * 1000);
    /**
     * 第 22 步 · D：**多实例上限**（默认 4，设置里可调）。
     *
     * 上限是**全局**的（跨智能体一起算）—— 每张页 = 一个独立渲染进程 + 一块 session 存储，
     * 吃的是整机内存，不是某个智能体的配额。
     *
     * ⚠️ 到顶只**拒绝新开**并把话说清楚，**绝不偷偷关掉已有页**
     *    （第 20 步钉死的规矩：宁可提示「开太多会卡」，也不替用户关页）。
     */
    const cap = Math.max(1, Math.floor(getMaxInstancesRef.current?.() ?? FALLBACK_MAX_INSTANCES));
    const live = flatTabs().length;
    if (live >= cap) {
      note(
        `已经开了 ${live} 张页，到上限 ${cap} 张了（这个数可以在设置里调大）。要开新的，先关掉一张。`,
      );
      return null;
    }
    setBucket(
      agentId,
      bucket.concat({
        id,
        // 标签页归属 = 智能体（这条没变）
        agentId,
        // 登录态归属 = 项目（Phase 3 新建的这条）；开页那一刻定下就不再变
        projectId: getProjectOfAgentRef.current?.(agentId) ?? null,
        bootUrl: url,
        url,
        title: hostLabel(url),
      }),
    );
    // Phase 4：记下建页时刻（时间线的起点）—— 放在"过了上限检查"之后，
    // 免得被拒的开页请求在 ref 里留一条对不上的时间线。
    createdRef.current[id] = Date.now();
    lastActiveRef.current[id] = createdRef.current[id];
    setActiveFor(agentId, id);
    // 第 25 步：开了一张新页 → 回到全屏（用户明确要看浏览器）。
    /*
     * ★ 2026-09-20（决定1）：这条**保留**——openUrl 的调用方都是「用户明确要浏览器」：
     *   点「＋」、认不出的开页指令（开起始页 + 聚焦地址栏）、当前智能体还没页时的聚焦，
     *   以及主进程发来的 open（敏感字段等待场景）。
     * AI 自己开新页走的是 `openFromPage`，那条**已经不再**拉回全屏。
     */
    setView('fullscreen');
    if (bucket.length + 1 === SOFT_TAB_HINT) {
      note(
        `这个智能体的页开到 ${SOFT_TAB_HINT} 张了，再往上会有点卡——不拦你，也不用我关，想清爽自己点 ✕ 就行。`,
      );
    }
    return id;
  };

  const openHome = (agentId: number): Promise<number | null> => openUrl(agentId, HOME_URL);

  /** 第 24 步：请求把焦点交给地址栏（计数 +1，BrowserPanel 监听它） */
  const focusUrlBar = (): void => {
    // 第 25 步：地址栏在后台态下看不见，聚焦前必须先回到全屏
    setView('fullscreen');
    setUrlBarFocusTick((n) => n + 1);
  };

  /**
   * 用户点「＋」：给**此刻正在聊的那个智能体**开一张默认主页。
   * 注意（既定设计，别乱改）：目标就是默认主页，所以同站复用会让它落在
   * 「本来就在百度」的那张页上（把当前页导航回主页），而不是又开一张。
   */
  const openNewTab = (): void => {
    const agentId = getAgentRef.current();
    if (agentId === null) return;
    void openUrl(agentId, HOME_URL);
  };

  /** 把焦点交给当前智能体那张页（它还没开过就先开一张默认主页） */
  const focusActive = (): void => {
    const agentId = getAgentRef.current();
    if (agentId === null) return;
    const cur = activeRef.current[agentId] ?? null;
    if (cur === null) void openUrl(agentId, HOME_URL);
    else activate(cur);
  };

  /**
   * 主进程说「把焦点给这张页」。
   * 第 20 步：只给**当前智能体自己**的页；别家智能体的页在后台照跑，
   * 但**不把用户的视线抢过去**（否则多智能体并行时画面会被别的智能体拽走）。
   */
  const focusByWebContents = (wcId: number): void => {
    const tabId = tabIdOfWebContents(wcId);
    if (tabId === null) {
      focusActive();
      return;
    }
    const t = findTab(tabId);
    if (t && t.agentId === visibleAgentRef.current) activate(tabId);
  };

  /** 主进程发来的 'open'（敏感字段等待时会发）：落给此刻正在聊的那个智能体 */
  const openFromMain = (url: string): void => {
    const agentId = getAgentRef.current();
    if (agentId === null || !url) return;
    void openUrl(agentId, url);
  };

  /**
   * ★ 第 23 步：**内嵌页里的 target=_blank / window.open** → 真开一条 tab。
   *
   * 与 openFromMain 的两点关键差别：
   *   1. 归属：用 `preferAgentId`（主进程查出的「哪张 guest 触发的」），
   *      不用「此刻正在聊的那个」—— A 的页里点出来的链接必须留在 A 名下。
   *      查不出归属时才回退到当前智能体。
   *   2. **不复用同站页**。真浏览器点 target=_blank 就是**新开**，
   *      哪怕同站（常见：搜索结果点开第二条、列表里点开另一个商品）。
   *      老逻辑走 openUrl 的「同站复用」会把当前页导航走 —— 那正是用户
   *      抱怨的「没开新 tab，反而把当前页换掉了」。
   *
   * 仍然遵守 maxBrowserInstances：到顶就说话、拒绝新开，绝不偷偷关页。
   */
  const openFromPage = (url: string, preferAgentId: number | null): void => {
    const target = toHttpUrl(url);
    if (!target) return;
    const agentId = preferAgentId ?? getAgentRef.current();
    if (agentId === null) return;
    // 强制新开一张（跳过同站复用），这是与 openUrl 的唯一区别
    const cap = Math.max(1, Math.floor(getMaxInstancesRef.current?.() ?? FALLBACK_MAX_INSTANCES));
    const live = flatTabs().length;
    if (live >= cap) {
      note(
        `页面里点开的链接要新开一张页，但已经到上限 ${cap} 张了（这个数可以在设置里调大）。先把不用的关掉一张，我再开。`,
      );
      return;
    }
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setBucket(
      agentId,
      bucketOf(agentId).concat({
        id,
        agentId,
        projectId: getProjectOfAgentRef.current?.(agentId) ?? null,
        bootUrl: target,
        url: target,
        title: hostLabel(target),
      }),
    );
    createdRef.current[id] = Date.now();
    lastActiveRef.current[id] = createdRef.current[id];
    setActiveFor(agentId, id);
    /*
     * ★ 2026-09-20（用户拍板·决定1）：**不再把用户从后台拽回全屏。**
     *
     * 这条路径 = 内嵌页里的 `target=_blank` / `window.open`，也就是「**AI 自己开新网页**」
     * （第 23 步起主进程把这种弹窗推给渲染层，真开一条 tab）。
     * 用户要求：只有**需要用户亲自处理**的情况（验证码 / 敏感字段等待，走主进程的
     * `workbench:browser:focus` → `focusByWebContents`）才把人拉回全屏；
     * AI 正常开页要**安静地在后台继续跑**。所以这里只开页、**不动 view**。
     *
     * ⚠️ 别顺手把 setView('fullscreen') 加回来：后台态下面板是 opacity:0 挂载着的，
     *    新页照常有真实尺寸、照样能被驾驶；用户想看自己点右下角小图标。
     */
  };

  /**
   * 「停」：点名那张页就只停那一路；没点名则停当前这张，它没在跑就全停。
   * 这是唯一会让驾驶停下来的入口（闲聊不再打断驾驶）。
   */
  const stopDriving = (tabId?: number): void => {
    const agentId = visibleAgentRef.current;
    const target = typeof tabId === 'number' ? tabId : agentId !== null ? activeRef.current[agentId] ?? null : null;
    const wcId = typeof target === 'number' ? webContentsIdOf(target) : undefined;
    const thisOneRunning = typeof target === 'number' && drivingIdsRef.current.includes(target);
    if (thisOneRunning && typeof wcId === 'number') void window.workbench?.agentDrop?.(wcId);
    else void window.workbench?.agentStop?.();
    window.setTimeout(() => {
      void refreshDriving();
    }, 200);
  };

  const registerWebview = (tabId: number, el: HTMLElement | null): void => {
    if (el) webviewRefs.current[tabId] = el;
    else delete webviewRefs.current[tabId];
  };

  const notePageInfo = (tabId: number, info: BrowserPageInfo): void => {
    const t = findTab(tabId);
    if (!t) return;
    touchTab(tabId); // Phase 4：页面自己动了（点链接 / SPA 跳转 / 标题变化）= 它刚被用过
    setBucket(
      t.agentId,
      bucketOf(t.agentId).map((x) =>
        x.id === tabId
          ? { ...x, ...(info.url ? { url: info.url } : {}), ...(info.title ? { title: info.title } : {}) }
          : x,
      ),
    );
  };

  /**
   * 第 24 步：**把浅休眠落到 CPU 上**。
   *
   * 上面那个定时器只负责"判定 + 改状态"；真正**去动页面**的是这里 ——
   * 每次 `pages` 变化后，把当前所有页的节流状态与它该有的状态对齐。
   *
   * 为什么不在 sweepSleep 里直接发 IPC：
   *   唤醒可能来自任何地方（切 tab / AI 派任务 / 用户点占位卡），
   *   那些路径都不经过定时器。这个 effect 以 `pages` 为准做**对账**，
   *   无论状态从哪儿变的，页面最终都会跟上 —— 不用在 5 个地方各写一次 IPC。
   *
   * 对齐是**幂等**的：`setBackgroundThrottling` 设成同一个值没有副作用，
   * 所以这里不做"变了才设"的优化，反而更省心（少一个状态去对账）。
   */
  useEffect(() => {
    for (const t of allTabs) {
      const wcId = webContentsIdOf(t.id);
      if (typeof wcId !== 'number') continue; // 还没 dom-ready，等下一次
      /*
       * 浅休眠 = 节流。深休眠的页**已经不在 DOM 里**了（拿不到 wcId，上面就 continue 了），
       * 所以这里实际只会对 `'shallow'` 和清醒态做对齐。
       */
      const want = t.sleep === 'shallow';
      void window.workbench?.browserThrottle?.(wcId, want);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, drivingIds]);

  /**
   * 第 25 步：视图切换。
   *
   * ★ 这两个函数**只**改 `view` 这一个 state —— 不调 agentStart / agentStop /
   *   agentDrop、不改 sleep、不动 webview。所以"退出全屏"在物理上不可能
   *   影响正在跑的任务（这是本步最想守住的性质）。
   */
  const showFullscreen = (): void => {
    setEmbedWcId(null);
    // 用户主动离开 embed（点了右下角小图标 / 「看浏览器」）→ 记录作废，
    // 否则待会儿收卡时 exitEmbed 会拿着旧记录把用户又送回后台。
    viewBeforeEmbedRef.current = null;
    setView('fullscreen');
  };
  const exitFullscreen = (): void => {
    setEmbedWcId(null);
    viewBeforeEmbedRef.current = null;
    setView('background');
  };

  /**
   * 第 27 步：进入求助卡模式。
   *
   * ★ 只有"这张页属于**当前正在聊的那个智能体**"才切视图 —— 别的智能体在后台求助，
   *   不该把用户的视线从当前会话拽走（沿用第 20 步 `focusByWebContents` 的同一条规矩）。
   *   不切视图时卡片照样会出现在那个智能体的聊天里，等用户切过去再看。
   */
  const enterEmbed = (wcId: number): void => {
    const tabId = tabIdOfWebContents(wcId);
    if (tabId === null) return;
    const t = findTab(tabId);
    if (!t || t.agentId !== visibleAgentRef.current) return;
    /*
     * ★ 先记「原来在哪一态」再切 —— 处理完要**从哪来回哪去**（见 exitEmbed）。
     *
     * ⚠️ 只在**还没进 embed** 时记：`enterEmbed` 可能被同一张卡的重复事件再调一次
     *   （主进程重发 help / 用户又触发一次），如果不判就把它覆盖成 `'embed'`，
     *   那 exitEmbed 就恢复到一个不存在的态、只能兜底回全屏 —— 用户原本在看聊天，
     *   结果被顶成全屏。实测这条覆盖路径踩得到。
     */
    if (viewRef.current !== 'embed') viewBeforeEmbedRef.current = viewRef.current;
    activate(tabId); // 把这张页切到该智能体的前台（embed 只显示"当前这张"）
    setEmbedWcId(wcId);
    setView('embed');
  };
  const exitEmbed = (): void => {
    setEmbedWcId(null);
    /*
     * **从哪来回哪去**：进 embed 之前是 `background`（用户自己退出全屏、正在聊天里
     * 看消息）就回 `background` —— 一律回全屏会把他正在看的聊天当场盖住，
     * 他得再点一次「退出全屏」才能接着看，等于求助处理完还多欠他一步。
     *
     * 只有"进 embed 前是 fullscreen"才回全屏；记不上（直接进来 / 中途页没了走下面
     * 那个 effect）时退回 fullscreen —— 那是最"看得见"的态，不会留下一个
     * "什么都没有"的界面。
     */
    const back = viewBeforeEmbedRef.current;
    viewBeforeEmbedRef.current = null;
    setView((v) => (v === 'embed' ? back ?? 'fullscreen' : v));
  };
  /**
   * 第 27 步：求助卡模式下那张页没了（被关掉 / 页面被卸载）→ 自动退出该模式。
   *
   * 不做这一步会留下一个"透明但仍存在的浏览器层"：聊天看得见，
   * 可底下还挂着一层不吃视觉、却在别处吃指针事件的页 —— 典型的"看不见的坏"。
   */
  useEffect(() => {
    if (view !== 'embed' || embedWcId === null) return;
    if (tabIdOfWebContents(embedWcId) === null) exitEmbed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, embedWcId, pages]);

  /** 活页变化（新开/关闭/切智能体）后同步一次「哪几张正在被驾驶」 */
  useEffect(() => {
    void refreshDriving();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);

  /**
   * 第 24 步：**空闲休眠的定时扫描**。
   *
   * 每 30 秒跑一次判定，把"该睡的"落进 tab 数据。
   *
   * 为什么是 30 秒而不是 5 秒：
   *   判定本身很便宜（纯字符串/数字计算），但**落结果会触发重渲染**。
   *   休眠的时间尺度是「分钟」，30 秒的粒度误差对用户完全无感，
   *   而每秒扫一次只会让界面无谓地抖。真正需要"立刻"的场景（唤醒）
   *   走的是 `wakeTab` / `activate` 的事件路径，不依赖这个定时器。
   *
   * `sleepEnabledRef` 关掉时直接 return（复用同一个定时器，不重建 interval）。
   */
  useEffect(() => {
    const timer = window.setInterval(sweepSleep, 30_000);
    // 挂载后先扫一次：应用重启后本来就有一堆"上次留下的页"
    sweepSleep();
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    currentAgentId: visibleAgentId,
    tabs,
    allTabs,
    activeId,
    active,
    view,
    drivingIds,
    tabCount: tabs.length,
    softHint: tabs.length >= SOFT_TAB_HINT,
    urlBarFocusTick,
    focusUrlBar,
    showFullscreen,
    exitFullscreen,
    enterEmbed,
    exitEmbed,
    embedWcId,
    registerWebview,
    notePageInfo,
    noteOwner,
    touchTab,
    sleepOf,
    idleMsOf,
    wakeTab: (tabId: number) => wakeTab(tabId, true),
    wakeAndActivate,
    sleepEnabled,
    setSleepEnabled,
    instanceList,
    openUrl,
    openHome,
    openNewTab,
    closeTab,
    closeTabsOfAgent,
    closeAllTabs,
    activate,
    navigate,
    focusActive,
    webContentsIdOf,
    awaitWebContentsId,
    tabIdOfWebContents,
    ownerOf,
    focusByWebContents,
    openFromMain,
    openFromPage,
    refreshDriving,
    stopDriving,
  };
}
