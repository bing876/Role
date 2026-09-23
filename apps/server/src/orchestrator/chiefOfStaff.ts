/**
 * 总协调路由：Chief-of-Staff 管家判断自己干/派谁
 *
 * Grok 取舍：用户自发造 Chief-of-Staff 做路由，砍仪表盘/指派板/手动交接
 * - 主对象是 Bot，管家是「项目管家」hen，负责判断任务归属
 * - 数据/接口我们做，版式/文案归前端
 *
 * 流程：
 * 1. 用户发消息未指定 agent → 路由到管家或最匹配职责的智能体
 * 2. 管家收到后自行判断：自己干 / delegate 给更合适的同事（走既有 delegate 工具）
 * 3. 路由决策写入对话流【协同·路由】，折叠摘要
 *
 * 路由策略（确定性优先，不依赖模型自觉）：
 * - 关键词/职责字面匹配（duty 含任务关键词）→ 匹配度最高者
 * - 否则走管家（hen）或小助（assistant）兜底，让它自己决定是否再委派
 * - 若有 LLM，可用轻量路由提示词二次确认（可选，不阻塞主流程）
 */

import type { Pool } from 'pg';
import { loadProjectRoster } from './roster';
import type { RosterEntry } from './prompts';
import type { JsonCipher } from '../crypto';
import { writeCollabToAgentChat } from './collabChat';

export interface RouteDecision {
  toAgentId: number;
  toAgentName: string;
  reason: string;
  method: 'duty_match' | 'hen_fallback' | 'assistant_fallback' | 'explicit' | 'keep_current';
  score?: number;
}

/**
 * 简单的职责匹配：任务文本与 duty 的字面重叠度
 * - 中文分词用最简实现：按非字母数字切，长度>1的词
 * - 英文同样
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/g)
    .filter((w) => w.length >= 2);
}

function scoreDuty(task: string, duty: string): number {
  if (!duty) return 0;
  const taskTokens = new Set(tokenize(task));
  const dutyTokens = tokenize(duty);
  if (dutyTokens.length === 0) return 0;
  let hit = 0;
  for (const t of dutyTokens) {
    if (taskTokens.has(t)) hit += 1;
    // 包含关系也算半分
    else if ([...taskTokens].some((tt) => tt.includes(t) || t.includes(tt))) hit += 0.5;
  }
  return hit / dutyTokens.length;
}

export function routeByDuty(task: string, roster: RosterEntry[]): RouteDecision | null {
  if (roster.length === 0) return null;
  let best: RosterEntry | null = null;
  let bestScore = 0;
  for (const r of roster) {
    if (r.busy || r.waiting) continue; // 忙/等的跳过，避免死循环
    const s = scoreDuty(task, r.duty);
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }
  if (!best || bestScore <= 0) return null;
  return {
    toAgentId: best.id,
    toAgentName: best.name,
    reason: `职责匹配度 ${(bestScore * 100).toFixed(0)}%：${best.duty.slice(0, 60)}`,
    method: 'duty_match',
    score: bestScore,
  };
}

export async function routeTask(
  pool: Pool,
  userId: number,
  projectId: number,
  task: string,
  opts?: { currentAgentId?: number | null; explicitAgentId?: number | null },
): Promise<RouteDecision | null> {
  const roster = await loadProjectRoster(pool, userId, projectId, null);
  if (roster.length === 0) return null;

  // 显式指定 agent → 保持
  if (opts?.explicitAgentId) {
    const found = roster.find((r) => r.id === opts.explicitAgentId);
    if (found) {
      return {
        toAgentId: found.id,
        toAgentName: found.name,
        reason: '用户显式指定',
        method: 'explicit',
      };
    }
  }

  // 当前会话已有归属 agent → 保持，不重路由（避免中途换人）
  if (opts?.currentAgentId) {
    const cur = roster.find((r) => r.id === opts.currentAgentId);
    if (cur) {
      return {
        toAgentId: cur.id,
        toAgentName: cur.name,
        reason: '保持当前会话归属',
        method: 'keep_current',
      };
    }
  }

  // 职责匹配
  const dutyMatch = routeByDuty(task, roster);
  if (dutyMatch) return dutyMatch;

  // 管家兜底：hen > assistant > 第一个空闲
  const hen = roster.find((r) => r.id && !r.busy && !r.waiting && r.name.includes('管家')) || roster.find((r) => (r as any).kind === 'hen');
  // roster Entry 没有 kind，需另查，但先用名字匹配
  const henByName = roster.find((r) => r.name === '项目管家' && !r.busy && !r.waiting);
  if (henByName) {
    return {
      toAgentId: henByName.id,
      toAgentName: henByName.name,
      reason: '职责未命中，交由项目管家判断',
      method: 'hen_fallback',
    };
  }
  const idle = roster.find((r) => !r.busy && !r.waiting);
  if (idle) {
    return {
      toAgentId: idle.id,
      toAgentName: idle.name,
      reason: '职责未命中，交由空闲智能体',
      method: idle.name.includes('小助') ? 'assistant_fallback' : 'hen_fallback',
    };
  }
  return null;
}

/**
 * 写入路由决策到对话流（无感核心：协同进对话流）
 */
export async function logRouteDecision(
  pool: Pool,
  cipher: JsonCipher,
  decision: RouteDecision,
  task: string,
  fromName = '系统',
): Promise<void> {
  try {
    await writeCollabToAgentChat(pool, cipher, decision.toAgentId, {
      kind: 'system',
      fromId: decision.toAgentId,
      fromName,
      toId: decision.toAgentId,
      toName: decision.toAgentName,
      status: 'routed',
      detail: `【协同·路由】${decision.method} → ${decision.toAgentName}：${decision.reason} | 任务：${task.slice(0, 100)}`,
    });
  } catch {}
}
