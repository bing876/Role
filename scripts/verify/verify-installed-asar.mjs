/**
 * 直接读「已安装」的 app.asar，确认里面真的是这一版代码。
 *
 * 为什么需要这个（而不是只看换装脚本的日志）：
 *   换装脚本打印的 ✓ 是它在**临时目录解包出来的内容**里查的。
 *   万一替换那一步出问题（本机踩过一次：trash shim 让旧包没删、新包没上位），
 *   日志照样一路 ✓，但磁盘上的 app.asar 还是旧的。
 *   所以最后必须**回头读安装目录里那个文件**，这才是用户双击时真正加载的东西。
 *
 * 跑法：node scripts/verify/verify-installed-asar.mjs
 */
import asar from '@electron/asar';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const A = String.raw`C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\resources\app.asar`;

const sha = crypto.createHash('sha256').update(fs.readFileSync(A)).digest('hex');
console.log(`app.asar size = ${fs.statSync(A).size} B`);
console.log(`sha256        = ${sha}`);

const list = asar.listPackage(A);
console.log(`条目数        = ${list.length}`);

/*
 * 路径形式的坑（实测出来的，不是猜的）：
 *   listPackage() 返回 `\dist\assets\x.js`（**前导反斜杠 + 反斜杠分隔**）。
 *   而 extractFile() 在 Windows 上要的是 **native 分隔符**：
 *     extractFile(A, 'dist\\assets\\index-BFNhn-Yi.js')  → OK
 *     extractFile(A, 'dist/assets/index-BFNhn-Yi.js')    → 找不到
 *   注意 `dist-electron/main.js`（正斜杠）**恰好也能用**，
 *   所以只试一个二层的路径会得出错误的结论 —— 必须用 native 形式统一处理。
 */
const toRel = (p) => p.replace(/^[\\/]/, '').replace(/[\\/]/g, path.sep);

const distJs = list.filter((x) => /dist[\\/]assets[\\/].+\.js$/.test(x));
if (distJs.length === 0) {
  console.error('★ 在 asar 里找不到任何 dist/assets/*.js —— 包可能没换成功');
  process.exit(1);
}
const renderer = distJs.map((f) => asar.extractFile(A, toRel(f)).toString('utf8')).join('\n');
const mainJs = asar.extractFile(A, 'dist-electron/main.js').toString('utf8');
const preloadJs = asar.extractFile(A, 'dist-electron/preload.js').toString('utf8');

const checks = [
  // ── 存量（不能因本轮改动而回归）──
  ['渲染层: 暂停/继续测试条 driveBar', renderer.includes('driveBar')],
  ['渲染层: data: 起始页', renderer.includes('新标签页')],
  ['渲染层: 豆包登记', renderer.includes('doubao')],
  ['渲染层: 千问登记', renderer.includes('tongyi')],
  ['渲染层: 「活页」已清干净（用户可见处）', !renderer.includes('活页')],

  // ── 本轮（空闲自动休眠）──
  ['渲染层: 休眠查询/唤醒属性名 sleepOf', renderer.includes('sleepOf')],
  ['渲染层: idleMsOf（闲置时长）', renderer.includes('idleMsOf')],
  ['渲染层: 深休眠占位卡样式类', renderer.includes('browserPanel__slept')],
  ['渲染层: 占位卡提示文案类', renderer.includes('browserPanel__sleptHint')],
  ['渲染层: 自动休眠总开关文案', renderer.includes('自动休眠')],
  ['渲染层: browserThrottle 桥接调用', renderer.includes('browserThrottle')],
  ['preload: 暴露了 browserThrottle', /browserThrottle/.test(preloadJs)],
  ['主进程: 节流 IPC handler', mainJs.includes('workbench:browser:throttle')],
  ['主进程: 真的调了 setBackgroundThrottling', mainJs.includes('setBackgroundThrottling')],
  ['主进程: ★ 拒绝节流正在被驾驶的页', /throttle\s*&&\s*isDriving/.test(mainJs)],

  // ── 第 26 步：联网搜索 / 浏览器操作分家 + 回答下方「来源」标注 ──
  // ★ 全部钉在"压缩后必然还在"的东西上：CSS 类名 / 字符串字面量 / 用户可见文案。
  //   本步的判定函数（`detectBrowseIntent` / `detectOpenUrl`）是模块内局部名，
  //   vite 压缩会改名 → **搜不到**，别拿它们当断言（踩过：搜函数名恒 0 命中，假红）。
  ['★ 来源块渲染（sources__item / sources__label）',
    renderer.includes('sources__item') && renderer.includes('sources__label')],
  ['★ 来源条目是真外链（target=_blank + rel=noreferrer）',
    renderer.includes('_blank') && renderer.includes('noreferrer')],
  ['★ 搜索期间「正在搜索」提示（用户看得见在联网查）', renderer.includes('正在搜索')],
  ['来源块标签是「来源」', renderer.includes('来源')],
  ['问题A —— 「查一下 / 搜一下」判定仍在（从页面动作里拆出来后没丢）',
    renderer.includes('查一下') && renderer.includes('搜一下')],
  ['问题A —— 「在这个页面」页面指代词优先级更高（不被"查资料"误伤）',
    renderer.includes('在这个页面')],
  ['问题A —— 页面专属动作仍在（滚动 / 翻页）',
    renderer.includes('滚动') && renderer.includes('翻页')],
  ['问题B —— 认不出站点时的兜底提示仍在（防误报闸没被带歪）',
    renderer.includes('认不出')],
];

console.log('\n已安装 asar 内容自检：');
let fails = 0;
for (const [name, ok] of checks) {
  if (!ok) fails += 1;
  console.log(`   ${ok ? '✓' : '✗'} ${name}`);
}
console.log(`\n失败：${fails}`);
process.exit(fails > 0 ? 1 : 0);
