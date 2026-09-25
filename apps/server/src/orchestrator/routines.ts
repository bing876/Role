/**
 * 定时/事件触发（Routines）：GrokBot 的 Routines，描述=长期规矩，对话=一次活
 *
 * 设计：
 * - 描述=长期规矩：Routine 的 description 是“一直有效的规矩”（如“每天早上 9 点查一下店铺数据”）
 * - 对话=一次活：每次触发产生一次具体的任务（task_template），写入对话流折叠摘要
 * - 数据/事件我们做，版式/文案归前端（用户后续 1:1 前端）
 *
 * 触发类型：
 * - interval: 每 N 分钟（最小 5 分钟，防刷）
 * - cron: 简化版 cron（分 时 日 月 周），先支持“每天 HH:MM”这种
 * - event: 事件触发（message, delegation_done, etc.），先做内存钩子，后续可扩展
 *
 * 调度：
 * - 启动时扫一次，之后每分钟扫一次 due 的 routines
 * - 触发时：写 messages（【协同·例行】）、写 collabChat、尝试启动 loop（若 agent 空闲）
 * - 幂等：last_run_at + next_run_at，同一 routine 同一分钟只触发一次
 */

import type { Pool } from 'pg';
import type { JsonCipher } from '../crypto';
import { writeCollabToAgentChat } from './collabChat';
import { sweepDanglingFollowups } from './followup';

export type RoutineTriggerType = 'interval' | 'cron' | 'event';

