/**
 * ADR-0003 · 浏览器深度 第一片 —— wait-for / watch **真 CDP 端到端** live 探针。
 *
 * ## 为什么有这一条(与 `wait-watch-smoke.mts` 的分工)
 *   - `wait-watch-smoke.mts`(沙箱可跑):驱动**生产 core**,在进程内 DOM 基底 + Node `vm` 上
 *     **真跑注入 JS** —— 验证控制流(轮询/超时/订阅/摘除)与注入脚本契约,不依赖 Electron。
 *   - 本探针(需真 Electron 二进制,机器上手动跑):开一个**本地测试页**,用**真 CDP**
 *     (`wc.debugger`)驱动**同一份编译产物** `dist-electron/wait-watch.js` 的 coreWaitFor/coreWatch,
 *     端到端复验「真驱动开本地测试页,wait-for 等到元素、watch 捕获插入」。
 *   两者互为镜像:沙箱证逻辑,本机证真 CDP(含 addBinding/bindingCalled 这条真事件链路)。
 *
 * ## 用法(机器上有 Electron 二进制时)
 *   cd apps/desktop
 *   npm run build:electron                       # 先把 core 编进 dist-electron
 *   npx electron ../../scripts/verify/wait-watch-live.mjs --no-sandbox
 *
 * 沙箱没有 Electron 二进制(且红线禁装 headless Chromium)—— 这里跑不了,属已知环境限制。
 */
import { app, BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import url from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const WAIT_WATCH = path.join(REPO, 'apps', 'desktop', 'dist-electron', 'wait-watch.js');

let fails = [];
let total = 0;
function chk(cond, label, detail) {
  total++;
  if (cond) console.log('  PASS  ' + label);
  else {
    console.log('  FAIL  ' + label + (detail ? '   ' + detail : ''));
    fails.push(label);
  }
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 本地测试页:先空,延迟插入 #late-result(wait-for)与 .msg 客服消息(watch)
const TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>wait-watch live</title></head>
<body><div id="shell">local test page</div><script>
  setTimeout(function () {
    var d = document.createElement('div');
    d.id = 'late-result';
    d.textContent = '结果渲染出来了';
    document.body.appendChild(d);
  }, 500);
  setTimeout(function () {
    var m = document.createElement('div');
    m.className = 'msg';
    m.textContent = '新客服消息:你好,在吗?';
    document.body.appendChild(m);
  }, 900);
</script></body></html>`;

async function main() {
  console.log('='.repeat(70));
  console.log('ADR-0003 · wait-for / watch 真 CDP 端到端 live 探针(本地测试页)');
  console.log('='.repeat(70));

  if (!require('node:fs').existsSync(WAIT_WATCH)) {
    console.log('  FAIL  找不到编译产物 ' + WAIT_WATCH + '(先 npm run build:electron)');
    app.exit(1);
    return;
  }
  const ww = require(WAIT_WATCH);

  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const wc = win.webContents;
  await win.loadURL('data:text/html,' + encodeURIComponent(TEST_PAGE));

  // 真 CDP transport:wc.debugger 的 sendCommand + on/off('message')
  const dbg = wc.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  const send = (method, params) => dbg.sendCommand(method, params);
  const events = {
    on: (e, l) => dbg.on(e, l),
    off: (e, l) => dbg.off(e, l),
  };

  // ---------------- (A) wait-for:真等到 #late-result(T+500ms 才出现) ----------------
  console.log('\n[A] wait-for:真 CDP 等到 #late-result');
  const t0 = Date.now();
  const res = await Promise.race([
    ww.coreWaitFor(send, { selector: '#late-result', timeoutMs: 6000, pollMs: 100 }),
    sleep(10000).then(() => ({ ok: false, found: false, waitedMs: -1, error: 'watchdog' })),
  ]);
  chk(res.found === true, 'wait-for 等到 #late-result(found=true)', JSON.stringify(res));
  chk(res.how === 'selector', 'wait-for 命中方式=selector', 'how=' + res.how);
  chk(res.waitedMs >= 300, 'wait-for 不早退(waitedMs≥300,元素 T+500 才出现)', 'waitedMs=' + res.waitedMs);

  // ---------------- (B) watch:真 CDP 捕获 .msg 客服消息插入(T+900ms) ----------------
  console.log('\n[B] watch:真 CDP 捕获 .msg 插入');
  const got = [];
  const handle = ww.coreWatch(send, events, (e) => got.push(e), {
    onSetupError: (e) => console.log('  setup 失败:', e.message),
  });
  await sleep(250); // 让 addBinding + observer 落地(页里 .msg 在 T+900 插入)
  await sleep(1500);
  chk(got.some((e) => e.label === 'insert' && e.tag === 'div' && /客服消息/.test(e.text)),
    'watch 捕获 .msg 插入(带对文本)', JSON.stringify(got));
  const msgCount = got.filter((e) => /客服消息/.test(e.text)).length;
  chk(msgCount === 1, 'watch 该消息恰好 1 条(不重复)', 'count=' + msgCount);

  // ---------------- (C) stop:停后不再收 ----------------
  console.log('\n[C] watch stop:停后不再收');
  handle.stop();
  const before = got.length;
  await sleep(300);
  chk(got.length === before, 'stop 后不再收新事件', `before=${before} after=${got.length}`);

  // ---------------- (D) 与既有驾驶能力并存(read_page 式 evaluate 不受 watch 影响) ----------------
  console.log('\n[D] 并存:watch 期间/摘除后,普通 Runtime.evaluate 照常');
  const title = await send('Runtime.evaluate', {
    expression: 'document.title',
    returnByValue: true,
  });
  chk(title.result?.value === 'wait-watch live', 'watch 摘除后 Runtime.evaluate 照常读回 title',
    JSON.stringify(title.result?.value));

  win.close();
  console.log('\n=== 结论 ===');
  console.log(`  ${total - fails.length} PASS / ${fails.length} FAIL`);
  if (fails.length) {
    for (const f of fails) console.log('    - ' + f);
    app.exit(1);
  } else {
    console.log('  真 CDP 端到端全绿(wait-for 等到 / watch 捕获 / stop 静默 / 并存不互斥)');
    app.exit(0);
  }
}

void main().catch((e) => {
  console.error('  探针异常:', e);
  app.exit(1);
});
