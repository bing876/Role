/**
 * 可信结论版：**iframe 边界到底挡不挡人工点击**（用真 http 服务器，不用 data:URL）。
 *
 * 为什么要重写第三次：
 *   前两轮都用 data:URL 装页面，反复踩到
 *     - data:URL 里的引号/转义把页面搞坏（ERR_FAILED）
 *     - 异步 src 没等到就点（读到 about:blank、__h=undefined）
 *   这些**探针自身的错**会被误读成"应用有 bug"——本项目已经因此产生过假证据。
 *   所以这一版起一个**真 http 服务**：同源真实、加载可等待、没有 data:URL 的编码地狱。
 *
 * 变量只有一个：副框架的内容由谁提供。
 *   A. 同源 http  iframe   —— 最常见（广告、评论、站内模块）
 *   B. 跨源 http  iframe   —— 播放器最常见（player.xxx.com）
 * 对每一种，测**真鼠标事件**能不能点中框架里的按钮。
 *
 * 用法：./node_modules/.bin/electron scripts/verify/iframe-click-http.mjs --no-sandbox
 */
import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '..', '..', 'docs', 'acceptance', 'root-cause');
mkdirSync(OUT, { recursive: true });
const lines = [];
const log = (...a) => { const s = a.map(String).join(' '); lines.push(s); console.log(s); };

app.commandLine.appendSwitch('no-sandbox');

const INNER_HTML = (label) => `<!doctype html><html><head><meta charset="utf-8"><title>INNER-${label}</title>
<style>html,body{margin:0;height:100%;background:#dfe}
#wrap{display:flex;align-items:center;justify-content:center;height:100vh}
button{font-size:18px;padding:12px 22px}</style></head>
<body><div id="wrap"><button id="v">PLAY-${label}</button></div>
<script>
window.__ready = 1;
window.__h = 0;
document.getElementById('v').onclick = function(){ window.__h += 1; document.title = 'HITS-' + window.__h; };
</script></body></html>`;

// 两个"域"：127.0.0.1 与 localhost —— 浏览器视为**不同源**（host 不同）
let portA = 0;
let portB = 0;

const startServers = () =>
  new Promise((resolve) => {
    // A 域：127.0.0.1 —— 提供宿主页 + 同源 inner
    const a = createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${portA}`);
      if (u.pathname === '/inner') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-wb-frame': 'same' });
        res.end(INNER_HTML('SAME'));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(hostPage(`http://127.0.0.1:${portA}`, `http://localhost:${portB}`));
    });
    // B 域：localhost —— 只提供跨源 inner
    const b = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-wb-frame': 'cross' });
      res.end(INNER_HTML('CROSS'));
    });
    a.listen(0, '127.0.0.1', () => {
      portA = a.address().port;
      b.listen(0, '127.0.0.1', () => {
        portB = b.address().port;
        resolve({ a, b });
      });
    });
  });

const hostPage = (sameOriginBase, crossOriginBase) => `<!doctype html><html><head><meta charset="utf-8"><title>HOST</title>
<style>html,body{margin:0;padding:0;background:#fff;font:13px system-ui}
.row{margin:10px}
.lbl{font:11px monospace;color:#336}
iframe{display:block;width:380px;height:200px;border:3px solid #333}</style>
</head><body>
<div class="row"><div class="lbl">A. 同源 iframe（127.0.0.1）</div>
  <iframe id="f-same" src="${sameOriginBase}/inner"></iframe></div>
<div class="row"><div class="lbl">B. 跨源 iframe（localhost ← 不同 host = 不同源）</div>
  <iframe id="f-cross" src="${crossOriginBase}/inner"></iframe></div>
<div class="row"><div class="lbl">C. 基线：宿主页自己的按钮</div>
  <button id="v-host" style="font-size:18px;padding:12px 22px">PLAY-HOST</button></div>
<script>
window.__ready = 1; window.__hHost = 0;
document.getElementById('v-host').onclick = function(){ window.__hHost += 1; };
</script></body></html>`;

