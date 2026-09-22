/**
 * 阶段 0 · Tool Registry 新旧对照测试。
 *
 * 要证明的事只有一句：**注册表上线后，线上行为与改前逐项一致**。
 *   ① 发模型的工具表：toOpenAITools 输出与旧 LOOP_TOOLS 字面量 deep-equal；
 *   ② 参数校验：新 sanitize 与 sanitizeToolCallLegacy 在全部用例上输出一致；
 *   ③ 动作映射：服务端 toolToAction / 桌面 toolToAction 新旧一致，
 *      且桌面本地表与 shared 内建定义的 toBrowserAction 逐项等价；
 *   ④ 回滚开关：TOOL_REGISTRY_LEGACY=1 时三处全部走旧逻辑；
 *   ⑤ 服务端直执行分支：注册一个临时 server 工具，证明 advance() 会在
 *      循环内就地执行它（阶段 0 线上无 server 工具，此分支平时走不到）。
 *
 * 运行前提（与 agent-loop-audit-test.mts 同一套）：
 *   npm install                                  # 建 workspace 软链（@ai-workbench/shared）
 *   npm run build -w @ai-workbench/shared        # toolLoop 现在有 shared 的运行时 import，必须先 build
 *   npx tsx scripts/verify/tool-registry-parity.mts
 * 或：npm run verify:tools
 */
import assert from 'node:assert/strict';
import {
  LOOP_TOOLS,
  advance,
  sanitizeToolCall,
  sanitizeToolCallLegacy,
  startLoop,
  toolToAction as serverToolToAction,
  toolToActionLegacy as serverToolToActionLegacy,
  useLegacyToolPath,
} from '../../apps/server/src/toolLoop';
import {
  LOOP_TOOL_NAMES,
  registerServerTool,
  serverToolRegistry,
} from '../../apps/server/src/toolRegistry';
import {
  BROWSER_TOOL_DEFINITIONS,
  BROWSER_TOOL_NAMES,
  createToolRegistry,
  type LoopToolCall,
  type PageSnapshot,
  type ToolDefinition,
} from '../../packages/shared/src/tools';
import { resolveBrowserAction } from '../../apps/desktop/electron/toolExecutors';
import {
  toolToAction as desktopToolToAction,
  toolToActionLegacy as desktopToolToActionLegacy,
} from '../../apps/desktop/electron/agent';
import type { LlmToolCall } from '../../apps/server/src/llm';
import type { ServerEnv } from '../../apps/server/src/env';

let fails = 0;
const log = (...a: string[]) => console.log(a.map(String).join(' '));
const check = (name: string, fn: () => void) => {
  try {
    fn();
    log(`  PASS ${name}`);
  } catch (err) {
    fails += 1;
    log(`  ★FAIL ${name}  —— ${(err as Error)?.message ?? String(err)}`);
  }
};

/** 造一个上游 tool_call（id 必填：新旧逻辑缺 id 时都会拿 Date.now() 补，随机值没法对照） */
const raw = (id: string, name: string, args: string): LlmToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: args },
});

const NULL_SNAP: PageSnapshot | null = null;
const NORMAL_SNAP: PageSnapshot = {
  url: 'https://example.com/',
  title: '示例页',
  buttons: ['搜索'],
  links: [],
  inputs: ['搜索框'],
  texts: [],
  loginLike: false,
};
const SENSITIVE_SNAP: PageSnapshot = {
  ...NORMAL_SNAP,
  inputFields: [
    { label: '[敏感·密码] placeholder=密码', kind: 'sensitive', reason: 'password' },
    { label: '搜索框', kind: 'normal' },
  ],
};
const SNAPS: Array<[string, PageSnapshot | null]> = [
  ['无快照', NULL_SNAP],
  ['普通页', NORMAL_SNAP],
  ['敏感页', SENSITIVE_SNAP],
];

