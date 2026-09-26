/**
 * 输出纪律 + 占位符清扫（2026-09-25）· 永久验收
 *
 * 用户标准（GrokBot）：简洁、先结论、没事不说话；各类输出（聊天回复/协同卡/提示/回话）
 * 零占位符残留；过程信息进折叠卡不进正文；同一轮不连发多张同类卡。
 *
 * 全部走**真实生产代码路径**：
 *   · 聊天回复 = buildApp 起的真 Fastify 实例 + app.inject() 打 /chat/stream（SSE）
 *   · 协同卡   = routeTask/logRouteDecision/triggerRoutine/executeDelegate 真函数 + 真 pglite 库
 *   · LLM      = 桩 fetch（拦截真实网络调用；同时**捕获请求体**用来验系统提示词）
 *
 * 用法：npx tsx scripts/verify/output-hygiene.mts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
/**
 * ★★★ 服务端模块必须用 `require`（CJS 图）载入，**不能**用 `import`（2026-09-26 修）
 * ---------------------------------------------------------------------------
 * 本文件是 `.mts`（ESM），而 `apps/server` 是 **CommonJS**（tsconfig `module: CommonJS`
 * + package.json 无 `type`）。tsx 下两者**各有一份模块图** ⇒ 测试 `import` 到的
 * `orchestrator/tools` 与生产代码内部 `require` 到的**不是同一个实例**。
 *
 * 症状（实测）：本文件 line ~177 调 `initOrchestrator(...)` 写的是实例 A 的 `deps`，
 * 而 `executeDelegate` / `collabChat` 读的是实例 B ⇒ 报
 * `[orc] 编排器还没初始化（initOrchestrator 要在启动时调一次）`，
 * A-5 / C-2 两条断言红，而其余 8 条绿（那几条不经过 tools.ts 的 deps）。
 * 产品代码没问题，是测试拿错了实例。
 *
 * ★ 以后往本文件加服务端模块，一律走下面的 `req`，别退回 `import`。
 */
import type { ServerEnv } from '../../apps/server/src/env';
import type { RoutineRow } from '../../apps/server/src/orchestrator/routines';
import type { LoopSession } from '../../apps/server/src/toolLoop';
import type { ServerExecutionContext } from '../../apps/server/src/toolRegistry';

const req = createRequire(import.meta.url);
const { loadEnv } = req('../../apps/server/src/env') as typeof import('../../apps/server/src/env');
const { makeCipher, signToken } = req('../../apps/server/src/crypto') as typeof import('../../apps/server/src/crypto');
const { makePool, migrate } = req('../../apps/server/src/db') as typeof import('../../apps/server/src/db');
const { buildApp } = req('../../apps/server/src/index') as typeof import('../../apps/server/src/index');
const { initOrchestrator } = req('../../apps/server/src/orchestrator/tools') as typeof import('../../apps/server/src/orchestrator/tools');
const { executeDelegate } = req('../../apps/server/src/orchestrator/delegation') as typeof import('../../apps/server/src/orchestrator/delegation');
const { resetRegistryForTest, initRegistry, markAgentBusy } = req(
  '../../apps/server/src/orchestrator/registry',
) as typeof import('../../apps/server/src/orchestrator/registry');
const { routeTask, logRouteDecision } = req('../../apps/server/src/orchestrator/chiefOfStaff') as typeof import('../../apps/server/src/orchestrator/chiefOfStaff');
const { triggerRoutine } = req('../../apps/server/src/orchestrator/routines') as typeof import('../../apps/server/src/orchestrator/routines');
const { __resetProgressCardCacheForTest, writeProgressToAgentChat } = req(
  '../../apps/server/src/orchestrator/collabChat',
) as typeof import('../../apps/server/src/orchestrator/collabChat');
const { startLoop } = req('../../apps/server/src/toolLoop') as typeof import('../../apps/server/src/toolLoop');

let passes = 0;
let fails = 0;
const log = (...a: unknown[]) => console.log(a.map(String).join(' '));
const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try {
    await fn();
    passes += 1;
    log(`  ✓ ${name}`);
  } catch (err) {
    fails += 1;
    log(`  ✗ ${name}`);
    log(`      ${(err as Error)?.message ?? String(err)}`);
  }
};

// loadEnv 的必填项（verify 环境没有 .env）；LLM 基址指向 llm.test 以便桩 fetch 拦截
process.env.DATABASE_URL ??= 'pglite://memory';
process.env.JWT_SECRET ??= 'verify-output-hygiene-jwt-secret';
process.env.DATA_KEY ??= 'a'.repeat(64);
process.env.PHONE_PEPPER ??= 'verify-output-hygiene-pepper';
process.env.DEEPSEEK_API_KEY ??= 'test-key';
process.env.DEEPSEEK_BASE_URL ??= 'https://llm.test/v1';
process.env.DEEPSEEK_MODEL ??= 'test-model';
const ENV: ServerEnv = loadEnv();

