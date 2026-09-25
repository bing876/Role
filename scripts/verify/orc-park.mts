/**
 * 多智能体编排 · S5 验收：**park 全生命周期**（挂起 → 结果回来自动续跑）。
 *
 * 这一步验证的是整个机制最吃重的一段链路，逐条对着「不能出的事」写：
 *
 *   ① 循环调 spawn_workers → 第一次 advance 回 `ask/job_pending`，且**模型只被调 1 次**；
 *   ② 挂起期间反复 advance（旧桌面狂点「继续」）**不再调模型**、原样重放同一句 —— 不烧 token、不自旋；
 *   ③ 挂起期间历史里**只有** assistant.tool_calls、**没有** tool 回执（不伪造回执）；
 *   ④ 结果回来后：tool 回执出现且**内容里带着临时工的结构化汇报**（`describeToolResult` 那一段），
 *      状态回 `running`、`pendingCallId` 清空、`step` 只加一次 —— 下一次 advance 能接着走；
 *   ⑤ `resumeLoop` 对 `waiting_job` 返回 `resumed:false`、**不重置 step、不改状态**
 *      （否则「继续」会把等结果的循环推乱）；
 *   ⑥ 用户手动暂停期间结果回来 → **只补回执、状态仍是 paused**（凭什么替用户解除暂停）；
 *   ⑦ 用户叫停 → 后台 job 被**级联取消**（不留着烧 token）。
 *
 * LLM 用桩 fetch（按系统提示词区分「主循环」与「临时工」两条路），DB 用 pglite 内存库。
 * 用法：npx tsx scripts/verify/orc-park.mts
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
/**
 * ★★★ 服务端模块必须用 `require`（CJS 图）载入，**不能**用 `import`（2026-09-25 修）
 * ---------------------------------------------------------------------------
 * 本文件是 `.mts`（ESM），而 `apps/server` 是 **CommonJS**（tsconfig `module: CommonJS`
 * + package.json 无 `type`）。tsx 下两者**各有一份模块图**：ESM 侧 `import` 进来的
 * `toolLoop` / `registry` 与生产代码内部 `require` 到的**不是同一个实例**。
 *
 * 症状：循环里 `spawn_workers` 建的 job 落在 CJS 实例，而本文件断言的
 * `liveJobCount()`（ESM 实例）恒为 0 ⇒ 「前置条件：该有一个 job 在跑」直接崩，
 * 连带 ⑥⑦⑧ 三段全红。产品代码没问题，是测试拿错了实例。
 *
 * ★ 以后往本文件加服务端模块，一律走下面的 `req`，别退回 `import`。
 *   （只测纯函数、不碰跨模块内存状态的脚本不受影响，`.mts` 照旧可用。）
 */
import type { OrchestratorEnv, ServerEnv } from '../../apps/server/src/env';

const req = createRequire(import.meta.url);
const { ORCH_DEFAULTS } = req('../../apps/server/src/env') as typeof import('../../apps/server/src/env');
const { makeCipher } = req('../../apps/server/src/crypto') as typeof import('../../apps/server/src/crypto');
const { makePool, migrate } = req('../../apps/server/src/db') as typeof import('../../apps/server/src/db');
const { advance, getLoop, resumeLoop, pauseLoop, startLoop, stopLoop } = req(
  '../../apps/server/src/toolLoop',
) as typeof import('../../apps/server/src/toolLoop');
const { initOrchestrator } = req('../../apps/server/src/orchestrator/tools') as typeof import('../../apps/server/src/orchestrator/tools');
const { liveJobCount } = req('../../apps/server/src/orchestrator/registry') as typeof import('../../apps/server/src/orchestrator/registry');

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

const ORCH: OrchestratorEnv = {
  ...ORCH_DEFAULTS,
  workerConcurrency: 3,
  workerMaxPerCall: 5,
  workerTimeoutMs: 3_000,
  workerJobBudgetMs: 6_000,
  workerMaxSearchRounds: 0, // 本用例不测搜索（S4 测过了），少一层桩
};

const ENV: ServerEnv = {
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
  orch: ORCH,
};

// ---------------------------------------------------------------------------
// 桩 LLM：按系统提示词区分「主循环」与「临时工」
// ---------------------------------------------------------------------------

interface StubState {
  llmCalls: number;
  mainCalls: number;
  workerCalls: number;
  /** 主循环第 N 次被问时要回什么 */
  mainScript: Array<{ name: string; args: unknown }>;
  delayMs: number;
}

