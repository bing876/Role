/**
 * 能力与连接 · **配置加密落本地**（2026-09-27）。
 *
 * 「配置加密落本地」的落盘一半：插件配置（含 API key）整份 JSON 走 AES-256-GCM
 * （复用项目统一的 JsonCipher / DATA_KEY），密文存 `plugin_configs.config_enc`。
 *   · 写：`cipher.encryptJson(config)` → 密文列；**明文 key 绝不留第二份**。
 *   · 读：`cipher.decryptJson` → 内存对象，用完即弃；**对外只回打码视图**（见 registry.ts）。
 *   · 无 cipher / 解不开 → fail-closed（当「没配」处理，绝不回退明文、绝不写兜底列）。
 *
 * 按 (user_id, plugin_id) 唯一：配置属于「当前登录的这个人」，与账号隔离（绝不串号）。
 */
import type { Pool } from 'pg';
import type { JsonCipher } from '../crypto';

export interface WebSearchPluginConfig {
  provider: 'tavily';
  apiKey: string;
  baseUrl?: string;
}

export type ImagePluginConfig =
  | { provider: 'dashscope'; apiKey: string; baseUrl?: string; model?: string }
  | { provider: 'openai'; apiKey: string; baseUrl?: string; model?: string };

/** 通用配置对象（落库前都是这个形状；具体字段由各插件的 configFields 决定） */
export type PluginConfig = Record<string, string>;

/** 写一份配置（加密 + upsert）。config 里只该有字符串字段（key/baseUrl/model/provider） */
export async function savePluginConfig(
  pool: Pool,
  cipher: JsonCipher,
  userId: number,
  pluginId: string,
  config: PluginConfig,
): Promise<void> {
  if (!cipher) throw new Error('未注入 cipher（DATA_KEY 缺失），配置无法加密落库');
  const enc = cipher.encryptJson(config);
  await pool.query(
    `INSERT INTO plugin_configs (user_id, plugin_id, config_enc)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, plugin_id) DO UPDATE SET config_enc = EXCLUDED.config_enc, updated_at = now()`,
    [userId, pluginId, enc],
  );
}

/** 删一份配置（=「拔插件」/ 清空） */
export async function deletePluginConfig(pool: Pool, userId: number, pluginId: string): Promise<void> {
  await pool.query('DELETE FROM plugin_configs WHERE user_id = $1 AND plugin_id = $2', [userId, pluginId]);
}

/**
 * 读一份配置。解不开 / 没配 → 返回 null（fail-closed，不当成功）。
 * 返回的是**内存里的明文对象**，只在进程内用；调用方负责用完不再外泄。
 */
export async function loadPluginConfig(
  pool: Pool,
  cipher: JsonCipher | null | undefined,
  userId: number,
  pluginId: string,
): Promise<PluginConfig | null> {
  if (!cipher) return null;
  try {
    const r = await pool.query<{ config_enc: string }>(
      'SELECT config_enc FROM plugin_configs WHERE user_id = $1 AND plugin_id = $2',
      [userId, pluginId],
    );
    if (!r.rows[0]?.config_enc) return null;
    const obj = cipher.decryptJson<PluginConfig>(r.rows[0].config_enc);
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch (err) {
    // 解不开（DATA_KEY 换过 / 密文损坏）→ 当「没配」，并打一行**不含内容**的警告
    console.warn(`[plugins] ${pluginId} 配置解密失败（当未配置处理，不回退明文）：`, (err as Error).message);
    return null;
  }
}

/** 这份配置是否「配齐可用」（requiredFields 全部有非空值） */
export function isConfigComplete(config: PluginConfig | null, requiredFields: string[]): boolean {
  if (!config) return false;
  return requiredFields.every((f) => typeof config[f] === 'string' && config[f].trim() !== '');
}

/** 该用户这个插件是否配齐（供 GET /plugins 的状态列） */
export async function pluginConfigured(
  pool: Pool,
  cipher: JsonCipher | null | undefined,
  userId: number,
  pluginId: string,
  requiredFields: string[],
): Promise<boolean> {
  const cfg = await loadPluginConfig(pool, cipher, userId, pluginId);
  return isConfigComplete(cfg, requiredFields);
}
