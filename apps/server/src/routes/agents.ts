/**
 * 第 15 步：多智能体（添加 + 聊天内引导表）+ 两层记忆。
 *
 * 记忆合并第一批后：
 *   - 单一 memories 表，两级作用域：agent_id NULL=账号级（用户记忆库），值=智能体级（项目记忆）
 *   - user_memories / agent_memories 旧表已由 db.ts 幂等迁移后 DROP
 *   - 本文件所有读写一律走 memories 表，接口面保持不变
 * 记忆合并第二批：
 *   - 三级作用域：conversation_id 加入，账号级=agent_id NULL+conv NULL，智能体级=agent_id=值+conv NULL，会话级=conv=值
 *   - 本文件查询显式过滤 conversation_id IS NULL，避免会话级串入账号/智能体列表
 *
 * 接口面（全部要 JWT）：
 *   GET    /agents                 → 我的智能体列表（含人设状态 + 各自的会话号）
 *   POST   /agents                 → 点「添加」：建一个智能体 + 立刻给它建一条空会话
 *   POST   /agents/:id/persona     → 引导表确认：存人设 → persona_status='ready'，之后按它干活
 *   DELETE /agents/:id             → 删自建智能体（「小助」恒不可删）
 *   POST   /agents/:id/tidy        → 把这段聊天**总结**进两层记忆（不存整段聊天）
 *   GET    /memory/user            → 用户记忆库（账号级，memories.agent_id IS NULL）
 *   GET    /agents/:id/memory      → 这个智能体的项目记忆（memories.agent_id = id）
 *   POST   /memory/forget          → {layer:'user'|'agent', id} 忘掉一条（走 memories.status=archived）
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type {
  AgentCreateResult,
  AgentListResult,
  AgentPersona,
  AgentTidyResult,
  AgentView,
  MemoryEntry,
  MemoryLayerList,
} from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable, withTx } from '../db';
import { llmFetch } from '../llm';
import { REFERENCE_PREFIX, sanitizeReferenceLine } from '../promptPolicy';
import { keepaliveOfAgent } from '../sessionState';
import { HEN_KIND, isProtectedKind, loadOwnedProject, resolveAgentCreator } from '../projectScope';
import { isSensitive, normalizeText } from '../memoryNormalize';
import { extractJsonLoose, TIDY_PROMPT, UNIFIED_TIDY_PROMPT, writeTidyLayer } from '../memoryShared';

export interface AgentDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

/** 新建智能体的默认名；引导表确认后会被用户填的名称替换 */
export const DEFAULT_AGENT_NAME = '新智能体';
const NAME_MAX = 24;
const PERSONA_FIELD_MAX = 120;
const MEM_CONTENT_MAX = 120;
const MEM_MAX_PER_LAYER = 5;
const TRANSCRIPT_MAX = 6000;

function errJson(reply: FastifyReply, code: number, error: string, extra?: Record<string, unknown>): FastifyReply {
  return reply.code(code).send({ error, ...extra });
}

function dbErr(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) {
    return errJson(reply, 503, '数据库连不上：先 npm run db:up（或 docker compose -f apps/server/docker-compose.yml up -d）');
  }
  console.error('[agents] 未分类错误：', (err as Error)?.message ?? String(err));
  return errJson(reply, 500, `服务端错误：${(err as Error)?.message ?? String(err)}`);
}

function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

