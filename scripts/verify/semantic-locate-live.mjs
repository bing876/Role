/**
 * ADR-0004 · 浏览器深度 第二片 —— 稳健元素定位(语义定位层)**真 CDP 端到端** live 探针。
 *
 * ## 与 `semantic-locate-smoke.mts` 的分工
 *   - `semantic-locate-smoke.mts`(沙箱可跑):驱动**生产 core**,在进程内 DOM 基底 + Node `vm` 上
 *     **真跑注入 JS** —— 验证两级解析/抗改版/反证,不依赖 Electron。
 *   - 本探针(需真 Electron 二进制,机器上手动跑):开**本地测试页**(改版前/后两版),用**真 CDP**
 *     (`wc.debugger`)驱动**同一份编译产物** `dist-electron/semantic-locate.js` 的 coreSemanticLocate,
 *     端到端复验「同一语义目标,改版前/后两版都点中同一颗;只认 class 的旧定位改版必红」。
 *   两者互为镜像:沙箱证逻辑,本机证真 CDP(Runtime.evaluate 这条真链路 + 真实可见性)。
 *
 * ## 用法(机器上有 Electron 二进制时)
 *   cd apps/desktop
 *   npm run build:electron                       # 先把 core 编进 dist-electron
 *   npx electron ../../scripts/verify/semantic-locate-live.mjs --no-sandbox
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
const LOCATE = path.join(REPO, 'apps', 'desktop', 'dist-electron', 'semantic-locate.js');

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
const enc = (s) => 'data:text/html,' + encodeURIComponent(s);

// 本地测试页:改版前 / 改版后(class 换 + 顺序对调 + testid 留)/ 改版后·去掉 testid
const PAGE_V1 = `<!doctype html><html><head><meta charset="utf-8"><title>semantic live v1</title></head>
<body><form id="order">
  <button class="submit-btn" data-testid="submit-order" id="btn-submit">提交订单</button>
  <button class="cancel-btn">取消</button>
  <button class="hidden-submit" id="hidden-submit" style="display:none">提交订单</button>
</form></body></html>`;
const PAGE_V2 = `<!doctype html><html><head><meta charset="utf-8"><title>semantic live v2</title></head>
<body><form id="order">
  <button class="cancel-v2">取消</button>
  <button class="cta-primary-2025" data-testid="submit-order">提交订单</button>
</form></body></html>`;
const PAGE_V2B = `<!doctype html><html><head><meta charset="utf-8"><title>semantic live v2b</title></head>
<body><form id="order">
  <button class="x-cancel">取消</button>
  <button class="x-primary">提交订单</button>
</form></body></html>`;

const TARGET = { text: '提交订单', tag: 'button', within: 'form' };

async function main() {
  console.log('='.repeat(70));
  console.log('ADR-0004 · 稳健元素定位(语义定位层)真 CDP 端到端 live 探针(本地测试页)');
  console.log('='.repeat(70));

  if (!require('node:fs').existsSync(LOCATE)) {
    console.log('  FAIL  找不到编译产物 ' + LOCATE + '(先 npm run build:electron)');
    app.exit(1);
    return;
  }
  const core = require(LOCATE);

  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const wc = win.webContents;
  const dbg = wc.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  const send = (method, params) => dbg.sendCommand(method, params);

  const classCount = (sel) =>
    send('Runtime.evaluate', { expression: `document.querySelectorAll(${JSON.stringify(sel)}).length`, returnByValue: true }).then(
      (r) => r.result?.value,
    );

  // ---------------- (A) 改版前:稳定属性优先(testid),真 CDP ----------------
  await win.loadURL(enc(PAGE_V1));
  console.log('\n[A] 改版前:稳定属性优先(testid)');
  const a = await core.coreSemanticLocate(send, { testId: 'submit-order' });
  chk(a.found === true && a.via === 'testid', 'A 命中,命中方式=testid', JSON.stringify(a));
  chk(a.label === '提交订单', 'A 命中的是「提交订单」', 'label=' + a.label);

  // ---------------- (B) 改版前:文本+tag+within(且有隐藏同名按钮 → 只挑可见那颗) ----------------
  console.log('\n[B] 改版前:文本+tag+within,隐藏同名按钮不命中');
  const b = await core.coreSemanticLocate(send, TARGET);
  chk(b.found === true && b.via === 'text+tag+within', 'B 命中,命中方式=text+tag+within', JSON.stringify(b));
  chk(b.label === '提交订单', 'B 命中的是「提交订单」', 'label=' + b.label);
  chk(typeof b.cx === 'number' && b.cx > 0, 'B 命中的是**可见**那颗(cx>0,不是 display:none 那颗)', 'cx=' + b.cx);

  // ---------------- (C) 改版后:同一语义目标仍点中同一颗;只认 class 的旧定位必红 ----------------
  console.log('\n[C] 改版后(class 换 + 顺序对调):同一目标仍点中;class 旧定位必红');
  await win.loadURL(enc(PAGE_V2));
  const c1 = await core.coreSemanticLocate(send, TARGET);
  chk(c1.found === true && c1.label === '提交订单', 'C1 改版后:同一语义目标仍点中「提交订单」', JSON.stringify(c1));
  const c2 = await classCount('.submit-btn');
  chk(c2 === 0, 'C2 改版后:只认 class 的旧定位(.submit-btn)**找不到**(必红)', 'count=' + c2);
  const c3testid = await core.coreSemanticLocate(send, { testId: 'submit-order' });
  chk(c3testid.found === true && c3testid.via === 'testid', 'C3 改版后:testid 保留,稳定属性仍命中', JSON.stringify(c3testid));

  // ---------------- (D) 改版后·去掉 testid:靠文本+结构兜底仍点中 ----------------
  console.log('\n[D] 改版后·去掉 testid:靠文本+tag+within 兜底仍点中');
  await win.loadURL(enc(PAGE_V2B));
  const d = await core.coreSemanticLocate(send, { testId: 'submit-order', ...TARGET });
  chk(d.found === true && d.label === '提交订单', 'D 去掉 testid 后仍点中「提交订单」', JSON.stringify(d));
  chk(d.via === 'text+tag+within', 'D 命中方式=text+tag+within(兜底)', 'via=' + d.via);
  const d2 = await classCount('.submit-btn');
  chk(d2 === 0, 'D 此版 class 旧定位也找不到(必红)', 'count=' + d2);

  // ---------------- (E) 健壮性:空目标 → notfound 不崩(真 CDP) ----------------
  console.log('\n[E] 健壮性:空目标 → notfound 不崩');
  const e = await core.coreSemanticLocate(send, {});
  chk(e.found === false && e.via === 'none', 'E 空目标 → notfound(via=none),不崩', JSON.stringify(e));

  win.close();
  console.log('\n=== 结论 ===');
  console.log(`  ${total - fails.length} PASS / ${fails.length} FAIL`);
  if (fails.length) {
    for (const f of fails) console.log('    - ' + f);
    app.exit(1);
  } else {
    console.log('  真 CDP 端到端全绿(同一目标改版前/后都点中;class 旧定位改版必红;隐藏不命中)');
    app.exit(0);
  }
}

void main().catch((e) => {
  console.error('  探针异常:', e);
  app.exit(1);
});
