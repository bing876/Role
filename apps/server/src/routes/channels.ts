/**
 * 多智能体编排 · **内部频道的读接口**（用户看智能体之间怎么交流的）。
 *
 *   GET /agents/channels                    → 我的频道列表（?projectId= 可只看一个项目）
 *   GET /agents/channels/:id/messages       → 某条频道的对话（?limit=&beforeId=）
 *   GET /agents/channels/:id/delegations    → 某条频道里的委派记录（含状态与结论）
 *
 * ★ 三条**只读**接口。没有「替智能体发消息」「改委派状态」这类写接口 ——
 *   内部频道是智能体之间的交流，用户是**读者**；要插手就自己下指令（那走 /chat 或 /agent/loop）。
 *
 * ★ 权限：只回自己的（`user_id = claims.sub`）。查别人的频道一律 **404**，
 *   与 `/agents` 那一套同一口径 —— 404 而不是 403，是不泄漏「这条频道到底存不存在」。
 *
 * ★ 正文在库里是密文（`content_enc`），这里解密后回。所以这些接口**必须**要 JWT，
 *   而且不能加缓存头（回的是明文对话）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { ChannelListResult, ChannelMessagesResult, DelegationListResult } from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable } from '../db';
import { channelMessages, listChannels, listDelegations } from '../orchestrator/channels';

export interface ChannelDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

function errJson(reply: FastifyReply, code: number, error: string, extra?: Record<string, unknown>): FastifyReply {
  return reply.code(code).send({ error, ...extra });
}

function dbErr(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) {
    return errJson(reply, 503, '数据库连不上：先 npm run db:up（或 docker compose -f apps/server/docker-compose.yml up -d）');
  }
  console.error('[channels] 未分类错误：', (err as Error)?.message ?? String(err));
  return errJson(reply, 500, `服务端错误：${(err as Error)?.message ?? String(err)}`);
}

function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

/** query 里的 id：只认正整数，其余一律 null（NaN/0/-3/字符串都要挡住） */
function positiveInt(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function registerChannelRoutes(app: FastifyInstance, { pool, env, cipher }: ChannelDeps): void {
  /** 我的频道列表（按最近一条消息倒序） */
  app.get('/agents/channels', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const q = req.query as { projectId?: unknown } | null;
    try {
      // projectId 没传 = 看全部项目（null 进 SQL 后是「不过滤」）
      const channels = await listChannels(pool, cipher, claims.sub, positiveInt(q?.projectId));
      return { channels } satisfies ChannelListResult;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  /** 某条频道的对话（不是自己的 → 404，不泄漏存在性） */
  app.get('/agents/channels/:id/messages', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const channelId = positiveInt((req.params as { id?: unknown })?.id);
    if (channelId === null) return errJson(reply, 400, '频道 id 必须是一个正整数');
    const q = req.query as { limit?: unknown; beforeId?: unknown } | null;
    try {
      const found = await channelMessages(pool, cipher, claims.sub, channelId, {
        ...(positiveInt(q?.limit) ? { limit: positiveInt(q?.limit) as number } : {}),
        ...(positiveInt(q?.beforeId) ? { beforeId: positiveInt(q?.beforeId) as number } : {}),
      });
      if (!found) return errJson(reply, 404, '这条频道不存在或不是你的');
      return found satisfies ChannelMessagesResult;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  /** 某条频道里的委派记录（状态 + 结论 + 超时原因） */
  app.get('/agents/channels/:id/delegations', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const channelId = positiveInt((req.params as { id?: unknown })?.id);
    if (channelId === null) return errJson(reply, 400, '频道 id 必须是一个正整数');
    const q = req.query as { limit?: unknown } | null;
    try {
      // 先用 listChannels 那条「只回自己的」口径确认归属：
      // 不然「别人的频道 id」会回一个空列表，等于告诉对方「这频道没有委派」（仍是泄漏）。
      const owned = await listChannels(pool, cipher, claims.sub, null);
      if (!owned.some((c) => c.id === channelId)) return errJson(reply, 404, '这条频道不存在或不是你的');
      const delegations = await listDelegations(pool, {
        userId: claims.sub,
        channelId,
        ...(positiveInt(q?.limit) ? { limit: positiveInt(q?.limit) as number } : {}),
      });
      return { delegations } satisfies DelegationListResult;
    } catch (err) {
      return dbErr(reply, err);
    }
  });
}
