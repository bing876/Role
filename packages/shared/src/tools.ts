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
 * 阶段 0 范围（最小）：只注册化浏览器 6 工具 + stop 这 7 个定义。
 * `web_search` 仍留在 `search/chatTool.ts`，本次不动（行为零变化）。
 */
import type { BrowserAction, LoopToolResult, PageSnapshot } from './index';

/** OpenAI function parameters 口径的 JSON Schema 子集（只用到的那几个关键字） */
export interface ToolParameterSchema {
  type: string;
  description?: string;
  enum?: string[];
  items?: { type: string };
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
  signal?: { readonly aborted: boolean };
}

/** 工具在哪执行：desktop = 下发给桌面（现有路径）；server = 服务端就地执行后继续内循环 */
export type ToolSide = 'desktop' | 'server';
/** action = 执行动作；control = 控制流（stop），只给模型看 schema，永不下发执行 */
export type ToolKind = 'action' | 'control';

export type ToolValidateOutcome =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; reason: string; question: string };

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
  function: { name: string; description: string; parameters: ToolJsonSchema };
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

export function createToolRegistry<TCtx = unknown>(): ToolRegistry<TCtx> {
  const defs = new Map<string, ToolDefinition>();
  const execs = new Map<string, ToolExecutor<TCtx>>();
  return {
    register(tool, executor) {
      if (!tool || typeof tool.name !== 'string' || !tool.name) {
        throw new Error('ToolRegistry.register：工具名不能为空');
      }
      if (defs.has(tool.name)) {
        throw new Error(`ToolRegistry.register：工具「${tool.name}」已注册，不允许覆盖`);
      }
      defs.set(tool.name, tool);
      if (executor) execs.set(tool.name, executor);
    },
    get: (name) => defs.get(name),
    list: (names) => {
      if (!names) return [...defs.values()];
      const out: ToolDefinition[] = [];
      for (const n of names) {
        const d = defs.get(n);
        if (d) out.push(d);
      }
      return out;
    },
    toOpenAITools: (names) => {
      const out: OpenAIFunctionTool[] = [];
      for (const n of names) {
        const d = defs.get(n);
        if (!d) throw new Error(`ToolRegistry.toOpenAITools：工具「${n}」未注册`);
        out.push({
          type: 'function',
          function: {
            name: d.name,
            description: d.description,
            // 深拷贝：调用方（llmFetch JSON 序列化等）不得有机会改掉注册表里的原对象
            parameters: JSON.parse(JSON.stringify(d.parameters)) as ToolJsonSchema,
          },
        });
      }
      return out;
    },
    getExecutor: (name) => execs.get(name),
  };
}

// ---------------------------------------------------------------------------
// 共享小件（从 toolLoop.ts 搬家，逻辑逐字一致；新旧两份校验共用它们）
// ---------------------------------------------------------------------------

/** 取一个字符串参数：非字符串按空串处理（语义由各工具 validate 判定） */
export function toolArgStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** 支付/收银的最终确认永远由用户点（第 9 步硬规矩） */
export const PAYMENT_TARGET_RE =
  /(立即支付|确认支付|确认付款|去支付|去付款|提交订单|确认订单|pay\s*now|checkout|place\s*order)/i;

/** 敏感字段：命中就不代填，转成「请你自己在卡片里输」 */
export const SENSITIVE_TARGET_RE =
  /(密码|password|验证码|校验码|动态口令|短信码|otp|captcha|verification\s*code|支付|付款|银行卡|卡号|cvv|身份证)/i;

/** 命中的敏感字段描述（快照里标过敏感的框，或文案本身像敏感字段） */
export function sensitiveTargetHit(snapshot: PageSnapshot | null, target: string): string {
  const t = target.trim().toLowerCase();
  if (!t) return '';
  for (const f of snapshot?.inputFields ?? []) {
    if (f.kind !== 'sensitive') continue;
    const lab = f.label.toLowerCase().replace(/^\[敏感·[^\]]*\]\s*/, '');
    if (lab && !lab.includes('无标识') && (t.includes(lab.slice(0, 20)) || lab.includes(t))) return f.label;
  }
  return SENSITIVE_TARGET_RE.test(t) ? target : '';
}

