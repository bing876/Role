import type { AgentView, ConversationStateView, TaskState } from '@ai-workbench/shared';

/** ADR-0012：底层协议不删；六种运行事实收敛为四种头像形态。 */
export type RunPhase = 'idle' | 'thinking' | 'working' | 'blocked' | 'failed' | 'sleeping';
export type AvatarMode = 'idle' | 'working' | 'blocked' | 'failed';
export type RunBarMode = 'running' | 'paused';

export interface RunFacts {
  phase: RunPhase;
  avatar: { mode: AvatarMode; word: string; color: string };
  /** 左栏第二行、头像 title、可见度提示共用的“它在干嘛”；思考/休眠只出现在细节里。 */
  doing: string;
  visibilityHint: string;
  runBar: { mode: RunBarMode; text: string; yielded: boolean } | null;
  /** 本地已收到暂停回执，输入框可以发送「继续」；不能把普通求助误作可交还。 */
  resumeAwaited: boolean;
  driveState: { cls: 'user' | 'agent' | 'none'; icon: string; text: string } | null;
  sessionHint: string | null;
  step: number | null;
}

export interface RunFactsInput {
  /** 已按 agentId 确认归属的名单项。 */
  agent: AgentView | null;
  conversation?: ConversationStateView | null;
  /** 只能传属于此智能体的任务镜像（带 wcId 时先经 tab 找 owner）。 */
  task?: TaskState | null;
  /** 在途信号只补未确认的窗口，不得将暂停/求助/失败覆盖成执行。 */
  inFlight?: {
    streaming?: boolean;
    loopId?: string | null;
    /** 接收 task 镜像当时的循环；无关联证据时不猜镜像已过期。 */
    taskObservedLoopId?: string | null;
    paused?: boolean;
    activeWebContentsId?: number | null;
    lastStep?: string | null;
  };
}

const AVATAR: Record<AvatarMode, { word: string; color: string }> = {
  idle: { word: '空闲', color: '#8b93a1' },
  working: { word: '执行', color: '#46b57c' },
  blocked: { word: '需你处理', color: '#e0a63a' },
  failed: { word: '出错', color: '#e05c5c' },
};

