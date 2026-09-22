// login-page-probe.cjs —— 用 CDP 读**真实登录页**，验证本轮两件事真的生效：
//   ① 后端还在自愈时**不显示**"连不上后端"那句红字（只显示"正在准备后端"）；
//   ② 发码后**登录页上直接出现 6 位验证码**。
//
// ★ 为什么必须读真实界面：这两件事的断言在产物里只能查到"字符串在不在"，
//   而"字符串在"不等于"渲染出来了"。用户已经被"看着像修好了其实没有"坑了四次，
//   这一步不能再靠存在性判断。
//
// ★ 为什么用 `--user-data-dir=<临时目录>`：真实 userData 里有登录 token，
//   应用会直接进工作台、**根本渲染不到登录页**。用一个独立的临时数据目录
//   既能看到登录页，又**完全不碰用户的登录态**。
//
// 用法：node scripts/verify/login-page-probe.cjs
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const EXE = 'C:\\Users\\bing\\AppData\\Local\\Programs\\@ai-workbenchdesktop\\AI 工作台.exe';
const REPO = path.resolve(__dirname, '..', '..');
const PORT = 9333;
const PHONE = '18665594444';
const LOG = path.join(REPO, 'docs', 'acceptance', 'root-cause', 'login-page-probe.log');

const out = [];
const say = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (n, ok, d = '') => { checks.push([n, ok, d]); say(`   ${ok ? '✓' : '✗'} ${n}${d ? `  [${d}]` : ''}`); };

