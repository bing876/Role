// fix-pg-launchers.cjs —— 把所有「启动 PG」的地方从 `start ""` 改成 `start "" /B`。
//
// 为什么：`start ""` 会**新开一个可见控制台窗口**（Win11 上由 Windows Terminal 承载），
// 于是每次 PG 被（重）启动就弹一个黑窗 —— 用户报的「一直弹终端」就是这个。
// `start "" /B` 不新建窗口（已由 pg-launch-window-test.cjs 实测：窗口增量 0 且 PG 可用）。
//
// ★ 不动 `pg-launch-window-test.cjs` —— 它里面的 `start ""` 是**被测对象①（现状）**，
//   改了它就没法复现"弹窗"那一档了。
//
// 用法：node scripts/verify/fix-pg-launchers.cjs [--check]
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SKIP = new Set(['fix-pg-launchers.cjs', 'pg-launch-window-test.cjs']);

const RULES = [
  // python: 'start "" "%s" -D "%s"' % (...)
  [/'start "" "%s" -D "%s"'/g, `'start "" /B "%s" -D "%s"'`],
  // python f-string
  [/f'start "" "/g, `f'start "" /B "`],
  // 多行字符串 / .cmd 里的裸 `start ""`（★ 必须容忍**行首缩进** ——
  // watchdog.cmd 里那处是缩进的，第一版用 `^start "" ` 没匹配到，复查才抓到）
  [/^(\s*)start "" /gm, `$1start "" /B `],
  // cmd: start "pgwatchdog" /MIN cmd /c ...  → 不弹窗
  [/start "pgwatchdog" \/MIN cmd \/c/g, `start "" /B cmd /c`],
];

/** 找出仓库里所有「会启动 PG 且用了 start \"\"」的文件 */
function targets() {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!/\.(py|cjs|mjs|cmd|ts)$/.test(e.name)) continue;
      if (SKIP.has(e.name)) continue;
      const txt = fs.readFileSync(p, 'utf8');
      if (/start "" /.test(txt) && /postgres|pgwatchdog/.test(txt)) out.push(p);
    }
  };
  walk(REPO, 0);
  // pg2 下的 .cmd 也要管
  const pg2 = path.join(require('os').homedir(), 'workbuddy-ai', 'pg2');
  if (fs.existsSync(pg2)) {
    for (const f of fs.readdirSync(pg2)) {
      if (!f.endsWith('.cmd')) continue;
      const p = path.join(pg2, f);
      if (/start ".*" |start "" /.test(fs.readFileSync(p, 'utf8'))) out.push(p);
    }
  }
  return out;
}

const check = process.argv.includes('--check');
let changed = 0, scanned = 0;

for (const file of targets()) {
  scanned++;
  const before = fs.readFileSync(file, 'utf8');
  let after = before;
  for (const [re, to] of RULES) after = after.replace(re, to);
  // 幂等：已经是 /B 的不再动
  after = after.replace(/start "" \/B \/B /g, 'start "" /B ');
  if (after === before) { console.log(`  · 无需改动  ${path.relative(REPO, file)}`); continue; }
  if (!check) fs.writeFileSync(file, after, 'utf8');
  const n = (before.match(/start "" (?!\/B)/g) || []).length;
  console.log(`  ${check ? '⚠ 待改' : '✓ 已改'} ${String(n).padStart(2)} 处  ${path.relative(REPO, file)}`);
  changed++;
}

console.log(`\n扫描 ${scanned} 个文件，${check ? '待改' : '改动'} ${changed} 个`);

// ★ 复查：改完再全仓扫一遍，确认没有漏网的 `start "" `（不带 /B）
const left = [];
for (const file of targets()) {
  const txt = fs.readFileSync(file, 'utf8');
  const bad = txt.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /start "" /.test(l) && !/start "" \/B /.test(l));
  if (bad.length) left.push([path.relative(REPO, file), bad]);
}
console.log('\n=== 复查：还剩几处会弹窗的 start "" ===');
if (!left.length) console.log('  ✅ 0 处');
for (const [f, bad] of left) for (const [ln, l] of bad) console.log(`  ✗ ${f}:${ln}  ${l.trim().slice(0, 100)}`);
process.exit(left.length ? 1 : 0);
