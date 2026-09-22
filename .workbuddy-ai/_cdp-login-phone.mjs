/**
 * 手机验证码登录 · 超出简报的边界测试
 *   1) 手机号不足 11 位 → 「获取验证码」必须仍 disabled（前端门槛）
 *   2) 正常流程：填 11 位 → 发码 → 从页面取 6 位 mock 码 → 登录成功（token 落盘 + 登录门消失）
 *   3) 错误验证码 → 必须报错且**不**登录（防"随便填个码就进去了"）
 *
 * 填值用 native setter + input 事件（React 受控组件认这个）；点击用完整鼠标序列。
 */
const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rec = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
};

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
  ev(`(() => {
    const el = document.querySelectorAll('input')[${idx}];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(val)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`);

const btnState = (text) =>
  ev(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => (x.innerText||'').includes(${JSON.stringify(text)}));
    return b ? JSON.stringify({found:true, disabled:b.disabled, text:(b.innerText||'').trim()}) : '{"found":false}';
  })()`);

const clickText = async (text) => {
  const rectStr = await ev(`(() => {
    const all = Array.from(document.querySelectorAll('button, a, [role=button]'));
    const hit = all.filter(el => (el.innerText||'').includes(${JSON.stringify(text)}) && el.getBoundingClientRect().width > 0);
    if (!hit.length) return 'NOT_FOUND';
    const el = hit[hit.length-1];
    const r = el.getBoundingClientRect();
    return JSON.stringify({x:r.x+r.width/2, y:r.y+r.height/2});
  })()`);
  if (rectStr === 'NOT_FOUND') return false;
  const { x, y } = JSON.parse(rectStr);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sleep(120);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(100);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  return true;
};

const pageText = () => ev(`document.body.innerText.replace(/\\n+/g, ' | ')`);

// ---------- 0) 确保在登录页 ----------
const atLogin = await ev(`document.body.innerText.includes('登录 AI 工作台')`);
if (!atLogin) {
  console.log('!! 不在登录页，先退出登录');
  await clickText('退出登录');
  await sleep(3000);
}
rec('前置：处于登录页', await ev(`document.body.innerText.includes('登录 AI 工作台')`), '');

// ---------- 1) 手机号不足 11 位 ----------
await setValue(0, '1866559444'); // 10 位
await sleep(600);
const s1 = JSON.parse(await btnState('获取验证码'));
rec('10 位手机号 → 获取验证码仍 disabled', s1.disabled === true, JSON.stringify(s1));

// ---------- 2) 正常流程 ----------
await setValue(0, '18665594441'); // 11 位
await sleep(600);
const s2 = JSON.parse(await btnState('获取验证码'));
rec('11 位手机号 → 获取验证码 enabled', s2.disabled === false, JSON.stringify(s2));

await clickText('获取验证码');
await sleep(4000);
let txt = await pageText();
const m = txt.match(/本次验证码[：: ]*(\d{6})/);
rec('发码后页面显示 6 位 mock 验证码', !!m, m ? m[1] : txt.slice(0, 200));

// ---------- 3) 错误验证码必须被拒 ----------
await setValue(1, '000000');
await sleep(500);
await clickText('登录 / 注册');
await sleep(4000);
const afterWrong = await ev(`JSON.stringify({hasToken: !!localStorage.getItem('workbench.token'), gate: document.body.innerText.includes('登录 AI 工作台')})`);
const aw = JSON.parse(afterWrong);
rec('错误验证码 → 不登录', aw.hasToken === false && aw.gate === true, afterWrong);
console.log('   错误码时的提示：', (await pageText()).slice(0, 260));

// ---------- 4) 正确验证码登录 ----------
if (m) {
  await setValue(1, m[1]);
  await sleep(500);
  await clickText('登录 / 注册');
  await sleep(5000);
  const after = await ev(`JSON.stringify({hasToken: !!localStorage.getItem('workbench.token'), len: (localStorage.getItem('workbench.token')||'').length, gate: document.body.innerText.includes('登录 AI 工作台')})`);
  const a = JSON.parse(after);
  rec('正确验证码 → 登录成功', a.hasToken === true && a.gate === false, after);
  console.log('   登录后页面：', (await pageText()).slice(0, 200));
}

console.log('\n===== 汇总 =====');
const pass = results.filter((r) => r.pass).length;
console.log(`${pass}/${results.length} 通过`);
results.filter((r) => !r.pass).forEach((r) => console.log('  未通过：', r.name, '|', r.detail));

ws.close();
process.exit(0);
