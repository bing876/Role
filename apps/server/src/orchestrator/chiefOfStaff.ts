/**
 * 总协调路由：Chief-of-Staff 管家判断自己干/派谁
 * 批次 C | 路由升级 — description 为燃料：字面匹配→关键词加权/嵌入；前端对"通用助手"这类空描述给警告
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
 * 路由策略升级（批次 C）：
 * - 字面匹配 → 关键词加权/嵌入：description 为燃料
 *   - 关键词加权：duty 分词后按长度、位置、重要性加权，任务命中高权重词得分更高
 *   - 嵌入：简化版语义相似度（Jaccard + 加权），可扩展为真实 embedding（预留接口）
 * - 空描述警告：通用助手/助手/AI助手等空描述，前端给警告，路由时降低优先级
 * - 确定性优先，不依赖模型自觉
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
  method: 'duty_match' | 'keyword_weighted' | 'embedding' | 'hen_fallback' | 'assistant_fallback' | 'explicit' | 'keep_current';
  score?: number;
  warning?: string;
}

// ---------------- 空描述检测（前端警告用） ----------------

const GENERIC_DUTIES = new Set([
  '通用助手',
  '助手',
  'AI助手',
  'ai助手',
  '智能助手',
  '通用',
  '帮你',
  '帮助',
  '助理',
  '小助手',
  '小助',
  'assistant',
  'general assistant',
  'helper',
]);

export function detectEmptyDuty(duty: string): { empty: boolean; warning?: string } {
  const d = (duty ?? '').trim();
  if (!d) return { empty: true, warning: '职责为空，路由时优先级降低，前端应警告用户补全描述' };
  if (d.length < 5) return { empty: true, warning: `职责过短（${d.length}字），建议补全具体职责，前端应警告` };
  const lower = d.toLowerCase();
  if (GENERIC_DUTIES.has(d) || GENERIC_DUTIES.has(lower)) {
    return { empty: true, warning: `职责为通用描述「${d}」，路由燃料不足，前端应警告用户改为具体职责` };
  }
  // 包含通用词且无具体动词
  if (/^(我是|我是一个|我能|我可以)?(通用|普通|万能)?(助手|助理|AI|智能)/.test(d) && d.length < 15) {
    return { empty: true, warning: `职责「${d}」过于通用，路由时作为兜底，前端应提示细化` };
  }
  return { empty: false };
}

// ---------------- 分词与关键词加权 ----------------

function tokenize(text: string): string[] {
  const raw = text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/g).filter((w) => w.length >= 2);
  const out: string[] = [];
  for (const token of raw) {
    out.push(token);
    // 中文长句：额外拆成 2 字词，提升命中率（description 为燃料，关键词加权）
    if (/[\u4e00-\u9fa5]/.test(token) && token.length > 2) {
      for (let i = 0; i <= token.length - 2; i++) {
        const bigram = token.slice(i, i + 2);
        if (bigram.length === 2) out.push(bigram);
      }
      // 同时保留单字中重要词（长度 1 但在重要表里的，单独处理）
    }
  }
  return out;
}

// 重要关键词表：这些词命中时权重更高（动词/领域词）
const IMPORTANT_KEYWORDS = new Set([
  '搜索',
  '分析',
  '整理',
  '诊断',
  '运营',
  '客服',
  '销售',
  '技术',
  '开发',
  '设计',
  '写作',
  '翻译',
  '财务',
  '数据',
  '调研',
  '策划',
  '推广',
  '选品',
  '店铺',
  '订单',
  '物流',
  '退款',
  '投诉',
  'research',
  'analysis',
  'write',
  'translate',
  'code',
  'design',
  'data',
  'sales',
  'marketing',
]);

function weightForToken(token: string, position: number, total: number): number {
  let w = 1;
  // 长度加权：长词更具体
  w += Math.min(2, token.length / 4);
  // 位置加权：越靠前越重要（职责描述通常前面是核心）
  w += (total - position) / total;
  // 重要性加权
  if (IMPORTANT_KEYWORDS.has(token)) w += 1.5;
  return w;
}

function scoreDutyWeighted(task: string, duty: string): number {
  if (!duty) return 0;
  const { empty } = detectEmptyDuty(duty);
  if (empty) return 0; // 空描述不参与加权匹配，走兜底

  const taskTokens = new Set(tokenize(task));
  const dutyTokens = tokenize(duty);
  if (dutyTokens.length === 0) return 0;

  let score = 0;
  let totalWeight = 0;
  for (let i = 0; i < dutyTokens.length; i++) {
    const t = dutyTokens[i];
    const w = weightForToken(t, i, dutyTokens.length);
    totalWeight += w;
    if (taskTokens.has(t)) {
      score += w;
    } else if ([...taskTokens].some((tt) => tt.includes(t) || t.includes(tt))) {
      score += w * 0.5;
    }
  }
  return totalWeight > 0 ? score / totalWeight : 0;
}

// 简化版嵌入相似度：Jaccard + 加权，预留真实 embedding 接口
function scoreDutyEmbedding(task: string, duty: string): number {
  if (!duty) return 0;
  const { empty } = detectEmptyDuty(duty);
  if (empty) return 0;

  const taskTokens = new Set(tokenize(task));
  const dutyTokens = new Set(tokenize(duty));
  if (taskTokens.size === 0 || dutyTokens.size === 0) return 0;

  // Jaccard
  let intersection = 0;
  for (const t of dutyTokens) {
    if (taskTokens.has(t)) intersection += 1;
  }
  const union = new Set([...taskTokens, ...dutyTokens]).size;
  const jaccard = union > 0 ? intersection / union : 0;

  // 加权命中
  const weighted = scoreDutyWeighted(task, duty);

  // 融合：加权 70% + Jaccard 30%
  return weighted * 0.7 + jaccard * 0.3;
}

// 兼容旧接口：字面匹配（保留）
function scoreDuty(task: string, duty: string): number {
  return scoreDutyWeighted(task, duty);
}

export function routeByDuty(task: string, roster: RosterEntry[]): RouteDecision | null {
  return routeByKeywordWeighted(task, roster);
}

export function routeByKeywordWeighted(task: string, roster: RosterEntry[]): RouteDecision | null {
  if (roster.length === 0) return null;
  let best: RosterEntry | null = null;
  let bestScore = 0;
  for (const r of roster) {
    if (r.busy || r.waiting) continue;
    const s = scoreDutyWeighted(task, r.duty);
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }
  if (!best || bestScore <= 0) return null;
  return {
    toAgentId: best.id,
    toAgentName: best.name,
    reason: `关键词加权匹配度 ${(bestScore * 100).toFixed(0)}%：${best.duty.slice(0, 60)}`,
    method: 'keyword_weighted',
    score: bestScore,
  };
}

export function routeByEmbedding(task: string, roster: RosterEntry[]): RouteDecision | null {
  if (roster.length === 0) return null;
  let best: RosterEntry | null = null;
  let bestScore = 0;
  for (const r of roster) {
    if (r.busy || r.waiting) continue;
    const s = scoreDutyEmbedding(task, r.duty);
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }
  if (!best || bestScore <= 0) return null;
  return {
    toAgentId: best.id,
    toAgentName: best.name,
    reason: `嵌入相似度 ${(bestScore * 100).toFixed(0)}%：${best.duty.slice(0, 60)}`,
    method: 'embedding',
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

  if (opts?.explicitAgentId) {
    const found = roster.find((r) => r.id === opts.explicitAgentId);
    if (found) {
      const { empty, warning } = detectEmptyDuty(found.duty);
      return {
        toAgentId: found.id,
        toAgentName: found.name,
        reason: '用户显式指定',
        method: 'explicit',
        warning: empty ? warning : undefined,
      };
    }
  }

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

  // 关键词加权优先，其次嵌入
  const weighted = routeByKeywordWeighted(task, roster);
  if (weighted) return weighted;
  const embedded = routeByEmbedding(task, roster);
  if (embedded) return embedded;

  // 空描述警告：收集空职责的 agent，前端可提示
  const emptyDuties = roster.filter((r) => !r.busy && !r.waiting && detectEmptyDuty(r.duty).empty);
  const warning = emptyDuties.length > 0 ? `项目中有 ${emptyDuties.length} 个智能体职责为空/通用（${emptyDuties.map((r) => r.name).join('、')}），路由燃料不足，前端应警告` : undefined;

  const henByName = roster.find((r) => r.name === '项目管家' && !r.busy && !r.waiting);
  if (henByName) {
    return {
      toAgentId: henByName.id,
      toAgentName: henByName.name,
      reason: '职责未命中，交由项目管家判断',
      method: 'hen_fallback',
      warning,
    };
  }
  const idle = roster.find((r) => !r.busy && !r.waiting);
  if (idle) {
    return {
      toAgentId: idle.id,
      toAgentName: idle.name,
      reason: '职责未命中，交由空闲智能体',
      method: idle.name.includes('小助') ? 'assistant_fallback' : 'hen_fallback',
      warning,
    };
  }
  return null;
}

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
      detail: `【协同·路由】${decision.method} → ${decision.toAgentName}：${decision.reason} | 任务：${task.slice(0, 100)}${decision.warning ? ` | 警告：${decision.warning}` : ''}`,
    });
  } catch {}
}
