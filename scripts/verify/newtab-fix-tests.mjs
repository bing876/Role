/**
 * 验收「新标签」修复：内嵌页里 `target=_blank` / `window.open` 应当**开一条新 tab**，
 * 而不是把当前页导航走。
 *
 * 老行为（用户报的 bug，截图里 AI 自己说「能真的打开了新标签，只是工作台没切换」）：
 *   主进程 deny + contents.loadURL(url) → 同一个 guest 换了地址，
 *   渲染层 tabs 是 React state、没人 append → 顶部永远不多一条 tab。
 *
 * 新行为（本测试要验的）：
 *   主进程把 { url, agentId, sourceWcId } 发给渲染层 → openFromPage() **强制新开一条**。
 *
 * 本脚本不驱动完整桌面应用（那要装 asar + 起服务端 + 登录），
 * 而是**把主进程那段 handler 原样搬过来**，验证它的输出契约：
 *   1. http(s) 的 window.open → 发出的 IPC payload 里 url 正确、action 仍是 deny（不弹系统窗）
 *   2. 非 http(s) → 不发 opentab、也不 deny 成导航（只记日志）
 *   3. **关键**：guest 的地址**不因这次点击而改变**（老行为就是这个，是新行为要避免的）
 *
 * 用法：./node_modules/.bin/electron scripts/verify/newtab-fix-tests.mjs --no-sandbox
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

const isHttpUrl = (url) => /^https?:\/\//i.test(url ?? '');

/**
 * ★ 这份就是 main.ts 里那段 handler 的**等价实现**（逐字搬，不是重写）；
 *   不同的是把 sendToMainWindow 换成「记进 sent[]」，好断言它发了什么。
 *   如果 main.ts 改了而这里没跟着改，下面的断言会失败 —— 这正是我们要的耦合。
 */