/** sanitize 对照矩阵：[用例名, name, arguments] —— 覆盖每个工具的合法/非法/截断/闸口 */
const SANITIZE_CASES: Array<[string, string, string]> = [
  ['open_url 合法', 'open_url', '{"url":"https://example.com/a?b=1"}'],
  ['open_url 非http', 'open_url', '{"url":"ftp://x/y"}'],
  ['open_url 缺参', 'open_url', '{}'],
  ['open_url 非字符串', 'open_url', '{"url":123}'],
  ['open_url 超长截断', 'open_url', `{"url":"https://x/${'a'.repeat(600)}"}`],
  ['read_page 无参', 'read_page', '{}'],
  ['read_page 多余参数被丢弃', 'read_page', '{"foo":1}'],
  ['click 合法', 'click', '{"target":"百度一下"}'],
  ['click 空target', 'click', '{"target":"  "}'],
  ['click 缺参', 'click', '{}'],
  ['click 支付确认被拦', 'click', '{"target":"立即支付"}'],
  ['click 支付英文被拦', 'click', '{"target":"Place Order"}'],
  ['click 超长截断', 'click', `{"target":"${'按'.repeat(200)}"}`],
  ['type 合法+提交', 'type', '{"target":"搜索框","text":"天气","submit":true}'],
  ['type 合法不提交', 'type', '{"target":"搜索框","text":"天气"}'],
  ['type 缺text', 'type', '{"target":"搜索框"}'],
  ['type 空text', 'type', '{"target":"搜索框","text":""}'],
  ['type 缺target', 'type', '{"text":"天气"}'],
  ['type text超长截断(只截断不清空格)', 'type', `{"target":"搜索框","text":"  ${'字'.repeat(600)}"}`],
  ['type 纯文本敏感(密码)', 'type', '{"target":"密码","text":"x"}'],
  ['type 纯文本敏感(验证码)', 'type', '{"target":"请输入短信验证码","text":"x"}'],
  ['type 快照敏感(密码框)', 'type', '{"target":"密码","text":"x"}'],
  ['type 快照普通框放行', 'type', '{"target":"搜索框","text":"天气"}'],
  ['type submit非布尔按真值', 'type', '{"target":"搜索框","text":"a","submit":"yes"}'],
  ['scroll down', 'scroll', '{"direction":"down"}'],
  ['scroll up', 'scroll', '{"direction":"up"}'],
  ['scroll 缺参默认down', 'scroll', '{}'],
  ['scroll 非法值默认down', 'scroll', '{"direction":"left"}'],
  ['scroll 非字符串默认down', 'scroll', '{"direction":1}'],
  ['stop done', 'stop', '{"reason":"done","summary":"ok","document_title":"T","document_outline":["a","b"]}'],
  ['stop need_user', 'stop', '{"reason":"need_user","question":"请登录"}'],
  ['stop blocked', 'stop', '{"reason":"blocked","question":"没入口"}'],
  ['stop 缺reason默认done', 'stop', '{}'],
  ['stop reason超长截断', 'stop', `{"reason":"${'r'.repeat(50)}"}`],
  ['stop outline超12条截断', 'stop', `{"reason":"done","document_outline":[${Array.from({ length: 13 }, (_, i) => `"t${i}"`).join(',')}]}`],
  ['stop outline单条超120截断', 'stop', `{"reason":"done","document_outline":["${'x'.repeat(200)}"]}`],
  ['stop outline非数组变空', 'stop', '{"reason":"done","document_outline":"abc"}'],
  ['未知工具', 'rm_rf', '{}'],
  ['空工具名', '', '{}'],
  ['非法JSON', 'click', '{oops'],
  ['JSON数组按缺参处理', 'open_url', '[]'],
  ['JSON字符串按缺参处理', 'open_url', '"x"'],
];

const EXPECTED_TOOL_NAMES = ['open_url', 'read_page', 'click', 'type', 'scroll', 'stop'];

// ---------------------------------------------------------------------------
log('');
log('=== ① 发模型的工具表：注册表输出与旧字面量 deep-equal ===');
// ---------------------------------------------------------------------------
check('BROWSER_TOOL_NAMES 顺序与旧表一致', () => {
  assert.deepEqual(BROWSER_TOOL_NAMES, EXPECTED_TOOL_NAMES);
  assert.deepEqual(LOOP_TOOL_NAMES, EXPECTED_TOOL_NAMES);
});
check('toOpenAITools(LOOP_TOOL_NAMES) deep-equal LOOP_TOOLS', () => {
  assert.deepEqual(serverToolRegistry.toOpenAITools(LOOP_TOOL_NAMES), LOOP_TOOLS);
});
check('toOpenAITools 返回的是深拷贝（改返回体不污染注册表）', () => {
  const first = serverToolRegistry.toOpenAITools(LOOP_TOOL_NAMES);
  (first[0].function.parameters as { required?: string[] }).required = ['HACK'];
  assert.deepEqual(serverToolRegistry.toOpenAITools(LOOP_TOOL_NAMES), LOOP_TOOLS);
});

