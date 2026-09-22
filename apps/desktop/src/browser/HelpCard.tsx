import { useEffect, useRef } from 'react';
import type { EmbedRect } from './BrowserPanel';
import './styles.css';

/**
 * 第 27 步 · **人工介入求助卡片**（AI 主动求助）。
 *
 * 它做的事只有三件（★ 别扩，扩了就踩安全红线）：
 *   1. **展示**当前页面状态 —— 卡片中间那块区域是「窗口」，真正显示的是**同一张真实页面**；
 *   2. **提示**用户需要介入（验证码/滑块 或 登录墙）；
 *   3. **提供手动确认按钮**（我处理好了，继续 / 不用了，停手）。
 *
 * ★★ 安全红线（本步的核心约束，改这个文件前必须读）：
 *   这张卡里**绝对不能**出现任何输入框、任何"提交/确认"表单动作 ——
 *   一旦出现，就等于"应用替用户把验证码/密码写进页面"，
 *   那正是 `typeSensitiveGuard` / `sanitizeToolCall` 两道闸在防的事，
 *   只是把决策权从模型换成了用户，机制上仍然绕开了闸门。
 *   用户必须在**上面那块真实页面里**自己操作。
 *
 * ★ 为什么卡片只是"窗口"而不是"把页面搬进来"（影子层方案）：
 *   `<webview>` 一旦离开 DOM，guest 就销毁、wcId 会变，正在跑的那一路驾驶当场失联。
 *   所以这里的做法是：卡片只画一块**占位区**，把它的几何量出来交给 `BrowserPanel`，
 *   由那边把**原本就挂着的那个 webview** 挪过来盖在占位区上 —— 元素一动不动。
 */
export function HelpCard({
  helpKind,
  question,
  hint,
  onRect,
  onDone,
  onStop,
}: {
  helpKind: 'captcha' | 'login';
  question: string;
  hint: string;
  /** 把占位区的几何（相对舞台左上角）报上去；量不到时传 null */
  onRect: (rect: EmbedRect | null) => void;
  /** 「我处理好了，继续」——手动兜底恢复（与自动感知走同一条链路） */
  onDone: () => void;
  /** 「不用了，停手」——放弃这一路，把循环放掉 */
  onStop: () => void;
}) {
  const holderRef = useRef<HTMLDivElement | null>(null);

  /**
   * 几何跟随：每帧量一次占位区，变了才上报。
   *
   * 为什么用 rAF 而不是只听 scroll 事件：聊天区会滚、窗口会缩放、
   * 上面的消息还会因为流式打字而长高 —— 逐个挂监听总会漏一个，
   * 而"每帧比一次"是**永远不会漏**的（代价只是一次 getBoundingClientRect）。
   * 真正贵的是 setState，所以这里用 key 比对，**没变就不上报**。
   */
  useEffect(() => {
    let raf = 0;
    let lastKey = '';
    const tick = (): void => {
      raf = window.requestAnimationFrame(tick);
      const holder = holderRef.current;
      const stage = document.querySelector('.browserPanel__stage');
      if (!holder || !(stage instanceof HTMLElement)) return;
      const h = holder.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      const width = Math.round(h.width);
      const height = Math.round(h.height);
      /**
       * ★ 尺寸没量到就**什么都不报**（保持上一次的几何），绝不报 0×0 ——
       *   尺寸归零会让 CDP 驾驶的点击坐标全部失效（本模块顶部的红线）。
       */
      if (width < 2 || height < 2) return;
      const left = Math.round(h.left - s.left);
      const top = Math.round(h.top - s.top);
      // 占位区被滚出舞台可见范围时，把页面裁到可见的那一块（免得一张大页盖住聊天）
      const clip = `inset(${Math.max(0, Math.round(s.top - h.top))}px ${Math.max(
        0,
        Math.round(h.right - s.right),
      )}px ${Math.max(0, Math.round(h.bottom - s.bottom))}px ${Math.max(0, Math.round(s.left - h.left))}px)`;
      const key = `${left},${top},${width},${height},${clip}`;
      if (key === lastKey) return;
      lastKey = key;
      onRect({ left, top, width, height, clip });
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(raf);
      onRect(null);
    };
  }, [onRect]);

  /** 卡片一出现就把它带进视野 —— 否则用户在全屏浏览器里被切回聊天后还得自己找 */
  useEffect(() => {
    holderRef.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  return (
    <div className={`helpCard helpCard--${helpKind}`} role="alert">
      <div className="helpCard__head">
        <span className="helpCard__icon" aria-hidden="true">
          🤖
        </span>
        <span className="helpCard__title">AI 需要你帮一下</span>
        <span className="helpCard__who">AI 发起</span>
        <span className="helpCard__kind">{helpKind === 'captcha' ? '验证码 / 滑块' : '登录墙'}</span>
      </div>
      <div className="helpCard__body">{question}</div>
      <div className="helpCard__hint">{hint}</div>
      {/*
        这块就是"窗口"：真实页面会被盖在它上面（几何由上面那个 rAF 上报）。
        它自己**只是一个空 div** —— 没有 input、没有 form、没有任何可提交的东西。
      */}
      <div className="helpCard__stage" ref={holderRef}>
        <span className="helpCard__stageHint">正在把这一小块页面接进来…</span>
      </div>
      <div className="helpCard__foot">
        <button type="button" className="btn helpCard__done" onClick={onDone}>
          我处理好了，继续
        </button>
        <button type="button" className="btn helpCard__stop" onClick={onStop}>
          不用了，停手
        </button>
        <span className="small helpCard__note">页面就是这张，请直接在上面操作（AI 不会代填验证码/密码，也不会代点提交）</span>
      </div>
    </div>
  );
}
