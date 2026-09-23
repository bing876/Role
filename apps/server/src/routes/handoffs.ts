/**
 * 批次 A | 交接结构化：项目工作区 handoffs/ + board.md 单写者
 *
 * - 每个委派一个文件 handoffs/<delegationId>.md，含 目标/输入/产出要求/审批边界
 * - 委派消息只传路径不传内容
 * - board.md 单写者：只有总协调/发起方能写，序列化防丢
 * - 数据/事件做，版式归前端
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable } from '../db';
import { loadOwnedProject } from '../projectScope';
import { getBoardPath, getHandoffPath, readBoard, readHandoffFile, getHandoffDir } from '../orchestrator/handoff';
import fs from 'node:fs';

export interface HandoffDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

function errJson(reply: FastifyReply, code: number, error: string, extra?: Record<string, unknown>): FastifyReply {
  return reply.code(code).send({ error, ...extra });
}

function dbErr(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) {
    return errJson(reply, 503, '数据库连不上');
  }
  console.error('[handoff] 未分类错误：', (err as Error)?.message ?? String(err));
  return errJson(reply, 500, `服务端错误：${(err as Error)?.message ?? String(err)}`);
}

function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

export function registerHandoffRoutes(app: FastifyInstance, deps: HandoffDeps): void {
  const { pool } = deps;

  // GET /projects/:id/handoffs/board → board.md 内容
  app.get('/projects/:id/handoffs/board', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, deps.env);
    if (!claims) return errJson(reply, 401, '未登录');
    const projectId = Number((req.params as { id?: unknown })?.id);
    if (!Number.isInteger(projectId) || projectId <= 0) return errJson(reply, 400, 'projectId 非法');
    try {
      const owned = await loadOwnedProject(pool, claims.sub, projectId);
      if (!owned) return errJson(reply, 404, '项目不存在或不是你的');
      const content = readBoard(projectId);
      return { projectId, board: content };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // GET /projects/:id/handoffs → 列表
  app.get('/projects/:id/handoffs', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, deps.env);
    if (!claims) return errJson(reply, 401, '未登录');
    const projectId = Number((req.params as { id?: unknown })?.id);
    if (!Number.isInteger(projectId) || projectId <= 0) return errJson(reply, 400, 'projectId 非法');
    try {
      const owned = await loadOwnedProject(pool, claims.sub, projectId);
      if (!owned) return errJson(reply, 404, '项目不存在或不是你的');
      const dir = getHandoffDir(projectId);
      if (!fs.existsSync(dir)) return { projectId, handoffs: [] };
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'board.md');
      const list = files.map((f) => {
        const id = f.replace('.md', '');
        return { delegationId: id, path: `handoff://${projectId}/${f}`, file: f };
      });
      return { projectId, handoffs: list };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // GET /projects/:id/handoffs/:delegationId → 单个文件内容
  app.get('/projects/:id/handoffs/:delegationId', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, deps.env);
    if (!claims) return errJson(reply, 401, '未登录');
    const projectId = Number((req.params as { id?: unknown })?.id);
    const delegationId = String((req.params as { delegationId?: unknown })?.delegationId ?? '').trim();
    if (!Number.isInteger(projectId) || projectId <= 0) return errJson(reply, 400, 'projectId 非法');
    if (!delegationId) return errJson(reply, 400, 'delegationId 非法');
    try {
      const owned = await loadOwnedProject(pool, claims.sub, projectId);
      if (!owned) return errJson(reply, 404, '项目不存在或不是你的');
      const content = readHandoffFile(projectId, delegationId as any);
      if (content === null) return errJson(reply, 404, '交接文件不存在');
      return { projectId, delegationId, content, path: `handoff://${projectId}/${delegationId}.md` };
    } catch (err) {
      return dbErr(reply, err);
    }
  });
}
