// which-pepper.cjs —— 现场判定：服务端**实际**在用哪个 pepper 算 phone_hash？
//
// 为什么需要：`.env` 里 PHONE_PEPPER 是一个**独立的新值**（≠ DATA_KEY），
// 但 e2e 用**旧值**（DATA_KEY）反推验证码却成功匹配到了行 —— 两者不可能同时成立。
// 猜没有意义，直接拿两个候选值各算一遍去库里对。
//
// ★ 顺带覆盖一个 dotenv 的经典坑：`dotenv` 默认**不覆盖**已存在的环境变量，
//   所以"父进程 env 里有空串 PHONE_PEPPER"会让 .env 里的值被无视 → 悄悄回落到 DATA_KEY。
//
// 用法：node scripts/verify/which-pepper.cjs [手机号]
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const os = require('os');
const net = require('net');

const REPO = path.resolve(__dirname, '..', '..');
const PHONE = process.argv[2] || process.env.PHONE || '18665594441';
const OLD_FALLBACK = '37e9158ac1e8b27befae29e59e0f94dc7d3b5f9408e853f9afcde816231cf887';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (p, t = 600) => new Promise((res) => {
  const s = net.connect({ host: '127.0.0.1', port: p });
  const d = (v) => { s.destroy(); res(v); };
  s.setTimeout(t, () => d(false)); s.once('connect', () => d(true)); s.once('error', () => d(false));
});

function readEnvFile() {
  const p = path.join(REPO, 'apps', 'server', '.env');
  if (!fs.existsSync(p)) return {};
  const o = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return o;
}

(async () => {
  const envFile = readEnvFile();
  const ppFile = envFile.PHONE_PEPPER || '';
  const dkFile = envFile.DATA_KEY || '';
  console.log('=== .env ===');
  console.log(`  PHONE_PEPPER 长度=${ppFile.length}  ${ppFile ? ppFile.slice(0, 8) + '…' : '(空/缺)'}`);
  console.log(`  DATA_KEY     长度=${dkFile.length}  ${dkFile ? dkFile.slice(0, 8) + '…' : '(空/缺)'}`);
  console.log(`  PHONE_PEPPER === DATA_KEY ? ${ppFile === dkFile}`);
  console.log(`  PHONE_PEPPER === 旧回落值 ? ${ppFile === OLD_FALLBACK}`);
  console.log(`  DATA_KEY      === 旧回落值 ? ${dkFile === OLD_FALLBACK}`);

  // ---- 确保库在（不在就自己起，单次调用内起→验） ----
  if (!(await portOpen(5432))) {
    const home = process.env.WORKBENCH_PG_HOME || path.join(os.homedir(), 'workbuddy-ai', 'pg2');
    const exe = path.join(home, 'pg', 'bin', 'postgres.exe');
    const dataDir = path.join(home, 'data');
    const pidFile = path.join(dataDir, 'postmaster.pid');
    if (fs.existsSync(pidFile)) {
      const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').split('\n')[0].trim(), 10);
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
      if (!(r.stdout || '').includes(`"${pid}"`)) { fs.rmSync(pidFile, { force: true }); console.log('(清了陈旧 pid)'); }
    }
    console.log('5432 不通，自己起一个…');
    const c = spawn(exe, ['-D', dataDir], { detached: true, stdio: 'ignore', windowsHide: true });
    c.unref();
  } else {
    console.log('5432 已在跑');
  }

  const { Client } = require(path.join(REPO, 'node_modules', 'pg'));
  const CS = 'postgresql://workbench:workbench@localhost:5432/workbench';
  // ★ 每次重试都用**新的 Client**：connect() 失败后同一个实例会卡在坏状态，
  //   重试它只会一直失败（第一版就是这么写，90 次全废、看起来像"库起不来"）。
  let db = null;
  let lastErr = '';
  for (let i = 0; i < 90; i++) {
    const c = new Client({ connectionString: CS });
    try { await c.connect(); await c.query('SELECT 1'); db = c; break; }
    catch (e) { lastErr = e.message; try { await c.end(); } catch { /* ignore */ } await sleep(1000); }
  }
  if (!db) { console.log('✗ 库一直连不上：', lastErr); process.exit(1); }
  console.log('库已就绪（等了约 ' + (Date.now() % 1000) + 'ms 量级，细节见上）');

  const cands = [
    ['旧回落值(DATA_KEY)', OLD_FALLBACK],
    ['.env 的 PHONE_PEPPER', ppFile],
    ['.env 的 DATA_KEY', dkFile],
  ];
  console.log('\n=== 用各候选值算 phone_hash 去库里对（手机号 ' + PHONE + '） ===');
  const results = [];
  for (const [name, pep] of cands) {
    if (!pep) continue;
    const h = crypto.createHmac('sha256', pep).update(PHONE, 'utf8').digest('hex');
    const u = (await db.query('SELECT count(*)::int n FROM users WHERE phone_hash = $1', [h])).rows[0].n;
    const s = (await db.query('SELECT count(*)::int n FROM sms_codes WHERE phone_hash = $1', [h])).rows[0].n;
    console.log(`  ${name.padEnd(22)} users 命中=${u}  sms_codes 命中=${s}`);
    results.push([name, u, s]);
  }
  // ---- 原始证据：直接看行，别只看计数 ----
  console.log('\n=== 原始行 ===');
  const us = (await db.query('SELECT id, xyz_id, phone_hash FROM users ORDER BY id')).rows;
  const hOld = crypto.createHmac('sha256', OLD_FALLBACK).update(PHONE, 'utf8').digest('hex');
  const hNew = crypto.createHmac('sha256', ppFile).update(PHONE, 'utf8').digest('hex');
  for (const u of us) {
    const tag = u.phone_hash === hOld ? '← 旧 pepper' : (u.phone_hash === hNew ? '← 新 pepper' : '');
    console.log(`  users id=${u.id} xyz=${u.xyz_id} hash=${(u.phone_hash || '').slice(0, 16)}… ${tag}`);
  }
  const sc = (await db.query(
    'SELECT id, phone_hash, used, created_at FROM sms_codes ORDER BY created_at DESC LIMIT 5')).rows;
  for (const r of sc) {
    const tag = r.phone_hash === hOld ? '← 旧 pepper' : (r.phone_hash === hNew ? '← 新 pepper' : '');
    console.log(`  sms id=${r.id} used=${r.used} at=${r.created_at.toISOString?.() || r.created_at} hash=${(r.phone_hash || '').slice(0, 16)}… ${tag}`);
  }
  await db.end();

  const winner = results.filter(([, u, s]) => u + s > 0).map(([n]) => n);
  console.log('\n=== 结论 ===');
  if (winner.length === 1) console.log(`服务端实际在用的 pepper = ${winner[0]}`);
  else if (winner.length === 0) console.log('✗ 三个候选都没命中 —— 用的既不是 .env 的值也不是 DATA_KEY，需要再查');
  else console.log(`⚠ 多个候选都命中（${winner.join(' / ')}）—— 说明库里混着两套 hash，历史数据没迁干净`);
})().catch((e) => { console.error('出错：', e.message); process.exit(2); });
