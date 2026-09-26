import { app, BrowserWindow, dialog, ipcMain, shell, webContents, type WebContents } from 'electron';
import { mkdirSync, appendFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  drive,
  setDrivingPaused,
  setTaskListener,
  getTaskState,
  startTask,
  pauseTask,
  resumeTask,
  resetTask,
  takeoverRun,
  setExternalPhase,
  isDrivingPaused,
} from './driver';
import { runToolLoop } from './agent';
import { startSensitiveAutoResume } from './driver';
// 第 27 步：人工介入（求助卡片）的状态机 —— 不 import electron，可单测
import { createHelpHub } from './helpState';
import { getSettings, onSettingsChange, setSettings } from './settings';
import { initResourceGuard, syncDrivingFlags } from './resource-guard';
import { ensurePostgres, ensureServer, getServerState, stopOwnedServer } from './server-supervisor';
// ADR-0002：页宿主（WebContentsView）生命周期 + 分区前缀常量（唯一建页口，分区闸在这里执行）
import {
  PROJECT_PARTITION_PREFIX,
  viewHostClose,
  viewHostCreate,
  viewHostFocus,
  viewHostInit,
  viewHostNavigate,
  viewHostOrder,
  viewHostRect,
  viewHostTeardown,
} from './view-host';
import type {
  AgentEventPayload,
  AgentLoopNextResult,
  AgentLoopStartResult,
  AgentLoopInfoResult,
  BrowserAction,
  LoopToolResult,
  PageSnapshot,
  TaskPhase,
  WorkbenchSettings,
} from '@ai-workbench/shared';

/**
 * Electron 主进程 —— 只有它能碰 Node / 系统能力。
 * 渲染进程跑在独立沙箱里，通过 preload 暴露的白名单通道通信。
 */

/** 开发模式下 Vite Dev Server 的地址（与 vite.config.ts 的 server.port 保持一致）。
 * 打包后的 app.isPackaged=true，即使用户环境里意外留有 VITE_DEV_SERVER_URL，
 * 也必须加载安装包内的 dist/index.html，而不是依赖 npm run dev 的 Vite。 */
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = !app.isPackaged && Boolean(DEV_SERVER_URL);

// 彻底禁用后台节流机制，确保窗口最小化或内嵌页切到后台隐藏时保持正常执行频率
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

let mainWindow: BrowserWindow | null = null;

/** 只允许 http(s) —— 其余协议（bytedance: / snssdk / itms-apps: / market: …）一律不进导航 */
const isHttpUrl = (url: string): boolean => /^https?:\/\//i.test(url);

/**
 * Phase 3：**登录态隔离粒度 = 项目**（同项目的多个智能体共用一套 cookie / localStorage）。
 *
 * 渲染层的 <webview> 用 `partition="persist:workbench-browser-project-<projectId>"`，
 * Electron 会把这个分区落到 `<userData>/Partitions/<分区名>/` —— 这天然就是
 * 「每个项目在 userData 下有自己的子目录」（cookie / localStorage / 站点数据全在里面）。
 *
 * ⚠️ 与标签页粒度别混：标签页 / 任务 / 暂停继续仍然**按 agentId** 隔离（那是渲染层的事）；
 *    主进程这边只关心分区（= 项目），外加「下载记录要能标出是哪个智能体触发的」。
 *
 * ⚠️ 主进程 import 不到渲染层代码，所以分区命名规则在这里是**同规则的第二份**
 *    （渲染层见 apps/desktop/src/browser/url.ts 的 partitionFor），**改一处要同时改两处**。
 */
const PROJECT_PARTITION_RE = /workbench-browser-project-(\d+)/;

// 分区名前缀：ADR-0002 起收进 view-host.ts（它是要拼分区字符串的唯一建页口），这里 import 复用。

/** 已经挂过 will-download 的分区（同一个分区可能被多次 attach，别重复挂） */
const downloadHooked = new Set<string>();

/**
 * Phase 3：guest webContents id → 开这张页的智能体。
 *
 * 分区名里现在只放得下 projectId，agentId 放不下了 —— 主进程要知道「这次下载是哪个智能体触发的」，
 * 只能由渲染层在页就绪时报一次（IPC `workbench:browser:owner`，见 preload 的 browserOwner()）。
 * 另外驾驶中的那几路还有 `lastAgentByWc` 兜底。
 */
const webviewOwner = new Map<number, number>();

/** 这次下载是哪个智能体触发的（拿不到就说拿不到，**绝不瞎猜成某一个**） */
function ownerAgentOf(wcId: number): { agentId: number | null; source: string } {
  const fromRenderer = webviewOwner.get(wcId);
  if (typeof fromRenderer === 'number') return { agentId: fromRenderer, source: 'renderer' };
  const fromLane = lastAgentByWc.get(wcId);
  if (typeof fromLane === 'number') return { agentId: fromLane, source: 'lane' };
  return { agentId: null, source: 'unknown' };
}

/** 按项目存下载的根目录（不存在就建出来） */
function projectRootDir(): string {
  const dir = path.join(app.getPath('userData'), 'browser-projects');
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    console.warn('[download] 建目录失败：', (error as Error).message);
  }
  return dir;
}

/** 某个项目自己的下载目录（不存在就建出来） */
function projectDownloadDir(projectId: number): string {
  const dir = path.join(projectRootDir(), String(projectId), 'downloads');
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    console.warn('[download] 建目录失败：', (error as Error).message);
  }
  return dir;
}

/**
 * 下载记录（append-only JSONL，落在 `<userData>/browser-projects/_downloads.jsonl`）。
 *
 * 这是「呈现给用户/排查用」的那份记录：**物理目录按项目合并了，但每条记录都带 agentId**，
 * 所以「这个文件是哪个智能体下载的」永远查得到，不会因为合并目录而丢失。
 */
function appendDownloadRecord(record: Record<string, unknown>): void {
  try {
    appendFileSync(path.join(projectRootDir(), '_downloads.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    console.warn('[download] 写下载记录失败：', (error as Error).message);
  }
}

/**
 * 给「某个项目的浏览器分区」挂下载落盘规则：文件进这个项目自己的 downloads 目录，
 * 不弹系统「另存为」。
 *
 * Phase 3 的两件事一起做：
 *   1. 物理目录按**项目**（同一项目的多个智能体下的文件落在同一处）；
 *   2. **记录里仍标 agentId** —— 目录合并了，归属信息不合并。
 *
 * 认不出分区的（例如主窗口自己那个默认 session）一律不管。
 */
function hookProjectDownloads(contents: WebContents): void {
  const ses = contents.session;
  const storage = ses.getStoragePath() ?? '';
  const m = PROJECT_PARTITION_RE.exec(storage);
  if (!m) return;
  if (downloadHooked.has(storage)) return;
  downloadHooked.add(storage);
  const projectId = Number(m[1]);
  // ⚠️ 归属必须取**第三个参数**（真正发起这次下载的那个 guest），不能闭包里的 `contents`：
  // Phase 3 起一个项目一个分区，**同一 session 被该项目的多个智能体共用**，
  // `contents` 只是第一个创建这个 session 的页 —— 拿它当「谁下载的」会把同项目其他智能体
  // 的下载全记到那第一只头上（真机取证时确实踩到了：A2 的下载被记成 A1）。
  ses.on('will-download', (_event, item, fromWc) => {
    const filename = item.getFilename();
    const savePath = path.join(projectDownloadDir(projectId), filename);
    item.setSavePath(savePath);
    const owner = ownerAgentOf((fromWc ?? contents).id);
    appendDownloadRecord({
      at: new Date().toISOString(),
      projectId,
      agentId: owner.agentId,
      agentSource: owner.source,
      filename,
      savePath,
      url: item.getURL(),
      partition: storage,
    });
    console.log(
      `[download] 项目 ${projectId} / 智能体 ${owner.agentId ?? '未知'}（${owner.source}）的下载落到：${savePath}`,
    );
  });
}

/**
 * 内嵌页不允许创建新窗口：点击 target=_blank / window.open 时，改为让**同一个 guest**导航。
 *
 * 这是用户在卡片里手点搜索结果、帮助链接时的必要行为；若只简单 deny，页面看起来就会“点了没反应”。
 * 全程没有 BrowserWindow，也不会打开系统 Edge / Chrome。
 *
 * 第 17 步「拦住系统弹窗」：
 *   - window.open / target=_blank 的非 http(s) 请求：直接忽略（不交给系统，不弹「获取打开此链接的应用」）；
 *   - **整页跳转**到非 http(s)：用 will-navigate / will-redirect / will-frame-navigate 拦下并留在当前页。
 *     抖音那类站点的「打开 App / bytedance://」按钮就是走这条路，不拦就会把当前页冲掉、
 *     甚至弹出 Windows 的「获取打开此链接的应用」系统框。
 */
/**
 * guest（内嵌页）接线 —— webview 时期与 WebContentsView 时期**同一套**（ADR-0002 决定 8/失败表 F12）：
 * 后台节流关 / 按项目下载 / owner 登记清理 / 弹窗收编 / 非 http(s) 协议闸 / 桌面 chrome 补丁 /
 * **pageinfo 推送**（宿主换原生视图后，标题/地址变化不再有 DOM 元素事件，由这里推给渲染层）。
 */
function wireBrowserGuest(contents: WebContents): void {
  // ★ 显式禁用内嵌页后台节流，保证其在后台隐藏状态下依然保持正常的 JS 执行和渲染更新
  try {
    contents.setBackgroundThrottling(false);
  } catch {}

  // Phase 3：这个内嵌页属于哪个项目，它的下载就落到那个项目自己的目录（记录里仍标 agentId）
  hookProjectDownloads(contents);

  // 页没了就把 owner 登记清掉，别让 wcId 被复用后认错人
  contents.once('destroyed', () => {
    webviewOwner.delete(contents.id);
  });

  /**
   * ★ 第 23 步：「点了标题没反应 / 没开新 tab」的正解。
   *
   * 老行为：`window.open` / `target=_blank` → deny + 让**同一个 guest** `loadURL(url)`。
   * 后果（截图里 AI 自己说的）：
   *   「能真的打开了新标签，只是工作台没切换」——
   *   guest 里地址确实变了，但渲染层的 tabs 数组是 React state，
   *   没有任何人告诉它「多了一张页」，所以顶部永远不多一条 tab。
   *   用户看到的是：point 了链接 → 当前页被换走 + 顶部没变化 = 「点了没反应」。
   *
   * 新行为：**真开一条 tab**。
   *   主进程不认识 tab（tab 是渲染层的事），所以这里只做一件事：
   *   把「这张 guest 想打开 url」推给渲染层，让 useBrowserWorkspace 用**已有的
   *   openUrl(agentId, url)** 去开 —— 和用户点「＋」走的是同一条路，
   *   不新增机制、不碰 maxBrowserInstances 以外的任何规则。
   *
   * `webviewOwner` 里记着这张 guest 是哪个智能体开的（渲染层在页就绪时报过），
   * 用它保证「A 的页里点出来的新 tab 仍然属于 A」，不会串到别的智能体。
   */
  contents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) {
      const owner = webviewOwner.get(contents.id);
      const sourceWcId = contents.id;
      console.log(`[webview] target=_blank / window.open → 新开一条 tab：${url}`);
      setImmediate(() => {
        // 推给渲染层：它会开一条新 tab（而不是把当前这张页导航走）
        sendToMainWindow('workbench:browser:opentab', JSON.stringify({ url, agentId: owner ?? null, sourceWcId }));
      });
    } else {
      console.warn('[webview] 已拦下非 http(s) 的 window.open（不弹系统框、不新开窗口）：', url);
    }
    return { action: 'deny' };
  });

  // 整页导航到自定义协议 → 取消，留在当前页
  contents.on('will-navigate', (event, url) => {
    if (isHttpUrl(url)) return;
    event.preventDefault();
    console.warn('[webview] 已拦截非 http(s) 跳转，留在当前页：', url);
  });
  // 3xx 重定向到自定义协议 → 同样取消
  contents.on('will-redirect', (event, url) => {
    if (isHttpUrl(url)) return;
    event.preventDefault();
    console.warn('[webview] 已拦截非 http(s) 重定向，留在当前页：', url);
  });
  // 子框架（iframe / 广告位）里的跳转也要拦，否则照样能唤起系统
  contents.on('will-frame-navigate', (details: unknown) => {
    const d = details as { url?: string; preventDefault?: () => void } | undefined;
    const url = d?.url ?? '';
    if (!url || isHttpUrl(url)) return;
    d?.preventDefault?.();
    console.warn('[webview] 已拦截子框架的非 http(s) 跳转：', url);
  });

  /**
   * 第 17 步：让内嵌页更像普通 Chrome 桌面。
   * 只做两件最小的事（不上整套指纹方案）：
   *   1. UA 由 app.userAgentFallback 去掉 Electron/<版本> 与产品名 token（见文件末尾的设置）；
   *   2. 页面里若没有 window.chrome，补一个空对象——不少站点的「是不是真 Chrome」检测就认这个。
   */
  contents.on('did-finish-load', () => {
    if (contents.isDestroyed()) return;
    void contents
      .executeJavaScript(
        `(() => {
          try {
            if (!window.chrome) {
              Object.defineProperty(window, 'chrome', { value: {}, writable: true, configurable: true });
            }
          } catch (_) {}
          return true;
        })()`,
      )
      .catch(() => {
        /* 页面脚本被禁之类的情况：不影响驾驶，忽略 */
      });
  });

  /**
   * ADR-0002：页宿主换原生视图后，「这张页换了标题 / 换了地址」没有 DOM 元素事件可听，
   * 由主进程按 wcId 推给渲染层（渲染层拿 wcId 换回 tabId 走 notePageInfo，口径与老事件一致，
   * 包括 touchTab 的「页面自己动了 = 它刚被用过」）。
   */
  const pushPageInfo = (patch: { title?: string; url?: string }): void => {
    if (contents.isDestroyed()) return;
    setImmediate(() => {
      if (contents.isDestroyed()) return;
      sendToMainWindow('workbench:browser:pageinfo', JSON.stringify({ wcId: contents.id, ...patch }));
    });
  };
  contents.on('page-title-updated', (_e, title) => pushPageInfo({ title }));
  contents.on('did-navigate', (_e, url) => pushPageInfo({ url }));
  contents.on('did-navigate-in-page', (_e, url) => pushPageInfo({ url }));
}