// ---------------------------------------------------------------------------
log('');
log('=== ② 注册表契约（重名抛错 / 未知抛错 / 查表语义）===');
// ---------------------------------------------------------------------------
check('重复注册同名工具抛错（不静默覆盖）', () => {
  const r = createToolRegistry();
  r.register(BROWSER_TOOL_DEFINITIONS[0]);
  assert.throws(() => r.register(BROWSER_TOOL_DEFINITIONS[0]), /已注册/);
});
check('空名注册抛错', () => {
  const r = createToolRegistry();
  assert.throws(() => r.register({ ...(BROWSER_TOOL_DEFINITIONS[0]), name: '' }), /不能为空/);
});
check('get 未知工具返回 undefined（不抛错）', () => {
  assert.equal(createToolRegistry().get('nope'), undefined);
});
check('toOpenAITools 遇到未注册名抛错（不静默跳过）', () => {
  assert.throws(() => createToolRegistry().toOpenAITools(['open_url']), /未注册/);
});
check('list(names) 按请求顺序过滤', () => {
  const r = createToolRegistry();
  for (const d of BROWSER_TOOL_DEFINITIONS) r.register(d);
  assert.deepEqual(
    r.list(['stop', 'open_url']).map((d) => d.name),
    ['stop', 'open_url'],
  );
});
check('registerServerTool 拒绝 side!=server 的工具（防劫持浏览器工具）', () => {
  assert.throws(
    () => registerServerTool(BROWSER_TOOL_DEFINITIONS[0], { execute: async () => ({ ok: true }) }),
    /只接受 side='server'/,
  );
});
check('stop 是 control 类且没有 toBrowserAction（永不映射成动作）', () => {
  const stop = serverToolRegistry.get('stop');
  assert.equal(stop?.kind, 'control');
  assert.equal(stop?.toBrowserAction, undefined);
});

// ---------------------------------------------------------------------------
log('');
log('=== ③ sanitize 新旧对照（矩阵 × 3 种快照）===');
// ---------------------------------------------------------------------------
let compared = 0;
for (const [snapName, snap] of SNAPS) {
  for (const [caseName, name, args] of SANITIZE_CASES) {
    compared += 1;
    check(`[${snapName}] ${caseName}`, () => {
      const r = raw(`c_${compared}`, name, args);
      assert.deepEqual(sanitizeToolCall(r, snap), sanitizeToolCallLegacy(r, snap));
    });
  }
}
check('对照用例总数符合预期（防矩阵被悄悄删空）', () => {
  assert.equal(compared, SNAPS.length * SANITIZE_CASES.length);
  assert.ok(compared >= 100, `用例太少：${compared}`);
});
// 几个关键语义钉死（不只对照旧逻辑，还断言业务含义，防止新旧一起错）：
check('支付确认话术钉死', () => {
  const o = sanitizeToolCall(raw('e1', 'click', '{"target":"确认支付"}'), NULL_SNAP);
  assert.equal(o.ok, false);
  if (!o.ok) {
    assert.equal(o.reason, 'payment_confirm');
    assert.ok(o.question.includes('必须由你自己点'));
  }
});
check('快照敏感字段话术钉死（含快照里的框名）', () => {
  const o = sanitizeToolCall(raw('e2', 'type', '{"target":"密码","text":"1"}'), SENSITIVE_SNAP);
  assert.equal(o.ok, false);
  if (!o.ok) {
    assert.equal(o.reason, 'sensitive_field');
    assert.ok(o.question.includes('[敏感·密码]'));
    assert.ok(o.question.includes('我不代填'));
  }
});
check('非法 JSON 话术钉死', () => {
  const o = sanitizeToolCall(raw('e3', 'click', '{oops'), NULL_SNAP);
  assert.equal(o.ok, false);
  if (!o.ok) assert.equal(o.reason, 'bad_args');
});
check('未知工具话术钉死（含工具名）', () => {
  const o = sanitizeToolCall(raw('e4', 'rm_rf', '{}'), NULL_SNAP);
  assert.equal(o.ok, false);
  if (!o.ok) {
    assert.equal(o.reason, 'bad_action');
    assert.ok(o.question.includes('rm_rf'));
  }
});
check('stop 缺 reason 默认 done', () => {
  const o = sanitizeToolCall(raw('e5', 'stop', '{}'), NULL_SNAP);
  assert.equal(o.ok, true);
  if (o.ok) assert.equal(o.call.args.reason, 'done');
});

