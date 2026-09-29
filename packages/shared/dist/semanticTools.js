"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SEMANTIC_BROWSER_TOOL_DEFINITIONS = void 0;
const tools_1 = require("./tools");
const KEYS = ['id', 'testId', 'ariaLabel', 'name', 'text', 'tag', 'within'];
function target(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        return null;
    const raw = v;
    const out = {};
    for (const key of KEYS) {
        if (raw[key] === undefined)
            continue;
        if (typeof raw[key] !== 'string' || raw[key].length > 160)
            return null;
        const text = raw[key].trim();
        if (text)
            out[key] = text;
    }
    if (out.tag && !/^[a-z][a-z0-9-]{0,24}$/i.test(out.tag))
        return null;
    // tag/within 单独给出相当于「随便第一颗」——绝不定位。
    return ['id', 'testId', 'ariaLabel', 'name', 'text'].some((k) => out[k]) ? out : null;
}
const schema = {
    type: 'object', properties: {
        id: { type: 'string', description: '稳定 id（如已知）' },
        testId: { type: 'string', description: 'data-testid（如已知）' },
        ariaLabel: { type: 'string', description: 'aria-label（如已知）' },
        name: { type: 'string', description: '输入框 name（如已知）' },
        text: { type: 'string', description: '可见文字或占位符；改 class 也能找到' },
        tag: { type: 'string', description: 'HTML tag，例如 button / input，用于收窄范围' },
        within: { type: 'string', description: '可选稳定祖先选择器，如 form/nav；找不到则拒绝，不扩成全页' },
    }, additionalProperties: false,
};
exports.SEMANTIC_BROWSER_TOOL_DEFINITIONS = [
    {
        name: 'click_semantic', side: 'desktop', kind: 'action', timeoutMs: tools_1.BROWSER_TOOL_TIMEOUT_MS, permission: 'browser',
        description: '点击页面上的语义目标；改版换 class/顺序后仍按 data-testid/aria/可见文字识别。比旧 click 的 CSS/位置更稳。目标未命中时停下，不用旧 CSS 猜测。支付/下单最终确认仍必须用户自己点。',
        parameters: { type: 'object', properties: {
                target: { type: 'string', description: '要点的按钮/链接人话描述（用于回执和安全判定）' },
                semantic: schema,
            }, required: ['target', 'semantic'] },
        validate: (args) => {
            const label = typeof args.target === 'string' ? args.target.trim().slice(0, 160) : '';
            const sem = target(args.semantic);
            if (!label || !sem)
                return { ok: false, reason: 'bad_target', question: '点击目标缺少有效语义描述，没点任何东西。' };
            if (tools_1.PAYMENT_TARGET_RE.test([label, sem.text, sem.ariaLabel, sem.name, sem.id, sem.testId].filter(Boolean).join(' ')))
                return { ok: false, reason: 'payment_confirm', question: '付款/提交订单的最终确认必须由你自己点。' };
            return { ok: true, args: { target: label, semantic: sem } };
        },
        toBrowserAction: (args) => ({ action: 'click', target: String(args.target ?? ''), semantic: args.semantic }),
    },
    {
        name: 'type_semantic', side: 'desktop', kind: 'action', timeoutMs: tools_1.BROWSER_TOOL_TIMEOUT_MS, permission: 'browser',
        description: '按稳定属性/占位符的语义定位输入框，改版换 class 后仍能定位；找不到不回落猜一个输入框。敏感字段（密码/验证码/卡号）一律由用户自己输入。',
        parameters: { type: 'object', properties: {
                target: { type: 'string', description: '输入框人话描述（用于回执和安全判定）' },
                semantic: schema,
                text: { type: 'string', description: '要输入的文字' },
                submit: { type: 'boolean', description: '输入完是否回车提交；默认 false' },
            }, required: ['target', 'semantic', 'text'] },
        validate: (args, ctx) => {
            const label = typeof args.target === 'string' ? args.target.trim().slice(0, 160) : '';
            const sem = target(args.semantic);
            const text = typeof args.text === 'string' ? args.text.slice(0, 500) : '';
            if (!label || !sem || !text)
                return { ok: false, reason: 'bad_target', question: '输入框/语义/要输入的内容缺失，未执行。' };
            const sensitive = [label, sem.text, sem.ariaLabel, sem.name, sem.id, sem.testId].filter(Boolean).map((x) => (0, tools_1.sensitiveTargetHit)(ctx.snapshot, String(x))).find(Boolean);
            if (sensitive)
                return { ok: false, reason: 'sensitive_field', question: '密码/验证码/付款等敏感内容必须由你自己在网页输入。' };
            return { ok: true, args: { target: label, semantic: sem, text, submit: Boolean(args.submit) } };
        },
        toBrowserAction: (args) => ({ action: 'type', target: String(args.target ?? ''), text: String(args.text ?? ''),
            submit: Boolean(args.submit), semantic: args.semantic }),
    },
];
//# sourceMappingURL=semanticTools.js.map