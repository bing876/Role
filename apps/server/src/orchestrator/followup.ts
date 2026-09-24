/**
 * 批次 K | 主动跟进掉线的活 —— Routines 扫两类"没人管了"的东西，**主动**写对话流提醒。
 *
 * 之前的问题：活"掉线"了用户不知道。
 *   · 委派（handoff）：`deadline_at` 到了但状态还是 `running`（服务端重启把内存里的超时定时器丢了，
 *     超时熔断没触发），既没有回音、也没有超时消息 —— 用户以为对方还在干，其实卡死了。
 *   · 挂起（task_pauses）：`resumed_at IS NULL` 且挂了很久 —— 用户忘了自己挂起了一条任务。
 *
 * 这一批让 Routines 定时扫这两类，**主动**往相关智能体的主会话（对话流）写一条催办提醒。
 * 不建任何 UI，数据/事件我们做，版式归前端（与 routines / collabChat 同一口径）。
 *
 * 幂等（防刷屏）：两张表各有一列 `last_followed_at`，同一条 N 分钟（默认 30）内只提醒一次。
 * 扫到"该提醒"就写消息 + 把 `last_followed_at` 置 now；扫到"还没到点"就跳过。
 *
 * 触发：挂在 Routines 的定时扫（`startRoutineSweeper` 的 tick）里，与 interval/cron routine 同频。
 */

import type { Pool } from 'pg';
import type { JsonCipher } from '../crypto';

/** 挂起超过这么久没人恢复 → 算"长期未恢复"（默认 30 分钟） */
export const PAUSE_STALE_MS_DEFAULT = 30 * 60 * 1000;
/** 同一条最多多久提醒一次（默认 30 分钟，防刷屏） */
export const REMIND_EVERY_MS_DEFAULT = 30 * 60 * 1000;
/** 一次最多提醒几条（防积压时一口气刷屏） */
const BATCH_LIMIT = 20;

export interface FollowupOptions {
  /** 挂起多久算"长期未恢复"（ms）。默认 PAUSE_STALE_MS_DEFAULT。 */
  pauseStaleMs?: number;
  /** 同一条最多多久提醒一次（ms）。默认 REMIND_EVERY_MS_DEFAULT。 */
  remindEveryMs?: number;
  /** 现在（注入便于测试）。默认 new Date()。 */
  now?: Date;
}

export interface FollowupResult {
  /** 这次为多少条"超期未回"的委派写了提醒 */
  handoffs: number;
  /** 这次为多少条"长期未恢复"的挂起写了提醒 */
  pauses: number;
}

interface DanglingHandoffRow {
  id: string;
  project_id: string;
  from_agent_id: string;
  to_agent_id: string;
  task: string;
  deadline_at: string;
  from_name: string | null;
  to_name: string | null;
}

interface DanglingPauseRow {
  id: string;
  user_id: string;
  loop_id: string;
  agent_id: string | null;
  paused_at: string;
  goal_enc: string | null;
}

/** 找某智能体最新一条主会话的 id；没有返回 null */
async function latestConversationId(pool: Pool, agentId: number): Promise<number | null> {
  const r = await pool.query<{ id: string }>(
    'SELECT id FROM conversations WHERE agent_id=$1 ORDER BY id DESC LIMIT 1',
    [agentId],
  );
  return r.rows.length > 0 ? Number(r.rows[0].id) : null;
}

/** 往会话写一条 assistant 消息（正文密文，与 messages 同一套 AES-256-GCM） */
async function writeFollowupMessage(
  pool: Pool,
  cipher: JsonCipher,
  conversationId: number,
  text: string,
): Promise<void> {
  const enc = cipher.encryptText(text);
  await pool.query('INSERT INTO messages (conversation_id, role, content_enc) VALUES ($1,$2,$3)', [
    conversationId,
    'assistant',
    enc,
  ]);
}

/**
 * 扫两类"没人管了"的活，主动写对话流提醒。返回这次各写了多少条。
 * 任何单条失败只告警，不中断整批（提醒是"锦上添花"，不能把 Routines 扫搞挂）。
 */
