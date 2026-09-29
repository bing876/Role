/**
 * 能力与连接 · 片2 · **MCP 通用桥 —— 注册/执行**（2026-09-27）。
 *
 * 把「某个用户挂的 MCP server 的 tools」接进循环引擎当可调用工具：
 *   · 工具名命名空间化：`mcp__s<serverRowId>__<toolName>`。serverRowId 是 `mcp_servers`
 *     的自增主键（**全局唯一**）→ 跨用户不撞名（注册表是全局 append-only，无注销口，
 *     唯一命名空间化后「删 server = 该名字从这个人工具表消失」，残留的全局条目是死条目）。
 *   · 执行器按 ctx.userId 归属硬闸：只认**当前用户自己**的 server 行，串号直接失败（不泄）。
 *   · auth 走 auth_enc 加密（复用 JsonCipher），只在进程内解出来用，绝不外泄。
 *
 * 纯服务端模块，零 React/electron 依赖，可单测（验收 mcp.mts 真连一个本地 MCP server）。
 */
import type { Pool } from 'pg';
import type { JsonCipher } from '../crypto';
import type { ToolDefinition } from '@ai-workbench/shared';
import type { ToolRegistry } from '@ai-workbench/shared';
import type { ServerExecutionContext } from '../toolRegistry';
import { callMcpTool, listMcpTools, McpError, type McpAuth, type McpTool } from './mcp';

/** MCP 工具名命名空间：`mcp__s<rowId>__<toolName>` */
export const MCP_TOOL_PREFIX = 'mcp__';
const NAME_SAFE = /^[A-Za-z0-9_.-]+$/;

function safeToolName(raw: string): string {
  const s = String(raw ?? '');
  return NAME_SAFE.test(s) ? s : s.replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function mcpToolNameFor(rowId: number, toolName: string): string {
  return `${MCP_TOOL_PREFIX}s${rowId}__${safeToolName(toolName)}`;
}

/** 解析命名空间化的 MCP 工具名 → { rowId, toolName }；不是 MCP 工具 → null */
export function parseMcpToolName(name: string): { rowId: number; toolName: string } | null {
  if (typeof name !== 'string' || !name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const m = /^s(\d+)__(.+)$/.exec(rest);
  if (!m) return null;
  const rowId = Number(m[1]);
  if (!Number.isInteger(rowId) || rowId <= 0) return null;
  return { rowId, toolName: m[2] };
}

export interface UserMcpServer {
  id: number;
  name: string;
  url: string;
  auth: McpAuth;
  tools: McpTool[];
}

interface McpServerRow {
  id: string;
  name: string;
  url: string;
  auth_enc: string | null;
  tools_json: string;
}

/** 解密一份 auth_enc（fail-closed：解不开 → 空 auth） */
function decryptAuth(cipher: JsonCipher | null | undefined, authEnc: string | null): McpAuth {
  if (!authEnc) return {};
  if (!cipher) throw new McpError('decrypt_failed', 'MCP 鉴权配置无法解密（DATA_KEY 未配置）');
  try {
    const o = cipher.decryptJson<{ bearerToken?: string; headers?: Record<string, string> }>(authEnc);
    if (!o || typeof o !== 'object') return {};
    return {
      bearerToken: typeof o.bearerToken === 'string' && o.bearerToken ? o.bearerToken : undefined,
      headers: o.headers && typeof o.headers === 'object' ? (o.headers as Record<string, string>) : undefined,
    };
  } catch {
    throw new McpError('decrypt_failed', 'MCP 鉴权配置解密失败（拒绝无凭据连接）');
  }
}

function parseTools(json: string): McpTool[] {
  try {
    const arr = JSON.parse(json || '[]');
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((t): t is McpTool => !!t && typeof (t as { name?: unknown }).name === 'string')
      .map((t) => ({
        name: String(t.name),
        description: typeof t.description === 'string' ? t.description : undefined,
        inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
      }));
  } catch {
    return [];
  }
}

/** 读某用户挂的所有 MCP server（含解密后的 auth + 解析后的 tools） */
export async function loadUserMcpServers(pool: Pool, cipher: JsonCipher | null | undefined, userId: number): Promise<UserMcpServer[]> {
  const r = await pool.query<McpServerRow>(
    'SELECT id, name, url, auth_enc, tools_json FROM mcp_servers WHERE user_id = $1 ORDER BY id',
    [userId],
  );
  return r.rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    url: row.url,
    auth: decryptAuth(cipher, row.auth_enc),
    tools: parseTools(row.tools_json),
  }));
}

