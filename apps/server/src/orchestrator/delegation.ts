/**
 * 多智能体编排 · **智能体间委派**（阶段 2）。
 *
 * 一次委派完整长这样：
 *
 *   A 调 delegate(to=B, task=…)
 *     ├─ 过闸（§闸门 一节，全是确定性判定，不靠模型自觉）
 *     ├─ 写 agent_delegations + 频道 kind='task'
 *     ├─ 建**分离式**子循环（agentId=B，toolNames=SUB_AGENT_TOOL_NAMES，wcId=null）
 *     ├─ 登记名额：A 进 waitingAgents（用户要求 1）、B 进 busyAgents
 *     ├─ 登记 job（deadline = DELEGATE_TIMEOUT_MS，默认 10 分钟）
 *     ├─ A 的循环 park 成 waiting_job，浏览器交还用户
 *     └─ 后台 runner 驱动子循环：每步写频道 kind='progress'，直到 stop / 超时
 *            完成 → 频道 kind='reply' + 投递结构化结果给 A → A 自动续跑
 *            超时 → stopLoop(子) + 频道 kind='system' + 投递 `delegate_timeout`（**如实说暂未完成**）
 *
 * ★ 三条不能破的规矩（改这里前先读）：
 *   1. **不在 `advance()` 里 await 子循环** —— 委派最长 10 分钟，而 `/next` 只有 90 秒硬超时，
 *      await 就是必挂（R6：传输出错即永久杀循环）。所以一律「派出即返回 + park + 结果回来续跑」。
 *   2. **超时不假装完成** —— 到点如实回「暂未完成」，并把 B 的名额释放掉（它能接下一件）。
 *   3. **子循环没有浏览器手** —— 工具表里就没有那 5 个浏览器工具；wcId 恒为 null，
 *      所以它也不会写任何页的分片状态（`syncPageState` 遇到非整数 wcId 直接 return）。
 */
import type { LoopToolResult, ToolDefinition } from '@ai-workbench/shared';
import { deliverJobResult, startLoop, type LoopSession } from '../toolLoop';
import { advance } from '../toolLoop';
import { SUB_AGENT_TOOL_NAMES, registerServerTool, type ServerExecutionContext } from '../toolRegistry';
import { detectSensitive, sensitiveLabel } from './redact';
import {
  agentBusyCount,
  cancelJobsOfLoop,
  clearAgentBusy,
  clearAgentWaiting,
  createJob,
  isAgentWaiting,
  liveJobCount,
  loopDelegateCount,
  markAgentBusy,
  markAgentWaiting,
  markResultReady,
} from './registry';
import { registerSubLoop, resolveLoop as subLoopLookup, unregisterSubLoop } from './subLoops';
import {
  addChannelMessage,
  ensureChannel,
  finishDelegation,
  insertDelegation,
  setDelegationChildLoop,
} from './channels';
import { findAgentByNameAnyProject, loadProjectRoster, projectOfAgent, resolveDelegateTarget } from './roster';
import { orchestrationBlock, subAgentSystemPrompt } from './prompts';
import { orchestratorDeps } from './tools';
import { writeCollabBoth, writeCollabToAgentChat } from './collabChat';

const TASK_MAX = 600;
const CONTEXT_MAX = 2000;

/** 被拒原因 → 人话（同时进频道 kind='system'，用户在内部频道能看见「谁被拒了、为什么」） */
const REJECT_TEXT: Record<string, string> = {
  orchestration_off: '编排能力已关闭，没有把这件事交出去。',
  no_identity: '我这一路没有绑定智能体身份，没法以某个智能体的名义委派。',
  agent_not_found: '找不到那个智能体（名字对不上，或它不在这个项目里）。',
  cross_project: '只能委派**同一个项目**里的智能体，跨项目的一律不交。',
  delegate_self: '不能把事委派给自己。',
  agent_busy_waiting: '对方正在等自己委派出去的结果 —— 这时候拉它接新活就是死循环，已当场拒绝。',
  agent_busy: '对方手上已经有在处理的委派了（同时只接一件），这次没交出去。',
  too_deep: '委派链太深了（最多转两层），再往下就是踢皮球。',
  cycle: '这条委派链会绕回已经在链上的智能体，已拒绝（防环）。',
  too_many: '这一路已经委派太多次了，不再交出去。',
  too_many_jobs: '后台子任务已满（全局上限），这次没交出去。',
  sensitive_content: '任务里含敏感信息，没有交出去。',
};

