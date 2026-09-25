import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, PointerEvent as ReactPointerEvent } from 'react';

/**
 * 批次 M-2 · 第四列(浏览器区)—— 用户 2026-09-25 定稿规格的状态与交互。
 *
 * 三形态(层元素**永不卸载**,`allTabs` 归零才卸载,那是 M0 文档化的有意路径①):
 *   · hidden  —— 用 transform 移出视野(绝不 display:none / 绝不尺寸归零:
 *                驾驶点击坐标依赖 webview 的真实几何,归零坐标全废);
 *   · column  —— 第四列,与聊天并排(聊天列让出 margin-right = 列宽);
 *   · overlay —— 盖聊天(可拖到全宽);列宽**过阈值**自动进 overlay。
 *
 * 触发(隐藏 → 第四列):① 点会话内链接/HTML 卡片;② 点「启用」按钮。
 *   两处调用方都走 `openColumn()`,本 hook 不关心谁点的。
 *
 * 伸缩:左缘拖动 —— 向左连续拖宽、过阈值变覆盖;向右收回。
 *   带滑动动画(宽度/位移 CSS transition,拖动时关掉 1:1 跟手);
 *   宽度**记忆上次值**(localStorage,用户定稿)。
 *
 * 为什么是 app/ 层的独立 hook(不塞进 browser/、不进 feature):
 *   `browser/` 一行不动(它的 view 三态 fullscreen/background/embed 是**它内部**的,
 *   本 hook 只在外壳侧加「列开没开 / 多宽」);feature 之间不许横切。
 *   调用点 = App 一处(与 useBrowserGlue 同一规矩,R2 门禁会守)。
 */

/** 列宽下限(px):再窄 tab 条与 URL 栏会挤爆 */
export const BROWSER_COL_MIN = 320;
/** 默认列宽(px):首次打开(没有记忆值)用这个 */
export const BROWSER_COL_DEFAULT = 420;
/** 记忆键(localStorage):用户定稿「记忆上次宽度(存本地)」 */
export const BROWSER_COL_STORAGE_KEY = 'workbench.browserCol';

export type BrowserColMode = 'hidden' | 'column' | 'overlay';

/**
 * 阈值(纯函数,可测):列宽 ≥ 阈值 → 覆盖态(盖聊天)。
 * 60% 帧宽,最低 480px —— 聊天至少要留得下能读的气泡;
 * jsdom 里帧宽为 0 → 恒 480(验收网里拖动 420→640 恰好过线,真实拖动语义一致)。
 */
export function overlayThresholdPx(frameWidth: number): number {
  return Math.max(480, Math.round(frameWidth * 0.6));
}

export interface BrowserColumnApi {
  /** 列是否打开(false = hidden 形态) */
  colOpen: boolean;
  /** 当前形态(派生:colOpen × 宽度 × 阈值) */
  colMode: BrowserColMode;
  /** 当前列宽(px,已夹在 [MIN, max(640, 帧宽)] —— 可拖到全宽) */
  colWidth: number;
  /** 正在拖(拖动时关 transition,1:1 跟手) */
  dragging: boolean;
  /** 挂在 div.app(帧根)上量帧宽 —— 阈值/上限都按它算 */
  frameRef: MutableRefObject<HTMLDivElement | null>;
  /** 帧根类名:column 态时聊天列要让位 → 挂 app--col */
  appClass: string;
  /** 浏览器层的类串(非 embed 态;embed 态由 App 按 browser.view 自己拼) */
  layerClass: string;
  /** 隐藏 → 第四列(记忆宽度)。触发 ①② 都调它 */
  openColumn: () => void;
  /** 第四列/覆盖 → 隐藏(transform 移出视野,不卸载) */
  hideColumn: () => void;
  /** 设列宽(夹取后)。拖动内部也走它 */
  setColWidth: (px: number) => void;
  /** 左缘拖动三件套(挂 .browserCol__resizer) */
  onResizerPointerDown: (e: ReactPointerEvent) => void;
  onResizerPointerMove: (e: ReactPointerEvent) => void;
  onResizerPointerUp: (e: ReactPointerEvent) => void;
}

export function useBrowserColumn(): BrowserColumnApi {
  const [colOpen, setColOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [colWidth, setColWidthState] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(BROWSER_COL_STORAGE_KEY);
      const v = raw === null ? NaN : Number(raw);
      return Number.isFinite(v) && v >= BROWSER_COL_MIN ? v : BROWSER_COL_DEFAULT;
    } catch {
      return BROWSER_COL_DEFAULT;
    }
  });

  const frameRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const colWidthRef = useRef(colWidth);
  colWidthRef.current = colWidth;

  // 记忆上次宽度(每次变化都落,含拖动过程 —— 断了电/关了窗也是最后那个宽)
  useEffect(() => {
    try {
      localStorage.setItem(BROWSER_COL_STORAGE_KEY, String(colWidth));
    } catch {
      /* localStorage 不可用(隐私模式等)—— 记忆丢了不挡用 */
    }
  }, [colWidth]);

  const frameWidth = frameRef.current?.clientWidth ?? 0;
  const colMode: BrowserColMode = !colOpen
    ? 'hidden'
    : colWidth >= overlayThresholdPx(frameWidth)
      ? 'overlay'
      : 'column';

  const setColWidth = useCallback((px: number) => {
    const max = Math.max(640, frameRef.current?.clientWidth ?? 0); // 上限 = 全宽
    setColWidthState(Math.max(BROWSER_COL_MIN, Math.min(max, Math.round(px))));
  }, []);

  const openColumn = useCallback(() => setColOpen(true), []);
  const hideColumn = useCallback(() => setColOpen(false), []);

  const onResizerPointerDown = useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    // jsdom（验收网）没实现 setPointerCapture —— 能力判断只为让验收网能走真实拖动路径
    if (typeof el.setPointerCapture === 'function') el.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startW: colWidthRef.current };
    setDragging(true);
  }, []);

  const onResizerPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!dragRef.current) return;
      // 向左拖(dx 负)变宽,向右拖收回 —— 用户定稿
      setColWidth(dragRef.current.startW + (dragRef.current.startX - e.clientX));
    },
    [setColWidth],
  );

  const onResizerPointerUp = useCallback((e: ReactPointerEvent) => {
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* capture 可能早已释放 */
    }
    setDragging(false);
  }, []);

  const appClass = colMode === 'column' ? 'app app--col' : 'app';
  const layerClass = !colOpen
    ? 'browserLayer browserLayer--hidden'
    : 'browserLayer' +
      (colMode === 'overlay' ? ' browserLayer--overlay' : '') +
      (dragging ? ' browserLayer--dragging' : '');

  return {
    colOpen,
    colMode,
    colWidth,
    dragging,
    frameRef,
    appClass,
    layerClass,
    openColumn,
    hideColumn,
    setColWidth,
    onResizerPointerDown,
    onResizerPointerMove,
    onResizerPointerUp,
  };
}
