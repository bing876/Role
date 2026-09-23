/**
 * Routines 定时/事件触发：CRUD + 触发
 *
 * - 描述=长期规矩，对话=一次活
 * - 数据/事件做，版式归前端
 * - 只留 Bots/Chats/Prompts/Tools/Artifacts，Routines 是 Prompts 的一种长期形态
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable } from '../db';
import { loadOwnedProject } from '../projectScope';
import { createRoutine, listRoutines, deleteRoutine, setRoutineEnabled, triggerRoutine } from '../orchestrator/routines';

export interface RoutineDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

function errJson(reply: FastifyReply, code: number, error: string, extra?: Record<string, unknown>): FastifyReply {
  return reply.code(code).send({ error, ...extra });
}

function dbErr(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) {
    return errJson(reply, 503, '数据库连不上：先 npm run db:up');
  }
  console.error('[routines] 未分类错误：', (err as Error)?.message ?? String(err));
  return errJson(reply, 500, `服务端错误：${(err as Error)?.message ?? String(err)}`);
}

function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

export function registerRoutineRoutes(app: FastifyInstance, deps: RoutineDeps): void {
  const { pool, cipher } = deps;

  app.get('/routines', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, deps.env);
    if (!claims) return errJson(reply, 401, '未登录');
    const q = req.query as { projectId?: unknown } | null;
    let projectId: number | null = null;
    if (q?.projectId !== undefined && q?.projectId !== null && String(q.projectId).trim() !== '') {
      const n = Number(String(q.projectId).trim());
      if (!Number.isSafeInteger(n) || n <= 0) return errJson(reply, 400, 'projectId 不正确');
      projectId = n;
    }
    try {
      if (projectId !== null) {
        const owned = await loadOwnedProject(pool, claims.sub, projectId);
        if (!owned) return errJson(reply, 404, '项目不存在或不是你的');
      }
      const routines = await listRoutines(pool, claims.sub, projectId);
      return { routines };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.post('/routines', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, deps.env);
    if (!claims) return errJson(reply, 401, '未登录');
    const b = (req.body ?? {}) as {
      projectId?: unknown;
      agentId?: unknown;
      name?: unknown;
      description?: unknown;
      triggerType?: unknown;
      triggerConfig?: unknown;
      taskTemplate?: unknown;
    };
    const projectId = Number(b.projectId);
    const agentId = Number(b.agentId);
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 80) : '';
    const description = typeof b.description === 'string' ? b.description.trim().slice(0, 300) : '';
    const triggerType = b.triggerType === 'interval' || b.triggerType === 'cron' || b.triggerType === 'event' ? b.triggerType : null;
    const taskTemplate = typeof b.taskTemplate === 'string' ? b.taskTemplate.trim().slice(0, 600) : '';
    if (!Number.isInteger(projectId) || projectId <= 0) return errJson(reply, 400, 'projectId 非法');
    if (!Number.isInteger(agentId) || agentId <= 0) return errJson(reply, 400, 'agentId 非法');
    if (!name) return errJson(reply, 400, 'name 不能为空');
    if (!triggerType) return errJson(reply, 400, 'triggerType 只能是 interval/cron/event');
    if (!taskTemplate) return errJson(reply, 400, 'taskTemplate 不能为空');
    try {
      const owned = await loadOwnedProject(pool, claims.sub, projectId);
      if (!owned) return errJson(reply, 404, '项目不存在或不是你的');
      // 校验 agent 归属
      const ag = await pool.query('SELECT id FROM agents WHERE id=$1 AND project_id=$2', [agentId, projectId]);
      if (ag.rowCount !== 1) return errJson(reply, 404, '智能体不存在或不在该项目');
      const routine = await createRoutine(pool, {
        userId: claims.sub,
        projectId,
        agentId,
        name,
        description,
        triggerType,
        triggerConfig: (b.triggerConfig as any) ?? {},
        taskTemplate,
      });
      return { routine };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.delete('/routines/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, deps.env);
    if (!claims) return errJson(reply, 401, '未登录');
    const id = Number((req.params as { id?: unknown })?.id);
    if (!Number.isInteger(id) || id <= 0) return errJson(reply, 400, 'id 非法');
    try {
      const ok = await deleteRoutine(pool, claims.sub, id);
      if (!ok) return errJson(reply, 404, '例行不存在或不是你的');
      return { ok: true };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.post('/routines/:id/enable', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, deps.env);
    if (!claims) return errJson(reply, 401, '未登录');
    const id = Number((req.params as { id?: unknown })?.id);
    const enabled = Boolean((req.body as { enabled?: unknown } | null)?.enabled);
    if (!Number.isInteger(id) || id <= 0) return errJson(reply, 400, 'id 非法');
    try {
      const ok = await setRoutineEnabled(pool, claims.sub, id, enabled);
      if (!ok) return errJson(reply, 404, '例行不存在或不是你的');
      return { ok: true, enabled };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.post('/routines/:id/trigger', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, deps.env);
    if (!claims) return errJson(reply, 401, '未登录');
    const id = Number((req.params as { id?: unknown })?.id);
    if (!Number.isInteger(id) || id <= 0) return errJson(reply, 400, 'id 非法');
    try {
      const r = await pool.query('SELECT * FROM agent_routines WHERE id=$1 AND user_id=$2', [id, claims.sub]);
      if (r.rowCount !== 1) return errJson(reply, 404, '例行不存在或不是你的');
      await triggerRoutine(pool, cipher, r.rows[0] as any);
      return { ok: true, triggered: true };
    } catch (err) {
      return dbErr(reply, err);
    }
  });
}
