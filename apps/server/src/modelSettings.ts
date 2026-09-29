/** 真模型接入层 · 每用户模型配置（复用 plugin_configs 中 plugin_id=model 的密文行）。
 * 没行 → 保留旧环境变量 DeepSeek 路由；有行但解不开 → 拒绝，不回落共享 env key。
 * 解密结果只活在请求栈内：不缓存任何用户的明文 API key。
 */
import type { Pool } from 'pg';
import type { JsonCipher } from './crypto';
import type { ServerEnv } from './env';
import { validateMcpEndpoint } from './plugins/mcp';
import { MODEL_PROVIDER_DEFAULTS } from '@ai-workbench/shared';

export type ModelProvider = 'deepseek' | 'openai' | 'custom';
export interface UserModelConfig {
  provider: ModelProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
}
export type ModelSetting = { kind: 'missing' } | { kind: 'invalid' } | { kind: 'configured'; config: UserModelConfig };
/** 新保存的 DeepSeek 默认名取自 2026-09 官方模型列表；旧 env DEEPSEEK_MODEL 保持兼容。 */
export const MODEL_DEFAULTS = MODEL_PROVIDER_DEFAULTS;
const MODEL_ID = 'model';

/** 更换供应商或 API 地址必须同时提供新 key，不能把上一家 key 悄悄发给新的端点。 */
export function normalizeModelConfig(input: Record<string, unknown>, previous?: UserModelConfig): UserModelConfig {
  const provider = input.provider ?? previous?.provider ?? 'deepseek';
  if (provider !== 'deepseek' && provider !== 'openai' && provider !== 'custom')
    throw Error('供应商须为 deepseek/openai/custom');
  const def = provider === 'custom' ? { model: '', baseUrl: '' } : MODEL_DEFAULTS[provider];
  const unchangedProvider = previous?.provider === provider;
  const model = String(input.model ?? (unchangedProvider ? previous.model : def.model)).trim();
  const baseUrl = String(input.baseUrl ?? (unchangedProvider ? previous.baseUrl : def.baseUrl)).trim();
  if (!/^[a-zA-Z0-9._:/-]{1,100}$/.test(model)) throw Error('模型名格式不正确（1–100 个安全字符）');
  if (!baseUrl) throw Error('自定义模型必须填 HTTPS API 地址');
  try { validateMcpEndpoint(baseUrl); }
  catch { throw Error('模型 API 地址须为 HTTPS（本机回环可 HTTP），不含 URL 密码/查询参数'); }
  const supplied = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  // 不接受把遮罩原样存成密钥，也不接受生产用户填写 mock 触发测试分支伪答。
  if (supplied === '****' || supplied === 'mock' || supplied.startsWith('mock:')) throw Error('请填真实 API Key，不接受遮罩或 mock');
  const canReuseKey = unchangedProvider && previous?.baseUrl === baseUrl;
  const apiKey = supplied || (canReuseKey ? previous!.apiKey : '');
  if (!apiKey || apiKey.length > 4096 || /[\r\n]/.test(apiKey))
    throw Error('请填 1–4096 字的 API Key；换供应商或地址时必须填新 key');
  return { provider, apiKey, model, baseUrl };
}

/** 只有真正无行才能回退 env；坏密文/不可信元数据都算 invalid。 */
export async function loadUserModelSetting(pool: Pool, cipher: JsonCipher | null | undefined, userId: number): Promise<ModelSetting> {
  const r = await pool.query<{ config_enc: string }>(
    'SELECT config_enc FROM plugin_configs WHERE user_id=$1 AND plugin_id=$2', [userId, MODEL_ID],
  );
  if (!r.rows[0]) return { kind: 'missing' };
  if (!cipher) return { kind: 'invalid' };
  try {
    const raw = cipher.decryptJson<UserModelConfig>(r.rows[0].config_enc);
    if (!raw || typeof raw !== 'object' || !['deepseek', 'openai', 'custom'].includes(raw.provider) ||
      typeof raw.apiKey !== 'string' || typeof raw.model !== 'string' || typeof raw.baseUrl !== 'string')
      return { kind: 'invalid' };
    // 验证解密后的 URL，防止本地库被篡改后把 key 发给恶意地址。
    const validated = normalizeModelConfig(raw as unknown as Record<string, unknown>);
    if (validated.model !== raw.model || validated.baseUrl !== raw.baseUrl || validated.apiKey !== raw.apiKey)
      return { kind: 'invalid' };
    return { kind: 'configured', config: raw };
  } catch { return { kind: 'invalid' }; }
}

export async function saveUserModelSetting(pool: Pool, cipher: JsonCipher, userId: number, config: UserModelConfig): Promise<void> {
  if (!cipher) throw Error('加密配置缺失，拒绝存模型密钥');
  const enc = cipher.encryptJson(config);
  await pool.query(`INSERT INTO plugin_configs (user_id,plugin_id,config_enc) VALUES ($1,$2,$3)
    ON CONFLICT (user_id,plugin_id) DO UPDATE SET config_enc=EXCLUDED.config_enc, updated_at=now()`, [userId, MODEL_ID, enc]);
}
export async function clearUserModelSetting(pool: Pool, userId: number): Promise<void> {
  await pool.query('DELETE FROM plugin_configs WHERE user_id=$1 AND plugin_id=$2', [userId, MODEL_ID]);
}

export async function modelAvailableForUser(pool: Pool, cipher: JsonCipher, userId: number, env: ServerEnv): Promise<boolean> {
  try {
    const setting = await loadUserModelSetting(pool, cipher, userId);
    return setting.kind === 'configured' || (setting.kind === 'missing' && Boolean(env.deepseekApiKey));
  } catch { return false; } // 库不可用也不能用共享 env key 发请求
}

/** buildApp 注入一次本进程的池/加密器；新请求每次重查库，不持有明文 key。 */
let lookup: ((userId: number) => Promise<ModelSetting>) | null = null;
export function installModelLookup(pool: Pool, cipher: JsonCipher): void {
  lookup = (id) => loadUserModelSetting(pool, cipher, id);
}
export async function modelSettingForCall(userId?: number): Promise<ModelSetting> {
  if (userId === undefined || userId === 0) return { kind: 'missing' }; // 旧无用户上下文单元验收走 env
  if (!Number.isSafeInteger(userId) || userId < 0 || !lookup) return { kind: 'invalid' };
  try { return await lookup(userId); }
  catch { return { kind: 'invalid' }; } // 库坏/断线也不能回落全局 env；错误不含连接串
}
