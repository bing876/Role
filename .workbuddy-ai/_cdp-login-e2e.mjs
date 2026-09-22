/**
 * 端到端：在真实安装版里点「⚡ 快捷登录：一键演示账号进入」，验证登录门控真的放行。
 * 用完整鼠标序列（mouseMoved -> mousePressed -> mouseReleased），因为 React 合成事件
 * 不认 element.click()。
 */
const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id != null && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return 'EXC: ' + JSON.stringify(r.result.exceptionDetails);
  return r.result?.result?.value;
};

// 1) 找到「快捷登录」按钮并拿它的视口坐标
const rectStr = await ev(`(() => {
  const all = Array.from(document.querySelectorAll('button, a, div, span'));
  const hit = all.filter(el => (el.innerText || '').includes('快捷登录'));
  if (!hit.length) return 'NOT_FOUND';
  const el = hit[hit.length - 1];
  const r = el.getBoundingClientRect();
  return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height, tag: el.tagName});
})()`);
console.log('快捷登录按钮:', rectStr);
if (rectStr === 'NOT_FOUND') {
  console.log('!! 没找到快捷登录按钮，登录页文案：');
  console.log(await ev(`document.body.innerText.replace(/\\n+/g,' | ').slice(0,300)`));
  process.exit(1);
}
const rect = JSON.parse(rectStr);

// 2) 完整鼠标序列点击
const pt = { x: rect.x, y: rect.y };
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pt, button: 'none' });
await sleep(150);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pt, button: 'left', clickCount: 1 });
await sleep(120);
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pt, button: 'left', clickCount: 1 });

// 3) 等登录流程走完，看登录门是否消失
await sleep(6000);
const after = await ev(`document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 500)`);
console.log('--- 点击 6 秒后的页面文案 ---');
console.log(after);
console.log('--- 是否已登录（localStorage 里有 token）---');
console.log(await ev(`JSON.stringify({hasToken: !!localStorage.getItem('workbench.token'), tokenLen: (localStorage.getItem('workbench.token')||'').length})`));
console.log('--- 登录门是否还在 ---');
console.log(await ev(`JSON.stringify({stillLoginGate: document.body.innerText.includes('登录 AI 工作台')})`));

ws.close();
process.exit(0);
