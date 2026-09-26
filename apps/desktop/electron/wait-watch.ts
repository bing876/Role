/**
 * ADR-0003 · 浏览器深度 第一片:wait-for / watch 两个原语的**纯逻辑核心**。
 *
 * ★ 为什么单独一个模块、且不 import electron:
 *   这两个原语真正的「会不会坏」都在**控制流**(轮询/超时/事件订阅/摘除)和**注入到页面里
 *   的那段 JS**。把它们从 `driver.ts` 里抽成只依赖「一个 CDP send 函数 + 一个 CDP 事件源」
 *   两个结构型接口的纯模块,就能在 node / jsdom 里**直接驱动这份真码**做验收(见
 *   `scripts/verify/wait-watch-smoke.mts`),而 `driver.ts` 只留一层薄包装,把**真实的**
 *   `ensureAttached(wc)` debugger 接进来。生产与验收共用同一份 core,不是副本。
 *
 * 两个原语对应 GrokBot 的「电脑可教 / 可监听」:
 *   - `coreWaitFor` = 「可教」地基:等某元素/文本出现(带超时)再动手。
 *   - `coreWatch`   = 「可监听」地基:监听 DOM 变化,新内容出现即回调(push,真实时)。
 */

// ---------------------------------------------------------------------------
// 结构型接口:core 只认这两个面,不认 electron
// ---------------------------------------------------------------------------

/** 一条 CDP 命令。生产传 `ensureAttached(wc).sendCommand`(打过 8s 超时补丁)。 */
export interface CdpSend {
  (method: string, params?: unknown): Promise<unknown>;
}

/** Electron `Debugger` 的 CDP 事件签名:(event, method, params, sessionId)。 */
export type CdpMessageListener = (
  event: unknown,
  method: string,
  params: any,
  sessionId?: string,
) => void;

/** CDP 事件源。生产传 `ensureAttached(wc)` 返回的那个 `Electron.Debugger`。 */
export interface CdpEvents {
  on(event: 'message', listener: CdpMessageListener): unknown;
  off(event: 'message', listener: CdpMessageListener): unknown;
}

// ---------------------------------------------------------------------------
// wait-for:等元素 / 等文本出现(带超时)
// ---------------------------------------------------------------------------

export interface WaitForSpec {
  /** CSS 选择器(与 text 至少给一个)。 */
  selector?: string;
  /** 正文子串(textContent 命中即算出现)。 */
  text?: string;
  /** 超时毫秒;到点没等到就如实回 found=false(上限 300s,与驾驶 wait 一致)。 */
  timeoutMs: number;
  /** 轮询间隔毫秒(默认 100)。 */
  pollMs?: number;
}

export interface WaitForResult {
  /** 调用本身是否成功(形状合法即 true;found 是「等到没有」,两回事)。 */
  ok: boolean;
  /** 在超时前是否等到。 */
  found: boolean;
  /** 命中的方式(选择器优先)。 */
  how?: 'selector' | 'text';
  /** 实际花了多久(诊断用)。 */
  waitedMs: number;
  /** 形状不合法时的原因。 */
  error?: string;
}

const DEFAULT_POLL_MS = 100;
/** 与 driver 的 MAX_WAIT_SECONDS=300 对齐。 */
const MAX_WAIT_MS = 300_000;
const MIN_POLL_MS = 20;

const sleepLocal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 注入到页面里的「等没等到」谓词(自包含 IIFE)。
 *
 * ★ 选择器非法(抛错)**一律当没找到**(吞掉异常)—— 既不能当「找到」(假阳性,F1),
 *   也不能让一次坏选择器炸掉整个等待。
 * ★ 文本判定走 `document.body.textContent` 子串:SPA 里异步插进来的新内容,
 *   它的文本必然并入 body 的 textContent,子串命中即视为「出现了」。
 */
export const waitForPredicateJs = (selector: string | null, text: string | null): string => `(() => {
  const sel = ${JSON.stringify(selector)};
  const text = ${JSON.stringify(text)};
  let el = null;
  if (sel) {
    try { el = document.querySelector(sel); } catch (e) { el = null; }
  }
  if (el) return { found: true, how: 'selector' };
  if (text) {
    const root = document.body || document.documentElement;
    const t = root ? (root.textContent || '') : '';
    if (t.indexOf(text) !== -1) return { found: true, how: 'text' };
  }
  return { found: false };
})()`;

