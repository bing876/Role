/**
 * #7 的**实测证据**（不是"我觉得该这样改"）· 可复现基准。
 *
 * 这个脚本**故意不进主链**：它要造 300,000 条消息，PGlite 里约 13 秒，
 * 塞进 48 步的链里不划算。主链里守这件事的是
 * `scripts/verify/idx-messages-fetch.mts`（8,000 条、约 0.3 秒、只钉计划形状）。
 *
 * 什么时候跑它：
 *   · 想复核"到底快了多少"的时候
 *   · 想改上界/索引之前，先拿一份改前数字
 *   · 怀疑真实环境不一样的时候
 *
 * 用法：npx tsx scripts/verify/bench-idle-scan.mts
 */
import { makePool, migrate } from '../../apps/server/src/db.ts';

const pool = makePool('pglite://memory') as unknown as import('node:pg').Pool;
const q = async (sql: string, params?: unknown[]) => pool.query(sql, params ?? []);
await migrate(pool as unknown as Parameters<typeof migrate>[0]);

const N_PROJECTS = 20;
const CONVS_PER_PROJECT = 100;
const MSGS_PER_CONV = 150;

console.log('=== 造数据（20 项目 / 2000 会话 / 300,000 消息，跨度 60 天）===');
const t0 = Date.now();
await q(`INSERT INTO users (id, xyz_id, phone_hash) VALUES (1,'bench','h') ON CONFLICT (id) DO NOTHING`);
for (let p = 1; p <= N_PROJECTS; p += 1) {
  await q('INSERT INTO projects (id, user_id, name) VALUES ($1, 1, $2)', [p, `项目${p}`]);
}
// ★ 长会话必须**最先**建（拿最小 id）：坏计划的形状是「走主键倒扫全表再按
//   conversation_id 过滤」，只有当这个会话的消息位于表的**前段**时才复现。
//   若把它建在最后，它的消息就在表尾，倒扫第一下就命中，0.07ms —— 什么都测不出来。
//   （首版就是这么写的，B 段测出 1x，白跑一趟。）
const LONG_FIRST = await q('INSERT INTO conversations (project_id, agent_id, title) VALUES (1, NULL, $1) RETURNING id', ['长会话']);
const longId = Number((LONG_FIRST.rows[0] as { id: unknown }).id);
const convRows: unknown[][] = [];
for (let p = 1; p <= N_PROJECTS; p += 1) {
  for (let c = 0; c < CONVS_PER_PROJECT; c += 1) convRows.push([p, `会话${p}-${c}`]);
}
{
  const rows: unknown[][] = [];
  for (let m = 0; m < 20000; m += 1) rows.push([longId, 'user', `L${m}`]);
  for (let k = 0; k < rows.length; k += 2000) {
    const chunk = rows.slice(k, k + 2000);
    const values = chunk.map((_, j) => `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3})`).join(',');
    await q(`INSERT INTO messages (conversation_id, role, content_enc) VALUES ${values}`, chunk.flat());
  }
}
const convIds: number[] = [];
for (let i = 0; i < convRows.length; i += 500) {
  const chunk = convRows.slice(i, i + 500);
  const values = chunk.map((_, k) => `($${k * 2 + 1}, NULL, $${k * 2 + 2})`).join(',');
  const r = await q(`INSERT INTO conversations (project_id, agent_id, title) VALUES ${values} RETURNING id`, chunk.flat());
  for (const row of r.rows as { id: unknown }[]) convIds.push(Number(row.id));
}
const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;
for (let i = 0; i < convIds.length; i += 1) {
  const cid = convIds[i];
  const lastAt = now - (i % 1440) * 60 * 1000 - Math.floor(i / 1440) * DAY;
  const rows: unknown[][] = [];
  for (let m = 0; m < MSGS_PER_CONV; m += 1) {
    rows.push([cid, m % 2 === 0 ? 'user' : 'assistant', `x${i}-${m}`, new Date(lastAt - m * 5 * 60 * 1000)]);
  }
  for (let k = 0; k < rows.length; k += 2000) {
    const chunk = rows.slice(k, k + 2000);
    const values = chunk.map((_, j) => `($${j * 4 + 1}, $${j * 4 + 2}, $${j * 4 + 3}, $${j * 4 + 4})`).join(',');
    await q(`INSERT INTO messages (conversation_id, role, content_enc, created_at) VALUES ${values}`, chunk.flat());
  }
}
console.log(`  耗时 ${Date.now() - t0} ms`);

