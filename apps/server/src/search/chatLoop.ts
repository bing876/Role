/**
 * 第 26 步：聊天路径上的「搜索感知」工具循环。
 *
 * 层次（刻意分成三层，别揉在一起）：
 *   ① `tavily.ts`  —— 纯搜索客户端：**零 import**，不认识任何模型（与浏览器/模型都无交集）；
 *   ② 本文件      —— **适配层**：把"模型想查资料"这件事翻译成"调 ①"，再把结果喂回去；
 *   ③ `routes/chat.ts` —— 只负责把 ② 的增量写成 SSE。
 * 所以"换模型"只影响 ② 的调用方式，搜索能力本身（①）一行都不用改。
 *
 * ★ 与「浏览器操作」的关系：**没有关系**。本文件不 import 浏览器链路上的任何东西，
 *   也不给模型任何"能开页"的工具 —— 这里唯一的工具是 `web_search`。
 *   浏览器那套工具在 `toolLoop.ts`（"页面任务"那一条路），两条路互不干扰。
 *
 * ★ 不做关键词判定：模型说查就查、说不查就不查，本地不猜语义。
 *   例外（R1·2026-09-22）：安全闸不算"猜语义" —— query 命中与驾驶循环同一份
 *   SENSITIVE_TARGET_RE（密码/验证码/身份证/银行卡/支付…）时直接拦截、不外发。
 *
 * 循环形态（为什么要"流式 + 工具"而不是先问一轮再答一轮）：
 *   不搜索的那一轮只发**一次**模型请求（和原来完全一样，不多花钱、不多等）；
 *   只有当模型真的要求调工具时，才会多一轮请求把资料喂回去。
 */

import type { ChatSource } from '@ai-workbench/shared';
import { SENSITIVE_TARGET_RE } from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import { llmFetch, type LlmMessage, type LlmToolCall } from '../llm';
import { webSearch, webSearchConfigFromEnv, WebSearchError, redactSecrets, type WebSearchItem } from './tavily';
import { WEB_SEARCH_TOOL, WEB_SEARCH_TOOL_NAME, WEB_SEARCH_MAX_ROUNDS } from './chatTool';

/**
 * 一次搜索的留痕（给日志/测试看，也用来聚合界面上的来源标注）。
 * ★ `sources` 用的是 shared 里的 `ChatSource` —— 服务端与桌面**同一个类型名**，
 *   避免"两端字段名不一致 ⇒ 静默不生效"这个已经踩过的坑。
 */
export interface SearchTrace {
  query: string;
  results: number;
  tookMs: number;
  error?: string;
  /** 这一搜命中的网页（原始顺序，未去重） */
  sources: ChatSource[];
}

/** 从网址里取展示用域名（剥掉 www. / 端口 / 路径）。取不到就返回空串。 */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/** Tavily 命中的一条 → 界面来源（只留标题 + 网址 + 域名） */
function toChatSource(item: WebSearchItem): ChatSource {
  return {
    title: (item.title || '').trim() || domainOf(item.url) || item.url,
    url: item.url,
    domain: domainOf(item.url),
  };
}

/**
 * 把本轮所有搜索的来源**去重**（按网址）后按首次命中顺序拼起来。
 *
 * 为什么要去重：模型可能为同一个问题连搜两三轮，命中同一批站点；
 * 界面上重复列同一个网址是噪音。
 * 为什么保留首次顺序：先搜到的通常更贴近用户问题，排序对用户有信息量。
 */