/** 某用户所有 MCP 工具的命名空间化名字（给循环拼工具表用） */
export async function mcpToolNamesForUser(pool: Pool, cipher: JsonCipher | null | undefined, userId: number): Promise<string[]> {
  const servers = await loadUserMcpServers(pool, cipher, userId);
  const names: string[] = [];
  for (const s of servers) for (const t of s.tools) names.push(mcpToolNameFor(s.id, t.name));
  return names;
}

function buildDef(name: string, serverName: string, tool: McpTool): ToolDefinition {
  return {
    name,
    description: [
      `[MCP:${serverName}] ${tool.description ?? '（该 server 未给描述）'}`,
      '',
      '这是一个外部 MCP server 提供的工具。参数按其 inputSchema 传（JSON）。',
    ].join('\n'),
    parameters: (tool.inputSchema && Object.keys(tool.inputSchema).length > 0
      ? tool.inputSchema
      : { type: 'object', properties: {} }) as unknown as ToolDefinition['parameters'],
    side: 'server',
    kind: 'action',
    timeoutMs: 60_000,
    validate: (_args) => ({ ok: true, args: _args }),
  } as ToolDefinition;
}

/**
 * 把某用户的 MCP 工具注册进全局注册表（幂等：已注册的名字跳过）。
 * 返回注册/已存在的命名空间化名字列表。
 */
export async function ensureMcpToolsRegistered(
  pool: Pool,
  cipher: JsonCipher | null | undefined,
  userId: number,
  registry: ToolRegistry<ServerExecutionContext>,
): Promise<string[]> {
  const servers = await loadUserMcpServers(pool, cipher, userId);
  const names: string[] = [];
  for (const s of servers) {
    for (const t of s.tools) {
      const name = mcpToolNameFor(s.id, t.name);
      if (registry.get(name)) {
        names.push(name);
        continue;
      }
      const def = buildDef(name, s.name, t);
      registry.register(def, {
        execute: async (args, ctx) => executeMcpTool(name, args, ctx, pool, cipher),
      });
      names.push(name);
    }
  }
  return names;
}

/**
 * 执行一个命名空间化的 MCP 工具：解析 serverRowId + toolName → 校验归属（ctx.userId）
 * → 连 server 调 tools/call → 回 LoopToolResult。
 */
export async function executeMcpTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ServerExecutionContext,
  pool: Pool,
  cipher: JsonCipher | null | undefined,
): Promise<{ ok: boolean; detail?: string; error?: string; data?: Record<string, unknown> }> {
  const parsed = parseMcpToolName(name);
  if (!parsed) return { ok: false, error: 'internal', detail: '内部错误：MCP 工具名解析失败' };
  const r = await pool.query<McpServerRow>(
    'SELECT id, name, url, auth_enc, tools_json FROM mcp_servers WHERE id = $1 AND user_id = $2',
    [parsed.rowId, ctx.userId],
  );
  const row = r.rows[0];
  if (!row) return { ok: false, error: 'not_found', detail: '这个 MCP 工具对应的 server 不存在或不属于你' };
  // 删除/重配后的旧注册条目不能借「死名字」访问新 server 的未公开工具。
  if (!parseTools(row.tools_json).some((t) => t.name === parsed.toolName && mcpToolNameFor(parsed.rowId, t.name) === name))
    return { ok: false, error: 'not_found', detail: '这个 MCP 工具已不在 server 的工具列表里' };
  try {
    const auth = decryptAuth(cipher, row.auth_enc);
    const res = await callMcpTool(row.url, auth, parsed.toolName, args ?? {}, { timeoutMs: 50_000 });
    if (res.isError) {
      return { ok: false, error: 'mcp_tool_error', detail: `MCP server 报这个工具执行出错：${truncate(res.text, 800) || '（无详情）'}`, data: { result: truncate(res.text, 4000) } };
    }
    return { ok: true, detail: `MCP「${row.name}.${parsed.toolName}」执行完成`, data: { result: truncate(res.text, 8000) || '（空结果）' } };
  } catch (err) {
    const code = err instanceof McpError ? err.code : 'mcp_failed';
    const msg = err instanceof McpError ? err.message : 'MCP 工具执行失败';
    return { ok: false, error: code, detail: `${row.name} 的 ${parsed.toolName}：${msg}` };
  }
}

function truncate(s: string, n: number): string {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + `…（已截断，共 ${t.length} 字）` : t;
}
