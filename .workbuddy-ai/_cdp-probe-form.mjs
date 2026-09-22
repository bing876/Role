/**
 * 探索：登出 → 回到登录页 → 把登录表单的真实 DOM 结构 dump 出来
 * （输入框数量/占位符、按钮文案），为手机验证码端到端测试做准备。
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

const clickText = async (text) => {
  const rectStr = await ev(`(() => {
    const all = Array.from(document.querySelectorAll('button, a, [role=button], div, span'));
    const hit = all.filter(el => (el.innerText||'').includes(${JSON.stringify(text)}) && el.getBoundingClientRect().width > 0);
    if (!hit.length) return 'NOT_FOUND';
    const el = hit[hit.length-1];
    const r = el.getBoundingClientRect();
    return JSON.stringify({x:r.x+r.width/2, y:r.y+r.height/2, tag:el.tagName});
  })()`);
  if (rectStr === 'NOT_FOUND') return 'NOT_FOUND ' + text;
  const { x, y } = JSON.parse(rectStr);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sleep(120);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(100);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return 'clicked ' + text;
};

console.log('--- 当前是否登录 ---');
console.log(await ev(`JSON.stringify({hasToken: !!localStorage.getItem('workbench.token')})`));

console.log('--- 点「退出登录」---');
console.log(await clickText('退出登录'));
await sleep(3000);

console.log('--- 回到登录页了吗 ---');
console.log(await ev(`JSON.stringify({hasToken: !!localStorage.getItem('workbench.token'), isLoginPage: document.body.innerText.includes('登录 AI 工作台')})`));

console.log('--- 输入框 ---');
console.log(
  await ev(`JSON.stringify(Array.from(document.querySelectorAll('input')).map((i, idx) => ({idx, placeholder: i.placeholder, type: i.type, name: i.name, id: i.id, maxLength: i.maxLength, value: i.value})), null, 1)`),
);

console.log('--- 按钮 ---');
console.log(
  await ev(`JSON.stringify(Array.from(document.querySelectorAll('button')).map((b, idx) => ({idx, text: (b.innerText||'').trim().slice(0,30), disabled: b.disabled})), null, 1)`),
);

ws.close();
process.exit(0);
