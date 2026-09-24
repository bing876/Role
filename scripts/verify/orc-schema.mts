/**
 * 多智能体编排 · S2 验收：**三张编排表的 DDL 幂等性**。
 *
 * 要证明的事：
 *   ① `migrate()` 之后 `agent_channels` / `agent_channel_messages` / `agent_delegations`
 *      三张表存在，且列名/列序/关键约束与设计一致；
 *   ② 再跑一次 `migrate()`（模拟老库升级 / 重启重连）**零副作用** ——
 *      表清单、列清单、索引清单逐项不变；
 *   ③ 频道唯一约束真的成立：同一对用户+两个智能体**插不进第二条**
 *      （a<b 归一 + UNIQUE(user_id, agent_a_id, agent_b_id)）；
 *   ④ 消息 kind 的 CHECK 约束真的拦得住非法值（脏数据不该能落库）。
 *
 * 用 pglite **内存库**（根依赖已有 @electric-sql/pglite），不碰任何活库、不写文件。
 *
 * 运行前提：npm install && npm run build -w @ai-workbench/shared
 * 用法：npx tsx scripts/verify/orc-schema.mts   （或 npm run verify:orc 里的第一段）
 */
import assert from 'node:assert/strict';
import { makePool, migrate } from '../../apps/server/src/db';

let fails = 0;
const log = (...a: string[]) => console.log(a.map(String).join(' '));
const check = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve()
    .then(fn)
    .then(() => log(`  PASS ${name}`))
    .catch((err) => {
      fails += 1;
      log(`  ★FAIL ${name}  —— ${(err as Error)?.message ?? String(err)}`);
    });

/** 取一张表的列（名字:类型，按定义顺序） */
async function columnsOf(pool: ReturnType<typeof makePool>, table: string): Promise<string[]> {
  const r = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return (r.rows as Array<{ column_name: string; data_type: string }>).map(
    (x) => `${x.column_name}:${x.data_type}`,
  );
}

async function tablesOf(pool: ReturnType<typeof makePool>): Promise<string[]> {
  const r = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`,
  );
  return (r.rows as Array<{ table_name: string }>).map((x) => x.table_name);
}

async function indexesOf(pool: ReturnType<typeof makePool>, table: string): Promise<string[]> {
  const r = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY indexname`, [table]);
  return (r.rows as Array<{ indexname: string }>).map((x) => x.indexname);
}

