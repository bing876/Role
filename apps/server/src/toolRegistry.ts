/**
 * 阶段 0 · 服务端 Tool Registry 单例（定义的**消费侧**，不是第二份定义）。
 *
 *   - 工具定义（schema / validate / toBrowserAction）只活在
 *     `@ai-workbench/shared` 的 `tools.ts`，这里只做两件事：
 *     ① 启动时把内建定义 register 进来；② 给阶段 1+ 留 `registerServerTool` 注册口。
 *   - 浏览器工具的执行器**不在这里** —— 它们在桌面（`electron/toolExecutors.ts` +
 *     `driver.ts`），服务端只负责 validate + 下发。这是刻意的：脑和手不在一个进程，
 *     注册表里挂不上桌面的 execute 实现（tools.ts 文件头有完整解释）。
 *   - 阶段 0 **不注册任何** side='server' 的工具：`advanceInner` 里的服务端直执行
 *     分支只被对照测试覆盖，线上永远走旧路径。阶段 1 的临时工 / 阶段 2 的委派
 *     到时用 `registerServerTool` 注册，那时才第一次有 server 工具上线。
 */
import {
  BROWSER_TOOL_DEFINITIONS,
  createToolRegistry,
  type BaseExecutionContext,
  type LoopToolCall,
  type LoopToolResult,
  type ToolDefinition,
  type ToolRegistry,
} from '@ai-workbench/shared';

/**
 * 服务端工具执行器的上下文 = 基础字段（loopId/userId/agentId/wcId/…）+
 * 将来扩展位（db pool / env / 子循环工厂等，扩展时只加可选字段，不改旧字段）。
 */
export interface ServerExecutionContext extends BaseExecutionContext {
  /**
   * 多智能体编排 · 这一路的**委派链**（发起方 → … → 当前）。
   *
   * `delegate` 的「链深 ≤ N」与「不许成环」两道闸全靠它 —— 没有链信息，
   * A→B→C→D→… 就能一直转下去（用户明确要求防死循环）。
   * 浏览器循环缺省是 `[自己的 agentId]`；子循环是 `[发起方, …, 自己]`。
   * 可选字段：阶段 0 的对照测试造的最小 ctx 不带它，`delegate` 会按「只有发起方」处理。
   */
  chain?: number[];
}

/** 服务端工具执行器：阶段 1+ 的 server 工具实现这个签名 */
export interface ServerToolExecutor {
  execute(args: Record<string, unknown>, ctx: ServerExecutionContext): Promise<LoopToolResult>;
}

/** 全进程唯一的服务端注册表（启动时一次性装好内建定义，之后只读） */
export const serverToolRegistry: ToolRegistry<ServerExecutionContext> = createToolRegistry<ServerExecutionContext>();

for (const def of BROWSER_TOOL_DEFINITIONS) {
  serverToolRegistry.register(def);
}

/** 发模型的工具名表（顺序 = BROWSER_TOOL_DEFINITIONS 顺序，与旧 LOOP_TOOLS 一致） */
export const LOOP_TOOL_NAMES: string[] = BROWSER_TOOL_DEFINITIONS.map((d) => d.name);

/**
 * 多智能体编排 · 被委派子循环的工具表。
 *
 * ★ 注意这里**没有** open_url / read_page / click / type / scroll —— 被委派方**没有浏览器手**。
 *   工具表就是能力边界：它想开页也没有工具可调（提示词里再说一遍是近因压制，见 orchestrator/prompts.ts）。
 *   将来要给它「桌面手」，只需要在这里加名字 + 给子循环分配 wcId 与 lane，其余部分不用动。
 */
export const SUB_AGENT_TOOL_NAMES: string[] = ['web_search', 'spawn_workers', 'delegate', 'stop'];

