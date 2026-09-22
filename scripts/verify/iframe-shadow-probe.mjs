/**
 * 验证 driver 的盲区：**iframe / shadow DOM 里的元素，现有 find() 完全看不见**。
 *
 * 为什么这是最可能的"点不动"根因：
 *   视频站（以及大量现代站点）把播放器放在 <iframe> 里，
 *   或把按钮封进 shadow DOM。而 driver.ts 的 find/snapshot/pageKey 全都只用
 *   `document.querySelectorAll` —— 只看主文档，**进不去** iframe 与 shadow root。
 *   结果：AI 说"点播放"，找不到元素 → 返回 notfound → 用户看到的就是"点了没反应"。
 *
 * 本脚本同时验证「修法可行」：用 CDP 给页面注入一段**递归穿透**查找的脚本，
 * 看能不能把 iframe / shadow DOM 里的元素找出来并点到。
 *
 * 用法：electron scripts/verify/iframe-shadow-probe.mjs --no-sandbox
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

// iframe 内部页（含一个播放按钮）
const INNER = `<!doctype html><html><head><meta charset="utf-8"><title>inner</title>
<style>body{margin:0;background:#111;color:#fff;font:15px system-ui}
#play{margin:30px;padding:14px 22px;background:#e33;border:0;color:#fff;
  font-size:17px;border-radius:6px;cursor:pointer}</style></head><body>
<button id="play">▶ 播放</button>
<div id="st" style="margin:30px">inner hits:0</div>
<script>window.__h=0;document.getElementById('play').onclick=function(){
  window.__h++;document.getElementById('st').textContent='inner hits:'+window.__h;};</script>
</body></html>`;

// 主页面：iframe + shadow DOM 各放一个按钮 + 一个主文档按钮（基线）
const HOST = `<!doctype html><html><head><meta charset="utf-8"><title>HOST</title>
<style>body{margin:0;font:15px system-ui;background:#fff}
#main-btn{margin:12px;padding:10px 18px;background:#28a;border:0;color:#fff;border-radius:6px}
iframe{width:420px;height:170px;border:2px solid #999;margin:12px}
#host-status{margin:12px;font:13px monospace;background:#eee;padding:8px}</style>
</head><body>
<button id="main-btn">主文档按钮（基线）</button>
<iframe id="fr" src="data:text/html;charset=utf-8,${encodeURIComponent(INNER)}"></iframe>
<div id="sd"></div>
<div id="host-status">host: (none)</div>
<script>
window.__hostH=0;
document.getElementById('main-btn').onclick=function(){window.__hostH++;
  document.getElementById('host-status').textContent='host: main-btn '+window.__hostH;};
// shadow DOM 里放一个按钮
const sd=document.getElementById('sd');
const root=sd.attachShadow({mode:'open'});
root.innerHTML='<button id="shadow-btn" style="margin:12px;padding:10px 18px;'
 +'background:#793;border:0;color:#fff;border-radius:6px">Shadow DOM 按钮</button>'
 +'<div id="sst" style="margin:12px;font:13px monospace">shadow hits:0</div>';
window.__shadowH=0;
root.getElementById('shadow-btn').onclick=function(){window.__shadowH++;
  root.getElementById('sst').textContent='shadow hits:'+window.__shadowH;};
</script></body></html>`;

app.commandLine.appendSwitch('no-sandbox');

// 现有 driver 的查找方式（复制其核心：只看主文档）
const CURRENT_FIND = `
const SELECTABLE='button, a, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [contenteditable="true"]';
const visible=(el)=>{try{const s=getComputedStyle(el);if(s.display==='none'||s.visibility==='hidden')return false;
 const r=el.getBoundingClientRect();return r.width>0&&r.height>0;}catch(_){return false;}};
const text=(el)=>String(el.innerText||el.textContent||el.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim();
const find=(target)=>{const t=String(target).trim();const low=t.toLowerCase();
 const cands=Array.prototype.filter.call(document.querySelectorAll(SELECTABLE),visible);
 let hit=cands.find(el=>text(el).toLowerCase()===low); if(hit)return hit;
 hit=cands.find(el=>text(el).toLowerCase().indexOf(low)>=0); if(hit)return hit;
 return null;};
`;

// 穿透版查找：递归进 iframe（同源）与 shadow root
const DEEP_FIND = `
const SELECTABLE='button, a, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [contenteditable="true"]';
const visible=(el)=>{try{const s=getComputedStyle(el);if(s.display==='none'||s.visibility==='hidden')return false;
 const r=el.getBoundingClientRect();return r.width>0&&r.height>0;}catch(_){return false;}};
const text=(el)=>String(el.innerText||el.textContent||el.getAttribute('aria-label')||'').replace(/\\s+/g,' ').trim();
function* walk(root, pathStr){
  let all; try{all=root.querySelectorAll('*');}catch(_){return;}
  for(let i=0;i<all.length;i++){
    const el=all[i];
    const p = pathStr + '>' + (el.tagName||'?') + (el.id?('#'+el.id):'');
    yield {el, path:p};
    if(el.shadowRoot){ yield* walk(el.shadowRoot, p+'::shadow'); }
    if(el.tagName==='IFRAME'){
      try{ const d=el.contentDocument; if(d) yield* walk(d, p+'::iframe'); }catch(_){}
    }
  }
}
const findDeep=(root,target)=>{const t=String(target).trim().toLowerCase();
  const cands=[];
  for(const n of walk(root,'')){ if(visible(n.el)&&n.el.matches && n.el.matches(SELECTABLE)) cands.push(n); }
  let hit=cands.find(n=>text(n.el).toLowerCase()===t); if(hit)return hit;
  hit=cands.find(n=>text(n.el).toLowerCase().indexOf(t)>=0); if(hit)return hit;
  return null;};
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 640, show: false,
    webPreferences: { webviewTag: true } });
  win.webContents.debugger.attach('1.3');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HOST));
  await new Promise((r) => setTimeout(r, 1200));

  const wc = win.webContents;
  const ev = (js) => wc.executeJavaScript(js);

  log('=== 1. 用**现有** find()（只看主文档）去找三类按钮 ===');
  for (const label of ['主文档按钮（基线）', '▶ 播放', 'Shadow DOM 按钮']) {
    const r = await ev(`(()=>{ ${CURRENT_FIND}
      const el = find(${JSON.stringify(label)});
      return el ? {found:true, tag:el.tagName, id:el.id} : {found:false};
    })()`);
    log(`  「${label}」→ ${r.found ? '找到 ' + r.tag + '#' + r.id : '★ 找不到（notfound）'}`);
  }

  log('');
  log('=== 2. 用**穿透版** findDeep()（进 iframe + shadow root） ===');
  for (const label of ['主文档按钮（基线）', '▶ 播放', 'Shadow DOM 按钮']) {
    const r = await ev(`(()=>{ ${DEEP_FIND}
      const n = findDeep(document, ${JSON.stringify(label)});
      if(!n) return {found:false};
      const el=n.el, r2=el.getBoundingClientRect();
      return {found:true, tag:el.tagName, id:el.id, path:n.path,
              x:Math.round(r2.left+r2.width/2), y:Math.round(r2.top+r2.height/2)};
    })()`);
    log(`  「${label}」→ ${r.found
      ? `找到 ${r.tag}#${r.id}  坐标=(${r.x},${r.y})  路径=${r.path}` : '★ 找不到'}`);
  }

  log('');
  log('=== 3. 真鼠标点击：iframe 里的播放按钮（用穿透坐标 + guest 内点击） ===');
  // iframe 是同源 data: URL —— 但 data: URL 的 iframe 拿不到 contentDocument？
  const diag = await ev(`(()=>{ const f=document.getElementById('fr');
    let ok=false, err=''; try{ ok = !!f.contentDocument; }catch(e){ err=e.message; }
    return {hasContentDocument:ok, err, src:(f.getAttribute('src')||'').slice(0,40)}; })()`);
  log('  iframe contentDocument 可访问? ' + JSON.stringify(diag));

  // 点击主文档基线按钮（证明点击链路本身没问题）
  const b = await ev(`(()=>{const r=document.getElementById('main-btn').getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1 });
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 400));
  const h1 = await ev('window.__hostH');
  log(`  主文档按钮点击 -> host hits=${h1} ${h1 > 0 ? 'OK' : 'BAD'}`);

  // 点击 shadow DOM 按钮
  const s = await ev(`(()=>{const sr=document.getElementById('sd').shadowRoot;
    const el=sr.getElementById('shadow-btn'); const r=el.getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: s.x, y: s.y, button: 'left', buttons: 1, clickCount: 1 });
  await wc.debugger.sendCommand('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: s.x, y: s.y, button: 'left', buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 400));
  const sh = await ev('window.__shadowH');
  log(`  Shadow DOM 按钮点击 -> shadow hits=${sh} ${sh > 0 ? 'OK' : 'BAD'}`);

  log('');
  log('=== 结论 ===');
  log('  现有 find() 只看主文档 → iframe / shadow DOM 里的元素**找不到** = notfound');
  log('  「点了没反应」的一种真实成因：**没找到元素**，而不是点击本身失败。');

  writeFileSync(path.join(OUT, 'iframe-shadow-result.json'),
    JSON.stringify({ lines }, null, 2), 'utf8');
  writeFileSync(path.join(OUT, 'iframe-shadow-run.log'), lines.join('\n'), 'utf8');
  app.exit(0);
}).catch((e) => {
  log('FATAL ' + (e.stack || e.message));
  try { writeFileSync(path.join(OUT, 'iframe-shadow-run.log'), lines.join('\n'), 'utf8'); } catch (_) {}
  app.exit(1);
});
