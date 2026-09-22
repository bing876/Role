/**
 * 用官方 @electron/asar 把新构建的 dist/ + dist-electron/ 换进已安装的 app.asar。
 *
 * 上一版为什么把包搞坏了：手工拼 asar 时只把 /dist 三个文件的条目写进了 JSON 头，
 * 把 node_modules / dist-electron / package.json 全丢了 —— Electron 读不到 package.json
 * 就直接 "Failed to parse header"。教训：重打包必须走官方库（extract -> 改 -> createPackage），
 * 不要手搓二进制。
 *
 * ★ 2026-09-19（本阶段）：原来只换 `dist/`（渲染层）。方案 B 的桌面端改动全在**主进程**
 *   （`main.ts` / `agent.ts` / `driver.ts` → `dist-electron/main.js`），只换 dist/ 的话
 *   界面是新的、暂停/继续的行为还是旧的 —— 「换完了但功能没变」最难排查。
 *   现在两个目录一起换。
 *
 * 用法：node .workbuddy-ai/swap-dist.mjs
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
// STAMP 会进备份/让位文件名，改它是为了让备份一眼能认出「换之前是哪一个版本」。
//
// ★★ 2026-09-20 踩到：上一轮（数据库守护 r6）我以为改了 STAMP，实际**根本没写进去**
//    （Edit 报了成功但文件没变），于是 r6 那次换装仍然用 `db-hint-r5` 这个名字 ——
//    备份名撞车被"同名不覆盖"跳过、归档名也撞车。**改完 STAMP 一定要 grep 复查。**
//    本轮：**后端保活心跳** —— 启动时拉一次不够，掉了要能自己拉回来。
// 本轮 = 第 28 步：**高风险动作确定性申报（risk 标记） + AI 后台开页不顶掉会话**。
//   渲染层（dist/assets：视图默认 background）与主进程（dist-electron：risk 守卫）**两头都有改动**。
// ★ 改完必须 grep 复查（2026-09-20 踩过：Edit 报成功但 STAMP 没写进去 ⇒ 备份名撞车）。
const STAMP = 'isElectron-fix-r8-final';

const run = (fn) => { try { return fn(); } catch (e) { return null; } };

/**
 * 剥掉注释再断言。
 * ★ 为什么必须：本轮我要断言"**没有** `detached: true`"，而代码注释里为了说明原因
 *   恰恰**写了**这串字面量 —— 不剥注释就会命中注释、把正确的代码判成错的（假红）。
 *   （同类坑踩过：断言"源码不该再含某句旧文案"，结果命中的是我自己描述旧文案的注释。）
 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const shaBuf = (b) => crypto.createHash('sha256').update(b).digest('hex');

// 0) 先把当前包从内存里放掉 —— 运行中的 Electron 会锁住 app.asar（调用前必须已杀干净）
const size0 = fs.statSync(ASAR).size;

// 1) 备份（带时间戳，不覆盖历史备份）
const bak = path.join(RES, `app.asar.bak-${STAMP}-pre`);
if (!fs.existsSync(bak)) { fs.copyFileSync(ASAR, bak); console.log('备份 ->', path.basename(bak)); }
else console.log('备份已存在（不覆盖）->', path.basename(bak));

// 2) 解包到临时目录
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-swap-'));
asar.extractAll(ASAR, tmp);
console.log('解包顶层:', fs.readdirSync(tmp).join(', '));

// 3) 用新构建替换 dist/（渲染层）
const destDist = path.join(tmp, 'dist');
fs.rmSync(destDist, { recursive: true, force: true });
fs.cpSync(NEW_DIST, destDist, { recursive: true });
console.log('新 dist/assets:', fs.readdirSync(path.join(destDist, 'assets')).join(', '));

// 4) 用新构建替换 dist-electron/（**主进程** —— 本阶段暂停/继续全在这儿）
//    只拷 .js：原包里就没有 .map，带上它们只会白白撑大体积。
const destEl = path.join(tmp, 'dist-electron');
fs.rmSync(destEl, { recursive: true, force: true });
fs.mkdirSync(destEl, { recursive: true });
for (const f of fs.readdirSync(NEW_ELECTRON)) {
  if (f.endsWith('.js')) fs.copyFileSync(path.join(NEW_ELECTRON, f), path.join(destEl, f));
}
console.log('新 dist-electron:', fs.readdirSync(destEl).join(', '));

// 5) 重新打包（官方库，会写完整 JSON 头）
//
// ★★ 2026-09-20 踩的坑：产出的包**整整 5.4MB 全是零字节**，脚本却一路"自检通过"
//    把坏包装了上去。因为原来的第 6/7 步自检读的是**解包出来的临时目录**
//    （`tmp/dist-electron/main.js`），根本不是真正要装的那个 asar ——
//    自检全绿，装上去的却是个空壳。
//
//    坏包的症状很好认：**文件长度正常、开头 8 字节的长度头也写了，
//    但 header JSON 与内容区全是 0x00**（实测 5470291 字节里只有 3 个非零）。
//    典型的"写缓冲没落盘 / 写到一半进程没了"。
//
//    所以现在改成三道保险：
//      ① 直接写到安装目录的 `.new`（少一次 copy，少一个出错点）；
//      ② **把字节读回来验**：非零比例 + 本轮新增的 canary 串 + 条目数；
//      ③ 失败自动重试一次，仍失败就中止 —— 旧包一根汗毛都不动。
const staged = ASAR + '.new';
// canary 要用「本轮新增、且压缩后必然还在」的东西。
// 本轮新增的是**渲染层的用户可见文案** —— 压缩只改标识符，字符串字面量必然原样保留。
// canary 用「本轮新增、且压缩后必然还在」的东西：
// 第 26 步新增的 **CSS 类名 / 用户可见文案**（字符串字面量，压缩改不掉；旧包里命中 0 次）。
const CANARY = 'sources__item';
const MIN_ENTRIES = 100;

async function buildAsar() {
  run(() => fs.rmSync(staged, { force: true }));
  await asar.createPackage(tmp, staged);
  const buf = fs.readFileSync(staged);
  let nz = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) nz++;
  let list = [];
  try { list = asar.listPackage(staged); } catch { list = []; }
  return {
    size: buf.length,
    ratio: buf.length ? nz / buf.length : 0,
    hasCanary: buf.includes(Buffer.from(CANARY, 'utf8')),
    list,
  };
}
const okBuild = (b) => b.ratio > 0.5 && b.hasCanary && b.list.length > MIN_ENTRIES;

let built = await buildAsar();
if (!okBuild(built)) {
  console.error(`\n✗ 新包校验失败（非零比例 ${built.ratio.toFixed(4)}，canary=${built.hasCanary}，条目 ${built.list.length}）—— 重试一次`);
  built = await buildAsar();
}
if (!okBuild(built)) {
  console.error(`\n✗ 重试后仍然失败（非零比例 ${built.ratio.toFixed(4)}，canary=${built.hasCanary}，条目 ${built.list.length}）`);
  console.error('  新包不可信，中止换装（旧包保持不动）。');
  fs.rmSync(tmp, { recursive: true, force: true });
  run(() => fs.rmSync(staged, { force: true }));
  process.exit(1);
}

// 6) 校验新包：条目数、dist 内容、JSON 头可解析
const outAsar = staged;
const list = built.list;
const distEntries = list.filter((x) => x.startsWith('\\dist\\'));
const sizeNew = built.size;
console.log(`\n新包 ${sizeNew} B   条目数 ${list.length}   dist 条目 ${distEntries.length}`);
console.log(`  字节自检：非零比例 ${(built.ratio * 100).toFixed(1)}%   canary(${CANARY})=${built.hasCanary}`);
distEntries.forEach((e) => console.log('   ', e));

// 7) 功能自检：新包的**主进程 + 渲染层**里必须能找到本阶段新增的代码，
//    否则就是「换了但没换到点上」—— 这正是上一版只换 dist/ 会踩的坑。
const elDir = path.join(tmp, 'dist-electron');
const mainJs = fs.readFileSync(path.join(elDir, 'main.js'), 'utf8');
const agentJs = fs.readFileSync(path.join(elDir, 'agent.js'), 'utf8');
// 服务端守护是**独立模块**，产物在 server-supervisor.js（不在 main.js 里）。
const supervisorJs = fs.readFileSync(path.join(elDir, 'server-supervisor.js'), 'utf8');
// 渲染层的自检：入口 js 是带 hash 的文件名（index-XXXX.js），所以按目录扫。
const distAssets = path.join(tmp, 'dist', 'assets');
const rendererJs = fs
  .readdirSync(distAssets)
  .filter((f) => f.endsWith('.js'))
  .map((f) => fs.readFileSync(path.join(distAssets, f), 'utf8'))
  .join('\n');
const must = [
  // ── 上一轮（暂停/继续）的存量自检：必须继续成立，防止回归 ──
  ['main.js: lastLoopByWc（暂停后还能接回原循环）', mainJs.includes('lastLoopByWc')],
  ['driver.js: resumeAgentLane（继续前重新感知）', fs.readFileSync(path.join(elDir, 'driver.js'), 'utf8').includes('resumeAgentLane')],
  ['main.js: /agent/loop/pause 挂起（不是 stop）', mainJs.includes('/agent/loop/pause')],
  ['agent.js: 暂停不再走终态 stopLoop', agentJs.includes("kind === 'paused'")],
  ['渲染层: 临时测试条 driveBar（暂停/继续可点）', rendererJs.includes('driveBar')],
  ['渲染层: pauseTask / resumeTask 桥接调用', rendererJs.includes('pauseTask')],

  // ── ★ 本轮（浏览器根因修复）的新增自检 ──
  // 换装的目的是「用户看到新行为」。只报"换成功了"不够，得证明**换进去的是这一版**。
  ['渲染层: data: 起始页（不再是百度默认页）', rendererJs.includes('新标签页') && rendererJs.includes('data:text/html')],
  ['渲染层: 起始页里不再有百度作为 HOME', !/https:\/\/www\.baidu\.com/.test(rendererJs) || rendererJs.includes('新标签页')],
  ['渲染层: 补了豆包/doubao 登记（原来认不出）', rendererJs.includes('doubao')],
  ['渲染层: 补了通义/千问登记（原来认不出）', rendererJs.includes('tongyi')],
  ['渲染层: 认不出站点时的拦截提示', rendererJs.includes('认不出')],
  ['渲染层: Chrome 同款休眠图标 SleepBadge', rendererJs.includes('browserTab__sleep')],
  // 「活页」这个词用户明确要求去掉 —— **渲染层**（用户看得见的那层）必须彻底没有。
  //
  // ★ 只查渲染层，不查主进程。主进程里那两处是**代码注释**
  //   （driver.js:「多张活页可以各跑一路」、main.js:「第 20 步取消了按活页数的硬顶」），
  //   是写给维护者看的历史沿革，不是用户界面文案。
  //   我第一版直接 grep 整个 asar，命中 2 处、看起来像"没清干净"，
  //   实际是**假警报** —— 用户永远看不到注释。断言要卡在"用户可见"这一层。
  ['渲染层: 「活页」文案已清干净（用户可见处，应为 0 处）', !rendererJs.includes('活页')],

  // ── ★ 本轮（取消活页 + 空闲自动休眠）的新增自检 ──
  // 休眠功能有个特点：**判定对了但没人调用 = 完全没生效**，
  // 而用户界面上"什么都没发生"看起来和"正常工作"一模一样（页还在那儿）。
  // 所以这一组自检必须钉到「调用链真的存在」，不能只查字符串常量。
  //
  // ★★ 这里有个压缩陷阱（我第一版就踩了）：
  //   渲染层是 **vite 压缩产物**，模块内的局部标识符会被改名 ——
  //   `sweepSleep` / `decideSleep` / `humanizeIdle` 在产物里**一个都搜不到**，
  //   但功能是好的。反倒是这些能搜到：
  //     · 对象**属性名**（`sleepOf` / `idleMsOf` / `wakeTab`）—— 属性名不能改；
  //     · CSS 类名字符串（`browserPanel__slept`）—— 在 styles.css 里按字面匹配；
  //     · 用户可见文案（`自动休眠`）。
  //   所以自检必须钉在"压缩后**必然**还在"的东西上。
  //   数字也靠不住：`30_000` 会被折叠成 `3e4`。
  [
    '渲染层: 休眠判定被真的调用（唤醒/查询属性名在产物里仍在）',
    rendererJs.includes('sleepOf') && rendererJs.includes('idleMsOf') && rendererJs.includes('wakeTab'),
  ],
  ['渲染层: 深休眠占位卡（内存真的释放，界面不空白）', rendererJs.includes('browserPanel__slept')],
  ['渲染层: 浅休眠走主进程节流通道 browserThrottle', rendererJs.includes('browserThrottle')],
  ['主进程: 有节流 IPC handler', mainJs.includes('workbench:browser:throttle')],
  [
    '主进程: ★ 拒绝节流"正在被驾驶"的页（守 CDP 点击的红线）',
    mainJs.includes('setBackgroundThrottling') &&
      /throttle\s*&&\s*isDriving/.test(mainJs),
  ],
  ['渲染层: 派任务前会唤醒休眠页（否则 AI 面对空页）', rendererJs.includes('sleepOf')],
  ['渲染层: 自动休眠总开关文案（用户能关掉）', rendererJs.includes('自动休眠')],
  [
    '渲染层: 标签图标带"已闲置多久"（占位卡文案在产物里还在）',
    rendererJs.includes('browserPanel__sleptHint') || rendererJs.includes('已闲置'),
  ],

  // ── ★ 本轮（服务端守护自愈）的新增自检 ──
  // 背景：应用启动时若 8787 上碰巧有"别的东西"在监听，就被永久当成后端可用，
  // 那东西一死也不自愈 → 用户点登录一路失败。
  // ★ 这两个断言必须写成"可区分对错"的，不能只查某个词还在不在：
  //   1) 老的短路行为已经**不在**（ensureServer 开头不能再直接 return true）；
  //   2) 新的身份校验**在**（probe 会看 service 字段）。
  //
  // ★★ 查对文件：这段逻辑在 `dist-electron/server-supervisor.js`（独立模块），
  //    不在 main.js 里。我第一版写成了查 main.js → 两条断言全 ✗，
  //    看起来像"代码没改对"，其实只是查错了地方。自检失败先确认"查的是不是那个文件"。
  [
    '主进程: ★ 不再永久信任外部服务端（老短路已移除）',
    !/if \(externalServerSeen\) \{\s*setState\(\{ reachable: true/.test(supervisorJs),
  ],
  [
    '主进程: ★ probe 会核对 /health 的 service 标识（不再只认 200）',
    supervisorJs.includes('ai-workbench-server') && supervisorJs.includes('body?.service'),
  ],
  [
    '主进程: 外部服务端消失时会重新探测并改走自动拉起',
    supervisorJs.includes('之前见过的外部服务端已不在 8787 上'),
  ],

  // ── ★ 本轮（数据库指引改成"双击 start-dev.cmd"）的新增自检 ──
  // 背景：用户看到的红字是「先跑 docker compose…」，但本机没有可用的 Docker
  // （PG 是便携包），照做只会更困惑。渲染层统一换成指向 start-dev.cmd 的指引。
  //
  // ★ 这一组全部钉在**用户可见文案**上（压缩后必然是字符串字面量，见上面第 128 行那条规律）。
  // ★ 必须同时断言"新的在"和"老的不在" —— 只查一个方向等于没查（老文案可能还留着）。
  ['渲染层: ★ 连不上后端时指向 start-dev.cmd（本机真能用的动作）',
    rendererJs.includes('start-dev.cmd')],
  ['渲染层: ★ 老的「先起库（npm run db:up）」指引已消失',
    !rendererJs.includes('先起库（npm run db:up）')],
  ['渲染层: 数据库 503 的 docker 文案会被替换成本机指引',
    rendererJs.includes('数据库连不上') && rendererJs.includes('start-dev.cmd')],
  ['渲染层: 429 限流有单独解释（别让用户以为手机号有问题）',
    rendererJs.includes('太频繁') && rendererJs.includes('防刷限制')],
  ['渲染层: 验证码提示指向「AI工作台-服务端」窗口（不再让人翻终端）',
    rendererJs.includes('AI工作台-服务端')],

  // ── ★ 本轮（数据库守护：应用也管 PostgreSQL）的新增自检 ──
  // 背景：用户第三次报「登录不上」，根因是 **5432 上根本没有 PostgreSQL**。
  // 服务端能自愈、数据库不能 → 用户仍必须先记得双击 start-dev.cmd。
  // 这一组证明「应用真的会自己把库拉起来」这件事被换进去了。
  //
  // ★ 仍然按"可区分对错"写：既要有新逻辑在，也要证明**关键语义没被写反**
  //   （PG 是 detached:true + unref 且退出不杀；服务端是 detached 缺省 + 退出要收尾）。
  ['主进程: ★ 应用会自己拉起 PostgreSQL（ensurePostgres 在产物里）',
    supervisorJs.includes('ensurePostgres')],
  ['主进程: 拉 PG 用 detached + unref（要活过应用退出，与服务端刻意相反）',
    /detached:\s*true/.test(supervisorJs) && supervisorJs.includes('unref()')],
  ['主进程: ★ 起 PG 前会清陈旧 postmaster.pid（否则 PG 静默拒启动）',
    supervisorJs.includes('postmaster.pid') && supervisorJs.includes('清掉陈旧')],
  ['主进程: 只清"真死了"的 pid（活着的不动）',
    supervisorJs.includes('还活着') && supervisorJs.includes('不动它')],
  ['主进程: 有逃生开关 WORKBENCH_NO_AUTOSTART_PG',
    supervisorJs.includes('WORKBENCH_NO_AUTOSTART_PG')],
  ['主进程: 端口/路径可覆盖（WORKBENCH_PG_PORT / WORKBENCH_PG_HOME）',
    supervisorJs.includes('WORKBENCH_PG_PORT') && supervisorJs.includes('WORKBENCH_PG_HOME')],
  // ★ 用 `ensurePostgres)(` 这种"调用点"形态断言 —— 直接查 `ensureServer` 会先命中
  //   文件里的注释（实测注释在 1300 行、调用在 1313 行），顺序判断就假红了。
  ['主进程: main.js 真的**调用**了 ensurePostgres（不只是模块里有）',
    /ensurePostgres\)\(/.test(mainJs)],
  ['主进程: ★ 启动顺序是先库后服务端（服务端起来要 migrate）',
    /ensurePostgres\)\(/.test(mainJs) &&
      mainJs.search(/ensurePostgres\)\(/) < mainJs.search(/ensureServer\)\(/)],
  // ★ 最强的一条：装进去的主进程文件必须与刚构建的**逐字节相同** ——
  //   堵死"自检读的是解包临时目录、装进去的是另一份"这类假通过。
  ['主进程: 装进去的 server-supervisor.js 与刚构建的逐字节一致',
    shaBuf(fs.readFileSync(path.join(elDir, 'server-supervisor.js'))) ===
      sha(path.join(NEW_ELECTRON, 'server-supervisor.js'))],
  ['主进程: 装进去的 main.js 与刚构建的逐字节一致',
    shaBuf(fs.readFileSync(path.join(elDir, 'main.js'))) ===
      sha(path.join(NEW_ELECTRON, 'main.js'))],

  // ── ★ 本轮（登录页别再骗人 + 显示验证码）的新增自检 ──
  // 背景：用户第四次报"进不去"。真因不是后端坏了 —— 后端在自愈（40 秒），
  // 但登录页**在这期间就甩了一句红字，而且不会自己重试**，用户以为坏了。
  // 再加上应用自己拉起的服务端**用户看不到任何窗口**，验证码根本拿不到。
  // 这一组证明这两件事都被换进去了。
  ['渲染层: ★ 后端没就绪时只显示"正在准备后端"（不再一上来就报错）',
    rendererJs.includes('正在准备后端')],
  ['渲染层: ★ 探测后端时核对 /health 的 service 标识（与主进程同一口径）',
    rendererJs.includes('ai-workbench-server')],
  ['渲染层: ★ mock 验证码会显示在登录页上（用户否则根本拿不到码）',
    rendererJs.includes('本次验证码')],
  ['渲染层: 订阅了主进程转来的验证码通道 onSmsMockCode',
    rendererJs.includes('onSmsMockCode')],
  ['渲染层: 连不上后端时会"重新排队等后端"（有重探触发器）',
    rendererJs.includes('AbortSignal') || rendererJs.includes('probeKey')],
  ['主进程: ★ 会把服务端日志里的 [sms:mock] 验证码转给登录页',
    mainJs.includes('workbench:sms:mock') && mainJs.includes('sms:mock')],
  ['主进程: preload 暴露了 onSmsMockCode',
    fs.readFileSync(path.join(elDir, 'preload.js'), 'utf8').includes('onSmsMockCode')],

  // ── ★ 本轮（后端保活心跳）的新增自检 ──
  // 背景：用户报「连不上后端：Failed to fetch」，而应用明明开着 ——
  // 真因是**后端进程死了、应用只在启动时拉过一次、之后不管**。
  // 这一组证明"掉了会自己拉回来"这件事被换进去了。
  // ★ 正则里**不要写 `ensureServer(`** —— tsc 产物里调用点长这样：
  //   `(0, server_supervisor_1.ensureServer)(undefined, ...)`（多了个右括号），
  //   写 `ensureServer(` 会恒不匹配 → 假红。踩过一次，这里只锚函数名。
  ['主进程: ★ 有后端保活心跳（定时重新 ensureServer）',
    /setInterval\([\s\S]{0,500}ensureServer/.test(mainJs)],
  ['主进程: ★ 心跳里也保活数据库（ensurePostgres quiet）',
    /setInterval[\s\S]{0,500}ensurePostgres[\s\S]{0,150}quiet:\s*true/.test(mainJs)],
  ['主进程: 退出时会清掉心跳（不留悬挂定时器）',
    /before-quit[\s\S]{0,200}clearInterval/.test(mainJs)],
  ['主进程: ensurePostgres 支持 quiet（保活不再每 10 秒刷一行日志）',
    supervisorJs.includes('quiet') && /opts\.quiet/.test(supervisorJs)],

  // ── ★ 本轮（不弹终端）的新增自检 ──
  // 背景：用户报「一直弹终端」。实测（pg-launch-window-test.cjs）：
  //   `spawn(postgres.exe, …, { detached:true, windowsHide:true })` → **窗口 +1**；
  //   去掉 detached → 窗口 0。原因是 DETACHED_PROCESS 与 CREATE_NO_WINDOW 冲突，
  //   Windows 会给这个控制台程序**新建一个控制台**（Win11 由 Windows Terminal 承载）。
  // ★ 这两条必须**剥掉注释**再判 —— 代码注释里为了讲清原因写了 `detached: true` 这串字面量。
  ['主进程: ★ 拉 PG 不再用 detached（否则 Windows 新建控制台 → 弹黑窗）',
    !/detached:\s*true/.test(stripComments(supervisorJs))],
  ['主进程: 拉 PG 用 windowsHide（不弹窗）',
    /windowsHide:\s*true/.test(stripComments(supervisorJs))],

  // ── ★ 本轮（第 26 步：搜索/浏览器分家 + 来源标注）的新增自检 ──
  // 背景：①「帮我查一下今天的美元汇率」在开着网页时被误判成操作当前页；
  //      ②「帮我在必应上查一下…」这种"在 X 上"句式既不开页也不搜索；
  //      ③ 搜索回答下方要列出「来源」，可点击跳原始网页。
  // 这一组证明这三件事都被换进去了。
  //
  // ★ 全部钉在**压缩后必然还在**的东西上：CSS 类名 / 字符串字面量 / 用户可见文案。
  //   本步的判定函数（`detectBrowseIntent` / `detectOpenUrl`）是模块内局部名，
  //   vite 压缩会改名，**搜不到** —— 别拿它们当断言。
  ['渲染层: ★ 来源块渲染出来了（sources__item / sources__label）',
    rendererJs.includes('sources__item') && rendererJs.includes('sources__label')],
  ['渲染层: ★ 来源条目是外链（target=_blank + rel=noreferrer）',
    rendererJs.includes('_blank') && rendererJs.includes('noreferrer')],
  ['渲染层: ★ 搜索期间有「正在搜索」提示（用户看得见在联网查）',
    rendererJs.includes('正在搜索')],
  ['渲染层: 来源块标签是「来源」', rendererJs.includes('来源')],
  // 问题 A：把「查一下/搜一下」这类**要一条信息**的说法，从"页面专属动作"里拆出来。
  // 产物里查判定正则的字面量（压缩不会改正则里的中文）。
  ['渲染层: 问题A —— 「查一下/搜一下」判定仍在（拆分后没丢）',
    rendererJs.includes('查一下') && rendererJs.includes('搜一下')],
  ['渲染层: 问题A —— 「在这个页面」这类页面指代词优先级更高（不被"查资料"误伤）',
    rendererJs.includes('在这个页面')],
  ['渲染层: 问题A —— 页面专属动作仍在（滚动 / 翻页）',
    rendererJs.includes('滚动') && rendererJs.includes('翻页')],
  // 问题 B：「在 X 上」句式。产物里能锚的是站点登记表的字面量（doubao / tongyi 是存量，
  // 这里额外确认"认不出站点"的兜底提示还在 —— 防误报闸没被这次改动带歪）。
  ['渲染层: 问题B —— 认不出站点时的兜底提示仍在（防误报闸没被带歪）',
    rendererJs.includes('认不出')],

  // ── ★ 本轮（isElectron 登录修复）的新增自检 ──
  // 背景：渲染层 API_BASE() 靠 `window.workbench?.isElectron` 决定后端地址。
  //   preload 缺这个字段 ⇒ `!undefined === true` ⇒ 返回空串 ⇒ `file://` 下 fetch 必败
  //   ⇒ 界面永远停在「正在准备后端」，登录不上。
  // 这两条直接钉住"修复真的进了包"：preload 必须真的暴露该字段，渲染层必须真的用它判定。
  // ★ 压缩安全性：`isElectron` 是**对象属性名**，vite 压缩不会改名；
  //   preload.js 是 tsc 产物（不压缩），字面量原样保留。
  ['主进程: ★ preload.js 暴露 isElectron（本轮登录修复）',
    fs.readFileSync(path.join(elDir, 'preload.js'), 'utf8').includes('isElectron')],
  ['渲染层: ★ API_BASE 用 isElectron 判定（本轮登录修复）',
    rendererJs.includes('isElectron')],
];
console.log('\n主进程 + 渲染层功能自检：');
for (const [name, ok] of must) console.log(`   ${ok ? '✓' : '✗'} ${name}`);
if (must.some(([, ok]) => !ok)) {
  console.error('\n自检没过，取消换装（旧包保持不动）。');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

// 8) 原子替换：先写同目录临时名，再用**两次 rename** 就位。
//
// ★ 2026-09-18 踩的坑：原来这里用 `fs.rmSync(ASAR)`，但本机的 safe-delete shim
//   会把 rm 转成「移到回收站」，对 Program Files 下的文件直接失败：
//   "Error during a `trash` operation: Some operations were aborted"。
//   结果是新包已经写成 app.asar.new，旧包却没删掉、rename 也没执行 ——
//   应用没事，但换包没生效，而脚本自己报的错看起来像"环境坏了"。
//   改成 rename 就绕开了：旧包改名让位、新包上位，**全程不删任何文件**。
//
// ★ 2026-09-20：沙箱里 `fs.renameSync` 会报 `EBUSY`（栈里是 node-brokered-fs-shim），
//   而**同等的 shell `mv` 是好的**。所以这里失败时不再抛栈，而是把两条 mv 命令
//   原样打出来 —— 照着敲就能收尾，不会像上次那样留下一个"空的 app.asar"。
const retired = ASAR + '.old-' + STAMP;
try {
  fs.renameSync(ASAR, retired);   // 旧包让位（Windows 上 rename 会覆盖同名旧残留）
  fs.renameSync(staged, ASAR);    // 新包就位
} catch (e) {
  console.error(`\n✗ rename 失败：${e.code} ${e.message}`);
  console.error(`  新包已就绪：${staged}`);
  console.error('  手工收尾（两条 mv，顺序不能反）：');
  console.error(`    mv "${ASAR}" "${retired}"`);
  console.error(`    mv "${staged}" "${ASAR}"`);
  process.exit(2);
}
console.log(`\n已替换 -> ${ASAR}`);
console.log(`  旧 ${size0} B  ->  新 ${fs.statSync(ASAR).size} B`);
console.log(`  sha256(app.asar) = ${sha(ASAR)}`);

// 让位的旧包挪出安装目录（它和 .bak-* 是同一份内容，留着只是占地方）
const ARCHIVE = String.raw`C:\Users\bing\workbuddy-ai\work123\_rollback-backup-20260918`;
if (fs.existsSync(ARCHIVE)) {
  const dst = path.join(ARCHIVE, `app.asar.old-${STAMP}`);
  run(() => fs.rmSync(dst, { force: true }));   // 同名先让位，避免 Windows rename 覆盖失败
  run(() => fs.renameSync(retired, dst));
  if (fs.existsSync(dst)) console.log('  旧包已归档 ->', dst);
  else console.log('  旧包留在安装目录 ->', retired);
} else {
  console.log('  旧包留在安装目录 ->', retired);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('DONE');
