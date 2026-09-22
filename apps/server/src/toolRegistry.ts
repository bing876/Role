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
  // 阶段 0：无新增字段。占位注释提醒后人：加字段走「可选 + 默认值」，不许 breaking。
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