const OLD_SQL = `SELECT c.id AS conv_id, p.user_id, c.agent_id, MAX(m.id) AS last_id, MAX(m.created_at) AS last_at
   FROM conversations c
   JOIN projects p ON p.id = c.project_id
   LEFT JOIN messages m ON m.conversation_id = c.id
  WHERE COALESCE(c.keepalive, false) = false
  GROUP BY c.id, p.user_id, c.agent_id`;

const NEW_SQL = `SELECT c.id AS conv_id, p.user_id, c.agent_id, MAX(m.id) AS last_id, MAX(m.created_at) AS last_at
   FROM conversations c
   JOIN projects p ON p.id = c.project_id
   LEFT JOIN messages m ON m.conversation_id = c.id AND m.created_at >= $1
  WHERE COALESCE(c.keepalive, false) = false
  GROUP BY c.id, p.user_id, c.agent_id`;

const FETCH_SQL = 'SELECT role, content_enc FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 40';

async function measure(label: string, sql: string, params: unknown[]): Promise<number> {
  await q(sql, params);
  const runs: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const e = await q(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params);
    const text = e.rows.map((x) => Object.values(x as Record<string, unknown>)[0] as string).join('\n');
    const m = /Execution Time: ([\d.]+) ms/.exec(text);
    if (m) runs.push(Number(m[1]));
  }
  const best = Math.min(...runs);
  console.log(`  ${label}: ${best.toFixed(2)} ms   [${runs.map((r) => r.toFixed(1)).join(', ')}]`);
  return best;
}

console.log('\n=== A. 闲置调度那条 GROUP BY ===');
await q('DROP INDEX IF EXISTS idx_messages_conversation_id');
await q('CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id)');
await q('ANALYZE messages');
const oldMs = await measure('OLD  无上界 + 单列索引     ', OLD_SQL, []);
await q('CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages (conversation_id, id)');
await q('ANALYZE messages');
const bound = new Date(now - 6 * 60 * 60 * 1000);
const newMs = await measure('NEW  有上界 + 复合索引     ', NEW_SQL, [bound]);
const noBoundMs = await measure('NOB  无上界 + 复合索引     ', OLD_SQL, []);
console.log(`  ⇒ 上界贡献 ${(oldMs / newMs).toFixed(1)}x；复合索引在这条上 ${noBoundMs > oldMs ? '反而略慢' : '略有帮助'}（${(noBoundMs / oldMs).toFixed(2)}x）`);

console.log('\n=== B. 读历史那条（长会话 20,000 条）===');
await q('ANALYZE messages');
await q('DROP INDEX IF EXISTS idx_messages_conversation_id');
await q('ANALYZE messages');
const fetchOld = await measure('只有单列索引            ', FETCH_SQL, [longId]);
await q('CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages (conversation_id, id)');
await q('ANALYZE messages');
const fetchNew = await measure('有复合索引              ', FETCH_SQL, [longId]);
console.log(`  ⇒ 复合索引在这条上贡献 ${(fetchOld / fetchNew).toFixed(0)}x`);

console.log('\n=== 结论 ===');
console.log(`  · 时间上界：只为 GROUP BY 那条服务，本次 ${(oldMs / newMs).toFixed(1)}x（多跑几次在 6~10x 之间波动）`);
console.log(`  · 复合索引：只为「按会话取最近 N 条」服务，长会话上本次 ${(fetchOld / fetchNew).toFixed(0)}x，`);
console.log('    且恶化方式与消息表总行数成正比（与会话长度无关）');
console.log('  ★ 绝对耗时不可迁移（PGlite 是 WASM 单线程、无并行 worker）。');
console.log('    可信的是计划形状与同环境比值。生产数字需真 PostgreSQL + EXPLAIN ANALYZE。');

await pool.end().catch(() => undefined);
