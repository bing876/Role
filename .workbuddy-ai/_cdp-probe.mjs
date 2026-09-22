/**
 * 用 CDP 直接进安装版工作台的渲染层，读「登录能不能通」的唯一真相：
 *   1) window.workbench.isElectron 是不是 true（决定 API_BASE 算不算得出 127.0.0.1:8787）
 *   2) 在页面上下文里真发一次 fetch('/health') 等价请求，看会不会失败
 *   3) 登录页现在的真实文案（还会不会显示「正在准备后端」）
 */
const PORT = 9222;

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) {
  console.log('NO_PAGE_TARGET');
  console.log(JSON.stringify(list, null, 1));
  process.exit(1);
}
console.log('target:', page.title, '|', page.url);

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
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) return 'EXC: ' + JSON.stringify(r.result.exceptionDetails);
  return r.result?.result?.value;
};

console.log('--- 1) 桥与后端地址 ---');
console.log(
  await ev(
    `JSON.stringify({hasBridge: !!window.workbench, isElectron: window.workbench && window.workbench.isElectron, apiBaseStored: localStorage.getItem('workbench.apiBase')})`,
  ),
);

console.log('--- 2) 页面上下文实测 fetch ---');
console.log(
  await ev(
    `(async () => { const base = localStorage.getItem('workbench.apiBase') || (window.workbench && window.workbench.isElectron ? 'http://127.0.0.1:8787' : ''); try { const r = await fetch(base + '/health', {signal: AbortSignal.timeout(5000)}); return 'base=[' + base + '] OK ' + (await r.text()).slice(0, 90); } catch (e) { return 'base=[' + base + '] FAIL ' + e.message; } })()`,
  ),
);

console.log('--- 3) 登录页真实文案 ---');
console.log(await ev(`document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 400)`));

ws.close();
process.exit(0);
