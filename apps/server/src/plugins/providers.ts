/**
 * 能力与连接 · **供应商抽象**（provider 抽象，2026-09-27）。
 *
 * 口径：能力（搜索 / 生成图片）与具体供应商解耦。
 *   · `searchProviderFor(config)` / `imageProviderFor(config)` 按 config 里的 `provider`
 *     字段挑具体实现；
 *   · 具体供应商**只从 config 读**（apiKey / baseUrl / model）——不读 env、不硬编码 key；
 *     「配置加密落本地」的另一半：config 由调用方从本地密文解出来再传进来。
 *   · `test()` 走**最轻的一次真调用**（搜索搜一个词 / 图片生成一张 256 小图），
 *     用来在设置抽屉里点「测试」时验证 key 是否可用。
 *
 * 本文件零 React 依赖、可单测；网络失败一律抛 `ProviderError`（带 code），
 * 调用方据此说人话，**绝不**把 key / 上游原文透传出去。
 */
import type { ChatSource } from '@ai-workbench/shared';
import { webSearch, isWebSearchConfigured, WebSearchError } from '../search/tavily';

/** 供应商级错误：code 给调用方判型，message 是人话（已脱敏，绝不带 key 片段） */
export class ProviderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

export interface SearchConfig {
  provider: 'tavily';
  apiKey: string;
  baseUrl?: string;
}

export interface SearchItem {
  title: string;
  url: string;
  content: string;
}

export interface SearchOutcome {
  ok: boolean;
  detail: string;
  error?: string;
  count: number;
  tookMs: number;
  sources: ChatSource[];
  items: SearchItem[];
}

export interface SearchProvider {
  search(query: string, opts?: { topic?: 'general' | 'news'; days?: number; maxResults?: number }): Promise<SearchOutcome>;
  test(): Promise<TestOutcome>;
}

export interface TestOutcome {
  ok: boolean;
  detail: string;
  error?: string;
}

