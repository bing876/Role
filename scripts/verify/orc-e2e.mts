/**
 * 多智能体编排 · S7 验收：**委派端到端** + **10 分钟超时熔断**。
 *
 * 对着用户的两条安全要求逐条验：
 *
 *   要求 1「不能死循环」的运行时部分（闸在 S6 验过了，这里验**运行起来真的不绕回来**）：
 *     · 被委派方拿到的是**分离式**子循环，工具表里**没有任何浏览器工具**（它没有浏览器手）；
 *     · 委派链真的传进了子循环（`chain = [发起方, 被委派方]`）—— 链深闸与成环闸全靠它，
 *       不传下去的话 A→B→C→D 就能无限转。
 *
 *   要求 2「10 分钟熔断」：
 *     · 被委派方一直不交活 → 到点**如实**回「暂未完成」，不是挂死、也不是假装完成；
 *     · 委派记录状态转 `timeout`、频道里留了「按超时熔断处理」的话；
 *     · 发起方循环收到回执后能接着走（不是卡死）；
 *     · 名额**释放**（被委派方能接下一件）、子循环销毁、在飞的 LLM 请求被掐。
 *
 * DB 用 pglite 内存库，LLM 用桩（按系统提示词区分主循环 / 子循环 / 临时工三条路）。
 * 用法：npx tsx scripts/verify/orc-e2e.mts
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
/**
 * ★★★ 服务端模块必须用 `require`（CJS 图）载入，**不能**用 `import`（2026-09-25 修）
 * 原因同 orc-delegate.mts 头注释：`.mts`(ESM) 与 `apps/server`(CJS) 在 tsx 下各有一份
 * 模块图，`import` 拿到的 registry / toolLoop / subLoops 与生产代码内部 require 到的
 * 不是同一个实例 ⇒ 子循环、忙碌、等待等状态断言全红。以后加服务端模块一律走 `req`。
 */
import type { OrchestratorEnv, ServerEnv } from '../../apps/server/src/env';
const req = createRequire(import.meta.url);
const { ORCH_DEFAULTS, resolveOrchestratorEnv } = req('../../apps/server/src/env') as typeof import('../../apps/server/src/env');
const { makeCipher } = req('../../apps/server/src/crypto') as typeof import('../../apps/server/src/crypto');
const { makePool, migrate } = req('../../apps/server/src/db') as typeof import('../../apps/server/src/db');
const { advance, startLoop } = req('../../apps/server/src/toolLoop') as typeof import('../../apps/server/src/toolLoop');
const { initOrchestrator, setOrchestratorDepsForTest } = req(
  '../../apps/server/src/orchestrator/tools',
) as typeof import('../../apps/server/src/orchestrator/tools');
const { SUB_AGENT_TOOL_NAMES } = req('../../apps/server/src/toolRegistry') as typeof import('../../apps/server/src/toolRegistry');
const { resetRegistryForTest, initRegistry, agentBusyCount, isAgentWaiting } = req(
  '../../apps/server/src/orchestrator/registry',
) as typeof import('../../apps/server/src/orchestrator/registry');
const { subLoopCount, listSubLoops } = req('../../apps/server/src/orchestrator/subLoops') as typeof import('../../apps/server/src/orchestrator/subLoops');

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DELEGATE = { name: 'delegate', args: { to: '母鸡', task: '把三家竞品的定价查一遍，回三个要点' } };
const DONE_MAIN = { name: 'stop', args: { reason: 'done', summary: '拿到了母鸡的结论', document_title: '定价对比', document_outline: ['甲', '乙'] } };

interface StubState {
  mainCalls: number;
  subCalls: number;
  mainScript: Array<{ name: string; args: unknown }>;
  /** 子循环这一格要拖多久（毫秒）—— 用它把委派拖过熔断线 */
  subDelayMs: number;
  subScript: Array<{ name: string; args: unknown }>;
  aborted: number;
}

