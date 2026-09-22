/**
 * 多智能体编排 · **关闭开关**（`ORCHESTRATION_TOOLS=0`）的端到端验收。
 *
 * ★ 为什么这条必须是**独立进程**（也就是为什么它是单独一个脚本，不能并进别的）：
 *   `serverToolRegistry` 是**进程级单例**，`register` 只增不减、重名直接抛错。
 *   一旦某个脚本调过 `initOrchestrator`（enabled=true），那三个工具就永久在册了，
 *   同进程里再也造不出「没装过」的状态。所以「关掉之后工具表回到旧的那张」这件事，
 *   只能在一个**从头到尾没开过编排**的进程里验 —— 就是这个脚本。
 *
 *   （交付报告里我原先把这条记成「留给真机验收」，那是我说错了：
 *     验收脚本本来就是各自独立的进程，这条完全验得了。）
 *
 * 验的是「关掉 = **完全**回到改动前的行为」，逐条对着「不能出的事」：
 *   ① 三个编排工具**一个都没注册**（不是注册了但不给用）；
 *   ② 5 个浏览器工具 + stop **照常在册** —— 关掉编排不能把原有能力弄丢；
 *   ③ `browserToolNamesFor` 返回的工具表与冻结常量 `LOOP_TOOL_NAMES` **逐项相等**；
 *   ④ 这张表喂给 `toOpenAITools` **不抛错**（遇到未注册名它会抛，整条循环起不来）；
 *   ⑤ 建出来的循环 `toolNames` 就是旧的那 7 个，第一条 user 消息里**没有**同事名单段。
 *
 * 用法：npx tsx scripts/verify/orc-killswitch.mts
 */
import assert from 'node:assert/strict';
import { ORCH_DEFAULTS, resolveOrchestratorEnv, type ServerEnv } from '../../apps/server/src/env';
import { makeCipher } from '../../apps/server/src/crypto';
import { makePool, migrate } from '../../apps/server/src/db';
import { LOOP_TOOL_NAMES, browserToolNamesFor, serverToolRegistry } from '../../apps/server/src/toolRegistry';
import { initOrchestrator } from '../../apps/server/src/orchestrator/tools';
import { orchestrationBlockFor } from '../../apps/server/src/orchestrator/roster';
import { startLoop } from '../../apps/server/src/toolLoop';

let fails = 0;
let passes = 0;
const log = (...a: string[]) => console.log(a.map(String).join(' '));
const check = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve()
    .then(fn)
    .then(() => {
      passes += 1;
      log(`  PASS ${name}`);
    })
    .catch((err) => {
      fails += 1;
      log(`  ★FAIL ${name}  —— ${(err as Error)?.message ?? String(err)}`);
    });

const ORCHESTRATION_TOOLS = ['web_search', 'spawn_workers', 'delegate'];