export function collectSources(searches: SearchTrace[], max = 8): ChatSource[] {
  const seen = new Set<string>();
  const out: ChatSource[] = [];
  for (const s of searches) {
    for (const src of s.sources ?? []) {
      if (!src.url || seen.has(src.url)) continue;
      seen.add(src.url);
      out.push(src);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** 推给界面的搜索状态（桌面拿它显示「正在搜索：xxx」） */
export type SearchEvent =
  | { phase: 'start'; query: string }
  | { phase: 'done'; query: string; results: number; tookMs: number }
  | { phase: 'error'; query: string; message: string };

export interface ChatWithSearchOptions {
  /** 日志标签 */
  tag: string;
  /** 客户端断开就掐上游（沿用第 6 步的 AbortController） */
  signal: AbortSignal;
  /**
   * **第一轮**上游确认可用（HTTP 2xx）时回调一次，且在推任何正文之前。
   *
   * 存在的意义：让调用方保留第 6 步的行为 ——
   * 「连不上 / 上游非 2xx」时还没开 SSE，可以照旧回一个 JSON 人话错误；
   * 一旦这里被调用，调用方就劫持连接、写 SSE 头与 meta，之后的失败只能走 SSE error。
   */
  onUpstreamReady?: () => void;
  /** 正文增量（打字机） */
  onDelta: (delta: string) => void;
  /** 搜索状态变化（可选） */
  onSearch?: (e: SearchEvent) => void;
  /** 已经开流之后的错误（开流前抛异常，见 UpstreamHttpError） */
  onError?: (message: string) => void;
  /** 最多真搜几轮，默认 WEB_SEARCH_MAX_ROUNDS */
  maxSearchRounds?: number;
}

export interface ChatWithSearchResult {
  /** 助手全文（含搜索前的过渡句） */
  text: string;
  searches: SearchTrace[];
  /** 见到 [DONE] 才算 true —— 与第 6 步「半截不落库」同一口径 */
  upstreamDone: boolean;
}

/**
 * 第一轮模型请求就失败（HTTP 非 2xx / 连不上）时抛这个。
 * 调用方此时**还没开 SSE**，可以照旧回一个 JSON 人话错误（保持第 6 步的行为）。
 * 第二轮之后失败就只能走 SSE error 了（流已经开了）。
 */
export class UpstreamHttpError extends Error {
  readonly status: number;
  readonly brief: string;
  constructor(status: number, brief: string) {
    super(`模型服务返回 HTTP ${status}：${brief || '（无详情）'}`);
    this.name = 'UpstreamHttpError';
    this.status = status;
    this.brief = brief;
  }
}

/** 单条结果喂给模型的正文上限（防止一次把上下文撑爆） */
const PER_ITEM_CHARS = 900;
/** 整包结果喂给模型的总上限 */
const TOTAL_CHARS = 5000;

interface ToolCallAcc {
  id: string;
  name: string;
  args: string;
}

/**
 * 读一条流式响应：正文走 onDelta，工具调用按 index 累积（OpenAI 兼容的碎片格式）。
 * 返回本次响应的正文与是否见到 [DONE]。
 */
async function consumeStream(
  res: Response,
  onDelta: (d: string) => void,
  calls: Map<number, ToolCallAcc>,
): Promise<{ text: string; done: boolean }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let upstreamDone = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split(/\r?\n\r?\n/);
    buf = parts.pop() ?? '';
    for (const block of parts) {
      const dataLine = block.split(/\r?\n/).find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (payload === '[DONE]') {
        upstreamDone = true;
        continue;
      }
      let json: {
        choices?: { delta?: { content?: string; tool_calls?: unknown[] } }[];
        error?: { message?: string };
      };
      try {
        json = JSON.parse(payload);
      } catch (e) {
        throw new Error(`上游 SSE 帧解析失败：${(e as Error).message}`);
      }
      if (json.error?.message) throw new Error(json.error.message);
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        onDelta(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const raw of delta.tool_calls) {
          const tc = (raw ?? {}) as {
            index?: unknown;
            id?: unknown;
            function?: { name?: unknown; arguments?: unknown };
          };
          const idx = Number.isInteger(Number(tc.index)) ? Number(tc.index) : 0;
          const cur = calls.get(idx) ?? { id: '', name: '', args: '' };
          if (typeof tc.id === 'string' && tc.id) cur.id = tc.id;
          if (typeof tc.function?.name === 'string' && tc.function.name) cur.name = tc.function.name;
          if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments;
          calls.set(idx, cur);
        }
      }
    }
    if (upstreamDone) break;
  }
  return { text, done: upstreamDone };
}