/** 浏览器工具单步执行超时（与桌面 agent.ts 的 EXEC_TIMEOUT_MS 同值，改一处要同时改两处） */
export const BROWSER_TOOL_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// 内建工具定义（7 个：浏览器 6 工具 + stop）。
// description / parameters 从旧 LOOP_TOOLS **逐字**迁移 ——
// `scripts/verify/tool-registry-parity.mjs` 会断言 toOpenAITools 输出与旧字面量 deep-equal，
// 改任何一个字都会红。想改话术请走正常的提示词评审，不要在这里顺手改。
// ---------------------------------------------------------------------------

const openUrlTool: ToolDefinition = {
  name: 'open_url',
  description:
    '在工作台浏览器里打开一个 http(s) 网址。只在需要换站点、或当前页明显不是目标站点时用；' +
    '只是要在当前页面上搜/读/点，就不要换页。',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: '要打开的完整地址，必须以 http:// 或 https:// 开头' } },
    required: ['url'],
  },
  side: 'desktop',
  kind: 'action',
  timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
  permission: 'browser',
  validate: (args) => {
    const url = toolArgStr(args.url, 500);
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, reason: 'bad_url', question: '要打开的网址不合法（需要 http(s):// 开头）。请确认目标站点。' };
    }
    return { ok: true, args: { url } };
  },
  toBrowserAction: (args) => ({ action: 'open_url', url: String(args.url ?? '') }),
};

const readPageTool: ToolDefinition = {
  name: 'read_page',
  description: '读当前这张页的地址、标题、可见按钮 / 链接 / 输入框，用来确认页面上到底有什么。信息不够时先读一次再决定。',
  parameters: { type: 'object', properties: {} },
  side: 'desktop',
  kind: 'action',
  timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
  permission: 'browser',
  validate: () => ({ ok: true, args: {} }),
  toBrowserAction: () => ({ action: 'read_page' }),
};

const clickTool: ToolDefinition = {
  name: 'click',
  description: '点击当前页面上一个可见元素。target 写元素上的文字（按钮/链接文字），例如「百度一下」。',
  parameters: {
    type: 'object',
    properties: { target: { type: 'string', description: '要点的按钮或链接上的文字' } },
    required: ['target'],
  },
  side: 'desktop',
  kind: 'action',
  timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
  permission: 'browser',
  validate: (args) => {
    const target = toolArgStr(args.target, 160);
    if (!target) return { ok: false, reason: 'bad_target', question: '要点的东西没写清楚。页面上你想让我点哪个？' };
    if (PAYMENT_TARGET_RE.test(target)) {
      return {
        ok: false,
        reason: 'payment_confirm',
        question: '支付/收银的最终确认必须由你自己点，我不代点。你在卡片里确认后告诉我结果就行。',
      };
    }
    return { ok: true, args: { target } };
  },
  toBrowserAction: (args) => ({ action: 'click', target: String(args.target ?? '') }),
};

const typeTool: ToolDefinition = {
  name: 'type',
  description:
    '往当前页面上的一个输入框里输入文字（打到网页自己的框里，不是聊天框）。' +
    'submit=true 表示输完直接回车提交。目标里有「搜索/查/找」时，必须真的用这个工具把关键词打进搜索框并提交。',
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', description: '输入框的描述（placeholder / 名称，例如「搜索框」）' },
      text: { type: 'string', description: '真正要输入的文字' },
      submit: { type: 'boolean', description: '输完是否回车提交，默认 false' },
    },
    required: ['target', 'text'],
  },
  side: 'desktop',
  kind: 'action',
  timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
  permission: 'browser',
  validate: (args, ctx) => {
    const target = toolArgStr(args.target, 160);
    // 注意：text 只截断不清空格（与旧 sanitizeToolCall 逐字一致，别顺手加 trim）
    const text = typeof args.text === 'string' ? args.text.slice(0, 500) : '';
    if (!target || !text) {
      return { ok: false, reason: 'bad_target', question: '输入框或要输入的内容没写清楚，请告诉我往哪个框里输什么。' };
    }
    const sens = sensitiveTargetHit(ctx.snapshot, target);
    if (sens) {
      return {
        ok: false,
        reason: 'sensitive_field',
        question: `这一步要往「${sens.slice(0, 40)}」里输入，这类敏感内容必须由你自己在网页卡片里打——我不代填、也不会留存。输完点「继续」，我接着做。`,
      };
    }
    return { ok: true, args: { target, text, submit: Boolean(args.submit) } };
  },
  toBrowserAction: (args) => ({
    action: 'type',
    target: String(args.target ?? ''),
    text: String(args.text ?? ''),
    submit: Boolean(args.submit),
  }),
};

