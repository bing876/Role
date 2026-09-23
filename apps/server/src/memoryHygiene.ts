/**
 * 记忆卫生 · 挂到 startIdleScheduler
 *
 * 需求：
 * - 按作用域把 active 记忆喂模型合并同类、标过时（被合并的改状态 merged 不删原文）
 * - 加上限：账号级 30 / 每智能体 20 超限触发整理，会话级不设上限
 * - 验收：
 *   ① 合并后条数减少
 *   ② merged 原文可查
 *   ③ 超上限不增长
 *   ④ 反证：关掉整理→只增不减
 */

import type { Pool } from 'pg';
import type { JsonCipher } from './crypto';
import type { ServerEnv } from './env';
import { llmFetch } from './llm';
import { isSensitive, normalizeText } from './memoryNormalize';
import { extractJsonLoose, writeMemoryRow } from './memoryShared';

export const MEMORY_LIMITS = {
  account: 30,
  agent: 20,
} as const;

export const HYGIENE_INTERVAL_MS = 5 * 60 * 1000;

export const HYGIENE_PROMPT = `你是记忆整理员。把下面这些长期记忆按语义合并同类、去重。
- 输入：[{id, content}]，id 是数据库 id，content 是记忆正文
- 任务：把语义相近、重复的分成一组，每组至少 2 条，输出合并后的新正文（30-60字，保留关键信息，去掉重复措辞）
- 只输出 JSON：{"groups":[{"ids":[1,2],"merged_content":"合并后..."}]}
- 找不到可合并的就输出 {"groups":[]}
- 敏感信息（身份证、手机号、银行卡、密码、token、API key 等）不要合并，直接忽略
- 不要编造新信息，只能基于输入内容合并`.trim();

export interface HygieneGroup {
  ids: number[];
  merged_content: string;
}

export interface HygieneResult {
  mergedGroups: number;
  createdIds: number[];
  mergedIds: number[];
  beforeCount: number;
  afterCount: number;
}

async function fetchActiveMemories(
  pool: Pool,
  cipher: JsonCipher,
  scope: { ownerId: number; agentId?: number | null; conversationId?: number | null },
): Promise<{ id: number; content: string; mem_key: string }[]> {
  const { ownerId, agentId, conversationId } = scope;
  let sql: string;
  let params: unknown[];
  if (conversationId != null) {
    sql = `SELECT id, mem_key, content_encrypted FROM memories WHERE owner_id=$1 AND conversation_id=$2 AND status='active' ORDER BY updated_at ASC`;
    params = [ownerId, conversationId];
  } else if (agentId != null) {
    sql = `SELECT id, mem_key, content_encrypted FROM memories WHERE owner_id=$1 AND agent_id=$2 AND conversation_id IS NULL AND status='active' ORDER BY updated_at ASC`;
    params = [ownerId, agentId];
  } else {
    sql = `SELECT id, mem_key, content_encrypted FROM memories WHERE owner_id=$1 AND agent_id IS NULL AND conversation_id IS NULL AND status='active' ORDER BY updated_at ASC`;
    params = [ownerId];
  }
  const r = await pool.query<{ id: string; mem_key: string; content_encrypted: string | null }>(sql, params as never[]);
  const out: { id: number; content: string; mem_key: string }[] = [];
  for (const row of r.rows) {
    const id = Number(row.id);
    let dec = '';
    try {
      dec = cipher.decryptText(String(row.content_encrypted));
    } catch {
      continue;
    }
    if (!dec) continue;
    out.push({ id, content: dec, mem_key: row.mem_key });
  }
  return out;
}

