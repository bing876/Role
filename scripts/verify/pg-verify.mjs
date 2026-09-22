/**
 * 直连 PostgreSQL 自检：证明「数据库接通」是可复现事实，而不是一次性残留。
 *
 * ★ 为什么不用 psql：
 *   本机没有原生 PostgreSQL，`wsl.exe` 被安全策略拦、Docker Linux 引擎起不来，
 *   唯一可行的是 zonky 嵌入式二进制（`pg2/pg/bin`）—— 但它**只带 initdb / pg_ctl / postgres**，
 *   **没有 psql / createdb**。所以建库与自检都走服务端同一套客户端库（node-postgres）。
 *
 * 跑法：node scripts/verify/pg-verify.mjs
 */
import pg from 'pg';

const URL = process.env.DATABASE_URL || 'postgresql://workbench:workbench@127.0.0.1:5432/workbench';
const c = new pg.Client({ connectionString: URL });

try {
  await c.connect();
  const head = await c.query('SELECT current_database() AS db, current_user AS u, version() AS v');
  const tables = await c.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
  );
  const names = tables.rows.map((r) => r.table_name);
  console.log('连接串 =', URL);
  console.log('db =', head.rows[0].db, '| user =', head.rows[0].u);
  console.log('版本 =', String(head.rows[0].v).split(',')[0]);
  console.log('public 表数量 =', names.length);
  console.log('表名 =', names.join(', '));
  // 关键表齐不齐 —— migrate 跑过的判据
  const expect = ['users', 'projects', 'agents', 'conversations', 'messages', 'tasks'];
  const missing = expect.filter((t) => !names.includes(t));
  console.log(missing.length ? `★ 缺表: ${missing.join(', ')}` : '✓ 关键表齐全（migrate 已跑过）');
  process.exitCode = missing.length ? 1 : 0;
} catch (e) {
  console.log('★ 连接失败:', e.message);
  process.exitCode = 1;
} finally {
  await c.end().catch(() => {});
}
