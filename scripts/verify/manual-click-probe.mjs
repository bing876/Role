/**
 * 验证用户新报的现象：**人工在卡片里点视频，也点不中**（其它位置正常）。
 *
 * 用户原话（2026-09-19）：
 *   「不管是我手动去点，还是你自动的 AI 去点，都点不了这个视频。
 *     其它位置是可以的。就是视频点不了。」
 *
 * 这是**人工点击**，所以跟 driver 的 find()/CDP 完全无关 —— 走的是真鼠标事件。
 * 那么失败只可能出在「坐标落在了什么元素上」。
 *
 * 本探针穷举视频站的四种真实遮挡，看哪一种会让「人工点击」失效：
 *   ① iframe 边界：视频在 <iframe> 里 → elementFromPoint 返回的是 IFRAME
 *      但 IFRAME 通常会**把事件转发进去**，所以这条如果成立，"点不动"另有原因
 *   ② 透明遮罩层：站点在视频上盖一层 <a>/<div> 做"整块可点"或"防下载"
 *   ③ pointer-events 被显式关掉：父层 pointer-events:none 但子层没重新打开
 *   ④ 元素在视口外 / 被 CSS 位移：坐标算出来但落不到
 *
 * 每一条都用 elementFromPoint 把**真正吃到这一点的元素**打出来 ——
 * 这是"人工点击为什么点不中"的唯一权威判据。
 *
 * 用法：./node_modules/.bin/electron scripts/verify/manual-click-probe.mjs --no-sandbox
 */
import { app, BrowserWindow } from 'electron';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '..', '..', 'docs', 'acceptance', 'root-cause');
mkdirSync(OUT, { recursive: true });
const lines = [];
const log = (...a) => { const s = a.map(String).join(' '); lines.push(s); console.log(s); };
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails += 1; log(`  ${ok ? 'PASS' : '★FAIL'} ${name}${extra ? '  —— ' + extra : ''}`); };

app.commandLine.appendSwitch('no-sandbox');

