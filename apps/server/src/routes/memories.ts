/**
 * 第 10 步：用户档案记忆 ——「记住这个人」。所有智能体共用同一 owner 的记忆，
 * **挂 owner_id，不按项目隔离**（memories 老表的 project_id 列保留但主逻辑不用）。
 *
 * 规矩（说明书钉死）：
 *   - preference：抽取后直接加密入库 status=active，不弹窗；
 *   - decision：status=pending，用户在确认卡上「确认」后才 active；「不用，忘掉这条」→ rejected；
 *   - fact：只在“会改变以后行为”（needs_confirm=true）时进 pending；否则整条丢弃；active 的 fact
 *     默认不注入，仅当本轮用户原话/任务目标命中其分词才追加；
 *   - pending 一律不注入；未确认永不影响行为；
 *   - 写入前必过敏感闸（密码/验证码/证件/卡号/Cookie 等原文一律丢弃该条）；
 *   - 语义去重用「规范化句子精确匹配」（不上向量库）；
 *   - 结束才抽取：任务 done/failed（服务端自触发）、聊天闲置 15 分钟（定时扫）、桌面「结束」按钮；
 *     同一会话/任务 10 分钟内不重复抽。
 *
 * 注入接口：buildMemoryBlock(pool, cipher, ownerId, userText, agentId?, conversationId?) —— chat.ts 与 agent.ts 各调一次，
 * 拼在系统提示词尾部；两条冲突以更晚为准（写进块里）。
 *
 * 记忆合并第一批：
 *   - 抽离 memoryNormalize.ts（零 import）
 *   - memories 表两级作用域：agent_id NULL=账号级，值=智能体级，project_id 可空
 *   - buildMemoryBlock / extractCore 通作用域（支持按 owner+agent 过滤）
 * 记忆合并第二批：
 *   - memories 表三级作用域：agent_id NULL + conversation_id NULL=账号级，agent_id=值+conv NULL=智能体级，conversation_id=值=会话级（只在该会话注入）
 *   - buildMemoryBlock 支持 conversationId，注入时按三级合并
 *   - extractCore 支持 conversationId，会话级记忆写入 conversation_id 列
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { MemoryExtractResult, MemoryItem, MemoryListResult } from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable } from '../db';
import { llmFetch } from '../llm';
import { REFERENCE_PREFIX, sanitizeReferenceLine } from '../promptPolicy';
import { normalizeText, isSensitive } from '../memoryNormalize';
import { extractJsonLoose, EXTRACT_PROMPT, looksLikeWorkRule, writeMemoryRow } from '../memoryShared';

export interface MemoryDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

/// 记忆合并第三批：提示词与判定收口到 memoryShared.ts
function wordHits(text: string, fact: string): boolean {
  const hay = normalizeText(text);
  if (!hay) return false;
  const whole = normalizeText(fact);
  if (whole && (hay.includes(whole) || whole.includes(hay))) return true;
  const words = fact
    .split(/[\s,，、;；.。/|]+/)
    .map((w) => normalizeText(w))
    .filter((w) => w.length >= 2);
  for (const w of words) {
    if (w.length <= 3) {
      if (hay.includes(w)) return true;
      continue;
    }
    for (let i = 0; i + 4 <= w.length; i += 1) {
      if (hay.includes(w.slice(i, i + 4))) return true;
    }
  }
  return false;
}

/** 同会话/同任务 10 分钟内不重复抽（进程内即可：重启后重复抽也会被“句子去重”挡住，不会重复入库） */
const DEDUP_MS = 10 * 60_000;
const lastExtractAt = new Map<string, number>();
const MAX_ITEMS = 5;
const CONTENT_MAX = 120;

function errJson(reply: FastifyReply, code: number, error: string, extra?: Record<string, unknown>): FastifyReply {
  return reply.code(code).send({ error, ...extra });
}