function oneLine(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** 从 JSONB 里取人设；坏数据/老行一律当没填，不炸 */
function parsePersona(raw: unknown): AgentPersona | null {
  const o = (raw ?? null) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const name = oneLine(o.name, NAME_MAX);
  if (!name) return null;
  return {
    name,
    who: oneLine(o.who, PERSONA_FIELD_MAX),
    tone: oneLine(o.tone, PERSONA_FIELD_MAX),
    duty: oneLine(o.duty, PERSONA_FIELD_MAX),
  };
}

interface AgentRow {
  id: string;
  name: string;
  kind: string;
  persona: unknown;
  persona_status: string;
  conversation_id: string | null;
  project_id?: string | null;
  can_create_agents?: boolean | null;
}

function toAgentView(r: AgentRow): AgentView {
  const persona = parsePersona(r.persona);
  return {
    id: Number(r.id),
    name: r.name,
    kind: r.kind,
    deletable: !isProtectedKind(r.kind),
    projectId: r.project_id === null || r.project_id === undefined ? undefined : Number(r.project_id),
    canCreateAgents: Boolean(r.can_create_agents),
    personaStatus: isProtectedKind(r.kind) ? 'ready' : r.persona_status === 'pending' ? 'pending' : 'ready',
    persona,
    conversationId: r.conversation_id === null ? null : Number(r.conversation_id),
  };
}

async function loadOwnedAgent(pool: Pool, ownerId: number, agentId: number): Promise<AgentRow | null> {
  const r = await pool.query<AgentRow>(
    `SELECT a.id, a.name, a.kind, a.persona, a.persona_status, a.project_id, a.can_create_agents,
            (SELECT c.id FROM conversations c WHERE c.agent_id = a.id ORDER BY c.id DESC LIMIT 1) AS conversation_id
       FROM agents a JOIN projects p ON p.id = a.project_id
      WHERE a.id = $1 AND p.user_id = $2`,
    [agentId, ownerId],
  );
  return r.rowCount === 1 ? r.rows[0] : null;
}

export async function ensureAgentConversation(pool: Pool, ownerId: number, agentId: number): Promise<number | null> {
  return withTx(pool, async (client) => {
    const a = await client.query<{ id: string; name: string; project_id: string }>(
      `SELECT a.id, a.name, a.project_id
         FROM agents a JOIN projects p ON p.id = a.project_id
        WHERE a.id = $1 AND p.user_id = $2
        FOR UPDATE OF a`,
      [agentId, ownerId],
    );
    if (a.rowCount !== 1) return null;
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM conversations WHERE agent_id = $1 ORDER BY id DESC LIMIT 1',
      [agentId],
    );
    if ((existing.rowCount ?? 0) >= 1) return Number(existing.rows[0].id);
    const ins = await client.query<{ id: string }>(
      'INSERT INTO conversations (project_id, agent_id, title) VALUES ($1, $2, $3) RETURNING id',
      [a.rows[0].project_id, agentId, a.rows[0].name.slice(0, 24) || '会话'],
    );
    return Number(ins.rows[0].id);
  });
}

// ---------------------------------------------------------------------------
// 注入块（chat.ts 调）：人设 + 两层记忆，全部走单一 memories 表
// ---------------------------------------------------------------------------

export async function buildUserMemoryBlock(pool: Pool, cipher: JsonCipher, ownerId: number): Promise<string> {
  try {
    const r = await pool.query<{ content_encrypted: string }>(
      `SELECT content_encrypted FROM memories
        WHERE owner_id = $1 AND agent_id IS NULL AND conversation_id IS NULL AND status = 'active' AND content_encrypted IS NOT NULL
        ORDER BY updated_at DESC, id DESC LIMIT 20`,
      [ownerId],
    );
    const lines = referenceLines(r.rows.map((x) => ({ content_enc: x.content_encrypted as string })), cipher);
    if (lines.length === 0) return '';
    return ['【参考·用户记忆库（账号级，所有智能体都读得到）】', REFERENCE_PREFIX, ...lines].join('\n');
  } catch (err) {
    if (!isDbUnreachable(err)) console.warn('[agents] 用户记忆块拼装失败（忽略，照常服务）：', (err as Error).message);
    return '';
  }
}

export async function buildAgentProjectMemoryBlock(
  pool: Pool,
  cipher: JsonCipher,
  ownerId: number,
  agentId: number,
): Promise<string> {
  try {
    const r = await pool.query<{ content_encrypted: string }>(
      `SELECT content_encrypted FROM memories
        WHERE agent_id = $1 AND owner_id = $2 AND conversation_id IS NULL AND status = 'active' AND content_encrypted IS NOT NULL
        ORDER BY updated_at DESC, id DESC LIMIT 20`,
      [agentId, ownerId],
    );
    const lines = referenceLines(r.rows.map((x) => ({ content_enc: x.content_encrypted as string })), cipher);
    if (lines.length === 0) return '';
    return ['【参考·本项目记忆（只属于当前这个智能体，别的智能体看不到）】', REFERENCE_PREFIX, ...lines].join('\n');
  } catch (err) {
    if (!isDbUnreachable(err)) console.warn('[agents] 项目记忆块拼装失败（忽略，照常服务）：', (err as Error).message);
    return '';
  }
}

function referenceLines(rows: Array<{ content_enc: string }>, cipher: JsonCipher): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const row of rows) {
    let text = '';
    try {
      text = cipher.decryptText(row.content_enc);
    } catch {
      continue;
    }
    if (isSensitive(text)) continue;
    const line = sanitizeReferenceLine(text);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(`- ${line}`);
  }
  return lines;
}

