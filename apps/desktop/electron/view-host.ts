/**
 * ADR-0002 · 页宿主：`<webview>` → 主进程托管的 WebContentsView。
 *
 * 分工（详见 docs/adr/0002-webview迁WebContentsView.md）：
 *   - 渲染层：只画占位 div（`.browserPanel__view`，与老 webview 同名同类），
 *     按它量出来的 rect 走 `view-rect` 通道；**第四列 UI 三态一个字节不动**；
 *   - 这里：页的**生命周期**（create / rect / order / close / navigate / focus）
 *     与**分区闸的唯一执行点**（create 是唯一建页口）。
 *
 * 坐标系：原生视图 setBounds 相对**窗口内容区**左上角；渲染层
 * `getBoundingClientRect` 相对视口左上角 —— 二者同一点（内容区即视口），
 * 所以 rect 直接透传、不需要偏移换算（F1）。
 *
 * 隐藏 ≠ 卸载：`setVisible(false)` 只是藏起来（视图仍附着、guest 照跑）；
 * 真正的卸载只有 `viewHostClose`（对应三条有意卸载路径：深休眠 / 关 tab / allTabs 归零）。
 */
import { WebContentsView, session, type BrowserWindow, type WebContents } from 'electron';

/** 分区名前缀（与渲染层 `browser/url.ts` 的 `PROJECT_PARTITION_PREFIX` 必须逐字一致）。 */
export const PROJECT_PARTITION_PREFIX = 'persist:workbench-browser-project-';

interface Entry {
  view: WebContentsView;
  wc: WebContents;
  wcId: number;
}

/** tabKey → 原生宿主 */
const entries = new Map<number, Entry>();

/**
 * 存活的原生页 wcId 集合 —— 驾驶层 `resolveTarget` 认「这是我们托管的内嵌页」的第二依据
 * （第一依据是 `wc.getType() === 'webview'`，回滚窗口内两条都在）。
 */
export const viewHostRegistry = new Set<number>();

export interface ViewHostDeps {
  /** 主窗口（视图挂在它的 contentView 下） */
  window: () => BrowserWindow | null;
  /** 分区闸（ADR-0002 第二片起唯一执行点；口径见 main.ts 分区闸注释） */
  decidePartition: (raw: string) => { partition: string; quarantined: boolean; reason?: string };
  /** 被闸改写/拦下时通知渲染层（那张页会落到兜底分区，页能开但没有任何项目登录态） */
  notifyBlocked: (info: { partition: string; reason?: string }) => void;
  /** guest 接线（与 webview 时期同一套：节流关 / 下载 / 弹窗 / 协议闸 / chrome 补丁 / pageinfo 推送） */
  wireGuest: (wc: WebContents) => void;
}

let deps: ViewHostDeps | null = null;

export function viewHostInit(d: ViewHostDeps): void {
  deps = d;
}

/** 这张 tabKey 的原生宿主在不在（冒烟/诊断用） */
export function viewHostWcIdOf(tabKey: number): number | null {
  const e = entries.get(tabKey);
  if (!e || e.wc.isDestroyed()) return null;
  return e.wcId;
}

/**
 * 创建一张页的原生宿主。
 *
 * ★ 分区闸在这里执行（F9）：**这里是唯一建页口**，渲染层给的是 projectId 而不是分区名，
 *   分区字符串由主进程拼 —— 渲染层被攻破也造不出自造分区名，
 *   判定规则（必须是本用户自己名下项目的分区，否则改写兜底 `-none`）与 will-attach 闸逐字一致。
 *
 * ★ 幂等：同一 tabKey 重复 create（React 重挂载 / 唤醒）直接回旧 wcId，不重复建视图。
 */
