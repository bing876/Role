/**
 * useSidebarColumn —— 批次 M-2'：第二列（侧栏）宽度的拖动与记忆。
 *
 * 规格（设计基准 workbench-ui 的 App.tsx splitter 逻辑，参数照搬）：
 * - 范围 [220, 360]，默认 250（与 design/01-tokens.css 的 --sb-w 默认值一致）；
 * - 拖动 = 直接跟手改宽度（startW + dx，任何 transition 都是缓动/拖泥带水 → 本列宽度本来就不挂 transition）；
 * - 记忆上次宽度到 localStorage('workbench:sb-w')（基准同款键名）；
 * - 双击分隔条复位 250。
 *
 * 与 useBrowserColumn（第四列）的关系：两套宽度各管各的列，互不引用、互不修改。
 * 铁律沿用：jsdom 里没有布局也没有 PointerEvent 捕获 —— 拖动算式只用 clientX 差值，
 * setPointerCapture 先做能力判断再调。
 */
import { useCallback, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

export const SB_MIN = 220;
export const SB_DEFAULT = 250;
export const SB_MAX = 360;
export const SB_STORAGE_KEY = 'workbench:sb-w';

const clamp = (w: number): number => Math.max(SB_MIN, Math.min(SB_MAX, Math.round(w)));

const persist = (w: number): void => {
  try { window.localStorage.setItem(SB_STORAGE_KEY, String(clamp(w))); } catch { /* 隐私模式等，忽略 */ }
};

export interface UseSidebarColumn {
  /** 当前宽度（px，始终在 [SB_MIN, SB_MAX]） */
  sbWidth: number;
  /** 正在拖动（.splitter.dragging 的引导线） */
  dragging: boolean;
  resetSbWidth: () => void;
  splitterDown: (e: ReactPointerEvent) => void;
  splitterMove: (e: ReactPointerEvent) => void;
  splitterUp: (e: ReactPointerEvent) => void;
}

export function useSidebarColumn(): UseSidebarColumn {
  const [sbWidth, setSbWidthRaw] = useState<number>(() => {
    try {
      const raw = window.localStorage.getItem(SB_STORAGE_KEY);
      if (raw) {
        const v = Number(raw);
        if (Number.isFinite(v) && v >= SB_MIN && v <= SB_MAX) return Math.round(v);
      }
    } catch { /* 忽略 */ }
    return SB_DEFAULT;
  });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startW: number; cur: number } | null>(null);

  const resetSbWidth = useCallback((): void => {
    setSbWidthRaw(SB_DEFAULT);
    persist(SB_DEFAULT);
  }, []);

  const splitterDown = useCallback((e: ReactPointerEvent): void => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: sbWidth, cur: sbWidth };
    setDragging(true);
    const el = e.currentTarget as Element;
    if (typeof el.setPointerCapture === 'function') {
      try { el.setPointerCapture(e.pointerId); } catch { /* jsdom 没有，忽略 */ }
    }
  }, [sbWidth]);

  const splitterMove = useCallback((e: ReactPointerEvent): void => {
    const d = dragRef.current;
    if (!d) return;
    const next = clamp(d.startW + (e.clientX - d.startX));
    d.cur = next;
    setSbWidthRaw(next);
  }, []);

  const splitterUp = useCallback((e: ReactPointerEvent): void => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    setDragging(false);
    const el = e.currentTarget as Element;
    if (typeof el.releasePointerCapture === 'function') {
      try { el.releasePointerCapture(e.pointerId); } catch { /* jsdom 没有，忽略 */ }
    }
    // ★ 持久化用 dragRef 里的实时夹取值,不用闭包里的 state ——
    // 四个指针事件可能在同一次 act/事件批里同步派发,那时重渲染还没发生,闭包里的 sbWidth 是旧值。
    persist(d.cur);
  }, []);

  return { sbWidth, dragging, resetSbWidth, splitterDown, splitterMove, splitterUp };
}
