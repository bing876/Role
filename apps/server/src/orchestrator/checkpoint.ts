/**
 * 批次 D | 重启恢复 — 借 LangGraph checkpoint 思路：循环状态落库，服务重启能续跑正在进行的 job
 *
 * 设计：
 * - 循环状态（LoopSession）落库到 loop_checkpoints 表，每次 advance 后更新
 * - 服务启动时加载未完成的 checkpoints，恢复到内存 loops Map
 * - job 状态通过 agent_delegations 表已落库，重启后可重建
 * - 数据/事件做，版式归前端
 *
 * 落库字段：
 * - id, user_id, agent_id, conversation_id, wc_id, goal, messages(JSONB), step, status, tool_names, kind, parent_loop_id, chain
 *
 * 恢复：
 * - 启动时扫 status IN ('running','paused','waiting','waiting_job') 的 checkpoints
 * - 重建 LoopSession（不含 abortCtl，touchedAt 设为 now）
 * - 已超时的 delegations 标记 timeout
 */

import type { Pool } from 'pg';
import type { LoopSession } from '../toolLoop';

export interface CheckpointRow {
  id: string;
  user_id: string;
  agent_id: string | null;
  conversation_id: string | null;
  wc_id: string | null;
  goal: string | null;
  messages: any;
  step: number;
  status: string;
  tool_names: any;
  kind: string | null;
  parent_loop_id: string | null;
  chain: any;
  created_at: string;
  updated_at: string;
}

export async function saveCheckpoint(pool: Pool, session: LoopSession): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO loop_checkpoints (id, user_id, agent_id, conversation_id, wc_id, goal, messages, step, status, tool_names, kind, parent_loop_id, chain, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
       ON CONFLICT (id) DO UPDATE SET
         agent_id=$3, conversation_id=$4, wc_id=$5, goal=$6, messages=$7, step=$8, status=$9, tool_names=$10, kind=$11, parent_loop_id=$12, chain=$13, updated_at=now()`,
      [
        session.id,
        session.userId,
        session.agentId,
        session.conversationId,
        session.wcId,
        session.goal ?? null,
        JSON.stringify(session.messages ?? []),
        session.step,
        session.status,
        JSON.stringify(session.toolNames ?? []),
        (session as any).kind ?? null,
        (session as any).parentLoopId ?? null,
        JSON.stringify((session as any).chain ?? []),
      ],
    );
  } catch (err) {
    console.warn(`[checkpoint] 保存失败 ${session.id}（忽略）：`, (err as Error).message);
  }
}

export async function deleteCheckpoint(pool: Pool, loopId: string): Promise<void> {
  try {
    await pool.query('DELETE FROM loop_checkpoints WHERE id=$1', [loopId]);
  } catch (err) {
    console.warn(`[checkpoint] 删除失败 ${loopId}（忽略）：`, (err as Error).message);
  }
}

export async function loadCheckpoints(pool: Pool): Promise<CheckpointRow[]> {
  try {
    const r = await pool.query<CheckpointRow>(
      `SELECT * FROM loop_checkpoints WHERE status IN ('running','paused','waiting','waiting_job') ORDER BY updated_at DESC LIMIT 100`,
    );
    return r.rows;
  } catch (err) {
    console.warn('[checkpoint] 加载失败（忽略）：', (err as Error).message);
    return [];
  }
}

export function checkpointToSession(row: CheckpointRow): Partial<LoopSession> & { id: string } {
  return {
    id: row.id,
    userId: Number(row.user_id),
    agentId: row.agent_id ? Number(row.agent_id) : null,
    conversationId: row.conversation_id ? Number(row.conversation_id) : null,
    wcId: row.wc_id ? Number(row.wc_id) : null,
    goal: row.goal ?? '',
    messages: Array.isArray(row.messages) ? row.messages : [],
    step: row.step,
    status: row.status as any,
    toolNames: Array.isArray(row.tool_names) ? row.tool_names : undefined,
    // @ts-ignore
    kind: row.kind ?? undefined,
    // @ts-ignore
    parentLoopId: row.parent_loop_id ?? undefined,
    // @ts-ignore
    chain: Array.isArray(row.chain) ? row.chain : [],
    touchedAt: Date.now(),
  } as any;
}

export async function restoreLoops(pool: Pool, restoreFn: (session: Partial<LoopSession> & { id: string }) => void): Promise<number> {
  const rows = await loadCheckpoints(pool);
  let restored = 0;
  for (const row of rows) {
    try {
      const partial = checkpointToSession(row);
      restoreFn(partial);
      restored += 1;
    } catch (err) {
      console.warn(`[checkpoint] 恢复失败 ${row.id}（忽略）：`, (err as Error).message);
    }
  }
  console.log(`[checkpoint] 重启恢复：从库中恢复 ${restored} 个循环`);
  return restored;
}
