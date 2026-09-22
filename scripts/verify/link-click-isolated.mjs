/**
 * 链接/视频「点不动」的**隔离复现**（不起整套桌面端，快且稳）。
 *
 * 做法：起一个最小 Electron，主进程**原样复制** main.ts 里
 * `setWindowOpenHandler` / `will-navigate` 那套拦截逻辑，页面里放各类链接，
 * 然后按 driver.ts clickTarget 的路径去点，看哪一类没反应。
 *
 * 这样做的价值：把「点击链路」从整个应用里切出来单独验 ——
 * 如果在这里复现不出来，说明问题在别处（比如渲染层没把点击送进 driver），
 * 避免对着错误的模块改半天。
 *
 * 用法：node scripts/verify/link-click-isolated.mjs
 */
import { app, BrowserWindow } from 'electron';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '..', '..', 'docs', 'acceptance', 'link-click');
mkdirSync(OUT, { recursive: true });
const lines = [];
const log = (...a) => {
  const s = a.map(String).join(' ');
  lines.push(s);
  console.log(s);
};

const isHttpUrl = (url) => /^https?:\/\//i.test(url);

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8">
<title>LINKCLICK</title><style>
body{font:15px/1.6 system-ui;margin:20px;background:#fff;color:#111}
a,button{display:block;margin:8px 0;padding:6px 10px;border:2px solid #2c7;
  background:#f6fffb;border-radius:6px;text-decoration:none;color:#063;font-size:15px}
button{border-color:#37c;background:#f5f8ff;color:#036}
#log{font:13px monospace;background:#f0f0f0;padding:8px;border-radius:6px;margin-top:12px}
</style></head><body>
<h4 id="T">LINKCLICK</h4>
<a id="L1" href="https://example.com/plain" target="_self">L1 普通链接(同页)</a>
<a id="L2" href="https://example.com/blank" target="_blank">L2 target=_blank</a>
<a id="L3" href="https://example.com/inner"><span>L3 里层 span</span></a>
<a id="L4" href="javascript:void(0)" onclick="mk('L4')">L4 javascript:</a>
<button id="L5" onclick="mk('L5')">L5 按钮 onclick</button>
<a id="L6" href="file:///C:/Windows/win.ini">L6 非 http (file:)</a>
<a id="L7" href="https://example.com/winopen" onclick="window.open('https://example.com/winopen','_blank');return false">L7 window.open JS</a>
<div id="log">marks: (none)</div>
<script>
window.__marks=[]; window.__navs=[]; window.__opens=[];
function mk(x){window.__marks.push(x);document.getElementById('log').textContent='marks: '+window.__marks.join(', ');}
const _o=window.open; window.open=function(u){window.__opens.push(String(u));mk('open:'+u);return null;};
document.addEventListener('click',function(e){
  const a=e.target&&e.target.closest?e.target.closest('a[href]'):null;
  if(a)window.__navs.push(a.getAttribute('href'));},true);
</script></body></html>`;

const results = [];

async function probe(win, id, describe, targetJs) {
  const wc = win.webContents;
  // ★ 每一类点击前都**重新载入复现台**：上一个用例可能把页面导航走了
  // （L1 就是），否则后面所有元素都"找不到" —— 那是假失败，会把人带偏。
  try {
    await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(FIXTURE));
    await new Promise((r) => setTimeout(r, 350));
  } catch (e) {
    log(`  ${id}: 载入复现台失败 ${String(e).slice(0, 60)}`);
  }
  const R = await wc.executeJavaScript(`(()=>{
    const el = ${targetJs};
    if(!el) return {notfound:true};
    try{el.scrollIntoView({block:'center'});}catch(_){}
    const r=el.getBoundingClientRect();
    const cx=r.left+r.width/2, cy=r.top+r.height/2;
    const vw=document.documentElement.clientWidth, vh=document.documentElement.clientHeight;
    const inside=cx>=0&&cy>=0&&cx<vw&&cy<vh;
    let top=null; try{top=document.elementFromPoint(cx,cy);}catch(_){}
    const hittable=inside&&!!top&&(top===el||el.contains(top));
    return {x:Math.round(cx),y:Math.round(cy),tag:el.tagName,inside,hittable,
            before:location.href+'|'+document.querySelectorAll('*').length,
            marks:(window.__marks||[]).length,
            navs:(window.__navs||[]).length, opens:(window.__opens||[]).length,
            topTag: top? top.tagName : '(null)'};
  })()`);
  if (R.notfound) {
    results.push({ id, describe, outcome: 'notfound' });
    log(`  ${id} ${describe}: 元素没找到`);
    return;
  }

  let method;
  if (R.hittable) {
    method = 'cdp-mouse';
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: R.x - 3, y: R.y - 2, button: 'none', clickCount: 0 });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: R.x, y: R.y, button: 'none', clickCount: 0 });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: R.x, y: R.y, button: 'left', buttons: 1, clickCount: 1 });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: R.x, y: R.y, button: 'left', buttons: 0, clickCount: 1 });
  } else {
    method = 'page-el.click';
    await wc.executeJavaScript(`(()=>{const el=${targetJs}; if(el) el.click(); return !!el;})()`);
  }
  await new Promise((r) => setTimeout(r, 1200));

  // 页面被导航走就读不到 js 了 → 那本身就是"点动了"的强证据
  let after = null;
  try {
    after = await wc.executeJavaScript(`(()=>({url:location.href,
      marks:(window.__marks||[]).length, navs:(window.__navs||[]).length,
      opens:(window.__opens||[]).length,
      key:location.href+'|'+document.querySelectorAll('*').length}))()`);
  } catch (e) {
    after = { navigated: true, err: String(e).slice(0, 80) };
  }

  const moved = after.navigated
    ? true
    : (after.key !== R.before || after.marks > R.marks
       || after.navs > R.navs || after.opens > R.opens);
  results.push({ id, describe, hittable: R.hittable, method, moved,
                 before: R.before, after: after.key || '(navigated)', afterUrl: after.url,
                 marks: after.marks, navs: after.navs, opens: after.opens });
  log(`  ${id} ${describe}: hittable=${R.hittable} method=${method} moved=${moved}` +
      (after.url ? ` url=${after.url}` : '') +
      ` marks=${after.marks} navs=${after.navs} opens=${after.opens}`);
}

app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 700, show: false });

  // ★ 原样复制 main.ts 里内嵌页的那套拦截（这是被测对象）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) {
      setImmediate(() => {
        if (!win.isDestroyed()) {
          void win.webContents.loadURL(url).catch((e) => {
            log('   [主进程] loadURL 失败: ' + e.message);
          });
        }
      });
      log('   [主进程] window.open 命中 http → 同一 guest 导航: ' + url);
    } else {
      log('   [主进程] 拦下非 http 的 window.open: ' + url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isHttpUrl(url)) return;
    event.preventDefault();
    log('   [主进程] 拦下非 http 跳转: ' + url);
  });

  win.webContents.debugger.attach('1.3');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(FIXTURE));
  await new Promise((r) => setTimeout(r, 600));

  // 记录主进程被触发的证据（window.open / 导航拦截都会打到这里）
  const mainEvents = [];
  win.webContents.on('did-start-navigation', (_e, url) => {
    mainEvents.push('did-start-navigation ' + String(url).slice(0, 70));
  });
  globalThis.__mainEvents = mainEvents;
  globalThis.__markLen = () => mainEvents.length;

  log('=== 按 driver.ts 的路径逐类点击 ===');
  await probe(win, 'L1', '普通链接(target=_self)', "document.getElementById('L1')");
  await probe(win, 'L2', '目标=_blank 新窗口', "document.getElementById('L2')");
  await probe(win, 'L3', '里层 span 的链接', "document.getElementById('L3')");
  await probe(win, 'L4', 'javascript: 链接', "document.getElementById('L4')");
  await probe(win, 'L5', '普通按钮 onclick', "document.getElementById('L5')");
  await probe(win, 'L6', '非 http (file:) 链接', "document.getElementById('L6')");
  await probe(win, 'L7', 'window.open JS 链接', "document.getElementById('L7')");

  log('');
  log('=== 主进程事件（window.open / 导航） ===');
  for (const e of mainEvents) log('  ' + e);

  log('');
  log('=== 汇总 ===');
  const bad = results.filter((r) => !r.moved);
  for (const r of results) {
    log(`  ${r.moved ? 'OK  ' : 'BAD '} ${r.id} ${r.describe}` +
        `  hittable=${r.hittable} method=${r.method}`);
  }
  log(`共 ${results.length} 类，点不动 ${bad.length} 类`);
  if (bad.length) log('点不动的是: ' + bad.map((b) => b.id + ' ' + b.describe).join(' | '));

  writeFileSync(path.join(OUT, 'isolated-result.json'),
                JSON.stringify({ results, lines }, null, 2), 'utf8');
  writeFileSync(path.join(OUT, 'isolated-run.log'), lines.join('\n'), 'utf8');
  app.exit(0);
}).catch((e) => {
  log('FATAL ' + (e.stack || e.message));
  try {
    writeFileSync(path.join(OUT, 'isolated-run.log'), lines.join('\n'), 'utf8');
  } catch (_) { /* ignore */ }
  app.exit(1);
});
