/**
 * 换装后的 sha256 校验：**不只看 app.asar 整体的哈希**，而是把它解开，
 * 逐个文件跟本地构建产物比对 —— 整体哈希相同只能证明「这个包是我刚放进去的那一个」，
 * 证明不了「里面的暂停/继续代码真的是新的」。
 *
 * 用法：node .workbuddy-ai/verify-asar.mjs
 */
import asar from '@electron/asar';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const RES = String.raw`C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\resources`;
const ASAR = path.join(RES, 'app.asar');
const NEW_DIST = String.raw`C:\Users\bing\workbuddy-ai\work123\apps\desktop\dist`;
const NEW_ELECTRON = String.raw`C:\Users\bing\workbuddy-ai\work123\apps\desktop\dist-electron`;

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

console.log('== 整体 ==');
console.log(`  app.asar  ${fs.statSync(ASAR).size} B`);
console.log(`  sha256 = ${sha(ASAR)}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-verify-'));
asar.extractAll(ASAR, tmp);
console.log(`\n解包到 ${tmp}`);

// 要逐字节比对的文件：主进程的暂停/继续 + 渲染层入口
const pairs = [];
for (const f of ['main.js', 'agent.js', 'driver.js', 'preload.js', 'server-supervisor.js']) {
  pairs.push([`dist-electron/${f}`, path.join(tmp, 'dist-electron', f), path.join(NEW_ELECTRON, f)]);
}
pairs.push(['dist/index.html', path.join(tmp, 'dist', 'index.html'), path.join(NEW_DIST, 'index.html')]);
// 渲染层入口 js / css 是带 hash 的文件名（index-XXXX.js），直接整目录比对：
// 既不用猜 index.html 里的引用写法，也能顺带发现「旧产物残留在包里没清掉」。
for (const name of fs.readdirSync(path.join(NEW_DIST, 'assets'))) {
  pairs.push([`dist/assets/${name}`, path.join(tmp, 'dist', 'assets', name), path.join(NEW_DIST, 'assets', name)]);
}
// 反向：包里有没有**多出来**的旧渲染层产物（换包时没清干净的痕迹）
for (const name of fs.readdirSync(path.join(tmp, 'dist', 'assets'))) {
  if (fs.existsSync(path.join(NEW_DIST, 'assets', name))) continue;
  console.log(`  ! 包里有本地没有的旧产物：dist/assets/${name}（上一版残留）`);
}

console.log('\n== 逐文件 sha256（已安装 vs 本地构建）==');
let ok = 0;
let bad = 0;
for (const [label, a, b] of pairs) {
  if (!fs.existsSync(a) || !fs.existsSync(b)) {
    console.log(`  ✗ ${label}: 缺文件（已安装 ${fs.existsSync(a)} / 本地 ${fs.existsSync(b)}）`);
    bad += 1;
    continue;
  }
  const ha = sha(a);
  const hb = sha(b);
  const same = ha === hb;
  console.log(`  ${same ? '✓' : '✗'} ${label.padEnd(34)} ${ha.slice(0, 16)} ${same ? '==' : '!='} ${hb.slice(0, 16)}`);
  same ? (ok += 1) : (bad += 1);
}

// 功能指纹：这次要验的「新行为」必须真的在包里
console.log('\n== 功能指纹 ==');
const mainJs = fs.readFileSync(path.join(tmp, 'dist-electron', 'main.js'), 'utf8');
const agentJs = fs.readFileSync(path.join(tmp, 'dist-electron', 'agent.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(tmp, 'dist-electron', 'preload.js'), 'utf8');
// ★ 本次换装的主角：桌面端自动拉起服务端。文件缺失就直接炸，别让指纹检查静默跳过。
const supervisorPath = path.join(tmp, 'dist-electron', 'server-supervisor.js');
if (!fs.existsSync(supervisorPath)) {
  console.log('\n❌ 包里没有 dist-electron/server-supervisor.js —— 这次换装的核心文件没进去。');
  process.exit(1);
}
const supervisorJs = fs.readFileSync(supervisorPath, 'utf8');
const assetsJs = fs
  .readdirSync(path.join(tmp, 'dist', 'assets'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => fs.readFileSync(path.join(tmp, 'dist', 'assets', f), 'utf8'))
  .join('\n');
const cssAll = fs
  .readdirSync(path.join(tmp, 'dist', 'assets'))
  .filter((f) => f.endsWith('.css'))
  .map((f) => fs.readFileSync(path.join(tmp, 'dist', 'assets', f), 'utf8'))
  .join('\n');
const fp = [
  ['main.js  暂停走挂起 /agent/loop/pause', mainJs.includes('/agent/loop/pause')],
  ['main.js  继续前重新感知 resumeAgentLane', mainJs.includes('resumeAgentLane')],
  ['main.js  暂停后接回原循环 lastLoopByWc', mainJs.includes('lastLoopByWc')],
  // 第 8 个 bug：暂停基线必须是「暂停那一刻真读到的页面」，不能拿循环里的旧快照，
  // 否则 AI 自己造成的变化会被算到用户头上（用户啥也没干却被说"你自己操作过"）。
  ['main.js  暂停前真读一次当前页当基线', mainJs.includes('暂停前读页失败')],
  ['agent.js 暂停不再走终态 stopLoop', agentJs.includes("kind === 'paused'")],
  ['preload  暂停/继续 IPC 桥接', preloadJs.includes('workbench:task:pause') && preloadJs.includes('workbench:task:resume')],
  ['渲染层   临时测试条 driveBar（按钮可点）', assetsJs.includes('driveBar')],
  ['渲染层   样式 .driveBar 已打包', cssAll.includes('driveBar')],
  // ★ 自动拉起服务端（本次换装的目的）——三条硬约束各验一条：
  //   ① 取 node 必须走 ELECTRON_RUN_AS_NODE（否则 spawn 出来的是 electron.exe，本机必崩）
  //   ② 只停自己拉起来的那份（不许碰用户手动起的）
  //   ③ main.js 真的调用了 ensureServer / stopOwnedServer
  ['supervisor ELECTRON_RUN_AS_NODE 取 node', supervisorJs.includes('ELECTRON_RUN_AS_NODE')],
  ['supervisor 只停自己拉起的服务端', supervisorJs.includes('stopOwnedServer') && supervisorJs.includes('ownedByUs')],
  ['supervisor 起构建产物 dist/index.js', supervisorJs.includes("dist") && supervisorJs.includes('index.js')],
  ['main.js  调用 ensureServer 自动拉起', mainJs.includes('ensureServer')],
  ['main.js  退出时 stopOwnedServer 收尾', mainJs.includes('stopOwnedServer')],
];
let fpBad = 0;
for (const [n, v] of fp) {
  console.log(`  ${v ? '✓' : '✗'} ${n}`);
  if (!v) fpBad += 1;
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n逐字节一致 ${ok} 个，不一致 ${bad} 个；功能指纹缺失 ${fpBad} 项。`);
if (bad === 0 && fpBad === 0) {
  console.log('✅ 校验通过：已安装的包就是本次构建产物，暂停/继续 + 服务端自动拉起代码在位。');
  process.exit(0);
}
console.log('❌ 校验未通过。');
process.exit(1);