function toSources(items: SearchItem[]): ChatSource[] {
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

/** Tavily 搜索供应商（复用 search/tavily.ts 的 webSearch，单一实现） */
function tavilySearchProvider(config: SearchConfig): SearchProvider {
  const cfg = {
    apiKey: String(config.apiKey ?? '').trim(),
    baseUrl: String(config.baseUrl ?? '').trim() || 'https://api.tavily.com',
  };
  return {
    async search(query, opts) {
      if (!isWebSearchConfigured(cfg)) {
        return { ok: false, detail: '未配置搜索密钥', error: 'not_configured', count: 0, tookMs: 0, sources: [], items: [] };
      }
      const q = String(query ?? '').trim();
      if (!q) return { ok: false, detail: '搜索词为空', error: 'bad_query', count: 0, tookMs: 0, sources: [], items: [] };
      const started = Date.now();
      try {
        const res = await webSearch(cfg, q, {
          topic: opts?.topic === 'news' ? 'news' : 'general',
          days: opts?.days,
          maxResults: opts?.maxResults ?? 5,
        });
        const items = (res.results ?? []).slice(0, 8).map((r) => ({
          title: String(r.title ?? '').slice(0, 200),
          url: String(r.url ?? '').slice(0, 500),
          content: String(r.content ?? '').slice(0, 500),
        }));
        return {
          ok: true,
          detail: `搜到 ${items.length} 条结果（${res.tookMs}ms）`,
          count: items.length,
          tookMs: Date.now() - started,
          sources: toSources(items),
          items,
        };
      } catch (err) {
        const code = err instanceof WebSearchError ? err.code : 'search_failed';
        return { ok: false, detail: '这次搜索没成功', error: code, count: 0, tookMs: Date.now() - started, sources: [], items: [] };
      }
    },
    async test() {
      const r = await this.search('天气', { maxResults: 1 });
      if (!r.ok) return { ok: false, detail: `测试失败：${r.error ?? '未知原因'}`, error: r.error };
      return { ok: true, detail: `连通正常（搜到 ${r.count} 条，${r.tookMs}ms）` };
    },
  };
}

export function searchProviderFor(config: SearchConfig): SearchProvider {
  // 当前只有 Tavily 一种搜索供应商；未来加别的按 config.provider 分派
  return tavilySearchProvider(config);
}

// ---------------------------------------------------------------------------
// 生成图片
// ---------------------------------------------------------------------------

export type ImageProviderKind = 'dashscope' | 'openai';

export interface ImageConfig {
  provider: ImageProviderKind;
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export interface ImageOutcome {
  ok: boolean;
  detail: string;
  error?: string;
  /** 图片字节（服务端已下载好，直接落盘；dashscope/openai 都补齐到这里） */
  bytes: Buffer | null;
  ext: 'png' | 'jpg' | 'jpeg';
  /** 上游原始地址（可选，便于排查；界面不直接用） */
  remoteUrl?: string;
  tookMs: number;
}

export interface ImageProvider {
  generateImage(prompt: string, opts?: { size?: string; testMode?: boolean }): Promise<ImageOutcome>;
  test(): Promise<TestOutcome>;
}

/** 下载一个 http(s) 图片到 Buffer（带超时 + 大小上限 12MB，防 OOM） */
async function fetchImageBytes(url: string, timeoutMs = 60_000): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new ProviderError('image_download_failed', `下载图片失败（HTTP ${res.status}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new ProviderError('image_download_failed', '下载到的图片是空的');
  if (buf.length > 12 * 1024 * 1024) throw new ProviderError('image_too_large', '图片超过 12MB，已拒绝落盘');
  return buf;
}

function extFromUrl(url: string, fallback: 'png' | 'jpg' | 'jpeg' = 'png'): 'png' | 'jpg' | 'jpeg' {
  const m = /\.(png|jpe?g)(\?|#|$)/i.exec(String(url ?? ''));
  if (!m) return fallback;
  return /jpe?g/i.test(m[0]) ? 'jpeg' : 'png';
}

/**
 * 通义万相（DashScope wanx）：异步任务（提交 → 轮询任务状态 → 拿结果 url → 下载）。
 * 这是默认图片供应商（与本项目 DeepSeek 一样偏国内、有免费额度、拿 key 简单）。
 */
function dashscopeImageProvider(config: ImageConfig): ImageProvider {
  const key = String(config.apiKey ?? '').trim();
  const base = String(config.baseUrl ?? '').trim().replace(/\/+$/, '') || 'https://dashscope.aliyuncs.com';
  const model = String(config.model ?? '').trim() || 'wanx-v1';
  const submitUrl = `${base}/api/v1/services/aigc/text2image/image-synthesis`;

  async function pollTask(taskId: string, deadlineMs: number): Promise<{ url: string | null; error?: string }> {
    while (Date.now() < deadlineMs) {
      await new Promise((r) => setTimeout(r, 2000));
      let res: Response;
      try {
        res = await fetch(`${base}/api/v1/tasks/${taskId}`, {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        return { url: null, error: `轮询任务出错：${(err as Error).message ?? String(err)}` };
      }
      if (!res.ok) return { url: null, error: `轮询任务 HTTP ${res.status}` };
      const obj = (await res.json().catch(() => ({}))) as { output?: { task_status?: string; results?: Array<{ url?: string }>; code?: string; message?: string } };
      const status = obj.output?.task_status;
      if (status === 'SUCCEEDED') {
        const url = obj.output?.results?.[0]?.url ?? null;
        return url ? { url } : { url: null, error: '任务成功但没拿到图片地址' };
      }
      if (status === 'FAILED' || status === 'UNKNOWN') {
        return { url: null, error: obj.output?.message ?? `任务状态 ${status}` };
      }
      // PENDING / RUNNING → 继续轮询
    }
    return { url: null, error: '生成图片超时（60 秒还没回来）' };
  }

  return {
    async generateImage(prompt, opts) {
      const p = String(prompt ?? '').trim();
      if (!p) return { ok: false, detail: '没有图片描述', error: 'bad_prompt', bytes: null, ext: 'png', tookMs: 0 };
      if (!key) return { ok: false, detail: '未配置图片密钥（DASHSCOPE_API_KEY）', error: 'not_configured', bytes: null, ext: 'png', tookMs: 0 };
      const started = Date.now();
      const size = opts?.size || (opts?.testMode ? '256*256' : '1024*1024');
      try {
        const submit = await fetch(submitUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
            'X-DashScope-Async': 'enable',
          },
          body: JSON.stringify({ model, input: { prompt: p.slice(0, 800) }, parameters: { size, n: 1 } }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!submit.ok) {
          const raw = (await submit.text().catch(() => '')).slice(0, 200);
          const code = submit.status === 401 || submit.status === 403 ? 'unauthorized' : 'upstream_error';
          return { ok: false, detail: `图片服务返回 HTTP ${submit.status}`, error: code, bytes: null, ext: 'png', tookMs: Date.now() - started };
        }
        const subObj = (await submit.json().catch(() => ({}))) as { output?: { task_id?: string; task_status?: string } };
        const taskId = subObj.output?.task_id;
        if (!taskId) return { ok: false, detail: '图片服务没返回任务号', error: 'bad_response', bytes: null, ext: 'png', tookMs: Date.now() - started };

        const polled = await pollTask(taskId, started + (opts?.testMode ? 30_000 : 60_000));
        if (!polled.url) {
          return { ok: false, detail: polled.error ?? '图片没生成出来', error: 'image_failed', bytes: null, ext: 'png', tookMs: Date.now() - started };
        }
        const bytes = await fetchImageBytes(polled.url);
        return {
          ok: true,
          detail: `图片已生成（${Math.round(bytes.length / 1024)}KB）`,
          bytes,
          ext: extFromUrl(polled.url, 'png'),
          remoteUrl: polled.url,
          tookMs: Date.now() - started,
        };
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        const code = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'image_failed';
        return { ok: false, detail: `图片生成出错：${(err as Error).message ?? String(err)}`, error: code, bytes: null, ext: 'png', tookMs: Date.now() - started };
      }
    },
    async test() {
      const r = await this.generateImage('a small red circle on white background, flat icon', { testMode: true });
      if (!r.ok) return { ok: false, detail: `测试失败：${r.error ?? r.detail}`, error: r.error };
      return { ok: true, detail: `连通正常（出一张测试小图，${r.tookMs}ms）` };
    },
  };
}

/** OpenAI DALL-E：同步（一次请求直接回 b64_json）。作为可切换的第二供应商 */
function openaiImageProvider(config: ImageConfig): ImageProvider {
  const key = String(config.apiKey ?? '').trim();
  const base = String(config.baseUrl ?? '').trim().replace(/\/+$/, '') || 'https://api.openai.com';
  const model = String(config.model ?? '').trim() || 'dall-e-3';
  const url = `${base}/v1/images/generations`;
  return {
    async generateImage(prompt, opts) {
      const p = String(prompt ?? '').trim();
      if (!p) return { ok: false, detail: '没有图片描述', error: 'bad_prompt', bytes: null, ext: 'png', tookMs: 0 };
      if (!key) return { ok: false, detail: '未配置图片密钥（OPENAI_API_KEY）', error: 'not_configured', bytes: null, ext: 'png', tookMs: 0 };
      const started = Date.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt: p.slice(0, 1000),
            n: 1,
            size: opts?.testMode ? '1024x1024' : '1024x1024',
            response_format: 'b64_json',
          }),
          signal: AbortSignal.timeout(90_000),
        });
        if (!res.ok) {
          const code = res.status === 401 || res.status === 403 ? 'unauthorized' : res.status === 429 ? 'rate_limited' : 'upstream_error';
          return { ok: false, detail: `图片服务返回 HTTP ${res.status}`, error: code, bytes: null, ext: 'png', tookMs: Date.now() - started };
        }
        const obj = (await res.json().catch(() => ({}))) as { data?: Array<{ b64_json?: string; url?: string }> };
        const item = obj.data?.[0];
        let bytes: Buffer | null = null;
        let remoteUrl: string | undefined;
        if (item?.b64_json) {
          bytes = Buffer.from(item.b64_json, 'base64');
        } else if (item?.url) {
          remoteUrl = item.url;
          bytes = await fetchImageBytes(item.url);
        }
        if (!bytes) return { ok: false, detail: '图片服务没返回图片数据', error: 'bad_response', bytes: null, ext: 'png', tookMs: Date.now() - started };
        return { ok: true, detail: `图片已生成（${Math.round(bytes.length / 1024)}KB）`, bytes, ext: 'png', remoteUrl, tookMs: Date.now() - started };
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        const code = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'image_failed';
        return { ok: false, detail: `图片生成出错：${(err as Error).message ?? String(err)}`, error: code, bytes: null, ext: 'png', tookMs: Date.now() - started };
      }
    },
    async test() {
      const r = await this.generateImage('a small red circle on white background, flat icon', { testMode: true });
      if (!r.ok) return { ok: false, detail: `测试失败：${r.error ?? r.detail}`, error: r.error };
      return { ok: true, detail: `连通正常（出一张测试小图，${r.tookMs}ms）` };
    },
  };
}

export function imageProviderFor(config: ImageConfig): ImageProvider {
  return config.provider === 'openai' ? openaiImageProvider(config) : dashscopeImageProvider(config);
}

/** 脱敏：任何要进日志/错误消息的字符串都过一道，防 key 意外泄漏 */
export function redactKey(text: string): string {
  return String(text ?? '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '***REDACTED***')
    .replace(/tvly-[A-Za-z0-9_-]{8,}/g, '***REDACTED***')
    .replace(/(sk-|tvly-|Bearer\s+)/gi, '$1***');
}