app.whenReady().then(async () => {
  const { a, b } = await startServers();
  log(`真 http 服务已起：A(宿主+同源)=127.0.0.1:${portA}   B(跨源)=localhost:${portB}`);
  log('');

  const win = new BrowserWindow({ width: 700, height: 800, show: false, webPreferences: { webviewTag: true } });
  win.webContents.debugger.attach('1.3');
  const wc = win.webContents;
  const ev = (js) => wc.executeJavaScript(js);

  // ★ 顺序很重要：必须在 loadURL **之前** 订阅并 enable，否则
  //   executionContextCreated 事件在页面加载时就发完了，事后订阅拿不到任何上下文
  //   （上一版就是这样，frames.length 一直是 0 → 假结论）。
  const frames = [];
  wc.debugger.on('message', (_e, method, params) => {
    if (method === 'Runtime.executionContextCreated') frames.push(params.context);
  });
  try { await wc.debugger.sendCommand('Runtime.enable'); } catch (e) { log('Runtime.enable 失败: ' + e.message); }

  await win.loadURL(`http://127.0.0.1:${portA}/`);
  await new Promise((r) => setTimeout(r, 1800));
  log(`CDP 上下文已收集：RuntimeContext=${frames.filter((c) => c && c.id !== undefined && !c._evt).length}  target 附加=${targets.length}`);
  log('');

  const click = async (x, y) => {
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await new Promise((r) => setTimeout(r, 400));
  };

  const results = {};

  // ---- C. 基线（宿主页自己的按钮）----
  {
    const r = await ev(`(() => { const b=document.getElementById('v-host').getBoundingClientRect();
      return { x: Math.round(b.left+b.width/2), y: Math.round(b.top+b.height/2) }; })()`);
    await click(r.x, r.y);
    const h = await ev('window.__hHost');
    log(`C. 宿主页按钮      → 坐标=(${r.x},${r.y})   hits=${h}  ${h > 0 ? '点得中' : '★ 点不中'}`);
    results.host = h;
  }

  // ---- A. 同源 iframe ----
  {
    const info = await ev(`(() => {
      const f=document.getElementById('f-same'); const r=f.getBoundingClientRect();
      let ready='n/a', hasBtn='n/a';
      try { ready = f.contentDocument.defaultView.__ready === 1 ? 1 : String(f.contentDocument.defaultView.__ready);
            hasBtn = f.contentDocument.getElementById('v') ? 'YES' : 'NO'; } catch(e){ ready='ERR'; }
      return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), ready, hasBtn,
               h: Math.round(r.height) };
    })()`);
    log(`A. 同源 iframe      → 坐标=(${info.x},${info.y})  内部就绪=${info.ready}  有按钮=${info.hasBtn}`);
    if (info.ready === 1) {
      await click(info.x, info.y);
      const h = await ev(`document.getElementById('f-same').contentDocument.defaultView.__h`);
      const t = await ev(`document.getElementById('f-same').contentDocument.title`);
      log(`                    真鼠标点击后 hits=${h}  内部 title=${t}  ${h > 0 ? '**点得中**' : '★ 点不中'}`);
      results.same = h;
    } else {
      log('                    ★ 内容没就绪，跳过（避免假证据）');
      results.same = 'skipped';
    }
  }

  // ---- B. 跨源 iframe（主文档读不到 contentDocument）----
  {
    const info = await ev(`(() => {
      const f=document.getElementById('f-cross'); const r=f.getBoundingClientRect();
      let cd='n/a'; try { cd = f.contentDocument ? 'READABLE' : 'null'; } catch(e){ cd='CROSS-ORIGIN-BLOCKED'; }
      return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), cd };
    })()`);
    log(`B. 跨源 iframe      → 坐标=(${info.x},${info.y})  主文档读 contentDocument = ${info.cd}`);
    await click(info.x, info.y);
    const crossCtxs = frames.filter((c) => c && !c._evt && (c.origin || c.name || '').includes('localhost'));
    let hits = 'unreadable';
    if (crossCtxs.length > 0) {
      for (const c of crossCtxs) {
        try {
          const res = await wc.debugger.sendCommand('Runtime.evaluate', {
            expression: 'window.__h',
            contextId: c.id,
            returnByValue: true,
          });
          if (res?.result?.value !== undefined && res?.result?.value !== null) {
            hits = res.result.value;
            break;
          }
        } catch (e) { /* 试下一个上下文 */ }
      }
    }
    log(`                    真鼠标点击后（从该帧自己的上下文读）hits=${hits}  ${hits > 0 ? '**点得中**' : '（读不到或点不中）'}`);
    log(`                    localhost 执行上下文数 = ${crossCtxs.length}`);
    log(`                    全部 Runtime 上下文 origin 列表 = ${JSON.stringify(frames.filter((c) => c && !c._evt).map((c) => c.origin || c.name || '(unnamed)'))}`);
    results.cross = hits;
  }

  log('');
  log('=== 结论 ===');
  log(`  基线（宿主页按钮）        hits = ${results.host}`);
  log(`  同源 iframe 内按钮        hits = ${results.same}`);
  log(`  跨源 iframe 内按钮        hits = ${results.cross}`);
  log('');
  if (results.same > 0 && results.cross > 0) {
    log('  → **iframe 边界不挡人工点击**：同源、跨源都点得中。');
    log('    "视频点不了"的成因不是 iframe 边界，而是别的东西（主文档遮挡 / 站点自身逻辑）。');
  } else if (results.same > 0 && !(results.cross > 0)) {
    log('  → 同源点得中、跨源存疑 → 需要用 CDP frame 级读取才能下定论。');
  }

  writeFileSync(path.join(OUT, 'iframe-click-http.json'), JSON.stringify({ lines, results }, null, 2), 'utf8');
  writeFileSync(path.join(OUT, 'iframe-click-http.log'), lines.join('\n'), 'utf8');
  a.close(); b.close();
  app.exit(0);
}).catch((e) => {
  log('FATAL ' + (e.stack || e.message));
  try { writeFileSync(path.join(OUT, 'iframe-click-http.log'), lines.join('\n'), 'utf8'); } catch (_) {}
  app.exit(1);
});
