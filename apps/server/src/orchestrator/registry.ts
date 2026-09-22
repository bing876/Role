/**
 * 多智能体编排 · **后台子任务登记表**（临时工批次 / 委派）+ 名额闸。
 *
 * 这个文件解决三件事，缺一不可：
 *
 *   1. **「用完即销毁」的落点**：临时工没有身份、没有记忆，任务一完成就从 `jobs` 里删掉 ——
 *      不留名字、不留记忆、不留句柄。`/health` 的 `jobs.live` 能证明它真的消失了。
 *   2. **「挂起 → 结果回来自动续跑」的桥**：每个 job 有一个 `done` Promise。
 *      发起方循环 park 在 `waiting_job` 上；结果到达时由调用方把结构化结果当作
 *      **那一格工具的正式回执**注入历史（`toolLoop.deliverJobResult`）。
 *      同进程直接 await，不走 HTTP —— 委派可能跑 10 分钟，任何 HTTP 等待都会超时。
 *   3. **确定性闸（不靠模型自觉）**：全局 job 上限、每循环累计上限、
 *      「谁在等结果」（`waitingAgents`）、「谁正在处理被委派的活」（`busyAgents`）。
 *      用户提的两条安全要求（防死循环 + 10 分钟熔断）就落在这两张表 + 每个 job 的 deadline 上。
 *
 * ★ 全是**进程内内存**：这是刻意的。跨重启要留存的那一份在 `agent_delegations` 表里
 *   （UI 与验收读它）；内存这份只管「现在正在跑什么、谁占着名额」。两者职责不重叠。
 *
 * ★ 依赖方向：本文件**不 import** toolLoop / delegation —— 只暴露纯数据结构与闸。
 *   谁用谁调，避免循环依赖。
 */
import type { AgentJobKind } from '@ai-workbench/shared';
import { ORCH_DEFAULTS, type OrchestratorEnv } from '../env';

/** 一个后台子任务 */
export interface AgentJob {
  id: string;
  kind: AgentJobKind;
  userId: number;
  projectId: number | null;
  /** 发起方循环（park 在它上面；结果回来投给它） */
  ownerLoopId: string;
  ownerAgentId: number | null;
  startedAt: number;
  deadlineAt: number;
  status: 'running' | 'done' | 'cancelled';
  /** 被取消的原因（'timeout' / 'owner_stopped' / 'user_stop' …） */
  cancelReason?: string;
  /** 结果是否已经投递给发起方（幂等凭据：只投递一次） */
  resultReady: boolean;
  /** 取消它：置 cancelled + 触发 deadline 之外的那条路（由创建方给具体动作） */
  cancel: (reason: string) => void;
  /** 结束时 resolve（成功/失败/取消都算结束）—— 子循环 runner 直接 await 它 */
  done: Promise<void>;
  /** 关联的委派行（kind='delegate' 时有） */
  delegationId?: number;
  /** 这一批派了几个临时工（kind='workers' 时有，/health 观测用） */
  workerCount?: number;
}

