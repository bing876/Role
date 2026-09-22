/**
 * 多智能体编排 · S4 验收：**临时工运行时**。
 *
 * 要证明的事：
 *   ① 真并行且并发有上限（5 个任务 / 并发 3 → 同时在跑的模型调用峰值 ≤ 3）；
 *   ② **单个失败/超时不影响同批**（allSettled 语义，逐条 status）；
 *   ③ 汇报**顺序与入参严格一致**（发起方的模型才能对上号）；
 *   ④ 超长字段被截断（summary ≤300 / findings ≤8 条 ≤200 字）；
 *   ⑤ **不许编造来源**：模型给的 url 不在真实搜索结果里 → 被过滤掉；
 *   ⑥ 敏感 query 不外发（R1 同一套闸；临时工这条路不经过 validate，靠 runWebSearch 兜底）；
 *   ⑦ allowSearch=false / 未配置 Tavily → 自动降级为纯推理，**不报错**；
 *   ⑧ 汇报不是合法 JSON 时如实报 failed 并保留原文截断（不假装成功）。
 *
 * LLM 与 Tavily 都用桩 fetch（脚本化），不碰网络。
 * 用法：npx tsx scripts/verify/orc-workers.mts
 */
import assert from 'node:assert/strict';
import { ORCH_DEFAULTS, type ServerEnv } from '../../apps/server/src/env';
import { runWorkerPool } from '../../apps/server/src/orchestrator/workers';
import { extractJson } from '../../apps/server/src/orchestrator/workers';
import type { WorkerTaskSpec } from '../../packages/shared/src/index';

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
  tavilyApiKey: 'tvly-test',
  tavilyBaseUrl: 'https://tavily.test',
  orch: { ...ORCH_DEFAULTS },
};

// ---------------------------------------------------------------------------
// 桩 fetch：按 URL 分流（LLM / Tavily），LLM 行为按「任务标题」脚本化
// ---------------------------------------------------------------------------

interface StubState {
  /** 每个标题的剧本：搜几轮、用什么 query 搜、汇报内容、要不要挂住、要不要 500 */
  scripts: Record<
    string,
    {
      searchRounds?: number;
      /** 模型这一轮要搜的 query（默认用任务标题） */
      searchQuery?: string;
      report?: unknown;
      hang?: boolean;
      http500?: boolean;
      rawReport?: string;
    }
  >;
  llmInFlight: number;
  llmPeak: number;
  llmCalls: number;
  tavilyQueries: string[];
  tavilyEnabled: boolean;
  /** 每次模型调用的模拟网络延迟（ms）。**必须 >0**，否则桩是同步返回的，量不出并发 */
  llmDelayMs: number;
}

/** 可被 abort 打断的延迟（真实 fetch 就是这个语义；桩也得一样，否则测不出「超时后不留后台调用」） */
function abortableDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = () => {
      // ★ 必须清掉定时器：abort 之后若留着这个 ref'd 句柄，
      //   Node 会一直等到它自然到期（实测让整个用例白等 30 秒）。
      if (timer) clearTimeout(timer);
      reject(new Error('aborted'));
    };
    if (signal?.aborted) return fail();
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', fail);
      resolve();
    }, ms);
    // ★ 这里**故意不 unref**：测试脚本没有别的常驻句柄，unref 会让事件循环直接排空、
    //   进程静默退出（实测过一次：输出停在第一行、exit 0，看着像"通过"其实什么都没跑）。
    signal?.addEventListener('abort', fail, { once: true });
  });
}

