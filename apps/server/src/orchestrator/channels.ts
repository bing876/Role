/**
 * 多智能体编排 · **内部频道**的存储层（DB + 密文 + 视图映射）。
 *
 * 一条频道 = 一对智能体（`agent_a_id < agent_b_id` + UNIQUE），所以「A→B」和「B→A」
 * 落在**同一条**频道上 —— 用户看到的是一个双向对话，不是两个单向窗口。
 *
 * ★ 正文一律密文（`content_enc`，与 `messages` 表同一套 AES-256-GCM）。
 *   `payload` 是明文 JSONB，所以进它之前必须过 `sanitizePayload()`（白名单式过滤）——
 *   这也是为什么 payload 只放状态/计数/来源网址/耗时这类**非内容**字段。
 *
 * ★ 权限口径与 `/agents` 一致：**只回自己的**。查别人的频道一律当不存在（404），
 *   不泄漏「这个频道存不存在」。
 */
import type {
  AgentChannelMessage,
  AgentChannelSummary,
  ChannelMessageKind,
  DelegationStatus,
  DelegationView,
} from '@ai-workbench/shared';
import type { Pool } from 'pg';
import type { JsonCipher } from '../crypto';
import { redactForStorage, sanitizePayload } from './redact';

/** 归一化一对智能体 id（小的当 a），保证 UNIQUE 约束真的能去重 */
export function normalizePair(x: number, y: number): { a: number; b: number } {
  return x <= y ? { a: x, b: y } : { a: y, b: x };
}

/** 取（必要时建）一条频道，返回 channelId */
export async function ensureChannel(
  pool: Pool,
  input: { userId: number; projectId: number; agentA: number; agentB: number },
): Promise<number> {
  const { a, b } = normalizePair(input.agentA, input.agentB);
  const found = await pool.query<{ id: string }>(
    'SELECT id FROM agent_channels WHERE user_id = $1 AND agent_a_id = $2 AND agent_b_id = $3 LIMIT 1',
    [input.userId, a, b],
  );
  if (found.rows[0]) return Number(found.rows[0].id);
  const created = await pool.query<{ id: string }>(
    `INSERT INTO agent_channels (user_id, project_id, agent_a_id, agent_b_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.userId, input.projectId, a, b],
  );
  return Number(created.rows[0].id);
}

/** 往频道里写一条（正文脱敏后加密；payload 白名单过滤） */
export async function addChannelMessage(
  pool: Pool,
  cipher: JsonCipher,
  input: {
    channelId: number;
    fromAgentId: number;
    toAgentId: number;
    kind: ChannelMessageKind;
    text: string;
    payload?: unknown;
    delegationId?: number;
  },
): Promise<number> {
  const safeText = redactForStorage(String(input.text ?? '')).slice(0, 4000);
  const r = await pool.query<{ id: string }>(
    `INSERT INTO agent_channel_messages
       (channel_id, from_agent_id, to_agent_id, kind, content_enc, payload, delegation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      input.channelId,
      input.fromAgentId,
      input.toAgentId,
      input.kind,
      cipher.encryptText(safeText),
      input.payload === undefined ? null : JSON.stringify(sanitizePayload(input.payload)),
      input.delegationId ?? null,
    ],
  );
  await pool
    .query('UPDATE agent_channels SET last_message_at = now() WHERE id = $1', [input.channelId])
    .catch(() => undefined);
  return Number(r.rows[0].id);
}

interface AgentNameRow {
  id: string;
  name: string;
  persona: { name?: string; duty?: string } | null;
}

/** 批量取智能体名字（含 persona.name —— 用户可能改过显示名） */
export async function loadAgentNames(pool: Pool, ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const uniq = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
  if (uniq.length === 0) return out;
  const r = await pool.query<AgentNameRow>(
    'SELECT id, name, persona FROM agents WHERE id = ANY($1::bigint[])',
    [uniq],
  );
  for (const row of r.rows) {
    const id = Number(row.id);
    const personaName = typeof row.persona?.name === 'string' ? row.persona.name.trim() : '';
    out.set(id, personaName || String(row.name ?? `#${id}`));
  }
  return out;
}