app.on('web-contents-created', (_event, contents) => {
  // ADR-0002 回滚窗口内 webviewTag 仍开着：真出现 webview guest（旧路径 / 手动实验）照旧接上。
  // 新的 WebContentsView guest 是 `webContents` 类型，不走这里 —— 由 view-host 的 create 显式接线。
  if (contents.getType() !== 'webview') return;
  wireBrowserGuest(contents);
});

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: 'AI 工作台',
    backgroundColor: '#f5f6f8',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // ---- 安全桥三件套 ----
      // 1. preload 独立上下文，渲染进程拿不到 require / process
      preload: path.join(__dirname, 'preload.js'),
      // 2. 渲染进程与 preload 隔离在不同 JS 上下文
      contextIsolation: true,
      // 3. 禁用 Node 集成
      nodeIntegration: false,
      // 额外：开启 Chromium 沙箱
      sandbox: true,
      webSecurity: true,
      // 4. 允许渲染层使用 <webview> 内嵌真实网页（工作台浏览器区域）
      webviewTag: true,
      // 5. 禁用主窗口后台节流，最小化或遮挡时保持高频定时器与 IPC 响应
      backgroundThrottling: false,
    },
  });

  // 等首帧渲染完再显示，避免白屏闪烁
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    viewHostTeardown(); // ADR-0002：视图随窗口死，清掉宿主登记
  });

  // 任何 window.open / 外链都交给系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 第 17 步：只有 http(s) 才交给系统浏览器。自定义协议（bytedance: / market: …）
    // 丢给 shell 会弹出 Windows 的「获取打开此链接的应用」——正是要拦掉的那个系统框。
    if (isHttpUrl(url)) void shell.openExternal(url);
    else console.warn('[main] 已拦下非 http(s) 的外链（不弹系统框）：', url);
    return { action: 'deny' };
  });

  // 禁止渲染进程被导航到外部站点（防止钓鱼 / 劫持）
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isDev && url.startsWith(DEV_SERVER_URL!)) return;
    event.preventDefault();
  });

  /**
   * ★★ 内嵌页的**分区闸**（这是唯一能钉死 `partition` 的地方）。
   *
   * 背景（为什么需要它）：
   *   渲染层的 `<webview partition="persist:workbench-browser-project-<projectId>">` 里
   *   那个分区名**完全由渲染层决定**。Electron 的 `session.fromPartition(name)`
   *   本身**没有任何访问控制** —— 知道名字就能拿到那个 session 里的全部 cookie。
   *   而 `will-attach-webview` 是主进程**唯一**能在 guest 挂载前改写/拦下 webPreferences 的时机。
   *   此前应用**没有**注册这个处理器（实测确认），所以渲染层写什么分区就用什么分区。
   *
   * ⚠️ 这里**刻意不做"强制改写成当前项目"**（那是想当然的修法，会改坏已设计好的行为）：
   *   `BrowserPanel.tsx` 明确约定「`t.projectId` 是**开页那一刻**定下的，
   *   所以**切项目不会让已开的页换一套登录态**」——
   *   页可以跨项目共存，把它们统一改写会让旧页突然换成另一套 cookie，等于把用户登出。
   *
   * 所以闸门口径是「**必须是这个用户自己的项目分区**」，而不是"必须是当前项目"：
   *   - 形状必须是 `persist:workbench-browser-project-<正整数>`（或兜底的 `-none`）。
   *     其它一律拦下 —— 包括**空分区**（那会落到默认 session，和主窗口共用一套 cookie）
   *     和任意自造的名字（`persist:whatever`）。
   *   - 项目号必须是**当前登录用户名下**的项目。这样渲染层即便被攻破，
   *     也够不到"别的账号在这台机器上留下的分区"。
   *
   * 诚实说明（别把它当成一道墙）：**同一账号的多个项目之间，这道闸拦不住** ——
   *   因为渲染层本来就合法地同时承载多个项目的标签页（见上面的 BrowserPanel 约定）。
   *   分区在本产品里的定位是「**登录态隔离**」（一个项目登过的站点不带进另一个项目），
   *   是**功能**不是安全边界。这道闸真正收掉的是"伸到自己的项目集合之外"那部分。
   */
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences) => {
    // 显式禁用 webview 后台节流，确保内嵌页隐藏时 JS 定时器与渲染正常运行
    webPreferences.backgroundThrottling = false;
    const raw = typeof webPreferences.partition === 'string' ? webPreferences.partition : '';
    /**
     * ★ 处置方式：**改写到隔离的兜底分区**，而不是 `preventDefault()` 直接拦掉。
     *
     * 为什么不用 preventDefault：那会让这张页**根本没有 guest** ——
     * 用户看到的是一张永远空白的卡片，而屏幕上没有任何解释，
     * 正是我们一直在修的那种"静默失败"（用户会以为网页坏了）。
     *
     * 改写到 `...-none` 的效果：
     *   - 页面照常能开、能看，只是**没有任何项目的登录态**（那是个独立空分区）；
     *   - 攻击者拿到的是一个空 session，**什么也读不到** —— 安全性不打折；
     *   - 正常用户看到的只是"这张页没登录"，比白屏好得多。
     */
    const d = decideWebviewPartition(raw, ownedProjectIds, projectsSyncedAt !== null);
    if (d.quarantined) {
      webPreferences.partition = d.partition;
      console.warn(`[main] 内嵌页分区被改写为隔离分区：${d.reason}`);
      sendToMainWindow('workbench:webview:blocked', JSON.stringify({ partition: raw, reason: d.reason }));
    }
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_SERVER_URL!);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