/**
 * 多智能体编排 · 主浏览器循环实际该用的工具表。
 *
 * ★ `LOOP_TOOL_NAMES` 是**冻结常量**（阶段 0 的 181 条对照断言拿它当旧真相），
 *   所以「要不要多挂几个编排工具」不能改它，只能在这里算出一张新表。
 *
 * ★ 新工具一律**追加在末尾**：前 6 个（5 个浏览器工具 + stop）的位置与冻结常量完全一致。
 *   工具顺序会进请求体，模型对靠前的工具也有偏好；把编排工具插到中间，
 *   等于悄悄改了「浏览器循环优先干什么」—— 那不该是这个改动的副作用。
 *
 * ★ 三道防御，缺一不可（`toOpenAITools` 遇到**未注册**的名字会抛错，整条循环直接起不来）：
 *   ① `env.orch` 缺失（老测试用 `as unknown as ServerEnv` 造的最小 env）→ 直接回冻结常量，
 *      工具表与改前**逐字节一致**。宁可少几个工具，也不能给一张名字没注册的名表。
 *   ② 编排总开关 `orch.enabled`（`ORCHESTRATION_TOOLS=0` 时是 false）→ 关掉就一个都不挂。
 *   ③ 每个名字都**查注册表确认真的注册了**才挂 —— 开关说开、进程里没装（比如
 *      `initOrchestrator` 没被调用）时，挂上去就是让循环启动即崩。
 *
 * `web_search` 单独一道闸（`agentLoopWebSearch`）：浏览器循环本职是「在页面上操作」，
 *   要不要顺手让它能查公开资料是一个独立的产品决定（已确认**默认开**），
 *   所以不与「能不能派临时工/委派」绑在同一个开关上。
 */
export function browserToolNamesFor(
  env: { orch?: { enabled?: boolean; agentLoopWebSearch?: boolean } } | null | undefined,
): string[] {
  const orch = env?.orch;
  if (!orch) return LOOP_TOOL_NAMES; // 防御 ①：老测试的最小 env，回旧表
  const extra: string[] = [];
  // web_search：独立开关（默认开）
  if (orch.agentLoopWebSearch && serverToolRegistry.get('web_search')) extra.push('web_search');
  // 编排两件套：总开关
  if (orch.enabled) {
    for (const n of ['spawn_workers', 'delegate']) {
      if (serverToolRegistry.get(n)) extra.push(n);
    }
  }
  return extra.length > 0 ? [...LOOP_TOOL_NAMES, ...extra] : LOOP_TOOL_NAMES;
}

// 启动时 fail-fast：名单里有一个名字没注册成功就直接崩，不要带着残缺的工具表上线
for (const n of LOOP_TOOL_NAMES) {
  if (!serverToolRegistry.get(n)) {
    throw new Error(`[tool-registry] 内建工具「${n}」未注册成功，拒绝启动`);
  }
}

/**
 * 注册一个 side='server' 的工具（阶段 1+ 用，阶段 0 没有调用方）。
 *
 * 约束（现在就立规矩，免得阶段 1 写歪）：
 *   - name 必须未被注册（重名抛错，不覆盖）；
 *   - `tool.side` 必须是 'server' —— browser 工具的执行器在桌面，不许在这里注册
 *     一个同名的 server 版把它「劫持」掉（路由歧义是灾难）；
 *   - 执行器抛出的异常由 `advanceInner` 统一转成 `{ ok:false, error }` 的工具回执，
 *     不会炸掉循环，但执行器自己要保证「失败时无副作用或可重入」。
 */
export function registerServerTool(tool: ToolDefinition, executor: ServerToolExecutor): void {
  if (tool.side !== 'server') {
    throw new Error(`[tool-registry] registerServerTool 只接受 side='server' 的工具，「${tool.name}」是 ${tool.side}`);
  }
  serverToolRegistry.register(tool, {
    execute: (args, ctx) => executor.execute(args, ctx),
  });
}

/** 兜底：工具调用的 args 归一成对象（历史脏数据 / 版本错位时不让映射函数抛错） */
export function normalizeToolArgs(call: LoopToolCall): Record<string, unknown> {
  const a = (call as { args?: unknown } | null | undefined)?.args;
  return a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : {};
}