// ---------------------------------------------------------------------------
log('');
log('=== ④ 动作映射对照（服务端新旧 / 桌面新旧 / 桌面≡shared）===');
// ---------------------------------------------------------------------------
const ACTION_CASES: LoopToolCall[] = [
  { id: 'a1', name: 'open_url', args: { url: 'https://x.com/' } },
  { id: 'a2', name: 'open_url', args: {} },
  { id: 'a3', name: 'read_page', args: {} },
  { id: 'a4', name: 'click', args: { target: '确定' } },
  { id: 'a5', name: 'click', args: {} },
  { id: 'a6', name: 'type', args: { target: '搜索框', text: 'hi', submit: true } },
  { id: 'a7', name: 'type', args: { target: '搜索框', text: 'hi' } },
  { id: 'a8', name: 'scroll', args: { direction: 'up' } },
  { id: 'a9', name: 'scroll', args: {} },
  { id: 'a10', name: 'stop', args: { reason: 'done' } },
  { id: 'a11', name: 'whatever_new_tool', args: {} },
];
for (const c of ACTION_CASES) {
  check(`服务端 toolToAction ≡ legacy [${c.name}]`, () => {
    assert.deepEqual(serverToolToAction(c), serverToolToActionLegacy(c));
  });
  check(`桌面 toolToAction ≡ legacy [${c.name}]`, () => {
    assert.deepEqual(desktopToolToAction(c), desktopToolToActionLegacy(c));
  });
}
check('服务端 stop/未知工具默认 read_page（与旧 default 分支一致）', () => {
  assert.deepEqual(serverToolToAction({ id: 'x', name: 'stop', args: {} }), { action: 'read_page' });
  assert.deepEqual(serverToolToAction({ id: 'x', name: 'nope', args: {} }), { action: 'read_page' });
});
check('桌面 stop/未知工具返回 null = 不执行（与旧 default 分支一致）', () => {
  assert.equal(desktopToolToAction({ id: 'x', name: 'stop', args: {} }), null);
  assert.equal(desktopToolToAction({ id: 'x', name: 'nope', args: {} }), null);
});
check('新逻辑 args 缺失时不抛错（旧 switch 会抛，防御性改进）', () => {
  const bad = { id: 'x', name: 'click' } as unknown as LoopToolCall;
  assert.deepEqual(serverToolToAction(bad), { action: 'click', target: '' });
  assert.deepEqual(desktopToolToAction(bad), { action: 'click', target: '' });
  assert.throws(() => serverToolToActionLegacy(bad));
  assert.throws(() => desktopToolToActionLegacy(bad));
});
// 桌面本地表 ≡ shared 内建定义的 toBrowserAction（P2-7 重复映射的闭环证明）：
for (const def of BROWSER_TOOL_DEFINITIONS) {
  if (def.kind !== 'action' || !def.toBrowserAction) continue;
  for (const c of ACTION_CASES.filter((a) => a.name === def.name)) {
    check(`桌面表 ≡ shared 定义 [${def.name} ← ${JSON.stringify(c.args)}]`, () => {
      const viaDesktop = resolveBrowserAction(c);
      const viaShared = def.toBrowserAction!(c.args);
      assert.deepEqual(viaDesktop, viaShared);
    });
  }
}

// ---------------------------------------------------------------------------
log('');
log('=== ⑤ 回滚开关 TOOL_REGISTRY_LEGACY=1 时三处走旧逻辑 ===');
// ---------------------------------------------------------------------------
check('开关打开：sanitize/toolToAction 结果与 legacy 一致', () => {
  process.env.TOOL_REGISTRY_LEGACY = '1';
  try {
    assert.equal(useLegacyToolPath(), true);
    const r = raw('leg1', 'click', '{"target":"立即支付"}');
    assert.deepEqual(sanitizeToolCall(r, NULL_SNAP), sanitizeToolCallLegacy(r, NULL_SNAP));
    const c: LoopToolCall = { id: 'leg2', name: 'type', args: { target: '框', text: 't', submit: true } };
    assert.deepEqual(serverToolToAction(c), serverToolToActionLegacy(c));
    assert.deepEqual(desktopToolToAction(c), desktopToolToActionLegacy(c));
  } finally {
    delete process.env.TOOL_REGISTRY_LEGACY;
  }
  assert.equal(useLegacyToolPath(), false);
});

