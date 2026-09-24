/**
 * 批次 L 片 2 | 自然语言建定时任务:真建 —— 验收(真 PGlite 库 + 生产代码本身)
 *
 * 跑的是 `createRoutineFromMessage`(chat.ts 调用的那个),里面全是真代码:
 * routineParser 解析 → loadProjectRoster 名册 → 去重 SQL → createRoutine 真 INSERT。
 *
 * 用户拍板的三个必须行为(各带反证,反证在 routine-create-revert-proof.py):
 *   ① 名字解析不到 → 不偷偷挑最像的,回「没找到叫『X』的智能体,现在有:[名单]」
 *   ② 同 agent + 同节奏 + 同任务已有 active → 不建第二个,回「已经有一个了」
 *   ③ 回话必须带设成了什么(节奏 + 任务),不是「好的」、不是确认框
 *
 * 用法:npx tsx scripts/verify/routine-create.mts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Pool } from 'pg';
import { makePool, migrate } from '../../apps/server/src/db';
import { makeCipher } from '../../apps/server/src/crypto';
import { createRoutineFromMessage } from '../../apps/server/src/orchestrator/routineCreate';

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
  const pool = makePool('pglite://memory') as unknown as Pool;
  await migrate(pool);
  const cipher = makeCipher('a'.repeat(64));

  await pool.query(`INSERT INTO users (id, xyz_id, phone_hash) VALUES (1,'x1','h1') ON CONFLICT (id) DO NOTHING`);
  await pool.query(`INSERT INTO projects (id, user_id, name, is_default) VALUES (10,1,'项目甲',true) ON CONFLICT (id) DO NOTHING`);
  const insAgent = (id: number, name: string, kind: string): Promise<unknown> =>
    pool.query(`INSERT INTO agents (id, project_id, name, kind, persona, persona_status, can_create_agents)
                VALUES ($1,10,$2,$3,'{}','ready',false) ON CONFLICT (id) DO NOTHING`, [id, name, kind]);
  await insAgent(21, '管家', 'hen');
  await insAgent(22, '运营助手', 'custom');
  await insAgent(23, '客服', 'custom');
  await pool.query(`SELECT setval('users_id_seq',100), setval('projects_id_seq',100), setval('agents_id_seq',1000)`);

  const countRoutines = async (): Promise<number> =>
    Number((await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM agent_routines')).rows[0].n);
  const rows = async () =>
    (await pool.query<{ agent_id: string; task_template: string; trigger_type: string; trigger_config: Record<string, unknown>; name: string; enabled: boolean; next_run_at: string | null }>(
      'SELECT agent_id, task_template, trigger_type, trigger_config, name, enabled, next_run_at FROM agent_routines ORDER BY id',
    )).rows;

  const say = (message: string, speaker = 21) =>
    createRoutineFromMessage(pool, { userId: 1, projectId: 10, speakerAgentId: speaker, message });

  log('');
  log('=== 批次 L 片 2 · 自然语言建定时任务:真建 验收 ===');

  // ---------------------------------------------------------------- ① 真建
  log('');
  log('--- ① 点名 + 真建(回话带设成了什么) ---');
  let n0 = await countRoutines();
  const r1 = await say('让运营助手每天9点检查店铺数据');
  await check('解析成 created,且库里真的多了一条 routine(指向运营助手 id=22)', async () => {
    assert.equal(r1.kind, 'created');
    const n = await countRoutines();
    assert.equal(n, n0 + 1);
    const rr = await rows();
    const row = rr.find((x) => Number(x.agent_id) === 22);
    assert.ok(row, '没有 agent_id=22 的行');
    assert.equal(row.task_template, '检查店铺数据');
    assert.equal(row.trigger_type, 'cron');
    assert.deepEqual(row.trigger_config, { hour: 9, minute: 0 });
    assert.equal(row.name, '每天 09:00·检查店铺数据');
    assert.equal(row.enabled, true);
    assert.ok(row.next_run_at, 'next_run_at 没算出来');
  });
  await check('③ 回话带设成了什么:节奏(每天 09:00)+ 任务(检查店铺数据)+ 智能体名,不是"好的"', () => {
    assert.ok(r1.kind === 'created');
    assert.match(r1.reply, /已设成:运营助手 每天 09:00 检查店铺数据/);
    assert.doesNotMatch(r1.reply, /^好的/);
  });
  await check('③ 结果去向诚实:点名的不是本轮发言人(管家 21) → 说"结果发到运营助手的主会话",不撒谎', () => {
    assert.ok(r1.kind === 'created');
    assert.match(r1.reply, /结果发到运营助手的主会话/);
  });

  // ---------------------------------------------------------------- ② 去重
  log('');
  log('--- ② 重复创建:同句发两次,只有一条 ---');
  const r2 = await say('让运营助手每天9点检查店铺数据');
  await check('第二遍 = duplicate,回「已经有一个了」,库里**仍然只有一条**', async () => {
    assert.equal(r2.kind, 'duplicate');
    assert.match(r2.reply, /已经有一个了/);
    assert.equal(await countRoutines(), n0 + 1);
  });

  // ---------------------------------------------------------------- ① 名字解析不到
  log('');
  log('--- ①(反证靶)名单外的名字:不建、不挑最像的 ---');
  const before = await countRoutines();
  const r3 = await say('让小王每天9点检查库存');
  await check('unknown-agent:**没有**新建任何 routine', async () => {
    assert.equal(r3.kind, 'unknown-agent');
    assert.equal(await countRoutines(), before);
  });
  await check('回话:「没找到叫『小王』的智能体」+ 现有名单(管家/运营助手/客服都在)', () => {
    assert.ok(r3.kind === 'unknown-agent');
    assert.match(r3.reply, /没找到叫『小王』的智能体/);
    assert.match(r3.reply, /『管家』/);
    assert.match(r3.reply, /『运营助手』/);
    assert.match(r3.reply, /『客服』/);
  });

  // ---------------------------------------------------------------- 没点名 → 发言人
  log('');
  log('--- 没点名:建给本轮发言人(确定性落点,不是猜) ---');
  const r4 = await say('每天9点提醒我喝水');
  await check('F2 没点名 → 建给发言人(管家 21),回话含发言人名字 + "结果发这里"', async () => {
    assert.equal(r4.kind, 'created');
    const rr = await rows();
    const row = rr.find((x) => Number(x.agent_id) === 21 && x.task_template === '喝水');
    assert.ok(row, '没有 agent_id=21 且 task=喝水 的行');
    assert.match(r4.reply, /已设成:管家 每天 09:00 喝水/);
    assert.match(r4.reply, /结果发这里/);
  });

  // ---------------------------------------------------------------- not-a-routine
  log('');
  log('--- 不是建任务的话 → not-a-routine(chat 层走正常 LLM) ---');
  const before2 = await countRoutines();
  const r5 = await say('让运营助手检查店铺数据');
  await check('没有节奏 → not-a-routine,一条都不建', async () => {
    assert.equal(r5.kind, 'not-a-routine');
    assert.equal(await countRoutines(), before2);
  });

  // ---------------------------------------------------------------- 去重范围
  log('');
  log('--- 去重的范围:同节奏不同任务 / 同任务不同节奏 → 都该建 ---');
  const r6 = await say('让运营助手每天10点检查店铺数据');
  const r7 = await say('让运营助手每天9点打扫仓库');
  await check('同任务不同时刻(10 点)→ 建;同时刻不同任务(打扫仓库)→ 建', async () => {
    assert.equal(r6.kind, 'created');
    assert.equal(r7.kind, 'created');
    const rr = await rows();
    assert.ok(rr.some((x) => Number(x.agent_id) === 22 && x.task_template === '检查店铺数据' && (x.trigger_config as { hour: number }).hour === 10));
    assert.ok(rr.some((x) => Number(x.agent_id) === 22 && x.task_template === '打扫仓库'));
  });
  await check('同一句间隔任务再发一遍 → duplicate', async () => {
    const a = await say('让运营助手每30分钟刷新页面');
    assert.equal(a.kind, 'created');
    const b = await say('让运营助手每30分钟刷新页面');
    assert.equal(b.kind, 'duplicate');
    const rr = await rows();
    assert.equal(rr.filter((x) => x.task_template === '刷新页面').length, 1);
  });

  // ---------------------------------------------------------------- 停用的不算重复
  log('');
  log('--- 去重只认 active(enabled=true) ---');
  const r8 = await say('让运营助手每天9点检查店铺数据');
  await check('先确认:此刻同句仍是 duplicate(去重基线)', () => {
    assert.equal(r8.kind, 'duplicate');
  });
  await pool.query('UPDATE agent_routines SET enabled=false WHERE agent_id=22 AND task_template=$1', ['检查店铺数据']);
  const r9 = await say('让运营助手每天9点检查店铺数据');
  await check('原 routine 停用后,同句再发 → 建新的(停用版不算 active)', () => {
    assert.equal(r9.kind, 'created');
  });

  // ---------------------------------------------------------------- chat.ts 接线(静态)
  log('');
  log('--- chat.ts 接线(静态检查:真挂在那条路径上) ---');
  const chatSrc = fs.readFileSync(new URL('../../apps/server/src/routes/chat.ts', import.meta.url), 'utf8');
  await check('chat.ts 调用了 createRoutineFromMessage,且在"先读历史"之前(不落到 LLM 路径)', () => {
    const idxCall = chatSrc.indexOf('createRoutineFromMessage');
    const idxHist = chatSrc.indexOf('// 1) 先读历史');
    assert.ok(idxCall > 0 && idxHist > 0 && idxCall < idxHist, `call@${idxCall} hist@${idxHist}`);
  });
  await check('接线口径:落 user+assistant 两条消息、assistant 记 speaker_agent_id、SSE 回 rc.reply', () => {
    assert.ok(chatSrc.includes("'[chat] 自然语言建定时任务失败，回落到普通聊天：'"));
    assert.ok(chatSrc.includes('rc.reply'));
    const block = chatSrc.slice(chatSrc.indexOf('批次 L 片 2'));
    assert.ok(block.includes("role, content_enc) VALUES ($1, 'user', $2)"), '没落 user 消息');
    assert.ok(block.includes('speaker_agent_id'), 'assistant 消息没记发言人');
    assert.ok(block.includes("sse(res, 'meta'") && block.includes("sse(res, null, { delta: rc.reply })") && block.includes("sse(res, 'done'"));
  });
  await check('not-a-routine 不劫持:只有 rc.kind !== "not-a-routine" 才 hijack', () => {
    const block = chatSrc.slice(chatSrc.indexOf('批次 L 片 2'));
    assert.ok(block.includes('rc.kind !== \'not-a-routine\''));
    assert.ok(block.indexOf('rc.kind !== \'not-a-routine\'') < block.indexOf('reply.hijack()'));
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
