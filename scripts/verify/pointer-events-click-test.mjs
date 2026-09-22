/**
 * 关键假设验证：**`pointer-events: none` 会不会让 CDP 真实鼠标点击落空？**
 *
 * 为什么怀疑它：
 *   `styles.css` 的 `.browserPanel__view--off { opacity:0; pointer-events:none }`
 *   上面写着「所以那张页仍然活着、仍然有真实尺寸，它上面跑着的那一路驾驶照样点得中」。
 *   但 CDP 的 `Input.dispatchMouseEvent` 是**浏览器的真实鼠标事件**，
 *   命中测试（hit test）是会尊重 `pointer-events` 的 —— 如果这条注释是错的，
 *   那么「AI 在非当前标签页上点击」就会**静默失败**，现象正是"点了没反应"。
 *
 * 同时验证第二个假设：**视口尺寸为 0 / 被隐藏**时点击是否落空。
 *
 * 用法：electron scripts/verify/pointer-events-click-test.mjs --no-sandbox
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>PE</title>
<style>body{margin:0;font:14px system-ui}
#t{position:absolute;left:40px;top:60px;width:260px;height:70px;background:#8f8;
   border:3px solid #080;font-size:16px;line-height:70px;text-align:center}</style>
</head><body>
<div id="t">点我试试</div>
<div id="log" style="position:absolute;left:40px;top:160px">hits:0</div>
<script>
window.__hits=0;
document.getElementById('t').addEventListener('click',function(){
  window.__hits++; document.getElementById('log').textContent='hits:'+window.__hits;
});
document.addEventListener('click',function(e){
  window.__any=(window.__any||0)+1;
  window.__last = (e.target&&e.target.id)||'(none)';
},true);
</script></body></html>`;

app.commandLine.appendSwitch('no-sandbox');

async function clickAt(wc, x, y) {
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',
    { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',
    { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 800, height: 600, show: false,
    webPreferences: { webviewTag: true },
  });

  // 用一个宿主页把被试点嵌进 <webview>，尽量贴近产品形态
  const host = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#eee}
    webview{position:absolute;left:0;top:0;width:600px;height:400px;border:0;z-index:1}
    #webview-wrap{position:absolute;inset:0}
    .on{z-index:2}
    .off{opacity:0;pointer-events:none;z-index:0}
  </style></head><body>
  <div id="webview-wrap">
    <webview id="wv" src="data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}" allowpopups></webview>
  </div>
  </body></html>`;

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(host));
  await new Promise((r) => setTimeout(r, 2500));

  const all = win.webContents.getAllWebContents
    ? null
    : null;
  const { webContents } = await import('electron');
  const guests = webContents.getAllWebContents().filter((c) => c.getType() === 'webview');
  log('webview guests: ' + guests.length);
  if (!guests.length) {
    log('没有 guest，无法继续');
    app.exit(1);
    return;
  }
  const g = guests[0];
  g.debugger.attach('1.3');

  const rect = await g.executeJavaScript(
    `(()=>{const r=document.getElementById('t').getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  log('目标中心（guest 内坐标）= ' + JSON.stringify(rect));

  const reset = async () => {
    await g.executeJavaScript('window.__hits=0;window.__any=0;window.__last="";'
      + "document.getElementById('log').textContent='hits:0';");
  };
  const read = async () => g.executeJavaScript(
    '(()=>({hits:window.__hits,any:window.__any||0,last:window.__last||""}))()');

  // ---- 用例 1：正常显示（基线）----
  await reset();
  await clickAt(g, rect.x, rect.y);
  await new Promise((r) => setTimeout(r, 500));
  let r1 = await read();
  log(`  用例1 正常显示: ${JSON.stringify(r1)}  -> ${r1.hits > 0 ? 'OK 点到了' : 'BAD 没点到'}`);

  // ---- 用例 2：宿主给 webview 加 pointer-events:none ----
  await win.webContents.executeJavaScript(
    "document.getElementById('wv').className='off'; 'ok'");
  await new Promise((r) => setTimeout(r, 600));
  await reset();
  await clickAt(g, rect.x, rect.y);
  await new Promise((r) => setTimeout(r, 500));
  let r2 = await read();
  log(`  用例2 pointer-events:none: ${JSON.stringify(r2)}  -> ${r2.hits > 0 ? 'OK 点到了' : 'BAD 没点到'}`);

  // ---- 用例 3：恢复后再点（确认不是一次性的）----
  await win.webContents.executeJavaScript(
    "document.getElementById('wv').className='on'; 'ok'");
  await new Promise((r) => setTimeout(r, 600));
  await reset();
  await clickAt(g, rect.x, rect.y);
  await new Promise((r) => setTimeout(r, 500));
  let r3 = await read();
  log(`  用例3 恢复显示: ${JSON.stringify(r3)}  -> ${r3.hits > 0 ? 'OK 点到了' : 'BAD 没点到'}`);

  // ---- 用例 4：宿主整体隐藏（等价"别的智能体的页不露脸"）----
  await win.webContents.executeJavaScript(
    "document.getElementById('webview-wrap').style.display='none'; 'ok'");
  await new Promise((r) => setTimeout(r, 600));
  await reset();
  await clickAt(g, rect.x, rect.y);
  await new Promise((r) => setTimeout(r, 500));
  let r4 = await read();
  log(`  用例4 display:none: ${JSON.stringify(r4)}  -> ${r4.hits > 0 ? 'OK 点到了' : 'BAD 没点到'}`);

  log('');
  log('=== 结论 ===');
  log(`  pointer-events:none 时点击：${r2.hits > 0 ? '仍然有效' : '★ 失效（这就是 bug 根因）'}`);
  log(`  display:none 时点击：${r4.hits > 0 ? '仍然有效' : '★ 失效'}`);

  writeFileSync(path.join(OUT, 'pointer-events-result.json'),
    JSON.stringify({ rect, r1, r2, r3, r4, lines }, null, 2), 'utf8');
  writeFileSync(path.join(OUT, 'pointer-events-run.log'), lines.join('\n'), 'utf8');
  app.exit(0);
}).catch((e) => {
  log('FATAL ' + (e.stack || e.message));
  try { writeFileSync(path.join(OUT, 'pointer-events-run.log'), lines.join('\n'), 'utf8'); } catch (_) {}
  app.exit(1);
});
