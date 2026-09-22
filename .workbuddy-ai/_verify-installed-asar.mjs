// 直读「已安装的 app.asar」字节，验证本轮登录修复真的进去了。
// 不用 grep（对二进制不可靠），用官方 @electron/asar 解包后精确读文件内容。
import asar from '@electron/asar';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RES = String.raw`C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\resources`;
const ASAR = path.join(RES, 'app.asar');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-verify-'));
asar.extractAll(ASAR, tmp);

const preload = fs.readFileSync(path.join(tmp, 'dist-electron', 'preload.js'), 'utf8');
const assetsDir = path.join(tmp, 'dist', 'assets');
let renderer = '';
for (const f of fs.readdirSync(assetsDir)) {
  if (f.endsWith('.js')) renderer += fs.readFileSync(path.join(assetsDir, f), 'utf8');
}

const count = (s, re) => (s.match(re) || []).length;

console.log('--- preload.js (主进程) ---');
console.log('  isElectron 出现次数        =', count(preload, /isElectron/g));
console.log('  含 "isElectron: true"      =', preload.includes('isElectron: true'));
console.log('  含 onSmsMockCode（存量）   =', preload.includes('onSmsMockCode'));

console.log('--- dist/assets/*.js (渲染层) ---');
console.log('  isElectron 出现次数        =', count(renderer, /isElectron/g));
console.log('  含 API_BASE 判定           =', /workbench\)\s*!=\s*null\s*&&\s*\w+\.isElectron/.test(renderer));
console.log('  含「正在准备后端」          =', renderer.includes('正在准备后端'));

console.log('--- 主进程其它关键模块 ---');
for (const f of ['main.js', 'server-supervisor.js']) {
  const s = fs.readFileSync(path.join(tmp, 'dist-electron', f), 'utf8');
  console.log(`  ${f} 含 ensurePostgres     =`, s.includes('ensurePostgres'));
}

// 顺带确认「包是完整的」：条目数不能是空壳
const list = asar.listPackage(ASAR);
console.log('--- 包完整性 ---');
console.log('  条目总数                   =', list.length);
console.log('  dist 条目数                =', list.filter((x) => x.startsWith('\\dist\\')).length);
console.log('  dist-electron 条目数       =', list.filter((x) => x.startsWith('\\dist-electron\\')).length);

fs.rmSync(tmp, { recursive: true, force: true });
