// pg-launch-window-test.cjs —— 实测「哪种启动 PG 的方式不会弹控制台窗口」。
//
// ★★ 判据的坑（第一版就踩了）：本机是 Windows 11，**默认终端是 Windows Terminal**，
//    控制台窗口由 `WindowsTerminal.exe` 承载，**不是 `conhost.exe`**。
//    而且 `conhost.exe ... 0x4` 在无窗口场景（伪控制台）也会出现、旧窗口还会残留，
//    所以"数 conhost"完全测不准（第一版得出"四种方式全弹窗"的结论，不可信）。
//
// ✅ 正确判据：**看有没有一个可见窗口，它的标题是 postgres.exe 的路径**。
//    （控制台窗口标题默认就是被启动程序的完整路径。）
//    在 PowerShell 里就是 `Get-Process | ? { $_.MainWindowTitle -like '*postgres.exe*' }`。
//
// 用法：node scripts/verify/pg-launch-window-test.cjs
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const PG_HOME = process.env.WORKBENCH_PG_HOME || path.join(os.homedir(), 'workbuddy-ai', 'pg2');
const BIN = path.join(PG_HOME, 'pg', 'bin');
const EXE = path.join(BIN, 'postgres.exe');
const PGCTL = path.join(BIN, 'pg_ctl.exe');
const DATA = path.join(PG_HOME, 'data');
const PIDFILE = path.join(DATA, 'postmaster.pid');
const LOG = path.join(__dirname, '..', '..', 'docs', 'acceptance', 'root-cause', 'pg-launch-window-test.log');

const out = [];
const say = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dump = () => { try { fs.writeFileSync(LOG, out.join('\n') + '\n', 'utf8'); } catch { /* ignore */ } };

/** 可见的「PG 控制台窗口」有几个（标题里带 postgres.exe 的可见窗口） */
function pgWindows() {
  const ps = `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*postgres.exe*' } | ForEach-Object { "$($_.Id)|$($_.ProcessName)|$($_.MainWindowTitle)" }`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
}
const portOpen = (p, t = 700) => new Promise((res) => {
  const s = net.connect({ host: '127.0.0.1', port: p });
  const d = (v) => { s.destroy(); res(v); };
  s.setTimeout(t, () => d(false)); s.once('connect', () => d(true)); s.once('error', () => d(false));
});

function killPg() {
  spawnSync('taskkill', ['/F', '/IM', 'postgres.exe'], { stdio: 'ignore', windowsHide: true });
  // 顺带把承载它控制台的终端窗口关掉（否则残留窗口会污染下一轮测量）
  const ps = `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*postgres.exe*' } | Stop-Process -Force -ErrorAction SilentlyContinue`;
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
}
function clearPid() { try { fs.rmSync(PIDFILE, { force: true }); } catch { /* ignore */ } }

async function tryLaunch(name, launch) {
  killPg();
  await sleep(2500);
  clearPid();
  await sleep(500);
  const before = pgWindows().length;
  await launch();
  let up = false;
  for (let i = 0; i < 60; i++) { await sleep(500); if (await portOpen(5432, 400)) { up = true; break; } }
  await sleep(2500);
  const wins = pgWindows();
  const delta = wins.length - before;
  say(`  ${name}`);
  say(`     可见 PG 控制台窗口: ${before} -> ${wins.length}   增量=${delta}   ${delta === 0 ? '✅ 不弹窗' : '❌ 弹窗了'}`);
  say(`     PG 可用=${up ? '是' : '否'}   窗口=${wins.join(' , ') || '(无)'}`);
  return { name, delta, up };
}

(async () => {
  if (!fs.existsSync(EXE)) { console.error('✗ 找不到 postgres.exe：', EXE); process.exit(1); }
  say('=== PG 启动方式 · 弹窗实测（判据：标题含 postgres.exe 的可见窗口）===');
  say(`exe = ${EXE}\n`);

  const results = [];

  results.push(await tryLaunch('① cmd: start "" "postgres.exe" -D data   （脚本现状）', async () => {
    const f = path.join(os.tmpdir(), `pgt1-${Date.now()}.cmd`);
    fs.writeFileSync(f, `@echo off\r\nchcp 936 >nul\r\nstart "" "${EXE}" -D "${DATA}"\r\n`, 'latin1');
    spawnSync('cmd', ['/c', f], { stdio: 'ignore', windowsHide: true, timeout: 20000 });
  }));

  results.push(await tryLaunch('② cmd: start "" /B "postgres.exe" -D data', async () => {
    const f = path.join(os.tmpdir(), `pgt2-${Date.now()}.cmd`);
    fs.writeFileSync(f, `@echo off\r\nchcp 936 >nul\r\nstart "" /B "${EXE}" -D "${DATA}"\r\n`, 'latin1');
    spawnSync('cmd', ['/c', f], { stdio: 'ignore', windowsHide: true, timeout: 20000 });
  }));

  results.push(await tryLaunch('③ node: spawn(detached:true, windowsHide:true)   （应用现在用的）', async () => {
    const c = spawn(EXE, ['-D', DATA], { detached: true, stdio: 'ignore', windowsHide: true });
    c.unref();
  }));

  results.push(await tryLaunch('④ node: spawn(windowsHide:true)  不要 detached', async () => {
    const c = spawn(EXE, ['-D', DATA], { stdio: 'ignore', windowsHide: true });
    c.unref();
  }));

  if (fs.existsSync(PGCTL)) {
    results.push(await tryLaunch('⑤ pg_ctl start -D data -l pg.log  （官方后台方式）', async () => {
      spawnSync(PGCTL, ['start', '-D', DATA, '-l', path.join(PG_HOME, 'pg.log')], {
        stdio: 'ignore', windowsHide: true, timeout: 30000,
      });
    }));
  }

  say('\n=== 汇总 ===');
  for (const r of results) {
    say(`  ${r.delta === 0 && r.up ? '✅' : (r.up ? '❌' : '⚠')} 窗口增量 ${String(r.delta).padStart(2)}  可用=${r.up ? '是' : '否'}   ${r.name}`);
  }
  const good = results.filter((r) => r.delta === 0 && r.up);
  say(`\n不弹窗且能起来的：${good.length} 种`);
  for (const g of good) say('   · ' + g.name);

  // 收尾：用第一个"不弹窗"的方式把 PG 留在运行状态；没有就退回 ③
  killPg();
  await sleep(2500);
  clearPid();
  const c = spawn(EXE, ['-D', DATA], { detached: true, stdio: 'ignore', windowsHide: true });
  c.unref();
  dump();
  say('\n（已把 PG 留在运行状态）');
})().catch((e) => { say('出错：' + (e && e.stack ? e.stack : e)); dump(); process.exit(2); });
