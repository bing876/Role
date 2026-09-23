/**
 * 阶段 0 · Tool Registry 契约（定义与执行分离的两截式，见文件头必读）。
 *
 * ★ 为什么 Registry 要拆成两截（改这里前先读完，否则一定改错）：
 *   本项目是「脑在服务端、手在桌面」的拉取式架构 —— 脑和手不在一个进程里，
 *   所以 Registry **不能**是传统单进程内「注册表里直接挂 execute 实现」的那种：
 *     · 本文件 = **定义侧**：工具名 / 给模型看的 schema / 路由声明（side/kind）/
 *       纯校验 validate / 纯映射 toBrowserAction。**零 Node / Electron 依赖**，
 *       任何环境 import 都安全。
 *     · 执行器按位置分两侧实现：
 *         - 浏览器工具（side='desktop'）→ 桌面 `electron/toolExecutors.ts` 的本地映射表
 *           + 现有 `driver.ts`（一行不改）；
 *         - 服务端工具（side='server'，阶段 1 的临时工/阶段 2 的委派）
 *           → 服务端 `toolRegistry.ts` 注册的 executor，`advanceInner` 内就地执行。
 *   桌面侧**故意不**在运行时 import 本文件（只 import 类型）：打包配置
 *   `apps/desktop/package.json` 的 electron-builder `files` 白名单里**没有**
 *   node_modules，打包后的应用在运行时根本没有 `@ai-workbench/shared`。
 *   桌面那份映射表是本地的，与本文件的 `toBrowserAction` 逐项等价，
 *   由 `scripts/verify/tool-registry-parity.mjs` 强制断言一致 ——
 *   **不要**为了「合一」而给 Electron 主进程加运行时 import，那会让打包产物启动即崩。
 *
 * 阶段 0 范围（最小）：只注册化 5 个浏览器工具 + stop 这 6 个定义。
 * `web_search` 仍留在 `search/chatTool.ts`，本次不动（行为零变化）。
 */
import type { BrowserAction, LoopToolResult, PageSnapshot } from './index';
/** OpenAI function parameters 口径的 JSON Schema 子集（只用到的那几个关键字） */
export interface ToolParameterSchema {
    type: string;
    description?: string;
    enum?: string[];
    items?: {
        type: string;
    };
}
export interface ToolJsonSchema {
    type: 'object';
    properties: Record<string, ToolParameterSchema>;
    required?: string[];
}
/** validate 拿到的上下文：只需要最新页面快照（敏感判定用），不需要会话身份 */
export interface ToolValidateContext {
    snapshot: PageSnapshot | null;
}
/**
 * 执行器拿到的基础上下文（两端共有字段）。
 * 服务端扩展见 `apps/server/src/toolRegistry.ts` 的 ServerExecutionContext。
 */
export interface BaseExecutionContext extends ToolValidateContext {
    loopId: string;
    userId: number;
    agentId: number | null;
    wcId: number | null;
    conversationId: number | null;
    /**
     * 取消信号（暂停/作废时触发；阶段 0 预留，执行器暂不消费）。
     * 只取最小结构（不用 AbortSignal 类型）：本包零依赖，lib 里没有 DOM @types/node。
     */
    signal?: {
        readonly aborted: boolean;
    };
}
/** 工具在哪执行：desktop = 下发给桌面（现有路径）；server = 服务端就地执行后继续内循环 */
export type ToolSide = 'desktop' | 'server';
/** action = 执行动作；control = 控制流（stop），只给模型看 schema，永不下发执行 */
export type ToolKind = 'action' | 'control';
export type ToolValidateOutcome = {
    ok: true;
    args: Record<string, unknown>;
} | {
    ok: false;
    reason: string;
    question: string;
};
/**
 * 工具定义 = 给模型看的 schema + 路由声明 + 纯校验/纯映射（不含副作用执行）。
 * `permission` 预留给产品 3.2「工具权限」，阶段 0 只声明、不 enforcement。
 */
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: ToolJsonSchema;
    side: ToolSide;
    kind: ToolKind;
    /** 单次执行超时（毫秒）。浏览器工具沿用既有 20s（与 agent.ts EXEC_TIMEOUT_MS 同值）。 */
    timeoutMs: number;
    permission?: string;
    /** 参数校验 + 业务闸（纯函数，可单测；脏动作返回 reason + 人话 question） */
    validate(args: Record<string, unknown>, ctx: ToolValidateContext): ToolValidateOutcome;
    /** 仅 desktop 浏览器工具：纯映射 args → BrowserAction（与桌面本地表逐项等价） */
    toBrowserAction?(args: Record<string, unknown>): BrowserAction | null;
}
/** 服务端直执行工具的执行器签名（只在服务端实现；TCtx 由服务端具化） */
export interface ToolExecutor<TCtx> {
    execute(args: Record<string, unknown>, ctx: TCtx): Promise<LoopToolResult>;
}
export interface OpenAIFunctionTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: ToolJsonSchema;
    };
}
export interface ToolRegistry<TCtx = unknown> {
    /** 注册。重名抛错（启动时失败，不静默覆盖） */
    register(tool: ToolDefinition, executor?: ToolExecutor<TCtx>): void;
    get(name: string): ToolDefinition | undefined;
    /** 不传 names = 全部（注册顺序）；传了 = 按请求顺序过滤 */
    list(names?: string[]): ToolDefinition[];
    /** 生成发模型的 tools 数组（按 names 顺序；有未注册名就抛错，不静默跳过） */
    toOpenAITools(names: string[]): OpenAIFunctionTool[];
    getExecutor(name: string): ToolExecutor<TCtx> | undefined;
}
export declare function createToolRegistry<TCtx = unknown>(): ToolRegistry<TCtx>;
/** 取一个字符串参数：非字符串按空串处理（语义由各工具 validate 判定） */
export declare function toolArgStr(v: unknown, max: number): string;
/** 支付/收银的最终确认永远由用户点（第 9 步硬规矩） */
export declare const PAYMENT_TARGET_RE: RegExp;
/** 敏感字段：命中就不代填，转成「请你自己在卡片里输」 */
export declare const SENSITIVE_TARGET_RE: RegExp;
/** 命中的敏感字段描述（快照里标过敏感的框，或文案本身像敏感字段） */
export declare function sensitiveTargetHit(snapshot: PageSnapshot | null, target: string): string;
/** 浏览器工具单步执行超时（与桌面 agent.ts 的 EXEC_TIMEOUT_MS 同值，改一处要同时改两处） */
export declare const BROWSER_TOOL_TIMEOUT_MS = 20000;
/**
 * 内建工具定义（顺序 = 发模型的工具表顺序，与旧 LOOP_TOOLS 一致，改顺序会红对照测试）。
 * 阶段 0 只有这 7 个；阶段 1+ 的新工具（临时工/委派）由服务端在 toolRegistry 里 register，
 * 不要往这个数组里加 side='server' 的条目（server 工具的 schema 名单由各调用方自行决定）。
 */
export declare const BROWSER_TOOL_DEFINITIONS: ToolDefinition[];
/** 发模型的工具名表（与 BROWSER_TOOL_DEFINITIONS 同顺序） */
export declare const BROWSER_TOOL_NAMES: string[];
//# sourceMappingURL=tools.d.ts.map