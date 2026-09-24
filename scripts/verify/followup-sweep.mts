/**
 * 批次 K | Routines 主动跟进 —— 验收（跑**生产代码本身** `sweepDanglingFollowups`，真 PGlite 库）。
 *
 * 验的四件事：
 *   ① 超期未回的委派（status=running 且 deadline_at 已过）→ 往派单方主会话写一条催办；
 *   ② 长期未恢复的挂起（resumed_at IS NULL 且挂起超阈值）→ 往归属智能体会话写催办（含解密后的目标）；
 *   ③ 不该提醒的（没超期 / 刚提醒过 / 已解决 / 刚挂起 / 已恢复）→ 一条都不写；
 *   ④ 幂等 + 主动：同一时刻重复扫不重复喊；过了提醒间隔后**仍掉线**的会**再**提醒一次。
 *
 * 用法：npx tsx scripts/verify/followup-sweep.mts
 */
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { makePool, migrate } from '../../apps/server/src/db';
import { makeCipher } from '../../apps/server/src/crypto';
import {
  sweepDanglingFollowups,
  PAUSE_STALE_MS_DEFAULT,
  REMIND_EVERY_MS_DEFAULT,
} from '../../apps/server/src/orchestrator/followup';

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
    log(`      ${(err as Error).message.split('\n').slice(0, 3).join('\n      ')}`);
  }
}