/** 桩 LLM：按系统提示词分「主循环 / 被委派子循环 / 临时工」三条路，并如实响应中止 */
function installStub(state: StubState): void {
  (globalThis as { fetch: typeof fetch }).fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content?: string }> };
    const system = (body.messages ?? []).find((m) => m.role === 'system')?.content ?? '';
    // ★ 判路要用**只属于那一种角色**的字眼：`临时工` 这个词在被委派方的提示词里也出现
    //   （它也能派临时工），拿它当临时工的判据会把子循环那一格错判成临时工。
    const isWorker = system.includes('做完这一件事就被销毁');
    const isSub = !isWorker && system.includes('把一件事交给了你');

    const reply = (name: string, args: unknown, id: string) =>
      new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
              finish_reason: 'tool_calls',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    if (isWorker) {
      await sleep(5);
      return new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify({ summary: '临时工的结论', findings: ['要点'], sources: [], confidence: 'medium' }) },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    // ★ 这一格要拖：**如实响应中止**（真请求被 abort 时也是立刻抛，不是等满）
    const delayMs = isSub ? state.subDelayMs : 5;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          state.aborted += 1;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            state.aborted += 1;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          },
          { once: true },
        );
      }
    });

    if (isSub) {
      state.subCalls += 1;
      const step = state.subScript[Math.min(state.subCalls - 1, state.subScript.length - 1)];
      return reply(step.name, step.args, `call_sub_${state.subCalls}`);
    }

    state.mainCalls += 1;
    const step = state.mainScript[Math.min(state.mainCalls - 1, state.mainScript.length - 1)];
    return reply(step.name, step.args, `call_main_${state.mainCalls}`);
  }) as typeof fetch;
}

function makeEnv(orch: OrchestratorEnv): ServerEnv {
  return {
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
    agentLoopMaxSteps: 0,
    tavilyApiKey: '',
    tavilyBaseUrl: 'https://tavily.test',
    orch,
  };
}

async function seed(pool: import('pg').Pool): Promise<void> {
  await pool.query(`INSERT INTO users (id, xyz_id, phone_hash) VALUES (1, 'x1', 'h1') ON CONFLICT (id) DO NOTHING`);
  await pool.query(`INSERT INTO projects (id, user_id, name, is_default) VALUES (10, 1, '项目甲', true) ON CONFLICT (id) DO NOTHING`);
  await pool.query(
    `INSERT INTO agents (id, project_id, name, kind, persona) VALUES
       (101, 10, '小助', 'assistant', '{"name":"小助","who":"贴身助手","tone":"利落","duty":"日常事务"}'),
       (102, 10, '母鸡', 'hen', '{"name":"母鸡","who":"项目总管","tone":"稳重","duty":"统筹与研究"}'),
       (103, 10, '研究员', 'custom', '{"name":"研究员","who":"资料员","tone":"严谨","duty":"查资料写要点"}')
     ON CONFLICT (id) DO NOTHING`,
  );
}