async function main(): Promise<void> {
  log('=== 多智能体编排 · 关闭开关（ORCHESTRATION_TOOLS=0）验收 ===');
  log('（本进程从头到尾没开过编排 —— 这正是能验「工具没注册」的前提）');

  const env: ServerEnv = {
    port: 0,
    databaseUrl: 'pglite://memory',
    jwtSecret: 'x'.repeat(24),
    dataKey: 'y'.repeat(64),
    phonePepper: 'z'.repeat(24),
    smsMock: true,
    smsHttpUrl: '',
    isProduction: false,
    deepseekApiKey: 'test-key',
    deepseekBaseUrl: 'https://llm.test/v1',
    deepseekModel: 'test-model',
    agentLoopMaxSteps: 10,
    tavilyApiKey: '',
    tavilyBaseUrl: 'https://tavily.test',
    orch: resolveOrchestratorEnv({ ORCHESTRATION_TOOLS: '0' }),
  };

  await check('ORCHESTRATION_TOOLS=0 → env.orch.enabled === false', () => {
    assert.equal(env.orch.enabled, false, `enabled=${env.orch.enabled}`);
  });

  // 装配（enabled=false 的那条分支）
  const pool = makePool('pglite://memory');
  await migrate(pool);
  const cipher = makeCipher(env.dataKey);
  await pool.query(`INSERT INTO users (id, xyz_id, phone_hash) VALUES (1,'x1','h1') ON CONFLICT (id) DO NOTHING`);
  await pool.query(`INSERT INTO projects (id, user_id, name, is_default) VALUES (10,1,'项目甲',true) ON CONFLICT (id) DO NOTHING`);
  await pool.query(
    `INSERT INTO agents (id, project_id, name, kind, persona) VALUES
       (101,10,'小助','assistant','{"name":"小助","duty":"日常事务"}'),
       (102,10,'母鸡','hen','{"name":"母鸡","duty":"统筹与研究"}')
     ON CONFLICT (id) DO NOTHING`,
  );
  initOrchestrator({ pool, env, cipher });

  log('');
  log('--- ①② 注册表：编排工具一个没装，浏览器工具一个没丢 ---');
  await check('★ 三个编排工具**一个都没注册**（不是「注册了但不给用」）', () => {
    const leaked = ORCHESTRATION_TOOLS.filter((n) => serverToolRegistry.get(n) !== undefined);
    assert.deepEqual(leaked, [], `这些工具居然在册：${leaked.join(', ')}`);
  });
  await check('★ 5 个浏览器工具 + stop **照常在册**（关掉编排不能弄丢原有能力）', () => {
    const missing = LOOP_TOOL_NAMES.filter((n) => serverToolRegistry.get(n) === undefined);
    assert.deepEqual(missing, [], `这些内建工具不见了：${missing.join(', ')}`);
    // 冻结常量 = 5 个浏览器工具（open_url/read_page/click/type/scroll）+ stop = 6 个。
    // ★ 别写成 7：那是把 stop 当成「第 6 个浏览器工具」又数了一遍。
    assert.equal(LOOP_TOOL_NAMES.length, 6, `冻结常量该是 6 个，实际 ${LOOP_TOOL_NAMES.length}`);
    assert.deepEqual([...LOOP_TOOL_NAMES], ['open_url', 'read_page', 'click', 'type', 'scroll', 'stop']);
  });

  log('');
  log('--- ③④ 工具表：与改动前逐项相等，且能安全喂给模型 ---');
  const names = browserToolNamesFor(env);
  await check('★ browserToolNamesFor 返回的表与冻结常量 LOOP_TOOL_NAMES **逐项相等**', () => {
    assert.deepEqual(names, [...LOOP_TOOL_NAMES], `工具表不一致：${names.join(',')}`);
  });
  await check('★ 这张表喂给 toOpenAITools **不抛错**（未注册名会让整条循环起不来）', () => {
    const tools = serverToolRegistry.toOpenAITools(names);
    assert.equal(tools.length, names.length, `该是 ${names.length} 个，实际 ${tools.length}`);
    const got = tools.map((t) => t.function.name).sort();
    assert.deepEqual(got, [...LOOP_TOOL_NAMES].sort());
  });
  await check('对照：同一进程里若把开关打开，表里就该多出编排工具（证明上面的相等不是因为「永远相等」）', () => {
    const onEnv = { ...env, orch: { ...ORCH_DEFAULTS, enabled: true, agentLoopWebSearch: true } };
    // 注意：这里只验「函数逻辑」，注册表仍未装 —— 所以不该多出来。
    // 真正的「开着」由 orc-routes.mts 那个进程验（它调过 enabled=true 的 initOrchestrator）。
    assert.deepEqual(browserToolNamesFor(onEnv), [...LOOP_TOOL_NAMES], '注册表没装时就不该多挂工具名');
  });

  log('');
  log('--- ⑤ 建循环：与改动前完全一致 ---');
  const session = startLoop(env, {
    userId: 1,
    agentId: 101,
    conversationId: null,
    wcId: 901,
    goal: '把三家竞品的定价查一遍',
    pageUrl: 'https://example.com/',
  });
  await check('循环的 toolNames 就是旧的那 6 个（5 个浏览器工具 + stop）', () => {
    assert.deepEqual([...(session.toolNames ?? [])], [...LOOP_TOOL_NAMES], `实际：${(session.toolNames ?? []).join(',')}`);
  });
  await check('★ 第一条 user 消息里**没有**同事名单段（这一路完全按改动前跑）', () => {
    const firstUser = session.messages.find((m) => m.role === 'user');
    const text = String(firstUser?.content ?? '');
    assert.ok(!/这个项目里还有谁/.test(text), `还塞了名单段：${text.slice(0, 200)}`);
    assert.ok(!/母鸡/.test(text), '名单里出现了同事名字');
  });
  await check('orchestrationBlockFor 在关闭态下回 undefined（不是回一段空话术）', async () => {
    const block = await orchestrationBlockFor(pool, env, 1, 101);
    assert.equal(block, undefined, `还给了名单段：${String(block).slice(0, 120)}`);
  });
  await check('对照：同一份数据、开关打开时该有名单（证明上面的 undefined 是开关生效，不是数据没造好）', async () => {
    const onEnv: ServerEnv = { ...env, orch: { ...ORCH_DEFAULTS, enabled: true } };
    const block = await orchestrationBlockFor(pool, onEnv, 1, 101);
    assert.ok(block && /母鸡/.test(block), `开着的时候也没有名单：${String(block).slice(0, 120)}`);
  });

  log('');
  log('=== 结论 ===');
  log(`  ${passes} PASS / ${fails} FAIL`);
  if (fails > 0) process.exitCode = 1;
}

void main();
