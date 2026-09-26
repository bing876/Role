/**
 * 2026-09-25 主动发现(P-1/P-2/P-3)验收:写路径的「真相」+ 空 body 宽容
 *
 * 三个根因都在服务端写路径上(真库 + 生产代码本身,不 mock):
 *   P-3  pglite 池包装把 UPDATE/DELETE/INSERT 的 rowCount 恒算成 0
 *        (res.rows=[] 是 truthy)→ 删定时任务/开关/忘白板全部误 404、计数恒 0
 *   P-2  Fastify 默认 JSON 解析器拒绝「content-type: application/json + 空 body」
 *        → 客户端给 DELETE 带 JSON 头(常见)就删不掉东西
 *   P-1  /memories/confirm|reject 的 changed 报 ids.length 而非真实 rowCount
 *        → 重复确认也谎报「变了 1 条」
 *
 * 用法:npx tsx scripts/verify/routines-lifecycle.mts
 * 反证:routines-lifecycle-revert-proof.py(三处各打一个洞,必须各红一个断言)
 */
import assert from 'node:assert/strict';
import process from 'node:process';
import type { Pool } from 'pg';
import { makePool, migrate } from '../../apps/server/src/db';
import { makeCipher, signToken } from '../../apps/server/src/crypto';
import { createRoutine, setRoutineEnabled, deleteRoutine } from '../../apps/server/src/orchestrator/routines';
import { writeMemoryRow } from '../../apps/server/src/memoryShared';
import { postWhiteboard, confirmWhiteboard } from '../../apps/server/src/orchestrator/whiteboard';
import { loadEnv } from '../../apps/server/src/env';
import { buildApp } from '../../apps/server/src/index';

let passes = 0;
let fails = 0;
const log = (...a: unknown[]): void => console.log(a.map(String).join(' '));
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passes += 1;
    log(`  ✓ ${name}`);
  } catch (err) {
    fails += 1;
    log(`  ✗ ${name}`);
    log(`      ${(err as Error).message.split('\n').slice(0, 4).join('\n      ')}`);
  }
}

