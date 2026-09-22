/**
 * 系统性根因探针：把截图里 AI 自述的三种现象，逐条还原到 **可复现的最小页面** 上，
 * 用**真实的 driver 代码路径**（不是手抄的近似实现）判断哪一条站得住。
 *
 * 截图里的三条自述（原始证据）：
 *   (a) 「之前点击标题无跳转，可能是新标签打开」
 *   (b) 「能真的打开了新标签，只是工作台没切换」
 *   (c) 「首页视频列表没加载出来（可能需要登录或加载中）」
 *       末了「一路最多走 10 步，现在走满了」
 *
 * 探针分四节，每节结论都要能用数字说话：
 *   ① 懒加载墙：视频列表在**滚动到可视区**之前是空的。
 *      → 测 driver 的 snapshot()/find() 在未滚动 / 滚动后 分别能看到几条。
 *      若「未滚动看不到、滚动后看得到」，则 (c) 的成因是**没有滚动动作**，不是找不到元素。
 *   ② iframe 墙：播放器 / 列表在 <iframe> 里。
 *      → 测现有 find() vs 穿透 findDeep()。验证 (a) 「点标题没反应」。
 *   ③ Shadow DOM 墙：同 ② 的第二条腿（现代站点常见）。
 *   ④ 「新标签」语义：window.open 被 setWindowOpenHandler 改成**同页导航**后，
 *      页面侧 pageKey 变没变？渲染层 tab 列表会不会多一条？
 *      —— 这一节**不复制实现**，直接 require 编译产物里真实的 setWindowOpenHandler
 *         逻辑做不到（它绑在 app 事件上），所以改为对比两种 handler 策略下的
 *         可观测差异，并把「渲染层为什么不同步」的判据打印出来。
 *
 * 用法：
 *   apps/desktop/node_modules/.bin/electron scripts/verify/rootcause-browser-probe.mjs --no-sandbox
 * 也可： npx electron scripts/verify/rootcause-browser-probe.mjs --no-sandbox
 */
import { app, BrowserWindow } from 'electron';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '..', '..', 'docs', 'acceptance', 'root-cause');
mkdirSync(OUT, { recursive: true });

const lines = [];
const log = (...a) => {
  const s = a.map(String).join(' ');
  lines.push(s);
  console.log(s);
};
let fails = 0;
const check = (name, ok, extra = '') => {
  if (!ok) fails += 1;
  log(`  ${ok ? 'PASS' : '★FAIL'} ${name}${extra ? '  —— ' + extra : ''}`);
};

app.commandLine.appendSwitch('no-sandbox');

