/**
 * 把 work123 新构建的 dist/ + dist-electron/ 换进**已安装版**的 app.asar。
 * 目的：让桌面「AI 工作台」图标打开的就是最新代码（带「🗂 内部频道」）。
 *
 * 流程：备份旧 asar → 解包 → 覆盖两个目录 → 校验 → 重打包 → 校验 → 就位 → 再校验。
 * 判据一律看**包里有没有本轮改动**（「内部频道」/ `job_pending`），不看 sha256。
 */
import asar from '@electron/asar';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STAMP = 'orch-20260923';
const RES = String.raw`C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\resources`;
const ASAR = path.join(RES, 'app.asar');
const SRC = String.raw`C:\Users\bing\workbuddy-ai\work123\apps\desktop`;
const NEW_DIST = path.join(SRC, 'dist');
const NEW_ELECTRON = path.join(SRC, 'dist-electron');
const BACKUP = path.join(RES, `app.asar.bak-${STAMP}`);
const NEW_ASAR = path.join(RES, `app.asar.new-${STAMP}`);

let fails = 0;
const ok = (m) => console.log(`  PASS ${m}`);
const bad = (m) => { fails += 1; console.log(`  ★FAIL ${m}`); };
const must = (cond, m) => (cond ? ok(m) : bad(m));

// ---------------------------------------------------------------- 0) 前置
console.log('=== 0) 前置检查 ===');
must(fs.existsSync(ASAR), `安装版 asar 存在 (${(fs.statSync(ASAR).size / 1e6).toFixed(2)} MB)`);
must(fs.existsSync(NEW_DIST), '新渲染层产物 dist/ 存在');
must(fs.existsSync(NEW_ELECTRON), '新主进程产物 dist-electron/ 存在');
const unpacked = path.join(RES, 'app.asar.unpacked');
console.log(`  (app.asar.unpacked ${fs.existsSync(unpacked) ? '存在' : '不存在'})`);

const srcRenderer = fs.readdirSync(path.join(NEW_DIST, 'assets')).filter((f) => f.endsWith('.js'));
const rendererHas = srcRenderer.some((f) =>
  fs.readFileSync(path.join(NEW_DIST, 'assets', f), 'utf8').includes('内部频道'));
must(rendererHas, `新渲染层含「内部频道」（${srcRenderer.join(', ')}）`);
must(
  fs.readFileSync(path.join(NEW_ELECTRON, 'agent.js'), 'utf8').includes('job_pending'),
  '新主进程 agent.js 含 job_pending（park 逻辑）',
);

// ---------------------------------------------------------------- 1) 备份
console.log('\n=== 1) 备份旧 asar ===');
if (fs.existsSync(BACKUP)) {
  console.log(`  备份已存在，跳过：${path.basename(BACKUP)}`);
} else {
  fs.copyFileSync(ASAR, BACKUP);
}
must(fs.existsSync(BACKUP) && fs.statSync(BACKUP).size === fs.statSync(ASAR).size,
  `备份完好 ${path.basename(BACKUP)} (${(fs.statSync(BACKUP).size / 1e6).toFixed(2)} MB)`);

// ---------------------------------------------------------------- 2) 解包
console.log('\n=== 2) 解包安装版 asar ===');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-swap-'));
asar.extractAll(ASAR, tmp);
must(fs.existsSync(path.join(tmp, 'package.json')), '解包后 package.json 在（Electron 靠它启动）');
must(fs.existsSync(path.join(tmp, 'dist-electron')), '解包后 dist-electron/ 在');
must(fs.existsSync(path.join(tmp, 'node_modules')), '解包后 node_modules/ 在（不能丢）');
const beforeFiles = fs.readdirSync(tmp).length;
console.log(`  解包到 ${tmp}（顶层 ${beforeFiles} 项）`);