export function viewHostCreate(req: { tabKey: number; projectId: number | null; url: string }): { wcId: number } {
  const existing = entries.get(req.tabKey);
  if (existing && !existing.wc.isDestroyed()) return { wcId: existing.wcId };

  const win = deps?.window();
  if (!win || win.isDestroyed()) throw new Error('主窗口还没就绪，建不了页宿主');

  const raw = `${PROJECT_PARTITION_PREFIX}${req.projectId ?? 'none'}`;
  const d = deps!.decidePartition(raw);
  if (d.quarantined) {
    deps!.notifyBlocked({ partition: raw, reason: d.reason });
  }

  const view = new WebContentsView({
    webPreferences: {
      session: session.fromPartition(d.partition),
      // 与 webview 时期同口径：内嵌页后台不节流（隐藏时 JS 照跑，驾驶/任务不断）
      backgroundThrottling: false,
    },
  });

  // ★ F7：先**离屏 + 隐藏**创建 —— 等渲染层把真实 rect 送过来再落位显示，
  //   避免第一帧在窗口左上角闪一下。
  view.setBounds({ x: -10000, y: -10000, width: 100, height: 100 });
  view.setVisible(false);
  win.contentView.addChildView(view);

  const wc = view.webContents;
  deps!.wireGuest(wc);
  void wc.loadURL(req.url);

  const entry: Entry = { view, wc, wcId: wc.id };
  entries.set(req.tabKey, entry);
  viewHostRegistry.add(wc.id);
  wc.once('destroyed', () => {
    viewHostRegistry.delete(wc.id);
    // 只在「还是我」时注销 —— 深休眠唤醒会重开同一 tabKey，旧的 destroyed 晚到不能误删新的
    if (entries.get(req.tabKey)?.wc === wc) entries.delete(req.tabKey);
  });
  return { wcId: wc.id };
}

/**
 * 几何 + 可见性。rect 非法（缺/零尺寸）时**只改可见性**，不碰 bounds
 * （宁可沿用上一个真实尺寸，也不归零 —— 归零会让 CDP 驾驶坐标全废，老红线照旧）。
 */
export function viewHostRect(req: {
  tabKey: number;
  rect: { x: number; y: number; width: number; height: number };
  visible: boolean;
}): void {
  const e = entries.get(req.tabKey);
  if (!e || e.wc.isDestroyed()) return;
  const r = req.rect;
  if (r && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.width) && Number.isFinite(r.height) && r.width > 0 && r.height > 0) {
    e.view.setBounds({
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
  }
  e.view.setVisible(req.visible);
}

/** 挪到最上层（原生视图的 z 序 = contentView 的子序，重新 addChildView = 置顶）。 */
export function viewHostOrder(tabKey: number): void {
  const win = deps?.window();
  const e = entries.get(tabKey);
  if (!win || win.isDestroyed() || !e || e.wc.isDestroyed()) return;
  try {
    win.contentView.addChildView(e.view);
  } catch {
    /* 视图已不在树上（异常路径）：下次 create/rect 会自愈，不把它当事故 */
  }
}

/** URL 栏回车 / 同站改道（协议闸在 wireGuest 里兜底，这里只管导航）。 */
export function viewHostNavigate(req: { tabKey: number; url: string }): { ok: boolean; error?: string } {
  const e = entries.get(req.tabKey);
  if (!e || e.wc.isDestroyed()) return { ok: false, error: 'gone' };
  if (typeof req.url !== 'string' || req.url.length === 0) return { ok: false, error: 'bad url' };
  void e.wc.loadURL(req.url);
  return { ok: true };
}

/** 焦点交给这张页（原生视图没有 DOM focus，走 guest webContents）。 */
export function viewHostFocus(tabKey: number): void {
  const e = entries.get(tabKey);
  if (!e || e.wc.isDestroyed()) return;
  try {
    e.wc.focus();
  } catch {
    /* 焦点失败不影响驾驶，忽略 */
  }
}

/**
 * 销毁一张页的原生宿主（**唯一的原生侧卸载口**）。
 * 摘视图 → 注销登记 → graceful close（guest 走 'destroyed' 清 registry，见 create）。
 * 幂等：不存在 / 已销毁时是空操作。
 */
export function viewHostClose(tabKey: number): void {
  const win = deps?.window();
  const e = entries.get(tabKey);
  if (!e || e.wc.isDestroyed()) return;
  if (win && !win.isDestroyed()) {
    try {
      win.contentView.removeChildView(e.view);
    } catch {
      /* 同上：异常路径自愈 */
    }
  }
  entries.delete(tabKey);
  // graceful close：触发 'destroyed'，registry 由 create 里那条监听兜底清理
  try {
    void e.wc.close();
  } catch {
    /* 视图已死，registry 由 destroyed 监听兜底清理 */
  }
}

/** 主窗口关闭时全清（窗口没了，视图跟着死；这里只是别让 map/registry 挂着死引用）。 */
export function viewHostTeardown(): void {
  for (const [tabKey] of entries) viewHostClose(tabKey);
}
