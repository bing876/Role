/**
 * G2（2026-09-25）· 小助默认身份 + anti-jobs + 整份人设 · 验收
 *
 * 用户标准：
 *   - 描述 = 整份人设（description 就是完整人设正文，读回逐字一致）
 *   - 每个 agent 增「不干什么」标准栏（antiJobs，chips/解析/落库/注入全链路）
 *   - 小助建号即带用户给的「小助配置」整份人设 + anti-jobs
 *
 * 全部走**真实生产代码路径**：
 *   · 建号 = buildApp 起真 Fastify 实例 + app.inject() 走 /auth/sms/send + /auth/login/sms（SMS mock）
 *   · 读回 = GET /agents + GET /agents/:id/persona 真接口
 *   · 注入 = buildIdentityBlock 真函数（拼系统提示词那份）
 *   · 回填 = migrate() 真迁移（存量小助 persona=NULL → 补默认）
 *
 * 用法：npx tsx scripts/verify/xiaozhu-persona.mts
 */
import assert from 'node:assert/strict';
import { loadEnv } from '../../apps/server/src/env';
import { makeCipher } from '../../apps/server/src/crypto';
import { makePool, migrate } from '../../apps/server/src/db';
import { buildApp } from '../../apps/server/src/index';
import { buildIdentityBlock, validatePersonaInput } from '../../apps/server/src/identityBlock';
import { XIAOZHU_PERSONA } from '../../apps/server/src/coordinatorPersona';

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

