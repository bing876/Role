/**
 * 批次 D | 重启恢复 — 借 LangGraph checkpoint 思路：循环状态落库，服务重启能续跑正在进行的 job
 * 修 1（安全）：messages 若为明文 JSONB，改为加密——整列 messages_enc TEXT 走 cipher，goal_enc 同理
 * 依据：本仓库 messages.content_enc / memories.content_encrypted 全是密文，R2 当年专门给 task_pauses 加 goal_enc
 *
 * 设计：
 * - 循环状态（LoopSession）落库到 loop_checkpoints 表，每次 advance 后更新
 * - 加密：goal_enc / messages_enc 走 JsonCipher（与 messages 表同一套 AES-256-GCM）
 * - 直接 SELECT 必须读不到明文（验收：发含敏感词消息→触发 checkpoint→SELECT 读不到明文）
 * - 服务启动时加载未完成的 checkpoints，解密后恢复到内存 loops Map
 */

import type { Pool } from 'pg';
import type { LoopSession } from '../toolLoop';
import type { JsonCipher } from '../crypto';

export interface CheckpointRow {
  id: string;
  user_id: string;
  agent_id: string | null;
  conversation_id: string | null;
  wc_id: string | null;
  goal: string | null;
  goal_enc: string | null;
  messages: any;
  messages_enc: string | null;
  pending_call_id: string | null;
  executed_tool_ids: any;
  step: number;
  status: string;
  tool_names: any;
  kind: string | null;
  parent_loop_id: string | null;
  chain: any;
  created_at: string;
  updated_at: string;
}

function safeDecryptText(cipher: JsonCipher | null | undefined, enc: string | null): string | null {
  if (!enc || !cipher) return null;
  try {
    return cipher.decryptText(enc);
  } catch {
    return null;
  }
}

function safeDecryptJson(cipher: JsonCipher | null | undefined, enc: string | null): any | null {
  if (!enc || !cipher) return null;
  try {
    const txt = cipher.decryptText(enc);
    return JSON.parse(txt);
  } catch {
    try {
      return (cipher as any).decryptJson(enc);
    } catch {
      return null;
    }
  }
}

/**
 * ★ 收尾 1（fail-closed）：**没有 cipher 或加密失败 → 这次 checkpoint 不写**，绝不回退成明文。
 *
 * 原来的写法是 `cipher ? null : session.goal` —— 调用方只要漏传 cipher（或 encryptText 抛错被吞），
 * 就**悄悄**把 goal / messages 明文写进 loop_checkpoints。收尾 1 用变异测试证实过：
 * 把 index.ts 里的 `setCheckpointDeps(pool, cipher)` 改成 `setCheckpointDeps(pool)`，
 * 整条任务（含银行卡号、密码、身份证）原样落库，而当时的验收脚本照样 PASS。
 *
 * 取舍：少一次 checkpoint 的代价只是「这一步重启后续不上」；写一次明文的代价是敏感数据落盘。
 * 前者可以接受，后者不行。所以这里宁可不写、打一行警告（警告里不带任何内容）。
 */