export interface JobStats {
  live: number;
  byKind: Record<AgentJobKind, number>;
  /** 累计派出过多少个临时工（只增，证明「并行真的发生过」） */
  workersSpawned: number;
  /** 累计委派次数 */
  delegationsStarted: number;
  /** 因超时被熔断的次数（验收取证要的就是这个数） */
  timeouts: number;
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let env: OrchestratorEnv = { ...ORCH_DEFAULTS };

const jobs = new Map<string, AgentJob>();
/** jobId → done 的 resolver（不挂在 job 对象上，免得「运行时加字段」污染接口形状） */
const doneResolvers = new Map<string, () => void>();
/** 一条循环此刻挂在哪个 job 上（一条循环同时只会有一个 park —— pendingCallId 也只有一个） */
const jobByLoop = new Map<string, string>();
/** agentId → delegationId：**正在等**自己委派结果的智能体（用户要求 1：这种智能体不能被拉去处理新委派） */
const waitingAgents = new Map<number, number>();
/** agentId → 正在处理的被委派任务数（用户要求 1 的并发面：一个智能体同时只接 N 件） */
const busyAgents = new Map<number, number>();
/** loopId → 这条循环累计派了多少（临时工 / 委派）。job 删了计数也留着，上限才是「累计」 */
const loopUsage = new Map<string, { workers: number; delegates: number; touchedAt: number }>();

let seq = 0;
let workersSpawned = 0;
let delegationsStarted = 0;
let timeouts = 0;

/** 用哪套上限（`initOrchestrator` 在启动时调一次；测试可以直接传自己的） */
export function initRegistry(next: OrchestratorEnv): void {
  env = { ...next };
}

export function registryEnv(): OrchestratorEnv {
  return env;
}

/** 只给测试用：把内存状态清干净（每个用例之间互不污染） */
export function resetRegistryForTest(): void {
  for (const j of jobs.values()) {
    try {
      j.cancel('test_reset');
    } catch {
      /* 测试清理不该抛 */
    }
  }
  jobs.clear();
  jobByLoop.clear();
  doneResolvers.clear();
  waitingAgents.clear();
  busyAgents.clear();
  loopUsage.clear();
  seq = 0;
  workersSpawned = 0;
  delegationsStarted = 0;
  timeouts = 0;
}

export function liveJobCount(): number {
  sweepJobs();
  return jobs.size;
}

export function jobStats(): JobStats {
  sweepJobs();
  const byKind: Record<AgentJobKind, number> = { workers: 0, delegate: 0 };
  for (const j of jobs.values()) byKind[j.kind] += 1;
  return { live: jobs.size, byKind, workersSpawned, delegationsStarted, timeouts };
}

export function getJob(id: string): AgentJob | null {
  return jobs.get(id) ?? null;
}

/** 「这一路挂在哪个子任务上」—— GET /agent/loop/job 用它（只回状态与时间戳，不含内容） */
export function jobOfLoop(loopId: string): AgentJob | null {
  const id = jobByLoop.get(loopId);
  if (!id) return null;
  return jobs.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// 创建 / 结束
// ---------------------------------------------------------------------------

export interface CreateJobInput {
  kind: AgentJobKind;
  userId: number;
  projectId: number | null;
  ownerLoopId: string;
  ownerAgentId: number | null;
  /** 这个 job 的预算（毫秒）—— 临时工用整批预算，委派用 DELEGATE_TIMEOUT_MS */
  budgetMs: number;
  delegationId?: number;
  workerCount?: number;
  /**
   * 到点（或被人叫停）时**具体要停什么**。
   * 登记表不知道「临时工怎么停 / 子循环怎么停」，那是创建方的事 —— 这里只负责在
   * 正确的时刻、以正确的理由调它一次。
   */
  onCancel: (reason: string) => void;
}

export type CreateJobOutcome = { ok: true; job: AgentJob } | { ok: false; reason: 'too_many_jobs' };

/**
 * 登记一个新 job。全局上限就在这里（`ORCH_MAX_LIVE_JOBS`）。
 *
 * ★ deadline 定时器一定 `unref()`：不能让「等一个 10 分钟的委派」把 Node 进程吊住不退出。
 */
export function createJob(input: CreateJobInput): CreateJobOutcome {
  sweepJobs();
  if (jobs.size >= env.maxLiveJobs) return { ok: false, reason: 'too_many_jobs' };

  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });

  const job: AgentJob = {
    id: nextJobId(),
    kind: input.kind,
    userId: input.userId,
    projectId: input.projectId,
    ownerLoopId: input.ownerLoopId,
    ownerAgentId: input.ownerAgentId,
    startedAt: Date.now(),
    deadlineAt: Date.now() + Math.max(1_000, input.budgetMs),
    status: 'running',
    resultReady: false,
    delegationId: input.delegationId,
    workerCount: input.workerCount,
    cancel: (reason: string) => {
      if (job.status !== 'running') return; // 幂等：只取消一次
      job.status = 'cancelled';
      job.cancelReason = reason;
      if (reason === 'timeout') timeouts += 1;
      try {
        input.onCancel(reason);
      } catch (err) {
        console.error(`[orc] job ${job.id} 取消动作抛错（不影响熔断本身）：`, (err as Error)?.message ?? String(err));
      }
      finish(job);
    },
    done,
  };

  const timer = setTimeout(() => job.cancel('timeout'), Math.max(1_000, input.budgetMs));
  // 别让「等结果」把进程吊住
  if (typeof timer.unref === 'function') timer.unref();

  jobs.set(job.id, job);
  jobByLoop.set(input.ownerLoopId, job.id);
  doneResolvers.set(job.id, resolveDone);
  if (input.kind === 'workers') workersSpawned += input.workerCount ?? 0;
  else delegationsStarted += 1;

  const usage = touchUsage(input.ownerLoopId);
  if (input.kind === 'workers') usage.workers += 1;
  else usage.delegates += 1;

  // done 被 await 之后清掉定时器句柄（对已触发的 timer 调 clearTimeout 无害）
  void done.then(() => clearTimeout(timer));
  return { ok: true, job };
}

function finish(job: AgentJob): void {
  jobs.delete(job.id);
  if (jobByLoop.get(job.ownerLoopId) === job.id) jobByLoop.delete(job.ownerLoopId);
  const resolve = doneResolvers.get(job.id);
  doneResolvers.delete(job.id);
  if (resolve) resolve();
}

