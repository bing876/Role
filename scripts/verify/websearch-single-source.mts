/**
 * web_search 单一来源验收（收口后）
 * 目标：确保只有一份定义，聊天与编排共用，且参数契约一致。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
/**
 * ★★★ 服务端三个模块必须用 `require`（CJS 图）载入，**不能**用 `import`（2026-09-25 修）
 * ---------------------------------------------------------------------------
 * 本文件是 `.mts`（ESM），而 `apps/server` 是 **CommonJS**（tsconfig `module: CommonJS`
 * + package.json 无 `type`）。tsx 下两者**各有一份模块图**，于是
 * `orchestrator/search` 的 `export const WEB_SEARCH_SERVER_TOOL = WEB_SEARCH_TOOL_DEFINITION`
 * 指向的是**另一份实例**里的对象 ⇒ 断言「与 toolDef 同对象」变成
 * `Values have same structure but are not reference-equal`。
 * 结构相等、引用不等 = 双实例的指纹（产品代码本身没问题）。
 * ★ 以后往本文件加服务端模块，一律走下面的 `req`。
 */
const req = createRequire(import.meta.url);
const { WEB_SEARCH_TOOL_DEFINITION, WEB_SEARCH_TOOL_NAME } = req('../../apps/server/src/search/toolDef') as typeof import('../../apps/server/src/search/toolDef');
const { WEB_SEARCH_TOOL: CHAT_TOOL } = req('../../apps/server/src/search/chatTool') as typeof import('../../apps/server/src/search/chatTool');
const { WEB_SEARCH_SERVER_TOOL } = req('../../apps/server/src/orchestrator/search') as typeof import('../../apps/server/src/orchestrator/search');
import { SENSITIVE_TARGET_RE } from '../../packages/shared/src/tools';

let fails = 0, passes = 0;
const check = (name: string, fn: () => void) => {
  try { fn(); passes++; console.log(`  PASS ${name}`); }
  catch (e) { fails++; console.log(`  FAIL ${name} — ${(e as Error).message}`); }
};

console.log('=== web_search 单一来源验收 ===');

check('toolDef 存在且 name=web_search', () => {
  assert.equal(WEB_SEARCH_TOOL_DEFINITION.name, 'web_search');
  assert.equal(WEB_SEARCH_TOOL_NAME, 'web_search');
});

check('chatTool.WEB_SEARCH_TOOL 与 toolDef 同源（description 相同）', () => {
  assert.equal((CHAT_TOOL as any).function.name, WEB_SEARCH_TOOL_DEFINITION.name);
  assert.equal((CHAT_TOOL as any).function.description, WEB_SEARCH_TOOL_DEFINITION.description);
});

check('orchestrator/search.WEB_SEARCH_SERVER_TOOL 与 toolDef 同对象', () => {
  assert.equal(WEB_SEARCH_SERVER_TOOL.name, WEB_SEARCH_TOOL_DEFINITION.name);
  assert.equal(WEB_SEARCH_SERVER_TOOL.description, WEB_SEARCH_TOOL_DEFINITION.description);
  assert.equal(WEB_SEARCH_SERVER_TOOL, WEB_SEARCH_TOOL_DEFINITION);
});

check('parameters 有 additionalProperties:false', () => {
  const params = WEB_SEARCH_TOOL_DEFINITION.parameters as any;
  assert.equal(params.additionalProperties, false);
  assert.ok(params.properties.query);
  assert.ok(params.properties.topic);
  assert.ok(params.properties.days);
  assert.ok(params.properties.max_results);
  assert.deepEqual(params.required, ['query']);
});

check('validate 存在且拦截敏感 query', () => {
  const res = WEB_SEARCH_TOOL_DEFINITION.validate({ query: '我的密码是123' } as any, { snapshot: null });
  assert.equal(res.ok, false);
  assert.equal((res as any).reason, 'blocked_sensitive');
});

check('validate 放行正常 query 并规范化', () => {
  const res = WEB_SEARCH_TOOL_DEFINITION.validate({ query: '今天天气', topic: 'news', days: 5, max_results: 10 } as any, { snapshot: null });
  assert.equal(res.ok, true);
  assert.equal((res as any).args.query, '今天天气');
  assert.equal((res as any).args.topic, 'news');
  assert.equal((res as any).args.days, 5);
  assert.equal((res as any).args.max_results, 10);
});

check('SENSITIVE_TARGET_RE 单一来源（与 shared 一致）', () => {
  assert.ok(SENSITIVE_TARGET_RE.test('密码'));
  assert.ok(SENSITIVE_TARGET_RE.test('验证码'));
});

check('description 包含关键红线（点明网站不要搜 / 已打开谎言 / 敏感拦截）', () => {
  const d = WEB_SEARCH_TOOL_DEFINITION.description;
  assert.ok(d.includes('点明了某个具体网站'), '应含网站红线');
  assert.ok(d.includes('已打开'), '应含已打开谎言红线');
  assert.ok(d.includes('敏感信息'), '应含敏感信息红线');
});

check('chatLoop 能从 toolDef 转 OpenAI tool（fallback 路径）', () => {
  const openAITool = {
    type: 'function' as const,
    function: {
      name: WEB_SEARCH_TOOL_DEFINITION.name,
      description: WEB_SEARCH_TOOL_DEFINITION.description,
      parameters: WEB_SEARCH_TOOL_DEFINITION.parameters,
    },
  };
  assert.equal(openAITool.function.name, 'web_search');
  assert.ok(openAITool.function.description.length > 100);
});

console.log(`\n=== 结论 ${passes} PASS / ${fails} FAIL ===`);
if (fails > 0) process.exit(1);
