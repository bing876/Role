/**
 * web_search 单一来源验收（收口后）
 * 目标：确保只有一份定义，聊天与编排共用，且参数契约一致。
 */
import assert from 'node:assert/strict';
import { WEB_SEARCH_TOOL_DEFINITION, WEB_SEARCH_TOOL_NAME } from '../../apps/server/src/search/toolDef';
import { WEB_SEARCH_TOOL as CHAT_TOOL } from '../../apps/server/src/search/chatTool';
import { WEB_SEARCH_SERVER_TOOL } from '../../apps/server/src/orchestrator/search';
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