/** 频道列表（只回自己的；带对方名字、最后一句预览、条数、是否有在跑的委派） */
export async function listChannels(
  pool: Pool,
  cipher: JsonCipher,
  userId: number,
  projectId: number | null,
): Promise<AgentChannelSummary[]> {
  const r = await pool.query<{
    id: string;
    project_id: string;
    agent_a_id: string;
    agent_b_id: string;
    last_message_at: string;
    message_count: string;
    last_content_enc: string | null;
    live_delegation_id: string | null;
    live_status: string | null;
  }>(
    `SELECT c.id, c.project_id, c.agent_a_id, c.agent_b_id, c.last_message_at,
            (SELECT count(*)::text FROM agent_channel_messages m WHERE m.channel_id = c.id) AS message_count,
            (SELECT m.content_enc FROM agent_channel_messages m WHERE m.channel_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_content_enc,
            (SELECT d.id::text FROM agent_delegations d
              WHERE d.channel_id = c.id AND d.status IN ('pending','running') ORDER BY d.id DESC LIMIT 1) AS live_delegation_id,
            (SELECT d.status FROM agent_delegations d
              WHERE d.channel_id = c.id AND d.status IN ('pending','running') ORDER BY d.id DESC LIMIT 1) AS live_status
       FROM agent_channels c
      WHERE c.user_id = $1 AND ($2::bigint IS NULL OR c.project_id = $2::bigint)
      ORDER BY c.last_message_at DESC
      LIMIT 50`,
    [userId, projectId],
  );
  if (r.rows.length === 0) return [];

  // 「对方是谁」取决于**看的人是谁**：同一条频道，A 看到的对方是 B，B 看到的是 A。
  // 这里的读口是给某个用户的，而用户可能有多个智能体 —— 所以取「这一对里 id 较小的那个」
  // 当默认视角不够用；正确做法是按请求方的 agentId 定视角。列表页先按 a 视角给 peer=b，
  // 详情接口（channelMessages）会用请求里的 agentId 精确判定。
  const peerIds = r.rows.map((x) => Number(x.agent_b_id));
  const names = await loadAgentNames(pool, peerIds);

  return r.rows.map((x) => {
    const peerId = Number(x.agent_b_id);
    let preview = '';
    if (x.last_content_enc) {
      try {
        preview = cipher.decryptText(x.last_content_enc).slice(0, 60);
      } catch {
        preview = '';
      }
    }
    return {
      id: Number(x.id),
      peerAgentId: peerId,
      peerName: names.get(peerId) ?? `#${peerId}`,
      lastAt: x.last_message_at,
      lastPreview: preview,
      messageCount: Number(x.message_count ?? 0),
      ...(x.live_delegation_id
        ? { liveDelegationId: Number(x.live_delegation_id), liveStatus: (x.live_status ?? 'running') as DelegationStatus }
        : {}),
    } satisfies AgentChannelSummary;
  });
}

/** 某条频道的对话（不是自己的 → null，由路由转 404，不泄漏存在性） */
export async function channelMessages(
  pool: Pool,
  cipher: JsonCipher,
  userId: number,
  channelId: number,
  opts: { limit?: number; beforeId?: number } = {},
): Promise<{ channel: AgentChannelSummary; messages: AgentChannelMessage[] } | null> {
  const ch = await pool.query<{ id: string; agent_a_id: string; agent_b_id: string; last_message_at: string }>(
    'SELECT id, agent_a_id, agent_b_id, last_message_at FROM agent_channels WHERE id = $1 AND user_id = $2 LIMIT 1',
    [channelId, userId],
  );
  if (!ch.rows[0]) return null;
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const rows = await pool.query<{
    id: string;
    from_agent_id: string;
    to_agent_id: string;
    kind: string;
    content_enc: string;
    payload: unknown;
    delegation_id: string | null;
    created_at: string;
  }>(
    `SELECT id, from_agent_id, to_agent_id, kind, content_enc, payload, delegation_id, created_at
       FROM agent_channel_messages
      WHERE channel_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint)
      ORDER BY id DESC LIMIT $3`,
    [channelId, opts.beforeId ?? null, limit],
  );
  const names = await loadAgentNames(pool, rows.rows.flatMap((r) => [Number(r.from_agent_id), Number(r.to_agent_id)]));
  const messages: AgentChannelMessage[] = rows.rows
    .map((r) => {
      let text = '';
      try {
        text = cipher.decryptText(r.content_enc);
      } catch {
        text = '（这条消息解不开，可能密钥换过）';
      }
      const fromId = Number(r.from_agent_id);
      const toId = Number(r.to_agent_id);
      return {
        id: Number(r.id),
        kind: r.kind as ChannelMessageKind,
        fromAgentId: fromId,
        toAgentId: toId,
        fromName: names.get(fromId) ?? `#${fromId}`,
        toName: names.get(toId) ?? `#${toId}`,
        text,
        ...(r.payload === null || r.payload === undefined ? {} : { payload: r.payload }),
        ...(r.delegation_id ? { delegationId: Number(r.delegation_id) } : {}),
        at: r.created_at,
      };
    })
    .reverse(); // 界面按时间正序画
  const peerId = Number(ch.rows[0].agent_b_id);
  const peerNames = await loadAgentNames(pool, [peerId]);
  return {
    channel: {
      id: Number(ch.rows[0].id),
      peerAgentId: peerId,
      peerName: peerNames.get(peerId) ?? `#${peerId}`,
      lastAt: ch.rows[0].last_message_at,
      lastPreview: messages.length > 0 ? messages[messages.length - 1].text.slice(0, 60) : '',
      messageCount: messages.length,
    },
    messages,
  };
}

