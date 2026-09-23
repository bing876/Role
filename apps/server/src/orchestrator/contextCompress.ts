/**
 * 上下文压缩：toolLoop 只增不减，长任务必爆 —— 做学习内核的前置
 *
 * 问题：toolLoop 的 session.messages 只增不减，每步追加 user/assistant/tool，20 步后轻松上万 token，30 步必爆
 * 解法（数据/事件做，版式归前端）：
 * - 保留首条 system + 首条 user（目标+人设+编排块+记忆块）
 * - 保留最近 N 步（默认 8 步）的完整 tool 交互
 * - 中间老的历史压缩成一条 assistant 摘要：目标、已走步数、关键发现、当前状态
 * - 压缩是确定性的，不依赖模型自觉（模型自己不会说“我历史太长了帮我压缩”）
 *
 * 触发条件：
 * - 消息数 > 20 或 估算 token > 8000（按 char/4 粗算）
 * - 每 5 步检查一次，避免每步都压缩
 *
 * 压缩后：
 * - 消息数回到 1(system) + 1(user goal) + 1(summary) + 最近 N*2 条
 * - 保留 loop 的 step、usedTools 等元信息，不丢
 */

import type { LoopSession } from '../toolLoop';

const KEEP_RECENT_STEPS = 8;
const COMPRESS_THRESHOLD_MSGS = 20;
const COMPRESS_THRESHOLD_TOKENS = 8000;
const CHECK_EVERY_STEPS = 5;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessagesTokens(messages: Array<{ content: string }>): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content ?? '');
  }
  return total;
}

function buildSummary(session: LoopSession, compressedCount: number): string {
  const goal = session.goal ?? '（未记录目标）';
  const step = session.step;
  const tools = (session.usedTools ?? []).slice(-10).join('、') || '无';
  const recentToolResults = session.messages
    .filter((m: any) => m.role === 'tool')
    .slice(-3)
    .map((m: any) => {
      const c = String((m as any).content ?? '').slice(0, 200);
      return `- ${c}`;
    })
    .join('\n');
  return [
    `【上下文压缩·已压缩 ${compressedCount} 条历史】`,
    `目标：${goal.slice(0, 200)}`,
    `已走：${step} 步`,
    `最近工具：${tools}`,
    `最近结果摘要：`,
    recentToolResults || '（无）',
    `（以上为自动压缩的摘要，中间详细过程已折叠，保留首条目标与最近 ${KEEP_RECENT_STEPS} 步完整记录）`,
  ].join('\n');
}

export function shouldCompress(session: LoopSession): boolean {
  if (session.step % CHECK_EVERY_STEPS !== 0) return false;
  if (session.messages.length <= COMPRESS_THRESHOLD_MSGS) return false;
  const tokens = estimateMessagesTokens(session.messages as any);
  return tokens > COMPRESS_THRESHOLD_TOKENS || session.messages.length > COMPRESS_THRESHOLD_MSGS;
}

export function compressSession(session: LoopSession): { compressed: boolean; before: number; after: number } {
  const before = session.messages.length;
  if (before <= 2) return { compressed: false, before, after: before };

  // 保留：system(首条) + user goal(第二条) + 最近 N*2 条
  // 假设前两条是 system + user（startLoop 的拼装），其余是 tool 交互
  const system = session.messages[0];
  const userGoal = session.messages[1];
  if (!system || !userGoal) return { compressed: false, before, after: before };

  const keepCount = KEEP_RECENT_STEPS * 2; // 每步大约 assistant+tool 两条
  if (before <= 2 + keepCount) return { compressed: false, before, after: before };

  const compressedCount = before - 2 - keepCount;
  const recent = session.messages.slice(-keepCount);
  const summary = buildSummary(session, compressedCount);

  // 新消息列表：system + userGoal + summary(assistant) + recent
  const summaryMsg = {
    role: 'assistant' as const,
    content: summary,
  };

  session.messages = [system, userGoal, summaryMsg as any, ...recent] as any;

  const after = session.messages.length;
  console.log(`[context-compress] 循环 ${session.id} 压缩：${before} → ${after} 条（压掉 ${compressedCount} 条），step=${session.step}`);
  return { compressed: true, before, after };
}

/**
 * 在 advance 前调用，必要时压缩
 */
export function compressIfNeeded(session: LoopSession): void {
  if (!shouldCompress(session)) return;
  compressSession(session);
}
