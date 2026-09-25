/**
 * 批次 L 片 2 | 自然语言建定时任务 —— 真建(chat 流的核心逻辑,不碰 HTTP/SSE)
 *
 * 输入一句话 + 上下文(用户/项目/本轮发言智能体),输出四选一:
 *   · not-a-routine  解析不出建任务意图 → 调用方(chat.ts)走正常 LLM 路径
 *   · unknown-agent  点名了名册外的智能体 → **不许偷偷挑最像的**,回话带现有名单
 *   · duplicate      同 agent + 同节奏 + 同任务已有 active routine → 不建第二个,回「已经有一个了」
 *   · created        真建(`createRoutine`),回话**必须带设成了什么**(节奏 + 任务)
 *
 * 回话口径(规格③):「已设成:运营助手 每天 09:00 检查店铺数据,结果发这里。」
 * 不是「好的」、更不是确认框 —— 一步到位。
 *
 * 结果去向的诚实口径:`triggerRoutine` 把例行结果写进**被点名的智能体**的最新主会话,
 * 所以点名的就是本轮发言人 → 说「结果发这里」;点的是别的智能体 → 说「结果发到 <TA> 的主会话」,
 * 不撒谎。
 *
 * HTTP/SSE 那一层(写 user/assistant 消息 + 流式回话)在 routes/chat.ts,与批次 E 建智能体同一口径。
 */

import type { Pool } from 'pg';
import { parseRoutineIntent } from './routineParser';
import { createRoutine } from './routines';
import { loadProjectRoster } from './roster';

export type RoutineCreateResult =
  | { kind: 'not-a-routine' }
  | { kind: 'unknown-agent'; reply: string }
  | { kind: 'duplicate'; reply: string }
  | { kind: 'created'; reply: string; routineId: number; agentId: number; agentName: string };

export interface RoutineCreateInput {
  userId: number;
  projectId: number;
  /** 本轮发言的智能体(没点名时的确定性落点 —— 不是猜) */
  speakerAgentId: number;
  message: string;
}

export async function createRoutineFromMessage(pool: Pool, opts: RoutineCreateInput): Promise<RoutineCreateResult> {
  // 名册先加载:F2b 节奏前置句「每天09:00让小助…」切"名字|任务"要靠它做精确前缀(不猜)
  const roster = await loadProjectRoster(pool, opts.userId, opts.projectId);
  const rosterNames = roster.map((r) => r.name);

  const intent = parseRoutineIntent(opts.message, { knownAgents: rosterNames });
  if (!intent) return { kind: 'not-a-routine' };

  // ---------------- ① 名字解析:只认**精确**名册名,解析不到不猜
  let agentId: number;
  let agentName: string;
  if (intent.agentName === null) {
    // 没点名:建给本轮发言人(这个会话的智能体)—— 确定性落点,不是"挑最像的"
    agentId = opts.speakerAgentId;
    agentName = roster.find((r) => Number(r.id) === agentId)?.name ?? `智能体${agentId}`;
  } else {
    const hit = roster.find((r) => r.name === intent.agentName);
    if (!hit) {
      const list = rosterNames.length > 0 ? rosterNames.map((n) => `『${n}』`).join('、') : '空(这个项目还没有智能体)';
      return {
        kind: 'unknown-agent',
        reply: `没找到叫『${intent.agentName}』的智能体,现在有:${list}。换个名字或直接说"让${rosterNames[0] ?? ''}…"我就设。`,
      };
    }
    agentId = Number(hit.id);
    agentName = hit.name;
  }

  // ---------------- ② 去重:同 agent + 同节奏 + 同任务,已有 active 的就不建第二个
  // JSONB 相等是语义相等(键序无关),所以 {hour,minute} 与 {minute,hour} 也认得
  const dup = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM agent_routines
      WHERE user_id=$1 AND agent_id=$2 AND trigger_type=$3 AND trigger_config=$4::jsonb
        AND task_template=$5 AND enabled=true
      ORDER BY id LIMIT 1`,
    [opts.userId, agentId, intent.triggerType, JSON.stringify(intent.triggerConfig), intent.taskTemplate],
  );
  if (dup.rowCount) {
    return {
      kind: 'duplicate',
      reply: `已经有一个了:${dup.rows[0].name}(${agentName} ${intent.scheduleLabel} ${intent.taskTemplate}),没再建第二个。`,
    };
  }

  // ---------------- 建 + ③ 回话必须带设成了什么(节奏 + 任务)
  const view = await createRoutine(pool, {
    userId: opts.userId,
    projectId: opts.projectId,
    agentId,
    name: intent.name,
    description: intent.description,
    triggerType: intent.triggerType,
    triggerConfig: intent.triggerConfig,
    taskTemplate: intent.taskTemplate,
  });
  const where =
    agentId === opts.speakerAgentId ? '结果发这里。' : `结果发到${agentName}的主会话。`;
  return {
    kind: 'created',
    reply: `已设成:${agentName} ${intent.scheduleLabel} ${intent.taskTemplate},${where}`,
    routineId: view.id,
    agentId,
    agentName,
  };
}
