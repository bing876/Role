/**
 * 第 20 步 · 浏览器模块的唯一对外入口。
 *
 * 以后要改浏览器相关的东西，**只改这个目录**，不要再往 App.tsx 里堆：
 *   App.tsx 只负责 <BrowserPanel ws={browser} agentLabel={…} /> 挂载
 *   + 调 browser.openUrl / browser.stopDriving，并把当前智能体 id 传进来。
 *
 * 目录：
 *   types.ts                一张活页长什么样（含它属于哪个智能体 / 哪个项目）
 *   url.ts                  地址、分区名（**按项目** = 登录态粒度）、页数提示（含桌面侧协议闸）
 *   sites.ts                「打开百度」→ URL
 *   intent.ts               「在这张页面上做事 / 停 / 继续」的判定
 *   useBrowserWorkspace.ts  按智能体分桶的 tab 状态 + 开/关/切 + 驾驶接口（无上限）
 *   BrowserPanel.tsx        中栏那块 UI（tab + URL 栏 + 页宿主占位 div；真页面在主进程 WebContentsView 里，见 ADR-0002）
 *   styles.css              这块 UI 的样式（第 19 步只改这里）
 *
 * Phase 3 的两层粒度别混：
 *   - **登录态 / cookie / localStorage** → 按 **projectId**（同项目共享，跨项目隔离）；
 *   - **标签页 / 任务执行 / 暂停继续**   → 按 **agentId**（没变，绝不合并）。
 */

export { BrowserPanel } from './BrowserPanel';
export type { EmbedRect } from './BrowserPanel';
/** 第 27 步：人工介入求助卡片（AI 主动求助时嵌在聊天流里的那张） */
export { HelpCard } from './HelpCard';
export { useBrowserWorkspace } from './useBrowserWorkspace';
export type { BrowserWorkspace } from './useBrowserWorkspace';
export type { BrowserPageInfo, BrowserTabView } from './types';
export {
  HOME_URL,
  START_PAGE_HTML,
  detectOpenUrl,
  detectUnknownOpenTarget,
  isPureOpenCommand,
  isStartPage,
} from './sites';
export {
  CONFIRM_ASK_RE,
  CONTINUE_STRONG_RE,
  CONTINUE_WEAK_RE,
  detectBrowseIntent,
  detectStopIntent,
} from './intent';
export {
  ORPHAN_PARTITION,
  PROJECT_PARTITION_PREFIX,
  SOFT_TAB_HINT,
  hostLabel,
  isHttpUrl,
  partitionFor,
  projectIdFromPartition,
  sameSite,
  toHttpUrl,
} from './url';

export { ComputerVisibility, VISIBILITY_LEVELS, loadVisibility, saveVisibility, visibilityUrl, formatToolForVisibility } from './ComputerVisibility';
export type { ComputerVisibility as ComputerVisibilityLevel } from './ComputerVisibility';