// ---------------------------------------------------------------- 桩 LLM
interface CapturedLlm {
  url: string;
  messages: Array<{ role: string; content: unknown }>;
  stream: boolean;
}
const captured: CapturedLlm[] = [];
/** 按调用顺序喂的响应；队列空了 → 默认「干净的短回复」 */
const queue: Response[] = [];

const sseOk = (text: string): Response =>
  new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
const jsonTool = (name: string, args: Record<string, unknown>): Response =>
  new Response(
    JSON.stringify({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: `call_${Math.random().toString(36).slice(2, 10)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
const jsonContent = (content: string): Response =>
  new Response(
    JSON.stringify({ id: 't', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

(function installStub(): void {
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    let body: any = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      /* 非 JSON 请求体 */
    }
    const isLlm = url.startsWith('https://llm.test');
    if (isLlm && body?.messages) captured.push({ url, messages: body.messages, stream: Boolean(body.stream) });
    if (isLlm) {
      const next = queue.shift();
      if (next) return next;
      return body?.stream ? sseOk('办完了，没发现问题。') : jsonContent(JSON.stringify({ items: [] }));
    }
    // 非 LLM（tavily 等）：给个空壳，工具按「没查到」走
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
})();

// ---------------------------------------------------------------- 占位符扫描
const PLACEHOLDER_PATTERNS: Array<[string, RegExp]> = [
  ['mustache {{}}', /\{\{|\}\}/],
  ['未插值 ${', /\$\{/],
  ['undefined', /\bundefined\b/],
  ['裸 null', /\bnull\b/],
  ['NaN', /\bNaN\b/],
  ['嵌套协同模板', /【协同·[^】]*】[^【]*【协同·/],
  ['空【】', /【\s*】/],
  ['「占位」字样', /占位/],
  ['空数组字面 []', /\[\s*\]/],
  ['裸 #id 当名字', /【协同·[^】]*】#\d+/],
  ['内部工具名外泄', /：stop\b|\bopen_url\b|\bweb_search\b|_fallback\b|_match\b|\bkeyword_weighted\b/],
];
function placeholderHits(text: string): string[] {
  const hits: string[] = [];
  for (const [label, re] of PLACEHOLDER_PATTERNS) if (re.test(text)) hits.push(label);
  return hits;
}
function assertNoPlaceholder(label: string, text: string): void {
  const hits = placeholderHits(text);
  assert.equal(hits.length, 0, `「${label}」有占位符残留 ${hits.join('/')}：${text.slice(0, 120)}`);
}

// ---------------------------------------------------------------- 数据
const CIPHER = makeCipher(ENV.dataKey);

async function seed(pool: { query: (sql: string, p?: unknown[]) => Promise<{ rows: any[] }> }): Promise<void> {
  await pool.query(`INSERT INTO users (id, xyz_id, phone_hash) VALUES (1, 'x1', 'h1') ON CONFLICT (id) DO NOTHING`);
  await pool.query(`INSERT INTO projects (id, user_id, name, is_default) VALUES (10, 1, '项目甲', true) ON CONFLICT (id) DO NOTHING`);
  await pool.query(
    `INSERT INTO agents (id, project_id, name, kind, persona) VALUES
       (101, 10, '小助', 'assistant', '{"name":"小助","who":"贴身助手","tone":"利落","duty":"日常事务"}'),
       (102, 10, '母鸡', 'hen', '{"name":"母鸡","who":"项目总管","tone":"稳重","duty":"统筹与研究"}'),
       (103, 10, '研究员', 'custom', '{"name":"研究员","who":"资料员","tone":"严谨","duty":"查资料写要点"}')
     ON CONFLICT (id) DO NOTHING`,
  );
  // 三个智能体各有一个主会话（协同卡有地方落）
  for (const agentId of [101, 102, 103]) {
    await pool.query(`INSERT INTO conversations (id, project_id, agent_id, title) VALUES ($1, 10, $1, '主会话')`, [agentId]);
  }
}

async function cardTexts(pool: { query: (sql: string, p?: unknown[]) => Promise<{ rows: any[] }> }, agentId: number): Promise<string[]> {
  const conv = await pool.query<{ id: string }>('SELECT id FROM conversations WHERE agent_id=$1 ORDER BY id DESC LIMIT 1', [agentId]);
  if (conv.rows.length === 0) return [];
  const rows = await pool.query<{ content_enc: string }>(
    'SELECT content_enc FROM messages WHERE conversation_id=$1 ORDER BY id ASC',
    [conv.rows[0].id],
  );
  return rows.rows.map((r) => CIPHER.decryptText(r.content_enc));
}

async function main(): Promise<void> {
  log('=== 输出纪律 + 占位符清扫 · 验收（真实路由/真实函数/真实库，LLM 用桩） ===');
  process.env.HANDOFF_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'output-hygiene-handoffs-'));

  const pool = makePool('pglite://memory');
  await migrate(pool);
  await seed(pool);
  const app = await buildApp(ENV, pool, CIPHER);
  // 委派/路由走编排器：必须先初始化（executeDelegate 里 orchestratorDeps() 会检查）
  initOrchestrator({ pool, env: ENV, cipher: CIPHER });
  const token = signToken({ sub: 1, xyz: 'x1' }, ENV.jwtSecret);
  const H = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

  // delta 帧是裸 `data: {"delta":"…"}`（没有 event 行）—— 逐行解析取 delta 字段
  const sseText = (raw: string): string =>
    [...raw.matchAll(/^data: (\{.*\})\s*$/gm)]
      .map((m) => {
        try {
          return (JSON.parse(m[1]) as { delta?: string }).delta ?? '';
        } catch {
          return '';
        }
      })
      .join('');

  // ================================================================ A 占位符零残留
  log('');
  log('--- A 各类输出零占位符（user-visible 断言）---');

  const allUserVisible: Array<{ label: string; text: string }> = [];

  await check('A-1 聊天回复（/chat/stream 真路由 + SSE）零占位符', async () => {
    const res = await app.inject({ method: 'POST', url: '/chat/stream', headers: H, payload: JSON.stringify({ agentId: 101, message: '检查今天服务器状态' }) });
    assert.equal(res.statusCode, 200, `HTTP ${res.statusCode}: ${res.body.slice(0, 200)}`);
    const reply = sseText(res.body);
    assert.ok(reply.length > 0, '没收到任何回复正文');
    allUserVisible.push({ label: 'A-1 聊天回复', text: reply });
    assertNoPlaceholder('聊天回复', reply);
  });

  await check('A-2 错误回话（400/401）零占位符', async () => {
    const bad = await app.inject({ method: 'POST', url: '/chat/stream', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: '{坏' });
    assert.equal(bad.statusCode, 400, `坏 JSON 应 400，实际 ${bad.statusCode}`);
    const badMsg = (bad.json() as { error?: string }).error ?? '';
    allUserVisible.push({ label: 'A-2 错误回话(坏JSON)', text: badMsg });

    const empty = await app.inject({ method: 'POST', url: '/chat/stream', headers: H, payload: JSON.stringify({ agentId: 101, message: '  ' }) });
    assert.equal(empty.statusCode, 400);
    const emptyMsg = (empty.json() as { error?: string }).error ?? '';
    allUserVisible.push({ label: 'A-2 错误回话(空消息)', text: emptyMsg });

    const anon = await app.inject({ method: 'POST', url: '/chat/stream', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ agentId: 101, message: 'hi' }) });
    assert.equal(anon.statusCode, 401);
    allUserVisible.push({ label: 'A-2 错误回话(未登录)', text: (anon.json() as { error?: string }).error ?? '' });

    for (const { label, text } of allUserVisible.filter((x) => x.label.startsWith('A-2'))) assertNoPlaceholder(label, text);
  });

  await check('A-3 路由卡（routeTask+logRouteDecision 真函数）单层前缀、零占位符', async () => {
    const decision = await routeTask(pool, 1, 10, '把这三家竞品的定价各查一遍', { explicitAgentId: null, currentAgentId: null });
    assert.ok(decision, 'routeTask 没给出路由决定（种子数据应有空闲智能体）');
    await logRouteDecision(pool, CIPHER, decision, '把这三家竞品的定价各查一遍', '管家路由');
    const cards = (await cardTexts(pool, decision.toAgentId)).filter((t) => t.startsWith('【协同·路由】'));
    assert.equal(cards.length, 1, `路由卡应有 1 张，实际 ${cards.length}`);
    allUserVisible.push({ label: 'A-3 路由卡', text: cards[0] });
    assert.equal(placeholderHits(cards[0]).filter((h) => h === '嵌套协同模板').length, 0, `嵌套模板：${cards[0]}`);
    assert.ok(!cards[0].slice('【协同·路由】'.length).includes('【协同·'), `正文里还套着模板：${cards[0]}`);
    assert.ok(cards[0].includes(decision.toAgentName), '路由卡里应有被路由到的智能体名字');
  });

  const routine: RoutineRow = {
    id: '701',
    user_id: '1',
    project_id: '10',
    agent_id: '103',
    name: '早间巡检',
    description: '验收用的例行任务',
    trigger_type: 'interval',
    trigger_config: { minutes: 5 },
    task_template: '检查服务器状态并汇报',
    enabled: true,
    last_run_at: null,
    next_run_at: null,
  } as RoutineRow;

  await check('A-4 例行卡（triggerRoutine 真函数）单层前缀、带 ID、零占位符', async () => {
    const before = (await cardTexts(pool, 103)).length;
    await triggerRoutine(pool, CIPHER, routine);
    const cards = (await cardTexts(pool, 103)).slice(before);
    assert.equal(cards.length, 1, `一次触发应只出 1 张例行卡，实际 ${cards.length}（旧实现双写两张）`);
    allUserVisible.push({ label: 'A-4 例行卡', text: cards[0] });
    assert.ok(cards[0].startsWith('【协同·例行】'), `例行卡前缀不对：${cards[0]}`);
    assert.ok(!cards[0].slice('【协同·例行】'.length).includes('【协同·'), `正文里还套着模板：${cards[0]}`);
    assert.ok(cards[0].includes('（ID:701）'), `例行卡应带 Routine ID：${cards[0]}`);
  });

  await check('A-5 委派被拒卡用真名字（不是 #id）', async () => {
    resetRegistryForTest();
    initRegistry(ENV.orch);
    markAgentBusy(102); // 母鸡正忙
    const s: LoopSession = startLoop(ENV, { userId: 1, agentId: 101, conversationId: null, wcId: null, goal: '测试委派' });
    const ctx: ServerExecutionContext = { loopId: s.id, userId: 1, agentId: 101, wcId: null, conversationId: null, snapshot: null, chain: [101] };
    const before = (await cardTexts(pool, 101)).length;
    const r = await executeDelegate({ to: '母鸡', task: '查一下三家竞品的定价' }, ctx);
    assert.equal(r.ok, false, '母鸡正忙，委派应被拒');
    const cards = (await cardTexts(pool, 101)).slice(before);
    assert.equal(cards.length, 1, `被拒应只留 1 张卡，实际 ${cards.length}`);
    allUserVisible.push({ label: 'A-5 被拒卡', text: cards[0] });
    assert.ok(cards[0].includes('小助'), `被拒卡应有发起方真名字，实际：${cards[0]}`);
    assert.ok(!/#101/.test(cards[0]), `裸 #id 残留：${cards[0]}`);
  });

  // ================================================================ B 输出纪律进系统提示
  log('');
  log('--- B 输出纪律（先结论/过程进卡/一次只报该报的/没事不说话）进了真实发出去的 system prompt ---');

  await check('B-1 /chat/stream 真发出去的 system prompt 含四条纪律', async () => {
    const req = captured.find((c) => c.stream);
    assert.ok(req, '没捕获到流式 LLM 请求（聊天回复那一路）');
    const system = (req.messages.find((m) => m.role === 'system')?.content as string) ?? '';
    assert.ok(system.length > 200, 'system prompt 可疑地短');
    for (const rule of ['先结论', '过程信息不进正文', '一次只报该报的', '没事不说话']) {
      assert.ok(system.includes(rule), `system prompt 缺纪律「${rule}」`);
    }
  });

  // ================================================================ C 卡片收敛
  log('');
  log('--- C 卡片收敛（同轮不连发同类卡）---');

  await check('C-1 例行触发两次 → 恰好两张卡（每次一张，不双写）', async () => {
    await triggerRoutine(pool, CIPHER, routine);
    const cards = (await cardTexts(pool, 103)).filter((t) => t.startsWith('【协同·例行】'));
    assert.equal(cards.length, 2, `两次触发应恰好 2 张例行卡，实际 ${cards.length}`);
  });

  await check('C-2 一次委派 3 步（2 次搜索 + 收尾）→ 进展卡只留 1 张，且不含「：stop」', async () => {
    resetRegistryForTest();
    initRegistry(ENV.orch);
    __resetProgressCardCacheForTest();
    // 子循环的 LLM 序列：web_search → web_search → stop(done)
    queue.push(jsonTool('web_search', { query: '竞品 A 定价' }), jsonTool('web_search', { query: '竞品 B 定价' }), jsonTool('stop', { reason: 'done', summary: '查完了：A 99 元、B 129 元。', document_outline: ['A 99 元', 'B 129 元'] }));
    const s: LoopSession = startLoop(ENV, { userId: 1, agentId: 101, conversationId: null, wcId: null, goal: '查竞品定价' });
    const ctx: ServerExecutionContext = { loopId: s.id, userId: 1, agentId: 101, wcId: null, conversationId: null, snapshot: null, chain: [101] };
    const before = (await cardTexts(pool, 101)).length;
    const r = await executeDelegate({ to: '研究员', task: '查一下竞品 A 和 B 的定价' }, ctx);
    assert.equal(r.ok, true, `委派应成功：${r.error} / ${r.detail}`);
    // 等子循环收尾（后台跑，桩 LLM 很快）
    const t0 = Date.now();
    let status = 'running';
    while (Date.now() - t0 < 30_000) {
      const d = await pool.query<{ status: string }>('SELECT status FROM agent_delegations ORDER BY id DESC LIMIT 1');
      status = d.rows[0]?.status ?? 'missing';
      if (status !== 'running') break;
      await new Promise((res) => setTimeout(res, 200));
    }
    assert.notEqual(status, 'running', `委派 30s 没收尾（status=${status}）`);
    // 进展/交回卡是 fire-and-forget 写入：状态翻转后给它们一点落地时间再数（防竞态假绿）
    await new Promise((res) => setTimeout(res, 800));
    const cards = (await cardTexts(pool, 101)).slice(before);
    const progress = cards.filter((t) => t.startsWith('【协同·进展】'));
    assert.equal(progress.length, 1, `真实委派流程进展卡应为 1 张，实际 ${progress.length}：\n${progress.join('\n')}`);
    allUserVisible.push({ label: 'C-2 进展卡', text: progress[0] });
    assert.ok(!progress[0].includes('：stop'), `进展卡里漏了内部工具名：${progress[0]}`);
    assert.ok(progress[0].includes('查了公开资料'), `进展卡内容应是人话：${progress[0]}`);
    const reply = cards.filter((t) => t.startsWith('【协同·交回】'));
    assert.equal(reply.length, 1, `交回卡应 1 张，实际 ${reply.length}`);
  });

  await check('C-3 进展卡合并机制（单元级）：同一委派连写 3 次 → 库里只 1 行，且是最后一次的内容', async () => {
    __resetProgressCardCacheForTest();
    // 用 102 的会话（母鸡）做合并目标，delegationId=999 同一委派
    for (const txt of ['第 1 步：查了公开资料', '第 2 步：又查了公开资料', '第 3 步：快查完了']) {
      await writeProgressToAgentChat(pool, CIPHER, 102, {
        kind: 'progress',
        fromId: 103,
        fromName: '研究员',
        toId: 102,
        toName: '母鸡',
        detail: txt,
        delegationId: 999,
      });
    }
    const cards = (await cardTexts(pool, 102)).filter((t) => t.startsWith('【协同·进展】') && t.includes('（ID:999）'));
    assert.equal(cards.length, 1, `同一委派连写 3 次进展，库里应只 1 行（新进展覆盖旧卡），实际 ${cards.length}：\n${cards.join('\n')}`);
    assert.ok(cards[0].includes('快查完了'), `合并后内容应是最后一次进展，实际：${cards[0]}`);
    assert.ok(!cards[0].includes('第 1 步'), `旧进展内容不该残留：${cards[0]}`);
    // 不同委派 → 各自的卡（合并只发生在同一委派内）
    await writeProgressToAgentChat(pool, CIPHER, 102, { kind: 'progress', fromId: 103, fromName: '研究员', toId: 102, toName: '母鸡', detail: '另一单的进展', delegationId: 998 });
    const both = (await cardTexts(pool, 102)).filter((t) => t.startsWith('【协同·进展】') && (t.includes('（ID:999）') || t.includes('（ID:998）')));
    assert.equal(both.length, 2, `两个不同委派的进展卡应各 1 张，实际 ${both.length}`);
  });

  // ================================================================ 总扫描
  log('');
  log('--- 总扫描：本验收捕获的全部 user-visible 文本 ---');
  await check(`总扫描：${allUserVisible.length} 条 user-visible 文本零占位符`, async () => {
    for (const { label, text } of allUserVisible) assertNoPlaceholder(label, text);
    log(`      共扫 ${allUserVisible.length} 条：聊天回复/错误回话/路由卡/例行卡/被拒卡/进展卡`);
  });

  await app.close();
  log('');
  log(`=== 结论：${passes} PASS / ${fails} FAIL ===`);
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.error('验收脚本自身出错：', err);
  process.exit(1);
});