/** 把 8787 上的监听者杀掉（探针前提：应用要能自己拉起服务端）。 */
function freePort8787() {
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
  const pids = new Set();
  for (const line of (r.stdout || '').split('\n')) {
    if (!/LISTENING/.test(line)) continue;
    const m = line.match(/TCP\s+\S*:8787\s+\S+\s+LISTENING\s+(\d+)/);
    if (m) pids.add(m[1]);
  }
  for (const pid of pids) {
    spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
  return pids.size ? `已终止 ${[...pids].join(',')}` : '（本来就没有，无需清理）';
}

function readPepper() {
  const env = fs.readFileSync(path.join(REPO, 'apps', 'server', '.env'), 'utf8');
  const pick = (k) => {
    const m = env.match(new RegExp('^\\s*' + k + '\\s*=\\s*(.*)$', 'm'));
    return m ? m[1].replace(/^["']|["']$/g, '').trim() : '';
  };
  return pick('PHONE_PEPPER') || pick('DATA_KEY');
}

(async () => {
  if (!fs.existsSync(EXE)) { say('✗ 找不到可执行文件'); process.exit(1); }

  // ★★ 第 0 步（第一版漏了，直接导致假红）：先把 8787 上的**残留服务端**清掉。
  //
  // 为什么必须：验证码转发的前提是「**应用自己**拉起了服务端」—— 只有那条路径下
  // 服务端的 stdout 才归主进程所有。若 8787 上已经有人（上一次探针的残留 / 用户手动起的），
  // `ensureServer` 会走「已有服务端在跑，直接用（不接管）」，于是：
  //   ① 主进程收不到 `[sms:mock]` 那行 → 验证码转发不触发 → 探针假红；
  //   ② 但**这不是 bug**：那种情况下服务端在控制台窗口里跑，用户本来就能看见码。
  // 所以探针必须先制造"没人占用 8787"的前提，才能测到应用自愈这条路径。
  const freed = freePort8787();
  say('清理 8787 残留服务端：', freed);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-login-probe-'));
  say('临时 userData =', userData, '（真实登录态不受影响）');

  const child = spawn(EXE, ['--no-sandbox', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  const buf = [];
  const relay = (t) => (d) => { const s = d.toString(); buf.push(t + s); };
  child.stdout.on('data', relay('[out] '));
  child.stderr.on('data', relay('[err] '));
  say('应用 PID =', child.pid);

  // ---- 等 CDP 端点起来，找到主窗口 ----
  let ws = null;
  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      target = list.find((t) => t.type === 'page' && t.url.startsWith('file:'));
      if (target) break;
    } catch { /* 还没起来 */ }
  }
  if (!target) { say('✗ 没等到 CDP 页面目标'); dump(); kill(); process.exit(1); }
  say('CDP 目标 =', target.url.slice(0, 80));

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id; pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r?.result?.result?.value;
  };
  await send('Runtime.enable');

  // ★ 先验活（握手不代表渲染进程就绪，见 electron-ui-verify skill）
  let alive = false;
  for (let i = 0; i < 20; i++) { if (await evalJs('1') === 1) { alive = true; break; } await sleep(500); }
  if (!alive) { say('✗ CDP 连上了但 evaluate 不通'); dump(); kill(); process.exit(1); }
  say('CDP 就绪\n');

  const text = () => evalJs('document.body.innerText');

  // ---- ① 登录页渲染出来了（说明临时 userData 生效、没被 token 带进工作台）----
  say('=== ① 登录页是否渲染 ===');
  // ★ 等页面真的渲染出来：第一版连上 CDP 就读 innerText，拿到的是**空串**
  //   （渲染进程刚起来、首帧还没画）→ 假红。这里轮询到有内容为止。
  let t0 = '';
  for (let i = 0; i < 60; i++) {
    t0 = await text();
    if (t0 && /获取验证码/.test(t0)) break;
    await sleep(500);
  }
  say('   页面全文（首 300 字）：\n' + String(t0 || '').slice(0, 300).split('\n').map((l) => '     | ' + l).join('\n'));
  check('渲染的是登录页（有"获取验证码"按钮）', /获取验证码/.test(t0 || ''));
  check('没被旧 token 直接带进工作台（临时 userData 生效）', !/智能体|项目|对话/.test(t0 || ''));

  // ---- ② 等后端就绪，看那句红字会不会被撤掉 ----
  say('\n=== ② 后端就绪前后，页面上的提示 ===');
  const sawPreparing = /正在准备后端/.test(t0 || '');
  say('   启动瞬间页面：', sawPreparing ? '显示「正在准备后端」' : '（没抓到"正在准备"，可能已经就绪）');

  let ready = false;
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch('http://127.0.0.1:8787/health');
      const j = await r.json();
      if (j.db === 'up') { ready = true; break; }
    } catch { /* 还没好 */ }
    await sleep(1000);
  }
  await sleep(3000); // 留出 2 秒轮询周期 + 一次渲染
  const t1 = await text();
  check('后端就绪', ready);
  check('★ 就绪后页面上**没有**"连不上后端"那句红字', !/连不上后端/.test(t1 || ''));
  check('★ 就绪后也不再有"正在准备后端"', !/正在准备后端/.test(t1 || ''));
  // ★ 先填手机号再看按钮：按钮的 disabled 里本来就有 `phone.length !== 11`，
  //   第一版没填就断言"按钮该是可点的" → 假红（用例错，不是代码错）。
  //   塞值必须用 native value setter + dispatchEvent('input')，React 受控组件只认这条。
  const typed = await evalJs(`(() => {
    const el = document.querySelector('input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(el, '${PHONE}');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`);
  await sleep(500);
  const btn = await evalJs(`[...document.querySelectorAll('button')].filter(b=>b.textContent.includes('获取验证码')).map(b=>({dis:b.disabled}))[0]`);
  check('填入 11 位手机号后，"获取验证码"按钮可点', typed === PHONE && !!btn && btn.dis === false,
    `输入框=${typed} 按钮=${JSON.stringify(btn)}`);

  // ---- ③ 发码 → 登录页上应该直接出现 6 位码 ----
  say('\n=== ③ 发码后登录页是否直接显示验证码 ===');
  // ★ 服务端有「**每 IP 每分钟**发码上限」（auth.ts:132），而本探针全程从 127.0.0.1 发 ——
  //   连着跑几次必然撞 429。撞到就等一轮再来，别把它当成"验证码没显示"的失败原因。
  let sent = null;
  for (let i = 0; i < 6; i++) {
    sent = await fetch('http://127.0.0.1:8787/auth/sms/send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: PHONE }),
    });
    if (sent.status !== 429) break;
    say('   （429：每 IP 每分钟的发码上限，等 20 秒重试）');
    await sleep(20000);
  }
  say('   POST /auth/sms/send =', sent && sent.status);
  await sleep(3000);
  const t2 = await text();
  const m = /本次验证码[：:]\s*(\d{6})/.exec(t2 || '');
  check('★ 登录页上出现了「本次验证码」', /本次验证码/.test(t2 || ''),
    (t2 || '').split('\n').filter((l) => l.includes('验证码')).join(' | ').slice(0, 120));
  check('★ 页面上真的显示出了 6 位数字', !!m, m ? m[1] : '没抓到');

  // 与库里那条对一下，证明显示的不是随便一个数
  if (m) {
    const { Client } = require(path.join(REPO, 'node_modules', 'pg'));
    const db = new Client({ connectionString: 'postgresql://workbench:workbench@localhost:5432/workbench' });
    await db.connect();
    const h = crypto.createHmac('sha256', readPepper()).update(PHONE, 'utf8').digest('hex');
    const row = (await db.query(
      'SELECT code_hash, salt, used FROM sms_codes WHERE phone_hash = $1 ORDER BY created_at DESC LIMIT 1', [h])).rows[0];
    let real = null;
    if (row && !row.used) {
      for (let i = 0; i < 1_000_000; i++) {
        const c = String(i).padStart(6, '0');
        if (crypto.createHash('sha256').update(`${row.salt}$${c}`, 'utf8').digest('hex') === row.code_hash) { real = c; break; }
      }
    }
    await db.end();
    check('★ 页面显示的码 == 库里真实的码（不是假数据）', !!real && real === m[1], `页面 ${m[1]} / 库 ${real}`);
  }

  const failed = checks.filter(([, ok]) => !ok).length;
  say(`\n通过 ${checks.length - failed} / 失败 ${failed}`);
  say(failed === 0 ? '=== 结论：登录页不再骗人，且验证码直接可见 ===' : '=== 结论：有判据没过 ===');
  dump(); kill(); process.exit(failed ? 1 : 0);

  function kill() {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  }
  function dump() {
    try { fs.writeFileSync(LOG, out.join('\n') + '\n\n===== 应用输出 =====\n' + buf.join(''), 'utf8'); } catch { /* ignore */ }
  }
})().catch((e) => {
  say('探针自身出错：' + (e && e.stack ? e.stack : e));
  try { fs.writeFileSync(LOG, out.join('\n') + '\n', 'utf8'); } catch { /* ignore */ }
  process.exit(2);
});