/**
 * 结果已经拿到、准备投递给发起方 —— 登记「有结果了」并把 job 从表里摘掉。
 *
 * ★ **只允许一次**：返回 false 表示这个 job 已经结束过了（超时/取消/重复投递），
 *   调用方必须据此**不再**往循环历史里写回执（否则历史里会出现对不上的 tool 消息）。
 */
export function markResultReady(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'running') return false;
  job.resultReady = true;
  job.status = 'done';
  finish(job);
  return true;
}

/** 清扫：已经结束但还留在表里的（正常路径 finish 已经删了，这里是兜底） */
function sweepJobs(): void {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.status !== 'running' || now > j.deadlineAt + 60_000) jobs.delete(id);
  }
  for (const [loopId, u] of loopUsage) {
    if (now - u.touchedAt > 12 * 60 * 60 * 1000) loopUsage.delete(loopId);
  }
}

function nextJobId(): string {
  seq += 1;
  return `job_${Date.now().toString(36)}_${seq.toString(36)}`;
}

function touchUsage(loopId: string): { workers: number; delegates: number; touchedAt: number } {
  const found = loopUsage.get(loopId);
  if (found) {
    found.touchedAt = Date.now();
    return found;
  }
  const created = { workers: 0, delegates: 0, touchedAt: Date.now() };
  loopUsage.set(loopId, created);
  return created;
}

// ---------------------------------------------------------------------------
// 每循环累计上限（费用熔断的一角；R9 记录过服务端此前对调用量毫无上限）
// ---------------------------------------------------------------------------

export function loopWorkerCount(loopId: string): number {
  return loopUsage.get(loopId)?.workers ?? 0;
}

export function loopDelegateCount(loopId: string): number {
  return loopUsage.get(loopId)?.delegates ?? 0;
}

// ---------------------------------------------------------------------------
// 名额闸：用户要求 1「正在等结果的智能体，不能被拉去处理新的委派请求」
// ---------------------------------------------------------------------------

/** 发起方开始等结果（委派发出后立刻登记；投递/超时/失败时释放） */
export function markAgentWaiting(agentId: number, delegationId: number): void {
  if (Number.isInteger(agentId) && agentId > 0) waitingAgents.set(agentId, delegationId);
}

/** 这个智能体是不是正在等自己委派的结果 */
export function isAgentWaiting(agentId: number): boolean {
  return waitingAgents.has(agentId);
}

export function waitingAgentDelegation(agentId: number): number | null {
  return waitingAgents.get(agentId) ?? null;
}

export function clearAgentWaiting(agentId: number, delegationId?: number): void {
  if (!waitingAgents.has(agentId)) return;
  // 传了 delegationId 就只释放**那一次**的（防止迟到的超时把新一次的名额误放掉）
  if (delegationId !== undefined && waitingAgents.get(agentId) !== delegationId) return;
  waitingAgents.delete(agentId);
}

/** 被委派方开始处理（并发面的闸） */
export function markAgentBusy(agentId: number): void {
  if (!Number.isInteger(agentId) || agentId <= 0) return;
  busyAgents.set(agentId, (busyAgents.get(agentId) ?? 0) + 1);
}

export function agentBusyCount(agentId: number): number {
  return busyAgents.get(agentId) ?? 0;
}

export function clearAgentBusy(agentId: number): void {
  const n = busyAgents.get(agentId) ?? 0;
  if (n <= 1) busyAgents.delete(agentId);
  else busyAgents.set(agentId, n - 1);
}

/** 名额表的只读快照（/health 与验收脚本用） */
export function slotSnapshot(): { waiting: number[]; busy: Array<{ agentId: number; count: number }> } {
  return {
    waiting: [...waitingAgents.keys()],
    busy: [...busyAgents.entries()].map(([agentId, count]) => ({ agentId, count })),
  };
}

// ---------------------------------------------------------------------------
// 级联取消：用户按「停」/ 换指令 / 登出时，不能把临时工与子智能体留在后台烧钱
// ---------------------------------------------------------------------------

/**
 * 取消某条循环名下的所有 job（发起方死了，子任务继续跑就是纯烧 token —— R9 的放大版）。
 * 返回被取消的个数。
 */
export function cancelJobsOfLoop(loopId: string, reason: string): number {
  let n = 0;
  for (const job of [...jobs.values()]) {
    if (job.ownerLoopId !== loopId) continue;
    job.cancel(reason);
    n += 1;
  }
  return n;
}

/** 取消某个智能体名下**作为发起方**的所有 job（登出 / 停掉这个 bot 的全部驾驶） */
export function cancelJobsOfAgent(agentId: number, reason: string): number {
  let n = 0;
  for (const job of [...jobs.values()]) {
    if (job.ownerAgentId !== agentId) continue;
    job.cancel(reason);
    n += 1;
  }
  return n;
}
