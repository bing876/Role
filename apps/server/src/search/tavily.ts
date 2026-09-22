/**
 * 第 26 步：联网搜索（Tavily）——**轻量查资料**能力。
 *
 * ★★ 核心原则：本能力与「浏览器操作」是**两套完全独立、互不干扰的系统**。
 *
 *   联网搜索（本文件）：一次 HTTPS 请求就结束的查资料动作。
 *     不启动浏览器实例、不占用浏览器相关资源、不触发全屏浏览器、
 *     不出现浏览器后台小图标 —— 界面上**什么都看不见**，只有文字结果。
 *
 *   浏览器操作（**不在这里**）：用户主动点开、AI 真操作网页的重型能力。
 *     代码在桌面端 `apps/desktop/src/browser/**`（BrowserPanel / useBrowserWorkspace）
 *     与 `apps/desktop/electron/**`（主进程 webview 驾驶）。
 *     本文件**不 import、不引用、不修改**那条链路上的任何东西；
 *     反过来，那条链路也不感知本文件的存在。
 *
 * ★ 与模型解耦：本文件**零 import**，只做「问题 → 结果」。
 *   它不认识任何模型名 / 模型协议 / DeepSeek 专属逻辑，
 *   所以以后换成任何模型，这个搜索能力都照常可用。
 *
 * 明确不做：不做结果摘要（那是模型的事）、不做缓存、不做重试风暴、
 *          不在任何日志/错误消息里出现 key 明文。
 */

export type WebSearchTopic = 'general' | 'news';
export type WebSearchDepth = 'basic' | 'advanced';

/** 调用本能力所需的最小配置（结构类型，刻意不 import ServerEnv，保持零依赖） */
export interface WebSearchConfig {
  /** Tavily API key。空串 = 未配置，调用会被**本地拒绝**（不发出请求） */
  apiKey: string;
  /** 接口地址，默认 https://api.tavily.com */
  baseUrl: string;
  /** 单次请求超时，默认 15s */
  timeoutMs?: number;
}

/** 结构化类型：`ServerEnv` 天然满足它，不需要 import 也能传进来 */
export interface WebSearchEnvLike {
  tavilyApiKey?: string;
  tavilyBaseUrl?: string;
}

export interface WebSearchItem {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface WebSearchResponse {
  query: string;
  /** Tavily 自带的简短回答；没请求（includeAnswer=false）时不存在 */
  answer?: string;
  results: WebSearchItem[];
  /** 本次调用耗时（含网络） */
  tookMs: number;
}

export interface WebSearchOptions {
  topic?: WebSearchTopic;
  depth?: WebSearchDepth;
  /** 返回条数，夹到 1~20，默认 5 */
  maxResults?: number;
  /** 让 Tavily 顺带给一段简短回答，默认 false（摘要交给模型做） */
  includeAnswer?: boolean;
  /** 只要最近 N 天（仅 topic='news' 有效），夹到 1~30 */
  days?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type WebSearchErrorCode =
  /** 本地没配 key —— 已拒绝外呼 */
  | 'not_configured'
  /** 搜索词为空/非法 */
  | 'bad_query'
  /** key 无效或没权限（HTTP 401/403） */
  | 'unauthorized'
  /** 触发限流 / 配额用尽（HTTP 429 或 Tavily 的 432） */
  | 'rate_limited'
  /** 上游 5xx 或其它非 2xx */
  | 'upstream_error'
  /** 超时 */
  | 'timeout'
  /** 连不上（DNS/网络/TLS） */
  | 'network_error'
  /** 2xx 但响应不是预期结构 */
  | 'bad_response';

export class WebSearchError extends Error {
  readonly code: WebSearchErrorCode;
  readonly status?: number;