async function main(): Promise<void> {
  log('=== 多智能体编排 · S2 表结构验收（pglite 内存库） ===');
  const pool = makePool('pglite://memory');

  await check('第一次 migrate() 成功', async () => {
    await migrate(pool);
  });

  const EXPECTED: Record<string, string[]> = {
    agent_channels: [
      'id:bigint',
      'user_id:bigint',
      'project_id:bigint',
      'agent_a_id:bigint',
      'agent_b_id:bigint',
      'created_at:timestamp with time zone',
      'last_message_at:timestamp with time zone',
    ],
    agent_channel_messages: [
      'id:bigint',
      'channel_id:bigint',
      'from_agent_id:bigint',
      'to_agent_id:bigint',
      'kind:text',
      'content_enc:text',
      'payload:jsonb',
      'delegation_id:bigint',
      'created_at:timestamp with time zone',
    ],
    agent_delegations: [
      'id:bigint',
      'user_id:bigint',
      'project_id:bigint',
      'channel_id:bigint',
      'from_agent_id:bigint',
      'to_agent_id:bigint',
      'parent_loop_id:text',
      'child_loop_id:text',
      'task:text',
      'status:text',
      'created_at:timestamp with time zone',
      'deadline_at:timestamp with time zone',
      'finished_at:timestamp with time zone',
      'result:jsonb',
      'error:text',
      // 批次 K：跟进扫的"上次催办时间"（幂等：同一条 30 分钟内只提醒一次），见 orchestrator/followup.ts
      'last_followed_at:timestamp with time zone',
    ],
  };

  for (const [table, cols] of Object.entries(EXPECTED)) {
    await check(`表 ${table} 存在且列与设计逐项一致`, async () => {
      assert.deepEqual(await columnsOf(pool, table), cols);
    });
  }

  await check('索引齐了（channel 消息按频道取、委派按用户/频道倒序取）', async () => {
    const a = await indexesOf(pool, 'agent_channel_messages');
    const b = await indexesOf(pool, 'agent_delegations');
    assert.ok(a.includes('idx_agent_channel_messages'), `缺 idx_agent_channel_messages：${a.join(',')}`);
    assert.ok(b.includes('idx_agent_delegations_user'), `缺 idx_agent_delegations_user：${b.join(',')}`);
    assert.ok(b.includes('idx_agent_delegations_channel'), `缺 idx_agent_delegations_channel：${b.join(',')}`);
  });

  // --- 幂等：第二次 migrate 之后一切不变 ---
  const tablesBefore = await tablesOf(pool);
  const colsBefore = Object.fromEntries(
    await Promise.all(Object.keys(EXPECTED).map(async (t) => [t, await columnsOf(pool, t)])),
  );
  const idxBefore = Object.fromEntries(
    await Promise.all(Object.keys(EXPECTED).map(async (t) => [t, await indexesOf(pool, t)])),
  );

  await check('第二次 migrate() 成功（老库升级路径）', async () => {
    await migrate(pool);
  });

  await check('二次执行零副作用：表/列/索引清单逐项不变', async () => {
    assert.deepEqual(await tablesOf(pool), tablesBefore);
    for (const t of Object.keys(EXPECTED)) {
      assert.deepEqual(await columnsOf(pool, t), colsBefore[t], `${t} 的列变了`);
      assert.deepEqual(await indexesOf(pool, t), idxBefore[t], `${t} 的索引变了`);
    }
  });

  // --- 真实写入：频道唯一 + kind 约束 ---
  await check('插一条用户/项目/两个智能体，能建出唯一频道', async () => {
    await pool.query(
      `INSERT INTO users (id, xyz_id, phone_hash, created_at) VALUES (9001, 'x9001', 'h9001', now())
       ON CONFLICT (id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO projects (id, user_id, name, is_default) VALUES (9001, 9001, 'p', true)
       ON CONFLICT (id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO agents (id, project_id, name, kind) VALUES (9001, 9001, '小助', 'assistant'), (9002, 9001, '母鸡', 'hen')
       ON CONFLICT (id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO agent_channels (user_id, project_id, agent_a_id, agent_b_id) VALUES (9001, 9001, 9001, 9002)`,
    );
    const r = await pool.query('SELECT count(*)::int AS n FROM agent_channels WHERE user_id = 9001');
    assert.equal((r.rows as Array<{ n: number }>)[0].n, 1);
  });

  await check('同一对智能体插第二条被 UNIQUE 拦住（A→B 与 B→A 是同一条频道）', async () => {
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO agent_channels (user_id, project_id, agent_a_id, agent_b_id) VALUES (9001, 9001, 9001, 9002)`,
        ),
      /duplicate key|unique/i,
    );
  });

  await check('频道消息的 kind 只收 task/progress/reply/system（非法值被 CHECK 拦下）', async () => {
    const ch = await pool.query('SELECT id FROM agent_channels WHERE user_id = 9001 LIMIT 1');
    const channelId = (ch.rows as Array<{ id: number }>)[0].id;
    await pool.query(
      `INSERT INTO agent_channel_messages (channel_id, from_agent_id, to_agent_id, kind, content_enc)
       VALUES ($1, 9001, 9002, 'task', 'enc')`,
      [channelId],
    );
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO agent_channel_messages (channel_id, from_agent_id, to_agent_id, kind, content_enc)
           VALUES ($1, 9001, 9002, 'gossip', 'enc')`,
          [channelId],
        ),
      /check|kind/i,
    );
  });

  log('');
  log('=== 结论 ===');
  log(`  失败项：${fails}`);
  if (fails > 0) process.exitCode = 1;
}

void main();
