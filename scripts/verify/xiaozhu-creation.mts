/**
 * G1（2026-09-25）· 管家专权创建 · 验收
 *
 * 用户标准（规格 C1·G1 收紧）：
 *   ② 非小助会话发「创建 XXX」→ 不建 + 回「这个由管家来建,我转给它」+ 转发进小助会话;左栏不新增、meta 无 newAgent
 *   ④ 小助说「建一个 XXX」→ 立刻建好（保留 chips/newAgent 流）
 *   ③ 「＋添加」只在小助上下文生效:服务端 POST /agents 调用者只放 assistant（母鸡当调用者 → 403）
 *   ⑤ 首进空项目（新账号默认项目）→ 小助主动提议搭团队
 *
 * 全部走**真实生产代码路径**：
 *   · 建号 = buildApp 真 Fastify + app.inject() 走 /auth/sms/send + /auth/login/sms（SMS mock）
 *   · 聊天 = POST /chat/stream（真 SSE,app.inject 读回）
 *   · 建人 = POST /agents（真权限闸）
 *   · 读会话/名单 = 真库查询（content 用 cipher 解密,真数据非写死）
 *
 * 用法：npx tsx scripts/verify/xiaozhu-creation.mts
 */
import assert from 'node:assert/strict';
import { loadEnv } from '../../apps/server/src/env';
import { makeCipher } from '../../apps/server/src/crypto';
import { makePool, migrate } from '../../apps/server/src/db';
import { buildApp } from '../../apps/server/src/index';

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

/** 解析 /chat/stream 的 SSE 帧（同 build-agent-e2e 口径） */
function parseSse(raw: string): { meta: any; deltaText: string; done: any } {
  let meta: any = null;
  let deltaText = '';
  let done: any = null;
  for (const ln of raw.split('\n')) {
    const d = ln.startsWith('data:') ? ln.slice(5).trim() : null;
    if (!d || d === '[DONE]') continue;
    let json: any;
    try {
      json = JSON.parse(d);
    } catch {
      continue;
    }
    if (json && json.conversationId !== undefined && json.userMessageId !== undefined) meta = json;
    if (json && typeof json.delta === 'string') deltaText += json.delta;
    if (json && json.contentLength !== undefined && json.searches !== undefined) done = json;
  }
  return { meta, deltaText, done };
}

