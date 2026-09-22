// who-is.cjs —— 按手机号查：库里有几个账号、各自是哪个 XYZ、hash 用的是哪个 pepper。
//
// 用来回答"我的账号是不是没了 / 是不是被新建了一个"。
// 口径：`users.phone_enc` 是**可解密的手机号副本**（AES-256-GCM，key = DATA_KEY），
//       所以即使 `phone_hash` 因为 pepper 轮换而"对不上"，也能靠解密找出真实归属。
//
// 用法：node scripts/verify/who-is.cjs [手机号]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const os = require('os');

const REPO = path.resolve(__dirname, '..', '..');
const PHONE = process.argv[2] || '18665594444';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readEnvFile() {
  const p = path.join(REPO, 'apps', 'server', '.env');
  const o = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return o;
}

const portOpen = (p, t = 600) => new Promise((res) => {
  const s = net.connect({ host: '127.0.0.1', port: p });
  const d = (v) => { s.destroy(); res(v); };
  s.setTimeout(t, () => d(false)); s.once('connect', () => d(true)); s.once('error', () => d(false));
});

(async () => {
  const env = readEnvFile();
  const key = /^[0-9a-fA-F]{64}$/.test(env.DATA_KEY)
    ? Buffer.from(env.DATA_KEY, 'hex')
    : crypto.createHash('sha256').update(env.DATA_KEY || '').digest();
  const dec = (payload) => {
    const [t, iv, tg, ct] = String(payload).split('$');
    if (t !== 'gcm') throw new Error('bad');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tg, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  };
  const mask = (p) => (p && p.length === 11 ? `${p.slice(0, 3)}****${p.slice(7)}` : '****');

  // 确保库在
  if (!(await portOpen(5432))) {
    const home = process.env.WORKBENCH_PG_HOME || path.join(os.homedir(), 'workbuddy-ai', 'pg2');
    const exe = path.join(home, 'pg', 'bin', 'postgres.exe');
    const dataDir = path.join(home, 'data');
    const pidFile = path.join(dataDir, 'postmaster.pid');
    if (fs.existsSync(pidFile)) {
      const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').split('\n')[0].trim(), 10);
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
      if (!(r.stdout || '').includes(`"${pid}"`)) fs.rmSync(pidFile, { force: true });
    }
    const c = spawn(exe, ['-D', dataDir], { detached: true, stdio: 'ignore', windowsHide: true });
    c.unref();
  }

  const { Client } = require(path.join(REPO, 'node_modules', 'pg'));
  const CS = 'postgresql://workbench:workbench@localhost:5432/workbench';
  let db = null;
  for (let i = 0; i < 90; i++) {
    const c = new Client({ connectionString: CS });
    try { await c.connect(); await c.query('SELECT 1'); db = c; break; }
    catch { try { await c.end(); } catch { /* ignore */ } await sleep(1000); }
  }
  if (!db) { console.log('✗ 库连不上'); process.exit(1); }

  const rows = (await db.query(
    'SELECT id, xyz_id, phone_hash, phone_enc, current_project_id FROM users ORDER BY id')).rows;

  const hNew = crypto.createHmac('sha256', env.PHONE_PEPPER || '').update(PHONE, 'utf8').digest('hex');
  const hOld = crypto.createHmac('sha256', env.DATA_KEY || '').update(PHONE, 'utf8').digest('hex');

  console.log(`=== 目标手机号 ${mask(PHONE)}（完整 ${PHONE}）===`);
  console.log(`  hash(新 pepper) = ${hNew.slice(0, 16)}…`);
  console.log(`  hash(旧 pepper) = ${hOld.slice(0, 16)}…\n`);

  const mine = [];
  for (const r of rows) {
    let phone = null;
    try { phone = dec(r.phone_enc); } catch { /* 解不开 */ }
    if (phone === PHONE) mine.push(r);
  }

  console.log(`=== 库里 phone_enc 解出来 == 这个号的账号：${mine.length} 个 ===`);
  for (const r of mine) {
    const which = r.phone_hash === hNew ? '新 pepper ✓' : (r.phone_hash === hOld ? '旧 pepper ✗' : '两边都不匹配 ✗');
    console.log(`  id=${r.id}  XYZ=${r.xyz_id}  hash=${String(r.phone_hash).slice(0, 16)}…  → ${which}`);
  }
  if (!mine.length) {
    console.log('  （一个都没有 —— 这个手机号在库里没有任何账号）');
  }

  // 顺带：有没有 hash 对得上、但 phone_enc 解出来不是这个号的（数据不一致）
  const byHash = rows.filter((r) => r.phone_hash === hNew || r.phone_hash === hOld);
  console.log(`\n=== 按 hash 能命中的账号（说明它就是这个号）===`);
  if (!byHash.length) console.log('  （0 个）');
  for (const r of byHash) {
    let phone = '(解不开)';
    try { phone = mask(dec(r.phone_enc)); } catch { /* ignore */ }
    console.log(`  id=${r.id}  XYZ=${r.xyz_id}  phone_enc=${phone}`);
  }

  const total = (await db.query('SELECT count(*)::int n FROM users')).rows[0].n;
  console.log(`\nusers 总数 = ${total}`);
  await db.end();
})().catch((e) => { console.error('出错：', e.message); process.exit(2); });
