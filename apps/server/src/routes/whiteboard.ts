/**
 * 批次 B | 项目共享白板：project scope 记忆暴露成“项目简报”，所有成员自动注入；贴白板=待确认记忆卡
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable } from '../db';
import { loadOwnedProject } from '../projectScope';
import { listWhiteboard, postWhiteboard, confirmWhiteboard, forgetWhiteboard } from '../orchestrator/whiteboard';

export interface WhiteboardDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

function errJson(reply: FastifyReply, code: number, error: string, extra?: Record<string, unknown>): FastifyReply {
  return reply.code(code).send({ error, ...extra });
}

function dbErr(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) return errJson(reply, 503, '数据库连不上');
  console.error('[whiteboard] 未分类错误：', (err as Error)?.message ?? String(err));
  return errJson(reply, 500, `服务端错误：${(err as Error)?.message ?? String(err)}`);
}

function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

export function registerWhiteboardRoutes(app: FastifyInstance, deps: WhiteboardDeps): void {
  const { pool, cipher } = deps;

  // GET /projects/:id/whiteboard → 项目简报列表
  app.get('/projects/:id/whiteboard', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, deps.env);
    if (!claims) return errJson(reply, 401, '未登录');
    const projectId = Number((req.params as { id?: unknown })?.id);
    if (!Number.isInteger(projectId) || projectId <= 0) return errJson(reply, 400, 'projectId 非法');
    try {
      const owned = await loadOwnedProject(pool, claims.sub, projectId);
      if (!owned) return errJson(reply, 404, '项目不存在或不是你的');
      const items = await listWhiteboard(pool, cipher, claims.sub, projectId);
      return { projectId, whiteboard: items };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // POST /projects/:id/whiteboard → 贴白板=待确认记忆卡
  app.post('/projects/:id/whiteboard', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, deps.env);
    if (!claims) return errJson(reply, 401, '未登录');
    const projectId = Number((req.params as { id?: unknown })?.id);
    const b = (req.body ?? {}) as { content?: unknown; agentId?: unknown; needsConfirm?: unknown };
    const content = typeof b.content === 'string' ? b.content.trim() : '';
    const agentId = b.agentId !== undefined && b.agentId !== null ? Number(b.agentId) : null;
    const needsConfirm = b.needsConfirm === true || b.needsConfirm === undefined ? true : false; // 默认待确认
    if (!Number.isInteger(projectId) || projectId <= 0) return errJson(reply, 400, 'projectId 非法');
    if (!content) return errJson(reply, 400, 'content 不能为空');
    if (content.length > 300) return errJson(reply, 400, 'content 最长 300 字');
    try {
      const owned = await loadOwnedProject(pool, claims.sub, projectId);
      if (!owned) return errJson(reply, 404, '项目不存在或不是你的');
      if (agentId !== null && (!Number.isInteger(agentId) || agentId <= 0)) return errJson(reply, 400, 'agentId 非法');
      if (agentId !== null) {
        const ag = await pool.query('SELECT id FROM agents WHERE id=$1 AND project_id=$2', [agentId, projectId]);
        if (ag.rowCount !== 1) return errJson(reply, 404, '智能体不存在或不在该项目');
      }
      const item = await postWhiteboard(pool, cipher, { userId: claims.sub, projectId, agentId, content, needsConfirm, source: 'whiteboard_post' });
      if (!item) return errJson(reply, 400, '写入失败（可能含敏感信息）');
      return { ok: true, whiteboard: item };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // POST /projects/:id/whiteboard/confirm → 确认卡
  app.post('/projects/:id/whiteboard/confirm', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, deps.env);
    if (!claims) return errJson(reply, 401, '未登录');
    const projectId = Number((req.params as { id?: unknown })?.id);
    const b = (req.body ?? {}) as { ids?: unknown; all?: unknown };
    if (!Number.isInteger(projectId) || projectId <= 0) return errJson(reply, 400, 'projectId 非法');
    try {
      const owned = await loadOwnedProject(pool, claims.sub, projectId);
      if (!owned) return errJson(reply, 404, '项目不存在或不是你的');
      if (b.all === true) {
        const r = await pool.query(`UPDATE project_whiteboard SET status='active', updated_at=now() WHERE user_id=$1 AND project_id=$2 AND status='pending'`, [claims.sub, projectId]);
        return { ok: true, changed: r.rowCount ?? 0 };
      }
      const ids = Array.isArray(b.ids) ? (b.ids as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 10) : [];
      if (ids.length === 0) return errJson(reply, 400, 'ids 不能为空');
      const changed = await confirmWhiteboard(pool, claims.sub, projectId, ids, 'active');
      return { ok: true, changed };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // POST /projects/:id/whiteboard/reject → 拒绝卡
  app.post('/projects/:id/whiteboard/reject', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, deps.env);
    if (!claims) return errJson(reply, 401, '未登录');
    const projectId = Number((req.params as { id?: unknown })?.id);
    const b = (req.body ?? {}) as { ids?: unknown; all?: unknown };
    if (!Number.isInteger(projectId) || projectId <= 0) return errJson(reply, 400, 'projectId 非法');
    try {
      const owned = await loadOwnedProject(pool, claims.sub, projectId);
      if (!owned) return errJson(reply, 404, '项目不存在或不是你的');
      if (b.all === true) {
        const r = await pool.query(`UPDATE project_whiteboard SET status='archived', updated_at=now() WHERE user_id=$1 AND project_id=$2 AND status='pending'`, [claims.sub, projectId]);
        return { ok: true, changed: r.rowCount ?? 0 };
      }
      const ids = Array.isArray(b.ids) ? (b.ids as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 10) : [];
      if (ids.length === 0) return errJson(reply, 400, 'ids 不能为空');
      const changed = await confirmWhiteboard(pool, claims.sub, projectId, ids, 'archived');
      return { ok: true, changed };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // POST /projects/:id/whiteboard/forget → 忘掉一条 active
  app.post('/projects/:id/whiteboard/forget', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, deps.env);
    if (!claims) return errJson(reply, 401, '未登录');
    const projectId = Number((req.params as { id?: unknown })?.id);
    const b = (req.body ?? {}) as { id?: unknown };
    const id = Number(b.id);
    if (!Number.isInteger(projectId) || projectId <= 0) return errJson(reply, 400, 'projectId 非法');
    if (!Number.isInteger(id) || id <= 0) return errJson(reply, 400, 'id 非法');
    try {
      const owned = await loadOwnedProject(pool, claims.sub, projectId);
      if (!owned) return errJson(reply, 404, '项目不存在或不是你的');
      const ok = await forgetWhiteboard(pool, claims.sub, projectId, id);
      if (!ok) return errJson(reply, 404, '白板条目不存在或不是 active');
      return { ok: true };
    } catch (err) {
      return dbErr(reply, err);
    }
  });
}