async function main(): Promise<void> {
  log('=== G1 · 管家专权创建 · 验收 ===');
  process.env.DATABASE_URL ??= 'pglite://memory';
  process.env.JWT_SECRET ??= 'verify-xiaozhu-creation-jwt-secret';
  process.env.DATA_KEY ??= 'b'.repeat(64);
  process.env.PHONE_PEPPER ??= 'verify-xiaozhu-creation-pepper';
  process.env.SMS_MOCK ??= '1';
  process.env.DEEPSEEK_API_KEY ??= 'test-key';
  process.env.DEEPSEEK_BASE_URL ??= 'https://llm.test/v1';
  process.env.DEEPSEEK_MODEL ??= 'test-model';
  const env = loadEnv();
  const cipher = makeCipher(env.dataKey);
  const pool = makePool('pglite://memory');
  await migrate(pool);
  const app = await buildApp(env, pool, cipher);
  const H = { 'content-type': 'application/json' };

  // ---------------------------------------------------------- 建号（真 auth 路径）
  const phone = '139' + String(Date.now()).slice(-8);
  const sj = await app.inject({ method: 'POST', url: '/auth/sms/send', headers: H, payload: JSON.stringify({ phone }) });
  const mockCode = (sj.json() as { mock_code?: string }).mock_code;
  const lj = await app.inject({ method: 'POST', url: '/auth/login/sms', headers: H, payload: JSON.stringify({ phone, code: mockCode }) });
  const token = (lj.json() as { token?: string }).token;
  assert.ok(token, '登录没拿到 token');
  const AH = { ...H, authorization: `Bearer ${token}` };

  const listAgents = async () => (
    (await app.inject({ method: 'GET', url: '/agents', headers: AH })).json() as { agents: Array<{ id: number; name: string; kind: string; personaStatus?: string }> }
  );
  /** 读某个智能体会话里的 assistant 消息（真库,解密） */
  const assistantMsgs = async (agentId: number): Promise<string[]> => {
    const r = await pool.query<{ id: string }>(
      `SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.agent_id = $1 AND m.role = 'assistant'`,
      [agentId],
    );
    const out: string[] = [];
    for (const row of r.rows) {
      const enc = await pool.query<{ content_enc: string }>('SELECT content_enc FROM messages WHERE id=$1', [row.id]);
      out.push(cipher.decryptText(enc.rows[0].content_enc));
    }
    return out;
  };

  // 默认项目 id（建母鸡项目会把 current_project_id 切走,②④ 前要切回来）
  const projRes = (await app.inject({ method: 'GET', url: '/projects', headers: AH })).json() as {
    currentProjectId: number;
    projects: Array<{ id: number; isDefault?: boolean }>;
  };
  const defaultProjectId = projRes.projects.find((p) => p.isDefault)?.id ?? projRes.currentProjectId;

  const firstList = await listAgents();
  const xiaozhu = firstList.agents.find((a) => a.kind === 'assistant');
  assert.ok(xiaozhu, `新账号没有小助：${JSON.stringify(firstList.agents.map((a) => a.kind))}`);
  const xzId = xiaozhu.id;
  const baseCount = firstList.agents.length;

  // ---------------------------------------------------------------- ⑤ 首进空项目小助主动提议
  log('');
  log('--- ⑤ 首进空项目（新账号默认项目,只有小助）→ 小助主动提议搭团队 ---');
  await check('新账号小助会话里有一条「主动搭团队」的提议（真库,非写死）', async () => {
    const msgs = await assistantMsgs(xzId);
    assert.ok(msgs.length >= 1, '小助会话里没有消息（提议没写进去？）');
    assert.ok(
      msgs.some((m) => m.includes('建议') && (m.includes('同事') || m.includes('建'))),
      `小助没主动提议搭团队，会话内容：${JSON.stringify(msgs).slice(0, 200)}`,
    );
  });

  // ---------------------------------------------------------------- ③ 添加 服务端只放 assistant
  log('');
  log('--- ③ 「＋添加」只在小助上下文生效：服务端 POST /agents 调用者只放 assistant ---');
  // 建一个母鸡项目（只有母鸡,没小助）
  const pj = await app.inject({ method: 'POST', url: '/projects', headers: AH, payload: JSON.stringify({ name: '母鸡边缘项目' }) });
  assert.equal(pj.statusCode, 200, `建母鸡项目失败：${pj.statusCode} ${pj.body.slice(0, 120)}`);
  const henProjectId = (pj.json() as { project: { id: number } }).project.id;
  const henList = ((await app.inject({ method: 'GET', url: `/agents?projectId=${henProjectId}`, headers: AH })).json()) as {
    agents: Array<{ id: number; name: string; kind: string }>;
  };
  const hen = henList.agents.find((a) => a.kind === 'hen');
  assert.ok(hen, '母鸡项目里没找到母鸡');

  await check('母鸡当调用者 POST /agents → 403（只有小助能建）', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: AH,
      payload: JSON.stringify({ asAgentId: hen!.id, name: '越权测试', duty: '测试' }),
    });
    assert.equal(r.statusCode, 403, `母鸡建人应 403,实际 ${r.statusCode} ${r.body.slice(0, 120)}`);
  });

  // 造一个非小助的自建智能体（小助当调用者,合法）→ 供 ② 用
  const createLao = await app.inject({
    method: 'POST',
    url: '/agents',
    headers: AH,
    payload: JSON.stringify({ asAgentId: xzId, name: '老王', duty: '盯仓库补货' }),
  });
  assert.equal(createLao.statusCode, 200, `小助建老王失败：${createLao.statusCode} ${createLao.body.slice(0, 120)}`);
  const laoId = (createLao.json() as { agent: { id: number } }).agent.id;
  await check('小助当调用者 POST /agents → 200（小助能建）', () => {
    assert.ok(laoId, '小助建人没返回 id');
  });

  // 把当前项目切回默认项目（③ 建母鸡项目时切走了）—— ②④ 都在默认项目里发生
  const act = await app.inject({ method: 'POST', url: `/projects/${defaultProjectId}/activate`, headers: AH, payload: '{}' });
  assert.equal(act.statusCode, 200, `切回默认项目失败：${act.statusCode} ${act.body.slice(0, 120)}`);

  // ---------------------------------------------------------------- ② 非小助发「创建」→ 不建 + 转发
  log('');
  log('--- ② 非小助（老王）发「创建小红」→ 不建 + 回「这个由管家来建,我转给它」+ 转发进小助会话 ---');
  const before2 = (await listAgents()).agents.length;
  const r2 = await app.inject({
    method: 'POST',
    url: '/chat/stream',
    headers: AH,
    payload: JSON.stringify({ agentId: laoId, message: '创建小红，帮我盯仓库补货' }),
  });
  const s2 = parseSse(r2.body);
  const after2 = (await listAgents()).agents.length;

  await check('非小助发「创建小红」→ 库里不新增（左栏不新增）', async () => {
    assert.equal(after2, before2, `智能体数量变了 ${before2}→${after2}（不该建）`);
    const names = (await listAgents()).agents.map((a) => a.name);
    assert.ok(!names.includes('小红'), '居然建出了「小红」');
  });
  await check('当前会话（老王）回「这个由管家来建,我转给它」', () => {
    assert.ok(s2.deltaText.includes('这个由管家来建'), `回话不含转发话术：${s2.deltaText.slice(0, 80)}`);
    assert.ok(s2.deltaText.includes('转给它'), `回话不完整：${s2.deltaText.slice(0, 80)}`);
  });
  await check('SSE meta 不带 newAgent（左栏不新增的数据源）', () => {
    assert.ok(s2.meta, '没拿到 SSE meta');
    assert.equal(s2.meta.newAgent, undefined, 'meta 不该带 newAgent');
  });
  await check('小助主会话流里有一条「转发」记录（含「小红」）', async () => {
    const msgs = await assistantMsgs(xzId);
    assert.ok(
      msgs.some((m) => m.includes('转发') && m.includes('小红')),
      `小助会话里没有转发记录：${JSON.stringify(msgs.slice(-3)).slice(0, 200)}`,
    );
  });

  // ---------------------------------------------------------------- ④ 小助发「创建」→ 立刻建好
  log('');
  log('--- ④ 小助发「创建小红」→ 立刻建好 + meta 带 newAgent（左栏现真名） ---');
  const before4 = (await listAgents()).agents.length;
  const r4 = await app.inject({
    method: 'POST',
    url: '/chat/stream',
    headers: AH,
    payload: JSON.stringify({ agentId: xzId, message: '创建小红，帮我盯仓库补货' }),
  });
  const s4 = parseSse(r4.body);
  const list4 = (await listAgents()).agents;
  const xiaohong = list4.find((a) => a.name === '小红');

  await check('小助发「创建小红」→ 库里真多出「小红」（左栏现真名）', () => {
    assert.equal(list4.length, before4 + 1, `数量 ${before4}→${list4.length}（应 +1）`);
    assert.ok(xiaohong, '没建出「小红」');
    assert.equal(xiaohong!.kind, 'custom', '小红应是 custom');
  });
  await check('回话「已建好「小红」…」', () => {
    assert.ok(s4.deltaText.includes('已建好「小红」'), `回话不对：${s4.deltaText.slice(0, 80)}`);
  });
  await check('SSE meta 带 newAgent（id/name 对得上,左栏数据源）', () => {
    assert.ok(s4.meta?.newAgent, 'meta 没带 newAgent');
    assert.equal(Number(s4.meta.newAgent.id), xiaohong!.id, 'newAgent.id 对不上');
    assert.equal(s4.meta.newAgent.name, '小红', 'newAgent.name 对不上');
  });
  await check('新智能体 duty 从原话提取（真数据）', async () => {
    const p = ((await app.inject({ method: 'GET', url: `/agents/${xiaohong!.id}/persona`, headers: AH })).json() as {
      persona: { duty?: string } | null;
    }).persona;
    assert.ok(p?.duty && p.duty.includes('盯仓库补货'), `duty 没提取对：${JSON.stringify(p)}`);
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
