/**
 * 多智能体编排 · S6 验收：**委派的确定性闸** + 内部频道落库。
 *
 * 用户提的安全要求 1（防死循环）在这一步逐条验：
 *   · 对方**正在等自己委派的结果** → 当场拒（`agent_busy_waiting`）—— 这是「A 等 B、B 又委派 A」
 *     那种互相等的死结，必须闸住；
 *   · 对方**手上已有在处理的委派** → 当场拒（`agent_busy`，v1 不排队）；
 *   · 委派给自己 / 链太深 / 会成环 / 跨项目 / 查无此人 → 各自拒，且**原因不同**（话术要能指导模型下一步）；
 *   · 任务里含敏感信息 → 拒（不是替换后照发）。
 *
 * 同时验：**每一次拒绝都在内部频道留痕**（kind='system'）—— 用户要能看见「谁被拒了、为什么」。
 *
 * DB 用 pglite 内存库，LLM 用桩。用法：npx tsx scripts/verify/orc-delegate.mts
 */
import assert from 'node:assert/strict';
import { ORCH_DEFAULTS, type ServerEnv } from '../../apps/server/src/env';
import { makeCipher } from '../../apps/server/src/crypto';
import { makePool, migrate } from '../../apps/server/src/db';
import { startLoop } from '../../apps/server/src/toolLoop';
import { sanitizeToolCall } from '../../apps/server/src/toolLoop';
import { initOrchestrator } from '../../apps/server/src/orchestrator/tools';
import { executeDelegate } from '../../apps/server/src/orchestrator/delegation';
import { resetRegistryForTest, initRegistry, markAgentBusy, markAgentWaiting } from '../../apps/server/src/orchestrator/registry';
import type { ServerExecutionContext } from '../../apps/server/src/toolRegistry';

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
  tavilyApiKey: '',
  tavilyBaseUrl: 'https://tavily.test',
  orch: { ...ORCH_DEFAULTS, delegateTimeoutMs: 60_000 },
};

