// server-heartbeat-e2e.cjs —— 证明「后端掉了会自己拉回来」。
//
// 场景（用户实际遇到的）：应用开着、人在工作台里，**8787 上的服务端进程死了**，
// 于是发消息就是「连不上后端：Failed to fetch」，而且**自己永远好不了** ——
// 因为原来的实现只在启动时拉一次。
//
// 判据（缺一条就是假 PASS）：
//   ① 应用启动后 /health 通
//   ② 杀掉服务端 → /health 不通（证明我们真的杀掉了，不是杀错进程）
//   ③ **不用重启应用**，/health 在 40 秒内自己恢复
//   ④ 应用日志里出现重新拉起的痕迹
//   ⑤ 恢复后能真登录（200 + token）
//
// 用法：node scripts/verify/server-heartbeat-e2e.cjs
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const EXE = 'C:\\Users\\bing\\AppData\\Local\\Programs\\@ai-workbenchdesktop\\AI 工作台.exe';
const REPO = path.resolve(__dirname, '..', '..');
const LOG = path.join(REPO, 'docs', 'acceptance', 'root-cause', 'server-heartbeat-e2e.log');
const PHONE = process.env.PHONE || '18665594441';

const out = [];
const t0 = Date.now();
const say = (...a) => { const s = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ` + a.join(' '); out.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (n, ok, d = '') => { checks.push([n, ok, d]); say(`   ${ok ? '✓' : '✗'} ${n}${d ? `  [${d}]` : ''}`); };
const dump = () => { try { fs.writeFileSync(LOG, out.join('\n') + '\n', 'utf8'); } catch { /* ignore */ } };

const portOpen = (p, t = 700) => new Promise((res) => {
  const s = net.connect({ host: '127.0.0.1', port: p });
  const d = (v) => { s.destroy(); res(v); };
  s.setTimeout(t, () => d(false)); s.once('connect', () => d(true)); s.once('error', () => d(false));
});
const healthUp = async () => {
  try {
    const r = await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return j?.service === 'ai-workbench-server' && j.db === 'up';
  } catch { return false; }
};
/** 找出监听 8787 的进程 PID */
function whoListens8787() {
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
  const pids = new Set();
  for (const line of (r.stdout || '').split('\n')) {
    if (!/LISTENING/.test(line)) continue;
    const m = line.match(/TCP\s+\S*:8787\s+\S+\s+LISTENING\s+(\d+)/);
    if (m) pids.add(m[1]);
  }
  return [...pids];
}
function readPepper() {
  const env = fs.readFileSync(path.join(REPO, 'apps', 'server', '.env'), 'utf8');
  const pick = (k) => { const m = env.match(new RegExp('^\\s*' + k + '\\s*=\\s*(.*)$', 'm')); return m ? m[1].replace(/^["']|["']$/g, '').trim() : ''; };
  return pick('PHONE_PEPPER') || pick('DATA_KEY');
}

(async () => {
  if (!fs.existsSync(EXE)) { say('✗ 找不到可执行文件'); process.exit(1); }

  // ---- 前提：8787 必须没人（否则应用会"直接用别人那份"、不持有句柄，测的就不是保活）----
  for (const pid of whoListens8787()) {
    spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    say(`（清掉 8787 上的残留服务端 PID ${pid}）`);
  }
  await sleep(1500);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-hb-'));
  const child = spawn(EXE, ['--no-sandbox', `--user-data-dir=${userData}`],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  say('应用 PID =', child.pid, '（临时 userData，不碰你的登录态）');
  const buf = [];
  const relay = (t) => (d) => {
    const s = d.toString(); buf.push(t + s);
    for (const line of s.split('\n')) {
      if (/supervisor|\[server\]|数据库|PostgreSQL|服务端/.test(line) && line.trim()) {
        say('   | ' + line.trim().slice(0, 150));
      }
    }
  };
  child.stdout.on('data', relay('[out] '));
  child.stderr.on('data', relay('[err] '));

  // ---- ① 等它自己把库 + 服务端拉起来 ----
  say('\n=== ① 等应用自愈 ===');
  let up = false;
  for (let i = 0; i < 90; i++) { if (await healthUp()) { up = true; break; } await sleep(1000); }
  check('① 应用启动后 /health 通（service + db 都正常）', up);

  // ---- ② 杀掉服务端 ----
  say('\n=== ② 杀掉 8787 上的服务端（模拟"后端进程死了"）===');
  const pids = whoListens8787();
  say('   监听 8787 的 PID =', pids.join(',') || '(没有)');
  for (const pid of pids) spawnSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore', windowsHide: true });
  await sleep(2500);
  const dead = !(await portOpen(8787));
  check('② 服务端确实被杀掉了（8787 不再监听）', dead, `portOpen=${!dead}`);

  // ---- ③ 不重启应用，等它自己拉回来 ----
  say('\n=== ③ 等应用自己把后端拉回来（最多 40 秒）===');
  let back = false;
  const tBack = Date.now();
  for (let i = 0; i < 40; i++) { if (await healthUp()) { back = true; break; } await sleep(1000); }
  const secs = ((Date.now() - tBack) / 1000).toFixed(1);
  check('③ ★ 不重启应用，后端自己恢复了', back, back ? `用了 ${secs}s` : '40 秒内没回来');

  // ---- ④ 日志里能看到"重新拉起" ----
  const text = buf.join('');
  check('④ 日志里有重新拉起的痕迹', /8787 不通，自动拉起|✅ 服务端已就绪/.test(text),
    (/8787 不通，自动拉起/.test(text) ? '看到「8787 不通，自动拉起」' : '没看到'));

  // ---- ⑤ 恢复后能真登录 ----
  say('\n=== ⑤ 恢复后真登录一次 ===');
  if (back) {
    let code = null;
    for (let i = 0; i < 6; i++) {
      const s = await fetch('http://127.0.0.1:8787/auth/sms/send', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: PHONE }),
      }).catch(() => null);
      if (s && s.status === 200) break;
      say('   （发码未成功，等 20 秒重试）');
      await sleep(20000);
    }
    try {
      const { Client } = require(path.join(REPO, 'node_modules', 'pg'));
      const db = new Client({ connectionString: 'postgresql://workbench:workbench@localhost:5432/workbench' });
      await db.connect();
      const h = crypto.createHmac('sha256', readPepper()).update(PHONE, 'utf8').digest('hex');
      const row = (await db.query(
        'SELECT code_hash, salt, used, expires_at FROM sms_codes WHERE phone_hash=$1 ORDER BY created_at DESC LIMIT 1', [h])).rows[0];
      if (row && !row.used && row.expires_at > new Date()) {
        for (let i = 0; i < 1_000_000; i++) {
          const c = String(i).padStart(6, '0');
          if (crypto.createHash('sha256').update(`${row.salt}$${c}`, 'utf8').digest('hex') === row.code_hash) { code = c; break; }
        }
      }
      await db.end();
    } catch (e) { say('   直连库失败：' + e.message); }
    const login = code ? await fetch('http://127.0.0.1:8787/auth/login/sms', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: PHONE, code }),
    }).catch(() => null) : null;
    const j = login ? await login.json().catch(() => null) : null;
    check('⑤ 恢复后登录 200 + token', !!login && login.status === 200 && !!j?.token,
      login ? `${login.status} user.id=${j?.user?.id}` : '没发出请求');
  } else {
    check('⑤ 恢复后登录 200 + token', false, '后端没恢复，跳过');
  }

  const failed = checks.filter(([, ok]) => !ok).length;
  say(`\n通过 ${checks.length - failed} / 失败 ${failed}`);
  say(failed === 0 ? '=== 结论：后端掉了会自己拉回来，不用重启应用 ===' : '=== 结论：有判据没过 ===');
  dump();
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})().catch((e) => { say('探针自身出错：' + (e && e.stack ? e.stack : e)); dump(); process.exit(2); });