export const DELEGATE_TOOL: ToolDefinition = {
  name: 'delegate',
  description: [
    '把一件事**交给同项目里的另一个智能体**去做，它做完会把结论交回来。',
    '【适合】这件事更合适别的同事（看下面的名单与各自职责），或者你自己手上的活已经排满了。',
    '【不适合】需要打开网页 / 点击 / 填表 / 登录的事 —— 被委派的一方**也没有浏览器手**，',
    '  这类事要么你自己用浏览器做，要么 stop(reason=need_user) 交给用户。',
    '【怎么写】to 写对方名字（照名单抄，别自己编）；task 写清「要它做成什么、要它回什么」；',
    '  它看不到你和用户的对话，所以必要的背景要用 context 一起给。',
    '【规矩】最长等 10 分钟；对方正忙 / 正在等自己的结果 / 不是你项目的 / 就是你自己 —— 会**当场被拒**并说明原因；',
    '  到点没做完会如实告诉你「暂未完成」。被拒或超时**不要反复重试**，自己接着做或交给用户。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: '目标智能体的名字（照同事名单抄）或它的 id' },
      task: { type: 'string', description: '要对方做成什么、要回什么（≤600 字）' },
      context: { type: 'string', description: '可选：对方需要知道的背景资料（≤2000 字）' },
      expect: { type: 'string', description: '可选：你希望对方回什么结构（例如「三个要点 + 来源」）' },
    },
    required: ['to', 'task'],
  },
  side: 'server',
  kind: 'action',
  /** 立刻返回（真正干活的是后台子循环），0 明示不阻塞 */
  timeoutMs: 0,
  validate: (args) => {
    const to = typeof args.to === 'string' ? args.to.trim().slice(0, 80) : String(args.to ?? '').trim().slice(0, 80);
    const task = typeof args.task === 'string' ? args.task.trim().slice(0, TASK_MAX) : '';
    if (!to) return { ok: false, reason: 'bad_args', question: '没写要交给谁。照同事名单给一个名字。' };
    if (!task) return { ok: false, reason: 'bad_args', question: '没写要它做什么。给一句具体的任务。' };
    const context = typeof args.context === 'string' ? args.context.trim().slice(0, CONTEXT_MAX) : '';
    const expect = typeof args.expect === 'string' ? args.expect.trim().slice(0, 300) : '';
    /**
     * 敏感闸：委派文本里带密码/验证码/卡号就**当场拒**。
     * 不是「替换后照发」—— 那会让发起方以为对方收到的是完整任务。
     */
    const hit = detectSensitive(`${task}\n${context}`);
    if (hit) {
      return {
        ok: false,
        reason: 'sensitive_content',
        question: `这件事里含${sensitiveLabel(hit)}，我没有交出去。这类内容不能委派给别的智能体去查，请换个不含敏感信息的写法。`,
      };
    }
    return { ok: true, args: { to, task, ...(context ? { context } : {}), ...(expect ? { expect } : {}) } };
  },
};

/** 委派被拒：当场回执（不 park）+ 频道留痕 + 对话流留痕（无感核心：协同进对话流） */
async function reject(
  ctx: ServerExecutionContext,
  reason: keyof typeof REJECT_TEXT | string,
  target: { id: number; name: string } | null,
): Promise<LoopToolResult> {
  const text = REJECT_TEXT[reason] ?? `这次委派被拒了（${reason}）。`;
  await writeSystem(ctx, target, reason, text).catch(() => undefined);
  // 无感核心：被拒也要进对话流，折叠成一行摘要（前端后续渲染成折叠卡）
  try {
    const { pool, cipher } = orchestratorDeps();
    const fromId = ctx.agentId;
    if (fromId && target && target.id) {
      const fromName = `#${fromId}`;
      await writeCollabToAgentChat(pool, cipher, fromId, {
        kind: 'system',
        fromId,
        fromName,
        toId: target.id,
        toName: target.name,
        status: 'rejected',
        detail: text,
      });
    }
  } catch {}
  return {
    ok: false,
    error: reason,
    detail: `${text}${target ? `（目标：「${target.name}」）` : ''}`,
    data: { status: 'rejected', reason },
  };
}