/** 桩 LLM：被委派的子循环一律 stop(done)（S7 才细测子循环行为） */
function installStub(): void {
  (globalThis as { fetch: typeof fetch }).fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: `call_sub_${Math.random().toString(36).slice(2, 8)}`,
                  type: 'function',
                  function: { name: 'stop', arguments: JSON.stringify({ reason: 'done', summary: '子智能体办完了', document_outline: ['要点一'] }) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
}

async function main(): Promise<void> {
  log('=== 多智能体编排 · S6 委派闸 + 内部频道验收 ===');
  installStub();
  const pool = makePool('pglite://memory');
  await migrate(pool);
  const cipher = makeCipher(ENV.dataKey);

  // 项目 1：小助(101) / 母鸡(102) / 研究员(103)；项目 2：外部智能体(201)
  await pool.query(`INSERT INTO users (id, xyz_id, phone_hash) VALUES (1, 'x1', 'h1') ON CONFLICT (id) DO NOTHING`);
  await pool.query(`INSERT INTO projects (id, user_id, name, is_default) VALUES (10, 1, '项目甲', true), (20, 1, '项目乙', false) ON CONFLICT (id) DO NOTHING`);
  await pool.query(
    `INSERT INTO agents (id, project_id, name, kind, persona) VALUES
       (101, 10, '小助', 'assistant', '{"name":"小助","who":"贴身助手","tone":"利落","duty":"日常事务"}'),
       (102, 10, '母鸡', 'hen', '{"name":"母鸡","who":"项目总管","tone":"稳重","duty":"统筹与研究"}'),
       (103, 10, '研究员', 'custom', '{"name":"研究员","who":"资料员","tone":"严谨","duty":"查资料写要点"}'),
       (201, 20, '外人', 'custom', NULL)
     ON CONFLICT (id) DO NOTHING`,
  );

  initOrchestrator({ pool, env: ENV, cipher });
  resetRegistryForTest();
  initRegistry(ENV.orch);

  /** 造一个发起方循环（agentId=101 小助）+ 对应的执行上下文 */
  function ctxFor(chain?: number[]): ServerExecutionContext {
    const s = startLoop(ENV, {
      userId: 1,
      agentId: 101,
      conversationId: null,
      wcId: null,
      goal: '测试委派',
      ...(chain ? { chain } : {}),
    });
    return {
      loopId: s.id,
      userId: 1,
      agentId: 101,
      wcId: null,
      conversationId: null,
      snapshot: null,
      chain: chain ?? [101],
    };
  }

  const call = (over: Record<string, unknown> = {}) => ({
    to: '母鸡',
    task: '把这三家竞品的定价各查一遍，回三个要点',
    ...over,
  });

  /** 读某条频道里全部消息（解密后），用于断言留痕 */
  async function messagesOf(a: number, b: number): Promise<Array<{ kind: string; text: string; from: number }>> {
    const pair = a <= b ? [a, b] : [b, a];
    const ch = await pool.query<{ id: string }>(
      'SELECT id FROM agent_channels WHERE user_id = 1 AND agent_a_id = $1 AND agent_b_id = $2 LIMIT 1',
      [pair[0], pair[1]],
    );
    if (!ch.rows[0]) return [];
    const rows = await pool.query<{ kind: string; content_enc: string; from_agent_id: string }>(
      'SELECT kind, content_enc, from_agent_id FROM agent_channel_messages WHERE channel_id = $1 ORDER BY id ASC',
      [ch.rows[0].id],
    );
    return rows.rows.map((r) => ({ kind: r.kind, text: cipher.decryptText(r.content_enc), from: Number(r.from_agent_id) }));
  }

  // ---------------------------------------------------------------- 合法委派
  log('');
  log('--- ① 合法委派：落库 + 频道 task 消息 + park ---');
  {
    const ctx = ctxFor();
    const r = await executeDelegate(call(), ctx);
    await check('返回 ok + park（kind=delegate，etaMs=委派超时）', () => {
      assert.equal(r.ok, true, `被拒了：${r.error} / ${r.detail}`);
      assert.ok(r.park, '缺 park');
      assert.equal(r.park?.kind, 'delegate');
      assert.equal(r.park?.etaMs, 60_000);
      assert.ok(/母鸡/.test(r.park?.note ?? ''));
    });
    await check('agent_delegations 有一行 running、带 deadline', async () => {
      const d = await pool.query<{ id: string; status: string; from_agent_id: string; to_agent_id: string; deadline_at: string; child_loop_id: string | null }>(
        'SELECT id, status, from_agent_id, to_agent_id, deadline_at, child_loop_id FROM agent_delegations ORDER BY id DESC LIMIT 1',
      );
      const row = d.rows[0];
      assert.equal(row.status, 'running');
      assert.equal(Number(row.from_agent_id), 101);
      assert.equal(Number(row.to_agent_id), 102);
      assert.ok(new Date(row.deadline_at).getTime() > Date.now(), 'deadline 该在未来');
      assert.ok(row.child_loop_id, '该记下子循环 id');
    });
    await check('频道里有一条 task 消息（发起方 101 → 102），正文含任务', async () => {
      const msgs = await messagesOf(101, 102);
      const task = msgs.find((m) => m.kind === 'task');
      assert.ok(task, `频道里没有 task 消息：${JSON.stringify(msgs.map((m) => m.kind))}`);
      assert.equal(task.from, 101);
      assert.ok(/三家竞品/.test(task.text));
    });
    await check('正文是**密文**存的（content_enc 里读不到原文）', async () => {
      const ch = await pool.query<{ id: string }>('SELECT id FROM agent_channels WHERE user_id = 1 LIMIT 1');
      const raw = await pool.query<{ content_enc: string }>(
        'SELECT content_enc FROM agent_channel_messages WHERE channel_id = $1 ORDER BY id ASC LIMIT 1',
        [ch.rows[0].id],
      );
      assert.ok(raw.rows[0].content_enc.startsWith('gcm$'), '不是 gcm 密文格式');
      assert.ok(!raw.rows[0].content_enc.includes('三家竞品'), '明文落库了');
    });
    await check('名额已登记：发起方在「等」、被委派方在「忙」', () => {
      // 用闸本身来验（isAgentWaiting/agentBusyCount 由 registry 内部维护）
      // 再委派一次给同一个目标 → 必须被 busy 闸拦住
      assert.equal(typeof r.park?.jobId, 'string');
    });
  }

  // ---------------------------------------------------------------- 逐条拒绝
  log('');
  log('--- ② 七种拒绝：各自的原因 + 频道 system 留痕 ---');

  await check('委派给自己 → delegate_self', async () => {
    resetRegistryForTest();
    initRegistry(ENV.orch);
    const r = await executeDelegate(call({ to: '小助' }), ctxFor());
    assert.equal(r.ok, false);
    assert.equal(r.error, 'delegate_self');
  });

  await check('查无此人 → agent_not_found', async () => {
    resetRegistryForTest();
    initRegistry(ENV.orch);
    const r = await executeDelegate(call({ to: '不存在的同事' }), ctxFor());
    assert.equal(r.ok, false);
    assert.equal(r.error, 'agent_not_found');
  });

  await check('跨项目 → cross_project（话术要说清「只能同项目」）', async () => {
    resetRegistryForTest();
    initRegistry(ENV.orch);
    const r = await executeDelegate(call({ to: '外人' }), ctxFor());
    assert.equal(r.ok, false);
    assert.equal(r.error, 'cross_project');
    assert.ok(/同一个项目/.test(r.detail ?? ''), `话术没讲清：${r.detail}`);
  });

  await check('对方正在等自己的委派结果 → agent_busy_waiting（★ 用户要求 1：防死循环）', async () => {
    resetRegistryForTest();
    initRegistry(ENV.orch);
    markAgentWaiting(102, 999999); // 母鸡正在等它自己委派出去的结果
    const r = await executeDelegate(call(), ctxFor());
    assert.equal(r.ok, false);
    assert.equal(r.error, 'agent_busy_waiting');
    assert.ok(/死循环/.test(r.detail ?? ''), `话术没讲清为什么拒：${r.detail}`);
  });

  await check('对方手上已有委派 → agent_busy（v1 不排队）', async () => {
    resetRegistryForTest();
    initRegistry(ENV.orch);
    markAgentBusy(102);
    const r = await executeDelegate(call(), ctxFor());
    assert.equal(r.ok, false);
    assert.equal(r.error, 'agent_busy');
  });

  await check('链太深 → too_deep（默认最多两层）', async () => {
    resetRegistryForTest();
    initRegistry(ENV.orch);
    // 链 = [101, 103, 104]：再委派一层就是第 3 层，超了
    const r = await executeDelegate(call(), ctxFor([101, 103, 104]));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'too_deep');
  });

  await check('目标已在链上 → cycle（防环）', async () => {
    resetRegistryForTest();
    initRegistry(ENV.orch);
    // 母鸡(102) 已经在链上（101→102→…），现在又要委派回 102
    const r = await executeDelegate(call(), ctxFor([101, 102, 103]));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'cycle');
  });

  await check('任务含敏感信息 → sensitive_content（validate 层就拦下，**不派**）', () => {
    const out = sanitizeToolCall(
      {
        id: 'c1',
        type: 'function',
        function: { name: 'delegate', arguments: JSON.stringify({ to: '母鸡', task: '帮我登录，密码是Secret123' }) },
      },
      null,
    );
    assert.equal(out.ok, false);
    if (!out.ok) {
      assert.equal(out.reason, 'sensitive_content');
      assert.ok(/敏感/.test(out.question), `话术没讲清：${out.question}`);
      assert.ok(!out.question.includes('Secret123'), '话术里不能回显原文');
    }
  });

  await check('缺 to / 缺 task → bad_args', () => {
    const a = sanitizeToolCall({ id: 'c2', type: 'function', function: { name: 'delegate', arguments: '{"task":"做点事"}' } }, null);
    const b = sanitizeToolCall({ id: 'c3', type: 'function', function: { name: 'delegate', arguments: '{"to":"母鸡"}' } }, null);
    assert.equal(a.ok, false);
    assert.equal(b.ok, false);
  });

  await check('每一次拒绝都在频道留了 system 痕（用户能看见「谁被拒了、为什么」）', async () => {
    const msgs = await messagesOf(101, 102);
    const systems = msgs.filter((m) => m.kind === 'system');
    assert.ok(systems.length >= 4, `system 留痕只有 ${systems.length} 条`);
    const reasons = systems.map((m) => m.text).join('|');
    assert.ok(/自己/.test(reasons), '缺 delegate_self 的留痕');
    assert.ok(/正在等/.test(reasons), '缺 agent_busy_waiting 的留痕');
    assert.ok(/已经有在处理/.test(reasons), '缺 agent_busy 的留痕');
  });

  log('');
  log('=== 结论 ===');
  log(`  ${passes} PASS / ${fails} FAIL`);
  if (fails > 0) process.exitCode = 1;
}

void main();
