/**
 * 收尾片 ④ · 折叠卡/确认卡「服务端触发口」· 真库验收
 *
 * 用户标准（一句话/一插入即触发，全走真库真路径）：
 *   ① 折叠卡：本地一句话（新会话、没指定智能体）路由到别的智能体 → 服务端
 *      `logRouteDecision` 把【协同·路由】写进对方会话 → 前端渲染成折叠卡。
 *      触发口 = chat 路由闸（routeTask + logRouteDecision），G3 两处入口同源。
 *   ② 确认卡：真库插一条 pending 记忆（走统一写口 writeMemoryRow + 真加密）→
 *      刷新（GET /memories）→ pending 槽里就有它 → 前端渲染成确认卡。
 *      触发口 = 记忆写口（status=pending）+ 列表口（pending 槽）。
 *
 * 桩模型：只答 chat 主调用的回复（一句固定话）。路由走**字面高置信**
 * （keyword_weighted，top 分≥阈值）→ 不触发语义层、不额外花桩调用，
 * 但触发口（routeTask + logRouteDecision）一字不差地走真代码。
 *
 * 用法：npx tsx scripts/verify/card-trigger.mts
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadEnv } from '../../apps/server/src/env';
import { makeCipher } from '../../apps/server/src/crypto';
import { makePool, migrate } from '../../apps/server/src/db';
import { buildApp } from '../../apps/server/src/index';
import { routeTask, logRouteDecision } from '../../apps/server/src/orchestrator/chiefOfStaff';
import { writeMemoryRow } from '../../apps/server/src/memoryShared';

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
    log(`      ${(err as Error)?.message?.split('\n').slice(0, 4).join('\n      ') ?? String(err)}`);
  }
};

/** 桩模型：任何 chat 主调用都回一句固定话（非流式 JSON）。 */
function startStub(): Promise<{ port: number; close: () => void }> {
  const srv = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += String(c)));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '收到，我先整理一下。' } }] }));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as { port: number }).port, close: () => srv.close() }));
  });
}

