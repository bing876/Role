// launch-check.cjs —— 单次调用内「起应用 → 等 → 判定 → 收尾」。
//
// 为什么必须一次做完：agent 工具调用一结束，派生进程会被回收（MEMORY.md 第四节），
// 应用活不过一次调用，所以不能在调用 A 里起、到调用 B 里看。
//
// 判定口径（都按最坏情况写）：
//   ① 进程是否还在（按 PID 问，不按进程名 —— 本机 tasklist 读不到非 ASCII 名）
//   ② 输出里有没有 asar 解析失败的特征（Failed to parse header / Invalid package）
//
// 用法：node scripts/verify/launch-check.cjs
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXE = 'C:\\Users\\bing\\AppData\\Local\\Programs\\@ai-workbenchdesktop\\AI 工作台.exe';
const REPO = path.resolve(__dirname, '..', '..');
const LOG = path.join(REPO, 'docs', 'acceptance', 'root-cause', 'launch-check.log');

const out = [];
const say = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };

const alive = (pid) => {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
  return (r.stdout || '').includes(`"${pid}"`);
};

(async () => {
  if (!fs.existsSync(EXE)) { say('✗ 找不到可执行文件:', EXE); process.exit(1); }
  say('启动:', path.basename(EXE));

  const child = spawn(EXE, ['--no-sandbox'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  const buf = [];
  child.stdout.on('data', (d) => buf.push('[out] ' + d.toString()));
  child.stderr.on('data', (d) => buf.push('[err] ' + d.toString()));
  child.on('exit', (code, sig) => buf.push(`[exit] code=${code} sig=${sig}`));

  say('PID =', child.pid);

  // 分几档采样存活情况（本机 Electron 常在前几秒崩，所以要看住这个窗口）
  for (const t of [3, 6, 10, 14]) {
    await new Promise((r) => setTimeout(r, t === 3 ? 3000 : 3000 + (t - 3) * 0 + 3000));
    say(`  ${t}s: 进程存活 = ${alive(child.pid)}`);
  }

  const text = buf.join('');
  const bad = /Failed to parse header|Invalid package|ENOENT.*app\.asar|Unable to parse/i.test(text);
  say('');
  say('asar 解析失败特征 =', bad);
  if (text.trim()) {
    say('--- 应用输出（最多 40 行）---');
    text.split('\n').slice(0, 40).forEach((l) => say(l));
  } else {
    say('（应用没有输出到 stdout/stderr）');
  }

  const stillAlive = alive(child.pid);
  say('');
  say(stillAlive && !bad
    ? '=== 结论：应用能起来，包没问题 ==='
    : `=== 结论：需要复查（存活=${stillAlive}，解析失败=${bad}）===`);

  // 收尾：杀掉（不然它会占着 asar 影响下次换装）
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  fs.writeFileSync(LOG, out.join('\n') + '\n', 'utf8');
  process.exit(0);
})();