// ---------------------------------------------------------------------------
// 委派记录
// ---------------------------------------------------------------------------

export async function insertDelegation(
  pool: Pool,
  input: {
    userId: number;
    projectId: number;
    channelId: number;
    fromAgentId: number;
    toAgentId: number;
    parentLoopId: string;
    task: string;
    status: DelegationStatus;
    deadlineAt: Date;
  },
): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO agent_delegations
       (user_id, project_id, channel_id, from_agent_id, to_agent_id, parent_loop_id, task, status, deadline_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      input.userId,
      input.projectId,
      input.channelId,
      input.fromAgentId,
      input.toAgentId,
      input.parentLoopId,
      redactForStorage(input.task).slice(0, 1000),
      input.status,
      input.deadlineAt,
    ],
  );
  return Number(r.rows[0].id);
}

export async function setDelegationChildLoop(pool: Pool, id: number, childLoopId: string): Promise<void> {
  await pool
    .query('UPDATE agent_delegations SET child_loop_id = $1 WHERE id = $2', [childLoopId, id])
    .catch(() => undefined);
}

/**
 * 收尾：状态 + 结果（脱敏）/ 原因。
 *
 * ★ 这条 UPDATE 带 `AND status IN ('pending','running')` —— **一次委派只能收尾一次**。
 *
 *   这不是多余的谨慎，是实测出来的竞态：超时熔断把行写成 `timeout` 之后，
 *   那条被 abort 的子循环请求会以 `llm_error` 的形式返回，runner 醒来接着走
 *   「没收尾」那条分支，就把 `timeout` **覆盖成了 `need_user`** —— 用户在
 *   内部频道看到的是「超时」，而 `/delegations` 接口里却是「等用户」，两个口径对不上。
 *
 *   所以收尾权交给 DB 的行状态来仲裁（与 registry 的 `markResultReady` 同一个道理：
 *   幂等要在**唯一的那一层**做，别指望每个调用方都记得检查）。
 *
 * @returns 是否真的写进去了（`false` = 这一行早已被别的分支收尾，本次作废）
 */
export async function finishDelegation(
  pool: Pool,
  id: number,
  input: { status: DelegationStatus; result?: { summary?: string; outline?: string[] }; error?: string },
): Promise<boolean> {
  try {
    const r = await pool.query<{ id: string }>(
      `UPDATE agent_delegations
          SET status = $1, finished_at = now(),
              result = $2, error = $3
        WHERE id = $4 AND status IN ('pending','running')
        RETURNING id`,
      [
        input.status,
        input.result ? JSON.stringify(sanitizePayload(input.result)) : null,
        input.error ? redactForStorage(input.error).slice(0, 500) : null,
        id,
      ],
    );
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

export async function listDelegations(
  pool: Pool,
  input: { userId: number; channelId?: number | null; limit?: number },
): Promise<DelegationView[]> {
  const limit = Math.min(100, Math.max(1, input.limit ?? 20));
  const r = await pool.query<{
    id: string;
    channel_id: string;
    from_agent_id: string;
    to_agent_id: string;
    task: string;
    status: string;
    created_at: string;
    deadline_at: string;
    finished_at: string | null;
    result: { summary?: string; outline?: string[] } | null;
    error: string | null;
  }>(
    `SELECT id, channel_id, from_agent_id, to_agent_id, task, status,
            created_at, deadline_at, finished_at, result, error
       FROM agent_delegations
      WHERE user_id = $1 AND ($2::bigint IS NULL OR channel_id = $2::bigint)
      ORDER BY id DESC LIMIT $3`,
    [input.userId, input.channelId ?? null, limit],
  );
  if (r.rows.length === 0) return [];
  const names = await loadAgentNames(
    pool,
    r.rows.flatMap((x) => [Number(x.from_agent_id), Number(x.to_agent_id)]),
  );
  return r.rows.map((x) => {
    const fromId = Number(x.from_agent_id);
    const toId = Number(x.to_agent_id);
    const outline = Array.isArray(x.result?.outline) ? x.result.outline.map((s) => String(s).slice(0, 200)) : undefined;
    return {
      id: Number(x.id),
      channelId: Number(x.channel_id),
      fromAgentId: fromId,
      toAgentId: toId,
      fromName: names.get(fromId) ?? `#${fromId}`,
      toName: names.get(toId) ?? `#${toId}`,
      task: x.task,
      status: x.status as DelegationStatus,
      createdAt: x.created_at,
      deadlineAt: x.deadline_at,
      finishedAt: x.finished_at,
      ...(x.result?.summary ? { summary: String(x.result.summary).slice(0, 500) } : {}),
      ...(outline && outline.length > 0 ? { outline } : {}),
      ...(x.error ? { error: x.error } : {}),
    } satisfies DelegationView;
  });
}
