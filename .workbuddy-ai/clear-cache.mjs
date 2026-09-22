/**
 * 清理已安装 Electron 应用的 HTTP 缓存（Cache / Code Cache / GPUCache）。
 *
 * 为什么换完包还要清：Electron 会缓存渲染层资源，只换 app.asar 的话用户可能看到的
 * 还是旧界面 —— 「包明明换了、界面没变」最难排查。
 *
 * 做法与 swap-dist.mjs 一致：**走 rename 不删除**（本机 safe-delete shim 会把 rm 转成
 * 移到回收站，对 AppData 下的目录也可能失败）。旧目录改名成 `.old-<stamp>-<ts>`，
 * 然后原地重建一个空目录。登录态在 Local Storage / IndexedDB 里，**不碰**。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = String.raw`C:\Users\bing\AppData\Roaming`;
const STAMP = 'pr-ui';

const dirSize = (p) => {
  let s = 0;
  const st = fs.statSync(p);
  if (st.isFile()) return st.size;
  for (const f of fs.readdirSync(p, { withFileTypes: true })) {
    s += dirSize(path.join(p, f.name));
  }
  return s;
};

const targets = ['Cache', 'Code Cache', 'GPUCache'];
/**
 * userData 的实际层级是 `Roaming\@ai-workbench\desktop`（不是 `@ai-workbenchdesktop`），
 * 所以这里往下多找一层：把所有散着缓存目录的地方都收进来，免得漏清。
 */
const roots = [];
for (const d of fs.readdirSync(ROOT)) {
  if (!/@ai-workbench/i.test(d)) continue;
  const p = path.join(ROOT, d);
  if (targets.some((t) => fs.existsSync(path.join(p, t)))) roots.push(p);
  for (const s of fs.readdirSync(p, { withFileTypes: true })) {
    if (s.isDirectory()) roots.push(path.join(p, s.name));
  }
}
if (roots.length === 0) {
  console.log('没找到 @ai-workbench* 的 userData 根目录，跳过。');
  process.exit(0);
}

let cleared = 0;
for (const base of roots) {
  if (!targets.some((t) => fs.existsSync(path.join(base, t)))) continue;
  console.log('userData:', base);
  for (const t of targets) {
    const p = path.join(base, t);
    if (!fs.existsSync(p)) {
      console.log(`  - ${t}: 不存在，跳过`);
      continue;
    }
    const kb = (dirSize(p) / 1024).toFixed(0);
    const retired = `${p}.old-${STAMP}-${Date.now()}`;
    fs.renameSync(p, retired);
    fs.mkdirSync(p, { recursive: true });
    const back = fs.existsSync(p) && fs.readdirSync(p).length === 0;
    console.log(`  ✓ ${t}: ${kb} KB 已让位 -> ${path.basename(retired)}（重建空目录 ${back ? 'ok' : '失败'}）`);
    cleared += 1;
  }
}
console.log(`\n共清理 ${cleared} 个缓存目录；Local Storage（登录态）未动。`);
