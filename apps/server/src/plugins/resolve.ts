/**
 * 能力与连接 · **按用户解析可用供应商**（2026-09-27）。
 *
 * 循环引擎的工具执行器拿不到「该用哪个供应商」—— 它只有 ctx.userId。
 * 本文件负责「按这个用户，从**本地加密配置**里挑出可用供应商」：
 *   · 网页搜索：本地配置优先；**没配**时回退到 env 的 TAVILY_API_KEY（老行为，兼容存量）；
 *   · 生成图片：只有本地配置（没有 env 兜底 —— 图片 key 是新产品面，env 里从没放过）。
 *
 * 没配 / 解不开 → 返回 null（工具执行器据此回 not_configured，**不发注定失败的请求**）。
 */
import type { Pool } from 'pg';
import type { JsonCipher } from '../crypto';
import type { ServerEnv } from '../env';
import { isWebSearchConfigured, webSearchConfigFromEnv } from '../search/tavily';
import { loadPluginConfig } from './config';
import { imageProviderFromConfig, searchProviderFromConfig } from './registry';
import { searchProviderFor, type ImageProvider, type SearchProvider } from './providers';

/**
 * **只给验收脚本用**的供应商解析覆盖口（名字带 `ForTest`，`grep ForTest` 一眼可辨）。
 * 生产路径永远走真实配置解析；测试用它塞一个 stub 供应商，证明「工具接进循环引擎、
 * 落项目目录、进对话流」的全链路而不必真连外部 API / 烧钱。
 */
let imageResolverOverride: ((pool: Pool, cipher: JsonCipher | null | undefined, userId: number) => Promise<ImageProvider | null>) | null = null;
let searchResolverOverride:
  | ((pool: Pool, cipher: JsonCipher | null | undefined, userId: number, env: ServerEnv) => Promise<SearchProvider | null>)
  | null = null;

export function setImageProviderResolverForTest(
  fn: ((pool: Pool, cipher: JsonCipher | null | undefined, userId: number) => Promise<ImageProvider | null>) | null,
): void {
  imageResolverOverride = fn;
}
export function setSearchProviderResolverForTest(
  fn: ((pool: Pool, cipher: JsonCipher | null | undefined, userId: number, env: ServerEnv) => Promise<SearchProvider | null>) | null,
): void {
  searchResolverOverride = fn;
}

/** 按用户解析搜索供应商：本地配置 → env 兜底 → null */
export async function resolveSearchProviderForUser(
  pool: Pool,
  cipher: JsonCipher | null | undefined,
  userId: number,
  env: ServerEnv,
): Promise<SearchProvider | null> {
  if (searchResolverOverride) return searchResolverOverride(pool, cipher, userId, env);
  const cfg = await loadPluginConfig(pool, cipher, userId, 'web_search');
  const fromLocal = searchProviderFromConfig(cfg);
  if (fromLocal) return fromLocal;
  // 老行为兜底：存量部署在 .env 里放了 TAVILY_API_KEY，没迁到抽屉的照样能用
  const envCfg = webSearchConfigFromEnv(env);
  if (isWebSearchConfigured(envCfg)) return searchProviderFor({ provider: 'tavily', ...envCfg });
  return null;
}

/** 按用户解析图片供应商：本地配置 → null（无 env 兜底） */
export async function resolveImageProviderForUser(
  pool: Pool,
  cipher: JsonCipher | null | undefined,
  userId: number,
): Promise<ImageProvider | null> {
  if (imageResolverOverride) return imageResolverOverride(pool, cipher, userId);
  const cfg = await loadPluginConfig(pool, cipher, userId, 'image_gen');
  return imageProviderFromConfig(cfg);
}
