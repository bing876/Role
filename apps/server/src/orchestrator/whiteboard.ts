/**
 * 批次 B | 项目共享白板 — 把 project scope 记忆暴露成"项目简报"，所有成员自动注入；贴白板=待确认记忆卡
 *
 * 设计：
 * - 白板是项目级共享记忆，存储在 project_whiteboard 表，密文
 * - 所有成员自动注入：buildWhiteboardBlock 被 chat.ts / toolLoop 注入
 * - 贴白板=待确认记忆卡：POST /projects/:id/whiteboard 时 status=pending, needs_confirm=true，生成确认卡
 * - 确认后 status=active，才注入
 * - 项目本身就是容器，第二列所有智能体天生同属一个项目=天然群，不需要 group_chats 表
 */

import type { Pool } from 'pg';
import type { JsonCipher } from '../crypto';
import { REFERENCE_PREFIX, sanitizeReferenceLine } from '../promptPolicy';
import { normalizeText, isSensitive } from '../memoryNormalize';

export interface WhiteboardRow {
  id: string;
  user_id: string;
  project_id: string;
  agent_id: string | null;
  mem_key: string;
  content_enc: string;
  status: string;
  needs_confirm: boolean;
  source: string | null;
  created_at: string;
  updated_at: string;
}

export interface WhiteboardView {
  id: number;
  projectId: number;
  agentId: number | null;
  content: string;
  status: 'active' | 'pending' | 'archived';
  needsConfirm: boolean;
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

function toView(row: WhiteboardRow, cipher: JsonCipher): WhiteboardView | null {
  let content = '';
  try {
    content = cipher.decryptText(row.content_enc);
  } catch {
    return null;
  }
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    agentId: row.agent_id ? Number(row.agent_id) : null,
    content,
    status: row.status as any,
    needsConfirm: row.needs_confirm,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listWhiteboard(pool: Pool, cipher: JsonCipher, userId: number, projectId: number): Promise<WhiteboardView[]> {
  const r = await pool.query<WhiteboardRow>('SELECT * FROM project_whiteboard WHERE user_id=$1 AND project_id=$2 AND status IN (\'active\',\'pending\') ORDER BY updated_at DESC LIMIT 50', [userId, projectId]);
  return r.rows.map((row) => toView(row, cipher)).filter((x): x is WhiteboardView => x !== null);
}

export async function buildWhiteboardBlock(pool: Pool, cipher: JsonCipher, userId: number, projectId: number): Promise<string> {
  try {
    const r = await pool.query<WhiteboardRow>('SELECT content_enc FROM project_whiteboard WHERE user_id=$1 AND project_id=$2 AND status=\'active\' ORDER BY updated_at DESC LIMIT 20', [userId, projectId]);
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const row of r.rows) {
      let text = '';
      try { text = cipher.decryptText(row.content_enc); } catch { continue; }
      if (isSensitive(text)) continue;
      const line = sanitizeReferenceLine(text);
      if (!line || seen.has(line)) continue;
      seen.add(line);
      lines.push(`- ${line}`);
    }
    if (lines.length === 0) return '';
    return ['【项目简报·白板（项目级共享，所有成员自动注入）】', REFERENCE_PREFIX, ...lines].join('\n');
  } catch (err) {
    console.warn('[whiteboard] 注入块拼装失败（忽略）：', (err as Error).message);
    return '';
  }
}

export async function postWhiteboard(
  pool: Pool,
  cipher: JsonCipher,
  input: { userId: number; projectId: number; agentId?: number | null; content: string; source?: string; needsConfirm?: boolean },
): Promise<WhiteboardView | null> {
  const content = input.content.trim().slice(0, 300);
  if (!content) return null;
  if (isSensitive(content)) {
    console.warn('[whiteboard] 敏感内容被拒（不落库）');
    return null;
  }
  const memKey = normalizeText(content);
  const enc = cipher.encryptText(content);
  const status = input.needsConfirm ? 'pending' : 'active';
  try {
    const r = await pool.query<WhiteboardRow>(
      `INSERT INTO project_whiteboard (user_id, project_id, agent_id, mem_key, content_enc, status, needs_confirm, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (project_id, mem_key) WHERE status IN ('active','pending') DO UPDATE SET content_enc=$5, status=$6, needs_confirm=$7, updated_at=now(), agent_id=$3, source=$8
       RETURNING *`,
      [input.userId, input.projectId, input.agentId ?? null, memKey, enc, status, Boolean(input.needsConfirm), input.source ?? 'whiteboard_post'],
    );
    return toView(r.rows[0], cipher);
  } catch (err) {
    console.warn('[whiteboard] 写入失败：', (err as Error).message);
    return null;
  }
}

export async function confirmWhiteboard(pool: Pool, userId: number, projectId: number, ids: number[], target: 'active' | 'archived'): Promise<number> {
  if (ids.length === 0) return 0;
  let count = 0;
  for (const id of ids.slice(0, 10)) {
    const r = await pool.query(`UPDATE project_whiteboard SET status=$3, updated_at=now() WHERE id=$1 AND user_id=$2 AND project_id=$4 AND status='pending'`, [id, userId, target, projectId]);
    count += r.rowCount ?? 0;
  }
  return count;
}

export async function forgetWhiteboard(pool: Pool, userId: number, projectId: number, id: number): Promise<boolean> {
  const r = await pool.query(`UPDATE project_whiteboard SET status='archived', updated_at=now() WHERE id=$1 AND user_id=$2 AND project_id=$3 AND status='active'`, [id, userId, projectId]);
  return (r.rowCount ?? 0) === 1;
}