// ---------------------------------------------------------------------------
log('');
log('=== ⑥ 服务端直执行分支（注册临时 server 工具 + stub 上游）===');
// ---------------------------------------------------------------------------
const echoDef: ToolDefinition = {
  name: 'parity_echo',
  description: '对照测试专用：服务端回声工具（跑完即弃，不进工具表名单）',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  side: 'server',
  kind: 'action',
  timeoutMs: 5000,
  validate: (args) => ({ ok: true, args: { text: String(args.text ?? '') } }),
};
const execCalls: Array<{ args: Record<string, unknown>; loopId: string }> = [];
check('注册临时 server 工具成功', () => {
  registerServerTool(echoDef, {
    execute: async (args, ctx) => {
      execCalls.push({ args, loopId: ctx.loopId });
      return { ok: true, detail: `echo:${String(args.text ?? '')}` };
    },
  });
  // 注册后仍不在发模型的名单里（名单是常量，不会被身边注册污染）
  assert.deepEqual(LOOP_TOOL_NAMES, EXPECTED_TOOL_NAMES);
});

const scriptedReplies = [
  [{ id: 'call_e1', type: 'function', function: { name: 'parity_echo', arguments: '{"text":"hi"}' } }],
  [{ id: 'call_r1', type: 'function', function: { name: 'read_page', arguments: '{}' } }],
];
const realFetch = globalThis.fetch;
let fetchCalls = 0;
(globalThis as { fetch: typeof fetch }).fetch = (async () => {
  const calls = scriptedReplies[Math.min(fetchCalls, scriptedReplies.length - 1)];
  fetchCalls += 1;
  return new Response(
    JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: calls }, finish_reason: 'tool_calls' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}) as typeof fetch;

try {
  const env = {
    deepseekApiKey: 'parity-test-key',
    deepseekBaseUrl: 'http://127.0.0.1:9/',
    deepseekModel: 'parity',
    agentLoopMaxSteps: 0,
  } as unknown as ServerEnv;
  const session = startLoop(env, {
    userId: 1,
    agentId: 1,
    conversationId: null,
    wcId: 99173,
    goal: 'parity e2e',
    pageUrl: 'https://example.com/',
  });
  const decision = await advance(env, session);
  check('server 工具在循环内被执行了一次（桌面无感知）', () => {
    assert.equal(execCalls.length, 1);
    assert.deepEqual(execCalls[0].args, { text: 'hi' });
    assert.equal(execCalls[0].loopId, session.id);
  });
  check('server 工具回执已 append 进历史（assistant+tool 成对）', () => {
    const toolMsgs = session.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 1);
    assert.equal(toolMsgs[0].tool_call_id, 'call_e1');
    assert.ok(String(toolMsgs[0].content).includes('echo:hi'));
    const asstEcho = session.messages.find(
      (m) => m.role === 'assistant' && (m.tool_calls ?? []).some((c) => c.id === 'call_e1'),
    );
    assert.ok(asstEcho, '缺 assistant(parity_echo) 消息');
  });
  check('内循环继续问模型后，返回的是下一格桌面工具', () => {
    assert.equal(fetchCalls, 2);
    assert.equal(decision.kind, 'tool');
    if (decision.kind === 'tool') {
      assert.equal(decision.call.name, 'read_page');
      assert.equal(decision.call.id, 'call_r1');
    }
    assert.equal(session.step, 1); // server 执行记一步（与桌面回执记一步同口径）
    assert.equal(session.pendingCallId, 'call_r1');
    assert.deepEqual(session.usedTools, ['parity_echo', 'read_page']);
  });
} catch (err) {
  fails += 1;
  log(`  ★FAIL §⑥ 执行异常  —— ${(err as Error)?.message ?? String(err)}`);
} finally {
  globalThis.fetch = realFetch;
}

// ---------------------------------------------------------------------------
log('');
log('=== 结论 ===');
log(`  失败项：${fails}`);
log('  ①工具表 ②注册表契约 ③校验 ④映射 ⑤回滚开关 ⑥服务端直执行 —— 全绿才算阶段 0 可合。');
process.exit(fails > 0 ? 1 : 0);
