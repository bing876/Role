// login-probe.mjs —— 端到端复现「手机号+验证码登录」全流程，定位到底哪一步坏。
// 验证码哈希是 sha256(salt$code)，6 位码空间只有 100 万 —— 可以直接爆破反推，
// 这样就不依赖「去服务端窗口看日志」。
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire('file:///' + process.cwd().replace(/\\/g, '/') + '/');
const { Client } = require('pg');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const PHONE = process.env.PHONE || '18665594441';
const DS = 'postgresql://workbench:workbench@localhost:5432/workbench';

const hashCode = (code, salt) => crypto.createHash('sha256').update(`${salt}$${code}`, 'utf8').digest('hex');
const phoneHash = (phone, pepper) => crypto.createHmac('sha256', pepper).update(phone, 'utf8').digest('hex');

const log = (...a) => console.log(...a);

const db = new Client({ connectionString: DS });
await db.connect();

// ---------- 1) 直连库看这个号最近有没有发码 ----------
// ★ PHONE_PEPPER 在 .env 里为空 -> env.ts 会回落成 DATA_KEY，别用空串算
const PEPPER = process.env.PHONE_PEPPER || '37e9158ac1e8b27befae29e59e0f94dc7d3b5f9408e853f9afcde816231cf887';
const h = phoneHash(PHONE, PEPPER);
const rows = (await db.query(
  `SELECT id, code_hash, salt, expires_at, created_at, used, attempts
   FROM sms_codes WHERE phone_hash = $1 ORDER BY created_at DESC LIMIT 3`, [h])).rows;
log('=== sms_codes（该手机号最近 3 条）===');
if (!rows.length) log('  （没有记录 —— 说明「获取验证码」按钮根本没把请求发出去）');
for (const r of rows) log('  id=%s created=%s used=%s attempts=%s', r.id, r.created_at.toISOString(), r.used, r.attempts);

// ---------- 2) 爆破最新一条的验证码 ----------
let code = null, latest = rows[0];
if (latest && !latest.used && latest.expires_at > new Date()) {
  for (let i = 0; i < 1_000_000; i++) {
    const c = String(i).padStart(6, '0');
    if (hashCode(c, latest.salt) === latest.code_hash) { code = c; break; }
  }
  log('\n=== 反推验证码 ===');
  log(code ? `  最新码 = ${code}（未过期、未使用）` : '  没爆破出来（可能被别的进程先用了）');
}

// ---------- 3) 真的走一遍登录 ----------
log('\n=== 走 /auth/login/sms ===');
let session = null;
if (code) {
  const r = await fetch(`${BASE}/auth/login/sms`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, code }),
  });
  const txt = await r.text();
  log('  HTTP %d  %s', r.status, txt.slice(0, 600));
  if (r.ok) { try { session = JSON.parse(txt); } catch {} }
} else {
  log('  跳过（没有可用验证码）');
}

// ---------- 4) 拿 token 调 /auth/me ----------
if (session?.token) {
  log('\n=== /auth/me ===');
  const r = await fetch(`${BASE}/auth/me`, { headers: { authorization: `Bearer ${session.token}` } });
  log('  HTTP %d  %s', r.status, (await r.text()).slice(0, 600));
  log('\n=== 会话摘要 ===');
  log('  user =', JSON.stringify(session.user));
  log('  project =', JSON.stringify(session.project));
  log('  agents =', JSON.stringify(session.agents));
} else {
  log('\n  !! 没拿到 token，登录没成功');
}

await db.end();