export async function saveCheckpoint(pool: Pool, session: LoopSession, cipher?: JsonCipher | null): Promise<void> {
  if (!cipher) {
    console.warn(`[checkpoint] 未注入 cipher，拒绝写入 ${session.id}（不回退明文）`);
    return;
  }
  try {
    let goalEnc: string | null;
    let messagesEnc: string;
    try {
      goalEnc = session.goal ? cipher.encryptText(session.goal) : null;
      messagesEnc = cipher.encryptText(JSON.stringify(session.messages ?? []));
    } catch (err) {
      console.warn(`[checkpoint] 加密失败，拒绝写入 ${session.id}（不回退明文）：`, (err as Error).message);
      return;
    }
    // 修 3 幂等：记录 pending_call_id 与已执行过的 tool_call_ids，重启后去重
    const pendingCallId = (session as any).pendingCallId ?? null;
    const executedIds = (session as any).executedToolIds ?? (session as any).usedTools ?? [];
    await pool.query(
      `INSERT INTO loop_checkpoints (id, user_id, agent_id, conversation_id, wc_id, goal, goal_enc, messages, messages_enc, pending_call_id, executed_tool_ids, step, status, tool_names, kind, parent_loop_id, chain, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
       ON CONFLICT (id) DO UPDATE SET
         agent_id=$3, conversation_id=$4, wc_id=$5, goal=$6, goal_enc=$7, messages=$8, messages_enc=$9, pending_call_id=$10, executed_tool_ids=$11, step=$12, status=$13, tool_names=$14, kind=$15, parent_loop_id=$16, chain=$17, updated_at=now()`,
      [
        session.id,
        session.userId,
        session.agentId,
        session.conversationId,
        session.wcId,
        null, // goal 明文列：永远 NULL（旧列只为兼容读老数据保留）
        goalEnc,
        '[]', // messages 明文列：永远 '[]'
        messagesEnc,
        pendingCallId,
        JSON.stringify(Array.isArray(executedIds) ? executedIds : []),
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

export async function loadCheckpoints(pool: Pool, cipher?: JsonCipher | null): Promise<CheckpointRow[]> {
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

export function checkpointToSession(row: CheckpointRow, cipher?: JsonCipher | null): Partial<LoopSession> & { id: string } {
  let goal = row.goal ?? '';
  let messages: any[] = [];

  if (cipher) {
    const decGoal = safeDecryptText(cipher, row.goal_enc);
    if (decGoal !== null) goal = decGoal;
    const decMessages = safeDecryptJson(cipher, row.messages_enc);
    if (Array.isArray(decMessages)) messages = decMessages;
    else if (decMessages !== null) messages = decMessages;
  }

  if (messages.length === 0) {
    if (Array.isArray(row.messages)) messages = row.messages;
    else if (typeof row.messages === 'string') {
      try {
        messages = JSON.parse(row.messages);
      } catch {
        messages = [];
      }
    }
  }
  if (!goal && row.goal) goal = row.goal;

  return {
    id: row.id,
    userId: Number(row.user_id),
    agentId: row.agent_id ? Number(row.agent_id) : null,
    conversationId: row.conversation_id ? Number(row.conversation_id) : null,
    wcId: row.wc_id ? Number(row.wc_id) : null,
    goal,
    messages,
    step: row.step,
    status: row.status as any,
    toolNames: Array.isArray(row.tool_names) ? row.tool_names : undefined,
    // 修 3 幂等：恢复 pending_call_id 与 executed_tool_ids
    // @ts-ignore
    pendingCallId: row.pending_call_id ?? null,
    // @ts-ignore
    executedToolIds: Array.isArray(row.executed_tool_ids) ? row.executed_tool_ids : [],
    // @ts-ignore
    kind: row.kind ?? undefined,
    // @ts-ignore
    parentLoopId: row.parent_loop_id ?? undefined,
    // @ts-ignore
    chain: Array.isArray(row.chain) ? row.chain : [],
    touchedAt: Date.now(),
  } as any;
}

export async function restoreLoops(
  pool: Pool,
  restoreFn: (session: Partial<LoopSession> & { id: string }) => void,
  cipher?: JsonCipher | null,
): Promise<number> {
  const rows = await loadCheckpoints(pool, cipher ?? null);
  let restored = 0;
  for (const row of rows) {
    try {
      const partial = checkpointToSession(row, cipher ?? null);
      restoreFn(partial);
      restored += 1;
    } catch (err) {
      console.warn(`[checkpoint] 恢复失败 ${row.id}（忽略）：`, (err as Error).message);
    }
  }
  console.log(`[checkpoint] 重启恢复：从库中恢复 ${restored} 个循环（已解密）`);
  return restored;
}
