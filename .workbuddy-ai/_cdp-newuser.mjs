/**
 * 边界：未注册手机号「自动建号」这条路径
 *   A) 全新手机号 → 发码 → 登录 → 新号应该是「密码：未设置」（若显示"已设置"则是可疑行为）
 *   B) 顺带点「微信」tab，确认不白屏 / 不崩溃（未接支付时最容易留空壳）
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
const setValue = (idx, val) =>
  ev(`(() => { const el = document.querySelectorAll('input')[${idx}];
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    s.call(el, ${JSON.stringify(val)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`);
const clickText = async (text) => {
  const r = await ev(`(() => { const all = Array.from(document.querySelectorAll('button, a, [role=button]'));
    const hit = all.filter(el => (el.innerText||'').includes(${JSON.stringify(text)}) && el.getBoundingClientRect().width>0);
    if (!hit.length) return 'NOT_FOUND'; const el = hit[hit.length-1]; const b = el.getBoundingClientRect();
    return JSON.stringify({x:b.x+b.width/2, y:b.y+b.height/2}); })()`);
  if (r === 'NOT_FOUND') return false;
  const { x, y } = JSON.parse(r);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sleep(120);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(100);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return true;
};
const pageText = () => ev(`document.body.innerText.replace(/\\n+/g,' | ')`);

// A) 先登出
if (!(await ev(`document.body.innerText.includes('登录 AI 工作台')`))) {
  await clickText('退出登录');
  await sleep(3000);
}
await clickText('手机验证码');
await sleep(800);

const NEW_PHONE = '1390000000' + String(Math.floor(Math.random() * 9) + 1); // 每次不同，避开重发限制
console.log('新手机号:', NEW_PHONE);
await setValue(0, NEW_PHONE);
await sleep(600);
await clickText('获取验证码');
await sleep(4500);
let t = await pageText();
const m = t.match(/本次验证码[：: ]*(\d{6})/);
console.log('拿到码:', m ? m[1] : t.slice(0, 220));
if (!m) {
  console.log('!! 没拿到验证码，放弃');
  process.exit(1);
}
await setValue(1, m[1]);
await sleep(500);
await clickText('登录 / 注册');
await sleep(5000);
const after = await pageText();
console.log('--- 新号登录后（看「我的号」与「密码」）---');
console.log(after.slice(0, 320));
console.log('--- 是否已登录 ---');
console.log(await ev(`JSON.stringify({hasToken: !!localStorage.getItem('workbench.token')})`));

// B) 微信 tab（登出后测，避免状态耦合）
await clickText('退出登录');
await sleep(3000);
console.log('--- 点「微信」tab ---');
await clickText('微信');
await sleep(2500);
console.log(await pageText());
console.log('--- 是否崩溃（登录门还在 = 没白屏）---');
console.log(await ev(`JSON.stringify({alive: document.body.innerText.includes('登录 AI 工作台'), len: document.body.innerText.length})`));

ws.close();
process.exit(0);