async function main(): Promise<void> {
  // loadEnv 的必填项(verify 环境没有 .env)
  process.env.DATABASE_URL ??= 'pglite://memory';
  process.env.JWT_SECRET ??= 'verify-lifecycle-jwt-secret';
  process.env.DATA_KEY ??= 'a'.repeat(64);
  process.env.PHONE_PEPPER ??= 'verify-lifecycle-pepper';

  const env = loadEnv();
  const pool = makePool('pglite://memory') as unknown as Pool;
  await migrate(pool);
  const cipher = makeCipher(env.dataKey);

  await pool.query(`INSERT INTO users (id, xyz_id, phone_hash) VALUES (1,'x1','h1') ON CONFLICT (id) DO NOTHING`);
  await pool.query(`INSERT INTO projects (id, user_id, name, is_default) VALUES (10,1,'项目甲',true) ON CONFLICT (id) DO NOTHING`);
  await pool.query(`INSERT INTO agents (id, project_id, name, kind, persona, persona_status, can_create_agents)
                    VALUES (21,10,'管家','hen','{}','ready',true) ON CONFLICT (id) DO NOTHING`);

  log('');
  log('=== 主动发现 P-1/P-2/P-3 · 写路径真相 验收 ===');

  // ---------------------------------------------------------------- P-3 池级(生产函数)
  log('');
  log('--- P-3 写语句的 rowCount 必须是真的(池级) ---');

  const created = await createRoutine(pool, {
    userId: 1, projectId: 10, agentId: 21,
    name: 'P3探针', description: '', triggerType: 'interval',
    triggerConfig: { intervalMinutes: 5 }, taskTemplate: 'P3-打卡',
  });
  const rid = Number(created.id);
  assert.ok(rid > 0, 'createRoutine 没建成');

  await check('setRoutineEnabled(false) → 返回 true 且库里真的 disabled', async () => {
    const ok = await setRoutineEnabled(pool, 1, rid, false);
    assert.equal(ok, true, '返回 false = 旧 bug:rowCount 恒 0 误判"没这行"');
    const r = await pool.query('SELECT enabled FROM agent_routines WHERE id=$1', [rid]);
    assert.equal((r.rows[0] as { enabled: boolean }).enabled, false);
  });

  await check('deleteRoutine → 返回 true 且行真的没了(删定时任务这条 API 的前提)', async () => {
    const ok = await deleteRoutine(pool, 1, rid);
    assert.equal(ok, true, '返回 false = 旧 bug:删不掉,API 永远 404');
    const r = await pool.query('SELECT count(*)::text AS n FROM agent_routines WHERE id=$1', [rid]);
    assert.equal((r.rows[0] as { n: string }).n, '0');
  });

  await check('writeMemoryRow:新 key 返回 1,同 key 撞车返回 0(ON CONFLICT DO NOTHING 的真相)', async () => {
    const enc = cipher.encryptText('P3-记忆探针');
    const n1 = await writeMemoryRow({ pool, cipher, ownerId: 1, agentId: null, conversationId: null, memKey: 'p3-probe', contentEnc: enc, type: 'decision', source: 'verify', status: 'pending', needsConfirm: true });
    assert.equal(n1, 1, '新行没返回 1');
    const n2 = await writeMemoryRow({ pool, cipher, ownerId: 1, agentId: null, conversationId: null, memKey: 'p3-probe', contentEnc: enc, type: 'decision', source: 'verify', status: 'pending', needsConfirm: true });
    assert.equal(n2, 0, '撞车行谎报 1');
  });

  const wb = await postWhiteboard(pool, cipher, { userId: 1, projectId: 10, agentId: 21, content: 'P3-白板探针', needsConfirm: true, source: 'verify' });
  assert.ok(wb, 'postWhiteboard 没建成');
  const wbId = Number(wb.id);

  await check('confirmWhiteboard:第一次返回 1,重复返回 0(不双计)', async () => {
    const c1 = await confirmWhiteboard(pool, 1, 10, [wbId], 'active');
    assert.equal(c1, 1, '第一次确认没返回 1');
    const c2 = await confirmWhiteboard(pool, 1, 10, [wbId], 'active');
    assert.equal(c2, 0, '重复确认谎报 1');
  });

  // ---------------------------------------------------------------- HTTP 级(真实路由,buildApp + inject)
  log('');
  log('--- P-2 空 body + JSON 头的 DELETE → 真删掉;P-1 confirm 的 changed 如实 ---');

  const app = await buildApp(env, pool, cipher);
  const token = signToken({ sub: 1, xyz: 'x1' }, env.jwtSecret);
  const H = { authorization: `Bearer ${token}` };

  const created2 = await createRoutine(pool, {
    userId: 1, projectId: 10, agentId: 21,
    name: 'P2探针', description: '', triggerType: 'interval',
    triggerConfig: { intervalMinutes: 5 }, taskTemplate: 'P2-打卡',
  });
  const rid2 = Number(created2.id);

  await check('P-2:DELETE 带 content-type: application/json 但无 body → 200 且真删掉', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/routines/${rid2}`, headers: { ...H, 'content-type': 'application/json' } });
    assert.equal(res.statusCode, 200, `旧 bug:Fastify 默认解析器回 ${res.statusCode}(FST_ERR_CTP_EMPTY_JSON_BODY)`);
    const r = await pool.query('SELECT count(*)::text AS n FROM agent_routines WHERE id=$1', [rid2]);
    assert.equal((r.rows[0] as { n: string }).n, '0', '返回 200 但行还在 = 假删');
  });

  await check('P-2:坏 JSON body 照旧 400(放宽不放宽过头)', async () => {
    const res = await app.inject({ method: 'POST', url: `/routines`, headers: { ...H, 'content-type': 'application/json' }, payload: '{这不是JSON' });
    assert.ok(res.statusCode === 400, `坏 JSON 应 400,实际 ${res.statusCode}`);
  });

  await check('P-1:/memories/confirm 的 changed = 真实变化条数(第一路 1、重复 0)', async () => {
    const memId = (await pool.query('SELECT id FROM memories WHERE owner_id=1 AND mem_key=$1 ORDER BY id DESC LIMIT 1', ['p3-probe'])).rows[0] as { id: number };
    const r1 = await app.inject({ method: 'POST', url: '/memories/confirm', headers: { ...H, 'content-type': 'application/json' }, payload: JSON.stringify({ ids: [Number(memId.id)] }) });
    assert.equal(r1.statusCode, 200);
    assert.equal(r1.json().changed, 1, `第一次确认应 changed=1,实际 ${r1.json().changed}`);
    const r2 = await app.inject({ method: 'POST', url: '/memories/confirm', headers: { ...H, 'content-type': 'application/json' }, payload: JSON.stringify({ ids: [Number(memId.id)] }) });
    assert.equal(r2.json().changed, 0, `重复确认应 changed=0(旧 bug 报 ids.length=1)`);
  });

  await check('P-3(路由级):/projects/:id/whiteboard/forget → 200 且条目真变 archived', async () => {
    const wb2 = await postWhiteboard(pool, cipher, { userId: 1, projectId: 10, agentId: 21, content: 'P3-忘我', needsConfirm: false, source: 'verify' });
    assert.ok(wb2, 'postWhiteboard 没建成');
    const res = await app.inject({ method: 'POST', url: '/projects/10/whiteboard/forget', headers: { ...H, 'content-type': 'application/json' }, payload: JSON.stringify({ id: Number(wb2.id) }) });
    assert.equal(res.statusCode, 200, `旧 bug:rowCount 恒 0 → 永远 ${res.statusCode}`);
    const r = await pool.query('SELECT status FROM project_whiteboard WHERE id=$1', [Number(wb2.id)]);
    assert.equal((r.rows[0] as { status: string }).status, 'archived');
  });

  log('');
  log(`=== 结论: ${passes} PASS / ${fails} FAIL ===`);
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', (err as Error).message);
  process.exit(2);
});