/** 频道 system 留痕（尽力而为：写不进去也不能挡住拒绝本身） */
async function writeSystem(
  ctx: ServerExecutionContext,
  target: { id: number; name: string } | null,
  reason: string,
  text: string,
  delegationId?: number,
): Promise<void> {
  const { pool, cipher } = orchestratorDeps();
  const fromId = ctx.agentId;
  if (fromId === null || !target) return;
  const projectId = await projectOfAgent(pool, ctx.userId, fromId);
  if (projectId === null) return;
  const channelId = await ensureChannel(pool, { userId: ctx.userId, projectId, agentA: fromId, agentB: target.id });
  await addChannelMessage(pool, cipher, {
    channelId,
    fromAgentId: fromId,
    toAgentId: target.id,
    kind: 'system',
    text,
    payload: { reason, ...(delegationId ? { delegationId } : {}) },
    delegationId,
  });
}

export async function executeDelegate(
  args: Record<string, unknown>,
  ctx: ServerExecutionContext,
): Promise<LoopToolResult> {
  const { pool, cipher, env } = orchestratorDeps();
  const orch = env.orch;
  const to = String(args.to ?? '');
  const task = String(args.task ?? '');
  const context = String(args.context ?? '');
  const expect = String(args.expect ?? '');

  // ---------------------------------------------------------------- 闸门（确定性）
  if (!orch.enabled) return reject(ctx, 'orchestration_off', null);
  const fromId = ctx.agentId;
  if (fromId === null || !Number.isInteger(fromId) || fromId <= 0) return reject(ctx, 'no_identity', null);

  const projectId = await projectOfAgent(pool, ctx.userId, fromId);
  if (projectId === null) return reject(ctx, 'no_identity', null);

  const target = await resolveDelegateTarget(pool, ctx.userId, projectId, to);
  if (!target) {
    // 名字对不上时也去**全账号**看一眼，好把「跨项目」和「查无此人」区分开（话术更有用）
    const anywhere = await findAgentByNameAnyProject(pool, ctx.userId, to).catch(() => null);
    return reject(ctx, anywhere ? 'cross_project' : 'agent_not_found', { id: 0, name: to });
  }
  if (target.projectId !== projectId) return reject(ctx, 'cross_project', target);
  if (target.id === fromId) return reject(ctx, 'delegate_self', target);
  /**
   * ★ 用户要求 1（防死循环）：**正在等自己委派结果的智能体，不能被拉去处理新的委派。**
   *   A 在等 B，B 又来委派 A —— 两边都在等对方，谁也不会动。所以这里直接拒。
   */
  if (isAgentWaiting(target.id)) return reject(ctx, 'agent_busy_waiting', target);
  if (agentBusyCount(target.id) >= orch.delegateMaxActivePerAgent) return reject(ctx, 'agent_busy', target);

  const chain = Array.isArray(ctx.chain) ? ctx.chain.filter((n) => Number.isInteger(n)) : fromId ? [fromId] : [];
  if (chain.includes(target.id)) return reject(ctx, 'cycle', target);
  const nextChain = [...chain, target.id];
  if (nextChain.length - 1 > orch.delegateMaxDepth) return reject(ctx, 'too_deep', target);

  if (loopDelegateCount(ctx.loopId) >= orch.delegateMaxPerLoop) return reject(ctx, 'too_many', target);
  if (liveJobCount() >= orch.maxLiveJobs) return reject(ctx, 'too_many_jobs', target);

  // ---------------------------------------------------------------- 落地
  const channelId = await ensureChannel(pool, { userId: ctx.userId, projectId, agentA: fromId, agentB: target.id });
  const fromName = (await loadProjectRoster(pool, ctx.userId, projectId, null)).find((r) => r.id === fromId)?.name ?? `#${fromId}`;
  const deadlineAt = new Date(Date.now() + orch.delegateTimeoutMs);

  const delegationId = await insertDelegation(pool, {
    userId: ctx.userId,
    projectId,
    channelId,
    fromAgentId: fromId,
    toAgentId: target.id,
    parentLoopId: ctx.loopId,
    task,
    status: 'running',
    deadlineAt,
  });
  await addChannelMessage(pool, cipher, {
    channelId,
    fromAgentId: fromId,
    toAgentId: target.id,
    kind: 'task',
    text: task + (context ? `\n\n【背景资料】\n${context}` : '') + (expect ? `\n\n【希望你回】\n${expect}` : ''),
    payload: { status: 'running', delegationId },
    delegationId,
  });
  // 无感核心：协同进对话流（派单方和接单方各一条，折叠摘要）
  void writeCollabBoth(pool, cipher, {
    kind: 'dispatch',
    fromId,
    fromName,
    toId: target.id,
    toName: target.name,
    task,
    delegationId,
  }).catch(() => undefined);

  // 子循环：**分离式**（不进主 loops Map）、没有页、工具表里没有浏览器工具
  const roster = await loadProjectRoster(pool, ctx.userId, projectId, target.id);
  const targetPersona = await loadAgentPersona(pool, target.id);
  // 记忆合并第一批：子循环也带记忆块（账号级+被委派智能体级）
  let delegateMemoryBlock: string | undefined;
  try {
    const { buildMemoryBlock } = await import('../routes/memories');
    delegateMemoryBlock = await buildMemoryBlock(pool, cipher, ctx.userId, task.slice(0, 500), target.id);
  } catch {}
  const sub = startLoop(env, {
    userId: ctx.userId,
    agentId: target.id,
    conversationId: null,
    wcId: null,
    goal: task.slice(0, 500),
    state: null,
    toolNames: [...SUB_AGENT_TOOL_NAMES],
    kind: 'delegate',
    parentLoopId: ctx.loopId,
    chain: nextChain,
    detached: true,
    systemPrompt: subAgentSystemPrompt({ selfName: target.name, persona: targetPersona, fromName }),
    orchestrationBlock: orchestrationBlock(target.id, roster),
    memoryBlock: delegateMemoryBlock,
  });
  registerSubLoop(sub);
  await setDelegationChildLoop(pool, delegationId, sub.id);

  // 名额：发起方进「在等」（用户要求 1 的闸），被委派方进「在忙」
  markAgentWaiting(fromId, delegationId);
  markAgentBusy(target.id);

  const aborted = { aborted: false };
  let settled = false;
  let jobId = '';
  const deliver = (result: LoopToolResult): void => {
    if (settled) return;
    settled = true;
    // 名额一定释放：不释放的话 A 永远「在等」、B 永远「在忙」，整个项目就废了
    clearAgentWaiting(fromId, delegationId);
    clearAgentBusy(target.id);
    unregisterSubLoop(sub.id);
    const owner = resolveOwnerLoop(ctx.loopId);
    if (!owner) {
      console.log(`[orc] 委派 ${delegationId} 有结果但发起方循环已不在（结果仍在内部频道里，不伪造回执）`);
      return;
    }
    deliverJobResult(owner, jobId, result);
  };

  const created = createJob({
    kind: 'delegate',
    userId: ctx.userId,
    projectId,
    ownerLoopId: ctx.loopId,
    ownerAgentId: fromId,
    budgetMs: orch.delegateTimeoutMs,
    delegationId,
    onCancel: (reason) => {
      aborted.aborted = true;
      // 子循环也要停：不停它就会在后台继续烧模型调用。
      // 走 `stopLoop` 是不行的（分离式子循环不在主 loops Map 里，那个函数会直接返回 false），
      // 所以这里直接落状态 + 掐掉在飞的那次 LLM 请求。
      sub.status = 'stopped';
      sub.touchedAt = Date.now();
      sub.abortCtl?.abort();
      sub.abortCtl = null;
      cancelJobsOfLoop(sub.id, `delegate_${reason}`);
      if (reason !== 'timeout') {
        // 发起方被停/登出：留痕但不投递（那边已经没人听了）
        void finishDelegation(pool, delegationId, { status: 'failed', error: reason });
        void addChannelMessage(pool, cipher, {
          channelId,
          fromAgentId: fromId,
          toAgentId: target.id,
          kind: 'system',
          text: `这次委派被取消了（${reason}）。`,
          payload: { reason, delegationId, status: 'failed' },
          delegationId,
        }).catch(() => undefined);
        void writeCollabBoth(pool, cipher, {
          kind: 'system',
          fromId,
          fromName,
          toId: target.id,
          toName: target.name,
          status: 'failed',
          detail: `委派被取消：${reason}`,
          delegationId,
        }).catch(() => undefined);
        return;
      }
      /**
       * ★ 用户要求 2（超时熔断）：**如实告知「暂未完成」**，不假装完成、不留它挂着。
       * 无感核心：超时也要进对话流
       */
      const mins = Math.round(orch.delegateTimeoutMs / 60_000);
      void finishDelegation(pool, delegationId, { status: 'timeout', error: `超过 ${mins} 分钟未完成` });
      void addChannelMessage(pool, cipher, {
        channelId,
        fromAgentId: target.id,
        toAgentId: fromId,
        kind: 'system',
        text: `超过 ${mins} 分钟没有做完，这次委派按超时熔断处理（已完成的部分留在上面的过程记录里）。`,
        payload: { reason: 'timeout', delegationId, status: 'timeout' },
        delegationId,
      }).catch(() => undefined);
      void writeCollabBoth(pool, cipher, {
        kind: 'system',
        fromId,
        fromName,
        toId: target.id,
        toName: target.name,
        status: 'timeout',
        detail: `超过 ${mins} 分钟未完成，按超时熔断`,
        delegationId,
      }).catch(() => undefined);
      deliver({
        ok: false,
        error: 'delegate_timeout',
        detail: `「${target.name}」暂未完成（已等 ${mins} 分钟，按超时熔断处理）。它做到哪一步在内部频道里能看到；这件事你可以自己接着做，或交给用户。`,
        data: { delegationId, status: 'timeout', waitedMs: orch.delegateTimeoutMs },
      });
    },
  });
  if (!created.ok) {
    clearAgentWaiting(fromId, delegationId);
    clearAgentBusy(target.id);
    unregisterSubLoop(sub.id);
    void finishDelegation(pool, delegationId, { status: 'rejected', error: created.reason });
    return reject(ctx, 'too_many_jobs', target);
  }
  jobId = created.job.id;

  console.log(
    `[orc] 委派 ${delegationId}：「${fromName}」→「${target.name}」（子循环 ${sub.id}，` +
      `链深 ${nextChain.length - 1}/${orch.delegateMaxDepth}，超时 ${Math.round(orch.delegateTimeoutMs / 1000)}s）`,
  );

  // 后台跑：**不 await**
  void runDelegatedTask({
    sub,
    jobId: created.job.id,
    delegationId,
    channelId,
    fromId,
    fromName,
    target,
    task,
    signal: aborted,
    deliver,
  }).catch((err) => {
    console.error(`[orc] 委派 ${delegationId} 的 runner 抛错：`, (err as Error)?.message ?? String(err));
    if (!markResultReady(created.job.id)) return;
    deliver({
      ok: false,
      error: 'delegate_failed',
      detail: `「${target.name}」这一路出错了：${(err as Error)?.message ?? String(err)}`.slice(0, 400),
      data: { delegationId, status: 'failed' },
    });
  });

  const etaMs = orch.delegateTimeoutMs;
  return {
    ok: true,
    detail: `已交给「${target.name}」，最多 ${Math.round(etaMs / 60_000)} 分钟给你结果`,
    data: { delegationId, channelId, to: target.name, status: 'running' },
    park: {
      jobId: created.job.id,
      kind: 'delegate',
      etaMs,
      note: `我已经把这件事交给「${target.name}」了，最多等 ${Math.round(etaMs / 60_000)} 分钟。` +
        '这一步我先停下来等它，结果一回来就自动接着做。协同过程已写入对话流，折叠展示。',
    },
  };
}

