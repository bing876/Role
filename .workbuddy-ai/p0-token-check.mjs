/**
 * 只回答一个问题：已安装包的 app.asar 里，有没有「阶段1 P0 止血」本轮的代码？
 * 口径 = 查 token（不查 sha256）。
 *   桌面端主进程 dist-electron/main.js → loop_gone / LOOP_GONE_QUESTION / workbench:task:loop-gone
 *   渲染层 dist/assets/*.js            → loop-gone / loopGone__q
 *   样式   dist/assets/*.css           → loopGone__q
 *   服务端 apps/server/** 不在包里（桌面端不打包服务端）⇒ WAITING_TTL_MS 不该出现，出现反而可疑
 */
import asar from '@electron/asar';
import path from 'node:path';

const ASAR = String.raw`C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\resources\app.asar`;
const list = asar.listPackage(ASAR);

function hits(buf, tokens) {
  const s = buf.toString('utf8');
  return Object.fromEntries(tokens.map((t) => [t, s.includes(t)]));
}

function report(paths, tokens, label) {
  console.log(`\n===== ${label} =====`);
  if (paths.length === 0) {
    console.log('  （包里没找到该类文件）');
    return;
  }
  for (const p of paths) {
    const native = p.replace(/\//g, '\\').replace(/^\\/, '');
    const buf = asar.extractFile(ASAR, native);
    const r = hits(buf, tokens);
    const found = Object.entries(r).filter(([, v]) => v === true || (typeof v === 'number' && v > 0));
    console.log(`  ${p}  (${buf.length}B)`);
    for (const [k, v] of Object.entries(r)) console.log(`      ${v ? '有' : '无'}  ${k}`);
    if (found.length === 0) console.log('      ⇒ 本轮 token 全无');
  }
}

const mainJs = list.filter((p) => p.includes('dist-electron') && p.endsWith('.js'));
report(mainJs,
  ['loop_gone', 'LOOP_GONE_QUESTION', 'workbench:task:loop-gone', '暂时接不上后端', 'WAITING_TTL_MS'],
  '主进程 dist-electron/*.js');

// 注意：listPackage 返回的是 Windows 反斜杠路径，别写 dist/assets
const renderJs = list.filter((p) => p.includes('dist\\assets') && p.endsWith('.js'));
report(renderJs.slice(0, 3), ['loop-gone', 'loopGone__q', '要重新开始吗'], '渲染层 dist/assets/*.js');

const renderCss = list.filter((p) => p.includes('dist\\assets') && p.endsWith('.css'));
report(renderCss, ['loopGone__q', 'loopGone__warn', 'loopGone__giveup'], '样式 dist/assets/*.css');

console.log(`\n（包内条目总数 ${list.length}）`);
