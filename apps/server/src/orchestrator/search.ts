/**
 * 多智能体编排 · `web_search` 作为**服务端工具**的定义 + 执行器。
 *
 * ★ 为什么要在这里再写一份定义，而不是直接用 `search/chatTool.ts` 的 `WEB_SEARCH_TOOL`：
 *   那一份是「聊天路径」的独立常量（`chatLoop.ts` 自己 `tools:[WEB_SEARCH_TOOL]` 喂模型、
 *   自己解析、自己执行），**没有**进 Tool Registry —— 阶段 0 只注册化了浏览器 6 工具 + stop。
 *   编排需要的是「能被 `serverToolRegistry` 注册、能被循环内联执行、有 validate 闸」的那一份。
 *
 *   ⚠️ 所以本项目现在有**两份** web_search 定义。这是有意的过渡状态，不是疏忽：
 *     · 聊天路径那份带一大段「什么时候不该用」的话术，是为闲聊场景实测调出来的；
 *     · 这份是给「有任务的执行体」（临时工 / 被委派方 / 浏览器循环）用的，话术更短。
 *   收口计划见 `docs/待办-编排-websearch双定义收口-20260923.md`（本批不做，避免同时动两条路）。
 *
 * 安全闸（与 R1 完全同一套，别在这里另立标准）：
 *   query 先过 `SENSITIVE_TARGET_RE` —— 命中就**拒绝执行、不外发、日志不记原文**。
 */
import { SENSITIVE_TARGET_RE, type ChatSource, type LoopToolResult, type ToolDefinition } from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import { isWebSearchConfigured, webSearch, webSearchConfigFromEnv, WebSearchError } from '../search/tavily';

/** 工具名与聊天路径保持同一个字符串（模型看到的是同一个工具） */
export const WEB_SEARCH_TOOL_NAME = 'web_search';

export const WEB_SEARCH_SERVER_TOOL: ToolDefinition = {
  name: WEB_SEARCH_TOOL_NAME,
  description: [
    '联网搜索公开资料，返回若干条结果（标题 / 网址）。',
    '【该用它】答案需要「此时此刻的外部信息」时：新闻时事、天气、行情比分、某公司近况、你训练数据里可能过期的信息。',
    '【不要用它】闲聊/写作/翻译/算术/写代码/解释通用概念；以及**用户点明了某个具体网站要你在那上面做事**的时候',
    '（「打开某站」「去某站搜」）—— 那属于浏览器操作，不是搜索。**绝不要**说「已打开 / 已为你打开」：这个工具不打开任何网页。',
    '【敏感信息】问题里含密码、验证码/短信码、银行卡号、身份证、支付信息时**不要调用**：本地安全规则会直接拦下这次调用。',
    '一次只提一个具体的 query；拿到结果后用简体中文讲结论，不要把一堆原始摘要倒出来。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '要搜索的问题或关键词，尽量具体' },
      topic: { type: 'string', enum: ['general', 'news'], description: '时事/新闻类用 news，其余 general（默认 general）' },
      days: { type: 'integer', description: '仅 topic=news 有效：只要最近 N 天（1~30）' },
      max_results: { type: 'integer', description: '要几条结果（1~20，默认 5）' },
    },
    required: ['query'],
  },
  side: 'server',
  kind: 'action',
  // Tavily 自己默认 15s 超时；这里给 20s 与浏览器工具同量级，别让一格卡住整条循环
  timeoutMs: 20_000,
  validate: (args) => {
    const query = typeof args.query === 'string' ? args.query.trim().slice(0, 300) : '';
    if (!query) {
      return { ok: false, reason: 'bad_args', question: '要搜什么没写清楚。给我一个具体的问题或关键词。' };
    }
    /**
     * R1 的闸：敏感 query **不外发**。
     * 注意话术里不重复原文（日志与回执都可能被留档）。
     */
    if (SENSITIVE_TARGET_RE.test(query)) {
      return {
        ok: false,
        reason: 'blocked_sensitive',
        question:
          '这次搜索的问题里含敏感信息（密码/验证码/银行卡/身份证/支付类），我没有发出去。' +
          '这类问题不能搜，请换个不带敏感信息的问法，或自己到官方渠道核对。',
      };
    }
    const topic = args.topic === 'news' ? 'news' : 'general';
    const days = Number.isFinite(Number(args.days)) ? Math.min(30, Math.max(1, Math.floor(Number(args.days)))) : undefined;
    const maxResults = Number.isFinite(Number(args.max_results))
      ? Math.min(20, Math.max(1, Math.floor(Number(args.max_results))))
      : 5;
    return { ok: true, args: { query, topic, ...(days ? { days } : {}), max_results: maxResults } };
  },
};

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