/** 唯一状态词典：App / ComputerVisibility 不再分别解释 status / streaming / pausedBy。 */
export function deriveRunFacts({ agent, conversation, task, inFlight }: RunFactsInput): RunFacts {
  const status = agent?.status ?? 'idle';
  const detail = agent?.statusDetail?.trim();
  const pausedHere = inFlight?.paused === true;
  const streamingLoop = Boolean(inFlight?.loopId) && inFlight?.streaming === true;
  // 名单可能仍指旧循环；但主进程镜像可能比名单更新。只有接收镜像时
  // **确实看见旧循环**、现在已确认新循环且无本地暂停，才盖过旧镜像的用户暂停/完成/失败。
  const newerThanAgent = !pausedHere && streamingLoop && Boolean(agent?.statusLoopId) &&
    inFlight?.loopId !== agent?.statusLoopId;
  const staleTask = newerThanAgent && Boolean(inFlight?.taskObservedLoopId) &&
    inFlight?.taskObservedLoopId === agent?.statusLoopId;
  const taskPaused = task?.phase === 'paused' && !(task.pausedBy === 'user' && staleTask);
  const yielded = task?.phase === 'running' && task.detail === '你在操作，我停下了' &&
    inFlight?.activeWebContentsId != null && task.wcId === inFlight.activeWebContentsId;

  let phase: RunPhase;
  let explanation: string;
  if (task?.phase === 'failed' && !staleTask) {
    phase = 'failed';
    explanation = task.detail || '这一步没走通';
  } else if (task?.phase === 'done' && !staleTask) {
    phase = 'idle';
    explanation = '刚干完一单';
  } else if (taskPaused && task?.pausedBy === 'agent') {
    phase = 'blocked';
    explanation = task.detail || 'AI 主动求助，等你处理';
  } else if (pausedHere) {
    phase = 'blocked';
    explanation = '已暂停，等你说「继续」';
  } else if (taskPaused) {
    phase = 'blocked';
    explanation = task?.pausedBy === 'user' ? '你在操作，AI 已暂停' : '已暂停，未记下是谁发起的';
  } else if (yielded) {
    phase = 'blocked';
    explanation = '你在操作，我停下了';
  } else if (task?.phase === 'running') {
    phase = 'working';
    explanation = status === 'thinking' ? (detail || '思考中，在想下一步怎么做') :
      status === 'working' || status === 'waiting' ? (detail || '正在动手干活') : '正在动手干活';
  } else if (status === 'blocked' && !newerThanAgent) {
    phase = 'blocked';
    explanation = detail || '卡住了，等你看一眼';
  } else if (status === 'failed' && !newerThanAgent) {
    phase = 'failed';
    explanation = detail || '上一步出错了，没走通';
  } else if (streamingLoop) {
    phase = 'working';
    explanation = inFlight?.lastStep ? `正在：${inFlight.lastStep}` : '正在操作浏览器…';
  } else if (status === 'thinking') {
    phase = 'thinking';
    explanation = detail || '思考中，在想下一步怎么做';
  } else if (status === 'working' || status === 'waiting') {
    phase = 'working';
    explanation = detail || (status === 'waiting' ? '正在等待同事结果' : '正在动手干活');
  } else if (inFlight?.streaming) {
    phase = 'thinking';
    explanation = '思考中，正在回复你';
  } else if (status === 'sleeping' || (status === 'idle' && !(conversation?.keepalive ?? agent?.listening))) {
    phase = 'sleeping';
    explanation = '休眠，没在监听';
  } else {
    phase = 'idle';
    explanation = status === 'done' ? (detail || '刚干完一单') : (detail || '闲着，随时能派活');
  }

  const mode: AvatarMode = phase === 'thinking' ? 'working' : phase === 'sleeping' ? 'idle' : phase;
  const doing = `它在干嘛：${explanation}`;
  let runBar: RunFacts['runBar'] = null;
  if (phase === 'blocked' && yielded && !pausedHere && !taskPaused) {
    runBar = { mode: 'paused', text: '你在操作，我停下了', yielded: true };
  } else if (phase === 'blocked' && (pausedHere || taskPaused)) {
    runBar = { mode: 'paused', text: pausedHere ? '已暂停 · 说「继续」接上' :
      task?.pausedBy === 'agent' ? '需要你处理 · AI 已暂停' : '已暂停 · 说「继续」接上', yielded: false };
  } else if ((phase === 'working' || phase === 'thinking') &&
    (task?.phase === 'running' || streamingLoop || Boolean(agent?.statusLoopId && (status === 'thinking' || status === 'working' || status === 'waiting')))) {
    runBar = { mode: 'running', text: inFlight?.lastStep ? `正在：${inFlight.lastStep}` : '正在操作浏览器…', yielded: false };
  }

  let driveState: RunFacts['driveState'] = null;
  if (taskPaused && task) {
    if (task.pausedBy === 'agent') {
      driveState = { cls: 'agent', icon: '🤖', text: `AI 主动求助 · 等你处理 — ${task.detail}` };
    } else if (task.pausedBy === 'user') {
      driveState = { cls: 'user', icon: '✋', text: `你在操作 · AI 已暂停，页面归你 — ${task.detail}` };
    } else {
      driveState = { cls: 'none', icon: '⏸', text: `已暂停（未记录发起方）— ${task.detail}` };
    }
  }
  const sessionHint = conversation && (conversation.current_task || conversation.keepalive || conversation.browser_confirmed)
    ? `${conversation.keepalive ? '● 监听中（保活：空闲不调模型）' : '○ 未保活'}${conversation.current_task ? ` · 当前任务：${conversation.current_task}` : ''}${conversation.browser_confirmed ? ' · 本会话已同意用浏览器' : ''}`
    : null;
  const step = staleTask ? null : task && task.step > 0 ? task.step :
    newerThanAgent ? null : agent?.statusStep ?? null;
  return { phase, avatar: { mode, ...AVATAR[mode] }, doing, visibilityHint: doing, runBar, resumeAwaited: phase === 'blocked' && pausedHere, driveState, sessionHint, step };
}
