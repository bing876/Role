/**
 * 批次 H | 电脑三级可见度 — Status/Preview(侧边钉住)/Takeover，默认收起
 * 依据 Grok：电脑越显眼，用户越被迫去监督它
 *
 * 三档：
 * - status：只显示状态芯片（running/waiting/done/paused），默认收起
 * - preview：侧边钉住，显示当前工具调用/页面摘要，不抢焦点
 * - takeover：全屏接管，用户必须监督，浏览器前置
 *
 * 存储：agents.computer_visibility，默认 status
 * API：
 *   GET /agents/:id/visibility → {visibility}
 *   POST /agents/:id/visibility {visibility} → 更新
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable } from '../db';

export type ComputerVisibility = 'status' | 'preview' | 'takeover';

export interface ComputerVisibilityDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

function errJson(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ error });
}
function dbErr(reply: FastifyReply, err: unknown) {
  if (isDbUnreachable(err)) return errJson(reply, 503, '数据库连不上');
  const msg = (err as Error)?.message ?? String(err);
  console.error('[computerVisibility] 错误：', msg);
  return errJson(reply, 500, `服务端错误：${msg}`);
}
function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

const VALID: ComputerVisibility[] = ['status', 'preview', 'takeover'];

export function registerComputerVisibilityRoutes(app: FastifyInstance, { pool, env }: ComputerVisibilityDeps): void {
  app.get('/agents/:id/visibility', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录');
    const agentId = Number((req.params as { id?: unknown })?.id);
    if (!Number.isInteger(agentId) || agentId <= 0) return errJson(reply, 400, 'id 非法');
    try {
      const r = await pool.query<{ computer_visibility: string }>(
        `SELECT a.computer_visibility FROM agents a JOIN projects p ON p.id = a.project_id WHERE a.id=$1 AND p.user_id=$2`,
        [agentId, claims.sub],
      );
      if (r.rowCount === 0) return errJson(reply, 404, '智能体不存在或不是你的');
      const v = (r.rows[0].computer_visibility as ComputerVisibility) ?? 'status';
      return { agentId, visibility: VALID.includes(v) ? v : 'status' };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.post('/agents/:id/visibility', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录');
    const agentId = Number((req.params as { id?: unknown })?.id);
    if (!Number.isInteger(agentId) || agentId <= 0) return errJson(reply, 400, 'id 非法');
    const body = req.body as { visibility?: unknown } | null;
    const v = typeof body?.visibility === 'string' ? body.visibility.trim() as ComputerVisibility : null;
    if (!v || !VALID.includes(v)) return errJson(reply, 400, `visibility 只能是 ${VALID.join('/')}`);
    try {
      const r = await pool.query(
        `UPDATE agents SET computer_visibility=$1 WHERE id=$2 AND project_id IN (SELECT id FROM projects WHERE user_id=$3) RETURNING id`,
        [v, agentId, claims.sub],
      );
      if (r.rowCount === 0) return errJson(reply, 404, '智能体不存在或不是你的');
      return { agentId, visibility: v };
    } catch (err) {
      return dbErr(reply, err);
    }
  });
}
