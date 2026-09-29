/**
 * 能力与连接 · 片2 · **MCP 通用桥 · 循环接线**（2026-09-27）。
 *
 * 建一个「主浏览器循环」前调它：把**当前用户**挂的 MCP server 工具注册进全局注册表
 * （幂等），并拼出这一轮该用的全量工具名（5 浏览器工具 + stop + 可选 web_search + 用户 MCP 工具）。
 *
 * ★ 单独成模块是为了避免循环依赖：`toolRegistry` ↔ `mcpRegistry` 若互相 import 会成环；
 *   这里只 import 两者（单向），谁都不 import 本文件。
 *
 * ★ fail-open：MCP 拉取/注册失败**不让它炸掉浏览器循环** —— 记一行警告、这一轮照常跑
 *   （只是没 MCP 工具）。MCP 是「多挂的能力」，不该比浏览器本体还关键。
 */
import type { Pool } from 'pg';
import type { JsonCipher } from '../crypto';
import type { ServerEnv } from '../env';
import { browserToolNamesFor, serverToolRegistry } from '../toolRegistry';
import { ensureMcpToolsRegistered } from './mcpRegistry';

/**
 * @returns 这一轮该用的全量工具名；没有 MCP 工具 → `undefined`（让 startLoop 走 `browserToolNamesFor(env)` 老路，逐字节不变）。
 */
export async function mainLoopToolNamesWithMcp(
  pool: Pool,
  cipher: JsonCipher | null | undefined,
  userId: number,
  env: ServerEnv,
): Promise<string[] | undefined> {
  let mcpNames: string[] = [];
  try {
    mcpNames = await ensureMcpToolsRegistered(pool, cipher, userId, serverToolRegistry);
  } catch (err) {
    console.warn('[mcp] 拉用户 MCP 工具失败（忽略，循环照常）：', (err as Error)?.message ?? String(err));
  }
  return mcpNames.length > 0 ? [...browserToolNamesFor(env), ...mcpNames] : undefined;
}
