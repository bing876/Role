/**
 * 批次 F | Skills CRUD — teach-a-task
 *
 * POST /skills — 教一个任务，落成 skills 表
 * GET /skills?projectId= — 列表
 * POST /skills/:id/revise — 自我修订
 * DELETE /skills/:id — 归档
 *
 * 加密：所有敏感字段走 cipher.encryptText
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable } from '../db';
import { createSkill, listSkills, reviseSkill, archiveSkill } from '../orchestrator/skills';

export interface SkillsDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

function errJson(reply: FastifyReply, code: number, error: string, extra?: Record<string, unknown>) {
  return reply.code(code).send({ error, ...extra });
}
function dbErr(reply: FastifyReply, err: unknown) {
  if (isDbUnreachable(err)) return errJson(reply, 503, '数据库连不上');
  const msg = (err as Error)?.message ?? String(err);
  console.error('[skills] 错误：', msg);
  return errJson(reply, 500, `服务端错误：${msg}`);
}
function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

export function registerSkillsRoutes(app: FastifyInstance, { pool, env, cipher }: SkillsDeps): void {
  // 列表
  app.get('/skills', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录');
    const q = req.query as { projectId?: unknown } | null;
    let projectId: number | null = null;
    if (q?.projectId !== undefined && q?.projectId !== '') {
      const n = Number(q.projectId);
      if (Number.isInteger(n) && n > 0) projectId = n;
    }
    try {
      const list = await listSkills(pool, cipher, claims.sub, projectId);
      return { skills: list };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // 创建：教一个任务
  app.post('/skills', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录');
    const body = req.body as {
      projectId?: unknown;
      agentId?: unknown;
      name?: unknown;
      triggerCondition?: unknown;
      steps?: unknown;
      decisionRules?: unknown;
      outputRequirements?: unknown;
      approvalBoundary?: unknown;
    } | null;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const trigger = typeof body?.triggerCondition === 'string' ? body.triggerCondition.trim() : '';
    if (!name || !trigger) return errJson(reply, 400, 'name 和 triggerCondition 必填');
    if (name.length > 60) return errJson(reply, 400, 'name 最长 60 字');
    if (trigger.length > 500) return errJson(reply, 400, 'triggerCondition 最长 500 字');
    let steps: string[] = [];
    if (Array.isArray(body?.steps)) steps = body.steps.map((x) => String(x)).filter(Boolean);
    else if (typeof body?.steps === 'string') steps = body.steps.split('\n').map((s) => s.trim()).filter(Boolean);
    if (steps.length === 0) return errJson(reply, 400, 'steps 至少 1 条');
    if (steps.length > 20) return errJson(reply, 400, 'steps 最多 20 条');
    const decision = typeof body?.decisionRules === 'string' ? body.decisionRules : '';
    const output = typeof body?.outputRequirements === 'string' ? body.outputRequirements : '';
    const approval = typeof body?.approvalBoundary === 'string' ? body.approvalBoundary : '';
    let projectId: number | null = null;
    if (body?.projectId !== undefined && body?.projectId !== '') {
      const n = Number(body.projectId);
      if (Number.isInteger(n) && n > 0) projectId = n;
    }
    let agentId: number | null = null;
    if (body?.agentId !== undefined && body?.agentId !== '') {
      const n = Number(body.agentId);
      if (Number.isInteger(n) && n > 0) agentId = n;
    }
    try {
      const skill = await createSkill(pool, cipher, {
        userId: claims.sub,
        projectId,
        agentId,
        name,
        triggerCondition: trigger,
        steps,
        decisionRules: decision,
        outputRequirements: output,
        approvalBoundary: approval,
      });
      if (!skill) return errJson(reply, 500, '创建失败');
      return { skill };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // 修订
  app.post('/skills/:id/revise', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录');
    const params = req.params as { id?: unknown };
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) return errJson(reply, 400, 'id 非法');
    const body = req.body as {
      triggerCondition?: unknown;
      steps?: unknown;
      decisionRules?: unknown;
      outputRequirements?: unknown;
      approvalBoundary?: unknown;
    } | null;
    const patch: any = {};
    if (typeof body?.triggerCondition === 'string') patch.triggerCondition = body.triggerCondition;
    if (Array.isArray(body?.steps)) patch.steps = body.steps.map((x) => String(x));
    else if (typeof body?.steps === 'string') patch.steps = body.steps.split('\n');
    if (typeof body?.decisionRules === 'string') patch.decisionRules = body.decisionRules;
    if (typeof body?.outputRequirements === 'string') patch.outputRequirements = body.outputRequirements;
    if (typeof body?.approvalBoundary === 'string') patch.approvalBoundary = body.approvalBoundary;
    try {
      const skill = await reviseSkill(pool, cipher, claims.sub, id, patch);
      if (!skill) return errJson(reply, 404, '技能不存在或不是你的');
      return { skill };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // 归档
  app.delete('/skills/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录');
    const params = req.params as { id?: unknown };
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) return errJson(reply, 400, 'id 非法');
    try {
      const ok = await archiveSkill(pool, claims.sub, id);
      if (!ok) return errJson(reply, 404, '技能不存在或已归档');
      return { ok: true };
    } catch (err) {
      return dbErr(reply, err);
    }
  });
}
