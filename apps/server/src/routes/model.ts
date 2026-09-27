/** 真模型接入层 · 本账号设置/测试：GET/POST/DELETE /model/config + POST /model/test。
 * key 不回显、不记日志；只有本账号可读写；测试经同一个生产 llmFetch。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { JsonCipher } from '../crypto';
import type { ServerEnv } from '../env';
import { bearerFrom, verifyToken } from '../crypto';
import { llmFetch } from '../llm';
import { clearUserModelSetting, loadUserModelSetting, modelAvailableForUser, normalizeModelConfig, saveUserModelSetting, MODEL_DEFAULTS } from '../modelSettings';

/** 模型测试只检查小响应；恶意兼容端点不能用无限响应占满本机内存。 */
async function readLimited(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_000_000) throw new Error('模型响应过大');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return new TextDecoder().decode(Buffer.concat(parts));
}

export function registerModelRoutes(app: FastifyInstance, deps: { pool: Pool; cipher: JsonCipher; env: ServerEnv }): void {
  const { pool, cipher, env } = deps;
  const auth = (req: FastifyRequest) => {
    const token = bearerFrom(req.headers.authorization);
    return token ? verifyToken(token, env.jwtSecret) : null;
  };
  const error = (rep: FastifyReply, code: number, message: string) => rep.code(code).send({ error: message });
  app.get('/model/config', async (req, reply) => {
    const claims = auth(req);
    if (!claims) return error(reply, 401, '未登录或登录已过期');
    try {
      const saved = await loadUserModelSetting(pool, cipher, claims.sub);
      if (saved.kind === 'invalid') return { provider: 'deepseek', model: '', baseUrl: '', apiKeySet: false, apiKeyMasked: '', source: 'invalid' };
      if (saved.kind === 'configured') {
        const { provider, model, baseUrl } = saved.config;
        return { provider, model, baseUrl, apiKeySet: true, apiKeyMasked: '****', source: 'local' };
      }
      return {
        provider: 'deepseek', model: env.deepseekApiKey ? env.deepseekModel : MODEL_DEFAULTS.deepseek.model,
        baseUrl: env.deepseekApiKey ? env.deepseekBaseUrl : MODEL_DEFAULTS.deepseek.baseUrl,
        apiKeySet: Boolean(env.deepseekApiKey), apiKeyMasked: env.deepseekApiKey ? '****' : '',
        source: env.deepseekApiKey ? 'env' : 'none',
      };
    } catch { return error(reply, 503, '模型配置读不到（数据库可能未就绪）'); }
  });
  app.post('/model/config', async (req, reply) => {
    const claims = auth(req);
    if (!claims) return error(reply, 401, '未登录或登录已过期');
    const body = req.body as { provider?: unknown; apiKey?: unknown; baseUrl?: unknown; model?: unknown } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return error(reply, 400, '配置须为对象');
    for (const key of ['provider', 'apiKey', 'baseUrl', 'model'] as const) {
      if (body[key] !== undefined && typeof body[key] !== 'string') return error(reply, 400, `${key} 须为字符串`);
    }
    try {
      const old = await loadUserModelSetting(pool, cipher, claims.sub);
      const config = normalizeModelConfig(body as Record<string, unknown>, old.kind === 'configured' ? old.config : undefined);
      await saveUserModelSetting(pool, cipher, claims.sub, config);
      return { ok: true, provider: config.provider, model: config.model, baseUrl: config.baseUrl, apiKeySet: true, apiKeyMasked: '****', source: 'local' };
    } catch (err) {
      // 参数错误（Message 是本地校验结果，不是上游响应），库错误按通用 503 回，绝不回显密钥。
      const msg = (err as Error).message;
      if (/供应商|API Key|模型名|API 地址|自定义模型|加密配置/.test(msg)) return error(reply, 400, msg);
      return error(reply, 503, '模型配置保存失败（数据库或密钥不可用）');
    }
  });
  app.delete('/model/config', async (req, reply) => {
    const claims = auth(req);
    if (!claims) return error(reply, 401, '未登录或登录已过期');
    try { await clearUserModelSetting(pool, claims.sub); return { ok: true, source: env.deepseekApiKey ? 'env' : 'none' }; }
    catch { return error(reply, 503, '模型配置清空失败'); }
  });
  app.post('/model/test', async (req, reply) => {
    const claims = auth(req);
    if (!claims) return error(reply, 401, '未登录或登录已过期');
    try {
      if (!(await modelAvailableForUser(pool, cipher, claims.sub, env)))
        return error(reply, 400, '未配置可用模型或密文损坏，请先在设置里填 API Key');
      const saved = await loadUserModelSetting(pool, cipher, claims.sub);
      if (saved.kind === 'missing' && (env.deepseekApiKey === 'mock' || env.deepseekApiKey.startsWith('mock:')))
        return { ok: false, detail: '开发模拟 key 不是真模型，请在设置里配置真实 API Key 后再测' };
      const started = Date.now();
      const result = await llmFetch(env, [{ role: 'user', content: '只回复 OK' }], {
        tag: 'model/test', userId: claims.sub, timeoutMs: 15_000, temperature: 0, tools: [],
      });
      if (!result.ok) { await result.body?.cancel().catch(() => undefined); return { ok: false, detail: `上游返回 HTTP ${result.status}（检查模型/密钥/权限）` }; }
      const json = JSON.parse(await readLimited(result)) as { choices?: Array<{ message?: { content?: string } }> };
      const text = json.choices?.[0]?.message?.content;
      return { ok: typeof text === 'string', detail: typeof text === 'string' ? `模型连通正常（${Date.now() - started}ms）` : '模型没有回有效内容' };
    } catch { return { ok: false, detail: '模型连不上（检查网络、地址和密钥）' }; }
  });
}