export async function sweepDanglingFollowups(
  pool: Pool,
  cipher: JsonCipher,
  opts: FollowupOptions = {},
): Promise<FollowupResult> {
  const pauseStaleMs = opts.pauseStaleMs ?? PAUSE_STALE_MS_DEFAULT;
  const remindEveryMs = opts.remindEveryMs ?? REMIND_EVERY_MS_DEFAULT;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  /**
   * 两个"截止线"直接算成时间戳传进 SQL（不在库里做 interval 运算）：
   * 既避免 pglite 对命名参数 `make_interval(msecs => $n)` 的类型推断坑，
   * 也让"多久算长期 / 多久提醒一次"的口径一眼看得懂。
   */
  const remindCutoffIso = new Date(now.getTime() - remindEveryMs).toISOString();
  const staleCutoffIso = new Date(now.getTime() - pauseStaleMs).toISOString();

  let handoffs = 0;
  let pauses = 0;

  // --------------------------------------------------------------- 委派：超期未回
  try {
    const r = await pool.query<DanglingHandoffRow>(
      `SELECT d.id, d.project_id, d.from_agent_id, d.to_agent_id, d.task, d.deadline_at,
              fa.name AS from_name, ta.name AS to_name
         FROM agent_delegations d
         LEFT JOIN agents fa ON fa.id = d.from_agent_id
         LEFT JOIN agents ta ON ta.id = d.to_agent_id
        WHERE d.status = 'running'
          AND d.deadline_at < $1::timestamptz
          AND (d.last_followed_at IS NULL OR d.last_followed_at < $2::timestamptz)
        ORDER BY d.deadline_at ASC
        LIMIT ${BATCH_LIMIT}`,
      [nowIso, remindCutoffIso],
    );
    for (const d of r.rows) {
      try {
        const fromId = Number(d.from_agent_id);
        const convId = await latestConversationId(pool, fromId);
        if (convId === null) continue; // 没会话就跳过（没地方提醒），下次有会话再提醒
        const from = d.from_name ?? `#${d.from_agent_id}`;
        const to = d.to_name ?? `#${d.to_agent_id}`;
        const deadline = new Date(d.deadline_at).toLocaleString('zh-CN', { hour12: false });
        const text =
          `【协同·催办】#${d.id} ${from}→${to} 的委派已超期（${deadline} 到期）仍未回音：` +
          `请催一下对方，或自己接手处理。任务：${String(d.task).slice(0, 60)}`;
        await writeFollowupMessage(pool, cipher, convId, text);
        await pool.query('UPDATE agent_delegations SET last_followed_at=$1 WHERE id=$2', [
          nowIso,
          d.id,
        ]);
        handoffs += 1;
        console.log(`[followup] 委派 #${d.id} ${from}→${to} 超期未回 → 已写催办`);
      } catch (err) {
        console.warn(`[followup] 委派 #${d.id} 催办失败（跳过）：`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn('[followup] 扫超期委派失败（忽略）：', (err as Error).message);
  }

  // --------------------------------------------------------------- 挂起：长期未恢复
  try {
    const r = await pool.query<DanglingPauseRow>(
      `SELECT p.id, p.user_id, p.loop_id, p.agent_id, p.paused_at, p.goal_enc
         FROM task_pauses p
        WHERE p.resumed_at IS NULL
          AND p.paused_at < $1::timestamptz
          AND (p.last_followed_at IS NULL OR p.last_followed_at < $2::timestamptz)
        ORDER BY p.paused_at ASC
        LIMIT ${BATCH_LIMIT}`,
      [staleCutoffIso, remindCutoffIso],
    );
    for (const p of r.rows) {
      const agentId = p.agent_id !== null ? Number(p.agent_id) : null;
      if (!agentId || agentId <= 0) continue; // 没有归属智能体 → 没有会话可提醒，跳过
      try {
        const convId = await latestConversationId(pool, agentId);
        if (convId === null) continue;
        let goal = '';
        if (p.goal_enc) {
          try {
            goal = cipher.decryptText(p.goal_enc);
          } catch {
            goal = ''; // 解不出就不带目标，催办本身照常
          }
        }
        const minutes = Math.max(1, Math.round((now.getTime() - new Date(p.paused_at).getTime()) / 60000));
        const text =
          `【协同·催办】你有一条任务已挂起 ${minutes} 分钟还没恢复（loop ${p.loop_id}）：` +
          `要继续就恢复它，不要就停掉。` +
          (goal ? ` 目标：${goal.slice(0, 60)}` : '');
        await writeFollowupMessage(pool, cipher, convId, text);
        await pool.query('UPDATE task_pauses SET last_followed_at=$1 WHERE id=$2', [nowIso, p.id]);
        pauses += 1;
        console.log(`[followup] 挂起 loop ${p.loop_id} 已 ${minutes} 分钟未恢复（agent ${agentId}）→ 已写催办`);
      } catch (err) {
        console.warn(`[followup] 挂起 loop ${p.loop_id} 催办失败（跳过）：`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn('[followup] 扫长期挂起失败（忽略）：', (err as Error).message);
  }

  return { handoffs, pauses };
}
