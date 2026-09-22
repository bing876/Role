// _ping-db.cjs —— 库探活：端口 + SELECT 1 双判 + 表数量
// 用法：node scripts/verify/_ping-db.cjs
const { Client } = require('pg');

(async () => {
  const t0 = Date.now();
  const db = new Client({
    connectionString: 'postgresql://workbench:workbench@localhost:5432/workbench',
  });
  try {
    await db.connect();
    const r = await db.query('SELECT 1 AS ok');
    console.log('QUERY_OK', JSON.stringify(r.rows[0]),
      'after', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    const t = await db.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'");
    console.log('TABLES', t.rows[0].n);
    await db.end();
    process.exit(0);
  } catch (e) {
    console.log('QUERY_FAIL', e.message.split('\n')[0],
      'after', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    process.exit(1);
  }
})();