async function callHygieneModel(
  env: ServerEnv,
  memories: { id: number; content: string }[],
): Promise<HygieneGroup[]> {
  if (memories.length < 2) return [];
  const payload = memories.map((m) => ({ id: m.id, content: m.content.slice(0, 200) }));
  const messages = [
    { role: 'system' as const, content: HYGIENE_PROMPT },
    { role: 'user' as const, content: JSON.stringify(payload, null, 2) },
  ];
  try {
    const resp = await llmFetch(env, messages as never, {
      tag: 'memories/hygiene',
      json: true,
      temperature: 0.2,
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content ?? '';
    if (!raw.trim()) return [];
    const parsed = (extractJsonLoose(raw) ?? JSON.parse(raw)) as { groups?: unknown[] };
    const groups = (parsed?.groups ?? []) as unknown[];
    const out: HygieneGroup[] = [];
    for (const g of groups) {
      const obj = g as Record<string, unknown>;
      const ids = (obj?.ids ?? []) as unknown[];
      const merged = typeof obj?.merged_content === 'string' ? (obj.merged_content as string).trim() : '';
      const numIds = ids.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
      if (numIds.length < 2) continue;
      if (!merged) continue;
      if (isSensitive(merged)) continue;
      out.push({ ids: numIds, merged_content: merged.slice(0, 120) });
    }
    return out;
  } catch {
    return [];
  }
}

async function executeMergeGroups(
  pool: Pool,
  cipher: JsonCipher,
  scope: { ownerId: number; agentId?: number | null; conversationId?: number | null },
  groups: HygieneGroup[],
  source: string,
): Promise<{ createdIds: number[]; mergedIds: number[] }> {
  const createdIds: number[] = [];
  const mergedIds: number[] = [];
  const usedIds = new Set<number>();

  for (const g of groups) {
    const ids = g.ids.filter((id) => !usedIds.has(id));
    if (ids.length < 2) continue;
    ids.forEach((id) => usedIds.add(id));

    const memKey = (normalizeText(g.merged_content).slice(0, 80) + `_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`).slice(0, 96) || `merged_${Date.now()}`;
    if (isSensitive(g.merged_content) || isSensitive(memKey)) continue;

    let contentEnc: string;
    try {
      contentEnc = cipher.encryptText(g.merged_content);
    } catch {
      continue;
    }

    try {
      // 用 writeMemoryRow（支持三级作用域，去重 ON CONFLICT DO NOTHING）
      const added = await writeMemoryRow({
        pool,
        cipher,
        ownerId: scope.ownerId,
        agentId: scope.agentId ?? null,
        conversationId: scope.conversationId ?? null,
        memKey,
        contentEnc,
        type: 'preference',
        source: source || 'hygiene',
        status: 'active',
        needsConfirm: false,
      });
      if (added === 0) continue;

      // 取刚插入的 id
      let idQuery: { text: string; values: unknown[] };
      if (scope.conversationId != null) {
        idQuery = {
          text: `SELECT id FROM memories WHERE owner_id=$1 AND conversation_id=$2 AND mem_key=$3 ORDER BY id DESC LIMIT 1`,
          values: [scope.ownerId, scope.conversationId, memKey],
        };
      } else if (scope.agentId != null) {
        idQuery = {
          text: `SELECT id FROM memories WHERE owner_id=$1 AND agent_id=$2 AND conversation_id IS NULL AND mem_key=$3 ORDER BY id DESC LIMIT 1`,
          values: [scope.ownerId, scope.agentId, memKey],
        };
      } else {
        idQuery = {
          text: `SELECT id FROM memories WHERE owner_id=$1 AND agent_id IS NULL AND conversation_id IS NULL AND mem_key=$2 ORDER BY id DESC LIMIT 1`,
          values: [scope.ownerId, memKey],
        };
      }
      const idRes = await pool.query<{ id: string }>(idQuery.text, idQuery.values);
      if (idRes.rowCount !== 1) continue;
      const newId = Number(idRes.rows[0].id);
      createdIds.push(newId);

      for (const oldId of ids) {
        try {
          await pool.query(`UPDATE memories SET status='merged', merged_into=$2, updated_at=now() WHERE id=$1 AND status='active'`, [
            oldId,
            newId,
          ]);
          mergedIds.push(oldId);
        } catch {
          // 忽略单条失败
        }
      }
    } catch {
      // 忽略
    }
  }

  return { createdIds, mergedIds };
}

export async function runHygieneForScope(
  pool: Pool,
  cipher: JsonCipher,
  env: ServerEnv,
  scope: { ownerId: number; agentId?: number | null; conversationId?: number | null },
  opts: { force?: boolean; limit?: number; source?: string } = {},
): Promise<HygieneResult> {
  const { force = false, source = 'hygiene' } = opts;
  let limit: number;
  if (scope.conversationId != null) {
    limit = opts.limit ?? Infinity;
  } else if (scope.agentId != null) {
    limit = opts.limit ?? MEMORY_LIMITS.agent;
  } else {
    limit = opts.limit ?? MEMORY_LIMITS.account;
  }

  const all = await fetchActiveMemories(pool, cipher, scope);
  const beforeCount = all.length;

  if (!force && beforeCount <= limit) {
    return { mergedGroups: 0, createdIds: [], mergedIds: [], beforeCount, afterCount: beforeCount };
  }

  const groups = await callHygieneModel(env, all);
  if (groups.length === 0) {
    if (beforeCount > limit && all.length >= 2) {
      const oldest = all.slice(0, 2);
      const mergedContent = `${oldest[0].content}；${oldest[1].content}`.slice(0, 100);
      const fallbackGroups: HygieneGroup[] = [{ ids: oldest.map((m) => m.id), merged_content: mergedContent }];
      const exec = await executeMergeGroups(pool, cipher, scope, fallbackGroups, source);
      const afterRows = await fetchActiveMemories(pool, cipher, scope);
      return {
        mergedGroups: fallbackGroups.length,
        createdIds: exec.createdIds,
        mergedIds: exec.mergedIds,
        beforeCount,
        afterCount: afterRows.length,
      };
    }
    return { mergedGroups: 0, createdIds: [], mergedIds: [], beforeCount, afterCount: beforeCount };
  }

  const exec = await executeMergeGroups(pool, cipher, scope, groups, source);
  const afterRows = await fetchActiveMemories(pool, cipher, scope);

  return {
    mergedGroups: groups.length,
    createdIds: exec.createdIds,
    mergedIds: exec.mergedIds,
    beforeCount,
    afterCount: afterRows.length,
  };
}

export async function runGlobalHygiene(
  pool: Pool,
  cipher: JsonCipher,
  env: ServerEnv,
  opts: { enabled?: boolean } = {},
): Promise<{ account: HygieneResult[]; agent: HygieneResult[] }> {
  if (opts.enabled === false) return { account: [], agent: [] };
  const accountResults: HygieneResult[] = [];
  const agentResults: HygieneResult[] = [];

  try {
    const overAccount = await pool.query<{ owner_id: string }>(
      `SELECT owner_id FROM memories WHERE agent_id IS NULL AND conversation_id IS NULL AND status='active' GROUP BY owner_id HAVING count(*) > $1`,
      [MEMORY_LIMITS.account],
    );
    for (const row of overAccount.rows) {
      const ownerId = Number(row.owner_id);
      const res = await runHygieneForScope(pool, cipher, env, { ownerId, agentId: null, conversationId: null });
      accountResults.push(res);
    }
  } catch {
    // 忽略
  }

  try {
    const overAgent = await pool.query<{ owner_id: string; agent_id: string }>(
      `SELECT owner_id, agent_id FROM memories WHERE agent_id IS NOT NULL AND conversation_id IS NULL AND status='active' GROUP BY owner_id, agent_id HAVING count(*) > $1`,
      [MEMORY_LIMITS.agent],
    );
    for (const row of overAgent.rows) {
      const ownerId = Number(row.owner_id);
      const agentId = Number(row.agent_id);
      const res = await runHygieneForScope(pool, cipher, env, { ownerId, agentId, conversationId: null });
      agentResults.push(res);
    }
  } catch {
    // 忽略
  }

  return { account: accountResults, agent: agentResults };
}

export function startMemoryHygieneScheduler(
  pool: Pool,
  cipher: JsonCipher,
  env: ServerEnv,
  opts: { intervalMs?: number; enabled?: boolean } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? HYGIENE_INTERVAL_MS;
  const enabled = opts.enabled ?? true;
  if (!enabled) {
    console.log('[memory-hygiene] 已禁用（MEMORY_HYGIENE_ENABLED=false）');
    return () => {};
  }

  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const res = await runGlobalHygiene(pool, cipher, env, { enabled });
      const totalMerged = [...res.account, ...res.agent].reduce((a, r) => a + r.mergedGroups, 0);
      if (totalMerged > 0) {
        console.log(`[memory-hygiene] 合并 ${totalMerged} 组，账号级 ${res.account.length} 作用域，智能体级 ${res.agent.length} 作用域`);
      }
    } catch (err) {
      console.warn('[memory-hygiene] 定时整理失败（忽略）：', (err as Error).message);
    } finally {
      running = false;
    }
  };

  const first = setTimeout(tick, 30_000);
  timer = setInterval(tick, intervalMs) as unknown as NodeJS.Timeout;

  return () => {
    clearTimeout(first);
    if (timer) clearInterval(timer);
  };
}