async function main(): Promise<void> {
  log('=== 多智能体编排 · S7 委派端到端 + 超时熔断验收 ===');

  // ------------------------------------------------------------------ 默认值
  await check('委派超时默认就是**10 分钟**（600000ms），且生产环境夹在 1~30 分钟内', () => {
    assert.equal(ORCH_DEFAULTS.delegateTimeoutMs, 600_000, `默认是 ${ORCH_DEFAULTS.delegateTimeoutMs}ms`);
    // 没设环境变量 → 就是默认 10 分钟
    assert.equal(resolveOrchestratorEnv({}).delegateTimeoutMs, 600_000, '默认值不是 10 分钟');
    // 设了合法值（60s 正好在下限上）→ 照着用，不能被默认值盖掉
    assert.equal(resolveOrchestratorEnv({ DELEGATE_TIMEOUT_MS: '60000' }).delegateTimeoutMs, 60_000, '合法的环境变量被忽略了');
    const low = resolveOrchestratorEnv({ DELEGATE_TIMEOUT_MS: '1' });
    assert.equal(low.delegateTimeoutMs, 60_000, `下限没夹住：${low.delegateTimeoutMs}`);
    const high = resolveOrchestratorEnv({ DELEGATE_TIMEOUT_MS: '99999999' });
    assert.equal(high.delegateTimeoutMs, 1_800_000, `上限没夹住：${high.delegateTimeoutMs}`);
  });

  // ------------------------------------------------------------------ 能力边界
  await check('★ 被委派方的工具表里**没有任何浏览器工具**（它没有浏览器手）', () => {
    const browser = new Set(['open_url', 'click', 'type', 'scroll', 'screenshot', 'snapshot']);
    const leaked = SUB_AGENT_TOOL_NAMES.filter((n) => browser.has(n));
    assert.deepEqual(leaked, [], `子循环工具表里有浏览器工具：${leaked.join(', ')}`);
    assert.ok(SUB_AGENT_TOOL_NAMES.includes('web_search'), '子循环该能查资料');
    assert.ok(SUB_AGENT_TOOL_NAMES.includes('stop'), '子循环必须能收尾');
  });

  // 交接文件（批次 A 起每次委派都会写）落临时目录，不污染 apps/server/data/handoffs
  process.env.HANDOFF_ROOT ??= (await import('node:fs')).mkdtempSync(
    (await import('node:path')).join((await import('node:os')).tmpdir(), 'orc-e2e-handoffs-'),
  );
  const pool = makePool('pglite://memory');
  await migrate(pool);
  await seed(pool);
  const cipher = makeCipher(makeEnv(ORCH_DEFAULTS).dataKey);

  /** 读某条频道的消息（解密后） */
  async function messagesOf(a: number, b: number): Promise<Array<{ kind: string; text: string; payload: unknown }>> {
    const pair = a <= b ? [a, b] : [b, a];
    const ch = await pool.query<{ id: string }>(
      'SELECT id FROM agent_channels WHERE user_id = 1 AND agent_a_id = $1 AND agent_b_id = $2 LIMIT 1',
      [pair[0], pair[1]],
    );
    if (!ch.rows[0]) return [];
    const rows = await pool.query<{ kind: string; content_enc: string; payload: unknown }>(
      'SELECT kind, content_enc, payload FROM agent_channel_messages WHERE channel_id = $1 ORDER BY id ASC',
      [ch.rows[0].id],
    );
    return rows.rows.map((r) => ({ kind: r.kind, text: cipher.decryptText(r.content_enc), payload: r.payload }));
  }

  // ================================================== A. 正常委派端到端
  log('');
  log('--- A. 正常委派：派出 → 子循环干完 → 结果回来 → 发起方续跑 ---');
  {
    const env = makeEnv({ ...ORCH_DEFAULTS, delegateTimeoutMs: 30_000 });
    const stub: StubState = {
      mainCalls: 0,
      subCalls: 0,
      mainScript: [DELEGATE, DONE_MAIN],
      subDelayMs: 5,
      subScript: [{ name: 'stop', args: { reason: 'done', summary: '三家定价分别是 99 / 199 / 299，中位数 199', document_outline: ['甲 99', '乙 199', '丙 299'] } }],
      aborted: 0,
    };
    installStub(stub);
    initOrchestrator({ pool, env, cipher });
    resetRegistryForTest();
    initRegistry(env.orch);

    const session = startLoop(env, { userId: 1, agentId: 101, conversationId: null, wcId: 801, goal: '把三家竞品的定价查一遍', pageUrl: 'https://example.com/' });
    const first = await advance(env, session);
    await check('第一次 advance 回 job_pending（kind=delegate），浏览器交还用户', () => {
      assert.equal(first.kind, 'ask');
      if (first.kind !== 'ask') throw new Error('not ask');
      assert.equal(first.reason, 'job_pending');
      assert.equal(first.jobKind, 'delegate');
      assert.equal(session.status, 'waiting_job');
    });

    // 子循环是分离式的，只能从 subLoops 里拿。
    // ★ **立刻**拿，不能先 sleep：这段脚本里子循环干完只要几十毫秒，
    //   睡一觉它就注销了 —— 那时查不到不代表「没建过」，只代表「已经跑完了」。
    const sub = listSubLoops()[0];
    await check('★ 子循环是**分离式**的：agentId=被委派方、wcId=null（不碰任何页的分片状态）', () => {
      assert.ok(sub, `没有子循环在跑（${subLoopCount()} 个）`);
      assert.equal(sub?.agentId, 102);
      assert.equal(sub?.wcId, null, '子循环不该绑任何页');
      assert.equal(sub?.kind, 'delegate');
      assert.equal(sub?.parentLoopId, session.id);
      assert.equal(sub?.detached, true);
    });
    await check('★ 委派链传进了子循环：chain = [发起方, 被委派方]（链深/成环闸靠它）', () => {
      assert.deepEqual(sub?.chain, [101, 102], `chain=${JSON.stringify(sub?.chain)}`);
    });

    // 等结果投递回来
    for (let i = 0; i < 60 && session.status === 'waiting_job'; i += 1) await sleep(100);
    await check('结果回来：发起方循环回 running、回执里带被委派方的结论', () => {
      assert.equal(session.status, 'running', `状态是 ${session.status}`);
      const last = session.messages[session.messages.length - 1];
      assert.equal(last.role, 'tool');
      const text = String(last.content ?? '');
      assert.ok(/三家定价分别是 99/.test(text), `回执里没有结论：${text.slice(0, 200)}`);
    });
    await check('名额已释放：发起方不再「在等」、被委派方不再「忙」', () => {
      assert.equal(isAgentWaiting(101), false, '发起方还挂在 waitingAgents 里');
      assert.equal(agentBusyCount(102), 0, `被委派方还有 ${agentBusyCount(102)} 个名额没释放`);
    });
    await check('子循环用完即销毁（不留在内存里）', () => {
      assert.equal(subLoopCount(), 0, `还有 ${subLoopCount()} 个子循环`);
    });

    const next = await advance(env, session);
    await check('发起方看到结论后收尾（stop→done）', () => {
      assert.equal(next.kind, 'done');
    });

    await check('DB：委派记录转 done，result 里有 summary + outline', async () => {
      const d = await pool.query<{ status: string; result: { summary?: string; outline?: string[] } | null; finished_at: string | null }>(
        'SELECT status, result, finished_at FROM agent_delegations ORDER BY id DESC LIMIT 1',
      );
      assert.equal(d.rows[0].status, 'done');
      assert.ok(d.rows[0].finished_at, 'finished_at 没写');
      assert.ok(/三家定价/.test(d.rows[0].result?.summary ?? ''), `result.summary 不对：${JSON.stringify(d.rows[0].result)}`);
      assert.deepEqual(d.rows[0].result?.outline, ['甲 99', '乙 199', '丙 299']);
    });
    await check('★ 频道里用户能看到完整过程：task → reply', async () => {
      const kinds = (await messagesOf(101, 102)).map((m) => m.kind);
      assert.ok(kinds.includes('task'), `缺 task：${kinds.join(',')}`);
      assert.ok(kinds.includes('reply'), `缺 reply：${kinds.join(',')}`);
      const reply = (await messagesOf(101, 102)).find((m) => m.kind === 'reply');
      assert.ok(/三家定价/.test(reply?.text ?? ''), `reply 正文不对：${reply?.text}`);
    });
  }

  // ================================================== B. 超时熔断
  log('');
  log('--- B. ★ 超时熔断：被委派方不交活 → 如实回「暂未完成」，不挂死 ---');
  {
    // 直接构造 env（不走 resolveOrchestratorEnv 的 1 分钟下限），把熔断线压到 1.5 秒
    const env = makeEnv({ ...ORCH_DEFAULTS, delegateTimeoutMs: 1_500 });
    const stub: StubState = {
      mainCalls: 0,
      subCalls: 0,
      mainScript: [DELEGATE, DONE_MAIN],
      subDelayMs: 8_000, // 子循环那一格拖 8 秒 —— 远超熔断线
      subScript: [{ name: 'stop', args: { reason: 'done', summary: '（这句永远到不了）' } }],
      aborted: 0,
    };
    installStub(stub);
    resetRegistryForTest();
    // ★ 换依赖（不是 initOrchestrator —— 那个有「只装一次」的闸，重复调用是 no-op）。
    //   不换的话 `executeDelegate` 读到的还是 A 段那套 30s 的配置，熔断线就测不到。
    setOrchestratorDepsForTest({ pool, env, cipher });

    const session = startLoop(env, { userId: 1, agentId: 101, conversationId: null, wcId: 802, goal: '再查一遍', pageUrl: 'https://example.com/' });
    const t0 = Date.now();
    const first = await advance(env, session);
    assert.equal(first.kind, 'ask', `第一次不是 ask：${first.kind}`);

    for (let i = 0; i < 80 && session.status === 'waiting_job'; i += 1) await sleep(100);
    const waited = Date.now() - t0;

    await check('到点就回结果（不是无限挂死），耗时约等于熔断线', () => {
      assert.ok(waited < 6_000, `等了 ${waited}ms —— 熔断没生效（子循环那一格要 8 秒）`);
      assert.ok(waited >= 1_400, `只等了 ${waited}ms —— 比熔断线还短，不该这么快`);
      assert.equal(session.status, 'running', `状态是 ${session.status}`);
    });
    await check('★ 回执是**如实的「暂未完成」**，不是假装完成', () => {
      const last = session.messages[session.messages.length - 1];
      assert.equal(last.role, 'tool');
      const text = String(last.content ?? '');
      assert.ok(/暂未完成/.test(text), `话术没说「暂未完成」：${text.slice(0, 200)}`);
      assert.ok(!/（这句永远到不了）/.test(text), '把没做完的东西当成结论交上来了');
    });
    await check('回执的 error 是 delegate_timeout，data.status=timeout（前端能区分「超时」与「办成了」）', () => {
      const last = session.messages[session.messages.length - 1];
      const text = String(last.content ?? '');
      assert.ok(/delegate_timeout/.test(text), `回执里没有 delegate_timeout：${text.slice(0, 300)}`);
      assert.ok(/"status":"timeout"/.test(text), `data.status 不是 timeout：${text.slice(0, 300)}`);
    });
    await check('在飞的那次 LLM 请求被掐掉了（不在后台把 8 秒跑完、钱照烧）', () => {
      assert.ok(stub.aborted >= 1, `没有请求被中止（aborted=${stub.aborted}）`);
    });
    await check('DB：委派记录转 timeout、写了 finished_at', async () => {
      const d = await pool.query<{ status: string; error: string | null; finished_at: string | null }>(
        'SELECT status, error, finished_at FROM agent_delegations ORDER BY id DESC LIMIT 1',
      );
      assert.equal(d.rows[0].status, 'timeout');
      assert.ok(d.rows[0].finished_at, 'finished_at 没写');
      assert.ok(/超时|分钟/.test(d.rows[0].error ?? ''), `error 没说明原因：${d.rows[0].error}`);
    });
    await check('★ 频道里留了熔断的话（用户看得见「超时了」）', async () => {
      const systems = (await messagesOf(101, 102)).filter((m) => m.kind === 'system');
      const hit = systems.find((m) => /超时/.test(m.text));
      assert.ok(hit, `频道里没有超时留痕：${systems.map((m) => m.text).join('|')}`);
    });
    await check('名额释放 + 子循环销毁（被委派方能接下一件，不留内存）', () => {
      assert.equal(isAgentWaiting(101), false);
      assert.equal(agentBusyCount(102), 0);
      assert.equal(subLoopCount(), 0, `还有 ${subLoopCount()} 个子循环`);
    });

    const next = await advance(env, session);
    await check('发起方拿到「暂未完成」后能继续走（不卡死）', () => {
      assert.equal(next.kind, 'done');
      assert.equal(stub.mainCalls, 2, `主循环被调了 ${stub.mainCalls} 次（该是 2）`);
    });
  }

  log('');
  log('=== 结论 ===');
  log(`  ${passes} PASS / ${fails} FAIL`);
  if (fails > 0) process.exitCode = 1;
}

void main();
