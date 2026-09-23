/**
 * 多智能体编排 · **三个服务端工具**的定义 + 执行器 + 装配。
 *
 *   · `spawn_workers` —— 临时工并行（阶段 1）
 *   · `delegate`      —— 智能体间委派（阶段 2，见 delegation.ts）
 *   · `web_search`    —— 联网检索（见 search.ts）
 *
 * ★ 这是本项目**第一次**有 `side='server'` 的工具上线。阶段 0 只注册化了 5 个浏览器工具 + stop（共 6 个），
 *   `advanceInner` 里的「服务端直执行 → continue 再问一轮」分支此前只被对照测试覆盖。
 *   所以本文件是那条分支的第一个真实调用方 —— 改它之前先读 `toolLoop.ts` 的 park 分支注释。
 *
 * ★ 长耗时工具的返回形状（三处必须一致，改一处要改三处）：
 *   `{ ok:true, detail:'人话', data:{结构化}, park:{ jobId, kind, etaMs, note } }`
 *   `park` 一出现，循环就转 `waiting_job` 并**不写回执**；结果回来由 `deliverJobResult`
 *   用同一个 `pendingCallId` 补上那一条 tool 消息（历史里 tool_calls 与回执严格一一对应）。
 */
import type { LoopToolResult, ToolDefinition, WorkerBatchResult, WorkerTaskSpec } from '@ai-workbench/shared';
import type { Pool } from 'pg';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { deliverJobResult, onLoopStopped } from '../toolLoop';
import { registerServerTool, type ServerExecutionContext } from '../toolRegistry';
import { detectSensitive, sensitiveLabel } from './redact';
import {
  cancelJobsOfLoop,
  createJob,
  initRegistry,
  liveJobCount,
  loopWorkerCount,
  markResultReady,
} from './registry';
import { resolveLoop } from './subLoops';
import { WEB_SEARCH_SERVER_TOOL, executeWebSearchTool } from './search';
import { runWorkerPool } from './workers';
import { registerDelegationTool } from './delegation';
import { registerSkillTools } from './skillTools';

export interface OrchestratorDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

let deps: OrchestratorDeps | null = null;
let installed = false;

export function orchestratorDeps(): OrchestratorDeps {
  if (!deps) throw new Error('[orc] 编排器还没初始化（initOrchestrator 要在启动时调一次）');
  return deps;
}

export function isOrchestratorInstalled(): boolean {
  return installed;
}

// ---------------------------------------------------------------------------
// spawn_workers
// ---------------------------------------------------------------------------

/** 任务书上各字段的硬上限（模型给多长都截到这里） */
const TITLE_MAX = 60;
const INSTRUCTION_MAX = 600;
const CONTEXT_MAX = 2000;

