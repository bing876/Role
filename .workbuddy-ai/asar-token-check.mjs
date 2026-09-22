/**
 * 核对「装进安装包的那份」里有没有**本轮**的新代码（不只看 sha256 一致）。
 * 依据 MEMORY 里的教训：构建产物是会动的靶子，口径要落到"本轮 token 在不在"。
 */
import asar from '@electron/asar';
import path from 'node:path';
import fs from 'node:fs';

const RES = String.raw`C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\resources`;
const ASAR = path.join(RES, 'app.asar');
const DIST = String.raw`C:\Users\bing\workbuddy-ai\work123\apps\desktop\dist`;

const list = asar.listPackage(ASAR);
console.log(`listPackage 条目数 = ${list.length}`);

const assets = list.filter((p) => p.includes('dist\\assets') || p.includes('dist/assets'));
console.log('渲染层产物：' + assets.join(', '));

function checkBundle(buf, label) {
  const s = buf.toString('utf8');
  const tokens = {
    '★ allowpopups:"true"（本轮修复）': s.includes('allowpopups:"true"'),
    '旧写法 allowpopups:!0（应无）': s.includes('allowpopups:!0'),
    '"fullscreen" 字面量个数': (s.match(/"fullscreen"/g) || []).length,
    '"background" 字面量个数': (s.match(/"background"/g) || []).length,
    'browserLayer--bg（后台态类）': s.includes('browserLayer--bg'),
    'browserFloating（小图标类）': s.includes('browserFloating'),
    '退出全屏（按钮文案）': s.includes('退出全屏'),
    '浏览器后台运行中（小图标文案）': s.includes('浏览器后台运行中'),
  };
  console.log(`\n== ${label} ==`);
  for (const [k, v] of Object.entries(tokens)) console.log(`  ${k}: ${v}`);
  return tokens;
}

// 从**安装包**里取渲染层 bundle（不能读解包临时目录 —— 踩过"空壳包也自检通过"）
for (const p of assets) {
  if (!p.endsWith('.js') && !p.endsWith('.css')) continue;
  const native = p.replace(/\//g, '\\').replace(/^\\/, '');
  const buf = asar.extractFile(ASAR, native);
  const local = path.join(DIST, 'assets', path.basename(p));
  const same = fs.existsSync(local) && Buffer.compare(buf, fs.readFileSync(local)) === 0;
  console.log(`\n-- ${p}（${buf.length} B，与本地构建逐字节一致=${same}）`);
  if (p.endsWith('.js')) checkBundle(buf, p);
}

// 主进程产物也看一眼（本轮没改主进程，确认没有意外改动）
const mp = asar.extractFile(ASAR, 'dist-electron\\main.js');
console.log(`\ndist-electron/main.js ${mp.length} B（本轮未改主进程）`);
