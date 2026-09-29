/**
 * 索引有效性守卫（2026-09-29）· **复合索引到底有没有用，测了才知道。**
 *
 * ## 起因：我原来的判断是错的
 *
 * 我给 `messages` 加了复合索引 `(conversation_id, id)`，理由写的是
 * 「也让闲置调度里按 conversation_id 分组求 MAX(id) 能走索引」。
 *
 * 用 300,000 条消息实测后发现：
 *
 *   被测对象                                            耗时
 *   OLD（无时间上界 + 单列索引）                      630.5 ms
 *   NEW（有时间上界 + 复合索引）                       64.9 ms   ← 9.7x
 *   NEW_NO_BOUND（无时间上界 + 复合索引）             708.5 ms   ← 比 OLD 还慢
 *
 * ⇒ **提速 100% 来自时间上界；复合索引在那条 GROUP BY 上不但没帮忙，还略慢**
 *   （索引更大，扫起来更贵）。我那句理由**是错的**。
 *
 * ## 但复合索引在另一条查询上是决定性的
 *
 * `SELECT ... FROM messages WHERE conversation_id=$1 ORDER BY id DESC LIMIT 40`
 * （读历史、整理记忆各有一处）。同库实测，一个 20,000 条消息的会话：
 *
 *   只有单列索引：`Index Scan Backward using messages_pkey`
 *                 `Filter: (conversation_id = '1')`
 *                 `Rows Removed by Filter: 299700`   ← 扫了全表才找到 40 行
 *                 58.6 ms
 *   有复合索引：  `Index Scan Backward using idx_messages_conversation_id`
 *                 `Index Cond: (conversation_id = '1')`
 *                 `Buffers: shared hit=4`             ← 只碰 4 个缓冲页
 *                 0.24 ms                             ← ~250x
 *
 * ★ 注意这条的恶化方式：它跟**消息表总行数**成正比，跟这个会话有多长无关。
 *   也就是说表越大，「读最近 40 条」越慢 —— 而这是每次打开历史都要跑的查询。
 *
 * ## 本脚本守什么
 *
 * 用最小可复现数据量（8,000 条消息、约 0.3 秒造好）钉住：
 *   ① 那条查询**必须走复合索引**，不许退回主键全表扫
 *   ② **不许出现大批量 `Rows Removed by Filter`**（>1000 就是坏计划的形状）
 *   ③ 复合索引必须真的存在于 schema
 *
 * ## 反证（已实测会红）
 *   删掉复合索引 → 「必须走复合索引」红 / RowsRemoved 爆红
 *
 * 用法：npx tsx scripts/verify/idx-messages-fetch.mts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const { makePool, migrate } = req('../../apps/server/src/db') as typeof import('../../apps/server/src/db');

let pass = 0;
const ok = (name: string): void => {
  pass += 1;
  console.log(`  PASS ${name}`);
};

const repo = (rel: string): string => path.join(path.dirname(new URL(import.meta.url).pathname), '../..', rel);

/** 读历史 / 整理记忆用的那条（与生产逐字一致） */
const FETCH_SQL = 'SELECT role, content_enc FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 40';

/** 最小可复现量：实测 8,000 条消息就足以让规划器选坏计划（见文件头） */
const LONG_LEN = 2000;
const OTHER_CONVS = 30;
const OTHER_LEN = 200;

