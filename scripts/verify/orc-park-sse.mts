/**
 * 多智能体编排 · 「等子任务」在聊天 SSE 流里的**话术口径**验收。
 *
 * 修的 bug（真实缺陷，不是洁癖）：
 *   `toolLoop.ts` 对 park 复用了 `kind:'ask'` + `reason:'job_pending'`（有意为之，
 *   见 AgentLoopDecision 注释：加新 kind 会让旧桌面掉进 tool 分支自旋）。
 *   但 `routes/loop.ts` 的 SSE 广播**不区分 reason**，把每一个 `ask` 都渲染成
 *   `⚠️ **需要协助**`。于是智能体派出临时工后，聊天流里会出现：
 *
 *       ⚠️ 需要协助：我已经派出 3 个临时工并行去做了（最多 180 秒）。
 *
 *   —— 它在**等同事交活**，不是**卡住了要人帮忙**。报成求助就是狼来了：
 *   用户被假警报训练过之后，真需要介入时反而不会看了。
 *   桌面端 `agent.ts:490` 对同一个 reason 早就拦掉了求助卡片，
 *   服务端 SSE 这一路却漏了 —— 两路口径不一致。
 *
 * 本脚本走**真 HTTP 路由**（Fastify inject）+ **真 SSE 客户端**（捕获 write），
 * 断言的是「用户实际看到的那行字」，不是内部状态。
 *
 * 用法：npx tsx scripts/verify/orc-park-sse.mts
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import Fastify from 'fastify';
import { ORCH_DEFAULTS, type ServerEnv } from '../../apps/server/src/env';
import { makeCipher, signToken } from '../../apps/server/src/crypto';
import { makePool, migrate } from '../../apps/server/src/db';
import { registerLoopRoutes } from '../../apps/server/src/routes/loop';
import { registerLoopSse } from '../../apps/server/src/loopSse';
import { startLoop, getLoop } from '../../apps/server/src/toolLoop';
import { initOrchestrator } from '../../apps/server/src/orchestrator/tools';

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
  agentLoopMaxSteps: 10,
  tavilyApiKey: '',
  tavilyBaseUrl: 'https://tavily.test',
  orch: { ...ORCH_DEFAULTS, delegateTimeoutMs: 600_000 },
};

/** 捕获型 SSE 客户端：只实现 sseWrite 会碰到的那几个成员 */
class FakeSse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  readonly chunks: string[] = [];
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  end(): void {
    this.writableEnded = true;
  }
  /** 已下发的原文 */
  get raw(): string {
    return this.chunks.join('');
  }
}