function installStub(state: StubState): void {
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url ?? '');
    if (url.includes('/search')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
      state.tavilyQueries.push(String(body.query ?? ''));
      if (!state.tavilyEnabled) return new Response('{"detail":"no key"}', { status: 401 });
      return new Response(
        JSON.stringify({
          results: [
            { title: `真结果·${body.query}`, url: `https://real.example.com/${encodeURIComponent(String(body.query))}`, content: '真实摘要', score: 0.9 },
            { title: '真结果2', url: 'https://real2.example.com/a', content: '真实摘要2', score: 0.8 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    // LLM
    state.llmCalls += 1;
    state.llmInFlight += 1;
    state.llmPeak = Math.max(state.llmPeak, state.llmInFlight);
    try {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role: string; content?: string }>;
        tools?: unknown[];
      };
      const firstUser = (body.messages ?? []).find((m) => m.role === 'user')?.content ?? '';
      const titleMatch = /这是第 \d+ 件事：(.*)/.exec(firstUser);
      const title = titleMatch ? titleMatch[1].trim() : '';
      const script = state.scripts[title] ?? {};
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

      // 模拟网络延迟：**没有它就量不出并发**（同步返回的桩峰值恒为 1）
      await abortableDelay(state.llmDelayMs, init?.signal);
      if (script.hang) {
        // 挂住：远长于测试的超时预算 —— 靠 withTimeout 兜住 + abort 掐掉，不是靠这里返回
        await abortableDelay(30_000, init?.signal);
      }
      if (script.http500 && !hasTools) {
        return new Response('{"error":"boom"}', { status: 500 });
      }

      if (hasTools) {
        const rounds = script.searchRounds ?? 0;
        // 已经搜过的轮数 = 历史里 tool 消息的条数
        const doneRounds = (body.messages ?? []).filter((m) => m.role === 'tool').length;
        if (doneRounds < rounds) {
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
                        id: `call_${title}_${doneRounds + 1}`,
                        type: 'function',
                        function: {
                          name: 'web_search',
                          arguments: JSON.stringify({ query: script.searchQuery ?? title }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '够了，开始汇总。' }, finish_reason: 'stop' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      // 汇总阶段
      const content =
        script.rawReport ??
        JSON.stringify(
          script.report ?? {
            summary: `${title} 的结论`,
            findings: ['要点一', '要点二'],
            sources: [{ title: '真结果2', url: 'https://real2.example.com/a' }],
            confidence: 'high',
          },
        );
      return new Response(
        JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    } finally {
      state.llmInFlight -= 1;
    }
  }) as typeof fetch;
}

const tasks = (titles: string[]): WorkerTaskSpec[] =>
  titles.map((t) => ({ title: t, instruction: `把「${t}」查清楚并给出要点`, context: '发起方已有的资料' }));

async function main(): Promise<void> {
  log('=== 多智能体编排 · S4 临时工运行时验收 ===');

  // ---------------------------------------------------------------- ① 并行与上限
  log('');
  log('--- ① 真并行 + 并发上限 ---');
  {
    const titles = ['A家竞品', 'B家竞品', 'C家竞品', 'D家竞品', 'E家竞品'];
    const state: StubState = {
      scripts: Object.fromEntries(titles.map((t) => [t, { searchRounds: 1 }])),
      llmInFlight: 0,
      llmPeak: 0,
      llmCalls: 0,
      tavilyQueries: [],
      tavilyEnabled: true,
      llmDelayMs: 30,
    };
    installStub(state);
    const batch = await runWorkerPool({
      env: ENV,
      jobId: 'job_t1',
      tasks: tasks(titles),
      allowSearch: true,
      concurrency: 3,
      perWorkerTimeoutMs: 20_000,
      budgetMs: 60_000,
      maxSearchRounds: 2,
    });
    await check('5 个任务全部回来，顺序与入参一致', () => {
      assert.equal(batch.reports.length, 5);
      assert.deepEqual(
        batch.reports.map((r) => r.title),
        titles,
      );
      assert.deepEqual(
        batch.reports.map((r) => r.id),
        ['w1', 'w2', 'w3', 'w4', 'w5'],
      );
      assert.equal(batch.okCount, 5);
      assert.equal(batch.failCount, 0);
    });
    await check('并发峰值 ≤ 3（WORKER_CONCURRENCY 真的生效，不是 5 路一起打上游）', () => {
      assert.ok(state.llmPeak <= 3, `峰值 ${state.llmPeak} > 3`);
      assert.ok(state.llmPeak >= 2, `峰值 ${state.llmPeak}，看起来没有真并行`);
    });
    await check('每个工人各搜了 1 轮（Tavily 收到 5 条查询，与任务一一对应）', () => {
      assert.deepEqual(state.tavilyQueries.sort(), [...titles].sort());
    });
    await check('汇报结构完整（summary/findings/sources/confidence/tookMs 都有）', () => {
      const r = batch.reports[0];
      assert.equal(r.status, 'ok');
      assert.equal(typeof r.summary, 'string');
      assert.ok(r.findings.length > 0);
      assert.ok(r.sources.length > 0);
      assert.equal(r.confidence, 'high');
      assert.ok(r.tookMs >= 0);
    });
  }

  // ---------------------------------------------------------------- ② 失败隔离
  log('');
  log('--- ② 单个失败/超时**不影响**同批 ---');
  {
    const titles = ['正常甲', '会挂住的乙', '正常丙'];
    const state: StubState = {
      scripts: {
        正常甲: { searchRounds: 0 },
        会挂住的乙: { hang: true },
        正常丙: { searchRounds: 0 },
      },
      llmInFlight: 0,
      llmPeak: 0,
      llmCalls: 0,
      tavilyQueries: [],
      tavilyEnabled: true,
      llmDelayMs: 30,
    };
    installStub(state);
    const batch = await runWorkerPool({
      env: ENV,
      jobId: 'job_t2',
      tasks: tasks(titles),
      allowSearch: true,
      concurrency: 3,
      perWorkerTimeoutMs: 1_200, // 让「挂住」那个快速超时
      budgetMs: 30_000,
      maxSearchRounds: 1,
    });
    await check('挂住的那个报 timeout，另外两个照样 ok', () => {
      assert.equal(batch.reports[0].status, 'ok', '甲不该受影响');
      assert.equal(batch.reports[1].status, 'timeout');
      assert.equal(batch.reports[2].status, 'ok', '丙不该受影响');
      assert.equal(batch.okCount, 2);
      assert.equal(batch.failCount, 1);
      assert.ok(/没有假装完成/.test(batch.reports[1].error ?? ''), '超时话术要如实');
    });
  }
  {
    const titles = ['正常丁', '会500的戊'];
    const state: StubState = {
      scripts: { 正常丁: { searchRounds: 0 }, 会500的戊: { http500: true } },
      llmInFlight: 0,
      llmPeak: 0,
      llmCalls: 0,
      tavilyQueries: [],
      tavilyEnabled: true,
      llmDelayMs: 30,
    };
    installStub(state);
    const batch = await runWorkerPool({
      env: ENV,
      jobId: 'job_t3',
      tasks: tasks(titles),
      allowSearch: true,
      concurrency: 2,
      perWorkerTimeoutMs: 20_000,
      budgetMs: 30_000,
      maxSearchRounds: 1,
    });
    await check('模型 500 的那个报 failed 且带原因，同批另一个 ok', () => {
      assert.equal(batch.reports[0].status, 'ok');
      assert.equal(batch.reports[1].status, 'failed');
      assert.ok(/HTTP 500/.test(batch.reports[1].error ?? ''), `error=${batch.reports[1].error}`);
    });
  }

  // ---------------------------------------------------------------- ③ 截断与来源真实性
  log('');
  log('--- ③ 字段截断 + 来源必须真实 ---');
  {
    const longSummary = '很长'.repeat(400); // 800 字
    const manyFindings = Array.from({ length: 30 }, (_, i) => `要点${i}`.padEnd(250, '长'));
    const state: StubState = {
      scripts: {
        超长汇报: {
          searchRounds: 1,
          report: {
            summary: longSummary,
            findings: manyFindings,
            sources: [
              { title: '真结果2', url: 'https://real2.example.com/a' }, // 搜索真的返回过
              { title: '编的', url: 'https://made-up.example.com/lie' }, // **没**返回过
              { title: '不是网址', url: 'javascript:alert(1)' },
            ],
            confidence: 'medium',
          },
        },
      },
      llmInFlight: 0,
      llmPeak: 0,
      llmCalls: 0,
      tavilyQueries: [],
      tavilyEnabled: true,
      llmDelayMs: 30,
    };
    installStub(state);
    const batch = await runWorkerPool({
      env: ENV,
      jobId: 'job_t4',
      tasks: tasks(['超长汇报']),
      allowSearch: true,
      concurrency: 1,
      perWorkerTimeoutMs: 20_000,
      budgetMs: 30_000,
      maxSearchRounds: 2,
    });
    const r = batch.reports[0];
    await check('summary 截到 300 字以内', () => {
      assert.ok([...r.summary].length <= 300, `实际 ${[...r.summary].length}`);
    });
    await check('findings 截到 8 条、每条 200 字以内', () => {
      assert.equal(r.findings.length, 8);
      for (const f of r.findings) assert.ok([...f].length <= 200, `有一条 ${[...f].length} 字`);
    });
    await check('编造的来源被过滤掉（只留搜索真的返回过的）', () => {
      assert.equal(r.sources.length, 1);
      assert.equal(r.sources[0].url, 'https://real2.example.com/a');
      assert.equal(r.sources[0].domain, 'real2.example.com');
    });
  }

  // ---------------------------------------------------------------- ④ 敏感闸
  log('');
  log('--- ④ 敏感 query 不外发（R1 同一套闸） ---');
  {
    const state: StubState = {
      // 剧本里让模型去搜一个含密码的 query —— 这条查询必须被本地闸拦下，一条都不许外发
      scripts: { 敏感任务: { searchRounds: 1, searchQuery: '我的密码是Secret123' } },
      llmInFlight: 0,
      llmPeak: 0,
      llmCalls: 0,
      tavilyQueries: [],
      tavilyEnabled: true,
      llmDelayMs: 30,
    };
    installStub(state);
    await runWorkerPool({
      env: ENV,
      jobId: 'job_t5',
      tasks: tasks(['敏感任务']),
      allowSearch: true,
      concurrency: 1,
      perWorkerTimeoutMs: 20_000,
      budgetMs: 30_000,
      maxSearchRounds: 1,
    });
    await check('含密码的查询**没有**发给第三方（Tavily 桩 0 条）', () => {
      assert.deepEqual(state.tavilyQueries, [], `外发了：${JSON.stringify(state.tavilyQueries)}`);
    });
  }

  // ---------------------------------------------------------------- ⑤ 降级
  log('');
  log('--- ⑤ 未配置 Tavily / 不允许搜索 → 降级为纯推理，不报错 ---');
  {
    const state: StubState = {
      scripts: { 降级任务: { searchRounds: 1 } },
      llmInFlight: 0,
      llmPeak: 0,
      llmCalls: 0,
      tavilyQueries: [],
      tavilyEnabled: false, // Tavily 回 401
    };
    installStub(state);
    const batch = await runWorkerPool({
      env: { ...ENV, tavilyApiKey: '' }, // 未配置 → 本地拒绝外呼
      jobId: 'job_t6',
      tasks: tasks(['降级任务']),
      allowSearch: true,
      concurrency: 1,
      perWorkerTimeoutMs: 20_000,
      budgetMs: 30_000,
      maxSearchRounds: 1,
    });
    await check('未配置时不外呼、汇报照样回来（status=ok，sources 空）', () => {
      assert.deepEqual(state.tavilyQueries, []);
      assert.equal(batch.reports[0].status, 'ok');
      assert.equal(batch.reports[0].sources.length, 0);
    });
  }
  {
    const state: StubState = {
      scripts: { 纯推理: { searchRounds: 5 } },
      llmInFlight: 0,
      llmPeak: 0,
      llmCalls: 0,
      tavilyQueries: [],
      tavilyEnabled: true,
      llmDelayMs: 30,
    };
    installStub(state);
    const batch = await runWorkerPool({
      env: ENV,
      jobId: 'job_t7',
      tasks: tasks(['纯推理']),
      allowSearch: false,
      concurrency: 1,
      perWorkerTimeoutMs: 20_000,
      budgetMs: 30_000,
      maxSearchRounds: 2,
    });
    await check('allowSearch=false 时一次都不搜（模型拿不到搜索工具）', () => {
      assert.deepEqual(state.tavilyQueries, []);
      assert.equal(batch.reports[0].status, 'ok');
      assert.equal(state.llmCalls, 1, '只有汇总那一次模型调用');
    });
  }

  // ---------------------------------------------------------------- ⑥ 脏汇报
  log('');
  log('--- ⑥ 汇报不是合法 JSON：如实 failed，不假装成功 ---');
  {
    const state: StubState = {
      scripts: { 脏汇报: { searchRounds: 0, rawReport: '我觉得答案是这样的……（模型没按格式来）' } },
      llmInFlight: 0,
      llmPeak: 0,
      llmCalls: 0,
      tavilyQueries: [],
      tavilyEnabled: true,
      llmDelayMs: 30,
    };
    installStub(state);
    const batch = await runWorkerPool({
      env: ENV,
      jobId: 'job_t8',
      tasks: tasks(['脏汇报']),
      allowSearch: true,
      concurrency: 1,
      perWorkerTimeoutMs: 20_000,
      budgetMs: 30_000,
      maxSearchRounds: 1,
    });
    await check('status=failed + 原文截断保留在 summary + 原因写明', () => {
      const r = batch.reports[0];
      assert.equal(r.status, 'failed');
      assert.ok(/模型没按格式来/.test(r.summary), '原文该保留');
      assert.ok(/不是合法 JSON/.test(r.error ?? ''));
    });
  }
  await check('extractJson 容忍 ```json 围栏与前后废话', () => {
    const a = extractJson('好的，结果如下：\n```json\n{"summary":"x","confidence":"high"}\n```\n希望有帮助');
    assert.equal(a?.summary, 'x');
    assert.equal(extractJson('完全不是 JSON'), null);
    assert.equal(extractJson(''), null);
  });

  log('');
  log('=== 结论 ===');
  log(`  ${passes} PASS / ${fails} FAIL`);
  if (fails > 0) process.exitCode = 1;
}

void main();
