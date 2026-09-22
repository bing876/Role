/**
 * 边界：XYZ号+密码 登录
 *   A) 未设置密码的新号 → 界面文案承诺「会明确失败」，验证：给出清晰错误 + 不登录
 *   B) 密码错误 → 同上
 */
const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) return 'EXC ' + JSON.stringify(r.result.exceptionDetails); return r.result?.result?.value; };
const setValue = (idx, val) => ev(`(() => { const el = document.querySelectorAll('input')[${idx}];
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  s.call(el, ${JSON.stringify(val)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`);
const clickText = async (text) => {
  const r = await ev(`(() => { const all = Array.from(document.querySelectorAll('button, a, [role=button]'));
    const hit = all.filter(el => (el.innerText||'').includes(${JSON.stringify(text)}) && el.getBoundingClientRect().width>0);
    if (!hit.length) return 'NOT_FOUND'; const el = hit[hit.length-1]; const b = el.getBoundingClientRect();
    return JSON.stringify({x:b.x+b.width/2, y:b.y+b.height/2}); })()`);
  if (r === 'NOT_FOUND') return false;
  const { x, y } = JSON.parse(r);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }); await sleep(120);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await sleep(100);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return true;
};
const pageText = () => ev(`document.body.innerText.replace(/\\n+/g,' | ')`);

if (!(await ev(`document.body.innerText.includes('登录 AI 工作台')`))) { await clickText('退出登录'); await sleep(3000); }
await clickText('XYZ号+密码');
await sleep(1000);
console.log('--- XYZ 登录页输入框 ---');
console.log(await ev(`JSON.stringify(Array.from(document.querySelectorAll('input')).map((i,idx)=>({idx, ph:i.placeholder, type:i.type, maxLength:i.maxLength})))`));
console.log('--- 按钮 ---');
console.log(await ev(`JSON.stringify(Array.from(document.querySelectorAll('button')).map(b=>({text:(b.innerText||'').trim().slice(0,20), disabled:b.disabled})))`));

await setValue(0, 'XYZ19958'); // 上一步刚建的、明确"未设置密码"的号
await setValue(1, 'whatever123');
await sleep(600);
await clickText('登录');
await sleep(4500);
console.log('--- 结果文案 ---');
console.log(await pageText());
console.log('--- 是否登录 ---');
console.log(await ev(`JSON.stringify({hasToken: !!localStorage.getItem('workbench.token')})`));

ws.close();
process.exit(0);
