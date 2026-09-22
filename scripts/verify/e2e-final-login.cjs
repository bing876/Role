// e2e-final-login.cjs —— 在**单次进程内**完成「起服务端 → 等库真就绪 → 发码 → 反推 → 登录」。
//
// 为什么必须单进程内做完：agent 工具调用一结束，派生进程会被全部回收，
// 服务端活不过一次调用（见 MEMORY.md 第四节）。
//
// 用法：node scripts/verify/e2e-final-login.cjs
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const LOG = path.join(REPO, 'docs', 'acceptance', 'root-cause', 'final-login-e2e.log');
const out = [];
const say = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };
const dump = () => fs.writeFileSync(LOG, out.join('\n') + '\n', 'utf8');

const PHONE = process.env.PHONE || '18665594441';
// ★ PHONE_PEPPER 在 .env 里为空 -> env.ts:80 回落成 DATA_KEY，别用空串算
const PEPPER = process.env.PHONE_PEPPER
  || '37e9158ac1e8b27befae29e59e0f94dc7d3b5f9408e853f9afcde816231cf887';

// 带重试的 fetch：服务端刚起来时连接会被重置（ECONNRESET），不能裸调
async function safeFetch(url, opts = {}, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts);
      return r;
    } catch (e) {
      // ECONNRESET / ECONNREFUSED：服务端还在初始化，等一下再试
      await new Promise(r => setTimeout(r, 700));
    }
  }
  return null;
}

(async () => {
  // 先看 8787 是否已经有东西在跑；没有才自己拉起来
  let already = false;
  try { const r = await fetch('http://127.0.0.1:8787/health'); already = r.ok; } catch {}
  let child = null;
  if (!already) {
    child = spawn(process.execPath,
      [path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
      { cwd: path.join(REPO, 'apps', 'server'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', d => out.push('[srv] ' + d.toString().trimEnd()));
    child.stderr.on('data', d => out.push('[srv!] ' + d.toString().trimEnd()));
  } else {
    say('(8787 已有服务端在跑，直接用)');
  }

  // ---- 1) 等 /health 的 db 真的 up ----
  let hp = null;
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const r = await safeFetch('http://127.0.0.1:8787/health', {}, 1);
    if (!r) continue;
    try { hp = await r.json(); } catch { continue; }
    if (hp.db === 'up') break;
  }
  say('=== /health ===', JSON.stringify(hp));

  // ---- 2) 核对 probe 身份校验所依赖的 service 字段 ----
  const svc = hp && hp.service;
  say('service 标识 =', svc, svc === 'ai-workbench-server' ? '✓' : '✗ (probe 会拒绝这个后端)');

  // ---- 3) 发码 ----
  const send = await safeFetch('http://127.0.0.1:8787/auth/sms/send', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: PHONE }),
  });
  say('=== POST /auth/sms/send ===', send ? send.status : '(请求失败)',
    send ? (await send.text()).slice(0, 200) : '');

  // ---- 4) 直连库反推验证码（不依赖看服务端窗口日志）----
  const { Client } = require(path.join(REPO, 'node_modules', 'pg'));
  const db = new Client({ connectionString: 'postgresql://workbench:workbench@localhost:5432/workbench' });
  await db.connect();
  const h = crypto.createHmac('sha256', PEPPER).update(PHONE, 'utf8').digest('hex');
  const rows = (await db.query(
    `SELECT id, code_hash, salt, expires_at, used
       FROM sms_codes WHERE phone_hash = $1 ORDER BY created_at DESC LIMIT 1`, [h])).rows;
  say('sms_codes 最新一条:', rows.length ? `id=${rows[0].id} used=${rows[0].used}` : '(无)');

  let code = null;
  if (rows.length && !rows[0].used && rows[0].expires_at > new Date()) {
    for (let i = 0; i < 1_000_000; i++) {
      const c = String(i).padStart(6, '0');
      if (crypto.createHash('sha256').update(`${rows[0].salt}$${c}`, 'utf8').digest('hex') === rows[0].code_hash) {
        code = c; break;
      }
    }
  }
  say('反推验证码 =', code);
  await db.end();

  // ---- 5) 登录 ----
  if (code) {
    const login = await safeFetch('http://127.0.0.1:8787/auth/login/sms', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: PHONE, code }),
    });
    if (!login) {
      say('=== POST /auth/login/sms === (请求失败，服务端未响应)');
    } else {
      const body = await login.text();
      say('=== POST /auth/login/sms ===', login.status);
      let j = null; try { j = JSON.parse(body); } catch { /* 非 JSON */ }
      if (j) {
        say('  token?', !!j.token,
          '| user.id =', j.user && j.user.id,
          '| xyz =', (j.user && (j.user.xyzId || j.user.xyz_id)) || '(未回)');
      } else {
        say('  body:', body.slice(0, 300));
      }
    }
  } else {
    say('(反推不到有效验证码 —— 可能没发成功或已过期)');
  }

  dump();
  if (child) { try { child.kill(); } catch { /* 已退出 */ } }
  process.exit(0);
})();
