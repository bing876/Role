// no-popup-e2e.cjs —— 决定性验证：应用把 PG 拉起来时**不再弹终端**。
//
// 场景（用户报的）：每次 PG 被（重）启动就弹一个黑窗，标题是 postgres.exe 的路径。
// 修法：① 应用内 spawn 去掉 `detached`（DETACHED_PROCESS 会逼 Windows 新建控制台）；
//       ② 所有脚本里的 `start ""` 改成 `start "" /B`。
//
// ★ 判据必须是「**可见窗口**」而不是「conhost 进程数」：
//   本机 Win11 默认终端是 Windows Terminal，控制台窗口由 `WindowsTerminal.exe` 承载；
//   而且 `conhost.exe … 0x4` 在无窗口的伪控制台场景也会出现、旧窗口还会残留 —— 数它会得出错误结论。
//   正确判据：**标题里含 `postgres.exe` 的可见窗口有几个**。
//
// 判据：
//   ① 起点：0 个 PG 窗口
//   ② 应用启动后把 PG 拉起来 → 仍然 0 个窗口
//   ③ 杀掉 PG，让**应用的心跳**把它拉回来 → 仍然 0 个窗口
//   ④ 过程中 /health 的 db 一直是 up（证明不是"靠不启动来不弹窗"）
//
// 用法：node scripts/verify/no-popup-e2e.cjs
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const EXE = 'C:\\Users\\bing\\AppData\\Local\\Programs\\@ai-workbenchdesktop\\AI 工作台.exe';
const REPO = path.resolve(__dirname, '..', '..');
const LOG = path.join(REPO, 'docs', 'acceptance', 'root-cause', 'no-popup-e2e.log');

const out = [];
const t0 = Date.now();
const say = (...a) => { const s = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ` + a.join(' '); out.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (n, ok, d = '') => { checks.push([n, ok, d]); say(`   ${ok ? '✓' : '✗'} ${n}${d ? `  [${d}]` : ''}`); };
const dump = () => { try { fs.writeFileSync(LOG, out.join('\n') + '\n', 'utf8'); } catch { /* ignore */ } };

const ps = (script) => (spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
  { encoding: 'utf8', windowsHide: true }).stdout || '').trim();

/** 可见的「PG 控制台窗口」 */
const pgWindows = () => ps(
  `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*postgres.exe*' } | ForEach-Object { "$($_.Id)|$($_.ProcessName)" }`
).split('\n').map((l) => l.trim()).filter(Boolean);

const killPgWindows = () => ps(
  `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*postgres.exe*' } | Stop-Process -Force -ErrorAction SilentlyContinue`
);
const killPg = () => spawnSync('taskkill', ['/F', '/IM', 'postgres.exe'], { stdio: 'ignore', windowsHide: true });
const portOpen = (p, t = 600) => new Promise((res) => {
  const s = net.connect({ host: '127.0.0.1', port: p });
  const d = (v) => { s.destroy(); res(v); };
  s.setTimeout(t, () => d(false)); s.once('connect', () => d(true)); s.once('error', () => d(false));
});
const healthDbUp = async () => {
  try {
    const r = await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return j?.db === 'up';
  } catch { return false; }
};

(async () => {
  if (!fs.existsSync(EXE)) { say('✗ 找不到可执行文件'); process.exit(1); }

  // ---- 起点：清干净 ----
  for (const pid of (spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || '')
    .split('\n').filter((l) => /:8787\s+\S+\s+LISTENING/.test(l)).map((l) => l.trim().split(/\s+/).pop())) {
    spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
  killPg(); killPgWindows();
  await sleep(3000);
  const w0 = pgWindows().length;
  say(`起点：可见 PG 窗口 = ${w0} 个`);
  check('① 起点是 0 个 PG 窗口（前提干净）', w0 === 0, `${w0}`);

  // ---- 启动应用 ----
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-nopopup-'));
  const child = spawn(EXE, ['--no-sandbox', `--user-data-dir=${userData}`],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  say('应用 PID =', child.pid, '（临时 userData）');
  const buf = [];
  child.stdout.on('data', (d) => buf.push('[out] ' + d.toString()));
  child.stderr.on('data', (d) => buf.push('[err] ' + d.toString()));

  // ---- ② 等它把 PG 拉起来，看有没有窗口 ----
  say('\n=== ② 应用自己拉起 PG（关键：这一步原来会弹窗）===');
  let up = false;
  for (let i = 0; i < 90; i++) { if (await portOpen(5432)) { up = true; break; } await sleep(1000); }
  await sleep(3000);
  const w1 = pgWindows();
  check('② PG 被应用拉起来了', up);
  check('★★ 拉起 PG 时**没有**弹出任何终端窗口', w1.length === 0, w1.length ? w1.join(' , ') : '0 个');

  // ---- ③ 杀掉 PG，让心跳拉回来 ----
  say('\n=== ③ 杀掉 PG，让应用心跳把它拉回来 ===');
  killPg(); killPgWindows();
  await sleep(2500);
  const dead = !(await portOpen(5432));
  check('③a PG 确实被杀掉了', dead);
  let back = false;
  for (let i = 0; i < 45; i++) { if (await portOpen(5432)) { back = true; break; } await sleep(1000); }
  await sleep(3000);
  const w2 = pgWindows();
  check('③b 心跳把 PG 拉回来了', back);
  check('★★ 心跳拉起 PG 时也**没有**弹窗', w2.length === 0, w2.length ? w2.join(' , ') : '0 个');

  // ---- ④ 不是"靠不启动来不弹窗" ----
  say('\n=== ④ 确认后端真的可用（不是靠不启动来"不弹窗"）===');
  let dbUp = false;
  for (let i = 0; i < 60; i++) { if (await healthDbUp()) { dbUp = true; break; } await sleep(1000); }
  check('④ /health 的 db = up（后端真的可用）', dbUp);

  // 全程窗口数变化
  say(`\n窗口数轨迹：起点 ${w0} → 应用拉起后 ${w1.length} → 心跳拉起后 ${w2.length}`);

  const failed = checks.filter(([, ok]) => !ok).length;
  say(`\n通过 ${checks.length - failed} / 失败 ${failed}`);
  say(failed === 0 ? '=== 结论：拉 PG 不再弹终端，且后端可用 ===' : '=== 结论：有判据没过 ===');
  dump();
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})().catch((e) => { say('出错：' + (e && e.stack ? e.stack : e)); dump(); process.exit(2); });
