/**
 * 批次 B | 项目共享白板 — 把 project scope 记忆暴露成"项目简报"，所有成员自动注入；贴白板=待确认记忆卡
 * 修 5 | 明确 project_whiteboard 与 project scope memories 的关系，避免重复注入
 *
 * 设计：
 * - 白板是项目级共享记忆，存储在 project_whiteboard 表，密文，轻量、显眼、可编辑
 * - 所有成员自动注入：buildWhiteboardBlock 被 chat.ts / toolLoop 注入
 * - 贴白板=待确认记忆卡：POST /projects/:id/whiteboard 时 status=pending, needs_confirm=true，生成确认卡
 * - 确认后 status=active，才注入
 * - 项目本身就是容器，第二列所有智能体天生同属一个项目=天然群，不需要 group_chats 表
 *
 * 修 5 — project_whiteboard vs project scope memories 去重注入关系：
 * - project_whiteboard：项目级、显眼、短平快，适合「当前目标/关键结论/待办」，上限 2000 字符（修 2 硬上限），超限强制归档进 memories
 * - memories（project scope）：同一项目的长期记忆，scope=project，type=fact，存于 memories 表，密文，可被语义检索（批次 G），
 *   适合沉淀后的知识/偏好/规矩
 * - 关系：白板是「工作台便签」，memories 是「档案库」。白板超限或归档时写入 memories（source=whiteboard_archive / whiteboard_overflow），
 *   但 memories 不自动回写白板，避免循环。注入时两块分别注入，buildWhiteboardBlock + buildMemoryBlock，
 *   并在各自块内做 seen 去重（sanitizeReferenceLine），跨块允许重复但提示词标明「白板=当前共识，记忆=参考」，
 *   避免两个项目级存储重复注入导致模型困惑。Letta 经验：白板逼 agent 取舍，档案库负责长记忆。
 * - 单写者锁作用域同 board.md：白板写是 DB 行级 UPSERT（ON CONFLICT mem_key），DB 保证原子，无需进程内锁；跨重启安全
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

// 修 2：白板硬上限 2000 字符，超限强制归档进项目记忆（Letta：上限是逼 agent 取舍的机制，不是限制）
export const WHITEBOARD_HARD_LIMIT = 2000;

async function archiveOldestIfNeeded(pool: Pool, cipher: JsonCipher, userId: number, projectId: number): Promise<void> {
  try {
    const r = await pool.query<WhiteboardRow>('SELECT * FROM project_whiteboard WHERE user_id=$1 AND project_id=$2 AND status=\'active\' ORDER BY updated_at ASC', [userId, projectId]);
    let total = 0;
    const rows: Array<{ row: WhiteboardRow; content: string }> = [];
    for (const row of r.rows) {
      try {
        const c = cipher.decryptText(row.content_enc);
        total += c.length;
        rows.push({ row, content: c });
      } catch {}
    }
    // 当总长超限，逐条把最旧的归档进项目记忆（memories 表），然后从白板归档
    while (total > WHITEBOARD_HARD_LIMIT && rows.length > 0) {
      const oldest = rows.shift()!;
      total -= oldest.content.length;
      try {
        // 归档进 memories：按项目记忆（agent_id 为原白板 agent，或空则归 user）
        const memKey = oldest.row.mem_key;
        const enc = oldest.row.content_enc; // 已是密文，复用
        // 写入 memories，type=fact，status=active，source=whiteboard_archive
        await pool.query(
          `INSERT INTO memories (project_id, agent_id, conversation_id, mem_key, value_enc, owner_id, type, content_encrypted, source, status, needs_confirm)
           VALUES ($1,$2,NULL,$3,$4,$5,'fact',$4,$6,'active',false)`,
          [projectId, oldest.row.agent_id, memKey, enc, userId, 'whiteboard_archive'],
        );
        await pool.query(`UPDATE project_whiteboard SET status='archived', updated_at=now() WHERE id=$1`, [oldest.row.id]);
        console.log(`[whiteboard] 硬上限触发：白板 ${oldest.row.id} 归档进项目记忆（${oldest.content.length}字）`);
      } catch (e) {
        console.warn('[whiteboard] 归档失败（忽略）：', (e as Error).message);
        break;
      }
    }
  } catch (e) {
    console.warn('[whiteboard] 检查上限失败（忽略）：', (e as Error).message);
  }
}

export async function postWhiteboard(
  pool: Pool,
  cipher: JsonCipher,
  input: { userId: number; projectId: number; agentId?: number | null; content: string; source?: string; needsConfirm?: boolean },
): Promise<WhiteboardView | null> {
  // 修 2：单条上限 2000，超长截断（Letta 取舍机制，超限部分强制归档）
  const raw = input.content.trim();
  if (!raw) return null;
  if (isSensitive(raw)) {
    console.warn('[whiteboard] 敏感内容被拒（不落库）');
    return null;
  }
  // 若单条就超 2000，拆：前 2000 进白板，剩余强制进项目记忆
  const content = raw.slice(0, WHITEBOARD_HARD_LIMIT);
  const overflow = raw.length > WHITEBOARD_HARD_LIMIT ? raw.slice(WHITEBOARD_HARD_LIMIT) : '';
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
    const view = toView(r.rows[0], cipher);
    // 溢出部分直接归档进项目记忆
    if (overflow) {
      try {
        const overflowKey = normalizeText(overflow);
        const overflowEnc = cipher.encryptText(overflow);
        await pool.query(
          `INSERT INTO memories (project_id, agent_id, conversation_id, mem_key, value_enc, owner_id, type, content_encrypted, source, status, needs_confirm)
           VALUES ($1,$2,NULL,$3,$4,$5,'fact',$4,$6,'active',false)`,
          [input.projectId, input.agentId ?? null, overflowKey, overflowEnc, input.userId, 'whiteboard_overflow'],
        );
        console.log(`[whiteboard] 单条超限：溢出 ${overflow.length}字 已归档进项目记忆`);
      } catch {}
    }
    // 检查总上限，超限归档最旧
    await archiveOldestIfNeeded(pool, cipher, input.userId, input.projectId);
    return view;
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
