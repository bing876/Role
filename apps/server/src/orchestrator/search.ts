/**
 * 多智能体编排 · `web_search` 的执行器 + 唯一定义的 re-export。
 *
 * 收口后：定义只有一份，活在 `search/toolDef.ts`（中立位置，聊天与编排都 import 它）。
 * 本文件只保留执行逻辑（runWebSearch / formatSearchForModel / executeWebSearchTool），
 * 定义本身从 toolDef.ts 导入并 re-export，保持旧 import 路径兼容。
 */
import { SENSITIVE_TARGET_RE, type ChatSource, type LoopToolResult } from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import { isWebSearchConfigured, webSearch, webSearchConfigFromEnv, WebSearchError } from '../search/tavily';
import {
  WEB_SEARCH_TOOL_DEFINITION,
  WEB_SEARCH_TOOL_NAME,
  WEB_SEARCH_MAX_ROUNDS,
  WEB_SEARCH_SERVER_TOOL as UNIFIED_TOOL,
} from '../search/toolDef';

// 唯一定义：re-export，保持旧路径可用
export { WEB_SEARCH_TOOL_NAME, WEB_SEARCH_MAX_ROUNDS, WEB_SEARCH_TOOL_DEFINITION };
export const WEB_SEARCH_SERVER_TOOL = WEB_SEARCH_TOOL_DEFINITION;
// 兼容：有些地方 import WEB_SEARCH_TOOL_DEFINITION
export const WEB_SEARCH_TOOL_DEFINITION_ALIAS = UNIFIED_TOOL;

export interface WebSearchRunInput {
  query: string;
  topic?: 'general' | 'news';
  days?: number;
  maxResults?: number;
}

/** 给模型看的搜索回执结构（进 tool 消息的那一段文字由 formatSearchForModel 生成） */
export interface WebSearchRunResult {
  ok: boolean;
  /** 人话一句（进 detail） */
  detail: string;
  error?: string;
  sources: ChatSource[];
  count: number;
  tookMs: number;
  /** 每条结果的摘要（进模型上下文用，不进界面） */
  items: Array<{ title: string; url: string; content: string }>;
}

function toSources(items: Array<{ title: string; url: string }>): ChatSource[] {
  return items.slice(0, 5).map((it) => {
    let domain = '';
    try {
      domain = new URL(it.url).host.replace(/^www\./i, '');
    } catch {
      domain = '';
    }
    return { title: String(it.title ?? '').slice(0, 200), url: String(it.url ?? '').slice(0, 500), domain };
  });
}

/**
 * 真的去搜一次。**唯一的执行入口**：服务端工具的 executor 与临时工的小循环都走它，
 * 所以「敏感闸 / 未配置降级 / 来源整形」只有一份实现。
 *
 * ★ 未配置 Tavily 时**不报错**、按「没有搜索结果」如实返回（`not_configured`）：
 *   临时工据此降级成纯推理，比整批失败有用得多。
 */
export async function runWebSearch(env: ServerEnv, input: WebSearchRunInput): Promise<WebSearchRunResult> {
  const query = String(input.query ?? '').trim().slice(0, 300);
  if (!query) return { ok: false, detail: '搜索词为空', error: 'bad_query', sources: [], count: 0, tookMs: 0, items: [] };
  // 纵深防御：调用方（validate）已经拦过一遍，这里再拦一次 —— 临时工那条路不经过 validate
  if (SENSITIVE_TARGET_RE.test(query)) {
    return { ok: false, detail: '敏感查询已拦截（未外发）', error: 'blocked_sensitive', sources: [], count: 0, tookMs: 0, items: [] };
  }
  const config = webSearchConfigFromEnv(env);
  if (!isWebSearchConfigured(config)) {
    return {
      ok: false,
      detail: '未配置联网搜索（TAVILY_API_KEY），这一格按「没有搜索结果」处理',
      error: 'not_configured',
      sources: [],
      count: 0,
      tookMs: 0,
      items: [],
    };
  }
  const started = Date.now();
  try {
    const res = await webSearch(config, query, {
      topic: input.topic === 'news' ? 'news' : 'general',
      days: input.days,
      maxResults: input.maxResults ?? 5,
    });
    const items = (res.results ?? []).slice(0, 8).map((r) => ({
      title: String(r.title ?? '').slice(0, 200),
      url: String(r.url ?? '').slice(0, 500),
      content: String(r.content ?? '').slice(0, 500),
    }));
    return {
      ok: true,
      detail: `搜到 ${items.length} 条结果（耗时 ${res.tookMs}ms）`,
      sources: toSources(items),
      count: items.length,
      tookMs: Date.now() - started,
      items,
    };
  } catch (err) {
    const code = err instanceof WebSearchError ? err.code : 'search_failed';
    // ★ 绝不把原始错误文本（可能含 key 片段 / 上游原文）透出去
    return {
      ok: false,
      detail: '这次搜索没成功',
      error: code,
      sources: [],
      count: 0,
      tookMs: Date.now() - started,
      items: [],
    };
  }
}

/** 搜索结果 → 给模型看的一段文字（临时工小循环的 tool 消息用它） */
export function formatSearchForModel(query: string, r: WebSearchRunResult): string {
  if (!r.ok) return `搜索「${query}」没有结果：${r.error ?? '未知原因'}。不要编造来源，如实说明没查到。`;
  const lines = [`搜索「${query}」的 ${r.count} 条结果：`];
  r.items.forEach((it, i) => {
    lines.push(`${i + 1}. ${it.title} — ${it.url}\n   ${it.content}`);
  });
  lines.push('（以上网址是真实来源，可以引用；不要编造没出现在这里的链接。）');
  return lines.join('\n');
}

/** 服务端工具的执行器出口（注册进 registry 的那个） */
export async function executeWebSearchTool(env: ServerEnv, args: Record<string, unknown>): Promise<LoopToolResult> {
  const r = await runWebSearch(env, {
    query: String(args.query ?? ''),
    topic: args.topic === 'news' ? 'news' : 'general',
    days: typeof args.days === 'number' ? args.days : undefined,
    maxResults: typeof args.max_results === 'number' ? args.max_results : 5,
  });
  if (!r.ok) return { ok: false, detail: r.detail, error: r.error, data: { sources: [], count: 0 } };
  return {
    ok: true,
    detail: r.detail,
    data: {
      count: r.count,
      tookMs: r.tookMs,
      sources: r.sources,
      // 摘要也进上下文：只给 detail 的话模型没法基于内容作答
      items: r.items.map((it) => ({ title: it.title, url: it.url, content: it.content })),
    },
  };
}