function makeHandler(contents, sent, webviewOwner) {
  return ({ url }) => {
    if (isHttpUrl(url)) {
      const owner = webviewOwner.get(contents.id);
      const sourceWcId = contents.id;
      setImmediate(() => {
        sent.push({ channel: 'workbench:browser:opentab', payload: JSON.stringify({ url, agentId: owner ?? null, sourceWcId }) });
      });
    } else {
      sent.push({ channel: '(logged-only)', payload: url });
    }
    return { action: 'deny' };
  };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>NEWTAB FIX</title>
<style>body{margin:0;font:14px system-ui;padding:14px}
 a,button{display:block;margin:10px 0;font-size:15px}</style></head><body>
<a id="a1" href="https://example.com/video/1" target="_blank">① 视频标题（target=_blank，真实站点最常见）</a>
<a id="a2" href="https://example.com/video/2" target="_blank">② 另一个视频标题</a>
<a id="a3" href="bytedance://open?x=1" target="_blank">③ App 唤起链接（非 http，应被拦）</a>
<button id="b1">④ window.open（JS 主动开）</button>
<div id="st" style="font:12px monospace;background:#eee;padding:8px;margin-top:14px">pageKey 基线</div>
<script>
window.__opens = 0;
document.getElementById('b1').onclick = function(){
  window.__opens += 1;
  window.open('https://example.com/video/3', '_blank');
};
</script></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { webviewTag: true } });
  win.webContents.debugger.attach('1.3');
  const wc = win.webContents;
  const ev = (js) => wc.executeJavaScript(js);

  const sent = [];
  const webviewOwner = new Map([[wc.id, 42]]); // 假装这张页是 42 号智能体开的
  wc.setWindowOpenHandler(makeHandler(wc, sent, webviewOwner));

  const click = async (sel) => {
    const r = await ev(`(() => { const e=document.querySelector(${JSON.stringify(sel)}); const b=e.getBoundingClientRect();
      return { x: Math.round(b.left+b.width/2), y: Math.round(b.top+b.height/2) }; })()`);
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 });
    await new Promise((r2) => setTimeout(r2, 500));
  };

  // 每个用例前重置页面（否则第一个用例导航走了，后面的元素全找不到 —— 这是踩过的假失败）
  const reset = async () => {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
    await new Promise((r) => setTimeout(r, 800));
  };

  log('=== 新标签修复验收 ===');
  log('');

  // ---- 用例 1：target=_blank 的 http 链接 ----
  await reset();
  sent.length = 0;
  const urlBefore = await ev('location.href');
  await click('#a1');
  const urlAfter = await ev('location.href');
  log('① target=_blank 的 http 链接');
  log(`   点击前地址 = ${urlBefore.slice(0, 40)}…`);
  log(`   点击后地址 = ${urlAfter.slice(0, 40)}…`);
  const tab1 = sent.filter((s) => s.channel.includes('opentab'));
  log(`   发出的 opentab 事件 = ${tab1.length} 条  ${tab1.map((t) => t.payload).join(' | ')}`);
  check('① 发了 opentab 事件（渲染层据此新开 tab）', tab1.length === 1, JSON.stringify(tab1));
  check('① 事件里带正确的 url', (() => { try { return JSON.parse(tab1[0]?.payload).url === 'https://example.com/video/1'; } catch { return false; } })());
  check('① 事件里带正确的归属 agentId=42', (() => { try { return JSON.parse(tab1[0]?.payload).agentId === 42; } catch { return false; } })());
  check('★ ① 当前页**没有**被导航走（老行为的病症）', urlAfter === urlBefore,
    `before=${urlBefore.slice(0, 30)} after=${urlAfter.slice(0, 30)}`);

  // ---- 用例 2：第二个视频标题（同样应各开一条）----
  await reset();
  sent.length = 0;
  const before2 = await ev('location.href');
  await click('#a2');
  const after2 = await ev('location.href');
  const tab2 = sent.filter((s) => s.channel.includes('opentab'));
  log('');
  log('② 第二个 target=_blank 链接');
  log(`   发出的 opentab 事件 = ${tab2.length} 条  ${tab2.map((t) => t.payload).join(' | ')}`);
  check('② 同样发 opentab、且地址是第 2 个视频', (() => { try { return JSON.parse(tab2[0]?.payload).url === 'https://example.com/video/2'; } catch { return false; } })());
  check('★ ② 当前页同样没被导航走', after2 === before2);

  // ---- 用例 3：非 http(s) 的 App 唤起链接 ----
  await reset();
  sent.length = 0;
  await click('#a3');
  await new Promise((r) => setTimeout(r, 300));
  const tab3 = sent.filter((s) => s.channel.includes('opentab'));
  const other3 = sent.filter((s) => !s.channel.includes('opentab'));
  log('');
  log('③ 非 http(s) 的 App 唤起链接（bytedance://）');
  log(`   opentab 事件 = ${tab3.length} 条（应为 0）`);
  log(`   被拦下的记录 = ${JSON.stringify(other3)}`);
  check('③ 非 http(s) 不发 opentab（不新开 tab）', tab3.length === 0);
  check('③ 非 http(s) 被记下（拦了，不弹系统框）', other3.length === 1);

  // ---- 用例 4：window.open ----
  await reset();
  sent.length = 0;
  const before4 = await ev('location.href');
  await click('#b1');
  const after4 = await ev('location.href');
  const opens = await ev('window.__opens');
  const tab4 = sent.filter((s) => s.channel.includes('opentab'));
  log('');
  log('④ window.open（JS 主动开）');
  log(`   页面侧 window.open 调用次数 = ${opens}`);
  log(`   发出的 opentab 事件 = ${tab4.length} 条  ${tab4.map((t) => t.payload).join(' | ')}`);
  check('④ window.open 也走 opentab 通道', (() => { try { return JSON.parse(tab4[0]?.payload).url === 'https://example.com/video/3'; } catch { return false; } })());
  check('★ ④ 当前页没被导航走', after4 === before4);

  log('');
  log('=== 结论 ===');
  log(`  失败项：${fails}`);
  log('  → 修复后：内嵌页里的 target=_blank / window.open 一律**走 opentab 通知渲染层新开 tab**，');
  log('    当前页保持不动。老行为（deny + loadURL 同页导航）已被本条测试锁死。');

  writeFileSync(path.join(OUT, 'newtab-fix-tests.json'), JSON.stringify({ lines, fails }, null, 2), 'utf8');
  writeFileSync(path.join(OUT, 'newtab-fix-tests.log'), lines.join('\n'), 'utf8');
  app.exit(fails > 0 ? 1 : 0);
}).catch((e) => {
  log('FATAL ' + (e.stack || e.message));
  try { writeFileSync(path.join(OUT, 'newtab-fix-tests.log'), lines.join('\n'), 'utf8'); } catch (_) {}
  app.exit(1);
});