/** 把搜索结果压成一段给模型看的文本（控制长度，且不带任何密钥） */
function toolResultPayload(query: string, results: WebSearchItem[]): string {
  let total = 0;
  const items: { title: string; url: string; content: string }[] = [];
  for (const r of results) {
    const content = r.content.length > PER_ITEM_CHARS ? `${r.content.slice(0, PER_ITEM_CHARS)}…` : r.content;
    if (total + content.length > TOTAL_CHARS && items.length > 0) break;
    total += content.length;
    items.push({ title: r.title, url: r.url, content });
  }
  return JSON.stringify({
    query,
    count: items.length,
    results: items,
    note: '以上是联网检索到的原始资料，可能不完整或过期；请综合判断后用系统当前语言作答，不要直接把摘要原样倒给用户。',
  });
}

/**
 * 跑一次「聊天 + 按需搜索」。
 *
 * 与 `routes/chat.ts` 的分工：本函数只管"拿到完整正文"，SSE 由调用方写。
 */
export async function streamChatWithSearch(
  env: ServerEnv,
  messages: LlmMessage[],
  opts: ChatWithSearchOptions,
): Promise<ChatWithSearchResult> {
  const maxRounds = opts.maxSearchRounds ?? WEB_SEARCH_MAX_ROUNDS;
  const msgs: LlmMessage[] = [...messages];
  const searches: SearchTrace[] = [];
  let text = '';

  for (let round = 0; ; round += 1) {
    /** 到顶了就**不许再调工具**，逼它用已有资料作答（是收敛，不是报错） */
    const forceAnswer = round > maxRounds;

    let res: Response;
    try {
      res = await llmFetch(env, msgs, {
        tag: forceAnswer ? `${opts.tag}/answer` : round === 0 ? opts.tag : `${opts.tag}/after-search${round}`,
        stream: true,
        signal: opts.signal,
        tools: [WEB_SEARCH_TOOL],
        toolChoice: forceAnswer ? 'none' : 'auto',
      });
    } catch (err) {
      if (round === 0) throw err; // 还没开流 → 调用方回 JSON 错误
      opts.onError?.(`模型服务连不上：${(err as Error).message}`);
      return { text, searches, upstreamDone: false };
    }

    if (!res.ok || !res.body) {
      const brief = (await res.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
      if (round === 0) throw new UpstreamHttpError(res.status, brief);
      opts.onError?.(`模型服务返回 HTTP ${res.status}：${brief || '（无详情）'}`);
      return { text, searches, upstreamDone: false };
    }

    // 第一轮确认可用 → 通知调用方开 SSE（此刻还没推过任何正文）
    if (round === 0) opts.onUpstreamReady?.();

    const calls = new Map<number, ToolCallAcc>();
    const r = await consumeStream(res, opts.onDelta, calls);
    text += r.text;
    if (!r.done) {
      // 半截不算成功（沿用第 6 步口径）
      opts.onError?.('上游在 [DONE] 前结束，回复只有半截');
      return { text, searches, upstreamDone: false };
    }

    const list = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
      .filter((c) => c.name);

    if (list.length === 0) {
      // 模型决定不查资料（或已经答完）→ 收工
      return { text, searches, upstreamDone: true };
    }

    // 把 assistant 的 tool_calls 原样回填，再逐条给 tool 结果（OpenAI 兼容协议要求）
    const toolCalls: LlmToolCall[] = list.map((c, i) => ({
      id: c.id || `call_${round}_${i}`,
      type: 'function',
      function: { name: c.name, arguments: c.args || '{}' },
    }));
    msgs.push({ role: 'assistant', content: r.text, tool_calls: toolCalls });

    for (let i = 0; i < list.length; i += 1) {
      const c = list[i];
      const callId = toolCalls[i].id;
      if (c.name !== WEB_SEARCH_TOOL_NAME) {
        // 只给了一个工具，理论上到不了这儿；真到了就如实回执，别静默吞掉
        msgs.push({
          role: 'tool',
          tool_call_id: callId,
          content: JSON.stringify({ error: `未知工具：${c.name}` }),
        });
        continue;
      }

      let query = '';
      try {
        const args = JSON.parse(c.args || '{}') as {
          query?: unknown;
          topic?: unknown;
          days?: unknown;
          max_results?: unknown;
        };
        query = typeof args.query === 'string' ? args.query.trim() : '';
      } catch {
        /* 参数坏了走下面「query 为空」的分支 */
      }
      if (!query) {
        msgs.push({
          role: 'tool',
          tool_call_id: callId,
          content: JSON.stringify({ error: '搜索参数不合法：缺少 query' }),
        });
        continue;
      }

      // R1（2026-09-22）：query 先过敏感闸 —— 与驾驶循环同一份 SENSITIVE_TARGET_RE。
      // 命中（密码/验证码/身份证/银行卡/支付…）→ 不外发、不记原文、不推"正在搜索"，
      // 直接回 tool 结果让模型向用户解释。误伤的纯知识问由模型引导换问法。
      if (SENSITIVE_TARGET_RE.test(query)) {
        console.log('[search] 已拦截敏感查询（未外发，未记原文）');
        searches.push({ query: '[已拦截·敏感查询]', results: 0, tookMs: 0, error: 'blocked_sensitive', sources: [] });
        msgs.push({
          role: 'tool',
          tool_call_id: callId,
          content: JSON.stringify({
            error: 'blocked_sensitive',
            note: '这次搜索被本地安全规则拦截了：问题里含有个人敏感信息（密码、验证码、身份证、银行卡、支付等），没有发往任何外部搜索服务。请直接告诉用户：这类问题不能用联网搜索查询，请他换个不带敏感信息的问法，或自己到官方渠道核对；不要编造答案。',
          }),
        });
        continue;
      }

      const started = Date.now();
      opts.onSearch?.({ phase: 'start', query });
      console.log(`[search] 模型要求联网搜索：${redactSecrets(query).slice(0, 80)}`);

      try {
        const args = JSON.parse(c.args || '{}') as {
          topic?: unknown;
          days?: unknown;
          max_results?: unknown;
        };
        const out = await webSearch(webSearchConfigFromEnv(env), query, {
          topic: args.topic === 'news' ? 'news' : 'general',
          days: typeof args.days === 'number' ? args.days : undefined,
          maxResults: typeof args.max_results === 'number' ? args.max_results : 5,
        });
        const tookMs = Date.now() - started;
        searches.push({ query, results: out.results.length, tookMs, sources: out.results.map(toChatSource) });
        opts.onSearch?.({ phase: 'done', query, results: out.results.length, tookMs });
        console.log(`[search] 完成：${out.results.length} 条 / ${tookMs}ms`);
        msgs.push({ role: 'tool', tool_call_id: callId, content: toolResultPayload(query, out.results) });
      } catch (err) {
        const code = err instanceof WebSearchError ? err.code : 'unknown';
        const message = redactSecrets((err as Error)?.message ?? String(err)).slice(0, 200);
        searches.push({ query, results: 0, tookMs: Date.now() - started, error: code, sources: [] });
        opts.onSearch?.({ phase: 'error', query, message });
        console.warn(`[search] 失败（${code}）：${message}`);
        /**
         * ★ 搜索失败**不掐掉这一轮**：把失败原因如实回给模型，让它决定怎么说。
         *   绝不能让"查不到"变成"编一个答案" —— 提示词里明确要求它如实告诉用户。
         */
        msgs.push({
          role: 'tool',
          tool_call_id: callId,
          content: JSON.stringify({
            error: code,
            message,
            note: '联网搜索没有成功。请如实告诉用户这次没查到，不要编造结果；如果问题凭常识也能答，就直接答。',
          }),
        });
      }
    }
    // 继续下一轮：模型看到资料后作答（若又要求搜索，最多到 maxRounds 次）
  }
}
