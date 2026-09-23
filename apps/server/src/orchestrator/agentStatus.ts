/**
 * 状态承载到联系人：头像即状态
 *
 * Grok 取舍：只留 Bots/Chats/Prompts/Tools/Artifacts，Bot 是主对象，头像即状态
 * - idle/thinking/working/waiting/blocked/done 六态，前端用头像边框/角标表达，不做六个独立指示器
 * - 数据/接口我们做，版式/文案/样式归用户（后续 1:1 前端）
 *
 * 状态机：
 * - waiting: 正在等自己委派出去的结果（waitingAgents）
 * - working: 手上有活（busyAgents）或有 running 的循环且最近在操作浏览器/委派/临时工
 * - thinking: 有 running 循环但还没进浏览器（LLM 调用中、web_search、spawn_workers 准备）
 * - blocked: 循环在 paused/waiting（需要用户）或 recent delegation need_user
 * - done: 循环最近 done（5 分钟内）或 delegation 刚 done
 * - idle: 其余
 *
 * 计算入口：resolveAgentStatus(agentId) → AgentLiveStatus
 */

import { isAgentWaiting, agentBusyCount } from './registry';
import { latestLoopOfAgent, loopsOfAgent } from '../toolLoop';

export type AvatarStatus = 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked' | 'done';

export interface AgentLiveStatus {
  status: AvatarStatus;
  detail: string;
  loopId?: string | null;
  step?: number;
  updatedAt: number;
}

const DONE_WINDOW_MS = 5 * 60 * 1000;

export function resolveAgentStatus(agentId: number): AgentLiveStatus {
  const now = Date.now();
  const waiting = isAgentWaiting(agentId);
  const busy = agentBusyCount(agentId);
  const loops = loopsOfAgent(agentId);
  const latest = latestLoopOfAgent(agentId);

  if (waiting) {
    return {
      status: 'waiting',
      detail: '正在等委派结果',
      loopId: latest?.id ?? null,
      step: latest?.step,
      updatedAt: now,
    };
  }

  if (!latest) {
    if (busy > 0) {
      return { status: 'working', detail: '正在处理被委派的活', updatedAt: now };
    }
    return { status: 'idle', detail: '空闲', updatedAt: now };
  }

  const age = now - latest.touchedAt;
  const status = latest.status;

  if (status === 'paused') {
    return {
      status: 'blocked',
      detail: latest.pause ? `已暂停：${latest.pause.by}` : '已暂停，需要你',
      loopId: latest.id,
      step: latest.step,
      updatedAt: now,
    };
  }
  if (status === 'waiting') {
    return {
      status: 'blocked',
      detail: '需要你处理',
      loopId: latest.id,
      step: latest.step,
      updatedAt: now,
    };
  }
  if (status === 'waiting_job') {
    return {
      status: 'waiting',
      detail: '等子任务中',
      loopId: latest.id,
      step: latest.step,
      updatedAt: now,
    };
  }
  if (status === 'running') {
    // 根据最近使用的工具判断 thinking vs working
    const used = latest.usedTools ?? [];
    const last = used[used.length - 1];
    const isBrowserTool = last && ['open_url', 'click', 'type', 'scroll', 'read_page'].includes(last);
    const isThinkingTool = last && ['web_search', 'spawn_workers'].includes(last);
    if (isBrowserTool || busy > 0) {
      return { status: 'working', detail: `第 ${latest.step} 步：${last}`, loopId: latest.id, step: latest.step, updatedAt: now };
    }
    if (isThinkingTool || used.length === 0) {
      return { status: 'thinking', detail: '思考中', loopId: latest.id, step: latest.step, updatedAt: now };
    }
    return { status: 'working', detail: `第 ${latest.step} 步`, loopId: latest.id, step: latest.step, updatedAt: now };
  }
  if (status === 'done') {
    if (age < DONE_WINDOW_MS) {
      return { status: 'done', detail: '刚完成', loopId: latest.id, step: latest.step, updatedAt: now };
    }
    return { status: 'idle', detail: '空闲', updatedAt: now };
  }
  if (status === 'failed' || status === 'stopped') {
    if (age < DONE_WINDOW_MS) {
      return { status: 'blocked', detail: status === 'failed' ? '失败' : '已停止', loopId: latest.id, step: latest.step, updatedAt: now };
    }
    return { status: 'idle', detail: '空闲', updatedAt: now };
  }

  return { status: 'idle', detail: '空闲', updatedAt: now };
}

export function resolveAgentStatuses(agentIds: number[]): Record<number, AgentLiveStatus> {
  const out: Record<number, AgentLiveStatus> = {};
  for (const id of agentIds) {
    out[id] = resolveAgentStatus(id);
  }
  return out;
}