// ---------------------------------------------------------------- 3) 覆盖
console.log('\n=== 3) 覆盖 dist/ + dist-electron/ ===');
fs.rmSync(path.join(tmp, 'dist'), { recursive: true, force: true });
fs.rmSync(path.join(tmp, 'dist-electron'), { recursive: true, force: true });
fs.cpSync(NEW_DIST, path.join(tmp, 'dist'), { recursive: true });
fs.cpSync(NEW_ELECTRON, path.join(tmp, 'dist-electron'), { recursive: true });
const tmpAssets = fs.readdirSync(path.join(tmp, 'dist', 'assets')).filter((f) => f.endsWith('.js'));
must(
  tmpAssets.some((f) => fs.readFileSync(path.join(tmp, 'dist', 'assets', f), 'utf8').includes('内部频道')),
  '待打包的树里含「内部频道」',
);
must(fs.existsSync(path.join(tmp, 'package.json')), '覆盖后 package.json 仍在');

// ---------------------------------------------------------------- 4) 重打包
console.log('\n=== 4) 重打包 ===');
if (fs.existsSync(NEW_ASAR)) fs.rmSync(NEW_ASAR, { force: true });
await asar.createPackage(tmp, NEW_ASAR);
must(fs.existsSync(NEW_ASAR), `新包已生成 (${(fs.statSync(NEW_ASAR).size / 1e6).toFixed(2)} MB)`);

// ---------------------------------------------------------------- 5) 校验新包
console.log('\n=== 5) 校验新包内容 ===');
const list = asar.listPackage(NEW_ASAR);
/**
 * ★ listPackage 在 Windows 上返回 `\dist\assets\x.js`（前导反斜杠 + 反斜杠分隔）；
 *   extractFile 要的是**去掉前导分隔符、保留反斜杠**的 `dist\assets\x.js`。
 *   （用正斜杠喂它 → "was not found in this archive"。踩过一次。）
 */
const rel = (f) => f.replace(/^[\\/]/, '');
const posix = (f) => rel(f).replace(/\\/g, '/');
const has = (p) => list.some((f) => posix(f).endsWith(p));
must(has('package.json'), '新包含 package.json');
must(list.some((f) => posix(f).startsWith('dist-electron/')), '新包含 dist-electron/');
must(list.some((f) => posix(f).startsWith('dist/assets/')), '新包含 dist/assets/');
must(list.some((f) => posix(f).startsWith('node_modules/')), '新包含 node_modules/');
const pkgMain = JSON.parse(asar.extractFile(NEW_ASAR, 'package.json').toString('utf8')).main;
must(!!pkgMain, `package.json.main = ${pkgMain}`);
const rendererFile = list.find((f) => /^dist\/assets\/index-.*\.js$/.test(posix(f)));
const rendererSrc = rendererFile ? asar.extractFile(NEW_ASAR, rel(rendererFile)).toString('utf8') : '';
must(rendererSrc.includes('内部频道'), '新包的渲染层含「内部频道」（本轮改动进包了）');
const agentFile = list.find((f) => posix(f) === 'dist-electron/agent.js');
const agentSrc = agentFile ? asar.extractFile(NEW_ASAR, rel(agentFile)).toString('utf8') : '';
must(agentSrc.includes('job_pending'), '新包的主进程含 park 逻辑');

if (fails > 0) {
  console.log(`\n!! 有 ${fails} 项没过，**不替换**安装版。新包留在 ${NEW_ASAR}`);
  process.exit(1);
}

// ---------------------------------------------------------------- 6) 就位
console.log('\n=== 6) 替换安装版 asar ===');
fs.copyFileSync(NEW_ASAR, ASAR);
must(fs.statSync(ASAR).size === fs.statSync(NEW_ASAR).size, '替换后大小一致');

console.log('\n=== 7) 就位后复核（直接读安装版）===');
const list2 = asar.listPackage(ASAR);
const rf2 = list2.find((f) => /^dist\/assets\/index-.*\.js$/.test(posix(f)));
const rs2 = rf2 ? asar.extractFile(ASAR, rel(rf2)).toString('utf8') : '';
must(rs2.includes('内部频道'), '★ 安装版现在含「内部频道」');
const af2 = list2.find((f) => posix(f) === 'dist-electron/agent.js');
const as2 = af2 ? asar.extractFile(ASAR, rel(af2)).toString('utf8') : '';
must(as2.includes('job_pending'), '★ 安装版主进程含 park 逻辑');
must(fs.existsSync(BACKUP), `旧包备份仍在：${path.basename(BACKUP)}`);

console.log(`\n=== 结论 ===\n  ${fails} FAIL`);
console.log(`  新包：${NEW_ASAR}`);
console.log(`  备份：${BACKUP}`);