// ---------------------------------------------------------------------------
// 内嵌浏览器区域（工作台浏览器）
//
// 注意：这里**不再创建任何 BrowserWindow**。
// 网页由渲染层的 <webview partition="persist:workbench-browser-project-<projectId>"> 承载
// （Phase 3：按项目分区 —— 同项目的智能体共用一套 cookie / 登录态，跨项目完全隔离），
// 主进程只做一件事：把渲染进程发来的指令原样转发回去，由渲染层决定显示 / 隐藏 / 聚焦。
//
// 这样做的原因：浏览器区域是主窗口界面的一部分（右侧那一栏），
// 用独立窗口反而要多维护一套窗口生命周期（位置、还原、关闭、焦点竞争）。
// ---------------------------------------------------------------------------
function sendToMainWindow(channel: string, payload?: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// IPC：渲染进程只能走这里注册的通道，preload 里再做一层白名单收敛
// ---------------------------------------------------------------------------
ipcMain.handle('app:ping', () => `pong from electron ${process.versions.electron}`);

// 第 2 步（内嵌版）：主窗口渲染进程 -> 主进程 -> 主窗口渲染进程
// 绕一圈的意义：显示 / 隐藏这类 UI 指令将来可能来自任务系统、快捷键或主进程侧逻辑，
// 统一从主进程走，渲染层只需要订阅。
ipcMain.handle('workbench:open', (_event, url?: string) => {
  sendToMainWindow('workbench:browser:open', url);
});

ipcMain.handle('workbench:show', () => {
  sendToMainWindow('workbench:browser:show');
});

ipcMain.handle('workbench:hide', () => {
  sendToMainWindow('workbench:browser:hide');
});

ipcMain.handle('workbench:focus', () => {
  sendToMainWindow('workbench:browser:focus');
});

// ---------------------------------------------------------------------------
// 第 3 步：本地驾驶（遥控器先通）
//
// 渲染进程把「一个动作」丢过来，主进程在内嵌 webview 的 guest webContents 上
// 用 debugger / CDP 执行，再把 { ok, pageSnapshot } 原样回给渲染层。
// 渲染进程全程碰不到 BrowserWindow / webContents / debugger，只认 preload 白名单。
// ---------------------------------------------------------------------------
ipcMain.handle(
  'workbench:drive',
  (_event, action: BrowserAction, targetWebContentsId?: number) =>
    drive(action, targetWebContentsId),
);

ipcMain.handle('workbench:read-page', (_event, targetWebContentsId?: number) =>
  drive({ action: 'read_page' }, targetWebContentsId),
);

// 暂停 / 恢复驾驶：暂停后 click / type 会被执行器拒绝，页面交还给用户手动点
// （第 4 步起与状态机同进同退：setDrivingPaused 内部就是 applyPaused）
ipcMain.handle('workbench:pause-driving', (_event, value: boolean) => setDrivingPaused(value));

// ---------------------------------------------------------------------------
// 第 4 步：任务状态机（idle | running | paused | done | failed）
//
// 权威状态在主进程 driver.ts；这里只做两件事：
//   1. 收渲染层的四个指令（start / pause / resume / reset）+ 一个初始读取；
//   2. 状态一变就广播 'workbench:browser:state'，渲染层横幅「AI 正在控制 / 你正在控制」
//      只是镜像——按钮与聊天框谁按下的都不影响"以主进程为准"这一条。
// ---------------------------------------------------------------------------
setTaskListener((state) => {
  sendToMainWindow('workbench:browser:state', JSON.stringify(state));
});

// 第 22 步：启动任务必须点名要驾驶哪张页（driver.resolveTarget 已删掉盲选兜底）
ipcMain.handle('workbench:task:start', (_event, targetWebContentsId?: number) =>
  startTask(targetWebContentsId),
);
/**
 * 子阶段 A：暂停 / 继续也支持**点名某一张页**。
 *
 * 为什么必须加：driver 侧早就是 per-target（`pauseTask(wcId)` / `applyPaused(wcId)`），
 * 但这两个 IPC 一直不接 target，落到 `activeTaskWcId()` 上 —— 多路真并行时那等于
 * 「按 Map 里第一条在跑的猜」，**验不出「暂停 1 号、2 号照跑」**，也做不到用户想停哪路停哪路。
 * 不传 target 时行为与以前**完全一致**（沿用「此刻在跑 / 最近碰过的那张」），所以老调用点不用改。
 */
ipcMain.handle('workbench:task:pause', async (_event, targetWebContentsId?: unknown) => {
  const wcId = Number(targetWebContentsId);
  const state = pauseTask(Number.isInteger(wcId) ? wcId : undefined);

  /**
   * ★ 光在本地置起「暂停门」是不够的：**服务端那一路必须真的挂起**。
   *
   * 原来只做上面那一句，服务端的挂起全靠 agent.ts 的 `pauseOut()`（它只在
   * 「桌面循环还在跑」时才跑得到）。一旦 AI 自己已经停下来问用户了 ——
   * 最典型的就是**敏感字段**（验证码/密码）：服务端把这一步挡下来、回 ask，
   * 桌面循环当场 `finish('ask_user')` 退出 —— 这时候用户再点「暂停」，
   * 服务端永远收不到挂起，仍然停在 `waiting`。
   *
   * 后果（实测，验证码场景就是这个）：点「继续」→ `/agent/loop/resume` 看到
   * `status !== 'paused'` → `resumed=false` → **恢复简报根本不会 append**，
   * 那句「你刚刚被用户暂停，现在已恢复」和页面变化判定全都没了，
   * 「暂停 → 用户自己操作 → 继续」就退化成「什么都没感知到，接着盲干」。
   *
   * 循环还在跑时这里会重复挂起一次 —— `pauseLoop` 对已挂起是幂等的，不会有副作用。
   */
  const only = Number.isInteger(wcId) ? wcId : null;
  const targets: number[] = only !== null
    ? [only]
    : [...new Set([...lanes.keys(), ...pendingGoals.keys()])];
  for (const id of targets) {
    const loopId = lanes.get(id)?.loopId ?? lastLoopByWc.get(id) ?? null;
    if (!loopId) continue;

    /**
     * ★ 暂停前**先读一次当前真实页面**当基线。
     *
     * 不读会怎样（实测场景 s4，用户暂停后什么都没做）：服务端拿
     * `lastSnapshot`（**循环最后一次读到的页面**）当基线，而 AI 的最后一步
     * 往往已经把页面改了却还没来得及重读 —— 于是基线是"改之前"那张页。
     * 恢复时一比，多出来的元素全被算到用户头上，delta 判成 edited，
     * AI 张口就说「页面内容跟我上次看到时不一样了，应该是你自己操作过」——
     * 可用户根本没动。**用户啥也没干却被说"你改了页面"，这比判错更伤信任。**
     */
    let base: PageSnapshot | null = null;
    try {
      const r = await drive({ action: 'read_page' }, id);
      base = r.pageSnapshot ?? null;
    } catch (err) {
      console.warn(`[agent] 第 ${id} 路暂停前读页失败（基线退回循环里的旧快照）：`,
        (err as Error).message);
    }
    try {
      await agentPost('/agent/loop/pause', { loopId, pausedBy: 'user', ...(base ? { page: base } : {}) });
      console.log(`[agent] 第 ${id} 路已挂起（服务端循环 ${loopId}，历史保留）`);
    } catch (err) {
      // 已经终态的循环会回 409，确实挂不起；别让它把「暂停」整个动作带崩 —— 本地已经停手了
      console.warn(`[agent] 第 ${id} 路服务端挂起未生效（继续时会退回新建一轮）：`,
        (err as Error).message);
    }
  }
  return state;
});
// 第 7 步：有挂起的驾驶员任务时，「继续」= 重启 AI 循环（第一步仍是 read_page，按当前页决策，
// 不重放旧动作）；没有则维持第 4 步 demo 语义。
// 第 17 步：两路并行时「继续」= 把**所有**挂起的那几路一起重新发车（每路各读自己那张页）。
/**
 * 阶段简报 · 方案 B：**「继续」的完整动作**（核心难点所在）。
 *
 * 顺序钉死，一步都不能省：
 *   1. **先 read_page** —— 读用户暂停期间操作后的**真实**当前页（这就是「重新感知」）。
 *      没有这一步，AI 只能沿用暂停前的旧记忆，正是要避免的那种错误；
 *   2. **解除服务端挂起**，并把刚读到的页面交给它算变化判定
 *      （服务端拿它和暂停前的快照比对，得出 unchanged / moved / edited / unknown）；
 *   3. **复用同一个 loopId 原地继续** —— 消息历史不丢，AI 记得自己做过什么，
 *      才可能「不重做用户已经手动完成的部分」。
 *
 * 为什么不用 `startAgentLoop` 新建循环（旧行为）：那会 abort 掉上一路并
 * `/agent/loop/stop`，stop 是终态 + 新循环历史为空 → 继续等于从头再来一遍。
 */
/**
 * 「继续」**在途去重**（按页）。
 *
 * 为什么要它（连点场景实测）：
 *   `resumeAgentLane` 是异步的（读页 → 解挂 → 发车），而 IPC 里是 `void` 调用不等待。
 *   用户快速连点「暂停 / 继续」时，上一次还没发车完、下一次又进来一次，
 *   **同一张页上会同时跑起两路 `runToolLoop`** —— 它们共用一条服务端循环、
 *   互相把对方的状态改掉，最后其中一路 `hooks.next()` 抛异常 → `phase='failed'`，
 *   而 failed 之后「继续」又什么都做不了（服务端循环已经 stopped），
 *   表现就是：**狂点几下，任务彻底卡死、按钮全废**。
 *
 *   去重之后，在途期间再点的「继续」直接忽略（返回当前状态），
 *   在途那一轮结束时会看到最新的暂停门 —— 状态不会串，也不会死。
 */
const resumingWc = new Set<number>();

/**
 * 每张页上**正在跑 `runToolLoop`** 的那一路。
 *
 * 为什么不能只看 `lanes`：`finishLane()` 会把 lane 从 `lanes` 里摘掉，
 * 但「暂停」之后循环往往**还没真的退出**（它正卡在等模型返回那一下，
 * 要等 `hooks.next()` 回来才会走到下一个检查点）。这段窗口里 `lanes.get(wcId)` 已经是
 * undefined，可循环还在车上 —— 判断「要不要再发一辆」必须靠这张表。
 */
const liveLoops = new Map<number, Lane>();

/**
 * ★ P0 止血（2026-09-21）：循环上下文丢失时问用户那句话。
 *
 * 措辞是产品的核心资产，别改顺口 —— 它必须同时说清三件事：
 *   ① 发生了什么（上下文不在了）；② 代价是什么（已经做过的动作**可能**会再做一遍）；
 *   ③ 决定权在用户（要重新开始吗）。
 * 「可能」两个字不能省：我们确实不知道那些动作有没有执行过，说死就是撒谎。
 */
const LOOP_GONE_QUESTION =
  '这一轮的上下文已经不在了。如果从头开始，前面已经做过的动作可能会再做一遍。要重新开始吗？';

async function resumeAgentLane(wcId: number, goal: string): Promise<void> {
  // 第 27 步：不管是自动感知还是手动点按钮，只要走到"继续"，求助卡就该收掉
  clearHelp(wcId, 'resumed');
  const lane = lanes.get(wcId);
    const loopId = lane?.loopId ?? lastLoopByWc.get(wcId) ?? null;

  // 1) 重新感知：读当前真实页面（失败也要继续 —— delta 会如实判成 unknown）
  let snapshot: PageSnapshot | null = null;
  try {
    const r = await drive({ action: 'read_page' }, wcId);
    snapshot = r.pageSnapshot ?? null;
    if (snapshot) console.log(`[agent] 第 ${wcId} 路继续前重读页面：${snapshot.url} · ${snapshot.title}`);
  } catch (err) {
    console.warn(`[agent] 第 ${wcId} 路继续前读页失败（delta 将判为 unknown）：`, (err as Error).message);
  }

  // 2) 解除挂起 + 提交变化判定
  if (loopId) {
    try {
      const r = await agentPost<{ delta?: { kind?: string } }>('/agent/loop/resume', { loopId, page: snapshot });
      console.log(`[agent] 第 ${wcId} 路已解除挂起（delta=${r?.delta?.kind ?? '?'}）`);
    } catch (err) {
      /**
       * ★★ P0 止血（2026-09-21）：**这里以前一律静默新建一轮。**
       *
       * 原注释写的是「绝不让『继续』变成没反应」—— 初衷是对的，
       * 但那条兜底会把消息历史**清零**：模型完全不知道自己做过什么，从头重跑整个目标，
       * 目标里若有不可逆转动作（提交 / 下单 / 发送）就会被**再执行一次**。
       * （只读审计见 `docs/审计-重复执行风险-20260921.md` 的「高优先级发现 1」）
       *
       * 现在的口径：
       *   · `loop_gone`（服务端明确说找不到这条循环：过期被回收 / 重启过）
       *     → **不许自动重开**。明确告诉用户代价，由用户在界面上点「重新开始」才新建。
       *       ★ 初衷保住了：不是报错甩锅，是「明确提示 + 一键确认」。
       *   · 其它原因（连不上 / 超时 / 401 / 服务端忙）
       *     → 同样**不许**新建一轮，如实说「暂时接不上，稍后再试」。
       *       否则一次网络抖动也会弹那个确认，用户会被训练成不看内容就点「重新开始」。
       */
      const code = (err as { code?: string }).code;
      if (code === 'loop_gone') {
        console.warn(`[agent] 第 ${wcId} 路的上下文已不在（loop_gone）—— 停下来问用户，绝不自动重开`);
        clearHelp(wcId, 'loop_gone');
        emitAgent({ kind: 'loop-gone', question: LOOP_GONE_QUESTION }, wcId);
        return;
      }
      console.warn(`[agent] 第 ${wcId} 路解挂失败（非"上下文丢失"），不重开：`, (err as Error).message);
      emitAgent(
        {
          kind: 'note',
          level: 'error',
          text: `暂时接不上后端，没法接着做：${(err as Error).message}。请稍后再点一次「继续」。`,
        },
        wcId,
      );
      return;
    }
  }

  /**
   * 3) 原地接上（同一 lane、同一 loopId）
   *
   * ★ 但**上一路还在车上时绝不再发一辆**。
   *   连点「暂停 / 继续」时最容易出现这个窗口：上一路正卡在等模型返回（要 2～3 秒），
   *   暂停门只是把它**下一格**挡住，它自己还没退出。这时候若再 startAgentLoop，
   *   两条 runToolLoop 会对同一个 loopId 并发 `/agent/loop/next`，
   *   服务端当场抛 `LoopBusyError`（409）→ 桌面把它当致命错误 → `phase='failed'`，
   *   而 failed 之后「继续」什么都做不了 —— **用户狂点几下，任务就彻底死了**（实测）。
   *
   *   这种情况「继续」只需要：把本地暂停门打开 + 服务端解挂（上面两步已做），
   *   车上的那一路下一格自己会接着跑，历史与 loopId 全部保留。
   */
  if (liveLoops.has(wcId)) {
    resumeTask(wcId);
    console.log(`[agent] 第 ${wcId} 路上一趟还在车上 —— 只解除暂停门，不重复发车`);
    return;
  }
  startAgentLoop(wcId, goal, false, {
    loopId: loopId ?? undefined,
    agentId: lane?.agentId ?? lastAgentByWc.get(wcId) ?? null,
    resume: true,
  });
}

ipcMain.handle('workbench:task:resume', (_event, targetWebContentsId?: unknown) => {
  const wcIdRaw = Number(targetWebContentsId);
  const only = Number.isInteger(wcIdRaw) ? wcIdRaw : null;
  // 点名了某一页：只动这一路，别路绝不碰
  if (only !== null) {
    const lane = lanes.get(only);
    /**
     * 第 27 步：这就是求助卡片上那颗「我处理好了，继续」按钮 —— **手动兜底**。
     *
     * 它和"自动感知到页面变化"走的是**同一条**恢复链路（下面那句 resumeAgentLane：
     * 重读当前页 → 服务端算 delta → 同一条历史原地接上），只是触发源不同。
     * 先收卡片再恢复：卡片是"我在等你"的展示，恢复动作一开始它就该消失。
     */
    if (helpHub.has(only)) clearHelp(only, 'manual');
    /**
     * ★ 这里要分清楚「用户按了暂停」和「AI 自己停下来问」这两种等待 —— 它们长得像，
     *   但「继续」该做的事完全不是一回事：
     *
     *   - **用户按了暂停**（driver 的暂停门是开着的）：走**完整恢复**——
     *     重读当前真实页面 → 服务端解挂并算变化判定 → 同一条历史原地接上。
     *     少了任何一步，「暂停期间用户自己动了页面」就白感知了。
     *   - **AI 自己停下来问**（敏感字段 / need_user，用户并没按暂停）：
     *     只是手动兜底唤醒，把在等的那一格放开就行（用户填完验证码本来就有自动唤醒信号，
     *     点「继续」是给「自动信号没来」留的手动出口）。
     *
     *   不这么分的话，验证码场景会踩这个坑：用户按了暂停 → 服务端挂起 →
     *   点「继续」却因为 lane 上有 waiter 走了唤醒分支，页面不重读、delta 不算，
     *   等于「继续」被静默降级。
     */
    const userPressedPause = isDrivingPaused(only);
    if (lane && lane.waiters.length > 0 && !userPressedPause) {
      notifyResume(lane);
      return getTaskState(only);
    }
    // ★ 上一次「继续」还在发车途中 → 这次点击直接忽略（否则同一张页会跑起两路循环，互相踩死）
    if (resumingWc.has(only)) return getTaskState(only);
    const goal = pendingGoals.get(only) ?? lane?.goal;
    if (goal) {
      resumingWc.add(only);
      void resumeAgentLane(only, goal).finally(() => resumingWc.delete(only));
      return getTaskState(only);
    }
    return resumeTask(only);
  }
  // 第 9 步：敏感等待中点「继续」= 手动兜底唤醒（和自动信号走同一条路）
  if (anyLaneWaiting()) {
    notifyAllResume();
    return getTaskState();
  }
  const paused = [...pendingGoals.keys()];
  if (paused.length > 0) {
    // 阶段简报：每一路都各自「先读自己那张页 → 再继续」，互不干扰
    for (const wcId of paused) {
      const goal = pendingGoals.get(wcId);
      // 同上：同一张页在途的「继续」不重复发车
      if (!goal || resumingWc.has(wcId)) continue;
      resumingWc.add(wcId);
      void resumeAgentLane(wcId, goal).finally(() => resumingWc.delete(wcId));
    }
    return getTaskState();
  }
  return resumeTask();
});

/**
 * ★ P0 止血（2026-09-21）：**「上下文没了」这件事的两个出口**。
 *
 * 触发源只有一个：`resumeAgentLane` 里 `/agent/loop/resume` 返回 `code:'loop_gone'`。
 * 那边**不会**自动重开，只 emit 一句问话；用户在这里做决定。
 *
 *   `restart` —— 用户明确确认后才新建一轮（原来的目标、原来的那张页）。
 *                ★ 这是**唯一**允许"丢掉历史、从头再来"的入口，必须是一次显式点击。
 *   `giveup`  —— 收摊：lane 清掉、目标清掉、界面回到「已停止」。
 *                ★ 不留半死不活的状态：否则「继续」还会去 resume 一个已经不存在的循环，
 *                  用户会以为按钮坏了。
 */
ipcMain.handle('workbench:task:loop-gone', (_event, targetRaw: unknown, choiceRaw: unknown) => {
  const wcId = Number(targetRaw);
  if (!Number.isInteger(wcId)) return getTaskState();
  const choice: 'restart' | 'giveup' = choiceRaw === 'restart' ? 'restart' : 'giveup';
  const agentId = lanes.get(wcId)?.agentId ?? lastAgentByWc.get(wcId) ?? null;
  const goal = pendingGoals.get(wcId) ?? lanes.get(wcId)?.goal ?? null;

  // 不管哪个出口，先把**这一路**在服务端那条（多半已经不在的）循环与本地 lane 收干净
  const lane = lanes.get(wcId);
  if (lane) {
    lane.aborted = true;
    lane.running = false;
    if (lane.loopId) void agentPost('/agent/loop/stop', { loopId: lane.loopId, reason: 'loop_gone' }).catch(() => undefined);
    notifyResume(lane);
    lanes.delete(wcId);
  }
  clearHelp(wcId, `loop_gone:${choice}`);
  // 旧循环号绝不能再被「继续」捡起来
  lastLoopByWc.delete(wcId);

  if (choice === 'giveup') {
    pendingGoals.delete(wcId);
    pendingAnswers.delete(wcId);
    lastAgentByWc.delete(wcId);
    resetTask(wcId);
    setExternalPhase(wcId, 'idle', '已停止（这一轮的上下文不在了，按你的选择收尾）', 0);
    console.log(`[agent] 第 ${wcId} 路：用户选择不重开，已收摊`);
    return getTaskState(wcId);
  }

  if (!goal) {
    // 连目标都没留下 —— 没法"重新开始"，如实说，别假装开始了
    setExternalPhase(wcId, 'idle', '已停止：原来的目标也找不到了，请重新下指令', 0);
    return getTaskState(wcId);
  }
  console.log(`[agent] 第 ${wcId} 路：用户明确确认后重新开始（新循环，历史归零）`);
  startAgentLoop(wcId, goal, false, { agentId });
  return getTaskState(wcId);
});

ipcMain.handle('workbench:task:reset', () => {
  abortAllLanes();
  notifyAllResume();
  pendingGoals.clear();
  pendingAnswers.clear();
  clearAllHelps('reset'); // 第 27 步：复位要把求助卡一并收干净，否则会留一张点不动的卡
  return resetTask();
});
/**
 * 子阶段 A：状态读口也支持**点名某一张页**。
 *
 * A1.5 已经把状态改成 per-target，但 `getTaskState()` 不接 target 时回的是**聚合视图**
 * （左栏横幅需要的那条）。多路真并行时这就读不出「1 号已暂停、2 号还在跑」——
 * 聚合视图按「running > paused」挑，只会回 2 号。不传 target 时行为不变。
 */
ipcMain.handle('workbench:task:state', (_event, targetWebContentsId?: unknown) => {
  const wcId = Number(targetWebContentsId);
  return getTaskState(Number.isInteger(wcId) ? wcId : undefined);
});

// ---------------------------------------------------------------------------
// 第 22 步：可调配置（A1.5 的并发数 / D 的多实例上限）
//
// 权威副本在 electron/settings.ts（userData 下的 JSON，用户手改也认）；
// 这里只做两件事：转发 IPC + 变更时广播给渲染层。
// ---------------------------------------------------------------------------
ipcMain.handle('workbench:settings:get', () => getSettings());
ipcMain.handle('workbench:settings:set', (_event, patch: unknown) =>
  setSettings((patch ?? {}) as Partial<WorkbenchSettings>),
);
onSettingsChange((s) => sendToMainWindow('workbench:browser:settings', JSON.stringify(s)));

// ---------------------------------------------------------------------------
// 第 7 步：云端驾驶员「一步一问」循环的编排层（就在主进程；渲染进程不直连 CDP）
//   - 调后端 /agent/next-action 要带第 5 步 JWT——token 只存在这里（内存），绝不打印全文；
//   - 执行永远走现有 driver.ts；暂停由 driver 的 paused 闸 + 循环自查双保险；
//   - API Key 不经过这里：它只在 apps/server/.env。
// ---------------------------------------------------------------------------
/**
 * 第 20 步：**并发驾驶不再有硬顶**（原来的 `MAX_LANES = 10` 已删）。
 *
 * 旧行为是「第 11 路直接拒绝」，它按活页数算，会变成「页能开 30 张、第 11 张一发车就被拒」，
 * 与本步「取消活页硬顶」相反。现在只保留一条语义：
 * **同一张页同一时间只有一路**（这张页上的新指令 → 覆盖旧目标，最新指令优先）。
 *
 * 卡顿是本步明确接受的已知代价（页多、路多就是会卡），不再靠拒绝/关页来「治」。
 */

/**
 * 一路驾驶 = **一张内嵌页** + 一个目标 + 自己那一份循环状态。
 *
 * 第 16 步之前这些都是全局单例（agentEpoch / agentGoal / sensitiveWaiters …），
 * 因为全窗口只有一张 webview。第 17 步要两路同时跑，就必须按 **guest webContents id** 拆开：
 *   - 同一张页上的新指令 → 覆盖这一路的旧指令（第 16 步「最新指令优先」的忠实推广）；
 *   - 不同页上的指令 → 互不打扰（第二句不会把第一张降级成不能动的占位）。
 */
interface Lane {
  wcId: number;
  goal: string;
  /**
   * 第 21 步：这一路在**服务端**的那个工具循环 id（脑在服务端，这里只当手）。
   * 建循环与「停」都要带上它，服务端才认得出「停的是哪一路」。
   */
  loopId: string | null;
  /** 第 21 步：这一路属于哪个智能体（服务端据此挡住「A 的循环点到 B 的页上」） */
  agentId: number | null;
  /** 被作废（新指令顶掉 / 用户放下 / 登出）时置 true，循环在下一个检查点自己退出 */
  aborted: boolean;
  running: boolean;
  /** 敏感输入等待：loop 挂在 promise 上；自动恢复 watch / 手动继续 / 用户答复 都来唤醒 */
  waiters: Array<() => void>;
  stopWatch: (() => void) | null;
  holdTimer: ReturnType<typeof setTimeout> | null;
  /** 这一路正在聊天里等用户答复（答复只喂给它，不串到别路） */
  awaiting: boolean;
  answers: string[];
}

/** 正在跑的那几路 */
const lanes = new Map<number, Lane>();
/** 跑完一段但还没结束的那几路（ask_user / 暂停 / 步数上限）：留着目标等「继续」或答复 */
const pendingGoals = new Map<number, string>();
/** 用户答复按「哪张页」分开暂存 */
const pendingAnswers = new Map<number, string[]>();
/**
 * 第 21 步：每张页最后是哪个智能体在驾驶 —— 「继续」会新起一轮循环，
 * 新循环也要记住同一个智能体（否则服务端会把它当成别的 bot 的循环，直接 409）。
 */
const lastAgentByWc = new Map<number, number>();
/**
 * 阶段简报 · 方案 B：**每张页最近用的服务端循环号**。
 *
 * 为什么必须另存一份：一路循环一结束，`finishLane` 就会把 lane 从 `lanes` 里摘掉
 * （`lanes.delete(wcId)`）——用户暂停时当然也会走这一步。于是「继续」时
 * `lanes.get(wcId)` 已经是 undefined，拿不到 loopId，只能新建一个服务端循环，
 * 消息历史照样归零，「原地接上」就名存实亡。
 *
 * 所以按页记一份循环号：继续时优先用**原来那个** loopId，服务端解除挂起即可。
 * 它的生命周期与 `lastAgentByWc` 一致（按页、进程内），不额外引入第三套 id。
 */
const lastLoopByWc = new Map<number, string>();

// ---------------------------------------------------------------------------
// 第 27 步 · 人工介入（求助卡片）
//
// 状态机本体在 `helpState.ts`（**不 import electron、全部依赖注入**）——
// 抽出去是为了能单测：这块最容易错的恰恰是时序（卡片刚弹就被自己收掉、
// 自动与手动同时触发恢复两次、观察窗没被停掉），而时序光读代码看不出来。
//
// ★ 为什么这些状态**不放在 Lane 里**（放进去会坏，别顺手搬）：
//   求助是在循环**收尾那一下**发出来的，紧接着 `finishLane` 就会
//   `notifyResume(lane)` —— 那会把 `lane.stopWatch` 停掉、并把 lane 从表里摘掉。
//   而卡片要在循环结束之后**继续留着**、自动恢复观察也要继续挂着。
//   所以状态按 wcId 独立存在，生命周期 = 「这张页还有没有一张待处理的求助卡」。
// ---------------------------------------------------------------------------
const helpHub = createHelpHub({
  emit: (payload, wcId) => emitAgent(payload, wcId),
  markAgentPaused: (wcId, detail) => setExternalPhase(wcId, 'paused', detail, undefined, 'agent'),
  startWatch: (wcId, onDone, opts) => startSensitiveAutoResume(onDone, wcId, opts),
  requestResume: (wcId) => requestResume(wcId),
  goalOf: (wcId) => lanes.get(wcId)?.goal ?? pendingGoals.get(wcId) ?? '',
  agentOf: (wcId) => lanes.get(wcId)?.agentId ?? lastAgentByWc.get(wcId) ?? null,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  log: (msg) => console.log(`[agent] ${msg}`),
});

/** 收掉某张页的求助卡（薄包装，调用点一行都不用改） */
function clearHelp(wcId: number, reason: string, notifyRenderer = true): boolean {
  return helpHub.clear(wcId, reason, notifyRenderer);
}


/**
 * 第 27 步：**「用户处理完了」的统一出口**（双保险的另一半 —— 自动感知走这里，
 * 手动「我处理好了」按钮也走这里）。
 *
 * 两条路最后都落到 `resumeAgentLane()`：它先 `read_page` 读用户操作后的**真实**页面，
 * 再 `/agent/loop/resume` 把变化判定交给服务端算 delta，然后复用同一个 loopId 原地接上。
 * 这就是已经验收过的「继续」链路 —— 这里**不新造任何恢复机制**。
 */
function requestResume(wcId: number): void {
  if (resumingWc.has(wcId)) return; // 在途去重（自动与手动同时来也只接一次）
  const goal = lanes.get(wcId)?.goal ?? pendingGoals.get(wcId) ?? null;
  if (!goal) return;
  resumingWc.add(wcId);
  void resumeAgentLane(wcId, goal).finally(() => resumingWc.delete(wcId));
}

/**
 * 第 27 步：**AI 主动求助** —— 循环判定「本地页面信号 + 我确实卡住了」之后调这里。
 *
 * 只做四件事，一件都不多：
 *   1. 把状态如实记成 `pausedBy='agent'`（界面靠它和"用户接管"区分开）；
 *   2. 往聊天区发一条 `help` 事件（渲染层据此在**聊天流里**长出那张卡片）；
 *   3. 挂上自动恢复观察（复用第 9 步的 `startSensitiveAutoResume`）；
 *   4. 挂一个 2 分钟的手动兜底提示（自动信号没来时告诉用户还有按钮）。
 *
 * ★ 安全红线：这里**不产生任何输入能力** —— 不聚焦输入框、不带字段值、不代填、不代提交。
 *   卡片只是"展示 + 提示 + 手动确认"，用户必须在真实页面上自己操作。
 */
/** 清掉所有求助卡（登出 / 全局停手时用） */
function clearAllHelps(reason: string): void {
  helpHub.clearAll(reason);
}


let agentApiBase = 'http://127.0.0.1:8787';
let agentJwt = '';

/**
 * ★ 后端的「地址白名单」——**只认回环**。
 *
 * 为什么需要它（改这里前先读完）：
 *   `agentApiBase` 与 `agentJwt` 都是「主进程**自己**去发请求」用的。
 *   主进程发出的请求**不受浏览器同源策略约束**（它不走渲染层的 fetch），
 *   而 `Authorization: Bearer <JWT>` 又会被**原样带出去**。
 *   于是只要 `apiBase` 能被指定成任意字符串，渲染层就凭空获得了一个
 *   「把用户的 JWT 发到任意远端地址」的能力 —— 这是把同源策略在我们自己程序里拆掉。
 *
 * 但**不能**改成"只认主进程内存里的值"（那会误伤一个真实场景）：
 *   渲染层点 F5 刷新后，它自己的登录态能从 localStorage 静默恢复（`/auth/me`），
 *   而主进程的 `agentJwt` 是**纯内存**变量、只在 `agent:start` 时才被写入 ——
 *   仅重启渲染层（Ctrl+R / F5）并不会重新走一遍 `agent:start` 就点下载的话，
 *   主进程手里的 token 是**空的**（该场景的成因详见 `workbench:doc:download` 的注释）。
 *
 * 所以采取「**限址 + 主进程权威凭证**」而不是"一律不接收"：
 *   ① 地址：只放行 127.0.0.1 / localhost / ::1（本产品后端本来就只监听回环），
 *      其余一律拒绝 —— 砍掉"发到远端"的能力，同时留住"本机开发用别的端口"的灵活性；
 *   ② 凭证：**不再接受渲染层传入**，一律用主进程内存里的 `agentJwt`；
 *      刷新后的情形由渲染层在**静默登录成功那一刻**显式同步一次（见 `workbench:session:sync`）。
 */
function isLoopbackBase(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * ★ 分区闸用的状态：当前账号名下的项目号 + 「项目列表同步过没有」。
 *
 * 为什么要单独记一个"同步过没有"：
 *   `will-attach-webview` 是**同步**事件（`preventDefault()` 必须当场调），
 *   没法在里面 await 一次 `/projects`。所以只能由渲染层在拿到项目列表后显式推过来。
 *   在那之前主进程**确实不知道**这个用户有哪些项目 —— 此时若"不知道就拦"，
 *   启动瞬间打开的合法标签页会被全拦死。所以：没同步过 → 放行但告警；同步过 → 严格执行。
 */
const ownedProjectIds = new Set<number>();
let projectsSyncedAt: number | null = null;

/**
 * ADR-0002：页原生宿主（WebContentsView）的依赖注入。
 * 判定函数/通知/接线都是**每次调用时**现读（ownedProjectIds 会随项目同步变化），
 * 所以模块级注入一次即可。
 */
viewHostInit({
  window: () => mainWindow,
  decidePartition: (raw) => decideWebviewPartition(raw, ownedProjectIds, projectsSyncedAt !== null),
  notifyBlocked: (info) => sendToMainWindow('workbench:webview:blocked', JSON.stringify(info)),
  wireGuest: wireBrowserGuest,
});

/**
 * 反解分区名（与渲染层 `browser/url.ts` 的 `projectIdFromPartition` 同一套规则）。
 *
 * 主进程 import 不到渲染层代码，所以这里是**同规则的第二份** ——
 * 改 `url.ts` 的命名规则时**必须同时改这里**（那边注释里也写了这条）。
 *
 * @returns 项目号；`null` 表示"合法但无项目"（兜底分区 `-none`）；`'bad'` 表示形状不合法
 */
function projectIdFromPartitionName(partition: string): number | null | 'bad' {
  if (partition === `${PROJECT_PARTITION_PREFIX}none`) return null;
  const m = /^persist:workbench-browser-project-(\d+)$/.exec(partition);
  if (!m) return 'bad';
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : 'bad';
}

/** 分区闸的判定结果 */
export interface PartitionDecision {
  /** 最终要用的分区名 */
  partition: string;
  /** 是否被改写成了隔离分区 */
  quarantined: boolean;
  /** 被改写的原因（给人看的一句话）；没改写时为 undefined */
  reason?: string;
}

/**
 * ★ 分区闸的**纯判定函数**（不碰 Electron，便于单独验证）。
 *
 * 把它从事件回调里抽出来，是因为回调里还夹着 `sendToMainWindow` 之类的副作用，
 * 没法直接跑断言；抽成纯函数后，"什么该放行、什么该改写"可以逐条对照着测。
 *
 * @param raw    渲染层请求的分区名
 * @param owned  当前账号名下的项目号
 * @param synced 项目列表是否已经同步过（没同步过时**放行但告警**，见下）
 */
export function decideWebviewPartition(
  raw: string,
  owned: ReadonlySet<number>,
  synced: boolean,
): PartitionDecision {
  const orphan = `${PROJECT_PARTITION_PREFIX}none`;
  const projectId = projectIdFromPartitionName(raw);

  if (projectId === 'bad') {
    return {
      partition: orphan,
      quarantined: true,
      reason: `分区名不合法（${raw || '（空）'}）——只允许 persist:workbench-browser-project-<项目号>`,
    };
  }
  if (projectId === null) return { partition: raw, quarantined: false }; // 本来就是隔离分区

  if (!synced) {
    // 还没同步过项目列表 → 主进程确实不知道这个用户有哪些项目。
    // 此时"不知道就拦"会把启动瞬间的合法标签页全打成隔离分区（等于把用户登出），
    // 所以放行；同步之后立即按下面严格判。
    return { partition: raw, quarantined: false };
  }
  if (!owned.has(projectId)) {
    return {
      partition: orphan,
      quarantined: true,
      reason: `分区属于项目 ${projectId}，但它不在当前账号的项目列表里`,
    };
  }
  return { partition: raw, quarantined: false };
}

function anyLaneWaiting(): boolean {
  for (const lane of lanes.values()) if (lane.waiters.length > 0) return true;
  return false;
}

/** 唤醒**这一路**挂着的等待（敏感输入 / 答复） */
function notifyResume(lane: Lane): void {
  if (lane.stopWatch) {
    lane.stopWatch();
    lane.stopWatch = null;
  }
  if (lane.holdTimer) {
    clearTimeout(lane.holdTimer);
    lane.holdTimer = null;
  }
  const waiters = lane.waiters;
  lane.waiters = [];
  for (const resolve of waiters) resolve();
}

function notifyAllResume(): void {
  for (const lane of [...lanes.values()]) notifyResume(lane);
}

function abortAllLanes(): void {
  for (const lane of [...lanes.values()]) {
    lane.aborted = true;
    lane.running = false;
    notifyResume(lane);
  }
  lanes.clear();
  liveLoops.clear();
  // 第 27 步：全局停手（登出 / 「停」）时，求助卡片与它的自动恢复观察一起收掉 ——
  // 否则用户登出后卡片还在，点它去 resume 一条已经不存在的循环。
  clearAllHelps('aborted');
}

/** 敏感等待态（第 9 步语义保留，第 17 步按路隔离）：前置窗口 + 聚焦**这一路那张页** + 挂自动恢复观察 */
function sensitiveHold(lane: Lane): Promise<void> {
  mainWindow?.show();
  mainWindow?.focus();
  // 渲染层：把焦点交给这一路那张页（两路并行时必须点名，不能瞎给）
  sendToMainWindow('workbench:browser:focus', String(lane.wcId));
  lane.stopWatch = startSensitiveAutoResume(() => notifyResume(lane), lane.wcId);
  // 2 分钟还没动静：提示手动兜底，等待继续挂着（不算失败，只是没自动化）
  lane.holdTimer = setTimeout(() => {
    emitAgent({
      kind: 'note',
      level: 'info',
      text: '没检测到页面变化。若你已完成输入并提交，点「继续」即可恢复驾驶。',
    });
  }, 120_000);
  return new Promise<void>((resolve) => {
    lane.waiters.push(resolve);
  });
}

/**
 * 第 17 步：事件里带上 wcId —— 两路可能属于不同智能体，
 * 渲染层靠它把步摘要/问话/结论落回**发起时那个智能体**的聊天里，绝不串。
 */
function emitAgent(payload: AgentEventPayload, wcId?: number): void {
  sendToMainWindow('workbench:browser:agent', JSON.stringify(wcId === undefined ? payload : { ...payload, wcId }));
}

async function agentPost<T>(path: string, body: unknown): Promise<T> {
  if (!agentJwt) throw new Error('没有可用的登录凭证（请先在窗口里登录）');
  let res: Response;
  try {
    res = await fetch(`${agentApiBase.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agentJwt}` },
      body: JSON.stringify(body),
      // 第 21 步：后端正常时最长一次模型调用 60s（服务端自己会掐），这里留 90s 上限。
      // 没有这个上限，后端半路挂掉会让驾驶循环永远停在「等下一步」上。
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    const msg = (err as Error).name === 'TimeoutError' ? '后端 90 秒没有回应（服务端可能卡住了）' : (err as Error).message;
    throw new Error(`连不上后端 ${agentApiBase}：${msg}`);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok) {
    const code = (data as { code?: string }).code;
    if (code === 'llm_not_configured') throw new Error('未配置模型：在 apps/server/.env 填 DEEPSEEK_API_KEY 后重启 npm run dev:server');
    if (res.status === 401) throw new Error('登录已过期：重新登录后再点「继续」');
    /**
     * ★ P0 止血（2026-09-21）：把服务端给的**语义码带出去**。
     *
     * 调用方要靠它区分「这条循环确实没了」和「网络抖了一下 / 服务端忙 / 401」——
     * 见 `resumeAgentLane` 里那道「要重新开始吗」的确认闸：只有 `loop_gone` 才弹，
     * 其余一律走「暂时接不上，稍后再试」。不做通用错误码重构，只加这一处。
     */
    const httpErr = new Error(
      (data as { error?: string }).error ?? `HTTP ${res.status}`,
    ) as Error & { code?: string };
    if (code) httpErr.code = code;
    throw httpErr;
  }
  return data;
}

/**
 * GET 版本（读口专用）。与 `agentPost` 同一套错误口径 —— 401 说"重新登录"、
 * 后端连不上说"连不上后端"，别让调用方各自解释一遍。
 */
async function agentGet<T>(path: string): Promise<T> {
  if (!agentJwt) throw new Error('没有可用的登录凭证（请先在窗口里登录）');
  let res: Response;
  try {
    res = await fetch(`${agentApiBase.replace(/\/+$/, '')}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${agentJwt}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const msg = (err as Error).name === 'TimeoutError' ? '后端 30 秒没有回应' : (err as Error).message;
    throw new Error(`连不上后端 ${agentApiBase}：${msg}`);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok) {
    if (res.status === 401) throw new Error('登录已过期：重新登录后再试');
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return data;
}

/**
 * 第 17 步：在某一张内嵌页上发车（或改道）。
 *
 * - 这张页上已经有一路在跑 → **最新指令优先**：旧循环作废，用新目标重发（第一步仍是读当前页）；
 * - 这张页上没有 → 新起一路（第 20 步取消了**按活页数**的硬顶；
 *   第 22 步改由配置项 `maxConcurrentAgentTasks` 管并发，默认 20 —— 见下面的 A1.5 注释）；
 * - 别路（别的页）**完全不动** —— 第二句不会把第一张降级成不能动的占位。
 *
 * 第 21 步：循环的**脑在服务端**。这里要么用渲染层带下来的 loopId（/chat/stream 已经建好），
 * 要么自己调 /agent/loop/start 建一个；然后 runToolLoop 只负责「要工具 → 执行 → 喂回执」。
 */
function startAgentLoop(
  wcId: number,
  goal: string,
  fresh: boolean,
  opts: { loopId?: string; agentId?: number | null; resume?: boolean } = {},
): ReturnType<typeof getTaskState> {
  const prev = lanes.get(wcId);
  /**
   * 阶段简报 · 方案 B：**「继续」不是重新发车，是原地接上**。
   *
   * 旧行为会把上一路作废（abort + `/agent/loop/stop`），再新建一个服务端循环。
   * 那对「用户主动暂停」是错的：stop 是终态，新循环的消息历史是空的，
   * AI 不记得自己做过什么，也就无从谈起「不重做用户手动完成的部分」。
   * 所以继续时**复用同一个 lane 与同一个 loopId**，让服务端那边的挂起态解除即可。
   */
  const resuming = opts.resume === true && !!prev?.loopId;
  if (prev && !resuming) {
    prev.aborted = true;
    prev.running = false;
    // 旧那一路在服务端的循环也要停：否则它还会被问下一步（白烧 token）
    if (prev.loopId) void agentPost('/agent/loop/stop', { loopId: prev.loopId, reason: 'superseded' }).catch(() => undefined);
    notifyResume(prev);
  } else if (!resuming) {
    /**
     * 第 22 步 · A1.5：**并发上限**（默认 20，设置里可调，绝不写死）。
     *
     * 「同一张页上的新指令覆盖旧指令」不算新增一路，所以只在 `!prev` 时判。
     * 超限就**拒绝发车**并把话说清楚 —— 既不静默丢弃，也不偷偷挤掉正在跑的那一路。
     * 上限是配置项而不是硬编码：把它调大就是更宽的并行，调小就是串行排队，
     * **不需要改数据结构**（这正是 A1.5 的意思）。
     */
    const limit = getSettings().maxConcurrentAgentTasks;
    if (lanes.size >= limit) {
      emitAgent(
        {
          kind: 'note',
          level: 'info',
          text:
            `现在已经有 ${lanes.size} 路在驾驶了，并发上限是 ${limit}（可以在设置里调大）。` +
            '要换一张页跑，先对正在跑的那张点「停」，或者把上限调大。',
        },
        wcId,
      );
      return getTaskState();
    }
  }

  const lane: Lane =
    resuming && prev
      ? prev // 继续：接着用原来那一路（loopId / agentId / 目标都原样保留）
      : {
          wcId,
          goal,
          loopId: typeof opts.loopId === 'string' && opts.loopId ? opts.loopId : null,
          agentId: typeof opts.agentId === 'number' ? opts.agentId : null,
          aborted: false,
          running: true,
          waiters: [],
          stopWatch: null,
          holdTimer: null,
          awaiting: false,
          answers: pendingAnswers.get(wcId) ?? [],
        };
  if (resuming && prev) {
    prev.aborted = false;
    prev.running = true;
    // 目标可能被「继续」时带的新指令更新（fresh=false 表示还是原目标）
    if (fresh) prev.goal = goal;
  }
  // 渲染层（/chat/stream）建好的循环号也要记下来，将来「继续」才接得回去
  if (lane.loopId) lastLoopByWc.set(wcId, lane.loopId);
  pendingAnswers.delete(wcId);
  pendingGoals.set(wcId, goal);
  lanes.set(wcId, lane);

  const detail = fresh
    ? `AI 驾驶中 · 任务：${goal.slice(0, 36)}`
    : `继续任务（先读当前页）：${goal.slice(0, 36)}`;
  // 第 22 步：状态机**按 target**，所以接管时要把「哪一张页」说清楚
  const state = takeoverRun(
    wcId,
    lanes.size > 1 ? `${lanes.size} 路驾驶中 · 本路任务：${goal.slice(0, 30)}` : detail,
  );

  void (async () => {
    liveLoops.set(wcId, lane);
    // 1) 拿到这一路的循环 id（渲染层没带就自己建一个：同一条服务端引擎，没有第二套）
    if (!lane.loopId) {
      const r = await agentPost<AgentLoopStartResult>('/agent/loop/start', {
        agentId: lane.agentId,
        goal,
        wcId,
      });
      if (!r || typeof r.loopId !== 'string') throw new Error('服务端没有给出循环号');
      lane.loopId = r.loopId;
      /**
       * ★ 把 agentId 换成**服务端认的那个**（权威值），不要继续用渲染层猜的。
       * 服务端建循环时可能用了比请求更权威的来源（`/chat/stream` 用的是会话自己的 agent_id），
       * 所以"我传了什么"和"循环实际记的是谁"可能不同 —— 后面每一步都要拿实际记的那个去自证，
       * 否则硬闸会判成不匹配（这正是之前三路全 brain_failed 的原因）。
       */
      lane.agentId = typeof r.agentId === 'number' ? r.agentId : lane.agentId;
      // 阶段简报：按页记一份循环号 —— 暂停会把 lane 摘掉，继续时靠它接回同一个循环
      lastLoopByWc.set(wcId, r.loopId);
      console.log(`[agent] 第 ${wcId} 路新循环 ${r.loopId}（上限 ${r.maxSteps} 步）`);
    } else {
      /**
       * ★ 循环是**渲染层**建的（`/chat/stream` 任务轮），我们手里只有 loopId ——
       * 那就拿它去换一次权威身份，把 agentId 补上。
       *
       * 为什么不干脆不传 agentId：`/agent/loop/next` 的归属硬闸要求调用方自证，
       * 缺了就是"不匹配"，整条路会 brain_failed。硬闸不能因为"调用方不知道"就放行
       * （那就退回成漏洞了），正确做法就是让它**问得到**。
       */
      try {
        const info = await agentGet<AgentLoopInfoResult>(
          `/agent/loop/info?loopId=${encodeURIComponent(lane.loopId)}`,
        );
        if (info && typeof info.agentId === 'number') lane.agentId = info.agentId;
      } catch (err) {
        // 问不到就保持原样：宁可在下一步被硬闸明确拒掉（有清晰错误），
        // 也不要在这里静默改成"不传"（那等于绕过硬闸）。
        console.warn(`[agent] 第 ${wcId} 路拿不到循环身份（继续用本地值）：`, (err as Error).message);
      }
    }
    if (lane.aborted) return;

    // 2) 当「手」：要工具 → 用现有 driver 在**这一路自己那张页**上执行 → 喂回执
    return runToolLoop(lane.loopId, goal, {
      next: (loopId, result) =>
        agentPost<AgentLoopNextResult>('/agent/loop/next', {
          loopId,
          agentId: lane.agentId,
          wcId,
          result,
        }).then((r) => {
          if (!r || !r.decision || typeof (r.decision as { kind?: string }).kind !== 'string') {
            throw new Error('服务端回了畸形的决策');
          }
          return r.decision;
        }),
      // 第 17 步：动作一律打到**这一路自己的那张页**上（两路并行时绝不能盲选 guest）
      exec: (action) => drive(action, wcId),
      // 第 22 步：暂停门按 target 判 —— 只问**这一路自己那张页**有没有被按住
      isPaused: () => isDrivingPaused(wcId),
      aborted: () => lane.aborted,
      emit: (payload) => {
        if (payload.kind === 'ask' || payload.kind === 'sensitive') lane.awaiting = true;
        emitAgent(payload, wcId);
      },
      stopLoop: (reason) => {
        if (!lane.loopId) return;
        void agentPost('/agent/loop/stop', { loopId: lane.loopId, reason }).catch(() => undefined);
      },
      /**
       * 阶段简报：用户点「暂停」→ 服务端**挂起**（不是 stop）。
       * 挂起后消息历史保留，继续时能原地接上。
       */
      pauseLoop: async (by?: string, result?: LoopToolResult | null) => {
        if (!lane.loopId) return;
        // R3：暂停时把桌面没喂过的回执一起刷上去 —— 服务端先认领再挂起，继续后不再重发。
        await agentPost('/agent/loop/pause', { loopId: lane.loopId, pausedBy: by ?? 'user', ...(result ? { result } : {}) });
        console.log(`[agent] 第 ${wcId} 路已挂起（服务端循环 ${lane.loopId} 保留历史${result ? '，回执已刷' : ''}）`);
      },
      sensitiveNotice: (question) => {
        // 敏感字段：窗口前置 + 聚焦这一路那张页 + 🔒 人话提示（值不经 AI、不落库）
        mainWindow?.show();
        mainWindow?.focus();
        sendToMainWindow('workbench:browser:focus', String(wcId));
        lane.awaiting = true;
        emitAgent({ kind: 'sensitive', fieldReason: 'sensitive', message: question }, wcId);
      },
      // 第 22 步：外部循环汇报的状态同样落到**这一路那张页**上
      // 第 27 步：多带一个 by —— 这次暂停是谁发起的（界面靠它区分"用户接管 / AI 求助"）
      phase: (next, detail, by) => setExternalPhase(wcId, next, detail, undefined, by),
      /**
       * 第 27 步：AI 主动求助 → 聊天流里长出那张求助卡片。
       * 判定（保守触发闸）在 agent.ts 的 `maybeRaiseHelp` 里，这里只负责落地。
       */
      raiseHelp: (info) => helpHub.raise(wcId, info),
      taskStart: async (g) => {
        try {
          const r = await agentPost<{ taskId: number }>('/agent/task/start', { goal: g });
          return typeof r.taskId === 'number' ? r.taskId : null;
        } catch {
          return null; // 记账失败不拦驾驶
        }
      },
      taskStep: async (id, summary, ok) => {
        if (id === null) return;
        await agentPost('/agent/task/step', { taskId: id, summary, ok }).catch(() => undefined);
      },
      taskStatus: async (id, status) => {
        if (id === null) return;
        await agentPost('/agent/task/status', { taskId: id, status }).catch(() => undefined);
      },
      sensitiveHold: () => sensitiveHold(lane),
      takeAnswers: () => {
        const list = lane.answers;
        lane.answers = [];
        lane.awaiting = false;
        return list;
      },
      // 第 8 步：done 收尾（服务端整理文档 + unread=true + 调通知桩；这里失败不卡 done）
      taskFinish: async (id, doneBits, pagePoints) => {
        const r = await agentPost<{ unreadHint?: string; docTitle?: string }>('/agent/task/finish', {
          taskId: id,
          summary: doneBits.summary,
          document_title: doneBits.document_title,
          document_outline: doneBits.document_outline,
          pagePoints,
        });
        return { unreadHint: r.unreadHint, docReady: Boolean(r.docTitle) };
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
  })()
    .then((reason) => finishLane(lane, reason ?? 'done'))
    .catch((err) => {
      // 循环本体不抛穿（内部都 catch 了）；真到这就是编程错误，也得说人话而不是崩
      console.error('[agent] 循环异常：', err);
      emitAgent({ kind: 'note', level: 'error', text: `驾驶员内部错误：${(err as Error).message}` }, wcId);
      setExternalPhase(wcId, 'failed', `驾驶员内部错误 — ${(err as Error).message}`);
      finishLane(lane, 'brain_failed');
    });
  return state;
}

/** 一路循环收尾：从运行表里摘掉，并按剩余路数决定全局状态机怎么显示 */
function finishLane(lane: Lane, reason: string): void {
  lane.running = false;
  // 只摘**自己**这一趟：狂点时可能已经有新的一趟顶上来了，别把新那趟的标记删掉
  if (liveLoops.get(lane.wcId) === lane) liveLoops.delete(lane.wcId);
  notifyResume(lane);
  if (lanes.get(lane.wcId) === lane) lanes.delete(lane.wcId);
  console.log(`[agent] 第 ${lane.wcId} 路循环结束：${reason}`);
  if (lane.aborted) {
    pendingGoals.delete(lane.wcId); // 被新指令顶掉：旧目标不再提起
    /**
     * 第 22 步：把**这张页**的状态收干净，否则聚合视图会一直显示「AI 驾驶中」
     * （用户点了「停」、状态却永远停在 running，确认按钮跟着一直是灰的）。
     *
     * 但要小心两种「已中止」：
     *   - 同一张页上**换了新的一路**（最新指令优先）→ 绝不能动状态，否则会把新循环的
     *     running 覆盖成 idle；
     *   - 用户停手 / 登出（`abortAllLanes` 已把 lanes 清空）→ 这时才收。
     */
    const current = lanes.get(lane.wcId);
    if (!current || current === lane) {
      setExternalPhase(lane.wcId, 'idle', '已停手（这一路已结束）');
    }
    return;
  }
  if (reason === 'done' || reason === 'read_failed' || reason === 'brain_failed') {
    pendingGoals.delete(lane.wcId);
  } else {
    // paused / ask_user / stuck / budget：留着目标等「继续」或用户答复
    pendingGoals.set(lane.wcId, lane.goal);
  }
  /**
   * 第 22 步：状态按 target 存 —— 这一路如实记成**它自己的结局**。
   *
   * 以前这里会把**全局**状态硬写成 running 并说「N 路仍在驾驶中」；
   * 现在「还有别的路在跑」由左栏的聚合视图自然体现（它会挑一条在跑的显示），
   * 不需要把已经停下的这一路也说成 running。
   */
  const mine: TaskPhase =
    reason === 'done'
      ? 'done'
      : reason === 'paused' || reason === 'ask_user' || reason === 'stuck' || reason === 'budget'
        ? 'paused'
        : 'failed';
  const tail =
    mine === 'done'
      ? `完成 — ${lane.goal.slice(0, 40)}`
      : mine === 'paused'
        ? `等你的下一步：${lane.goal.slice(0, 30)}`
        : `驾驶员已停止（${reason}）`;
  setExternalPhase(lane.wcId, mine, tail);
}

/**
 * ★ 显式的「登录态同步」通道 —— 只在渲染层**登录成功那一刻**调用一次。
 *
 * 存在的唯一理由（不要删，删了会坏一个真实场景）：
 *   主进程的 `agentJwt` 是纯内存变量，只在 `workbench:agent:start` 时被写入。
 *   而渲染层点 F5 时，它会从 localStorage 悄悄把登录态恢复回来（`/auth/me`）——
 *   这一路**完全不经过主进程**。于是出现「渲染层已登录、主进程没凭证」的错位，
 *   用户在刷新后立刻点"下载文档"就会失败。
 *
 * 为什么不干脆恢复成"下载时把 token 传进来"：
 *   那等于让渲染层随时能把任意 JWT 递给主进程去发请求（主进程不受同源策略约束），
 *   是把同源策略在我们自己程序里拆掉。改为**显式同步**后：
 *     - 时刻只有一处（登录成功）、且与业务动作解耦 —— 渲染层不能"顺手夹带"凭证；
 *     - 主进程仍然是发请求时**唯一**的凭证持有者，下游（下载等）一律只用自己的那份。
 *
 * 与 `agent:start` 的关系：两者都写 `agentJwt`，语义一致（都是"用户此刻已登录"）。
 * 登出 / 会话失效时渲染层应再调一次 `syncSession(base, '')` 把它清掉。
 */
ipcMain.handle('workbench:session:sync', (_event, apiBaseRaw: unknown, tokenRaw: unknown) => {
  const base = typeof apiBaseRaw === 'string' ? apiBaseRaw.trim() : '';
  if (base && isLoopbackBase(base)) agentApiBase = base;
  // 允许显式清空（登出）；非字符串一律忽略，不当成"清空"误伤。
  if (typeof tokenRaw === 'string') agentJwt = tokenRaw.trim();
  return { ok: true, hasToken: Boolean(agentJwt) };
});

/**
 * ★ 项目列表同步 —— 渲染层拿到 `/projects` 的结果后推过来，供分区闸判定归属。
 *
 * 为什么不让主进程自己去拉：`will-attach-webview` 是**同步**事件，
 * `preventDefault()` 必须当场调用，没机会 await 一次 HTTP。
 * 所以只能由渲染层在拿到列表时显式推一次（与 `session:sync` 同一个思路）。
 *
 * 传空数组是**有意义的**：表示"这个账号确实一个项目都没有"，
 * 与"还没同步过"（主进程放行+告警）是两种不同状态 —— 所以这里要写 `projectsSyncedAt`。
 */
ipcMain.handle('workbench:projects:sync', (_event, idsRaw: unknown) => {
  if (!Array.isArray(idsRaw)) return { ok: false, error: '需要数组' };
  const ids = idsRaw
    .map((x) => Number(x))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  ownedProjectIds.clear();
  for (const n of ids) ownedProjectIds.add(n);
  projectsSyncedAt = Date.now();
  console.log(`[main] 已同步项目列表（${ids.length} 个），分区闸开始生效`);
  return { ok: true, count: ids.length };
});

ipcMain.handle(
  'workbench:agent:start',
  (_event, goal: unknown, apiBase: unknown, token: unknown, targetRaw: unknown, optsRaw: unknown) => {
    const g = typeof goal === 'string' ? goal.trim().slice(0, 200) : '';
    if (!g) return getTaskState();
    // 第 17 步：两路并行时必须点名「驾驶哪一张页」——不点名就宁可不开车，
    // 也绝不让主进程自己瞎挑一张（那会把动作打到另一路正在跑的页面上）。
    const wcId = Number(targetRaw);
    if (!Number.isInteger(wcId)) {
      emitAgent({ kind: 'note', level: 'error', text: '这一路没有指定要驾驶哪张内嵌页，没有发车。' });
      return getTaskState();
    }
    // 地址同样只认回环（与 doc:download 同一条规矩，别只堵一个口子）。
    if (typeof apiBase === 'string' && apiBase && isLoopbackBase(apiBase)) agentApiBase = apiBase;
    if (typeof token === 'string') agentJwt = token; // 只存内存；绝不 console
    /**
     * 第 21 步：opts = {loopId?, agentId?}。
     * loopId 是 /chat/stream 的任务轮已经建好的那个服务端循环（带上就不用再建）；
     * agentId 记下这一路属于哪个智能体（服务端用它挡住串到别的 bot 的页）。
     */
    const opts = (optsRaw ?? {}) as { loopId?: unknown; agentId?: unknown };
    const loopId = typeof opts.loopId === 'string' && opts.loopId ? opts.loopId : undefined;
    const agentIdRaw = Number(opts.agentId);
    const agentId = Number.isInteger(agentIdRaw) && agentIdRaw > 0 ? agentIdRaw : null;
    if (agentId !== null) lastAgentByWc.set(wcId, agentId);
    return startAgentLoop(wcId, g, true, { loopId, agentId });
  },
);

/** 第 17 步：当前正在驾驶的 webview guest id 列表（渲染层开第 3 张页时用来挑「没在跑的那张」） */
ipcMain.handle('workbench:agent:lanes', () => [...lanes.keys()]);

/**
 * Phase 3：渲染层登记「这张内嵌页是哪个智能体开的」。
 *
 * 分区名里现在只放得下 projectId，而下载记录必须能标出「哪个智能体触发的」——
 * 所以由渲染层在页就绪时报一次（见 preload 的 browserOwner / BrowserPanel 的 dom-ready）。
 */
ipcMain.handle('workbench:browser:owner', (_event, wcIdRaw: unknown, agentIdRaw: unknown) => {
  const wcId = Number(wcIdRaw);
  const agentId = Number(agentIdRaw);
  if (!Number.isInteger(wcId) || wcId < 0) return;
  if (!Number.isInteger(agentId) || agentId <= 0) return;
  webviewOwner.set(wcId, agentId);
});

/**
 * 第 24 步：**浅休眠** —— 把一张后台内嵌页的节流拉到最紧。
 *
 * 浅休眠与深休眠的分工（改这里前先看懂）：
 *   - 浅休眠**不卸载** `<webview>`（页面、滚动、SPA 状态全在，唤醒是瞬时的），
 *     它要解决的是 **CPU**：视频在后台继续解码、广告 iframe 在后台轮询、
 *     `setInterval` 在后台空转 —— 这些让笔记本发烫。
 *   - 深休眠才卸载、才省内存（那是渲染层的事，不经过这里）。
 *
 * `setBackgroundThrottling(true)` 是 Electron 的机制：把这个 guest 标记成"后台"，
 * Chromium 就会按后台规则降频（定时器被钳到 1 秒级、requestAnimationFrame 基本停摆）。
 * **不改页面内容、不注入脚本、不影响 cookie** —— 纯资源层面的开关。
 *
 * ⚠️ 两个必须守住的边界：
 *   ① 正在被驾驶的页**绝不能**被节流。驾驶要靠 CDP 在页里查找/点击/滚动，
 *      节流会让 `requestAnimationFrame` 停摆、元素坐标拿不到，**点击就失灵了**——
 *      这正是我们前几轮在修的那个 bug，别自己再造一个。
 *      这里直接拒绝对 drivingIds 里的页做节流（渲染层也拦了一道，双保险）。
 *   ② 唤醒时要**立刻**恢复（`false`），否则用户切回来页面还是卡着。
 */
ipcMain.handle('workbench:browser:throttle', (_event, wcIdRaw: unknown, throttleRaw: unknown) => {
  const wcId = Number(wcIdRaw);
  const throttle = Boolean(throttleRaw);
  if (!Number.isInteger(wcId) || wcId < 0) return { ok: false, error: 'bad wcId' };
  // ① 被驾驶的页一律不节流（拒绝，且明确回报，让渲染层能看出来）
  const isDriving = [...lanes.values()].some((lane) => lane.wcId === wcId);
  if (throttle && isDriving) return { ok: false, error: 'driving' };
  try {
    const wc = webContents.fromId(wcId);
    if (!wc || wc.isDestroyed()) return { ok: false, error: 'gone' };
    wc.setBackgroundThrottling(throttle);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

// ---------------------------------------------------------------------------
// ADR-0002：页宿主族（渲染层只发指令；生命周期在 view-host.ts）。
// 渲染层传的是 tabKey（tabId 当键）+ projectId，**不传分区名** —— 分区字符串由
// 主进程在 create 里拼并过闸（唯一建页口，见 view-host 的注释）。
// ---------------------------------------------------------------------------

/** 页能否作**首帧地址**：http(s) 或工作台自己的 data: 起始页（其余一律拒绝，fail-closed） */
const isCreatablePageUrl = (url: string): boolean => isHttpUrl(url) || url.startsWith('data:text/html');

ipcMain.handle('workbench:browser:view-create', (_event, req: unknown) => {
  const r = req as { tabKey?: unknown; projectId?: unknown; url?: unknown } | null;
  const tabKey = Number(r?.tabKey);
  if (!Number.isInteger(tabKey) || tabKey < 0) throw new Error('view-create：tabKey 非法');
  const url = typeof r?.url === 'string' ? r.url : '';
  if (!isCreatablePageUrl(url)) throw new Error('view-create：只允许 http/https 或工作台起始页');
  const projectId =
    typeof r?.projectId === 'number' && Number.isInteger(r.projectId) && r.projectId > 0 ? r.projectId : null;
  return viewHostCreate({ tabKey, projectId, url });
});

ipcMain.handle('workbench:browser:view-rect', (_event, req: unknown) => {
  const r = req as { tabKey?: unknown; rect?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown }; visible?: unknown } | null;
  const tabKey = Number(r?.tabKey);
  if (!Number.isInteger(tabKey)) return;
  const raw = r?.rect;
  const rect =
    raw && Number.isFinite(raw.x) && Number.isFinite(raw.y) && Number.isFinite(raw.width) && Number.isFinite(raw.height)
      ? { x: raw.x as number, y: raw.y as number, width: raw.width as number, height: raw.height as number }
      : { x: 0, y: 0, width: 0, height: 0 };
  viewHostRect({ tabKey, rect, visible: r?.visible !== false });
});

ipcMain.handle('workbench:browser:view-order', (_event, tabKeyRaw: unknown) => {
  const tabKey = Number(tabKeyRaw);
  if (Number.isInteger(tabKey)) viewHostOrder(tabKey);
});

ipcMain.handle('workbench:browser:view-navigate', (_event, req: unknown) => {
  const r = req as { tabKey?: unknown; url?: unknown } | null;
  const tabKey = Number(r?.tabKey);
  if (!Number.isInteger(tabKey)) return { ok: false, error: 'bad tabKey' };
  const url = typeof r?.url === 'string' ? r.url : '';
  // 首帧闸同 create；导航闸（非 http(s) 整页跳转）由 wireBrowserGuest 的 will-navigate 兜底
  if (!isCreatablePageUrl(url)) return { ok: false, error: '只允许 http/https 或工作台起始页' };
  return viewHostNavigate({ tabKey, url });
});

ipcMain.handle('workbench:browser:view-focus', (_event, tabKeyRaw: unknown) => {
  const tabKey = Number(tabKeyRaw);
  if (Number.isInteger(tabKey)) viewHostFocus(tabKey);
});

ipcMain.handle('workbench:browser:view-close', (_event, tabKeyRaw: unknown) => {
  const tabKey = Number(tabKeyRaw);
  if (Number.isInteger(tabKey)) viewHostClose(tabKey);
});

// 第 8 步：结果文档下载。拿到 Markdown 后：先本地脱敏兜底，再弹系统"保存为"对话框（只有 1 个窗口，不新增窗）。
//
// ★ 关于凭证与地址的两个改动（本批次）：
//   - `apiBase` **只放行回环地址**：主进程发出的请求不受同源策略约束，
//     允许任意地址就等于给了渲染层一个"把 JWT 发去任何地方"的口子（见 `isLoopbackBase`）；
//   - `token` **只认主进程内存里的 `agentJwt`，不再接受渲染层传入**：
//     但刷新后主进程可能确实没会话（它只在 `agent:start` 时被写入），
//     所以由渲染层在静默登录成功时经 `workbench:session:sync` 显式同步一次。
ipcMain.handle('workbench:doc:download', async (_event, taskIdRaw: unknown, apiBaseRaw: unknown) => {
  const taskId = Number(taskIdRaw);
  if (!Number.isInteger(taskId)) return { saved: false, error: '没有可用的任务号（taskId 非法）' };
  // 地址：渲染层可以指定（本机换端口开发），但**必须落在回环内**，否则拒绝。
  const wantedBase = typeof apiBaseRaw === 'string' && apiBaseRaw ? apiBaseRaw : agentApiBase;
  if (!isLoopbackBase(wantedBase)) {
    return { saved: false, error: `只允许下载本机后端（回环地址）的文档，已拒绝：${wantedBase}` };
  }
  const apiBase = wantedBase;
  // 凭证：**一律**用主进程内存里的那份，不接受渲染层传入。
  const token = agentJwt;
  if (!token) return { saved: false, error: '没有登录凭证：请先登录，或刷新后重新登录一次' };
  try {
    const res = await fetch(`${apiBase.replace(/\/+$/, '')}/agent/task/doc?taskId=${taskId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const data = (await res.json().catch(() => ({}))) as { markdown?: string; title?: string; error?: string };
    if (!res.ok) return { saved: false, error: data.error ?? `HTTP ${res.status}` };
    let md = String(data.markdown ?? '');
    if (!md.trim()) return { saved: false, error: '文档是空的，别下载；去后端日志看收尾是否被跳过' };
    // 脱敏兜底：Key/JWT/手机号绝不进文件（服务端文档本不该有，这里再滤一遍）
    md = md
      .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [已隐去]')
      .replace(/sk-[A-Za-z0-9_\-]{6,}/g, '[已隐去密钥]')
      .replace(/\b1[3-9]\d{9}\b/g, '[已隐去手机号]');
    const safeTitle = String(data.title || '任务记录')
      .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
      .trim()
      .slice(0, 60) || '任务记录';
    const options: Electron.SaveDialogOptions = { defaultPath: `${safeTitle}.md`, filters: [{ name: 'Markdown 文档', extensions: ['md'] }] };
    const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const { canceled, filePath } = target ? await dialog.showSaveDialog(target, options) : await dialog.showSaveDialog(options);
    if (canceled || !filePath) return { saved: false, canceled: true };
    await writeFile(filePath, `<!-- 由 AI 工作台导出 · 只含任务结论，凭证与手机号已过滤 -->\n\n${md}`, 'utf8');
    return { saved: true, path: filePath };
  } catch (err) {
    return { saved: false, error: (err as Error).message };
  }
});


// 第 9 步：用户对「补资料」提问的回答。只许普通资料（模型层+执行层双闸挡敏感值）；
// 只进内存与步摘要，不进 messages/memories。等待中收到答复 = 自动唤醒继续。
// 第 17 步：两路并行时答复只喂给**提问的那一路**（带 targetWebContentsId），不串到别路。
ipcMain.handle('workbench:agent:answer', (_event, text: unknown, targetRaw: unknown) => {
  const t = typeof text === 'string' ? text.trim().slice(0, 200) : '';
  if (!t) return getTaskState();
  const asked = Number(targetRaw);
  const targets = new Set<number>();
  if (Number.isInteger(asked)) {
    targets.add(asked);
  } else {
    // 没点名：优先给正在等答复的那几路；一路都没有就按挂起的目标猜
    for (const lane of lanes.values()) if (lane.awaiting) targets.add(lane.wcId);
    if (targets.size === 0) for (const wcId of pendingGoals.keys()) targets.add(wcId);
  }
  for (const wcId of targets) {
    const lane = lanes.get(wcId);
    if (lane && lane.awaiting && lane.waiters.length > 0) {
      lane.answers.push(t); // 循环还挂在敏感等待上：喂进去 + 唤醒
      notifyResume(lane);
      continue;
    }
    const goal = lane?.goal ?? pendingGoals.get(wcId);
    if (!goal) continue;
    pendingAnswers.set(wcId, [...(pendingAnswers.get(wcId) ?? []), t]);
    // 第 21 步：带答复重启（仍是先读当前页）；智能体沿用这张页上一次那个
    startAgentLoop(wcId, goal, false, { agentId: lane?.agentId ?? lastAgentByWc.get(wcId) ?? null });
  }
  return getTaskState();
});

ipcMain.handle('workbench:agent:stop', () => {
  // 第 21 步：先告诉服务端「这些循环都别走了」（否则它还会被问下一步，白烧 token）
  for (const lane of lanes.values()) {
    if (lane.loopId) void agentPost('/agent/loop/stop', { loopId: lane.loopId, reason: 'agent_stop' }).catch(() => undefined);
  }
  abortAllLanes();
  agentJwt = '';
  notifyAllResume(); // 别让挂在敏感等待上的循环僵住
  pendingGoals.clear();
  pendingAnswers.clear();
  lastAgentByWc.clear();
  emitAgent({ kind: 'note', level: 'info', text: '驾驶员循环已中止（登出/停止）。' });
});

/**
 * 第 16 步：**放下**当前任务但保留登录凭证 —— 用户改口时用。
 *
 * 场景：正在做任务 A（例如看旧店铺后台），用户直接说「打开油管」。
 * 最新指令优先级最高：旧循环立刻作废，旧目标清空（不会被「继续」重新捡起来），
 * 状态机回 idle。凭证保留，所以新任务不用重新登录。
 *
 * 第 17 步：带 targetWebContentsId 时**只放下那一路**（那一张页），
 * 另一路在别的页上继续跑 —— 这正是「第二句不会把第一张废掉」。
 * 不带则放下全部（登出 / 停止）。
 */
ipcMain.handle('workbench:agent:drop', (_event, targetRaw: unknown) => {
  const wcId = Number(targetRaw);
  if (Number.isInteger(wcId)) {
    const lane = lanes.get(wcId);
    if (lane) {
      lane.aborted = true;
      lane.running = false;
      // 第 21 步：只停**这一路**在服务端的那个循环（别路照跑）
      if (lane.loopId) void agentPost('/agent/loop/stop', { loopId: lane.loopId, reason: 'dropped' }).catch(() => undefined);
      notifyResume(lane);
      lanes.delete(wcId);
    }
    pendingGoals.delete(wcId);
    pendingAnswers.delete(wcId);
    lastAgentByWc.delete(wcId);
    // 第 27 步：用户选「不用了，停手」→ 求助卡与它的自动恢复观察一起收掉。
    // 不收的话，观察窗还挂着：用户随便动一下页面就会被当成"处理完了"，
    // 然后去 resume 一条已经被 drop 掉的循环 —— 卡片会莫名其妙自己消失。
    clearHelp(wcId, 'dropped');
    if (lanes.size === 0) resetTask();
    return;
  }
  for (const lane of lanes.values()) {
    if (lane.loopId) void agentPost('/agent/loop/stop', { loopId: lane.loopId, reason: 'dropped_all' }).catch(() => undefined);
  }
  abortAllLanes();
  notifyAllResume();
  pendingGoals.clear();
  pendingAnswers.clear();
  lastAgentByWc.clear();
  resetTask();
  emitAgent({ kind: 'note', level: 'info', text: '按你的最新指令：已经放下上一件事（旧任务不再提起）。' });
});

// 单实例锁：重复启动时聚焦已有窗口，而不是再开一个
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // 已经有实例在跑。如果不打印这行，新进程会「1 秒内静默退出、退出码 0」，
  // 看起来像启动成功了但窗口没出现，非常难排查。
  console.warn('[main] 检测到已有实例在运行，本次启动退出（已聚焦原窗口）。');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    /**
     * ★ 服务端守护：**先确保后端可用，再开窗**。
     *
     * 为什么放在 createMainWindow() 之前：
     *   桌面端与服务端是两个独立进程（桌面端不打包服务端），后端没起时登录页会直接
     *   红字「连不上后端 http://127.0.0.1:8787」—— 用户得自己记得去跑 `npm run dev:server`，
     *   重启电脑后尤其容易撞上。这里把这件事自动做掉。
     *
     * 三条硬约束（改这段前先看 server-supervisor.ts 的文件头注释）：
     *   ① 8787 上本来就有服务端 → **一个字节都不动它**，退出时也不杀；
     *   ② 只 kill「我们自己 spawn 出来的那一个 child 进程」，不靠 PID 猜；
     *   ③ 拉不起来**不阻塞开窗**（登录页那句红字是准确的，别用 Modal 挡住用户）。
     *
     * 注意是 `void ... .then()` 不 await：真让它等到超时（30s）才开窗，
     * 用户会以为应用卡死了。这里**不阻塞窗口创建**，探测/拉起在后台跑；
     * 拉起成功后由渲染层的重试逻辑自然接上（登录页本来就有「重新尝试」的语义）。
     */
    /**
     * ★ 数据库守护（2026-09-20 新增）：**先确保库在，再确保后端在**。
     *
     * 为什么必须先库后服务端：
     *   服务端启动时会跑一次 migrate 建表。如果那一刻 5432 上没有库，
     *   migrate 就失败（日志「数据库暂未连通」），而 /auth 一律回 503 ——
     *   用户看到的就是「数据库没连上」。所以顺序不能反。
     *
     * 两条自我约束（与 ensureServer 一致，改之前先看 server-supervisor.ts 注释）：
     *   ① 5432 上本来就有库 → 一个字节都不动它；
     *   ② **退出时不杀 PG** —— 它是本机共享的数据库服务，杀了下次要等 30 多秒恢复。
     *
     * 同样 `void ...` 不 await：拉起最坏要 90 秒，绝不能拿它挡住开窗。
     */
    /**
     * ★ 把守护进程的日志打出来，**顺带把 mock 验证码转给登录页**。
     *
     * 为什么需要：服务端是应用**自己**拉起来的，stdio 走 `pipe` 被这里接管 ——
     * 那行 `[sms:mock] → 186****4444 验证码 169532` 只进了这条管道，
     * 用户**看不到任何窗口**（start-dev.cmd 那个「AI工作台-服务端」窗口根本不存在）。
     * 没有这一转，"能连上后端"和"拿得到验证码"就是两回事，用户照样进不去。
     *
     * 只在 mock 模式命中：生产环境服务端不打印验证码，这段永远不会触发。
     */
    const relayServerLog = (msg: string): void => {
      console.log(msg);
      const m = /\[sms:mock\][^\n]*?(\d{3})\*+(\d{4})[^\n]*?验证码\s*(\d{6})/.exec(msg);
      if (m) sendToMainWindow('workbench:sms:mock', { masked: `${m[1]}****${m[2]}`, code: m[3] });
    };

    void ensurePostgres(relayServerLog)
      .then((pgOk) => {
        if (!pgOk) {
          console.warn('[main] 数据库未能自动就绪 —— 登录页会提示「数据库没连上」，请手动跑 start-dev.cmd。');
        }
        // 库这一步无论成败都继续拉服务端：库没起来时服务端也会起（只是 /auth 回 503），
        // 而且它自己会带重试地建表 —— 库稍后就绪时能自己接上。
        return ensureServer(undefined, relayServerLog);
      })
      .then((ok) => {
        if (!ok) {
          console.warn('[main] 后端未能自动就绪 —— 登录页会提示「连不上后端」，请手动起服务端。');
          return;
        }
        const st = getServerState();
        sendToMainWindow('workbench:server-state', st);
      });

    /**
     * ★★ 后端保活心跳（2026-09-20 补）—— 上面那次 `ensureServer` **只在启动时跑一次**，
     * 那是不够的。
     *
     * 实测踩到（用户报「连不上后端：Failed to fetch」，而应用明明开着）：
     *   应用启动那一刻，8787 上碰巧有**别人**的服务端（上一次进程留下的）。
     *   按约定我们「已有服务端在跑，直接用（不接管）」—— 于是**不持有**它的句柄。
     *   那个进程随后随它的宿主一起死掉，而我们**毫不知情、也不会重拉** ——
     *   结果就是：人在工作台里，后端已经没了，一发消息就失败，而且**自己好不了**。
     *
     * 现在每 10 秒探一次（连同数据库一起），掉了就重新拉起。
     * 与 PG 看门狗同一个思路：**「启动时拉过一次」不等于「它一直在」**。
     *
     * 短路为什么安全：`ensureServer` 只在「**自己 spawn 的** child 还活着且刚就绪过」时才跳过探测；
     * child 一退出就把句柄置空 → 下一轮心跳必然重新探测并拉起。外部服务端则每次都真探。
     */
    const HEARTBEAT_MS = 10_000;
    const heartbeat = setInterval(() => {
      void ensurePostgres(relayServerLog, { quiet: true })
        .catch(() => false)
        .then(() => ensureServer(undefined, relayServerLog))
        .then((ok) => {
          if (ok) sendToMainWindow('workbench:server-state', getServerState());
          else console.warn('[main] 后端保活：这一轮没能拉起，10 秒后再试。');
        })
        .catch((err) => console.warn('[main] 后端保活出错：', (err as Error).message));
    }, HEARTBEAT_MS);
    app.on('before-quit', () => clearInterval(heartbeat));

    /**
     * 第 17 步：让内嵌页的 UA 像**普通 Chrome 桌面**——只去掉 `Electron/<版本>` 与产品名 token。
     * 目的很窄：少一眼被站点认成「内嵌壳」。明确**不做**指纹浏览器那一套（不改 Canvas/WebGL/字体…）。
     */
    const rawUa = app.userAgentFallback || '';
    if (rawUa) {
      const clean = rawUa
        .replace(/\sElectron\/[^\s]+/g, '')
        .replace(/\s(ai-workbench|AI\s*工作台)\/[^\s]+/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (clean && clean !== rawUa) {
        app.userAgentFallback = clean;
        console.log('[main] 内嵌页 UA 已去掉 Electron token（贴近普通 Chrome 桌面）。');
      }
    }

    createMainWindow();

    /**
     * Phase 4：资源守护者 —— 持续采集本应用的内存 / CPU、按两档阈值判定、落盘并暴露 IPC。
     *
     * 注入两样东西：
     *   - `sendToMainWindow`：警戒提示往渲染层广播（本阶段复用既有单行提示通道，不新增 UI）；
     *   - `getDriving`：**有未结束任务的页**（lanes 里在跑的 + pendingGoals 里挂着等继续的）
     *     —— 主进程才是权威，提示里"这个别关"必须按它说，不能听渲染层转述。
     *
     * ⚠️ 它**不改任何浏览器行为**：不关页、不限开、不插进驾驶循环。
     *    监控自己出问题时，配置里 `resourceGuardEnabled=0` 就能让它闭嘴，不用改代码。
     */
    initResourceGuard(sendToMainWindow, () => [...lanes.keys(), ...pendingGoals.keys()]);

    // macOS：点 Dock 图标且无窗口时重建
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
}

// Windows / Linux：关掉所有窗口即退出；macOS 保留在 Dock
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * ★ 服务端收尾：**只停我们自己拉起的那一份**。
 *
 * 用户手动起的服务端（比如开发者开着 `npm run dev:server`）绝不能被应用退出带走 ——
 * 那会把人家正在跑的东西弄没。是不是"我们自己起的"由 server-supervisor 用 child 句柄判定，
 * 不靠端口或 PID 猜。
 *
 * 用 'before-quit' 而不是 'quit'：后者触发时事件循环已经在收尾，
 * 再 spawn taskkill 可能来不及执行完。
 */
app.on('before-quit', () => {
  stopOwnedServer((msg) => console.log(msg));
});