async function main(): Promise<void> {
  const pool = makePool('pglite://memory') as unknown as import('node:pg').Pool;
  const q = async (sql: string, params?: unknown[]) => pool.query(sql, params ?? []);
  await migrate(pool as unknown as Parameters<typeof migrate>[0]);

  await q(`INSERT INTO users (id, xyz_id, phone_hash) VALUES (1,'idx-guard','h') ON CONFLICT (id) DO NOTHING`);
  await q('INSERT INTO projects (id, user_id, name) VALUES (1, 1, $1)', ['idx-guard']);

  const L = await q('INSERT INTO conversations (project_id, agent_id, title) VALUES (1, NULL, $1) RETURNING id', ['长会话']);
  const longId = Number((L.rows[0] as { id: unknown }).id);

  // 长会话的消息
  {
    const rows: unknown[][] = [];
    for (let m = 0; m < LONG_LEN; m += 1) rows.push([longId, 'user', `L${m}`]);
    for (let k = 0; k < rows.length; k += 1000) {
      const chunk = rows.slice(k, k + 1000);
      const values = chunk.map((_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3})`).join(',');
      await q(`INSERT INTO messages (conversation_id, role, content_enc) VALUES ${values}`, chunk.flat());
    }
  }
  // 其它会话，把总行数抬到能触发坏计划的量级
  for (let i = 0; i < OTHER_CONVS; i += 1) {
    const r = await q('INSERT INTO conversations (project_id, agent_id, title) VALUES (1, NULL, $1) RETURNING id', [`o${i}`]);
    const cid = Number((r.rows[0] as { id: unknown }).id);
    const rows: unknown[][] = [];
    for (let m = 0; m < OTHER_LEN; m += 1) rows.push([cid, 'user', `x${i}-${m}`]);
    for (let k = 0; k < rows.length; k += 1000) {
      const chunk = rows.slice(k, k + 1000);
      const values = chunk.map((_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3})`).join(',');
      await q(`INSERT INTO messages (conversation_id, role, content_enc) VALUES ${values}`, chunk.flat());
    }
  }
  const cnt = await q('SELECT count(*)::int AS n FROM messages');
  const total = Number((cnt.rows[0] as { n: unknown }).n);

  await q('ANALYZE messages');

  // 预热后取计划
  await q(FETCH_SQL, [longId]);
  const e = await q(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${FETCH_SQL}`, [longId]);
  const plan = e.rows.map((r) => Object.values(r as Record<string, unknown>)[0] as string).join('\n');

  // =====================================================================
  // ① 必须走复合索引，不许退回主键全表扫
  // =====================================================================
  {
    assert.ok(
      /Index (Only )?Scan (Backward )?using idx_messages_conversation_id/.test(plan),
      `这条查询必须走复合索引 idx_messages_conversation_id，否则就是全表扫。实际计划：\n${plan}`,
    );
    assert.ok(
      !/Index (Only )?Scan (Backward )?using messages_pkey/.test(plan),
      `不许走主键倒扫再 Filter（那正是扫全表的形状）：\n${plan}`,
    );
    assert.ok(/Index Cond: \(conversation_id = /.test(plan), `必须有 Index Cond（而不是 Filter）：\n${plan}`);
    ok('读历史那条查询走复合索引 + Index Cond（不是走主键全表扫再 Filter）');
  }

  // =====================================================================
  // ② 不许出现大批量 Rows Removed by Filter（坏计划的形状）
  // =====================================================================
  {
    const m = /Rows Removed by Filter: (\d+)/.exec(plan);
    const removed = m ? Number(m[1]) : 0;
    assert.ok(
      removed <= 1000,
      `Rows Removed by Filter = ${removed}（>1000 就是坏计划：扫了很多行才找到 40 条）。计划：\n${plan}`,
    );
    ok(`没有大批量 Filter 淘汰（Rows Removed = ${removed}，总行数 ${total}）`);
  }

  // =====================================================================
  // ③ schema 里索引必须在
  // =====================================================================
  {
    const src = fs.readFileSync(repo('apps/server/src/db.ts'), 'utf8');
    assert.ok(
      /CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages \(conversation_id, id\)/.test(src),
      'db.ts 里必须建 (conversation_id, id) 复合索引',
    );
    const idx = await q("SELECT indexname FROM pg_indexes WHERE tablename = 'messages'");
    const names = (idx.rows as { indexname: string }[]).map((r) => r.indexname);
    assert.ok(names.includes('idx_messages_conversation_id'), `库里没有该索引：${names.join(', ')}`);
    ok('schema 与生产 DDL 都有 (conversation_id, id) 复合索引');
  }

  await pool.end().catch(() => undefined);
  console.log(`\n=== 索引有效性守卫：${pass} PASS / 0 FAIL ===`);
  console.log(`  数据量：${total} 条消息（含一个 ${LONG_LEN} 条的长会话）`);
  console.log('  实测依据（300k 消息的大基准，另见 docs/技术接手报告 §10.9）：');
  console.log('    只有单列索引 → 走主键倒扫，Rows Removed 299,700，58.6 ms');
  console.log('    有复合索引   → 走复合索引，Buffers hit=4，      0.24 ms（~250x）');
  console.log('  注意：绝对耗时不可迁移（PGlite 是 WASM）。可信的是计划形状 + 同环境比值。');
}

main().catch((err) => {
  console.error('FATAL', (err as Error).message);
  process.exit(2);
});
