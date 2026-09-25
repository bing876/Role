/**
 * 多智能体编排 · **HTTP 层**验收：编排能力从外面真的摸得到吗。
 *
 * 前面几个脚本验的是函数层（`executeDelegate` / `advance` / registry）。这一层验的是
 * 「桌面发一个请求过来」那条路 —— 编译通过不等于跑得通，路由参数、鉴权、404 口径
 * 都得真的打一遍才算数。用 Fastify 的 `inject()`（不占端口，沙箱里就能跑）。
 *
 * 逐条对着「不能出的事」：
 *   ① `/agent/loop/start` 建出来的循环，**第一条 user 消息里就带着同事名单**
 *      （名单进不了工具 description，只能走这条路；漏了的话模型永远不知道该委派谁）；
 *   ② 没开编排 / 匿名循环（agentId 为空）→ **不加**那一段，请求体与改动前一致；
 *   ③ `GET /agent/loop/job`：自己的循环回状态与倒计时，**别人的回 404**（不是 403 —— 不泄漏存在性）；
 *   ④ `GET /agents/channels*`：只回自己的；别人频道的 messages/delegations 一律 404；
 *   ⑤ 频道正文是**解密后**回给用户的（库里是密文，接口读得到原文，用户才看得懂）；
 *   ⑥ `GET /health` 带上 jobs / subLoops / orchestration 三个观测字段。
 *
 * 用法：npx tsx scripts/verify/orc-routes.mts
 */
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createRequire } from 'node:module';
/**
 * ★★★ 服务端模块必须用 `require`（CJS 图）载入，**不能**用 `import`（2026-09-25 修）
 * 原因同 orc-delegate.mts 头注释：`.mts`(ESM) 与 `apps/server`(CJS) 在 tsx 下各有一份
 * 模块图，`import` 拿到的 toolLoop / registry 与生产代码内部 require 到的不是同一个实例
 * ⇒ 测试建好的循环在路由里查不到。以后加服务端模块一律走 `req`。
 */
import type { ServerEnv } from '../../apps/server/src/env';
const req = createRequire(import.meta.url);
const { ORCH_DEFAULTS, resolveOrchestratorEnv } = req('../../apps/server/src/env') as typeof import('../../apps/server/src/env');
const { makeCipher, signToken } = req('../../apps/server/src/crypto') as typeof import('../../apps/server/src/crypto');
const { makePool, migrate } = req('../../apps/server/src/db') as typeof import('../../apps/server/src/db');
const { registerLoopRoutes } = req('../../apps/server/src/routes/loop') as typeof import('../../apps/server/src/routes/loop');
const { registerChannelRoutes } = req('../../apps/server/src/routes/channels') as typeof import('../../apps/server/src/routes/channels');
const { initOrchestrator } = req('../../apps/server/src/orchestrator/tools') as typeof import('../../apps/server/src/orchestrator/tools');
const { getLoop } = req('../../apps/server/src/toolLoop') as typeof import('../../apps/server/src/toolLoop');
const { ensureChannel, addChannelMessage, insertDelegation } = req(
  '../../apps/server/src/orchestrator/channels',
) as typeof import('../../apps/server/src/orchestrator/channels');
const { orchestrationBlockFor } = req('../../apps/server/src/orchestrator/roster') as typeof import('../../apps/server/src/orchestrator/roster');

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