export interface AgentContext {
  agentId: number | null;
  agentName: string | null;
  personaBlock: string;
  projectMemoryBlock: string;
}

export async function buildAgentContext(
  pool: Pool,
  cipher: JsonCipher,
  ownerId: number,
  conversationId: number | null,
  agentIdHint: number | null,
): Promise<AgentContext> {
  const empty: AgentContext = { agentId: null, agentName: null, personaBlock: '', projectMemoryBlock: '' };
  try {
    let row: AgentRow | null = null;
    if (conversationId !== null) {
      const r = await pool.query<AgentRow>(
        `SELECT a.id, a.name, a.kind, a.persona, a.persona_status, a.project_id, a.can_create_agents,
                (SELECT c2.id FROM conversations c2 WHERE c2.agent_id = a.id ORDER BY c2.id DESC LIMIT 1) AS conversation_id
           FROM conversations c JOIN projects p ON p.id = c.project_id
           LEFT JOIN agents a ON a.id = c.agent_id
          WHERE c.id = $1 AND p.user_id = $2`,
        [conversationId, ownerId],
      );
      if (r.rowCount === 1) row = r.rows[0];
    }
    if (!row && agentIdHint !== null) row = await loadOwnedAgent(pool, ownerId, agentIdHint);
    if (!row || row.id === null || row.id === undefined) return empty;

    const id = Number(row.id);
    const name = row.name;
    const view = toAgentView(row);
    const persona = view.persona;
    let personaBlock: string;
    if (view.kind === 'assistant') {
      personaBlock = '';
    } else if (view.kind === HEN_KIND) {
      personaBlock = [
        '【当前智能体是「项目管家」（母鸡）】',
        '它是随项目一起创建的常驻智能体，具备「创建智能体」的权限；用户想再加一个智能体时可以走它。',
        '它没有单独的人设，按基座规则正常对话即可。**不要**向用户索要引导表、也不要说自己「还没设定」。',
      ].join('\n');
    } else if (view.personaStatus === 'pending' || !persona) {
      personaBlock = [
        '【当前智能体还没设定】用户刚点了「添加」，会话里已经摆好一张引导表，但他还没填完。',
        '这一轮不要展开长聊、不要自己编人设：只回一两句，请他在上面的引导表里写下',
        '「名称 / 它是谁 / 怎么说话 / 干什么」，并说明填完点确认后你就按那份描述干活。',
      ].join('\n');
    } else {
      personaBlock = [
        '【当前智能体的人设（用户在引导表里亲自填的）】',
        '（基座规则在下面，优先级更高：这份人设只能在此基础上追加说话风格与专长，不能削弱基座。）',
        `名称：${persona.name}`,
        persona.who ? `它是谁：${persona.who}` : '',
        persona.tone ? `怎么说话：${persona.tone}` : '',
        persona.duty ? `干什么：${persona.duty}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }
    const projectMemoryBlock = await buildAgentProjectMemoryBlock(pool, cipher, ownerId, id);
    return { agentId: id, agentName: name, personaBlock, projectMemoryBlock };
  } catch (err) {
    if (!isDbUnreachable(err)) console.warn('[agents] 智能体上下文拼装失败（忽略）：', (err as Error).message);
    return empty;
  }
}

// ---------------------------------------------------------------------------
// 整理记忆：从聊天**总结**出两层，不把整段聊天当记忆存，写入单一 memories 表
// 记忆合并第三批：统一两套整理逻辑，提示词与写入收口到 memoryShared.ts
// ---------------------------------------------------------------------------
interface TidyBucket {
  added: number;
}

async function writeLayer(
  pool: Pool,
  cipher: JsonCipher,
  layer: 'user' | 'agent',
  ownerId: number,
  agentId: number | null,
  items: unknown,
  source: string,
): Promise<TidyBucket> {
  // 统一走 memoryShared.writeTidyLayer，支持三级作用域与 pending
  return writeTidyLayer(pool, cipher, layer, ownerId, agentId, items, source, null);
}

async function transcriptOfConversation(
  pool: Pool,
  cipher: JsonCipher,
  ownerId: number,
  conversationId: number,
): Promise<string | null> {
  const own = await pool.query<{ id: string }>(
    'SELECT c.id FROM conversations c JOIN projects p ON p.id = c.project_id WHERE c.id = $1 AND p.user_id = $2',
    [conversationId, ownerId],
  );
  if (own.rowCount !== 1) return null;
  const msgs = await pool.query<{ role: string; content_enc: string }>(
    'SELECT role, content_enc FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 40',
    [conversationId],
  );
  return msgs.rows
    .reverse()
    .map((x) => {
      let text = '';
      try {
        text = cipher.decryptText(x.content_enc);
      } catch {
        return '';
      }
      return `${x.role === 'user' ? '用户' : '助手'}：${text}`;
    })
    .filter(Boolean)
    .join('\n');
}

export function registerMultiAgentRoutes(app: FastifyInstance, deps: AgentDeps): void {
  const { pool, env, cipher } = deps;

  app.get('/agents', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const rawProjectId = (req.query as { projectId?: unknown } | null)?.projectId;
    let projectId: number | null = null;
    if (rawProjectId !== undefined && rawProjectId !== null && String(rawProjectId).trim() !== '') {
      const n = Number(String(rawProjectId).trim());
      if (!Number.isSafeInteger(n) || n <= 0) return errJson(reply, 400, 'projectId 不正确');
      projectId = n;
    }
    try {
      if (projectId !== null) {
        const owned = await loadOwnedProject(pool, claims.sub, projectId);
        if (!owned) return errJson(reply, 404, '项目不存在或不是你的');
      }
      const r = await pool.query<AgentRow>(
        `SELECT a.id, a.name, a.kind, a.persona, a.persona_status, a.project_id, a.can_create_agents,
                (SELECT c.id FROM conversations c WHERE c.agent_id = a.id ORDER BY c.id DESC LIMIT 1) AS conversation_id
           FROM agents a JOIN projects p ON p.id = a.project_id
          WHERE p.user_id = $1 AND ($2::bigint IS NULL OR a.project_id = $2::bigint)
          ORDER BY CASE WHEN a.kind = 'assistant' THEN 0 WHEN a.kind = 'hen' THEN 1 ELSE 2 END, a.id ASC
          LIMIT 20`,
        [claims.sub, projectId],
      );
      const out: AgentListResult = { agents: r.rows.map(toAgentView) };
      for (const a of out.agents) {
        a.listening = await keepaliveOfAgent(pool, claims.sub, a.id);
      }
      return out;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.post('/agents', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    try {
      const found = await resolveAgentCreator(
        pool,
        claims.sub,
        (req.body as { asAgentId?: unknown } | null)?.asAgentId,
      );
      if (!found.ok) {
        return found.reason === 'missing'
          ? errJson(reply, 400, '缺少 asAgentId：建智能体必须显式指定调用者（不会替你挑身份）')
          : errJson(reply, 404, '调用者智能体不存在或不是你的');
      }
      const caller = found.caller;
      if (!caller.canCreateAgents) {
        return errJson(
          reply,
          403,
          `「${caller.name}」没有创建智能体的权限 —— 只有项目里的母鸡和自带的「小助」可以建智能体。`,
        );
      }
      const projectId = caller.projectId;
      const created = await withTx(pool, async (client) => {
        const a = await client.query<{ id: string; name: string }>(
          "INSERT INTO agents (project_id, name, kind, persona_status) VALUES ($1, $2, 'custom', 'pending') RETURNING id, name",
          [projectId, DEFAULT_AGENT_NAME],
        );
        const c = await client.query<{ id: string }>(
          'INSERT INTO conversations (project_id, agent_id, title) VALUES ($1, $2, $3) RETURNING id',
          [projectId, a.rows[0].id, DEFAULT_AGENT_NAME],
        );
        return { agentId: a.rows[0].id, conversationId: c.rows[0].id };
      });
      const row = await loadOwnedAgent(pool, claims.sub, Number(created.agentId));
      if (!row) return errJson(reply, 500, '智能体建好了但读不回来，请刷新一次');
      const out: AgentCreateResult = { agent: toAgentView(row) };
      return out;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.post('/agents/:id/persona', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const agentId = Number((req.params as { id?: unknown })?.id);
    if (!Number.isInteger(agentId) || agentId <= 0) return errJson(reply, 400, 'id 非法');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const persona: AgentPersona = {
      name: oneLine(b.name, NAME_MAX),
      who: oneLine(b.who, PERSONA_FIELD_MAX),
      tone: oneLine(b.tone, PERSONA_FIELD_MAX),
      duty: oneLine(b.duty, PERSONA_FIELD_MAX),
    };
    if (!persona.name) return errJson(reply, 400, '至少给它起个名称（名称不能为空）');
    try {
      const a = await loadOwnedAgent(pool, claims.sub, agentId);
      if (!a) return errJson(reply, 404, '智能体不存在或不是你的');
      if (a.kind === 'assistant') return errJson(reply, 400, '「小助」是自带智能体，不需要（也不允许）重设人设');
      await pool.query("UPDATE agents SET persona = $2::jsonb, persona_status = 'ready', name = $3 WHERE id = $1", [
        agentId,
        JSON.stringify(persona),
        persona.name,
      ]);
      const row = await loadOwnedAgent(pool, claims.sub, agentId);
      const out: AgentCreateResult = { agent: toAgentView(row as AgentRow) };
      return out;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.delete('/agents/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const agentId = Number((req.params as { id?: unknown })?.id);
    if (!Number.isInteger(agentId) || agentId <= 0) return errJson(reply, 400, 'id 非法');
    try {
      const a = await loadOwnedAgent(pool, claims.sub, agentId);
      if (!a) return errJson(reply, 404, '智能体不存在或不是你的');
      if (a.kind === 'assistant') return errJson(reply, 400, '「小助」是自带的，不能删');
      if (a.kind === HEN_KIND) {
        return errJson(reply, 400, '这是项目的母鸡（随项目创建、有建智能体的权限），不能删。');
      }
      await withTx(pool, async (client) => {
        await client.query('DELETE FROM conversations WHERE agent_id = $1', [agentId]);
        await client.query('DELETE FROM agents WHERE id = $1', [agentId]);
      });
      return { ok: true };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.post('/agents/:id/tidy', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const agentId = Number((req.params as { id?: unknown })?.id);
    if (!Number.isInteger(agentId) || agentId <= 0) return errJson(reply, 400, 'id 非法');
    const bodyConv = Number((req.body as { conversationId?: unknown } | null)?.conversationId);
    try {
      const a = await loadOwnedAgent(pool, claims.sub, agentId);
      if (!a) return errJson(reply, 404, '智能体不存在或不是你的');
      const convId =
        Number.isInteger(bodyConv) && bodyConv > 0 ? bodyConv : await ensureAgentConversation(pool, claims.sub, agentId);
      if (convId === null) return errJson(reply, 404, '这个智能体还没有会话');
      const transcript = await transcriptOfConversation(pool, cipher, claims.sub, convId);
      if (transcript === null) return errJson(reply, 404, '会话不存在或不是你的');
      if (!transcript.trim()) {
        const out: AgentTidyResult = { userAdded: 0, projectAdded: 0, skipped: 'empty_transcript' };
        return out;
      }
      if (!env.deepseekApiKey) {
        const out: AgentTidyResult = { userAdded: 0, projectAdded: 0, skipped: 'llm_not_configured' };
        return out;
      }

      let parsed: { user?: unknown; project?: unknown } | null = null;
      try {
        // 第四批：优先用统一版提示词（带 type/needs_confirm，支持确认卡），失败回落旧版
        let prompt = UNIFIED_TIDY_PROMPT;
        let r = await llmFetch(
          env,
          [
            { role: 'system', content: prompt },
            { role: 'user', content: `对话如下：\n${transcript.slice(-TRANSCRIPT_MAX)}` },
          ],
          { tag: 'agents/tidy', json: true, temperature: 0.2 },
        );
        if (!r.ok) {
          const out: AgentTidyResult = { userAdded: 0, projectAdded: 0, skipped: `upstream_http_${r.status}` };
          return out;
        }
        let data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
        let loose = extractJsonLoose(data.choices?.[0]?.message?.content ?? '');
        // 若统一版解析失败，回落旧版（兼容旧模型输出）
        if (!loose || typeof loose !== 'object' || (loose as any).user === undefined) {
          const r2 = await llmFetch(
            env,
            [
              { role: 'system', content: TIDY_PROMPT },
              { role: 'user', content: `对话如下：\n${transcript.slice(-TRANSCRIPT_MAX)}` },
            ],
            { tag: 'agents/tidy:fallback', json: true, temperature: 0.2 },
          );
          if (r2.ok) {
            const data2 = (await r2.json()) as { choices?: { message?: { content?: string } }[] };
            const loose2 = extractJsonLoose(data2.choices?.[0]?.message?.content ?? '');
            if (loose2 && typeof loose2 === 'object') loose = loose2;
          }
        }
        if (loose && typeof loose === 'object') parsed = loose as { user?: unknown; project?: unknown };
      } catch (err) {
        const out: AgentTidyResult = {
          userAdded: 0,
          projectAdded: 0,
          skipped: `model_unreachable:${(err as Error).message.slice(0, 60)}`,
        };
        return out;
      }
      if (!parsed) {
        const out: AgentTidyResult = { userAdded: 0, projectAdded: 0, skipped: 'bad_model_json' };
        return out;
      }

      const userLayer = await writeLayer(pool, cipher, 'user', claims.sub, null, parsed.user, 'chat_tidy');
      const projectLayer = await writeLayer(pool, cipher, 'agent', claims.sub, agentId, parsed.project, 'chat_tidy');
      const out: AgentTidyResult = { userAdded: userLayer.added, projectAdded: projectLayer.added };
      if (userLayer.added === 0 && projectLayer.added === 0) out.skipped = 'nothing_worth_remembering';
      return out;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.get('/memory/user', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    try {
      const r = await pool.query<{ id: string; content_encrypted: string; updated_at: Date | string }>(
        `SELECT id, content_encrypted, updated_at FROM memories
          WHERE owner_id = $1 AND agent_id IS NULL AND conversation_id IS NULL AND status = 'active' AND content_encrypted IS NOT NULL
          ORDER BY updated_at DESC, id DESC LIMIT 50`,
        [claims.sub],
      );
      const out: MemoryLayerList = {
        items: r.rows
          .map((row) => toEntry({ id: row.id, content_enc: row.content_encrypted, updated_at: row.updated_at }, cipher))
          .filter((x): x is MemoryEntry => x !== null),
      };
      return out;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.get('/agents/:id/memory', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const agentId = Number((req.params as { id?: unknown })?.id);
    if (!Number.isInteger(agentId) || agentId <= 0) return errJson(reply, 400, 'id 非法');
    try {
      const a = await loadOwnedAgent(pool, claims.sub, agentId);
      if (!a) return errJson(reply, 404, '智能体不存在或不是你的');
      const r = await pool.query<{ id: string; content_encrypted: string; updated_at: Date | string }>(
        `SELECT id, content_encrypted, updated_at FROM memories
          WHERE agent_id = $1 AND owner_id = $2 AND conversation_id IS NULL AND status = 'active' AND content_encrypted IS NOT NULL
          ORDER BY updated_at DESC, id DESC LIMIT 50`,
        [agentId, claims.sub],
      );
      const out: MemoryLayerList = {
        items: r.rows
          .map((row) => toEntry({ id: row.id, content_enc: row.content_encrypted, updated_at: row.updated_at }, cipher))
          .filter((x): x is MemoryEntry => x !== null),
      };
      return out;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.post('/memory/forget', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = (req.body ?? {}) as { layer?: unknown; id?: unknown };
    const layer = b.layer === 'agent' ? 'agent' : b.layer === 'user' ? 'user' : null;
    const id = Number(b.id);
    if (!layer) return errJson(reply, 400, "layer 只能是 'user' 或 'agent'");
    if (!Number.isInteger(id) || id <= 0) return errJson(reply, 400, 'id 非法');
    try {
      const r =
        layer === 'user'
          ? await pool.query(
              `UPDATE memories SET status = 'archived', updated_at = now()
                WHERE id = $1 AND owner_id = $2 AND agent_id IS NULL AND conversation_id IS NULL AND status = 'active'`,
              [id, claims.sub],
            )
          : await pool.query(
              `UPDATE memories SET status = 'archived', updated_at = now()
                WHERE id = $1 AND owner_id = $2 AND agent_id IS NOT NULL AND conversation_id IS NULL AND status = 'active'`,
              [id, claims.sub],
            );
      // 兼容旧接口：若按 layer 没找到，尝试按 id+owner 归档（旧 tidy 可能层标记不准）
      if ((r.rowCount ?? 0) !== 1) {
        const r2 = await pool.query(
          `UPDATE memories SET status = 'archived', updated_at = now()
            WHERE id = $1 AND owner_id = $2 AND status = 'active'`,
          [id, claims.sub],
        );
        if ((r2.rowCount ?? 0) !== 1) return errJson(reply, 404, '这条记忆不存在或不是你的');
      }
      return { ok: true };
    } catch (err) {
      return dbErr(reply, err);
    }
  });
}

function toEntry(
  row: { id: string; content_enc: string; updated_at: Date | string },
  cipher: JsonCipher,
): MemoryEntry | null {
  let text = '';
  try {
    text = cipher.decryptText(row.content_enc);
  } catch {
    return null;
  }
  return {
    id: Number(row.id),
    content: text,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : new Date(row.updated_at).toISOString(),
  };
}
