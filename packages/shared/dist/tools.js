"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BROWSER_TOOL_NAMES = exports.BROWSER_TOOL_DEFINITIONS = exports.BROWSER_TOOL_TIMEOUT_MS = exports.SENSITIVE_TARGET_RE = exports.PAYMENT_TARGET_RE = void 0;
exports.createToolRegistry = createToolRegistry;
exports.toolArgStr = toolArgStr;
exports.sensitiveTargetHit = sensitiveTargetHit;
function createToolRegistry() {
    const defs = new Map();
    const execs = new Map();
    return {
        register(tool, executor) {
            if (!tool || typeof tool.name !== 'string' || !tool.name) {
                throw new Error('ToolRegistry.register：工具名不能为空');
            }
            if (defs.has(tool.name)) {
                throw new Error(`ToolRegistry.register：工具「${tool.name}」已注册，不允许覆盖`);
            }
            defs.set(tool.name, tool);
            if (executor)
                execs.set(tool.name, executor);
        },
        get: (name) => defs.get(name),
        list: (names) => {
            if (!names)
                return [...defs.values()];
            const out = [];
            for (const n of names) {
                const d = defs.get(n);
                if (d)
                    out.push(d);
            }
            return out;
        },
        toOpenAITools: (names) => {
            const out = [];
            for (const n of names) {
                const d = defs.get(n);
                if (!d)
                    throw new Error(`ToolRegistry.toOpenAITools：工具「${n}」未注册`);
                out.push({
                    type: 'function',
                    function: {
                        name: d.name,
                        description: d.description,
                        // 深拷贝：调用方（llmFetch JSON 序列化等）不得有机会改掉注册表里的原对象
                        parameters: JSON.parse(JSON.stringify(d.parameters)),
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
function toolArgStr(v, max) {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
/** 支付/收银的最终确认永远由用户点（第 9 步硬规矩） */
exports.PAYMENT_TARGET_RE = /(立即支付|确认支付|确认付款|去支付|去付款|提交订单|确认订单|pay\s*now|checkout|place\s*order)/i;
/** 敏感字段：命中就不代填，转成「请你自己在卡片里输」 */
exports.SENSITIVE_TARGET_RE = /(密码|password|验证码|校验码|动态口令|短信码|otp|captcha|verification\s*code|支付|付款|银行卡|卡号|cvv|身份证)/i;
/** 命中的敏感字段描述（快照里标过敏感的框，或文案本身像敏感字段） */
function sensitiveTargetHit(snapshot, target) {
    const t = target.trim().toLowerCase();
    if (!t)
        return '';
    for (const f of snapshot?.inputFields ?? []) {
        if (f.kind !== 'sensitive')
            continue;
        const lab = f.label.toLowerCase().replace(/^\[敏感·[^\]]*\]\s*/, '');
        if (lab && !lab.includes('无标识') && (t.includes(lab.slice(0, 20)) || lab.includes(t)))
            return f.label;
    }
    return exports.SENSITIVE_TARGET_RE.test(t) ? target : '';
}
/** 浏览器工具单步执行超时（与桌面 agent.ts 的 EXEC_TIMEOUT_MS 同值，改一处要同时改两处） */
exports.BROWSER_TOOL_TIMEOUT_MS = 20_000;
// ---------------------------------------------------------------------------
// 内建工具定义（6 个：5 个浏览器工具 open_url/read_page/click/type/scroll + stop）。
// description / parameters 从旧 LOOP_TOOLS **逐字**迁移 ——
// `scripts/verify/tool-registry-parity.mjs` 会断言 toOpenAITools 输出与旧字面量 deep-equal，
// 改任何一个字都会红。想改话术请走正常的提示词评审，不要在这里顺手改。
// ---------------------------------------------------------------------------
const openUrlTool = {
    name: 'open_url',
    description: '在工作台浏览器里打开一个 http(s) 网址。只在需要换站点、或当前页明显不是目标站点时用；' +
        '只是要在当前页面上搜/读/点，就不要换页。',
    parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要打开的完整地址，必须以 http:// 或 https:// 开头' } },
        required: ['url'],
    },
    side: 'desktop',
    kind: 'action',
    timeoutMs: exports.BROWSER_TOOL_TIMEOUT_MS,
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
const readPageTool = {
    name: 'read_page',
    description: '读当前这张页的地址、标题、可见按钮 / 链接 / 输入框，用来确认页面上到底有什么。信息不够时先读一次再决定。',
    parameters: { type: 'object', properties: {} },
    side: 'desktop',
    kind: 'action',
    timeoutMs: exports.BROWSER_TOOL_TIMEOUT_MS,
    permission: 'browser',
    validate: () => ({ ok: true, args: {} }),
    toBrowserAction: () => ({ action: 'read_page' }),
};
const clickTool = {
    name: 'click',
    description: '点击当前页面上一个可见元素。target 写元素上的文字（按钮/链接文字），例如「百度一下」。',
    parameters: {
        type: 'object',
        properties: { target: { type: 'string', description: '要点的按钮或链接上的文字' } },
        required: ['target'],
    },
    side: 'desktop',
    kind: 'action',
    timeoutMs: exports.BROWSER_TOOL_TIMEOUT_MS,
    permission: 'browser',
    validate: (args) => {
        const target = toolArgStr(args.target, 160);
        if (!target)
            return { ok: false, reason: 'bad_target', question: '要点的东西没写清楚。页面上你想让我点哪个？' };
        if (exports.PAYMENT_TARGET_RE.test(target)) {
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
const typeTool = {
    name: 'type',
    description: '往当前页面上的一个输入框里输入文字（打到网页自己的框里，不是聊天框）。' +
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
    timeoutMs: exports.BROWSER_TOOL_TIMEOUT_MS,
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
const scrollTool = {
    name: 'scroll',
    description: '在当前页面上向下/向上滚动一屏（内容没露出来时用）。',
    parameters: {
        type: 'object',
        properties: { direction: { type: 'string', enum: ['up', 'down'], description: '滚动方向' } },
        required: ['direction'],
    },
    side: 'desktop',
    kind: 'action',
    timeoutMs: exports.BROWSER_TOOL_TIMEOUT_MS,
    permission: 'browser',
    validate: (args) => ({ ok: true, args: { direction: args.direction === 'up' ? 'up' : 'down' } }),
    toBrowserAction: (args) => ({ action: 'scroll', direction: args.direction === 'up' ? 'up' : 'down' }),
};
const stopTool = {
    name: 'stop',
    description: '结束这一轮循环。reason=done 表示用户要的结果已经在页面上（summary 写结论）；' +
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
            ? args.document_outline.slice(0, 12).map((x) => String(x).slice(0, 120))
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
exports.BROWSER_TOOL_DEFINITIONS = [
    openUrlTool,
    readPageTool,
    clickTool,
    typeTool,
    scrollTool,
    stopTool,
];
/** 发模型的工具名表（与 BROWSER_TOOL_DEFINITIONS 同顺序） */
exports.BROWSER_TOOL_NAMES = exports.BROWSER_TOOL_DEFINITIONS.map((d) => d.name);
//# sourceMappingURL=tools.js.map