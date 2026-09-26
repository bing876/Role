/**
 * ADR-0004 · 浏览器深度 第二片:稳健元素定位(语义定位层)的**纯逻辑核心**。
 *
 * ★ 为什么单独一个模块、不 import electron(与 wait-watch.ts 同一纪律):
 *   「抗不抗改版」的真相全在**解析 JS**(在页面里怎么按语义找到那颗元素)。**单一真源**
 *   `SEMANTIC_RESOLVE_BODY` 生成注入脚本;生产(`driver.ts`)与验收(`semantic-locate-smoke.mts`,
 *   Node `vm` 真跑)共用同一段,不是副本。
 *
 * 两级解析(都只认**可见**元素):
 *   ① 稳定属性(最抗改版):id → data-testid → aria-label → name;
 *   ② 文本 + tag + 结构:在 within(可选祖先选择器)里按 tag(可选)选候选,按可见文本包含过滤。
 * 全是**抗改版**维度(没有 class)—— 站点换 class / 调顺序后,同一语义目标照样解析到同一颗。
 *
 * 边界(已知):本片只**主文档**解析;穿透 shadow/iframe 的语义定位留后续片(老 find 路径
 * 照旧覆盖非语义 target 的穿透)。全程 try/catch:换页途中 document 可能为 null,绝不抛(F9)。
 */
import type { SemanticLocateResult, SemanticTarget } from '@ai-workbench/shared';

// ---------------------------------------------------------------------------
// 页面侧解析函数体(单一真源)。用法:
//   const r = (function(){ ${SEMANTIC_RESOLVE_BODY} })();   // r = { el, via, description }
// 依赖外层 SEM(内联的 SemanticTarget)与 window/document(页面环境)。
// ---------------------------------------------------------------------------
const SEMANTIC_RESOLVE_BODY = `
  const T = (typeof SEM !== 'undefined' ? SEM : null) || {};
  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const lower = (s) => norm(s).toLowerCase();
  const textOf = (el) => {
    if (!el) return '';
    let raw = '';
    try { raw = el.innerText || el.textContent || ''; } catch (e) {}
    if (!raw) { try { if (el.tagName === 'INPUT' || el.tagName === 'BUTTON') raw = el.value || ''; } catch (e) {} }
    if (!raw) { try { raw = el.getAttribute('aria-label') || el.getAttribute('placeholder') || ''; } catch (e) {} }
    return lower(raw);
  };
  const isVis = (el) => {
    if (!el) return false;
    let r; try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (!r || r.width <= 0 || r.height <= 0) return false;
    let s; try { s = getComputedStyle(el); } catch (e) { return false; }
    return !!s && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  };
  const esc = (v) => {
    try { return (window.CSS && window.CSS.escape) ? window.CSS.escape(String(v)) : String(v); }
    catch (e) { return String(v); }
  };
  const firstVis = (sel) => {
    let list = null;
    try { list = document.querySelectorAll(sel); } catch (e) { return null; }
    for (let i = 0; i < list.length; i++) { if (isVis(list[i])) return list[i]; }
    return null;
  };
  // ---- ① 稳定属性(最抗改版;F4:优先于文本)----
  if (T.id) { const el = firstVis('#' + esc(T.id)); if (el) return { el, via: 'id', description: 'id=' + T.id }; }
  if (T.testId) { const el = firstVis('[data-testid="' + esc(T.testId) + '"]'); if (el) return { el, via: 'testid', description: 'data-testid=' + T.testId }; }
  if (T.ariaLabel) { const el = firstVis('[aria-label="' + esc(T.ariaLabel) + '"]'); if (el) return { el, via: 'aria', description: 'aria-label="' + T.ariaLabel + '"' }; }
  if (T.name) { const el = firstVis('[name="' + esc(T.name) + '"]'); if (el) return { el, via: 'name', description: 'name=' + T.name }; }
  // ---- ② 文本 + tag + 结构(兜底;F5)----
  const wantText = lower(T.text);
  const wantTag = T.tag ? norm(T.tag).toUpperCase() : '';
  // 完全空目标(text/tag/within 全空、且稳定属性也没给)→ notfound,绝不「匹配一切」(F12/F5 防御)
  if (!wantText && !wantTag && !T.within) return { el: null, via: 'none', description: '' };
  let scopes = [document];
  if (T.within) { try { const w = document.querySelectorAll(T.within); if (w.length) scopes = Array.prototype.slice.call(w); } catch (e) { scopes = [document]; } }
  const SELECTABLE = 'button, a, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [contenteditable="true"]';
  const cands = [];
  for (let si = 0; si < scopes.length; si++) {
    let nodes = null;
    try { nodes = scopes[si].querySelectorAll(wantTag || SELECTABLE); } catch (e) { nodes = null; }
    if (!nodes) continue;
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!isVis(el)) continue;
      if (!wantText || textOf(el).indexOf(wantText) >= 0) cands.push(el);
    }
  }
  if (cands.length) {
    // 多个候选:文本最贴合的优先(完全相等 > 前缀 > 包含)
    const score = (el) => { const t = textOf(el); if (!wantText) return 0; if (t === wantText) return 2; if (t.indexOf(wantText) === 0) return 1; return 0; };
    cands.sort((a, b) => score(b) - score(a));
    const via = (wantTag && T.within) ? 'text+tag+within' : (T.within ? 'text+within' : (wantTag ? 'text+tag' : 'text'));
    const desc = 'text~"' + (T.text || '') + '"' + (wantTag ? ' <' + wantTag.toLowerCase() + '>' : '') + (T.within ? ' within ' + T.within : '');
    return { el: cands[0], via, description: desc };
  }
  return { el: null, via: 'none', description: '' };
`;