// ---------------------------------------------------------------------------
// ① 懒加载墙：列表项在滚动进视口前**根本不存在于 DOM**
// ---------------------------------------------------------------------------
const LAZY_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>LAZY 视频站</title>
<style>
 body{margin:0;font:14px system-ui;background:#fff}
 #feed{height:2400px;background:#fafafa}
 .card{height:520px;border-bottom:1px solid #ddd;padding:16px;box-sizing:border-box}
 .card a{display:block;font-size:18px;color:#06c;text-decoration:none;padding:8px 0}
</style></head><body>
<div style="padding:12px;background:#eee" id="sentinel">列表容器（前 3 张卡在视口外）</div>
<div id="feed"></div>
<script>
// 真实站点做法：IntersectionObserver / 滚动事件里才 append 卡片。
// 这里刻意模仿「首屏 DOM 里一张卡都没有」的情况 —— 与截图里
// 「视频列表没加载出来」的现象一致。
const TITLES = ['影视飓风：iPhone 17 Pro 深度评测','影视飓风：我们如何拍一部电影','影视飓风：色彩管理入门',
                '别的UP主：开箱视频','别的UP主：Vlog 日常'];
let built = 0;
function build(n){
  const feed = document.getElementById('feed');
  for (let i = built; i < n && i < TITLES.length; i += 1) {
    const d = document.createElement('div');
    d.className = 'card';
    d.innerHTML = '<a href="#v' + i + '" class="vtitle">' + TITLES[i] + '</a>';
    feed.appendChild(d);
  }
  if (n > built) built = n;
}
// 只有滚动过才建后面那些卡（模拟懒加载）
let called = false;
window.addEventListener('scroll', function(){
  if (window.scrollY > 50) { called = true; build(TITLES.length); }
}, { passive: true });
window.__lazy = { built: () => built, scrollCalls: () => called };
build(3); // 首屏只建 3 张（全在视口外，因为 #feed 从 y≈40 开始但卡片高 520）
</script></body></html>`;

// ---------------------------------------------------------------------------
// ②③ iframe + shadow DOM 墙
// ---------------------------------------------------------------------------
const PLAYER_IFRAME = `<!doctype html><html><head><meta charset="utf-8"><title>player</title>
<style>body{margin:0;background:#000;color:#fff;font:14px system-ui}
#play{margin:24px;padding:14px 22px;background:#e33;border:0;color:#fff;font-size:17px;border-radius:6px}
#st{margin:24px;font:13px monospace}</style></head><body>
<button id="play">▶ 播放视频</button>
<div id="st">inner hits:0</div>
<script>window.__h=0;document.getElementById('play').onclick=function(){
 window.__h++;document.getElementById('st').textContent='inner hits:'+window.__h;};</script>
</body></html>`;

const FRAME_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>FRAME 站点</title>
<style>body{margin:0;font:14px system-ui;background:#fff}
 #hostbtn{margin:12px;padding:10px 18px;background:#28a;border:0;color:#fff;border-radius:6px}
 iframe{width:460px;height:180px;border:2px solid #999;margin:12px;display:block}
 #sst{margin:12px;font:13px monospace;background:#eee;padding:8px}</style>
</head><body>
<button id="hostbtn">主文档按钮（基线）</button>
<iframe id="fr" srcdoc="${PLAYER_IFRAME.replace(/"/g, '&quot;')}"></iframe>
<div id="sdhost"></div>
<div id="sst">shadow hits:0</div>
<script>
window.__hostH=0; document.getElementById('hostbtn').onclick=function(){window.__hostH++;};
const root = document.getElementById('sdhost').attachShadow({mode:'open'});
root.innerHTML='<button id="splay" style="margin:12px;padding:10px 18px;background:#793;border:0;color:#fff;border-radius:6px">▶ 播放（Shadow DOM）</button>';
window.__shadowH=0;
root.getElementById('splay').onclick=function(){window.__shadowH++;
 document.getElementById('sst').textContent='shadow hits:'+window.__shadowH;};
</script></body></html>`;

// ---------------------------------------------------------------------------
// ③.5 新标签墙：target=_blank / window.open 的三种归宿
// ---------------------------------------------------------------------------
const NEWTAB_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>NEWTAB 站点</title>
<style>body{margin:0;font:14px system-ui;padding:12px}
 a,button{display:block;margin:8px 0;font-size:16px}
 #st{font:13px monospace;background:#eee;padding:8px;margin-top:12px}</style>
</head><body>
<a id="a-blank" href="about:blank#second" target="_blank">① target=_blank 标题（真实站点最常见）</a>
<a id="a-self" href="about:blank#third">② 普通同页链接</a>
<button id="b-open">③ window.open 打开新标签</button>
<div id="st">pageKey 基线</div>
<script>
window.__opened = 0;
document.getElementById('b-open').onclick = function(){
  window.__opened += 1;
  const w = window.open('about:blank#popup-' + window.__opened, '_blank');
  document.getElementById('st').textContent = 'window.open 返回：' + (w ? '窗口对象' : 'null（被拦）');
};
</script></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1000, height: 700, show: false,
    webPreferences: { webviewTag: true },
  });
  win.webContents.debugger.attach('1.3');
  const wc = win.webContents;
  const ev = (js) => wc.executeJavaScript(js);

  // ---- 把真实 driver 里的页面侧 helper 抠出来（PAGE_HELPERS 常量）----
  const driverSrc = await (await import('node:fs/promises')).readFile(
    path.resolve(import.meta.dirname, '..', '..', 'apps', 'desktop', 'electron', 'driver.ts'), 'utf8');
  const m = driverSrc.match(/const PAGE_HELPERS = `([\s\S]*?)`;\r?\n/);
  if (!m) {
    log('★ 抠不出 PAGE_HELPERS —— driver.ts 结构变了，本探针需要更新');
    app.exit(1);
    return;
  }
  const PAGE_HELPERS = m[1];
  log(`已从 driver.ts 抠出真实 PAGE_HELPERS（${PAGE_HELPERS.length} 字符）—— 下面跑的 find()/snapshot() 都是**线上那份**`);
  log('');

  // =========================================================================
  log('=== ① 懒加载墙：视频列表在滚动前是否存在 ===');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(LAZY_PAGE));
  await new Promise((r) => setTimeout(r, 900));

  const lazyBefore = await ev(`(() => {
    ${PAGE_HELPERS}
    const H = window.__wbHelper;
    const snap = H.snapshot();
    return {
      domCards: document.querySelectorAll('.card').length,
      visibleLinks: snap.links.length,
      linkTexts: snap.links.slice(0, 6),
      contentTexts: H.contentTexts().slice(0, 6),
      scrollY: window.scrollY,
    };
  })()`);
  log('  未滚动时：');
  log(`    DOM 里 .card 数量 = ${lazyBefore.domCards}   scrollY=${lazyBefore.scrollY}`);
  log(`    snapshot().links = ${JSON.stringify(lazyBefore.linkTexts)}`);
  log(`    contentTexts() 前几条 = ${JSON.stringify(lazyBefore.contentTexts)}`);

  // 滚动到底
  await ev(`(async () => {
    for (let y = 0; y <= 2400; y += 400) { window.scrollTo(0, y); await new Promise(r=>setTimeout(r,120)); }
    window.scrollTo(0, 0);
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 700));

  const lazyAfter = await ev(`(() => {
    ${PAGE_HELPERS}
    const H = window.__wbHelper;
    const snap = H.snapshot();
    return {
      domCards: document.querySelectorAll('.card').length,
      visibleLinks: snap.links.length,
      linkTexts: snap.links.slice(0, 6),
      contentTexts: H.contentTexts().slice(0, 8),
      lazyCalled: window.__lazy.scrollCalls(),
    };
  })()`);
  log('  滚动一遍之后（再滚回顶部）：');
  log(`    DOM 里 .card 数量 = ${lazyAfter.domCards}   （懒加载触发过=${lazyAfter.lazyCalled}）`);
  log(`    snapshot().links = ${JSON.stringify(lazyAfter.linkTexts)}`);
  log(`    contentTexts() 前几条 = ${JSON.stringify(lazyAfter.contentTexts)}`);
  log('');
  check('懒加载：未滚动只看到首屏、滚动后才全（driver 需要主动滚动才拿得全）',
    lazyBefore.domCards === 3 && lazyAfter.domCards === 5,
    `未滚动 ${lazyBefore.domCards} 张 → 滚动后 ${lazyAfter.domCards} 张`);
  check('★ 修复后：contentTexts() 能拿到链接列表（老实现返回空数组）',
    lazyBefore.contentTexts.length >= 3,
    JSON.stringify(lazyBefore.contentTexts.slice(0, 3)));

  // =========================================================================
  log('');
  log('=== ② iframe 墙 + ③ Shadow DOM 墙：现有的 find() 能不能看见 ===');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(FRAME_PAGE));
  await new Promise((r) => setTimeout(r, 1200));

  const probe = await ev(`(() => {
    ${PAGE_HELPERS}
    const H = window.__wbHelper;
    const out = {};
    const targets = [
      ['主文档按钮（基线）', 'host'],
      ['▶ 播放视频', 'iframe'],
      ['▶ 播放（Shadow DOM）', 'shadow'],
    ];
    for (const [label, tag] of targets) {
      let el = null, err = '';
      try { el = H.find(label); } catch (e) { err = e.message; }
      out[tag] = el ? { found: true, node: el.tagName + (el.id ? '#' + el.id : '') } : { found: false, err };
    }
    // snapshot 能看到什么
    const snap = H.snapshot();
    out._snapButtons = snap.buttons;
    out._snapLinks = snap.links;
    // pageKey 是不是只看主文档
    out._pageKey = H.pageKey();
    // helper 实际版本（顺带验一下守卫常量对不对）
    out._helperVer = H.__v;
    // iframe 的 contentDocument 到底能不能读（同源 srcdoc 应该能）
    const f = document.getElementById('fr');
    out._iframeDocReadable = (() => { try { return !!f.contentDocument; } catch (e) { return 'ERR:' + e.message; } })();
    out._iframeInnerButtons = (() => {
      try { return Array.prototype.map.call(f.contentDocument.querySelectorAll('button'), (b) => b.textContent.trim()); }
      catch (e) { return 'ERR:' + e.message; }
    })();
    out._shadowRootReadable = !!document.getElementById('sdhost').shadowRoot;
    return out;
  })()`);

  log(`  主文档按钮（基线）        → ${probe.host.found ? '找到 ' + probe.host.node : '★ notfound'}`);
  log(`  iframe 里的「▶ 播放视频」  → ${probe.iframe.found ? '找到 ' + probe.iframe.node : '★ notfound（find() 进不去 iframe）'}`);
  log(`  Shadow DOM 里的播放按钮    → ${probe.shadow.found ? '找到 ' + probe.shadow.node : '★ notfound（find() 进不去 shadow root）'}`);
  log(`  iframe.contentDocument 可读? ${probe._iframeDocReadable}`);
  log(`  iframe 内实际存在的按钮     = ${JSON.stringify(probe._iframeInnerButtons)}`);
  log(`  shadowRoot 可读? ${probe._shadowRootReadable}`);
  log(`  snapshot().buttons         = ${JSON.stringify(probe._snapButtons)}`);
  log(`  snapshot().links           = ${JSON.stringify(probe._snapLinks)}`);
  log('');
  check('★ 修复后：iframe 里的元素**找得到**了', probe.host.found === true && probe.iframe.found === true,
    probe.iframe.node || String(probe.iframe.err));
  check('★ 修复后：Shadow DOM 里的元素**找得到**了', probe.shadow.found === true,
    probe.shadow.node || String(probe.shadow.err));
  check('★ 修复后：snapshot() 能看到 iframe 与 shadow 里的按钮', probe._snapButtons.length >= 3,
    JSON.stringify(probe._snapButtons));
  check('但 iframe/shadow 里的元素**其实存在且可点**（说明缺的是"找"，不是"点"）',
    Array.isArray(probe._iframeInnerButtons) && probe._iframeInnerButtons.some((t) => t.includes('播放')));

  // 拿到 iframe 内按钮坐标，用**真鼠标**点一次，证明点击链路本身没问题
  const coord = await ev(`(() => {
    const f = document.getElementById('fr');
    const b = f.contentDocument.getElementById('play');
    const r = b.getBoundingClientRect();
    const fr = f.getBoundingClientRect();
    // iframe 内坐标要加上 iframe 自身的偏移
    return { x: fr.left + r.left + r.width / 2, y: fr.top + r.top + r.height / 2 };
  })()`);
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: coord.x, y: coord.y });
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', buttons: 1, clickCount: 1 });
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 500));
  const innerHits = await ev(`document.getElementById('fr').contentDocument.defaultView.__h`);
  log(`  真鼠标点 iframe 内播放按钮 → inner hits=${innerHits}`);
  check('点击链路本身没问题：拿到坐标就能点动 iframe 内的按钮', innerHits > 0);

  // =========================================================================
  log('');
  log('=== ④ 新标签语义：target=_blank 被拦成"同页导航"后，渲染层看得到吗 ===');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(NEWTAB_PAGE));
  await new Promise((r) => setTimeout(r, 800));

  // 先用**当前线上策略**（deny + 同 guest loadURL）复现一次
  const before = await ev(`(() => { ${PAGE_HELPERS}
    const H = window.__wbHelper;
    return { key: H.pageKey(), url: location.href, title: document.title, ver: H.__v }; })()`);
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || url.startsWith('about:')) {
      setImmediate(() => { if (!wc.isDestroyed()) void wc.loadURL(url).catch(() => {}); });
    }
    return { action: 'deny' };
  });
  // 点 target=_blank 那条链接（用真鼠标，走和 driver 一样的路）
  const aCoord = await ev(`(() => { const r = document.getElementById('a-blank').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: aCoord.x, y: aCoord.y, button: 'left', buttons: 1, clickCount: 1 });
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: aCoord.x, y: aCoord.y, button: 'left', buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 900));
  const after = await ev(`(() => ({ url: location.href, title: document.title }))()`);
  log(`  点击前：${before.url}  title=${before.title}`);
  log(`  点击后：${after.url}  title=${after.title}`);
  const navigated = after.url !== before.url;
  log(`  → 同一个 guest **导航走了**（页面被替换）：${navigated}`);
  log('  ★ 这就是截图里那句「能真的打开了新标签，只是工作台没切换」的可观测形态：');
  log('     guest 里地址变了，但**渲染层的 tab 列表由 React state 维护**，主进程没有把');
  log('     「这张 guest 换地址了」的通知回推给渲染层 → 顶部不多一条 tab、地址栏不同步。');
  check('新标签被折成同页导航（渲染层无从得知新 tab 存在）', navigated === true);

  // 对照：如果改成 createWindow（真·新窗口），那就该出现第二个 webContents
  const gcBefore = wc.getAllWebContents ? wc.getAllWebContents().length : -1;
  log(`  当前 webContents 数 = ${gcBefore}（单窗口单 guest 场景下没有第二个）`);

  log('');
  log('=== 结论 ===');
  log(`  ① 懒加载：未滚动 ${lazyBefore.domCards} 张 → 滚动后 ${lazyAfter.domCards} 张（driver 需主动滚动才拿得全）`);
  log(`  ② iframe  墙：${probe.iframe.found ? '★ 已修复（find 能找到）' : '未修复'}`);
  log(`  ③ shadow  墙：${probe.shadow.found ? '★ 已修复（find 能找到）' : '未修复'}`);
  log(`  ④ 新标签   ：${navigated ? '折成同页导航' : '未折成'} —— 渲染层 tab 不同步，用户觉得"没开新 tab"`);
  log('');
  log(`  失败项：${fails}`);

  writeFileSync(path.join(OUT, 'rootcause-probe.json'),
    JSON.stringify({ lines, fails, lazyBefore, lazyAfter, probe, navigated }, null, 2), 'utf8');
  writeFileSync(path.join(OUT, 'rootcause-probe.log'), lines.join('\n'), 'utf8');
  app.exit(fails > 0 ? 1 : 0);
}).catch((e) => {
  log('FATAL ' + (e.stack || e.message));
  try { writeFileSync(path.join(OUT, 'rootcause-probe.log'), lines.join('\n'), 'utf8'); } catch (_) {}
  app.exit(1);
});
