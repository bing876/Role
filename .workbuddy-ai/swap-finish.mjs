/**
 * 把已经打好的 app.asar.new 换到 app.asar 上（swap-dist.mjs 第 6 步的补完）。
 *
 * 为什么要单独一个脚本：本机 rename 会被杀毒/索引的瞬时扫描撞成 EBUSY，
 * 一次失败不代表换不了，重试几次通常就过去了。所以这里带退避重试，
 * 实在不行再退回「原地覆盖写」（不依赖 rename）。
 *
 * 用法：node .workbuddy-ai/swap-finish.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const RES = String.raw`C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\resources`;
const ASAR = path.join(RES, 'app.asar');
const STAGED = ASAR + '.new';
const STAMP = 'rollback-ui16d';

if (!fs.existsSync(STAGED)) {
  console.error('没有找到待换入的包：', STAGED);
  process.exit(2);
}

const sizeNew = fs.statSync(STAGED).size;
const sizeOld = fs.statSync(ASAR).size;
console.log(`旧 ${sizeOld} B  ->  新 ${sizeNew} B`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 退避重试：EBUSY 多半是瞬时扫描，等一下再来 */
async function tryRenameSwap() {
  for (let i = 1; i <= 10; i += 1) {
    const retired = ASAR + '.old-' + STAMP;
    try {
      fs.renameSync(ASAR, retired);
      fs.renameSync(STAGED, ASAR);
      return { ok: true, retired, tries: i };
    } catch (e) {
      console.log(`  第 ${i} 次 rename 失败（${e.code}）—— ${i < 10 ? '等 1.5s 重试' : '放弃，改用覆盖写'}`);
      await sleep(1500);
    }
  }
  return { ok: false };
}

let r = await tryRenameSwap();

if (!r.ok) {
  // 兜底：不改名，直接把新内容盖写到原文件上
  for (let i = 1; i <= 5; i += 1) {
    try {
      fs.copyFileSync(STAGED, ASAR);
      r = { ok: true, retired: null, tries: 'cover-write#' + i };
      break;
    } catch (e) {
      console.log(`  第 ${i} 次覆盖写失败（${e.code}），等 2s 重试`);
      await sleep(2000);
    }
  }
}

if (!r.ok) {
  console.error('\n换包失败：文件一直被占用。旧包完好，应用不受影响。');
  process.exit(1);
}

console.log(`\n已替换（方式：${typeof r.tries === 'number' ? 'rename，第 ' + r.tries + ' 次成功' : r.tries}）`);
console.log(`  现在 app.asar = ${fs.statSync(ASAR).size} B`);

// 让位的旧包挪出安装目录归档
if (r.retired && fs.existsSync(r.retired)) {
  const ARCHIVE = String.raw`C:\Users\bing\workbuddy-ai\work123\_rollback-backup-20260918`;
  if (fs.existsSync(ARCHIVE)) {
    const dst = path.join(ARCHIVE, 'app.asar.before-rollback-swap');
    try {
      fs.renameSync(r.retired, dst);
      console.log('  旧包已归档 ->', dst);
    } catch {
      console.log('  旧包留在原地：', r.retired);
    }
  }
}

// 校验：新包里不该再有 UI-1.5/1.6 的三列标记
const buf = fs.readFileSync(ASAR);
console.log(`  校验 wtRail 出现次数 = ${(buf.toString('latin1').match(/wtRail/g) || []).length}（应为 0）`);
console.log('DONE');