function dbErr(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) {
    return errJson(reply, 503, '数据库连不上：先 npm run db:up（或 docker compose -f apps/server/docker-compose.yml up -d）');
  }
  console.error('[memories] 未分类错误：', (err as Error)?.message ?? String(err));
  return errJson(reply, 500, `服务端错误：${(err as Error)?.message ?? String(err)}`);
}

function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

// extractJsonLoose 已收口到 memoryShared.ts

/**
 * 注入块：active preference+decision 全带上；active fact 仅命中才带。
 * 三级作用域：
 *   - 账号级：agent_id IS NULL AND conversation_id IS NULL
 *   - 智能体级：agent_id = ? AND conversation_id IS NULL
 *   - 会话级：conversation_id = ?（只在该会话注入）
 */
export async function buildMemoryBlock(
  pool: Pool,
  cipher: JsonCipher,
  ownerId: number,
  userText: string,
  agentId?: number | null,
  conversationId?: number | null,
): Promise<string> {
  try {
    const aid = Number(agentId);
    const hasAgent = Number.isInteger(aid) && aid > 0;
    const cid = Number(conversationId);
    const hasConv = Number.isInteger(cid) && cid > 0;

    let coreQuery: { text: string; values: unknown[] };
    let factQuery: { text: string; values: unknown[] };

    if (hasConv && hasAgent) {
      coreQuery = {
        text: `SELECT type, content_encrypted FROM memories
                WHERE owner_id = $1 AND status = 'active' AND type IN ('preference', 'decision')
                  AND content_encrypted IS NOT NULL
                  AND ((agent_id IS NULL AND conversation_id IS NULL) OR (agent_id = $2 AND conversation_id IS NULL) OR (conversation_id = $3))
                ORDER BY updated_at DESC, id DESC LIMIT 30`,
        values: [ownerId, aid, cid],
      };
      factQuery = {
        text: `SELECT content_encrypted FROM memories
                WHERE owner_id = $1 AND status = 'active' AND type = 'fact'
                  AND content_encrypted IS NOT NULL
                  AND ((agent_id IS NULL AND conversation_id IS NULL) OR (agent_id = $2 AND conversation_id IS NULL) OR (conversation_id = $3))
                ORDER BY updated_at DESC LIMIT 15`,
        values: [ownerId, aid, cid],
      };
    } else if (hasConv) {
      coreQuery = {
        text: `SELECT type, content_encrypted FROM memories
                WHERE owner_id = $1 AND status = 'active' AND type IN ('preference', 'decision')
                  AND content_encrypted IS NOT NULL
                  AND ((agent_id IS NULL AND conversation_id IS NULL) OR (conversation_id = $2))
                ORDER BY updated_at DESC, id DESC LIMIT 30`,
        values: [ownerId, cid],
      };
      factQuery = {
        text: `SELECT content_encrypted FROM memories
                WHERE owner_id = $1 AND status = 'active' AND type = 'fact'
                  AND content_encrypted IS NOT NULL
                  AND ((agent_id IS NULL AND conversation_id IS NULL) OR (conversation_id = $2))
                ORDER BY updated_at DESC LIMIT 15`,
        values: [ownerId, cid],
      };
    } else if (hasAgent) {
      coreQuery = {
        text: `SELECT type, content_encrypted FROM memories
                WHERE owner_id = $1 AND status = 'active' AND type IN ('preference', 'decision')
                  AND content_encrypted IS NOT NULL
                  AND ((agent_id IS NULL AND conversation_id IS NULL) OR (agent_id = $2 AND conversation_id IS NULL))
                ORDER BY updated_at DESC, id DESC LIMIT 20`,
        values: [ownerId, aid],
      };
      factQuery = {
        text: `SELECT content_encrypted FROM memories
                WHERE owner_id = $1 AND status = 'active' AND type = 'fact'
                  AND content_encrypted IS NOT NULL
                  AND ((agent_id IS NULL AND conversation_id IS NULL) OR (agent_id = $2 AND conversation_id IS NULL))
                ORDER BY updated_at DESC LIMIT 10`,
        values: [ownerId, aid],
      };
    } else {
      coreQuery = {
        text: `SELECT type, content_encrypted FROM memories
                WHERE owner_id = $1 AND status = 'active' AND type IN ('preference', 'decision')
                  AND content_encrypted IS NOT NULL
                  AND agent_id IS NULL AND conversation_id IS NULL
                ORDER BY updated_at DESC, id DESC LIMIT 20`,
        values: [ownerId],
      };
      factQuery = {
        text: `SELECT content_encrypted FROM memories
                WHERE owner_id = $1 AND status = 'active' AND type = 'fact'
                  AND content_encrypted IS NOT NULL
                  AND agent_id IS NULL AND conversation_id IS NULL
                ORDER BY updated_at DESC LIMIT 10`,
        values: [ownerId],
      };
    }

    const core = await pool.query<{ type: string; content_encrypted: string | null }>(coreQuery.text, coreQuery.values);
    const lines: string[] = [];
    const seen = new Set<string>();
    const label = (t: string): string => (t === 'preference' ? '偏好' : t === 'decision' ? '决定' : '事实');
    for (const r of core.rows) {
      let text = '';
      try {
        text = cipher.decryptText(String(r.content_encrypted));
      } catch {
        continue;
      }
      if (isSensitive(text)) continue;
      const line = sanitizeReferenceLine(text);
      if (!line || seen.has(line)) continue;
      seen.add(line);
      lines.push(`- [${label(r.type)}] ${line}`);
    }
    if (lines.length > 0) lines.push('若两条冲突，以更晚的为准；与用户本轮最新指令冲突，以最新指令为准。');

    const facts = await pool.query<{ content_encrypted: string }>(factQuery.text, factQuery.values);
    for (const f of facts.rows) {
      let text = '';
      try {
        text = cipher.decryptText(String(f.content_encrypted));
      } catch {
        continue;
      }
      if (isSensitive(text)) continue;
      if (!wordHits(userText, text)) continue;
      const line = sanitizeReferenceLine(text);
      if (!line || seen.has(line)) continue;
      seen.add(line);
      lines.push(`- [事实·本轮相关] ${line}`);
    }
    if (lines.length === 0) return '';
    return ['【参考·用户档案记忆（该用户此前定下的）】', REFERENCE_PREFIX, ...lines].join('\n');
  } catch (err) {
    if (!isDbUnreachable(err)) console.warn('[memories] 注入块拼装失败（忽略，照常服务）：', (err as Error).message);
    return '';
  }
}

