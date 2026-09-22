import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type {
  BrowserAction,
  BrowserEvent,
  BrowserInstanceInfo,
  WorkbenchBridge,
  WorkbenchSettings,
} from '@ai-workbench/shared';

/**
 * preload —— 渲染进程与主进程之间唯一的桥。
 *
 * 这里只暴露「明确白名单」的方法，绝不把 ipcRenderer / require / process 整个丢出去。
 * 配合 BrowserWindow 的 contextIsolation: true + nodeIntegration: false，
 * 渲染进程即使被 XSS 也只能调用下面这几个函数。
 */

/** 主进程 → 渲染进程的 UI 指令通道前缀 */
const BROWSER_CHANNEL_PREFIX = 'workbench:browser:';

const bridge: WorkbenchBridge = {
  platform: process.platform,
  appVersion: process.env.npm_package_version ?? '0.1.0',
  // ★ 渲染层据此把后端地址定为 http://127.0.0.1:8787（缺失会被误判成 web 直测模式 → 连不上后端）
  isElectron: true,
  ping: () => ipcRenderer.invoke('app:ping'),

  // ---- 内嵌浏览器区域：渲染进程只发指令，显示/隐藏由主进程转发回来决定 ----
  openBrowser: (url?: string) => ipcRenderer.invoke('workbench:open', url),
  showBrowser: () => ipcRenderer.invoke('workbench:show'),
  hideBrowser: () => ipcRenderer.invoke('workbench:hide'),
  focusBrowser: () => ipcRenderer.invoke('workbench:focus'),

  // ---- 第 3 步：驾驶内嵌页（动作进 → 结果出），渲染层只发指令 ----
  drive: (action: BrowserAction, targetWebContentsId?: number) =>
    ipcRenderer.invoke('workbench:drive', action, targetWebContentsId),
  readPage: (targetWebContentsId?: number) =>
    ipcRenderer.invoke('workbench:read-page', targetWebContentsId),
  pauseDriving: () => ipcRenderer.invoke('workbench:pause-driving', true),
  resumeDriving: () => ipcRenderer.invoke('workbench:pause-driving', false),

  // ---- 第 4 步：任务状态机（权威状态在主进程，这里只发指令 / 取镜像）----
  // 第 22 步：启动任务必须点名要驾驶哪张页（主进程不再盲选第一个 webview）
  startTask: (targetWebContentsId?: number) =>
    ipcRenderer.invoke('workbench:task:start', targetWebContentsId),
  // 子阶段 A：暂停 / 继续也支持点名某一张页 —— 多路真并行时「暂停这一路」必须能指定目标，
  // 否则只能按「此刻在跑的那张」猜，验不出「暂停 1 号、2 号照跑」。不传 = 沿用旧行为。
  pauseTask: (targetWebContentsId?: number) =>
    ipcRenderer.invoke('workbench:task:pause', targetWebContentsId),
  resumeTask: (targetWebContentsId?: number) =>
    ipcRenderer.invoke('workbench:task:resume', targetWebContentsId),
  resetTask: () => ipcRenderer.invoke('workbench:task:reset'),
  // 子阶段 A：可点名读**某一张页**的状态（driver 侧本来就是 per-target 的，只是这个读口
  // 一直只回聚合视图）。不传 = 聚合视图（左栏横幅用的那条路），老调用点不受影响。
  getTaskState: (targetWebContentsId?: number) =>
    ipcRenderer.invoke('workbench:task:state', targetWebContentsId),

  // ---- 第 7 步：云端驾驶员循环（编排就在主进程；token 只递给主进程用，不打印）----
  // 第 17 步：多带一个 targetWebContentsId —— 这次驾驶**哪一张**内嵌页（两路并行必须点名）
  // 第 21 步：opts = {loopId, agentId} —— 循环的脑在服务端，loopId 是 /chat/stream 建好的那个；
  //           agentId 让服务端挡住「A 的循环点到 B 的页上」
  agentStart: (
    goal: string,
    apiBase: string,
    token: string,
    targetWebContentsId?: number,
    opts?: { agentId?: number | null; loopId?: string },
  ) => ipcRenderer.invoke('workbench:agent:start', goal, apiBase, token, targetWebContentsId, opts ?? {}),
  agentStop: () => ipcRenderer.invoke('workbench:agent:stop'),
  // 第 16 步：用户改口时放下当前任务（保留凭证），旧目标不会被「继续」重新捡起来
  // 第 17 步：带 id 只放下那一路（那张页），别路照跑；不带则全部放下
  agentDrop: (targetWebContentsId?: number) => ipcRenderer.invoke('workbench:agent:drop', targetWebContentsId),
  /** ★ P0 止血（2026-09-21）：回应「上下文没了」那张卡 —— restart = 用户确认后重开；giveup = 收摊 */
  loopGoneChoice: (targetWebContentsId: number, choice: 'restart' | 'giveup') =>
    ipcRenderer.invoke('workbench:task:loop-gone', targetWebContentsId, choice),
  /** 第 17 步：正在驾驶哪几张内嵌页（guest id 列表）——开第 3 张页时用来挑空闲的那张 */
  agentLanes: () => ipcRenderer.invoke('workbench:agent:lanes'),
  /**
   * Phase 3：登记「这张内嵌页是哪个智能体开的」。
   * 分区改成按项目之后，主进程从分区名里读不到 agentId，下载记录靠这个标记 owner。
   */
  browserOwner: (webContentsId: number, agentId: number) =>
    ipcRenderer.invoke('workbench:browser:owner', webContentsId, agentId),
  /**
   * 第 24 步：浅休眠 —— 把一张内嵌页的节流拉到最紧 / 放开。
   *
   * `throttle=true` 省 CPU（后台视频不再解码、定时器降频），页面不卸载、唤醒瞬时。
   * 主进程会**拒绝**对正在被驾驶的页做节流（那会让 CDP 点击失灵），返回 `{ok:false,error:'driving'}`。
   */
  browserThrottle: (webContentsId: number, throttle: boolean) =>
    ipcRenderer.invoke('workbench:browser:throttle', webContentsId, throttle),
  agentAnswer: (text: string, targetWebContentsId?: number) =>
    ipcRenderer.invoke('workbench:agent:answer', text, targetWebContentsId),

  // ---- 第 8 步：结果文档下载 + 服务端任务快照（红点以它为准）----
  // ★ 不再接收 token：主进程一律用自己内存里的那份（见 main.ts 的 isLoopbackBase 注释）。
  //   apiBase 仍可指定（本机换端口开发），但主进程只放行回环地址。
  downloadDoc: (taskId: number, apiBase: string) =>
    ipcRenderer.invoke('workbench:doc:download', taskId, apiBase),
  /**
   * ★ 登录态显式同步：**只在渲染层登录成功那一刻**（含 F5 后的静默恢复）调用。
   *
   * 为什么需要它：主进程的 token 是纯内存的，F5 之后渲染层能自己恢复登录态、
   * 主进程却不能，于是「刷新后点下载」会失败。这条通道把"我此刻已登录"显式告诉主进程。
   * 登出时调 `syncSession(base, '')` 清掉。
   *
   * 它**不是**给普通业务动作传凭证用的 —— 别在下载/提问之类的调用旁边顺手加一个它。
   */
  syncSession: (apiBase: string, token: string) =>
    ipcRenderer.invoke('workbench:session:sync', apiBase, token),

  /**
   * ★ 项目列表同步：拿到 `/projects` 结果后推给主进程，供**分区闸**判定归属。
   *
   * 主进程的 `will-attach-webview` 是同步事件（没机会 await 一次 HTTP），
   * 所以只能由渲染层把"这个账号有哪些项目"显式推过去。
   * 传空数组表示"确实没有项目"，与"还没同步过"是两种状态。
   */
  syncProjects: (projectIds: number[]) =>
    ipcRenderer.invoke('workbench:projects:sync', projectIds),

  /**
   * ★ 主进程拦下了一个分区不合法 / 跨账号的内嵌页 —— 渲染层据此把那张页标成失败，
   * 而不是让它变成一张永远空白的卡片（用户会以为"网页坏了"）。
   */
  onWebviewBlocked: (cb: (info: { partition: string; reason: string }) => void) => {
    const handler = (_e: unknown, payload: string) => {
      try {
        cb(JSON.parse(payload) as { partition: string; reason: string });
      } catch {
        /* 坏 payload 忽略，不让它把渲染层带崩 */
      }
    };
    ipcRenderer.on('workbench:webview:blocked', handler);
    return () => ipcRenderer.off('workbench:webview:blocked', handler);
  },

  // ---- 第 22 步：可调配置（并发数 / 多实例上限）。权威副本在主进程 userData 下的 JSON ----
  getSettings: () => ipcRenderer.invoke('workbench:settings:get'),
  setSettings: (patch: Partial<WorkbenchSettings>) =>
    ipcRenderer.invoke('workbench:settings:set', patch),

  // ---- Phase 4：资源守护者（采集在主进程；这里只读 + 上报实例清单）----
  /**
   * 读实时视图（最新采样 / 档位 / 阈值 / 去抖计数 / 落盘目录）。
   * 这是"数据可查"的正门 —— 后续 UI 阶段的提示界面就读它，本阶段先用它取证。
   */
  resourceSnapshot: () => ipcRenderer.invoke('workbench:resources:snapshot'),
  resourceHistory: (minutes?: number) => ipcRenderer.invoke('workbench:resources:history', minutes),
  resourceEvents: (limit?: number) => ipcRenderer.invoke('workbench:resources:events', limit),
  /**
   * 上报浏览器实例清单（含每个实例的最后使用时间）。
   * 「最久未使用」排序靠它 —— 主进程看不到标签页；只在**变化时**发，没有固定心跳。
   */
  resourceInstances: (list: BrowserInstanceInfo[]) =>
    ipcRenderer.invoke('workbench:resources:instances', list),

  /**
   * 简易订阅：把主进程发来的 'workbench:browser:*' 转成回调。
   * 返回取消订阅函数（contextBridge 会把函数代理过去）。
   */
  on: (event: BrowserEvent, callback: (payload?: string) => void) => {
    const channel = `${BROWSER_CHANNEL_PREFIX}${event}`;
    const listener = (_e: IpcRendererEvent, payload?: string) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },

  /**
   * ★ mock 模式的验证码转给登录页（详见 shared 里 onSmsMockCode 的注释）。
   * 只有主进程从**自己拉起的**服务端日志里解析出 [sms:mock] 那行时才会发。
   */
  onSmsMockCode: (cb: (info: { masked: string; code: string }) => void) => {
    const channel = 'workbench:sms:mock';
    const listener = (_e: IpcRendererEvent, payload: { masked: string; code: string }) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
};

contextBridge.exposeInMainWorld('workbench', bridge);