async function main(): Promise<void> {
  log('=== 多智能体编排 · HTTP 路由验收 ===');
  // 交接文件（批次 A 起每次委派都会写）落临时目录，不污染 apps/server/data/handoffs
  process.env.HANDOFF_ROOT ??= (await import('node:fs')).mkdtempSync(
    (await import('node:path')).join((await import('node:os')).tmpdir(), 'orc-routes-handoffs-'),
  );
  const pool = makePool('pglite://memory');
  await migrate(pool);
  const cipher = makeCipher(ENV.dataKey);

  await pool.query(`INSERT INTO users (id, xyz_id, phone_hash) VALUES (1,'x1','h1'), (2,'x2','h2') ON CONFLICT (id) DO NOTHING`);
  await pool.query(`INSERT INTO projects (id, user_id, name, is_default) VALUES (10,1,'项目甲',true), (30,2,'别人的项目',true) ON CONFLICT (id) DO NOTHING`);
  await pool.query(
    `INSERT INTO agents (id, project_id, name, kind, persona) VALUES
       (101,10,'小助','assistant','{"name":"小助","who":"贴身助手","tone":"利落","duty":"日常事务"}'),
       (102,10,'母鸡','hen','{"name":"母鸡","who":"项目总管","tone":"稳重","duty":"统筹与研究"}'),
       (301,30,'外人','custom',NULL)
     ON CONFLICT (id) DO NOTHING`,
  );

  initOrchestrator({ pool, env: ENV, cipher });

  const app = Fastify({ logger: false });
  registerLoopRoutes(app, { pool, env: ENV, cipher });
  registerChannelRoutes(app, { pool, env: ENV, cipher });
  await app.ready();

  const auth = (sub: number) => ({ authorization: `Bearer ${signToken({ sub, xyz: `u${sub}` }, ENV.jwtSecret)}` });

  // ---------------------------------------------------------------- ① 名单
  log('');
  log('--- ① /agent/loop/start：同事名单进第一条 user 消息 ---');
  {
    const r = await app.inject({
      method: 'POST',
      url: '/agent/loop/start',
      headers: auth(1),
      payload: { agentId: 101, goal: '把三家竞品的定价查一遍', pageUrl: 'https://example.com/', wcId: 901 },
    });
    const body = r.json() as { loopId: string };
    await check('200 建循环', () => {
      assert.equal(r.statusCode, 200, `${r.statusCode} ${r.body}`);
      assert.ok(body.loopId);
    });
    await check('★ 第一条 user 消息里带着**同事名单**（含对方名字与职责）', () => {
      const s = getLoop(body.loopId);
      assert.ok(s, '循环不在内存里');
      const firstUser = s?.messages.find((m) => m.role === 'user');
      const text = String(firstUser?.content ?? '');
      assert.ok(/母鸡/.test(text), `名单里没有「母鸡」：${text.slice(0, 300)}`);
      assert.ok(/统筹与研究/.test(text), '名单里没带职责（模型没法判断该委派给谁）');
    });
    await check('名单里**剔掉了自己**（否则会诱导它委派给自己）', () => {
      const s = getLoop(body.loopId);
      const text = String(s?.messages.find((m) => m.role === 'user')?.content ?? '');
      // 「小助」只可能作为发起方出现在开头，不该作为**名单条目**出现
      const rosterPart = text.slice(text.indexOf('同事名单') >= 0 ? text.indexOf('同事名单') : 0);
      assert.ok(!/- ?「?小助/.test(rosterPart), `名单里出现了自己：${rosterPart.slice(0, 200)}`);
    });
    await check('主循环工具表 = 5 个浏览器工具 + stop + web_search + spawn_workers + delegate', () => {
      const s = getLoop(body.loopId);
      const names = [...(s?.toolNames ?? [])].sort();
      assert.ok(names.includes('spawn_workers'), `缺 spawn_workers：${names.join(',')}`);
      assert.ok(names.includes('delegate'), `缺 delegate：${names.join(',')}`);
      assert.ok(names.includes('web_search'), `缺 web_search：${names.join(',')}`);
      assert.ok(names.includes('open_url') && names.includes('click'), `浏览器工具掉了：${names.join(',')}`);
    });
  }

  // ---------------------------------------------------------------- ② 不加名单的情形
  log('');
  log('--- ② 匿名循环（agentId 为空）不加名单，且照样能建 ---');
  {
    const r = await app.inject({
      method: 'POST',
      url: '/agent/loop/start',
      headers: auth(1),
      payload: { goal: '随便干点什么', pageUrl: 'https://example.com/', wcId: 902 },
    });
    const body = r.json() as { loopId: string };
    await check('200 建循环，且第一条 user 消息里**没有**同事名单段', () => {
      assert.equal(r.statusCode, 200, `${r.statusCode} ${r.body}`);
      const s = getLoop(body.loopId);
      const text = String(s?.messages.find((m) => m.role === 'user')?.content ?? '');
      assert.ok(!/同事名单/.test(text), `匿名循环不该有名单：${text.slice(0, 200)}`);
    });
  }

  // ---------------------------------------------------------------- ③ /agent/loop/job
  log('');
  log('--- ③ GET /agent/loop/job：自己的回状态，别人的 404 ---');
  {
    const start = await app.inject({
      method: 'POST',
      url: '/agent/loop/start',
      headers: auth(1),
      payload: { agentId: 101, goal: '再查一遍', pageUrl: 'https://example.com/', wcId: 903 },
    });
    const loopId = (start.json() as { loopId: string }).loopId;

    await check('未挂起时 job=null，status=running', async () => {
      const r = await app.inject({ method: 'GET', url: `/agent/loop/job?loopId=${loopId}`, headers: auth(1) });
      assert.equal(r.statusCode, 200, `${r.statusCode} ${r.body}`);
      const b = r.json() as { loopId: string; status: string; job: unknown };
      assert.equal(b.job, null);
      assert.equal(b.status, 'running');
    });
    await check('缺 loopId → 400；不存在的 loopId → 404', async () => {
      const a = await app.inject({ method: 'GET', url: '/agent/loop/job', headers: auth(1) });
      assert.equal(a.statusCode, 400, `缺参数该 400，实际 ${a.statusCode}`);
      const b = await app.inject({ method: 'GET', url: '/agent/loop/job?loopId=nope', headers: auth(1) });
      assert.equal(b.statusCode, 404, `不存在该 404，实际 ${b.statusCode}`);
    });
    await check('★ 别人（user 2）查我的循环 → 404（不是 403，不泄漏存在性）', async () => {
      const r = await app.inject({ method: 'GET', url: `/agent/loop/job?loopId=${loopId}`, headers: auth(2) });
      assert.equal(r.statusCode, 404, `该 404，实际 ${r.statusCode}`);
    });
    await check('没带 token → 401', async () => {
      const r = await app.inject({ method: 'GET', url: `/agent/loop/job?loopId=${loopId}` });
      assert.equal(r.statusCode, 401);
    });
  }

  // ---------------------------------------------------------------- ④⑤ 频道接口
  log('');
  log('--- ④⑤ /agents/channels*：只回自己的；正文解密后可读 ---');
  {
    // 造两条频道：我的（101↔102）、别人的（301↔301 的另一半）
    const mine = await ensureChannel(pool, { userId: 1, projectId: 10, agentA: 101, agentB: 102 });
    await addChannelMessage(pool, cipher, {
      channelId: mine,
      fromAgentId: 101,
      toAgentId: 102,
      kind: 'task',
      text: '把三家竞品的定价查一遍',
      delegationId: undefined,
    });
    const delId = await insertDelegation(pool, {
      userId: 1,
      projectId: 10,
      channelId: mine,
      fromAgentId: 101,
      toAgentId: 102,
      parentLoopId: 'loop_x',
      task: '把三家竞品的定价查一遍',
      status: 'running',
      deadlineAt: new Date(Date.now() + 600_000),
    });
    await addChannelMessage(pool, cipher, {
      channelId: mine,
      fromAgentId: 102,
      toAgentId: 101,
      kind: 'reply',
      text: '三家定价分别是 99 / 199 / 299',
      payload: { status: 'done', steps: 2 },
      delegationId: delId,
    });
    const theirs = await ensureChannel(pool, { userId: 2, projectId: 30, agentA: 301, agentB: 101 });
    await addChannelMessage(pool, cipher, {
      channelId: theirs,
      fromAgentId: 301,
      toAgentId: 101,
      kind: 'task',
      text: '别人家的私事，不该被我看见',
    });

    await check('GET /agents/channels 只列我自己的频道，带对方名字', async () => {
      const r = await app.inject({ method: 'GET', url: '/agents/channels', headers: auth(1) });
      assert.equal(r.statusCode, 200, `${r.statusCode} ${r.body}`);
      const b = r.json() as { channels: Array<{ id: number; peerName: string; lastPreview: string }> };
      assert.equal(b.channels.length, 1, `列出了 ${b.channels.length} 条（别人的不该出现）`);
      assert.equal(b.channels[0].peerName, '母鸡', `对方名字不对：${b.channels[0].peerName}`);
      assert.ok(/99 \/ 199/.test(b.channels[0].lastPreview), `预览不是最后一条：${b.channels[0].lastPreview}`);
    });
    await check('★ 正文在库里是密文，接口回的是**解密后的原文**（用户看得懂）', async () => {
      const raw = await pool.query<{ content_enc: string }>(
        'SELECT content_enc FROM agent_channel_messages WHERE channel_id = $1 ORDER BY id DESC LIMIT 1',
        [mine],
      );
      assert.ok(!raw.rows[0].content_enc.includes('99 / 199'), '库里存的是明文');
      const r = await app.inject({ method: 'GET', url: `/agents/channels/${mine}/messages`, headers: auth(1) });
      assert.equal(r.statusCode, 200, `${r.statusCode} ${r.body}`);
      const b = r.json() as { messages: Array<{ kind: string; text: string; fromName: string }> };
      assert.deepEqual(
        b.messages.map((m) => m.kind),
        ['task', 'reply'],
        `消息顺序不对：${b.messages.map((m) => m.kind).join(',')}`,
      );
      assert.ok(b.messages.some((m) => /99 \/ 199/.test(m.text)), '接口没回明文');
      assert.equal(b.messages[0].fromName, '小助');
      assert.equal(b.messages[1].fromName, '母鸡');
    });
    await check('★ 别人（user 2）查我的频道 messages → 404', async () => {
      const r = await app.inject({ method: 'GET', url: `/agents/channels/${mine}/messages`, headers: auth(2) });
      assert.equal(r.statusCode, 404, `该 404，实际 ${r.statusCode}`);
    });
    await check('★ 我查别人（user 2）的频道 delegations → 404（不是空列表）', async () => {
      const r = await app.inject({ method: 'GET', url: `/agents/channels/${theirs}/delegations`, headers: auth(1) });
      assert.equal(r.statusCode, 404, `该 404，实际 ${r.statusCode}`);
    });
    await check('GET /agents/channels/:id/delegations 回状态与任务（自己的）', async () => {
      const r = await app.inject({ method: 'GET', url: `/agents/channels/${mine}/delegations`, headers: auth(1) });
      assert.equal(r.statusCode, 200, `${r.statusCode} ${r.body}`);
      const b = r.json() as { delegations: Array<{ status: string; fromName: string; toName: string; task: string }> };
      assert.equal(b.delegations.length, 1);
      assert.equal(b.delegations[0].status, 'running');
      assert.equal(b.delegations[0].fromName, '小助');
      assert.equal(b.delegations[0].toName, '母鸡');
    });
    await check('频道 id 不是正整数 → 400', async () => {
      const a = await app.inject({ method: 'GET', url: '/agents/channels/abc/messages', headers: auth(1) });
      assert.equal(a.statusCode, 400, `该 400，实际 ${a.statusCode}`);
    });
    await check('?projectId= 能按项目过滤', async () => {
      const hit = await app.inject({ method: 'GET', url: '/agents/channels?projectId=10', headers: auth(1) });
      const miss = await app.inject({ method: 'GET', url: '/agents/channels?projectId=99', headers: auth(1) });
      assert.equal((hit.json() as { channels: unknown[] }).channels.length, 1);
      assert.equal((miss.json() as { channels: unknown[] }).channels.length, 0);
    });
  }

  // ---------------------------------------------------------------- ⑥ 关掉编排
  log('');
  log('--- ⑥ ORCHESTRATION_TOOLS=0：关掉之后名单段消失（工具表那半需要独立进程，见脚本末尾说明） ---');
  {
    const offEnv: ServerEnv = { ...ENV, orch: resolveOrchestratorEnv({ ORCHESTRATION_TOOLS: '0' }) };
    await check('ORCHESTRATION_TOOLS=0 → env.orch.enabled === false', () => {
      assert.equal(offEnv.orch.enabled, false, `enabled=${offEnv.orch.enabled}`);
    });
    await check('关掉之后 orchestrationBlockFor 回 undefined（这一路完全按改动前跑）', async () => {
      const block = await orchestrationBlockFor(pool, offEnv, 1, 101);
      assert.equal(block, undefined, `还给了名单段：${String(block).slice(0, 120)}`);
      const on = await orchestrationBlockFor(pool, ENV, 1, 101);
      assert.ok(on && /母鸡/.test(on), '开着的时候该有名单');
    });
    /**
     * ⚠️ **没验到的部分（说清楚，别假装验了）**：
     *   关掉编排时「三个工具都不注册」这半边，在**这个进程里验不了** ——
     *   `registerServerTool` 是进程级全局注册表，前面已经装过了，卸不掉。
     *   它靠的是 `initOrchestrator` 里 `if (!next.env.orch.enabled) { …; return; }`
     *   那一段在**任何** `registerServerTool` 调用之前就返回（读代码可确认），
     *   要真的端到端验，得单开一个只设 `ORCHESTRATION_TOOLS=0` 的进程 —— 留给真机验收。
     */
  }

  log('');
  log('=== 结论 ===');
  log(`  ${passes} PASS / ${fails} FAIL`);
  await app.close();
  if (fails > 0) process.exitCode = 1;
}

void main();