interface CoreOutcome {
  extracted: number;
  pending: MemoryItem[];
  skipped?: string;
}

/** 真正干活的抽取。source: 'chat_end' | 'chat_idle' | 'task_end' */
async function extractCore(
  deps: MemoryDeps,
  ownerId: number,
  source: string,
  transcript: string,
  dedupKey: string,
  agentId?: number | null,
  conversationId?: number | null,
): Promise<CoreOutcome> {
  const { pool, env, cipher } = deps;
  const now = Date.now();
  const last = lastExtractAt.get(dedupKey) ?? 0;
  if (now - last < DEDUP_MS) return { extracted: 0, pending: [], skipped: 'dedup_10min' };
  lastExtractAt.set(dedupKey, now);
  if (lastExtractAt.size > 500) {
    const oldestKey = lastExtractAt.keys().next().value;
    if (oldestKey !== undefined) lastExtractAt.delete(oldestKey);
  }
  if (!transcript.trim()) return { extracted: 0, pending: [], skipped: 'empty_transcript' };
  if (!env.deepseekApiKey) return { extracted: 0, pending: [], skipped: 'llm_not_configured' };
  const empty: CoreOutcome = { extracted: 0, pending: [] };
  let raw: { items?: unknown };
  try {
    const r = await llmFetch(
      env,
      [
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: `记录如下：\n${transcript.slice(-6000)}` },
      ],
      { tag: `memories/extract:${source}`, json: true, temperature: 0.2 },
    );
    if (!r.ok) return { ...empty, skipped: `upstream_http_${r.status}` };
    const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const parsed = extractJsonLoose(data.choices?.[0]?.message?.content ?? '');
    if (!parsed || typeof parsed !== 'object') return { ...empty, skipped: 'bad_model_json' };
    raw = parsed as { items?: unknown };
  } catch (err) {
    return { ...empty, skipped: `model_unreachable:${(err as Error).message.slice(0, 60)}` };
  }
  const list = Array.isArray(raw.items) ? raw.items.slice(0, MAX_ITEMS) : [];
  if (list.length === 0) return { ...empty, skipped: 'nothing_worth_remembering' };

  // 去重基线：按作用域查（三级）
  const aid = Number(agentId);
  const hasAgent = Number.isInteger(aid) && aid > 0;
  const cid = Number(conversationId);
  const hasConv = Number.isInteger(cid) && cid > 0;

  let existQuery: { text: string; values: unknown[] };
  if (hasConv && hasAgent) {
    existQuery = {
      text: `SELECT mem_key FROM memories WHERE owner_id = $1 AND status IN ('pending', 'active', 'rejected') AND ((agent_id IS NULL AND conversation_id IS NULL) OR (agent_id = $2 AND conversation_id IS NULL) OR (conversation_id = $3))`,
      values: [ownerId, aid, cid],
    };
  } else if (hasConv) {
    existQuery = {
      text: `SELECT mem_key FROM memories WHERE owner_id = $1 AND status IN ('pending', 'active', 'rejected') AND ((agent_id IS NULL AND conversation_id IS NULL) OR (conversation_id = $2))`,
      values: [ownerId, cid],
    };
  } else if (hasAgent) {
    existQuery = {
      text: `SELECT mem_key FROM memories WHERE owner_id = $1 AND status IN ('pending', 'active', 'rejected') AND ((agent_id IS NULL AND conversation_id IS NULL) OR (agent_id = $2 AND conversation_id IS NULL))`,
      values: [ownerId, aid],
    };
  } else {
    existQuery = {
      text: `SELECT mem_key FROM memories WHERE owner_id = $1 AND status IN ('pending', 'active', 'rejected') AND agent_id IS NULL AND conversation_id IS NULL`,
      values: [ownerId],
    };
  }
  const exist = await pool.query<{ mem_key: string }>(existQuery.text, existQuery.values);
  const seen = new Set(exist.rows.map((r) => r.mem_key));

  let inserted = 0;
  const pending: MemoryItem[] = [];
  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>;
    const rawType = String(o.type ?? '');
    if (!['preference', 'decision', 'fact'].includes(rawType)) continue;
    const content = typeof o.content === 'string' ? o.content.trim().slice(0, CONTENT_MAX) : '';
    if (content.length < 2) continue;
    let type = rawType;
    if (looksLikeWorkRule(content)) {
      type = 'decision';
      if (rawType !== 'decision') {
        console.warn(`[memories] 「${content.slice(0, 20)}…」被判定为工作方式规则：强制 decision + pending（模型给的是 ${rawType}）`);
      }
    }
    const needs = type === 'preference' ? false : type === 'decision' ? true : Boolean(o.needs_confirm);
    if (type === 'fact' && !needs) continue;
    if (isSensitive(content)) {
      console.warn('[memories] 一条疑似敏感内容在写入前被丢弃（不落库、不入卡）');
      continue;
    }
    const key = normalizeText(content);
    if (seen.has(key)) continue;
    seen.add(key);
    const status = needs ? 'pending' : 'active';
    const enc = cipher.encryptText(content);
    // 三级作用域写入（统一走 memoryShared.writeMemoryRow）
    const written = await writeMemoryRow({
      pool,
      cipher,
      ownerId,
      agentId: hasAgent ? aid : null,
      conversationId: hasConv ? cid : null,
      memKey: key,
      contentEnc: enc,
      type,
      source,
      status,
      needsConfirm: needs,
    });
    // 兼容旧计数：若 ON CONFLICT DO NOTHING 返回 0，也算已处理过（幂等），但不计入 extracted
    if (written === 0) {
      // 已存在，跳过 pending 回查
      continue;
    }
    inserted += 1;
    if (needs) {
      let idq;
      if (hasConv && hasAgent) {
        idq = await pool.query<{ id: string }>(
          'SELECT id FROM memories WHERE owner_id = $1 AND conversation_id = $2 AND mem_key = $3 ORDER BY id DESC LIMIT 1',
          [ownerId, cid, key],
        );
      } else if (hasConv) {
        idq = await pool.query<{ id: string }>(
          'SELECT id FROM memories WHERE owner_id = $1 AND conversation_id = $2 AND mem_key = $3 ORDER BY id DESC LIMIT 1',
          [ownerId, cid, key],
        );
      } else if (hasAgent) {
        idq = await pool.query<{ id: string }>(
          'SELECT id FROM memories WHERE owner_id = $1 AND agent_id = $2 AND conversation_id IS NULL AND mem_key = $3 ORDER BY id DESC LIMIT 1',
          [ownerId, aid, key],
        );
      } else {
        idq = await pool.query<{ id: string }>(
          'SELECT id FROM memories WHERE owner_id = $1 AND agent_id IS NULL AND conversation_id IS NULL AND mem_key = $2 ORDER BY id DESC LIMIT 1',
          [ownerId, key],
        );
      }
      if (idq.rowCount === 1) {
        pending.push({
          id: Number(idq.rows[0].id),
          type: type as MemoryItem['type'],
          content,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }
  return { extracted: inserted, pending };
}

/** 任务 done/failed 时由 agent 路由调用（fire-and-forget，失败只静默） */
export function triggerTaskExtract(
  deps: MemoryDeps,
  ownerId: number,
  taskId: number,
  payload: unknown,
  agentId?: number | null,
  conversationId?: number | null,
): void {
  setImmediate(() => {
    void (async () => {
      const pl = (payload ?? {}) as { goal?: string; steps?: string[]; doc?: { summary?: string } };
      const transcript = [
        `任务目标：${pl.goal ?? ''}`,
        '步骤：',
        ...(pl.steps ?? []).map((x, i) => `${i + 1}. ${x}`),
        pl.doc?.summary ? `结论：${pl.doc.summary}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      await extractCore(deps, ownerId, 'task_end', transcript, `task:${taskId}`, agentId ?? null, conversationId ?? null);
    })().catch((err) => console.warn('[memories] 任务收尾提取失败（忽略）：', (err as Error).message));
  });
}

/**
 * 闲置 15 分钟自动提取：每分钟扫一轮（进程内记“处理到哪个消息号”，同一切点不重抽）。
 */
export function startIdleScheduler(deps: MemoryDeps, intervalMs = 60_000): NodeJS.Timeout {
  const done = new Set<string>();
  const timer = setInterval(() => {
    void (async () => {
      const { pool } = deps;
      const r = await pool.query<{ conv_id: string; user_id: string; agent_id: string | null; last_id: string | null; last_at: string | null }>(
        `SELECT c.id AS conv_id, p.user_id, c.agent_id, MAX(m.id) AS last_id, MAX(m.created_at) AS last_at
           FROM conversations c
           JOIN projects p ON p.id = c.project_id
           LEFT JOIN messages m ON m.conversation_id = c.id
          WHERE COALESCE(c.keepalive, false) = false
          GROUP BY c.id, p.user_id, c.agent_id`,
      );
      const now = Date.now();
      for (const row of r.rows) {
        if (!row.last_id || !row.last_at) continue;
        const ago = now - new Date(row.last_at).getTime();
        if (ago < 15 * 60_000 || ago > 60 * 60_000) continue;
        const key = `c${row.conv_id}:${row.last_id}`;
        if (done.has(key)) continue;
        done.add(key);
        if (done.size > 800) done.clear();
        const msgs = await pool.query<{ role: string; content_enc: string }>(
          'SELECT role, content_enc FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 40',
          [Number(row.conv_id)],
        );
        const transcript = msgs.rows
          .reverse()
          .map((x) => {
            let text = '';
            try {
              text = deps.cipher.decryptText(x.content_enc);
            } catch {
              return '';
            }
            return `${x.role === 'user' ? '用户' : '小助'}：${text}`;
          })
          .filter(Boolean)
          .join('\n');
        console.log(`[memories] 会话 ${row.conv_id} 闲置 ${Math.round(ago / 60_000)} 分钟 → 整理一次记忆`);
        const agentId = row.agent_id ? Number(row.agent_id) : null;
        const convId = Number(row.conv_id);
        await extractCore(deps, Number(row.user_id), 'chat_idle', transcript, `conv:${row.conv_id}:idle`, agentId, convId);
      }
    })().catch((err) => {
      if (!isDbUnreachable(err)) console.warn('[memories] 闲置扫描跳过：', (err as Error).message);
    });
  }, intervalMs);
  timer.unref?.();
  return timer;
}

/** 会话记录取数（桌面「结束」按钮用）：只取该用户自己的会话 */
async function conversationTranscript(deps: MemoryDeps, ownerId: number, conversationId: number): Promise<string | null> {
  const own = await deps.pool.query<{ id: string }>(
    'SELECT c.id FROM conversations c JOIN projects p ON p.id = c.project_id WHERE c.id = $1 AND p.user_id = $2',
    [conversationId, ownerId],
  );
  if (own.rowCount !== 1) return null;
  const msgs = await deps.pool.query<{ role: string; content_enc: string }>(
    'SELECT role, content_enc FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 40',
    [conversationId],
  );
  return msgs.rows
    .reverse()
    .map((x) => {
      let text = '';
      try {
        text = deps.cipher.decryptText(x.content_enc);
      } catch {
        return '';
      }
      return `${x.role === 'user' ? '用户' : '小助'}：${text}`;
    })
    .filter(Boolean)
    .join('\n');
}

export function registerMemoryRoutes(app: FastifyInstance, deps: MemoryDeps): void {
  const { pool, env, cipher } = deps;

  app.post('/memories/extract', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = req.body as { conversationId?: unknown; agentId?: unknown } | null;
    const convId = Number(b?.conversationId);
    const agentId = Number(b?.agentId);
    if (!Number.isInteger(convId) || convId <= 0) return errJson(reply, 400, 'conversationId 必填（先聊过一次）');
    try {
      const transcript = await conversationTranscript(deps, claims.sub, convId);
      if (transcript === null) return errJson(reply, 404, '会话不存在或不是你的');
      const out = await extractCore(
        deps,
        claims.sub,
        'chat_end',
        transcript,
        `conv:${convId}`,
        Number.isInteger(agentId) && agentId > 0 ? agentId : null,
        convId,
      );
      return out satisfies MemoryExtractResult;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.get('/memories', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    try {
      const q = req.query as { agentId?: unknown; conversationId?: unknown } | null;
      const agentIdRaw = Number(q?.agentId);
      const convIdRaw = Number(q?.conversationId);
      const hasAgent = Number.isInteger(agentIdRaw) && agentIdRaw > 0;
      const hasConv = Number.isInteger(convIdRaw) && convIdRaw > 0;
      const statusFilter = (status: string) => {
        if (hasConv && hasAgent) {
          return {
            text: `SELECT id, type, content_encrypted, updated_at, agent_id, conversation_id FROM memories WHERE owner_id = $1 AND status = $2 AND content_encrypted IS NOT NULL AND ((agent_id IS NULL AND conversation_id IS NULL) OR (agent_id = $3 AND conversation_id IS NULL) OR (conversation_id = $4)) ORDER BY updated_at DESC, id DESC LIMIT 50`,
            values: [claims.sub, status, agentIdRaw, convIdRaw],
          };
        }
        if (hasConv) {
          return {
            text: `SELECT id, type, content_encrypted, updated_at, agent_id, conversation_id FROM memories WHERE owner_id = $1 AND status = $2 AND content_encrypted IS NOT NULL AND ((agent_id IS NULL AND conversation_id IS NULL) OR (conversation_id = $3)) ORDER BY updated_at DESC, id DESC LIMIT 50`,
            values: [claims.sub, status, convIdRaw],
          };
        }
        if (hasAgent) {
          return {
            text: `SELECT id, type, content_encrypted, updated_at, agent_id, conversation_id FROM memories WHERE owner_id = $1 AND status = $2 AND content_encrypted IS NOT NULL AND ((agent_id IS NULL AND conversation_id IS NULL) OR (agent_id = $3 AND conversation_id IS NULL)) ORDER BY updated_at DESC, id DESC LIMIT 50`,
            values: [claims.sub, status, agentIdRaw],
          };
        }
        return {
          text: `SELECT id, type, content_encrypted, updated_at, agent_id, conversation_id FROM memories WHERE owner_id = $1 AND status = $2 AND content_encrypted IS NOT NULL AND agent_id IS NULL AND conversation_id IS NULL ORDER BY updated_at DESC, id DESC LIMIT 50`,
          values: [claims.sub, status],
        };
      };
      const fetch = async (status: string) => {
        const qq = statusFilter(status);
        const r = await pool.query<{ id: string; type: string; content_encrypted: string | null; updated_at: Date | string }>(qq.text, qq.values);
        const out: MemoryItem[] = [];
        for (const row of r.rows) {
          let text = '';
          try {
            text = cipher.decryptText(String(row.content_encrypted));
          } catch {
            continue;
          }
          out.push({
            id: Number(row.id),
            type: (row.type === 'decision' || row.type === 'fact' ? row.type : 'preference') as MemoryItem['type'],
            content: text,
            updatedAt: typeof row.updated_at === 'string' ? row.updated_at : new Date(row.updated_at).toISOString(),
          });
        }
        return out;
      };
      const result: MemoryListResult = { active: await fetch('active'), pending: await fetch('pending') };
      return result;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  const decide = (target: 'active' | 'rejected') => async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = req.body as { all?: unknown; ids?: unknown } | null;
    try {
      if (b?.all === true) {
        await pool.query('UPDATE memories SET status = $2, updated_at = now() WHERE owner_id = $1 AND status = $3', [
          claims.sub,
          target,
          'pending',
        ]);
        return { ok: true, target };
      }
      const ids = Array.isArray(b?.ids) ? (b.ids as unknown[]).map(Number).filter(Number.isInteger).slice(0, 10) : [];
      if (ids.length === 0) return errJson(reply, 400, 'all 或 ids 至少给一个');
      for (const id of ids) {
        await pool.query(
          'UPDATE memories SET status = $2, updated_at = now() WHERE id = $3 AND owner_id = $1 AND status = $4',
          [claims.sub, target, id, 'pending'],
        );
      }
      return { ok: true, changed: ids.length, target };
    } catch (err) {
      return dbErr(reply, err);
    }
  };
  app.post('/memories/confirm', decide('active'));
  app.post('/memories/reject', decide('rejected'));

  app.post('/memories/forget', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const id = Number((req.body as { id?: unknown } | null)?.id);
    if (!Number.isInteger(id)) return errJson(reply, 400, 'id 必填');
    try {
      const r = await pool.query(
        "UPDATE memories SET status = 'archived', updated_at = now() WHERE id = $1 AND owner_id = $2 AND status = 'active'",
        [id, claims.sub],
      );
      if (r.rowCount !== 1) return errJson(reply, 404, '这条记忆不存在、不是你的，或已不是生效状态');
      return { ok: true };
    } catch (err) {
      return dbErr(reply, err);
    }
  });
}