function installStub(state: StubState): void {
  (globalThis as { fetch: typeof fetch }).fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    state.llmCalls += 1;
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ role: string; content?: string }>;
    };
    const system = (body.messages ?? []).find((m) => m.role === 'system')?.content ?? '';
    const isWorker = system.includes('临时工');
    await new Promise((r) => setTimeout(r, state.delayMs));

    if (isWorker) {
      state.workerCalls += 1;
      return new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  summary: '临时工查到的结论',
                  findings: ['要点甲', '要点乙'],
                  sources: [],
                  confidence: 'high',
                }),
              },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    state.mainCalls += 1;
    const step = state.mainScript[Math.min(state.mainCalls - 1, state.mainScript.length - 1)];
    return new Response(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: `call_main_${state.mainCalls}`,
                  type: 'function',
                  function: { name: step.name, arguments: JSON.stringify(step.args) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

function newStub(script: StubState['mainScript']): StubState {
  return { llmCalls: 0, mainCalls: 0, workerCalls: 0, mainScript: script, delayMs: 5 };
}

async function main(): Promise<void> {
  log('=== 多智能体编排 · S5 park 生命周期验收 ===');
  const pool = makePool('pglite://memory');
  await migrate(pool);
  const cipher = makeCipher(ENV.dataKey);
  initOrchestrator({ pool, env: ENV, cipher });

  const SPAWN = {
    name: 'spawn_workers',
    args: {
      tasks: [
        { title: '查甲', instruction: '把甲查清楚' },
        { title: '查乙', instruction: '把乙查清楚' },
      ],
      allow_search: false,
    },
  };
  const DONE = { name: 'stop', args: { reason: 'done', summary: '两件事都办完了', document_title: '结论', document_outline: ['甲', '乙'] } };

  // ---------------------------------------------------------------- ①②③ 挂起
  log('');
  log('--- ①②③ 派出即挂起：不调模型、不伪造回执、重复 advance 不自旋 ---');
  const stub = newStub([SPAWN, DONE]);
  installStub(stub);
  const session = startLoop(ENV, {
    userId: 1,
    agentId: 11,
    conversationId: null,
    wcId: 777,
    goal: '把甲和乙各查一遍',
    pageUrl: 'https://example.com/',
  });

  const first = await advance(ENV, session);
  await check('第一次 advance 回 ask/job_pending，并带上 jobId/jobKind/etaMs', () => {
    assert.equal(first.kind, 'ask');
    if (first.kind !== 'ask') throw new Error('not ask');
    assert.equal(first.reason, 'job_pending');
    assert.ok(first.jobId, '缺 jobId');
    assert.equal(first.jobKind, 'workers');
    assert.ok((first.etaMs ?? 0) > 0);
    assert.ok(/临时工/.test(first.question), `话术没提临时工：${first.question}`);
  });
  await check('模型只被调了 1 次（派出即返回，没有 await 子任务）', () => {
    assert.equal(stub.mainCalls, 1, `主循环被调了 ${stub.mainCalls} 次`);
  });
  await check('循环转 waiting_job、记着 jobId，且仍在内存里（getLoop 拿得到）', () => {
    assert.equal(session.status, 'waiting_job');
    assert.ok(session.jobId);
    assert.equal(getLoop(session.id)?.status, 'waiting_job');
    assert.equal(liveJobCount(), 1);
  });
  await check('历史里只有 assistant.tool_calls、**没有** tool 回执（不伪造回执）', () => {
    const last = session.messages[session.messages.length - 1];
    assert.equal(last.role, 'assistant');
    assert.ok(last.tool_calls?.length, '最后一条该是带 tool_calls 的 assistant');
    assert.equal(session.messages.filter((m) => m.role === 'tool').length, 0, '挂起期间不该有 tool 回执');
    assert.equal(session.pendingCallId, last.tool_calls?.[0].id, 'pendingCallId 要留着等结果');
  });

  const before = { llm: stub.llmCalls, msgs: session.messages.length, step: session.step };
  for (let i = 0; i < 3; i += 1) {
    const again = await advance(ENV, session);
    if (again.kind !== 'ask' || again.reason !== 'job_pending') throw new Error(`第 ${i + 1} 次重放不是 job_pending`);
  }
  await check('挂起期间连点 3 次「继续」：原样重放，模型 0 次新调用、历史 0 条新消息、step 不变', () => {
    assert.equal(stub.llmCalls, before.llm, `模型被多调了 ${stub.llmCalls - before.llm} 次`);
    assert.equal(session.messages.length, before.msgs);
    assert.equal(session.step, before.step);
  });

  // ---------------------------------------------------------------- ⑤ resume 语义
  log('');
  log('--- ⑤ resumeLoop 对 waiting_job 必须是 no-op（不重置 step、不改状态） ---');
  await check('resume 返回 resumed:false，状态仍 waiting_job、step 不变', () => {
    session.step = 4; // 造一个非 0 的 step，好证明它没被重置
    const r = resumeLoop(session.id, null);
    assert.equal(r?.resumed, false);
    assert.equal(session.status, 'waiting_job');
    assert.equal(session.step, 4, 'step 被重置了 —— 「继续」会把等结果的循环推乱');
  });

  // ---------------------------------------------------------------- ④ 结果回来
  log('');
  log('--- ④ 结果回来：回执带结构化汇报、状态回 running、能接着走 ---');
  // 等临时工跑完并投递（预算 6s，正常 1s 内就回来）
  for (let i = 0; i < 60 && session.status === 'waiting_job'; i += 1) await sleep(100);

  await check('投递后状态回 running、jobId 清空、job 已销毁', () => {
    assert.equal(session.status, 'running', `状态是 ${session.status}`);
    assert.equal(session.jobId, null);
    assert.equal(liveJobCount(), 0, '临时工用完即销毁：job 该从表里消失');
  });
  await check('历史里出现了 tool 回执，pendingCallId 清空，step 只加一次', () => {
    const last = session.messages[session.messages.length - 1];
    assert.equal(last.role, 'tool');
    assert.equal(session.pendingCallId, null);
    assert.equal(session.step, 5, `step=${session.step}（原来 4，该只加 1）`);
  });
  await check('★ 回执正文里**带着临时工的结构化汇报**（describeToolResult 那一段）', () => {
    const toolMsg = session.messages[session.messages.length - 1];
    const text = String(toolMsg.content ?? '');
    assert.ok(/结构化结果/.test(text), `回执里没有结构化结果段：${text.slice(0, 200)}`);
    assert.ok(/临时工查到的结论/.test(text), '汇报的 summary 没进上下文');
    assert.ok(/要点甲/.test(text) && /要点乙/.test(text), '汇报的 findings 没进上下文');
    assert.ok(/"okCount":2/.test(text), `汇总计数没进上下文：${text.slice(0, 300)}`);
  });

  const next = await advance(ENV, session);
  await check('续跑：模型看到汇报后收尾（stop→done），这是第 2 次主循环调用', () => {
    assert.equal(next.kind, 'done');
    assert.equal(stub.mainCalls, 2, `主循环被调了 ${stub.mainCalls} 次（该是 2）`);
  });

  // ---------------------------------------------------------------- ⑥ 暂停优先
  log('');
  log('--- ⑥ 用户手动暂停期间结果回来：只补回执、**不解除暂停** ---');
  {
    const s2stub = newStub([SPAWN, DONE]);
    installStub(s2stub);
    const s2 = startLoop(ENV, {
      userId: 1,
      agentId: 12,
      conversationId: null,
      wcId: 778,
      goal: '再来一遍',
      pageUrl: 'https://example.com/',
    });
    await advance(ENV, s2);
    assert.equal(s2.status, 'waiting_job');
    pauseLoop(s2.id, { by: 'user' });
    await check('waiting_job 期间可以暂停（pauseLoop 接受非终态）', () => {
      assert.equal(s2.status, 'paused');
    });
    for (let i = 0; i < 60 && s2.jobId !== null; i += 1) await sleep(100);
    await check('结果回来只补回执，状态**仍是 paused**（不替用户解除暂停）', () => {
      assert.equal(s2.status, 'paused', `状态是 ${s2.status}`);
      const last = s2.messages[s2.messages.length - 1];
      assert.equal(last.role, 'tool', '回执该已经补进历史，等用户点继续就能看见');
      assert.ok(/结构化结果/.test(String(last.content ?? '')));
    });
  }

  // ---------------------------------------------------------------- ⑦ 叫停级联
  log('');
  log('--- ⑦ 用户叫停 → 后台 job 级联取消 ---');
  {
    const s3stub = newStub([SPAWN, DONE]);
    installStub(s3stub);
    const s3 = startLoop(ENV, {
      userId: 1,
      agentId: 13,
      conversationId: null,
      wcId: 779,
      goal: '第三遍',
      pageUrl: 'https://example.com/',
    });
    await advance(ENV, s3);
    assert.equal(s3.status, 'waiting_job');
    assert.equal(liveJobCount(), 1, '前置条件：该有一个 job 在跑');
    const stopped = stopLoop(s3.id, 'user_stop');
    await sleep(200);
    await check('stopLoop 成功且 job 被级联取消（不留后台烧 token）', () => {
      assert.equal(stopped, true);
      assert.equal(s3.status, 'stopped');
      assert.equal(liveJobCount(), 0, `还有 ${liveJobCount()} 个 job 在跑`);
    });
    await check('被停掉的循环不会再被投递（deliverJobResult 对终态返回 false）', () => {
      const tools = s3.messages.filter((m) => m.role === 'tool').length;
      assert.equal(tools, 0, '终态循环不该再收到回执');
    });
  }

  log('');
  log('=== 结论 ===');
  log(`  ${passes} PASS / ${fails} FAIL`);
  if (fails > 0) process.exitCode = 1;
}

void main();