interface EvalEnvelope {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/** 跑一段 IIFE 表达式,取回可序列化值;页面侧异常抛成 Error(与 driver.evaluate 同口径)。 */
async function evalJson(send: CdpSend, expression: string): Promise<unknown> {
  const res = (await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
  })) as EvalEnvelope;
  if (res.exceptionDetails) {
    throw new Error(
      res.exceptionDetails.exception?.description ??
        res.exceptionDetails.text ??
        '页面脚本执行异常',
    );
  }
  return res.result?.value;
}

export interface CoreWaitForOpts {
  /** 注入 sleep(验收可换成确定性实现;默认真计时)。 */
  sleepFn?: (ms: number) => Promise<void>;
  /** 注入时钟(验收可换;默认 Date.now)。 */
  now?: () => number;
}

/**
 * 轮询等待元素/文本出现。
 *
 * ★ 为什么是**轮询**而不是「注入 Promise + awaitPromise」:driver 的 sendCommand 补丁对
 *   **每条** CDP 命令都强加 8s 超时,一个跨多秒的长 awaitPromise 会在 8s 被那条补丁杀掉。
 *   轮询的每次 evaluate 都是毫秒级短命令,天然绕开那条硬闸,且跨导航鲁棒(F4)。
 */
export async function coreWaitFor(
  send: CdpSend,
  spec: WaitForSpec,
  opts: CoreWaitForOpts = {},
): Promise<WaitForResult> {
  const sleepFn = opts.sleepFn ?? sleepLocal;
  const now = opts.now ?? (() => Date.now());

  const sel = typeof spec.selector === 'string' && spec.selector.trim() ? spec.selector : null;
  const text = typeof spec.text === 'string' && spec.text.trim() ? spec.text : null;
  if (!sel && !text) {
    return { ok: false, found: false, waitedMs: 0, error: 'wait-for 至少要给 selector 或 text 之一' };
  }

  const timeoutMs = Math.max(0, Math.min(Math.floor(Number(spec.timeoutMs) || 0), MAX_WAIT_MS));
  const pollMs = Math.max(MIN_POLL_MS, Math.floor(Number(spec.pollMs) || DEFAULT_POLL_MS));
  const expression = waitForPredicateJs(sel, text);

  const start = now();
  const deadline = start + timeoutMs;
  for (;;) {
    let val: unknown;
    try {
      val = await evalJson(send, expression);
    } catch {
      // F1:一次坏选择器 / 页面异常 = 这一轮没等到,继续轮询,绝不当「找到」、绝不炸。
      val = { found: false };
    }
    const v = (val ?? {}) as { found?: boolean; how?: string };
    if (v && v.found === true) {
      return {
        ok: true,
        found: true,
        how: v.how === 'text' ? 'text' : 'selector',
        waitedMs: now() - start,
      };
    }
    if (now() >= deadline) {
      return { ok: true, found: false, waitedMs: now() - start };
    }
    await sleepFn(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

// ---------------------------------------------------------------------------
// watch:监听 DOM 变化,新内容出现即回调(CDP Runtime.addBinding,push,真实时)
// ---------------------------------------------------------------------------

/** 页里生成的 binding 名(主进程据此过滤 bindingCalled)。 */
export const WATCH_BIND_NAME = '__wbWatchReport';

/** 一次 DOM 新内容事件(截断过,绝不让巨大 DOM 打爆 IPC)。 */
export interface WatchEvent {
  /** insert = 插入了新元素;text-change = 已有节点文本变了。 */
  label: 'insert' | 'text-change';
  /** 命中标签名(小写);文本变化时为被改节点的标签。 */
  tag: string | null;
  /** 新内容文本(≤500 字)。 */
  text: string;
  /** 新内容 outerHTML(≤1000 字);文本变化时为 null。 */
  html: string | null;
}

export interface WatchSpec {
  /** 建 binding / 挂 observer 失败时回调一次(不抛、不挂起调用方)。 */
  onSetupError?: (e: Error) => void;
}

export interface WatchHandle {
  /** 摘除:off('message') + 页内 disconnect + removeBinding(幂等)。 */
  stop(): void;
}

/**
 * 注入页内的 MutationObserver 安装脚本。
 *
 * ★ 先 `disconnect` 旧的再挂 —— 同一页重复 start = re-arm(F11),绝不留两个 observer 双发。
 * ★ 只报 nodeType===1(元素)的插入 + 文本变化;属性/重排之类不报(客服台要的是「新消息」,
 *   不是每一次 style 抖动)。
 * ★ 每条上报都 try/catch 兜住 —— 页里任何报错都不该把 observer 自己搞挂。
 */
export const WATCH_START_JS = `(() => {
  if (window.__wbWatch) { try { window.__wbWatch.disconnect(); } catch (e) {} }
  const report = (label, node) => {
    try {
      const p = {
        label: label,
        tag: node && node.tagName ? String(node.tagName).toLowerCase() : null,
        text: node && node.textContent ? String(node.textContent).slice(0, 500) : '',
        html: node && node.outerHTML ? String(node.outerHTML).slice(0, 1000) : null,
      };
      if (window.__wbWatchReport) window.__wbWatchReport(JSON.stringify(p));
    } catch (e) {}
  };
  const obs = new MutationObserver((muts) => {
    for (let i = 0; i < muts.length; i++) {
      const m = muts[i];
      if (m.type === 'childList') {
        for (let j = 0; j < m.addedNodes.length; j++) {
          const n = m.addedNodes[j];
          if (n && n.nodeType === 1) report('insert', n);
        }
      } else if (m.type === 'characterData') {
        report('text-change', m.target);
      }
    }
  });
  obs.observe(document.body || document.documentElement, {
    childList: true, subtree: true, characterData: true,
  });
  window.__wbWatch = obs;
  return { started: true };
})()`;

/** 页内卸载 observer 脚本(stop 用)。 */
export const WATCH_STOP_JS = `(() => {
  let stopped = false;
  if (window.__wbWatch) {
    try { window.__wbWatch.disconnect(); } catch (e) {}
    stopped = true;
    window.__wbWatch = null;
  }
  return { stopped };
})()`;

/**
 * 挂一个 DOM 监听。返回 handle,`stop()` 摘除。
 *
 * ★ 事件不丢的次序(F6/丢事件窗口):先 addBinding,再 `events.on('message')` 注册监听,
 *   **最后**才注入 observer —— 监听就绪之前 observer 还不存在,不可能有 bindingCalled 先到。
 * ★ 同一时刻一张页只该有一个监听;重复 start 由 coreWatch 的 removeBinding + 页内
 *   disconnect 保证 re-arm 语义。
 */
export function coreWatch(
  send: CdpSend,
  events: CdpEvents,
  onEvent: (e: WatchEvent) => void,
  spec: WatchSpec = {},
): WatchHandle {
  let stopped = false;

  const listener: CdpMessageListener = (_event, method, params) => {
    if (stopped) return;
    if (method !== 'Runtime.bindingCalled') return;
    if (!params || params.name !== WATCH_BIND_NAME) return;
    const raw = params.payload;
    if (typeof raw !== 'string') return;
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // F8:畸形 payload 吞掉,绝不炸主进程
    }
    if (!parsed || typeof parsed !== 'object') return;
    const label =
      parsed.label === 'insert' ? 'insert' : parsed.label === 'text-change' ? 'text-change' : null;
    if (!label) return;
    onEvent({
      label,
      tag: typeof parsed.tag === 'string' ? parsed.tag : null,
      text: typeof parsed.text === 'string' ? parsed.text : '',
      html: typeof parsed.html === 'string' ? parsed.html : null,
    });
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    try {
      events.off('message', listener);
    } catch {
      /* 已摘 / 未挂,忽略 */
    }
    // 页内卸载 + 摘 binding 都是 best-effort:页可能正在导航/已死,失败不影响主进程
    void send('Runtime.evaluate', { expression: WATCH_STOP_JS, returnByValue: true }).catch(() => {});
    void send('Runtime.removeBinding', { name: WATCH_BIND_NAME }).catch(() => {});
  };

  void (async () => {
    try {
      await send('Runtime.enable');
      // re-arm:先摘同名 binding(可能上次没清干净),再挂新的
      try {
        await send('Runtime.removeBinding', { name: WATCH_BIND_NAME });
      } catch {
        /* 第一次没有同名 binding,正常 */
      }
      await send('Runtime.addBinding', { name: WATCH_BIND_NAME });
      events.on('message', listener); // 监听先于 observer 就绪,堵住丢事件窗口
      await evalJson(send, WATCH_START_JS);
    } catch (e) {
      stop();
      try {
        spec.onSetupError?.(e instanceof Error ? e : new Error(String(e)));
      } catch {
        /* onSetupError 自己出错也不该炸主进程 */
      }
    }
  })();

  return { stop };
}