async function main(): Promise<void> {
  log('=== 收尾片 ④ · 折叠卡/确认卡 服务端触发口 · 真库验收 ===');

  const stub = await startStub();
  process.env.DATABASE_URL ??= 'pglite://memory';
  process.env.JWT_SECRET ??= 'verify-card-trigger-jwt';
  process.env.DATA_KEY ??= 'd'.repeat(64);
  process.env.PHONE_PEPPER ??= 'verify-card-trigger-pepper';
  process.env.SMS_MOCK ??= '1';
  process.env.DEEPSEEK_API_KEY ??= 'stub-key';
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${stub.port}/v1`;
  process.env.DEEPSEEK_MODEL ??= 'stub-model';
  const env = loadEnv();
  const cipher = makeCipher(env.dataKey);
  const pool = makePool('pglite://memory');
  await migrate(pool);
  const app = await buildApp(env, pool, cipher);
  const H = { 'content-type': 'application/json' };

  // 建号（真 auth）
  const phone = '137' + String(Date.now()).slice(-8);
  const sj = await app.inject({ method: 'POST', url: '/auth/sms/send', headers: H, payload: JSON.stringify({ phone }) });
  const code = (sj.json() as { mock_code?: string }).mock_code;
  const lj = await app.inject({ method: 'POST', url: '/auth/login/sms', headers: H, payload: JSON.stringify({ phone, code }) });
  const token = (lj.json() as { token?: string }).token;
  const userId = Number((lj.json() as { userId?: number }).userId ?? 1);
  const AH = { ...H, authorization: `Bearer ${token}` };

  const proj = (await app.inject({ method: 'GET', url: '/projects', headers: AH })).json() as { currentProjectId: number };
  const pid = proj.currentProjectId;
  const agents0 = ((await app.inject({ method: 'GET', url: `/agents?projectId=${pid}`, headers: AH })).json()) as {
    agents: Array<{ id: number; name: string; kind: string }>;
  };
  const xz = agents0.agents.find((a) => a.kind === 'assistant');
  assert.ok(xz, '新账号没有小助');

  // 造一个「数据分析师」：duty 与「帮我搜索竞品分析市场数据」字面高重合 → keyword_weighted 高置信命中
  const mk = async (name: string, duty: string, description: string) => {
    const r = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: AH,
      payload: JSON.stringify({ asAgentId: xz!.id, name, duty, description }),
    });
    assert.equal(r.statusCode, 200, `建 ${name} 失败：${r.statusCode} ${r.body.slice(0, 120)}`);
    return (r.json() as { agent: { id: number } }).agent.id;
  };
  const analystId = await mk('数据分析师', '搜索竞品并分析市场数据，输出调研报告', '负责市场调研与数据分析。');
  log(`  项目 #${pid}：小助 #${xz!.id} / 数据分析师 #${analystId}`);

  /** 轮询 GET /chat/history，直到出现含子串的消息（logRouteDecision 是 fire-and-forget，给它落地时间） */
  const waitCollab = async (agentId: number, substr: string, rounds = 60): Promise<string | null> => {
    for (let i = 0; i < rounds; i++) {
      const hj = (await app.inject({ method: 'GET', url: '/chat/history', headers: AH, query: { agentId: String(agentId) } })).json() as {
        messages?: Array<{ role?: string; content?: string; text?: string }>;
      };
      const msgs = hj.messages ?? [];
      const hit = msgs.find((m) => {
        const t = m.content ?? m.text ?? '';
        return typeof t === 'string' && t.includes(substr);
      });
      if (hit) return String(hit.content ?? hit.text ?? '');
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  };

  log('');
  log('--- ① 折叠卡触发口：本地一句话（新会话）路由到别的智能体 → 【协同·路由】落进对方会话 ---');
  // POST /chat/stream 是 SSE（app.inject 等流结束会挂），所以直接打**触发口本身**
  // （routeTask + logRouteDecision = chat 路由闸调的那两个真函数），再静态钉死 chat 路径确实接了它们。
  await check('本地一句话「帮我搜索竞品分析市场数据」→ routeTask 路由到数据分析师（字面高置信）', async () => {
    const decision = await routeTask(pool, userId, pid, '帮我搜索竞品分析市场数据', { explicitAgentId: null, currentAgentId: null, env });
    assert.ok(decision, 'routeTask 没路由出来');
    assert.equal(decision.toAgentId, analystId, `应路由到数据分析师 #${analystId},实际 ${decision.toAgentId}`);
    // 触发口：把这次路由决策写进对方会话（折叠卡素材）
    await logRouteDecision(pool, cipher, decision, '帮我搜索竞品分析市场数据', '管家路由');
  });
  await check('触发口真的写进对方会话：数据分析师的 /chat/history 里出现【协同·路由】（折叠卡素材）', async () => {
    const line = await waitCollab(analystId, '【协同·路由】');
    assert.ok(line, '数据分析师会话里没有【协同·路由】—— 路由触发口没落库（折叠卡无料可渲染）');
    assert.match(line, /数据分析师/, `【协同·路由】里该有被路由到的智能体（数据分析师）：${line}`);
    assert.match(line, /帮我搜索竞品分析市场数据/, `【协同·路由】里该有任务原文（折叠卡展开要看的那句）：${line}`);
  });
  await check('chat 路由闸确实接了触发口（源码里 POST /chat/stream 的路由分支调 logRouteDecision）', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../apps/server/src/routes/chat.ts', import.meta.url), 'utf8');
    assert.ok(src.includes("logRouteDecision(pool, cipher, decision, message, '管家路由')"), 'chat 路由闸没接 logRouteDecision（触发口断链）');
    assert.ok(src.includes('routeTask(pool, claims.sub, curProj, message'), 'chat 路由闸没调 routeTask（路由闸没了）');
  });

  log('');
  log('--- ② 确认卡触发口：真库插一条 pending 记忆（统一写口 + 真加密）→ 刷新即在 pending 槽 ---');
  await check('writeMemoryRow 插一条 pending 记忆（type=decision、needs_confirm、真加密落库）', async () => {
    const enc = cipher.encryptText('以后调研默认只看竞品近 30 天数据');
    const written = await writeMemoryRow({
      pool,
      cipher,
      ownerId: userId,
      agentId: null,
      conversationId: null,
      memKey: 'decision.research_window',
      contentEnc: enc,
      type: 'decision',
      source: 'chat',
      status: 'pending',
      needsConfirm: true,
    });
    assert.equal(written, 1, `写入返回 ${written}（应为 1）`);
  });
  await check('刷新（GET /memories）：pending 槽里就是那条记忆（确认卡素材），且内容真解得回来', async () => {
    const mj = (await app.inject({ method: 'GET', url: '/memories', headers: AH })).json() as {
      pending?: Array<{ id?: number; type?: string; content?: string }>;
    };
    const pend = mj.pending ?? [];
    assert.ok(pend.length >= 1, `pending 槽是空的（刷新后确认卡无料可渲染）：${JSON.stringify(mj).slice(0, 160)}`);
    const hit = pend.find((m) => String(m.content ?? '').includes('近 30 天'));
    assert.ok(hit, `pending 里没有那条记忆：${JSON.stringify(pend).slice(0, 160)}`);
    assert.equal(hit?.type, 'decision', `类型不对：${hit?.type}`);
    assert.match(String(hit?.content ?? ''), /近 30 天/, `pending 记忆内容解不回来（真加密没走通）：「${hit?.content}」`);
  });
  await check('pending 未确认绝不注入行为（active 槽里没有它）—— 要确认才生效', async () => {
    const mj = (await app.inject({ method: 'GET', url: '/memories', headers: AH })).json() as {
      active?: Array<{ content?: string }>;
    };
    const act = mj.active ?? [];
    assert.ok(!act.some((m) => String(m.content ?? '').includes('近 30 天')), 'pending 记忆混进了 active 槽（没确认就生效了）');
  });

  log('');
  log('=== 结论 ===');
  log(`  ${passes} PASS / ${fails} FAIL`);
  if (fails > 0) process.exitCode = 1;
  await app.close();
  stub.close();
}

void main();