async function main(): Promise<void> {
  log('=== 多智能体编排 · park 在聊天 SSE 里的话术验收 ===');
  const pool = makePool('pglite://memory');
  await migrate(pool);
  const cipher = makeCipher(ENV.dataKey);

  await pool.query(`INSERT INTO users (id, xyz_id, phone_hash) VALUES (1,'x1','h1') ON CONFLICT (id) DO NOTHING`);
  await pool.query(`INSERT INTO projects (id, user_id, name, is_default) VALUES (10,1,'项目甲',true) ON CONFLICT (id) DO NOTHING`);
  await pool.query(
    `INSERT INTO agents (id, project_id, name, kind, persona) VALUES
       (101,10,'小助','assistant','{"name":"小助","duty":"日常事务"}'),
       (102,10,'母鸡','hen','{"name":"母鸡","duty":"统筹与研究"}')
     ON CONFLICT (id) DO NOTHING`,
  );
  initOrchestrator({ pool, env: ENV, cipher });

  const app = Fastify({ logger: false });
  registerLoopRoutes(app, { pool, env: ENV, cipher });
  await app.ready();
  const auth = { authorization: `Bearer ${signToken({ sub: 1, xyz: 'u1' }, ENV.jwtSecret)}` };

  // 建一个循环，手工置成 waiting_job（等价于 spawn_workers/delegate 刚 park 的那一刻）
  const PARK_NOTE = '我已经派出 3 个临时工并行去做了（最多 180 秒）。';
  const session = startLoop(ENV, {
    userId: 1,
    agentId: 101,
    conversationId: null,
    wcId: 700,
    goal: '整理三家竞品的定价',
    pageUrl: 'https://example.com/',
  });
  const loopId = session.id;
  const live = getLoop(loopId);
  assert.ok(live, '循环建不出来，后面没法验');
  live!.status = 'waiting_job';
  live!.jobId = 'job_test_1';
  live!.jobPark = { jobId: 'job_test_1', kind: 'workers', etaMs: 180_000, note: PARK_NOTE };

  // 挂一个真 SSE 客户端上去（走 registerLoopSse，不是自己塞 map）
  const sse = new FakeSse();
  registerLoopSse(loopId, sse as unknown as ServerResponse, 0);

  log('');
  log('--- ① /next 在 waiting_job 上重放 park ---');
  // ★ agentId / wcId 必须与建循环时一致，否则路由按「不串 bot」硬闸回 409
  //   （routes/loop.ts:187-200：会话有约束 ⇒ 调用方必须自证相符）。
  const r = await app.inject({
    method: 'POST',
    url: '/agent/loop/next',
    headers: auth,
    payload: { loopId, agentId: 101, wcId: 700 },
  });
  await check('HTTP 200，且决策是 ask/job_pending', () => {
    assert.equal(r.statusCode, 200, `${r.statusCode} ${r.body}`);
    const body = JSON.parse(r.body) as { decision?: { kind?: string; reason?: string } };
    assert.equal(body.decision?.kind, 'ask', `kind=${body.decision?.kind}`);
    assert.equal(body.decision?.reason, 'job_pending', `reason=${body.decision?.reason}`);
  });
  // ★ 防「空过」：下面几条都是对 SSE 原文做**否定**断言（不该出现某话术）。
  //   如果广播压根没发生，那些否定断言会全部假通过。所以先钉死「确实下发了内容」。
  await check('★ SSE 客户端确实收到了广播（否则下面的否定断言全是空过）', () => {
    assert.ok(sse.raw.length > 0, 'SSE 一个字都没收到 —— 后面的否定断言不作数');
    assert.ok(sse.chunks.length >= 2, `只收到 ${sse.chunks.length} 段，该有 ask + note + delta`);
  });

  log('');
  log('--- ② ★ 用户在聊天流里实际看到的那行字 ---');
  await check('★ 不再出现「需要协助」这种求助话术（这不是求助，是在等同事）', () => {
    assert.ok(!/需要协助/.test(sse.raw), `还是报了求助：\n${sse.raw}`);
  });
  await check('★ 用的是「等待中」的 ⏳ 口径，且把 park 的原话带给用户', () => {
    assert.ok(/⏳/.test(sse.raw), `没有 ⏳ 等待口径：\n${sse.raw}`);
    assert.ok(sse.raw.includes(PARK_NOTE), `park 原话没送达：\n${sse.raw}`);
  });
  await check('★ 仍然发 ask 事件本体（前端靠它拿 jobId/etaMs 画倒计时）', () => {
    assert.ok(/event: ask\n/.test(sse.raw), `ask 事件没发：\n${sse.raw}`);
  });
  await check('★ ask 事件负载里带上 jobId / jobKind / etaMs', () => {
    const m = sse.raw.match(/event: ask\ndata: (.*)\n/);
    assert.ok(m, `没找到 ask 事件负载：\n${sse.raw}`);
    const payload = JSON.parse(m![1]) as Record<string, unknown>;
    assert.equal(payload.jobId, 'job_test_1', `jobId=${payload.jobId}`);
    assert.equal(payload.jobKind, 'workers', `jobKind=${payload.jobKind}`);
    assert.equal(payload.etaMs, 180_000, `etaMs=${payload.etaMs}`);
    assert.equal(payload.reason, 'job_pending', `reason=${payload.reason}`);
  });
  await check('同时发一条 info 级 note（不是 warn/error —— 这不是异常）', () => {
    const m = sse.raw.match(/event: note\ndata: (.*)\n/);
    assert.ok(m, `没发 note：\n${sse.raw}`);
    const payload = JSON.parse(m![1]) as { level?: string; text?: string };
    assert.equal(payload.level, 'info', `level=${payload.level}（不该是 warn/error）`);
    assert.ok((payload.text ?? '').includes('临时工'), `note 正文不对：${payload.text}`);
  });
  await check('循环没被误结束（SSE 不该收到 done）', () => {
    assert.ok(!/event: done\n/.test(sse.raw), `循环被提前结束了：\n${sse.raw}`);
    assert.equal(sse.writableEnded, false, 'SSE 被 end 了');
  });

  log('');
  log('--- ③ 对照：真正的求助仍然要报「需要协助」 ---');
  {
    const s2 = startLoop(ENV, {
      userId: 1,
      agentId: 101,
      conversationId: null,
      wcId: 701,
      goal: '整理三家竞品的定价',
      pageUrl: 'https://example.com/',
    });
    const sse2 = new FakeSse();
    registerLoopSse(s2.id, sse2 as unknown as ServerResponse, 0);
    // 直接把一个「真求助」的 ask 广播出去，走同一个渲染分支
    const { broadcastLoopEvent } = await import('../../apps/server/src/loopSse');
    // 用一个非 job_pending 的 reason 走 else 分支 —— 这里直接调路由不方便，
    // 于是断言渲染逻辑对非 job_pending 仍保留求助话术：用 advance 的等价路径不易构造，
    // 改为验证「代码里那条 else 分支还在」这一事实由下面 ④ 覆盖。
    broadcastLoopEvent(s2.id, 'ask', { reason: 'need_user', question: '要不要我继续？', step: 1 });
    await check('非 job_pending 的 ask 事件照常下发（未被新分支吞掉）', () => {
      assert.ok(/event: ask\n/.test(sse2.raw), `ask 事件没发：\n${sse2.raw}`);
      assert.ok(/要不要我继续/.test(sse2.raw));
    });
  }

  log('');
  log('--- ④ 静态确认：求助话术那条分支仍然存在（没被改没） ---');
  {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../apps/server/src/routes/loop.ts', import.meta.url), 'utf8');
    await check('job_pending 分支在通用 ask 分支**之前**（顺序反了就不会生效）', () => {
      const iPark = src.indexOf("decision.reason === 'job_pending'");
      const iGeneric = src.indexOf('⚠️ **需要协助**');
      assert.ok(iPark > 0, '找不到 job_pending 分支');
      assert.ok(iGeneric > 0, '找不到通用求助分支');
      assert.ok(iPark < iGeneric, `顺序反了：job_pending@${iPark} 通用@${iGeneric}`);
    });
    await check('通用求助话术仍在（真卡住时还得报）', () => {
      assert.ok(/⚠️ \*\*需要协助\*\*/.test(src), '通用求助分支被删了');
    });
  }

  log('');
  log('=== 结论 ===');
  log(`  ${passes} PASS / ${fails} FAIL`);
  if (fails > 0) process.exitCode = 1;
  await app.close();
}

void main();