export const SPAWN_WORKERS_TOOL: ToolDefinition = {
  name: 'spawn_workers',
  description: [
    '派出若干**临时工并行**处理互不依赖的子任务，他们做完会以结构化汇报交回来。',
    '【适合】同一件事能拆成几块**互不依赖**的活：例如「三家竞品各查一遍」「五个关键词各搜一轮」',
    '  「把这份清单里的每一项各核实一次」。派出去之后你这一格会挂起，结果回来自动接着做。',
    '【不适合】有先后依赖的活（后一步要用前一步的结果）—— 那要你自己一步一步做。',
    '【临时工是什么】没有名字、没有身份、没有记忆、**没有浏览器**：只能查公开资料 + 推理。',
    '  所以要打开网页 / 登录 / 点击 / 填表 / 下单的事**不要**派给他们 —— 那要么你自己用浏览器做，',
    '  要么 stop(reason=need_user) 交给用户。',
    '【怎么写任务书】因为他们看不到你们的对话，每个任务都要**自带足够上下文**：',
    '  title 写这件事叫什么，instruction 写清「要做什么、要回什么」，必要时用 context 把你手上的资料贴进去。',
    '【上限】一次最多派 5 个；同一条任务累计有上限；整批有预算，到点没回来的会如实报 timeout。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description:
          '要并行处理的子任务列表（1~5 个）。每项：{"title":"这件事叫什么(≤60字)",' +
          '"instruction":"具体要做什么、要回什么(≤600字)","context":"可选：你已有的资料(≤2000字)"}',
        items: { type: 'object' },
      },
      allow_search: {
        type: 'boolean',
        description: '允许临时工联网搜索（默认 true）。未配置搜索通道时会自动降级为纯推理，不会报错。',
      },
    },
    required: ['tasks'],
  },
  side: 'server',
  kind: 'action',
  /**
   * 这个工具**立刻返回**（真正干活的是后台 job），所以 timeout 填 0 明示 ——
   * 填 20000 会误导后人以为它会阻塞 20 秒。
   */
  timeoutMs: 0,
  validate: (args) => {
    const rawTasks = Array.isArray(args.tasks) ? (args.tasks as unknown[]) : [];
    if (rawTasks.length === 0) {
      return { ok: false, reason: 'bad_args', question: '要派的活一个都没写。给我 1~5 个具体子任务。' };
    }
    const limit = deps?.env.orch.workerMaxPerCall ?? 5;
    if (rawTasks.length > limit) {
      return {
        ok: false,
        reason: 'too_many_workers',
        question: `一次最多派 ${limit} 个临时工（这次给了 ${rawTasks.length} 个）。挑最关键的几件，或者分几次派。`,
      };
    }
    const tasks: WorkerTaskSpec[] = [];
    for (let i = 0; i < rawTasks.length; i += 1) {
      const item = (rawTasks[i] ?? {}) as Record<string, unknown>;
      const title = typeof item.title === 'string' ? item.title.trim().slice(0, TITLE_MAX) : '';
      const instruction = typeof item.instruction === 'string' ? item.instruction.trim().slice(0, INSTRUCTION_MAX) : '';
      if (!title || !instruction) {
        return {
          ok: false,
          reason: 'bad_args',
          question: `第 ${i + 1} 个任务缺 title 或 instruction。每件事都要写清「叫什么」和「要做什么」。`,
        };
      }
      /**
       * 敏感闸：任务书里带密码/验证码/卡号就**当场拒**（不是悄悄替换后照发 ——
       * 那会让模型以为临时工收到的是完整任务）。
       */
      const hit = detectSensitive(`${title}\n${instruction}\n${String(item.context ?? '')}`);
      if (hit) {
        return {
          ok: false,
          reason: 'sensitive_content',
          question: `第 ${i + 1} 个任务里含${sensitiveLabel(hit)}，我没有派出去。这类内容不能交给临时工去查，请换个不含敏感信息的写法。`,
        };
      }
      const context = typeof item.context === 'string' ? item.context.trim().slice(0, CONTEXT_MAX) : undefined;
      tasks.push({ title, instruction, ...(context ? { context } : {}) });
    }
    return { ok: true, args: { tasks, allow_search: args.allow_search !== false } };
  },
};

/**
 * spawn_workers 的执行器：**登记 job → 立刻返回 park**，真正的活在后台跑。
 *
 * ★ 这里绝不能 `await runWorkerPool(...)`：一次批处理最长 180 秒，而调用它的
 *   `/agent/loop/next` 桌面侧只有 90 秒硬超时 —— await 就是必挂（R6：传输出错即永久杀循环）。
 */
