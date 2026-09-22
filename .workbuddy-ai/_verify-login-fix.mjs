/**
 * 验证 isElectron 登录修复在「真实安装版」里是否真的生效。
 * 判据全部取自页面运行时状态，不看源码。
 */
const PORT = 9222;

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) {
  console.log('!! 没找到 page target');
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
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
  if (r.result?.exceptionDetails) return 'EXC: ' + r.result.exceptionDetails.text;
  return r.result?.result?.value;
};

// 页面刚起来时 innerText 可能是空串，轮询等它渲染
let text = '';
for (let i = 0; i < 30; i++) {
  text = (await ev('document.body.innerText')) || '';
  if (text.trim().length > 20) break;
  await new Promise((r) => setTimeout(r, 500));
}

console.log('=== 1) 桥接对象 ===');
console.log('  window.workbench 存在      =', await ev('!!window.workbench'));
console.log('  isElectron                 =', await ev('window.workbench && window.workbench.isElectron'));
console.log('  platform                   =', await ev('window.workbench && window.workbench.platform'));

console.log('=== 2) 后端地址判定（关键）===');
console.log(
  '  页面内 fetch /health       =',
  await ev(
    `fetch('http://127.0.0.1:8787/health').then(r=>r.text()).then(t=>t.slice(0,140)).catch(e=>'ERR '+e.message)`,
  ),
);

console.log('=== 3) 界面文案（用户可见）===');
console.log('  含「正在准备后端」          =', text.includes('正在准备后端'));
console.log('  含「登录 AI 工作台」        =', text.includes('登录 AI 工作台'));
console.log('  含「快捷登录」              =', text.includes('快捷登录'));
console.log('  页面文案（前 400 字）       =');
console.log('   ', text.replace(/\n+/g, ' | ').slice(0, 400));

console.log('=== 4) 起始页 URL ===');
console.log('  ', await ev('location.href'));

ws.close();
process.exit(0);
