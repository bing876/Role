/**
 * 无感核心：协同进对话流
 *
 * 之前：委派只写 agent_channels / agent_channel_messages，聊天里看不到，用户必须点「内部频道」抽屉才知道
 * 现在：协同往来直接进对话流，折叠成一行摘要（数据/事件我们做，折叠卡长相归前端）
 *
 * 做法：
 * - 每次委派创建/完成/失败/超时/被拒，都往相关智能体的主会话（conversations.agent_id = agentId）写一条 assistant 消息
 * - 消息以 【协同·xxx】 开头，前端可据此渲染成折叠卡（现在先用纯文本，1:1 前端来后替换样式）
 * - 正文密文，与 messages 表同一套 AES-256-GCM
 * - 失败只告警，不阻断委派本身
 */

import type { Pool } from 'pg';
import type { JsonCipher } from '../crypto';

export type CollabKind = 'dispatch' | 'accept' | 'reply' | 'progress' | 'system' | 'route' | 'routine';

export interface CollabChatInput {
  kind: CollabKind;
  fromId: number;
  fromName: string;
  toId: number;
  toName: string;
  task?: string;
  summary?: string;
  status?: string;
  delegationId?: number;
  detail?: string;
}

function buildCollabText(input: CollabChatInput): string {
  const { kind, fromName, toName, task, summary, status, delegationId, detail } = input;
  const idTag = delegationId ? `（ID:${delegationId}）` : '';
  switch (kind) {
    case 'dispatch':
      return `【协同·派单】${fromName} → ${toName}：${(task ?? '').slice(0, 200)}${idTag}`.trim();
    case 'accept':
      return `【协同·接单】${toName} 收到 ${fromName} 的委派：${(task ?? '').slice(0, 200)}${idTag}`.trim();
    case 'reply':
      return `【协同·交回】${toName} → ${fromName}：${(summary ?? detail ?? '').slice(0, 300)}${idTag}${status ? ` [${status}]` : ''}`.trim();
    case 'progress':
      return `【协同·进展】${fromName} → ${toName}：${(detail ?? '').slice(0, 200)}${idTag}`.trim();
    case 'route':
      // ★ 独立前缀，绝不再套【协同·系统】—— 嵌套【】就是占位符残留（2026-09-25 清扫）
      return `【协同·路由】${(detail ?? '').slice(0, 300)}${status ? ` [${status}]` : ''}`.trim();
    case 'routine':
      // ★ 独立前缀，单次触发只出这一张卡（不再先写一条又走 collabChat 写第二条）
      return `【协同·例行】${(detail ?? '').slice(0, 300)}${idTag}${status ? ` [${status}]` : ''}`.trim();
    case 'system':
    default:
      return `【协同·系统】${fromName} → ${toName}：${(detail ?? '').slice(0, 300)}${idTag}${status ? ` [${status}]` : ''}`.trim();
  }
}

/**
 * 往某个智能体的主会话写一条协同消息（assistant 角色）
 * - 找不到会话就跳过（不抛错，委派本身不能因写聊天失败）
 */
export async function writeCollabToAgentChat(
  pool: Pool,
  cipher: JsonCipher,
  agentId: number,
  input: CollabChatInput,
): Promise<void> {
  if (!Number.isInteger(agentId) || agentId <= 0) return;
  try {
    const conv = await pool.query<{ id: string }>('SELECT id FROM conversations WHERE agent_id=$1 ORDER BY id DESC LIMIT 1', [agentId]);
    if (conv.rows.length === 0) return;
    const convId = Number(conv.rows[0].id);
    const text = buildCollabText(input);
    const enc = cipher.encryptText(text);
    await pool.query(`INSERT INTO messages (conversation_id, role, content_enc) VALUES ($1,'assistant',$2)`, [convId, enc]);
  } catch (err) {
    console.warn(`[collab-chat] 写入智能体 ${agentId} 的协同消息失败（忽略）：`, (err as Error).message);
  }
}

/**
 * ★ 进展卡收敛（2026-09-25 输出纪律③）：同一委派、同一会话里**最多一张**进展卡。
 *
 * 以前每走一步工具就 INSERT 一条「第 N 步：…」，一次委派 5 步 = 对话流里连甩 5 张
 * 同类卡（用户抱怨「一次吐一堆」）。现在：新进展**覆盖**旧卡（UPDATE 同一行），
 * 对话流里永远只看到最新那一步；卡的内容（谁→谁、ID、最新进展）逐字不变，
 * 只是不再堆叠。
 *
 * 记录「上一张进展卡的消息 id」用进程内 Map（委派生命周期 = 单进程，registry 本就
 * 在内存里）；查不到 / 旧行已被删（换会话）就回落到 INSERT，绝不丢卡。
 */
const progressCardMsgId = new Map<string, number>(); // `${agentId}:${delegationId}` → messages.id

/** 测试/反证用：清掉进展卡合并表（不测的话它会跨用例串状态） */
export function __resetProgressCardCacheForTest(): void {
  progressCardMsgId.clear();
}

export async function writeProgressToAgentChat(
  pool: Pool,
  cipher: JsonCipher,
  agentId: number,
  input: CollabChatInput,
): Promise<void> {
  if (!Number.isInteger(agentId) || agentId <= 0) return;
  // 没有 delegationId 无从对齐同一委派的卡 → 退回普通写法
  if (!input.delegationId) {
    await writeCollabToAgentChat(pool, cipher, agentId, input);
    return;
  }
  try {
    const conv = await pool.query<{ id: string }>('SELECT id FROM conversations WHERE agent_id=$1 ORDER BY id DESC LIMIT 1', [agentId]);
    if (conv.rows.length === 0) return;
    const convId = Number(conv.rows[0].id);
    const enc = cipher.encryptText(buildCollabText(input));
    const key = `${agentId}:${input.delegationId}`;
    const prev = progressCardMsgId.get(key);
    if (prev !== undefined) {
      const r = await pool.query('UPDATE messages SET content_enc=$1 WHERE id=$2 AND conversation_id=$3', [enc, prev, convId]);
      if ((r.rowCount ?? 0) > 0) return; // 旧卡还在 → 已覆盖，不加新行
    }
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, role, content_enc) VALUES ($1,'assistant',$2) RETURNING id`,
      [convId, enc],
    );
    progressCardMsgId.set(key, Number(ins.rows[0].id));
  } catch (err) {
    console.warn(`[collab-chat] 写进展卡到智能体 ${agentId} 失败（忽略）：`, (err as Error).message);
  }
}

/**
 * 双向写入：派单方和接单方各一条
 */
export async function writeCollabBoth(
  pool: Pool,
  cipher: JsonCipher,
  input: CollabChatInput,
): Promise<void> {
  // 派单方视角
  await writeCollabToAgentChat(pool, cipher, input.fromId, input);
  // 接单方视角（kind 转成 accept 或 reply 等）
  if (input.toId !== input.fromId) {
    // 接单方用 accept 视角
    const toInput: CollabChatInput = { ...input, kind: input.kind === 'dispatch' ? 'accept' : input.kind };
    await writeCollabToAgentChat(pool, cipher, input.toId, toInput);
  }
}