const scrollTool: ToolDefinition = {
  name: 'scroll',
  description: '在当前页面上向下/向上滚动一屏（内容没露出来时用）。',
  parameters: {
    type: 'object',
    properties: { direction: { type: 'string', enum: ['up', 'down'], description: '滚动方向' } },
    required: ['direction'],
  },
  side: 'desktop',
  kind: 'action',
  timeoutMs: BROWSER_TOOL_TIMEOUT_MS,
  permission: 'browser',
  validate: (args) => ({ ok: true, args: { direction: args.direction === 'up' ? 'up' : 'down' } }),
  toBrowserAction: (args) => ({ action: 'scroll', direction: args.direction === 'up' ? 'up' : 'down' }),
};

const stopTool: ToolDefinition = {
  name: 'stop',
  description:
    '结束这一轮循环。reason=done 表示用户要的结果已经在页面上（summary 写结论）；' +
    'reason=need_user 表示你被卡住了（question 写你要用户做什么，例如自己登录 / 自己输验证码）；' +
    'reason=blocked 表示页面上根本做不了（question 写原因和一条替代路）。',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', enum: ['done', 'need_user', 'blocked'] },
      summary: { type: 'string', description: 'reason=done 时的结论（给聊天窗口看，短、可扫读）' },
      question: { type: 'string', description: 'reason=need_user/blocked 时，问用户的一句话' },
      document_title: { type: 'string', description: '可选：结论文档的标题' },
      document_outline: { type: 'array', items: { type: 'string' }, description: '可选：要点提纲（最多 12 条）' },
    },
    required: ['reason'],
  },
  side: 'desktop',
  kind: 'control',
  // control 类工具永不执行，timeout 无意义，填 0 明示（不要填 20000，那会误导后人以为它会被执行）
  timeoutMs: 0,
  validate: (args) => {
    const reason = toolArgStr(args.reason, 20) || 'done';
    const outline = Array.isArray(args.document_outline)
      ? (args.document_outline as unknown[]).slice(0, 12).map((x) => String(x).slice(0, 120))
      : [];
    return {
      ok: true,
      args: {
        reason,
        summary: toolArgStr(args.summary, 500),
        question: toolArgStr(args.question, 500),
        document_title: toolArgStr(args.document_title, 120),
        document_outline: outline,
      },
    };
  },
  // control 类没有 toBrowserAction：任何一方查到它都必须走控制流分支，绝不映射成动作
};

/**
 * 内建工具定义（顺序 = 发模型的工具表顺序，与旧 LOOP_TOOLS 一致，改顺序会红对照测试）。
 * 阶段 0 只有这 7 个；阶段 1+ 的新工具（临时工/委派）由服务端在 toolRegistry 里 register，
 * 不要往这个数组里加 side='server' 的条目（server 工具的 schema 名单由各调用方自行决定）。
 */
export const BROWSER_TOOL_DEFINITIONS: ToolDefinition[] = [
  openUrlTool,
  readPageTool,
  clickTool,
  typeTool,
  scrollTool,
  stopTool,
];

/** 发模型的工具名表（与 BROWSER_TOOL_DEFINITIONS 同顺序） */
export const BROWSER_TOOL_NAMES: string[] = BROWSER_TOOL_DEFINITIONS.map((d) => d.name);