/**
 * 返回一段「在页面里执行、解析语义目标」的**表达式字符串**(自包含,不依赖 __wbHelper)。
 * 求值结果 = `{ el, via, description }`(el 是解析出的元素或 null)。
 * 用法:`const r = ${semanticResolveExpr(JSON.stringify(target))};`
 */
export const semanticResolveExpr = (semJson: string): string =>
  `((() => { const SEM = ${semJson}; return (function(){\n${SEMANTIC_RESOLVE_BODY}\n  })(); })())`;

/**
 * 独立定位脚本(先解析、拿坐标/描述,不操作)。求值结果 = SemanticLocateResult 形状。
 * 供 driver 的 type 预解析 / 诊断 / 验收直接驱动。
 */
export const semanticLocateJs = (target: SemanticTarget): string =>
  `(() => {
    const r = ${semanticResolveExpr(JSON.stringify(target))};
    if (!r.el) return { found: false, via: 'none', description: '', label: '', cx: null, cy: null, w: 0, h: 0 };
    const el = r.el;
    let rect = { left: 0, top: 0, width: 0, height: 0 };
    try { const q = el.getBoundingClientRect(); if (q) rect = q; } catch (e) {}
    let label = '';
    try { label = String(el.innerText || el.textContent || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 60); } catch (e) {}
    return {
      found: true, via: r.via, description: r.description, label,
      cx: Math.round(rect.left + rect.width / 2), cy: Math.round(rect.top + rect.height / 2),
      w: rect.width, h: rect.height,
    };
  })()`;

/** 一条 CDP 命令(生产传 `ensureAttached(wc).sendCommand`)。 */
export interface CdpSend {
  (method: string, params?: unknown): Promise<unknown>;
}

interface EvalEnvelope {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/**
 * 驱动一次语义定位(真 CDP)。页面侧异常**不抛**,如实回 notfound + error(F9)。
 */
export async function coreSemanticLocate(send: CdpSend, target: SemanticTarget): Promise<SemanticLocateResult> {
  const res = (await send('Runtime.evaluate', {
    expression: semanticLocateJs(target),
    returnByValue: true,
    awaitPromise: false,
  })) as EvalEnvelope;
  if (res.exceptionDetails) {
    return {
      found: false,
      via: 'none',
      description: '',
      label: '',
      cx: null,
      cy: null,
      w: 0,
      h: 0,
      error: res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? '页面解析异常',
    };
  }
  const v = (res.result?.value ?? {}) as Partial<SemanticLocateResult>;
  return {
    found: v.found === true,
    via: (v.via as SemanticLocateResult['via']) ?? 'none',
    description: typeof v.description === 'string' ? v.description : '',
    label: typeof v.label === 'string' ? v.label : '',
    cx: typeof v.cx === 'number' ? v.cx : null,
    cy: typeof v.cy === 'number' ? v.cy : null,
    w: typeof v.w === 'number' ? v.w : 0,
    h: typeof v.h === 'number' ? v.h : 0,
    error: typeof v.error === 'string' ? v.error : undefined,
  };
}