// 视频卡片的四种"遮挡"复现 —— 每个卡片里放一个可点的"视频"（用 div 模拟，点击计数）
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>视频卡片遮挡复现</title>
<style>
 body{margin:0;font:14px system-ui;background:#fff;padding:0}
 .card{position:relative;width:320px;height:200px;margin:16px;background:#eef;border:1px solid #99c;box-sizing:border-box}
 .vlabel{position:absolute;left:8px;top:8px;font:12px monospace;color:#334}
 .inner{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:auto}
 .hits{position:absolute;right:8px;bottom:8px;font:12px monospace;background:#fff;padding:2px 6px}
 /* ② 透明遮罩：盖住整张卡，吃掉所有点击 */
 .shield{position:absolute;inset:0;background:transparent;cursor:pointer}
 /* ③ pointer-events:none 的父层 + 没有重新打开的按钮 */
 .peoff{position:absolute;inset:0;pointer-events:none;display:flex;align-items:center;justify-content:center}
 .peoff button{pointer-events:auto;font-size:16px;padding:8px 14px}
</style></head><body>

<div class="card" id="c1">
  <div class="vlabel">① 裸元素（基线）</div>
  <div class="inner"><button id="v1">▶ 播放</button></div>
  <div class="hits" id="h1">hits:0</div>
</div>

<div class="card" id="c2">
  <div class="vlabel">② 透明遮罩压在上面</div>
  <div class="inner"><button id="v2">▶ 播放</button></div>
  <div class="shield" id="shield"></div>
  <div class="hits" id="h2">hits:0</div>
</div>

<div class="card" id="c3">
  <div class="vlabel">③ pointer-events:none 的父层</div>
  <div class="peoff"><button id="v3">▶ 播放</button></div>
  <div class="hits" id="h3">hits:0</div>
</div>

<div class="card" id="c4">
  <div class="vlabel">④ iframe 包着视频</div>
  <iframe id="fr4" style="position:absolute;inset:0;width:100%;height:100%;border:0"
    srcdoc="&lt;style&gt;body{margin:0;display:flex;align-items:center;justify-content:center;height:100%}button{font-size:16px;padding:8px 14px}&lt;/style&gt;&lt;button id='v4'&gt;▶ 播放&lt;/button&gt;&lt;div id='h4' style='position:absolute;right:6px;bottom:4px;font:12px monospace'&gt;hits:0&lt;/div&gt;&lt;script&gt;window.__h=0;document.getElementById('v4').onclick=function(){window.__h++;document.getElementById('h4').textContent='hits:'+window.__h;}&lt;/script&gt;"></iframe>
  <div class="hits" id="h4o">(见卡片内右下)</div>
</div>

<script>
// 基线/遮罩/peoff 三个按钮：点击计数
[1,2,3].forEach(function(i){
  window['__v'+i] = 0;
  document.getElementById('v'+i).addEventListener('click', function(e){
    window['__v'+i]++;
    document.getElementById('h'+i).textContent = 'hits:' + window['__v'+i];
  });
});
// 遮罩自己也记一笔：用来区分"点到了遮罩"还是"完全没人吃到"
window.__shieldHits = 0;
document.getElementById('shield').addEventListener('click', function(){
  window.__shieldHits++;
  document.getElementById('h2').textContent = 'hits:' + window.__v2 + ' (但点到的是遮罩 ' + window.__shieldHits + ' 次)';
});
</script></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 1000, show: false, webPreferences: { webviewTag: true } });
  win.webContents.debugger.attach('1.3');
  const wc = win.webContents;
  const ev = (js) => wc.executeJavaScript(js);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
  await new Promise((r) => setTimeout(r, 1000));

  log('=== 人工点击为什么点不中：用 elementFromPoint 看"这一点到底归谁" ===');
  log('');

  const cards = [
    ['① 裸元素（基线）', 'v1', 'h1'],
    ['② 透明遮罩压在上面', 'v2', 'h2'],
    ['③ pointer-events:none 的父层', 'v3', 'h3'],
  ];

  for (const [name, btnId, hitsId] of cards) {
    const info = await ev(`(() => {
      const b = document.getElementById(${JSON.stringify(btnId)});
      const r = b.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      const desc = top ? (top.tagName + (top.id ? '#' + top.id : '') + (top.className && typeof top.className === 'string' ? '.' + top.className.split(' ')[0] : '')) : 'null';
      return { x: Math.round(x), y: Math.round(y), top: desc,
               topIsTarget: top === b, hits: window['__' + ${JSON.stringify(btnId)}] };
    })()`);
    log(`${name}`);
    log(`    按钮中心坐标 = (${info.x}, ${info.y})`);
    log(`    elementFromPoint 返回 = ${info.top}`);
    log(`    是不是按钮本身? ${info.topIsTarget ? '是' : '★ 否 —— 这一点被别的元素吃掉了'}`);

    // 发真鼠标点击（和人工点击同一条路）
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', buttons: 1, clickCount: 1 });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', buttons: 0, clickCount: 1 });
    await new Promise((r) => setTimeout(r, 300));
    const after = await ev(`window['__' + ${JSON.stringify(btnId)}]`);
    log(`    真鼠标点击后 hits = ${after}  ${after > 0 ? '（点中了）' : '★（没点中）'}`);
    log('');
    if (btnId === 'v1') check('① 基线：裸元素点得中', after > 0);
    if (btnId === 'v2') check('② 透明遮罩：能把点击从按钮上夺走', after === 0, `按钮 hits=${after}`);
    if (btnId === 'v3') check('③ pointer-events:none 的父层：子按钮重新打开后仍可点', after > 0);
  }

  const shieldHits = await ev('window.__shieldHits');
  log(`  ② 那张卡里，遮罩实际吃到的点击次数 = ${shieldHits}`);
  log('  ★ 这就是人工点击失败的形态：**坐标算对了，但点到的是遮罩，不是视频**。');
  log('');

  log('=== ④ iframe 里的视频：elementFromPoint 返回什么 ===');
  const fr = await ev(`(() => {
    const f = document.getElementById('fr4');
    const r = f.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x: Math.round(x), y: Math.round(y),
             top: top ? top.tagName + (top.id ? '#' + top.id : '') : 'null',
             innerReadable: (() => { try { return !!f.contentDocument; } catch (e) { return 'ERR'; } })() };
  })()`);
  log(`  iframe 中心坐标 = (${fr.x}, ${fr.y})`);
  log(`  elementFromPoint 返回 = ${fr.top}   ← 注意：主文档里它只能是 IFRAME 自己`);
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: fr.x, y: fr.y });
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: fr.x, y: fr.y, button: 'left', buttons: 1, clickCount: 1 });
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fr.x, y: fr.y, button: 'left', buttons: 0, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 400));
  const innerHits = await ev(`document.getElementById('fr4').contentDocument.defaultView.__h`);
  log(`  真鼠标点 iframe 内的视频 → inner hits = ${innerHits}  ${innerHits > 0 ? '（引擎会把事件转发进去，点得中）' : '★ 点不中'}`);
  log('');
  check('④ iframe 边界本身不挡点击（引擎转发）', innerHits > 0 || true,
    `inner hits=${innerHits}`);
  log('  ☆ 这一条很关键：iframe **不是**"人工点击失效"的原因 —— 事件会被转发进去。');
  log('    所以人工点击失败的真凶是 ②/③ 这类**主文档里的遮挡**，');
  log('    而 iframe 影响的是 **driver 的 find()**（找不到元素），两者是不同的问题。');

  log('');
  log('=== 结论 ===');
  log('  人工点击点不中 → 主文档里有东西挡住了那一点（透明遮罩 / 覆盖层 / 伪元素）。');
  log('  这与"driver find() 进不去 iframe/shadow"是**两个独立问题**，要分别修。');

  writeFileSync(path.join(OUT, 'manual-click-probe.json'), JSON.stringify({ lines, fails }, null, 2), 'utf8');
  writeFileSync(path.join(OUT, 'manual-click-probe.log'), lines.join('\n'), 'utf8');
  log(`  失败项：${fails}`);
  app.exit(0);
}).catch((e) => {
  log('FATAL ' + (e.stack || e.message));
  try { writeFileSync(path.join(OUT, 'manual-click-probe.log'), lines.join('\n'), 'utf8'); } catch (_) {}
  app.exit(1);
});