async function main(): Promise<void> {
  log('=== G2 · 小助默认身份 + anti-jobs + 整份人设 · 验收 ===');

  // loadEnv 的必填项（verify 环境没有 .env）；SMS mock 走响应体回码
  process.env.DATABASE_URL ??= 'pglite://memory';
  process.env.JWT_SECRET ??= 'verify-xiaozhu-persona-jwt-secret';
  process.env.DATA_KEY ??= 'a'.repeat(64);
  process.env.PHONE_PEPPER ??= 'verify-xiaozhu-persona-pepper';
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

  // ---------------------------------------------------------------- 建号（真 auth 路径）
  const phone = '138' + String(Date.now()).slice(-8);
  const sj = await app.inject({ method: 'POST', url: '/auth/sms/send', headers: H, payload: JSON.stringify({ phone }) });
  const mockCode = (sj.json() as { mock_code?: string }).mock_code;
  const lj = await app.inject({ method: 'POST', url: '/auth/login/sms', headers: H, payload: JSON.stringify({ phone, code: mockCode }) });
  const token = (lj.json() as { token?: string }).token;
  const AH = { ...H, authorization: `Bearer ${token}` };

  const listRes = await app.inject({ method: 'GET', url: '/agents', headers: AH });
  const agents = (listRes.json() as { agents: Array<{ id: number; name: string; kind: string }> }).agents;
  const xiaozhu = agents.find((a) => a.kind === 'assistant');

  log('');
  log('--- ① 新账号小助建号即带整份人设 + anti-jobs（真 auth 路径 + 真接口读回）---');

  await check('新账号有小助（kind=assistant）', () => {
    assert.ok(xiaozhu, `没找到小助：${JSON.stringify(agents.map((a) => a.kind))}`);
  });

  await check('读回小助人设 = 整份人设（description 逐字）+ anti-jobs + 是谁/怎么说话/干什么', async () => {
    if (!xiaozhu) throw new Error('小助不存在');
    const r = await app.inject({ method: 'GET', url: `/agents/${xiaozhu.id}/persona`, headers: AH });
    assert.equal(r.statusCode, 200);
    const p = (r.json() as { persona: typeof XIAOZHU_PERSONA | null }).persona;
    assert.ok(p, '小助人设读回是 null（建号没写进去？）');
    assert.equal(p.description, XIAOZHU_PERSONA.description, 'description 与整份人设不一致');
    assert.equal(p.antiJobs, XIAOZHU_PERSONA.antiJobs, 'antiJobs 与配置不一致');
    assert.equal(p.who, XIAOZHU_PERSONA.who, 'who 与配置不一致');
    assert.equal(p.tone, XIAOZHU_PERSONA.tone, 'tone 与配置不一致');
    assert.equal(p.duty, XIAOZHU_PERSONA.duty, 'duty 与配置不一致');
    assert.ok(p.description.includes('只有小助能创建智能体'), '整份人设里应有「只有小助能创建智能体」');
    assert.ok(p.antiJobs.includes('不抢专员'), 'anti-jobs 里应有「不抢专员」');
  });

  // ---------------------------------------------------------------- 注入（buildIdentityBlock 真函数）
  log('');
  log('--- ② 小助系统提示词含管家身份 + 不干什么 + 整份人设（buildIdentityBlock 真函数）---');

  await check('buildIdentityBlock（小助 + 存库人设）含管家/总协调 + 不干什么 + 整份人设全文', async () => {
    if (!xiaozhu) throw new Error('小助不存在');
    const r = await app.inject({ method: 'GET', url: `/agents/${xiaozhu.id}/persona`, headers: AH });
    const p = (r.json() as { persona: typeof XIAOZHU_PERSONA | null }).persona;
    const block = buildIdentityBlock({ id: xiaozhu.id, name: '小助', kind: 'assistant', persona: p, personaStatus: 'ready' });
    assert.ok(block.includes('管家') && block.includes('总协调'), `小助身份块缺「管家/总协调」：${block.slice(0, 80)}`);
    assert.ok(block.includes('不干什么：'), `小助身份块缺「不干什么」行：${block.slice(0, 120)}`);
    assert.ok(block.includes(XIAOZHU_PERSONA.description), '小助身份块缺整份人设全文');
  });

  await check('buildIdentityBlock（小助 + persona=null，存量账号）回落同一份默认配置', () => {
    const block = buildIdentityBlock({ id: 1, name: '小助', kind: 'assistant', persona: null, personaStatus: 'ready' });
    assert.ok(block.includes('管家') && block.includes('总协调'), '存量小助（persona=null）回落默认身份失败');
    assert.ok(block.includes(XIAOZHU_PERSONA.description), '存量小助回落默认应含整份人设');
    assert.ok(block.includes('不干什么：'), '存量小助回落默认应含「不干什么」');
  });

  // ---------------------------------------------------------------- 解析/校验链路（antiJobs + description 全链路）
  log('');
  log('--- ③ anti-jobs / 整份人设 解析·校验·读回链路 ---');

  await check('validatePersonaInput 支持填「不干什么」+「整份人设」（可填可空）', () => {
    const withAll = validatePersonaInput({ name: '小美', who: 'w', tone: 't', duty: 'd', antiJobs: '不碰敏感操作', description: '小美是只盯店铺的专员。' });
    assert.equal(withAll.ok, true, withAll.ok ? '' : withAll.error);
    if (withAll.ok) {
      assert.equal(withAll.persona.antiJobs, '不碰敏感操作', 'validatePersonaInput 丢了 antiJobs');
      assert.equal(withAll.persona.description, '小美是只盯店铺的专员。', 'validatePersonaInput 丢了 description');
    }
    const without = validatePersonaInput({ name: '老王', who: 'w', tone: 't', duty: 'd' });
    assert.equal(without.ok, true);
    if (without.ok) {
      assert.equal(without.persona.antiJobs, undefined, '没填 antiJobs 应保持空');
      assert.equal(without.persona.description, undefined, '没填 description 应保持空');
    }
  });

  await check('自建智能体填「不干什么」+「整份人设」→ 落库 + 读回一致（chips/POST persona 链路）', async () => {
    if (!xiaozhu) throw new Error('小助不存在');
    // 建一个自建智能体（小助当调用者）
    const cr = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: AH,
      payload: JSON.stringify({ asAgentId: xiaozhu.id, name: '小美', duty: '盯店铺数据', antiJobs: '不碰花钱操作', description: '小美是只盯店铺数据的专员。' }),
    });
    assert.equal(cr.statusCode, 200, `建自建智能体失败：${cr.statusCode} ${cr.body.slice(0, 120)}`);
    const customId = (cr.json() as { agent: { id: number } }).agent.id;
    // chips 答完 → POST persona 细化（带 antiJobs + description）
    const r = await app.inject({
      method: 'POST',
      url: `/agents/${customId}/persona`,
      headers: AH,
      payload: JSON.stringify({ name: '小美', who: '改过的 who', tone: '改过的 tone', duty: '改过的 duty', antiJobs: '改过的不干什么', description: '改过的整份人设' }),
    });
    assert.equal(r.statusCode, 200, `POST persona 失败：${r.statusCode} ${r.body.slice(0, 120)}`);
    const g = await app.inject({ method: 'GET', url: `/agents/${customId}/persona`, headers: AH });
    const p = (g.json() as { persona: { antiJobs?: string; description?: string } | null }).persona;
    assert.equal(p?.antiJobs, '改过的不干什么', 'antiJobs 读回不一致');
    assert.equal(p?.description, '改过的整份人设', 'description 读回不一致');
  });

  // ---------------------------------------------------------------- 存量回填（真迁移）
  log('');
  log('--- ④ 存量小助（persona=NULL）启动迁移回填默认（只补 NULL，不覆盖改过的）---');

  await check('migrate 把 persona=NULL 的小助补成默认配置，且不动已改过的小助', async () => {
    // 造两只小助：一只 persona=NULL（老账号），一只 persona=已改过（不能被动）
    await pool.query(`INSERT INTO users (id, xyz_id, phone_hash) VALUES (9001, 'x-9001', 'h-9001'), (9002, 'x-9002', 'h-9002') ON CONFLICT (id) DO NOTHING`);
    await pool.query(`INSERT INTO projects (id, user_id, name, is_default) VALUES (9101, 9001, '老项目', true), (9102, 9002, '改过项目', true) ON CONFLICT (id) DO NOTHING`);
    await pool.query(`INSERT INTO agents (id, project_id, name, kind, persona, persona_status, can_create_agents) VALUES
        (9201, 9101, '小助', 'assistant', NULL, 'ready', true),
        (9202, 9102, '小助', 'assistant', '{"name":"小助","who":"用户改过的 who","tone":"t","duty":"d"}', 'ready', true)`);
    await migrate(pool); // 幂等迁移：只补 persona=NULL 的 9201
    const r1 = await pool.query<{ persona: unknown }>('SELECT persona FROM agents WHERE id=9201');
    const r2 = await pool.query<{ persona: unknown }>('SELECT persona FROM agents WHERE id=9202');
    const p1 = r1.rows[0].persona as { who?: string; description?: string; antiJobs?: string };
    const p2 = r2.rows[0].persona as { who?: string };
    assert.ok(p1 && p1.description === XIAOZHU_PERSONA.description, `NULL 小助没回填成默认：${JSON.stringify(p1)?.slice(0, 80)}`);
    assert.ok(p1 && p1.antiJobs === XIAOZHU_PERSONA.antiJobs, 'NULL 小助回填缺 antiJobs');
    assert.equal(p2?.who, '用户改过的 who', '已改过的小助被迁移覆盖了（红线：只补 NULL）');
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