  constructor(code: WebSearchErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'WebSearchError';
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_BASE_URL = 'https://api.tavily.com';
const DEFAULT_TIMEOUT_MS = 15_000;

/** 兜底脱敏：任何要落日志/进错误消息的字符串都过一道，防止 key 意外泄漏 */
export function redactSecrets(text: string): string {
  return String(text ?? '').replace(/tvly-[A-Za-z0-9_-]{8,}/g, 'tvly-***REDACTED***');
}

/** 给人看的 key 描述（**只含前缀与长度，不含密钥本体**），用于自检输出 */
export function describeApiKey(apiKey: string): string {
  const k = String(apiKey ?? '');
  if (!k) return '(未配置)';
  const prefix = k.startsWith('tvly-') ? 'tvly-' : '(非 tvly- 前缀) ';
  return `${prefix}…(长度 ${k.length})`;
}

/** 从环境对象取配置；`ServerEnv` 直接可传 */
export function webSearchConfigFromEnv(env: WebSearchEnvLike): WebSearchConfig {
  return {
    apiKey: String(env?.tavilyApiKey ?? '').trim(),
    baseUrl: String(env?.tavilyBaseUrl ?? '').trim() || DEFAULT_BASE_URL,
  };
}

export function isWebSearchConfigured(config: WebSearchConfig): boolean {
  return Boolean(config?.apiKey);
}

function clamp(n: number, lo: number, hi: number, fallback: number): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 执行一次联网搜索。
 *
 * 失败一律抛 `WebSearchError`（带 `code`），调用方据此说人话。
 * 注意：**本地能判定的错误一定在本地拦掉**（未配置 / 空查询），
 * 绝不"发一个注定失败的请求再解释"。
 */
export async function webSearch(
  config: WebSearchConfig,
  query: string,
  opts: WebSearchOptions = {},
): Promise<WebSearchResponse> {
  const q = String(query ?? '').trim();
  if (!q) {
    throw new WebSearchError('bad_query', '搜索词为空，已拒绝外呼');
  }
  if (!config?.apiKey) {
    throw new WebSearchError(
      'not_configured',
      '未配置 TAVILY_API_KEY（apps/server/.env），已拒绝外呼',
    );
  }

  const topic: WebSearchTopic = opts.topic === 'news' ? 'news' : 'general';
  const body: Record<string, unknown> = {
    query: q,
    topic,
    search_depth: opts.depth === 'advanced' ? 'advanced' : 'basic',
    max_results: clamp(opts.maxResults ?? 5, 1, 20, 5),
    include_answer: Boolean(opts.includeAnswer),
  };
  if (topic === 'news' && opts.days != null) body.days = clamp(opts.days, 1, 30, 3);
  if (opts.includeDomains?.length) body.include_domains = opts.includeDomains;
  if (opts.excludeDomains?.length) body.exclude_domains = opts.excludeDomains;

  const url = `${String(config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/search`;
  const timeoutMs = clamp(opts.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, 120_000, DEFAULT_TIMEOUT_MS);
  const started = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        // ★ key 只走请求头：不进 body、不进日志、不进错误消息
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: opts.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new WebSearchError('timeout', `联网搜索超时（${timeoutMs}ms）`);
    }
    throw new WebSearchError(
      'network_error',
      `联网搜索连不上：${redactSecrets((err as Error)?.message ?? String(err))}`,
    );
  }

  const tookMs = Date.now() - started;

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    const detail = redactSecrets(raw).slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      throw new WebSearchError('unauthorized', `Tavily 拒绝该密钥（HTTP ${res.status}）：${detail}`, res.status);
    }
    if (res.status === 429 || res.status === 432) {
      throw new WebSearchError('rate_limited', `Tavily 限流/配额用尽（HTTP ${res.status}）：${detail}`, res.status);
    }
    throw new WebSearchError('upstream_error', `Tavily 返回 HTTP ${res.status}：${detail}`, res.status);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new WebSearchError('bad_response', 'Tavily 返回的不是合法 JSON', res.status);
  }

  const obj = json as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.results)) {
    throw new WebSearchError('bad_response', 'Tavily 响应缺少 results 数组', res.status);
  }

  const results: WebSearchItem[] = (obj.results as unknown[]).map((r) => {
    const it = (r ?? {}) as Record<string, unknown>;
    return {
      title: String(it.title ?? ''),
      url: String(it.url ?? ''),
      content: String(it.content ?? ''),
      score: Number(it.score ?? 0) || 0,
    };
  });

  const out: WebSearchResponse = {
    query: String(obj.query ?? q),
    results,
    tookMs,
  };
  if (typeof obj.answer === 'string' && obj.answer) out.answer = obj.answer;
  return out;
}