async function executeSpawnWorkers(
  args: Record<string, unknown>,
  ctx: ServerExecutionContext,
): Promise<LoopToolResult> {
  const { env } = orchestratorDeps();
  const orch = env.orch;
  const tasks = (args.tasks as WorkerTaskSpec[]) ?? [];

  if (!orch.enabled) {
    return { ok: false, error: 'orchestration_off', detail: '编排能力已关闭（ORCHESTRATION_TOOLS=0），没有派临时工。' };
  }

  // 每循环累计上限（job 早就销毁了，计数仍在 —— 上限是「累计」不是「并发」）
  if (loopWorkerCount(ctx.loopId) >= orch.workerMaxPerLoop) {
    return {
      ok: false,
      error: 'worker_budget',
      detail: `这一路已经派过 ${orch.workerMaxPerLoop} 批临时工了（累计上限），不再派。剩下的事请你自己做，或 stop 交给用户。`,
    };
  }
  if (liveJobCount() >= orch.maxLiveJobs) {
    return {
      ok: false,
      error: 'too_many_jobs',
      detail: `现在后台已经有 ${orch.maxLiveJobs} 个子任务在跑（全局上限），这次不派。等它们回来再说。`,
    };
  }

  const aborted = { aborted: false };
  /**
   * 投递是**幂等**的：超时熔断路径（onCancel）与正常完成路径会赛跑，
   * 只允许其中一个真的往循环历史里写回执 —— 写两次就会出现对不上的 tool 消息。
   */
  let settled = false;
  let jobId = '';
  const deliver = (result: LoopToolResult): void => {
    if (settled) return;
    settled = true;
    const owner = resolveLoop(ctx.loopId);
    if (!owner) {
      console.log(`[orc] job ${jobId} 有结果但发起方循环已不在（只落库，**不伪造回执**）`);
      return;
    }
    deliverJobResult(owner, jobId, result);
  };

  const created = createJob({
    kind: 'workers',
    userId: ctx.userId,
    projectId: null,
    ownerLoopId: ctx.loopId,
    ownerAgentId: ctx.agentId,
    budgetMs: orch.workerJobBudgetMs,
    workerCount: tasks.length,
    onCancel: (reason) => {
      // 掐掉在飞的模型调用（否则「超时了还在烧钱」）
      aborted.aborted = true;
      if (reason !== 'timeout') return;
      // 整批预算用完：**如实**告诉发起方，不留它挂着
      deliver({
        ok: false,
        error: 'orchestrator_timeout',
        detail: `这批临时工整体超时（${Math.round(orch.workerJobBudgetMs / 1000)} 秒预算用完），没有全部回来。剩下的请自己补，或 stop 交给用户。`,
        data: { jobId, status: 'timeout', tookMs: orch.workerJobBudgetMs },
      });
    },
  });
  if (!created.ok) {
    return { ok: false, error: created.reason, detail: '后台子任务已满（全局上限），这次不派。' };
  }
  const job = created.job;
  jobId = job.id;

  console.log(
    `[orc] job=${job.id} 派出 ${tasks.length} 个临时工（并发 ${orch.workerConcurrency}，` +
      `单个 ${Math.round(orch.workerTimeoutMs / 1000)}s / 整批 ${Math.round(orch.workerJobBudgetMs / 1000)}s，搜索=${args.allow_search !== false}）`,
  );

  // 后台跑：**不 await**
  void runWorkerPool({
    env,
    jobId: job.id,
    tasks,
    allowSearch: args.allow_search !== false,
    concurrency: orch.workerConcurrency,
    perWorkerTimeoutMs: orch.workerTimeoutMs,
    budgetMs: orch.workerJobBudgetMs,
    maxSearchRounds: orch.workerMaxSearchRounds,
    signal: aborted,
  })
    .then((batch: WorkerBatchResult) => {
      // registry 侧的第二道幂等闸：已被超时/取消抢先就不要再投递
      if (!markResultReady(job.id)) {
        console.log(`[orc] job ${job.id} 已被抢先结束（超时/取消），丢弃这批结果`);
        return;
      }
      deliver({
        ok: batch.failCount === 0,
        detail: `${batch.okCount} 个临时工交活了${batch.failCount > 0 ? `，${batch.failCount} 个失败/超时` : ''}（耗时 ${Math.round(batch.tookMs / 1000)} 秒）`,
        data: batch,
      });
    })
    .catch((err) => {
      if (!markResultReady(job.id)) return;
      deliver({
        ok: false,
        error: 'worker_pool_failed',
        detail: `临时工这批出错了：${(err as Error)?.message ?? String(err)}`.slice(0, 400),
      });
    });

  const etaMs = orch.workerJobBudgetMs;
  return {
    ok: true,
    detail: `已派出 ${tasks.length} 个临时工并行处理，最多 ${Math.round(etaMs / 1000)} 秒`,
    data: { jobId: job.id, status: 'pending', workerCount: tasks.length },
    park: {
      jobId: job.id,
      kind: 'workers',
      etaMs,
      note: `我已经派出 ${tasks.length} 个临时工并行去做了（最多 ${Math.round(etaMs / 1000)} 秒）。` +
        '这一步我先停下来等他们，结果一回来就自动接着做 —— 你不用管，也不用催。',
    },
  };
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

/**
 * 启动时调一次：装上限、注册工具、挂上「循环被停 → 级联取消」的钩子。
 *
 * ★ `ORCHESTRATION_TOOLS=0` 是**一票否决**：不注册 spawn_workers / delegate / web_search，
 *   服务端与桌面就退回「只有 5 个浏览器工具 + stop（共 6 个）」——`browserToolNamesFor()` 查注册表
 *   发现 web_search 不在，主循环的工具表与改造前**逐字节一致**。
 */
/**
 * **只给验收脚本用**：换一套依赖（pool / env / cipher）重挂一次。
 *
 * ★ 为什么生产不需要它、也不该有它：
 *   `initOrchestrator` 在 boot 时调一次，env 是**启动时**读的（`.env` / 容器环境变量），
 *   跑起来不会变 —— 所以 `installed` 那道「只装一次」的闸是对的，重复调用应该 no-op。
 *   但验收脚本要在同一个进程里跑「超时 30s」和「超时 1.5s」两种编排配置，
 *   不给换依赖的口子就只能把熔断测试拆成独立进程（启动 pglite 一次要好几秒）。
 *
 * 名字里带 `ForTest` 是刻意的：`grep ForTest` 就能一眼看出哪些口子不是给生产用的。
 * 工具**不重复注册**（注册是全局注册表的副作用，重复注册没意义），只换依赖与名额表。
 */
export function setOrchestratorDepsForTest(next: OrchestratorDeps): void {
  deps = next;
  initRegistry(next.env.orch);
}

export function initOrchestrator(next: OrchestratorDeps): void {
  if (installed) return;
  deps = next;
  initRegistry(next.env.orch);

  onLoopStopped((loopId, reason) => {
    const n = cancelJobsOfLoop(loopId, reason === 'user_stop' ? 'owner_stopped' : reason);
    if (n > 0) console.log(`[orc] 循环 ${loopId} 被停（${reason}），级联取消 ${n} 个后台子任务`);
  });

  if (!next.env.orch.enabled) {
    console.log('[orc] 编排能力已关闭（ORCHESTRATION_TOOLS=0）：不注册 spawn_workers / delegate / web_search');
    installed = true;
    return;
  }

  registerServerTool(WEB_SEARCH_SERVER_TOOL, {
    execute: async (args) => executeWebSearchTool(next.env, args),
  });
  registerServerTool(SPAWN_WORKERS_TOOL, { execute: executeSpawnWorkers });
  registerDelegationTool();
  registerSkillTools();

  console.log(
    `[orc] 已注册 web_search / spawn_workers / delegate —— ` +
      `委派超时 ${Math.round(next.env.orch.delegateTimeoutMs / 1000)}s，` +
      `临时工并发 ${next.env.orch.workerConcurrency}（单次 ≤${next.env.orch.workerMaxPerCall}），` +
      `主循环搜索=${next.env.orch.agentLoopWebSearch ? '开' : '关'}`,
  );
  installed = true;
}
