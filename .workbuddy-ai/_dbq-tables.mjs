// 验收：数据库表是否真的建好了（光看 /health 的 db:"up" 不够，
// 因为服务端在数据库没就绪时启动会「静默降级」，之后 /auth 一律 503）。
import { Client } from 'pg';

const c = new Client({
  host: '127.0.0.1',
  port: 5432,
  user: 'workbench',
  password: 'workbench',
  database: 'workbench',
});
await c.connect();
const r = await c.query(
  "select table_name from information_schema.tables where table_schema='public' order by table_name"
);
console.log('表数量:', r.rows.length);
console.log(r.rows.map((x) => x.table_name).join(', '));
const u = await c.query('select count(*)::int as n from users').catch((e) => ({ rows: [{ n: 'ERR:' + e.message }] }));
console.log('users 表可读, 行数:', u.rows[0].n);
await c.end();