async function main(): Promise<void> {
  const pool = makePool('pglite://memory') as unknown as Pool;
  await migrate(pool);
  const cipher = makeCipher('a'.repeat(64));

  // 前置数据：一个用户 / 项目 / 三个智能体 / 派单方与挂起方各一个主会话 / 一条频道
  await pool.query(`INSERT INTO users (id, xyz_id, phone_hash) VALUES (1,'x1','h1') ON CONFLICT (id) DO NOTHING`);
  await pool.query(`INSERT INTO projects (id, user_id, name, is_default) VALUES (10,1,'项目甲',true) ON CONFLICT (id) DO NOTHING`);
  await pool.query(`INSERT INTO agents (id, project_id, name, kind) VALUES (21,10,'派单方','assistant') ON CONFLICT (id) DO NOTHING`);
  await pool.query(`INSERT INTO agents (id, project_id, name, kind) VALUES (22,10,'接单方','worker') ON CONFLICT (id) DO NOTHING`);
  await pool.query(`INSERT INTO agents (id, project_id, name, kind) VALUES (23,10,'挂起方','worker') ON CONFLICT (id) DO NOTHING`);
  await pool.query(`INSERT INTO conversations (id, project_id, agent_id, title) VALUES (101,10,21,'派单方主会话') ON CONFLICT (id) DO NOTHING`);
  await pool.query(`INSERT INTO conversations (id, project_id, agent_id, title) VALUES (103,10,23,'挂起方主会话') ON CONFLICT (id) DO NOTHING`);
  await pool.query(
    `INSERT INTO agent_channels (id, user_id, project_id, agent_a_id, agent_b_id) VALUES (501,1,10,21,22) ON CONFLICT (id) DO NOTHING`,
  );
  await pool.query(`SELECT setval('users_id_seq',100), setval('projects_id_seq',100), setval('agents_id_seq',1000), setval('conversations_id_seq',1000), setval('agent_channels_id_seq',1000)`);

  const now = new Date('2026-09-25T12:00:00.000Z');
  const iso = (ms: number): string => new Date(now.getTime() + ms).toISOString();
  const MIN = 60_000;

  // 委派样本
  await pool.query(
    `INSERT INTO agent_delegations (id,user_id,project_id,channel_id,from_agent_id,to_agent_id,task,status,deadline_at)
     VALUES ($1,1,10,501,21,22,'整理店铺周报','running',$2)`,
    [1001, iso(-5 * MIN)],
  ); // d1 超期未回 → 该提醒
  await pool.query(
    `INSERT INTO agent_delegations (id,user_id,project_id,channel_id,from_agent_id,to_agent_id,task,status,deadline_at)
     VALUES ($1,1,10,501,21,22,'没超期的活','running',$2)`,
    [1002, iso(5 * MIN)],
  ); // d2 没超期 → 不该
  await pool.query(
    `INSERT INTO agent_delegations (id,user_id,project_id,channel_id,from_agent_id,to_agent_id,task,status,deadline_at,last_followed_at)
     VALUES ($1,1,10,501,21,22,'刚提醒过的活','running',$2,$3)`,
    [1003, iso(-5 * MIN), iso(-1 * MIN)],
  ); // d3 超期但 1 分钟前刚提醒过 → 不该（防刷屏）
  await pool.query(
    `INSERT INTO agent_delegations (id,user_id,project_id,channel_id,from_agent_id,to_agent_id,task,status,deadline_at,finished_at,result)
     VALUES ($1,1,10,501,21,22,'已解决','timeout',$2,$3,'{"ok":true}')`,
    [1004, iso(-5 * MIN), iso(-4 * MIN)],
  ); // d4 已解决(timeout) → 不该

  // 挂起样本
  const goalEnc = cipher.encryptText('整理店铺周报');
  await pool.query(
    `INSERT INTO task_pauses (id,user_id,loop_id,agent_id,goal_enc,paused_at)
     VALUES ($1,1,'loop-p1',23,$2,$3)`,
    [2001, goalEnc, iso(-60 * MIN)],
  ); // p1 挂 60 分钟未恢复 → 该提醒
  await pool.query(
    `INSERT INTO task_pauses (id,user_id,loop_id,agent_id,goal_enc,paused_at)
     VALUES ($1,1,'loop-p2',23,$2,$3)`,
    [2002, goalEnc, iso(-5 * MIN)],
  ); // p2 刚挂 5 分钟 → 不该（没到"长期"）
  await pool.query(
    `INSERT INTO task_pauses (id,user_id,loop_id,agent_id,goal_enc,paused_at,resumed_at)
     VALUES ($1,1,'loop-p3',23,$2,$3,$4)`,
    [2003, goalEnc, iso(-60 * MIN), iso(-10 * MIN)],
  ); // p3 已恢复 → 不该

  const convMessages = async (convId: number): Promise<string[]> => {
    const r = await pool.query<{ content_enc: string }>('SELECT content_enc FROM messages WHERE conversation_id=$1 ORDER BY id', [convId]);
    return r.rows.map((row) => cipher.decryptText(row.content_enc));
  };

  log('');
  log('=== 批次 K · Routines 主动跟进 验收 ===');

  // ---------------------------------------------------------------- ① ② ③
  log('');
  log('--- 第一次扫（now = 2026-09-25T12:00Z）---');
  const r1 = await sweepDanglingFollowups(pool, cipher, { now });
  await check(`只为"超期未回"的委派写了 1 条催办（实际 ${r1.handoffs}；没超期/刚提醒过/已解决都不写）`, () => {
    assert.equal(r1.handoffs, 1);
  });
  await check(`只为"长期未恢复"的挂起写了 1 条催办（实际 ${r1.pauses}；刚挂起/已恢复都不写）`, () => {
    assert.equal(r1.pauses, 1);
  });

  const convA = await convMessages(101);
  const convP = await convMessages(103);
  await check('派单方的主会话恰好 1 条，是委派 #1001 的催办', () => {
    assert.equal(convA.length, 1);
    assert.match(convA[0], /【协同·催办】#1001 派单方→接单方/);
    assert.match(convA[0], /超期/);
    assert.match(convA[0], /整理店铺周报/);
  });
  await check('挂起方的主会话恰好 1 条，是 60 分钟挂起催办（含解密后的目标）', () => {
    assert.equal(convP.length, 1);
    assert.match(convP[0], /【协同·催办】/);
    assert.match(convP[0], /挂起 60 分钟/);
    assert.match(convP[0], /loop-p1/);
    assert.match(convP[0], /整理店铺周报/);
  });
  await check('落库是密文：messages.content_enc 里搜不到目标明文', async () => {
    const raw = await pool.query<{ content_enc: string }>('SELECT content_enc FROM messages WHERE conversation_id=103');
    assert.ok(!raw.rows.some((x) => x.content_enc.includes('整理店铺周报')));
  });
  await check('被提醒的行 last_followed_at 已置为 now（幂等的前提）', async () => {
    const d = await pool.query<{ last_followed_at: string | null }>('SELECT last_followed_at FROM agent_delegations WHERE id=1001');
    const p = await pool.query<{ last_followed_at: string | null }>('SELECT last_followed_at FROM task_pauses WHERE id=2001');
    assert.ok(d.rows[0].last_followed_at, '委派 #1001 没记 last_followed_at');
    assert.ok(p.rows[0].last_followed_at, '挂起 #2001 没记 last_followed_at');
  });

  // ---------------------------------------------------------------- ④ 幂等
  log('');
  log('--- 同一时刻再扫（幂等：不该重复喊）---');
  const r2 = await sweepDanglingFollowups(pool, cipher, { now });
  await check(`重复扫不产生任何新提醒（handoffs=${r2.handoffs}, pauses=${r2.pauses}，都该是 0）`, () => {
    assert.equal(r2.handoffs, 0);
    assert.equal(r2.pauses, 0);
  });
  await check('两个会话的消息条数都不变（没有刷屏）', async () => {
    assert.equal((await convMessages(101)).length, 1);
    assert.equal((await convMessages(103)).length, 1);
  });

  // ---------------------------------------------------------------- ④ 主动（过间隔后仍掉线 → 再提醒）
  log('');
  log('--- 过了提醒间隔再扫（仍掉线 → 应当"主动"再提醒一次）---');
  const now2 = new Date(now.getTime() + (REMIND_EVERY_MS_DEFAULT / 60000 + 1) * MIN); // 31 分钟后
  const r3 = await sweepDanglingFollowups(pool, cipher, { now: now2 });
  /**
   * ★ 31 分钟后**世界变了**，期望必须跟着变（这正是"主动跟进"的本意）：
   *   · d1：仍超期、且距上次提醒 >30 分钟 → 再催；
   *   · d2：deadline 是 now+5 分钟，此刻已过去 26 分钟还没回 → **新**的"超期未回"，该催；
   *   · d3：上次提醒（now-1 分钟）距此刻 32 分钟 → 过了间隔，该再催；
   *   · p1：仍未恢复、过了间隔 → 再催；p2：挂起已 36 分钟 → **新**的"长期未恢复"，该催。
   */
  await check(`31 分钟后：三条超期未回的委派都被催（handoffs=${r3.handoffs}，该是 3）`, () => {
    assert.equal(r3.handoffs, 3);
  });
  await check(`31 分钟后：两条长期未恢复的挂起都被催（pauses=${r3.pauses}，该是 2）`, () => {
    assert.equal(r3.pauses, 2);
  });
  await check('d1 与 p1 确实**被再次**催办（新增的批次里有它们的催办 —— 跟进是"持续"的，不是一锤子）', async () => {
    const a = await convMessages(101);
    const pp = await convMessages(103);
    assert.equal(a.length, 4);
    assert.ok(a.slice(1).some((t) => /【协同·催办】#1001/.test(t)), 'd1 这次没有被再催');
    assert.equal(pp.length, 3);
    assert.ok(pp.slice(1).some((t) => /loop-p1/.test(t)), 'p1 这次没有被再催');
  });

  // ---------------------------------------------------------------- 收尾
  await check('默认阈值合理（挂起 30 分钟 / 每 30 分钟提醒一次）', () => {
    assert.equal(PAUSE_STALE_MS_DEFAULT, 30 * MIN);
    assert.equal(REMIND_EVERY_MS_DEFAULT, 30 * MIN);
  });

  await pool.end().catch(() => undefined);
  log('');
  log('=== 结论 ===');
  log(`  ${passes} PASS / ${fails} FAIL`);
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', (err as Error).message);
  process.exit(2);
});
