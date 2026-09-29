/**
 * 能力与连接 · 片2 · **MCP 通用桥 —— HTTP 面**（2026-09-27）。
 *
 *   POST   /mcp/servers            加一个 MCP server（连上→tools/list 拉工具→存）；
 *                                  连不上/没工具 → 不落库（不挂个死 server）。
 *   GET    /mcp/servers            列当前用户的 MCP server（name/url/tools；**绝不**回 auth）
 *   DELETE /mcp/servers/:id        删（拔 server，它的工具从这个人工具表消失）
 *   POST   /mcp/servers/:id/test   测连通（重连一次 tools/list）
 *
 * 口径（与 /plugins 一致）：要 JWT；只认**当前登录用户自己**的 server（别人的 404，不泄存在性）；
 * auth（Bearer token）AES-256-GCM 加密落本地，读回绝不回明文；任何错误消息不带 key/上游原文。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { bearerFrom, verifyToken } from '../crypto';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { isDbUnreachable } from '../db';
import { listMcpTools, McpError, validateMcpEndpoint } from '../plugins/mcp';
import { loadUserMcpServers } from '../plugins/mcpRegistry';

export interface McpDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

function errJson(reply: FastifyReply, code: number, error: string, extra?: Record<string, unknown>): FastifyReply {
  return reply.code(code).send({ error, ...extra });
}

function dbErr(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) return errJson(reply, 503, '数据库连不上，稍后再试');
  console.error('[mcp] 未分类错误：', (err as Error)?.message ?? String(err));
  return errJson(reply, 500, `服务端错误：${(err as Error)?.message ?? String(err)}`);
}

function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

export function registerMcpRoutes(app: FastifyInstance, { pool, env, cipher }: McpDeps): void {
  // ---------------------------------------------------------------------------
  // POST /mcp/servers —— 加 server（连上拉工具再落库）
  //   body: { name, url, auth?: { bearerToken?, headers? } }
  // ---------------------------------------------------------------------------
  app.post('/mcp/servers', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const body = (req.body ?? {}) as { name?: unknown; url?: unknown; auth?: { bearerToken?: unknown; headers?: Record<string, unknown> } };
    const name = str(body.name);
    const url = str(body.url);
    if (!name || name.length > 64) return errJson(reply, 400, '给 server 起一个 1–64 字的名字');
    let safeUrl: string;
    try { safeUrl = validateMcpEndpoint(url ?? ''); }
    catch (e) { return errJson(reply, 400, (e as McpError).message); }
    if (typeof body.auth?.bearerToken === 'string' && body.auth.bearerToken.length > 4096)
      return errJson(reply, 400, 'Bearer token 太长');
    const auth = {
      bearerToken: str(body.auth?.bearerToken),
      headers:
        body.auth?.headers && typeof body.auth.headers === 'object'
          ? (Object.fromEntries(Object.entries(body.auth.headers).filter(([, v]) => typeof v === 'string')) as Record<string, string>)
          : undefined,
    };

    // 先连（真拉一次 tools/list）——连不上/没工具就不落库
    let tools;
    try {
      tools = await listMcpTools(safeUrl, auth, { timeoutMs: 25_000 });
    } catch (err) {
      const msg = err instanceof McpError ? err.message : '连不上这个 MCP server';
      return errJson(reply, 400, `加不了：${msg}`, { code: 'connect_failed' });
    }
    if (tools.length === 0) return errJson(reply, 400, '这个 server 没暴露任何工具，挂上去没用', { code: 'no_tools' });

    try {
      const existing = await pool.query('SELECT id FROM mcp_servers WHERE user_id = $1 AND name = $2', [claims.sub, name]);
      if (existing.rowCount) return errJson(reply, 409, '这个名字已经用过；请先删除旧连接或换个名字');
      const count = await pool.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM mcp_servers WHERE user_id = $1', [claims.sub]);
      if (Number(count.rows[0]?.n) >= 8) return errJson(reply, 400, '最多挂 8 个 MCP server（请先删除不用的）');
      // 没有 cipher 就拒绝，绝不明文兜底。
      if (!cipher) return errJson(reply, 503, '缺少加密配置，不能保存 MCP 连接');
      const authEnc = cipher.encryptJson(auth);
      const r = await pool.query<{ id: string }>(
        `INSERT INTO mcp_servers (user_id, name, url, auth_enc, tools_json)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [claims.sub, name, safeUrl, authEnc, JSON.stringify(tools)],
      );
      return { ok: true, id: Number(r.rows[0].id), name, url: safeUrl, toolCount: tools.length, tools: tools.map((t) => ({ name: t.name, description: t.description })) };
    } catch (err) { return dbErr(reply, err); }
  });

  // ---------------------------------------------------------------------------
  // GET /mcp/servers —— 列当前用户的 server（不回 auth）
  // ---------------------------------------------------------------------------
  app.get('/mcp/servers', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    try {
      const servers = await loadUserMcpServers(pool, cipher, claims.sub);
      return {
        servers: servers.map((s) => ({
          id: s.id,
          name: s.name,
          url: s.url,
          hasAuth: Boolean(s.auth.bearerToken || (s.auth.headers && Object.keys(s.auth.headers).length > 0)),
          tools: s.tools.map((t) => ({ name: t.name, description: t.description })),
        })),
      };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /mcp/servers/:id —— 删（只认自己的）
  // ---------------------------------------------------------------------------
  app.delete('/mcp/servers/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const id = Number((req.params as { id?: unknown }).id);
    if (!Number.isInteger(id) || id <= 0) return errJson(reply, 400, 'server 号不正确');
    const r = await pool.query('DELETE FROM mcp_servers WHERE id = $1 AND user_id = $2 RETURNING id', [id, claims.sub]);
    if (r.rowCount !== 1) return errJson(reply, 404, '没有这个 server');
    return { ok: true, id };
  });

  // ---------------------------------------------------------------------------
  // POST /mcp/servers/:id/test —— 测连通（重连一次 tools/list）
  // ---------------------------------------------------------------------------
  app.post('/mcp/servers/:id/test', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const id = Number((req.params as { id?: unknown }).id);
    if (!Number.isInteger(id) || id <= 0) return errJson(reply, 400, 'server 号不正确');
    const servers = (await loadUserMcpServers(pool, cipher, claims.sub)).filter((s) => s.id === id);
    if (servers.length === 0) return errJson(reply, 404, '没有这个 server');
    const s = servers[0];
    try {
      const tools = await listMcpTools(s.url, s.auth, { timeoutMs: 25_000 });
      return { ok: true, detail: `连通正常（${tools.length} 个工具）`, count: tools.length };
    } catch (err) {
      const msg = err instanceof McpError ? err.message : '连不上这个 MCP server';
      return { ok: false, detail: msg };
    }
  });
}