/** 发起方循环可能是浏览器循环（在主 Map 里）也可能是子循环（链深 2）——两边都要能找到 */
function resolveOwnerLoop(loopId: string): LoopSession | null {
  return subLoopLookup(loopId);
}

interface RunnerInput {
  sub: LoopSession;
  jobId: string;
  delegationId: number;
  channelId: number;
  fromId: number;
  fromName: string;
  target: { id: number; name: string };
  task: string;
  signal: { aborted: boolean };
  deliver: (r: LoopToolResult) => void;
}

/** 同一条子循环里，连续的「参数被拒」最多容忍几次（防模型反复给脏参数空转） */
const MAX_CONSECUTIVE_REJECTS = 3;
/** 一条子循环最多推进多少格（硬兜底，防任何形式的自旋） */
const SUB_LOOP_MAX_ADVANCES = 40;

/**
 * 驱动被委派的子循环，直到它自己收尾 / 卡住 / 超时。
 *
 * ★ 这个函数**只在后台跑**，绝不能被 `/next` 那条路 await（见文件头规矩 1）。
 */
async function runDelegatedTask(input: RunnerInput): Promise<void> {
  const { pool, cipher, env } = orchestratorDeps();
  const { sub, delegationId, channelId, fromId, target } = input;
  let seenTools = 0;
  let rejects = 0;

  for (let i = 0; i < SUB_LOOP_MAX_ADVANCES; i += 1) {
    if (input.signal.aborted) return; // 已被超时/取消接管，结果已经投递过了
    if (sub.status === 'stopped' || sub.status === 'done' || sub.status === 'failed') break;

    let decision;
    try {
      decision = await advance(env, sub);
    } catch (err) {
      if (input.signal.aborted) return; // 熔断/取消已经把结论写完了，这里别再写一遍
      await progress(`推进失败：${(err as Error)?.message ?? String(err)}`);
      break;
    }
    /**
     * ★ 熔断之后**立刻退出**，不再写任何东西。
     *
     * 这一格必须查：超时熔断会 abort 在飞的请求，`advance` 于是以 `llm_error`
     * 的形式**正常返回**（不是抛错）。不查的话 runner 会顺着「模型说卡住了」那条分支
     * 把已经写成 `timeout` 的记录覆盖成 `need_user` —— 频道说超时、接口说等用户，
     * 两个口径对不上。（`finishDelegation` 那层也有仲裁，这里是不给它机会发生。）
     */
    if (input.signal.aborted) return;
    await progressFromTools();

    if (decision.kind === 'done') {
      const summary = String(decision.summary ?? '').trim() || '（对方说做完了，但没给结论）';
      await finishDelegation(pool, delegationId, {
        status: 'done',
        result: { summary, outline: decision.document_outline ?? [] },
      });
      await reply(summary, decision.document_outline ?? []);
      if (!markResultReady(input.jobId)) return;
      input.deliver({
        ok: true,
        detail: `「${target.name}」把结果交回来了：${summary.slice(0, 200)}`,
        data: { delegationId, status: 'done', summary, outline: decision.document_outline ?? [], steps: sub.step },
      });
      return;
    }

    if (decision.kind === 'ask') {
      /**
       * 子循环自己也派了临时工/又委派了一层 → 它挂在 `waiting_job` 上。
       * 这里 **await 它那个 job 的 done**（同进程 Promise，不是 HTTP），醒来继续推进。
       * 整条链仍然受**本委派的 10 分钟 deadline** 约束（超时熔断会连它一起掐）。
       */
      if (decision.reason === 'job_pending') {
        await progress('它自己又派了活出去，正在等结果');
        await waitForNestedJob(sub);
        continue;
      }
      // 参数被拒这类：回执已经进历史了，模型有机会自己改对 —— 给有限的几次机会
      const retryable =
        decision.reason === 'bad_args' ||
        decision.reason === 'bad_action' ||
        decision.reason === 'blocked_sensitive' ||
        decision.reason === 'no_executor';
      if (retryable && rejects < MAX_CONSECUTIVE_REJECTS) {
        rejects += 1;
        continue;
      }
      const question = String(decision.question ?? '').trim() || '它说卡住了，但没说卡在哪。';
      await finishDelegation(pool, delegationId, { status: 'need_user', error: question.slice(0, 300) });
      await reply(`我这边卡住了：${question}`, []);
      if (!markResultReady(input.jobId)) return;
      input.deliver({
        ok: false,
        error: 'delegate_need_user',
        detail: `「${target.name}」说它卡住了：${question.slice(0, 200)}`,
        data: { delegationId, status: 'need_user', question: question.slice(0, 300) },
      });
      return;
    }

    if (decision.kind === 'say') {
      // 只说话没调工具：当成一次「交活」（它把结论写在话里了）
      const text = String(decision.text ?? '').trim();
      await finishDelegation(pool, delegationId, { status: 'done', result: { summary: text.slice(0, 500) } });
      await reply(text.slice(0, 500), []);
      if (!markResultReady(input.jobId)) return;
      input.deliver({
        ok: true,
        detail: `「${target.name}」回话了：${text.slice(0, 200)}`,
        data: { delegationId, status: 'done', summary: text.slice(0, 500), steps: sub.step },
      });
      return;
    }

    if (decision.kind === 'stopped' || decision.kind === 'paused') break;
    // decision.kind === 'tool' 不该出现（子循环工具表里没有 desktop 工具）—— 出现就当收尾
    break;
  }

  if (input.signal.aborted) return;
  // 走到这里 = 没收尾就退出了（被停 / 撞上兜底上限）
  await finishDelegation(pool, delegationId, { status: 'failed', error: '子循环未收尾即退出' });
  await reply('我没能把这件事做完就停下了（没有给出结论）。', []);
  if (!markResultReady(input.jobId)) return;
  input.deliver({
    ok: false,
    error: 'delegate_incomplete',
    detail: `「${target.name}」没能把这件事做完就停下了（走了 ${sub.step} 步，没有给出结论）。`,
    data: { delegationId, status: 'failed', steps: sub.step },
  });

  // ------------------------------------------------------------ 局部小工具（无感核心：协同进对话流，频道仍保留）
  async function progress(text: string): Promise<void> {
    await addChannelMessage(pool, cipher, {
      channelId,
      fromAgentId: target.id,
      toAgentId: fromId,
      kind: 'progress',
      text,
      payload: { delegationId, steps: sub.step },
      delegationId,
    }).catch(() => undefined);
    // 进度也进对话流（折叠摘要，细节前端可展开）
    void writeCollabToAgentChat(pool, cipher, fromId, {
      kind: 'progress',
      fromId: target.id,
      fromName: target.name,
      toId: fromId,
      toName: input.fromName,
      detail: text,
      delegationId,
    }).catch(() => undefined);
  }

  async function reply(text: string, outline: string[]): Promise<void> {
    await addChannelMessage(pool, cipher, {
      channelId,
      fromAgentId: target.id,
      toAgentId: fromId,
      kind: 'reply',
      text,
      payload: { delegationId, status: 'done', steps: sub.step, findings: outline.slice(0, 12) },
      delegationId,
    }).catch(() => undefined);
    // 交回也进对话流
    void writeCollabBoth(pool, cipher, {
      kind: 'reply',
      fromId: fromId,
      fromName: input.fromName,
      toId: target.id,
      toName: target.name,
      summary: text,
      status: 'done',
      delegationId,
    }).catch(() => undefined);
  }

  /** 把子循环这一步新用掉的工具写成频道过程注记（用户「查看交流过程」看的就是这些） */
  async function progressFromTools(): Promise<void> {
    const used = sub.usedTools ?? [];
    if (used.length <= seenTools) return;
    const fresh = used.slice(seenTools);
    seenTools = used.length;
    const label = fresh
      .map((t) => (t === 'web_search' ? '查了公开资料' : t === 'spawn_workers' ? '派了临时工' : t === 'delegate' ? '又转交给别人' : String(t)))
      .join('、');
    await progress(`第 ${sub.step} 步：${label}`);
  }
}

/** 子循环自己 park 了 → 等它那个 job 结束（同进程 Promise，不走 HTTP） */
async function waitForNestedJob(sub: LoopSession): Promise<void> {
  const { jobOfLoop } = await import('./registry');
  const job = jobOfLoop(sub.id);
  if (!job) return;
  await job.done;
}

/** 取被委派方的人设（拼系统提示词用） */
async function loadAgentPersona(
  pool: import('pg').Pool,
  agentId: number,
): Promise<{ name: string; who: string; tone: string; duty: string } | null> {
  const r = await pool.query<{ persona: unknown }>('SELECT persona FROM agents WHERE id = $1 LIMIT 1', [agentId]);
  const p = r.rows[0]?.persona as { name?: string; who?: string; tone?: string; duty?: string } | null;
  if (!p || typeof p !== 'object') return null;
  return {
    name: String(p.name ?? ''),
    who: String(p.who ?? ''),
    tone: String(p.tone ?? ''),
    duty: String(p.duty ?? ''),
  };
}

export function registerDelegationTool(): void {
  registerServerTool(DELEGATE_TOOL, { execute: executeDelegate });
}