export interface RoutineRow {
  id: string;
  user_id: string;
  project_id: string;
  agent_id: string;
  name: string;
  description: string | null;
  trigger_type: RoutineTriggerType;
  trigger_config: any;
  task_template: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoutineView {
  id: number;
  projectId: number;
  agentId: number;
  agentName?: string;
  name: string;
  description: string;
  triggerType: RoutineTriggerType;
  triggerConfig: any;
  taskTemplate: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

function toView(row: RoutineRow, agentName?: string): RoutineView {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    agentId: Number(row.agent_id),
    agentName,
    name: row.name,
    description: row.description ?? '',
    triggerType: row.trigger_type as RoutineTriggerType,
    triggerConfig: row.trigger_config ?? {},
    taskTemplate: row.task_template,
    enabled: row.enabled,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
  };
}

/**
 * 计算下一次运行时间
 * - interval: last_run_at + intervalMinutes
 * - cron: 简化，只支持 daily HH:MM（trigger_config: {hour, minute}）
 * - event: 无 next_run_at，由事件钩子直接触发
 */
export function computeNextRun(triggerType: RoutineTriggerType, config: any, from: Date = new Date()): Date | null {
  if (triggerType === 'interval') {
    const mins = Number(config?.intervalMinutes ?? config?.minutes ?? 60);
    const safe = Math.max(5, Math.min(24 * 60 * 7, mins)); // 5 分钟 ~ 7 天
    return new Date(from.getTime() + safe * 60 * 1000);
  }
  if (triggerType === 'cron') {
    // 简化：每天 HH:MM
    const hour = Number(config?.hour ?? 9);
    const minute = Number(config?.minute ?? 0);
    const next = new Date(from);
    next.setSeconds(0, 0);
    next.setHours(hour, minute, 0, 0);
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }
  return null; // event 类型无固定 next
}

export async function listRoutines(pool: Pool, userId: number, projectId?: number | null): Promise<RoutineView[]> {
  const r = await pool.query<RoutineRow & { agent_name: string }>(
    `SELECT ar.*, a.name AS agent_name
       FROM agent_routines ar
       JOIN agents a ON a.id = ar.agent_id
       JOIN projects p ON p.id = ar.project_id
      WHERE ar.user_id = $1 AND ($2::bigint IS NULL OR ar.project_id = $2::bigint)
      ORDER BY ar.id DESC LIMIT 100`,
    [userId, projectId ?? null],
  );
  return r.rows.map((row) => toView(row, (row as any).agent_name));
}

export async function createRoutine(
  pool: Pool,
  input: {
    userId: number;
    projectId: number;
    agentId: number;
    name: string;
    description?: string;
    triggerType: RoutineTriggerType;
    triggerConfig: any;
    taskTemplate: string;
  },
): Promise<RoutineView> {
  const next = computeNextRun(input.triggerType, input.triggerConfig, new Date());
  const r = await pool.query<RoutineRow>(
    `INSERT INTO agent_routines (user_id, project_id, agent_id, name, description, trigger_type, trigger_config, task_template, enabled, next_run_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9) RETURNING *`,
    [
      input.userId,
      input.projectId,
      input.agentId,
      input.name.slice(0, 80),
      (input.description ?? '').slice(0, 300),
      input.triggerType,
      JSON.stringify(input.triggerConfig ?? {}),
      input.taskTemplate.slice(0, 600),
      next,
    ],
  );
  return toView(r.rows[0]);
}

export async function deleteRoutine(pool: Pool, userId: number, routineId: number): Promise<boolean> {
  const r = await pool.query('DELETE FROM agent_routines WHERE id=$1 AND user_id=$2', [routineId, userId]);
  return (r.rowCount ?? 0) > 0;
}

export async function setRoutineEnabled(pool: Pool, userId: number, routineId: number, enabled: boolean): Promise<boolean> {
  const r = await pool.query('UPDATE agent_routines SET enabled=$3, updated_at=now() WHERE id=$1 AND user_id=$2', [routineId, userId, enabled]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * 触发一个 routine：写入对话流 + 更新 last_run_at/next_run_at
 */
export async function triggerRoutine(
  pool: Pool,
  cipher: JsonCipher,
  routine: RoutineRow,
): Promise<void> {
  const agentId = Number(routine.agent_id);
  const task = routine.task_template;
  const name = routine.name;
  try {
    // 1. 写对话流：**一张**例行卡（kind='routine' 自带【协同·例行】前缀）。
    //    以前这里先直接 INSERT 一条、再走 collabChat 又写一条（「双重保障」）→
    //    每次触发连甩两张同类卡，第二张还嵌套【协同·系统】套【协同·例行】。
    //    2026-09-25 输出纪律③：单次触发只出一张。
    await writeCollabToAgentChat(pool, cipher, agentId, {
      kind: 'routine',
      fromId: agentId,
      fromName: name,
      toId: agentId,
      toName: name,
      status: 'routine',
      detail: `${name}：${task.slice(0, 200)}`,
      delegationId: Number(routine.id),
    });
    // 2. 更新时间戳
    const next = computeNextRun(routine.trigger_type as RoutineTriggerType, routine.trigger_config, new Date());
    await pool.query(`UPDATE agent_routines SET last_run_at=now(), next_run_at=$2, updated_at=now() WHERE id=$1`, [routine.id, next]);
    console.log(`[routines] 触发 Routine ${routine.id}「${name}」→ Agent ${agentId}`);
  } catch (err) {
    console.warn(`[routines] 触发失败 Routine ${routine.id}：`, (err as Error).message);
  }
}

/**
 * 扫 due 的 routines（interval/cron）
 */
export async function sweepDueRoutines(pool: Pool, cipher: JsonCipher): Promise<number> {
  try {
    const r = await pool.query<RoutineRow>(
      `SELECT * FROM agent_routines
        WHERE enabled=true AND trigger_type IN ('interval','cron') AND (next_run_at IS NULL OR next_run_at <= now())
        ORDER BY next_run_at ASC NULLS FIRST LIMIT 20`,
    );
    let count = 0;
    for (const row of r.rows) {
      await triggerRoutine(pool, cipher, row);
      count += 1;
    }
    return count;
  } catch (err) {
    console.warn('[routines] sweep 失败（忽略）：', (err as Error).message);
    return 0;
  }
}

/**
 * 事件触发：由外部调用（如 delegation 完成、收到消息等）
 */
export async function triggerByEvent(
  pool: Pool,
  cipher: JsonCipher,
  eventKind: string,
  context: { userId: number; projectId: number; agentId?: number },
): Promise<number> {
  try {
    const r = await pool.query<RoutineRow>(
      `SELECT * FROM agent_routines
        WHERE enabled=true AND trigger_type='event' AND user_id=$1 AND ($2::bigint=0 OR project_id=$2)
          AND (trigger_config->>'eventKind' = $3 OR trigger_config->>'eventKind' IS NULL)
        LIMIT 20`,
      [context.userId, context.projectId, eventKind],
    );
    let count = 0;
    for (const row of r.rows) {
      // 若 routine 指定了 agent，则只触发对应 agent
      if (context.agentId && Number(row.agent_id) !== context.agentId) continue;
      await triggerRoutine(pool, cipher, row);
      count += 1;
    }
    return count;
  } catch (err) {
    console.warn('[routines] event 触发失败（忽略）：', (err as Error).message);
    return 0;
  }
}

let sweepTimer: NodeJS.Timeout | null = null;

export function startRoutineSweeper(pool: Pool, cipher: JsonCipher, intervalMs = 60_000): void {
  if (sweepTimer) return;
  console.log(`[routines] 启动定时扫，每 ${intervalMs / 1000}s 一次`);
  const tick = async () => {
    await sweepDueRoutines(pool, cipher);
    /**
     * 批次 K：同一个 tick 顺手扫"掉线的活"（超期未回的委派 / 长期未恢复的挂起），
     * 该提醒的主动写对话流催办。幂等由 last_followed_at 兜着，30 分钟内不会重复喊。
     */
    await sweepDanglingFollowups(pool, cipher);
  };
  // 启动后 10s 先扫一次
  setTimeout(tick, 10_000).unref?.();
  sweepTimer = setInterval(tick, intervalMs);
  (sweepTimer as any).unref?.();
}

export function stopRoutineSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
