/**
 * 第 28 步换装后的「包内是否是本轮代码」校验。
 *
 * 为什么不能直接 listPackage + extractFile：
 *  - listPackage 返回 **Windows 反斜杠**（带前导 `\`）；extractFile 要的是**正斜杠、无前导**
 *    ⇒ 不转换就报 "was not found"（2026-09-21 实测踩到，且 dist-electron 能读、dist/assets 读不到）。
 * - 最稳的做法还是 extractAll 到临时目录再用 fs 读，路径坑一次都没有。
 *
 * ★ esbuild 默认 charset='ascii' ⇒ 打包产物里的**中文是 \uXXXX 转义**。
 *   所以「付款按钮词表」这类中文断言必须查转义后的形式，查原中文会假红。
 */
import asar from '@electron/asar';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ASAR = String.raw`C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\resources\app.asar`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's28-check-'));
asar.extractAll(ASAR, tmp);

const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const elDir = path.join(tmp, 'dist-electron');
const elFiles = fs.readdirSync(elDir).filter((f) => f.endsWith('.js'));
const allEl = elFiles.map((f) => readIf(path.join(elDir, f))).join('\n');
const drv = readIf(path.join(elDir, 'driver.js'));
const ag = readIf(path.join(elDir, 'agent.js'));
// 付款/敏感词表在 fieldClass.js（vite 多入口，没有并进 driver.js 的产物）
const fc = readIf(path.join(elDir, 'fieldClass.js'));

const assetsDir = path.join(tmp, 'dist', 'assets');
const assetsJs = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
const mSrc = assetsJs.length ? readIf(path.join(assetsDir, assetsJs[0])) : '';

// 中文在产物里是 \uXXXX：把断言里的中文转成同一种形式再查
const esc = (s) =>
  Array.from(s)
    .map((c) => (c.charCodeAt(0) > 127 ? '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') : c))
    .join('');

const C = (s, t) => s.split(t).length - 1;
let pass = 0;
let fail = 0;
const A = (n, c, e = '') => {
  if (c) pass++;
  else fail++;
  console.log(c ? '✓' : '✗', n, e);
};

console.log('主进程 js:', elFiles.length, '| 渲染 js:', assetsJs.join(','));

A("driver 含 risk: 'pay'", C(drv, "risk: 'pay'") > 0, 'x' + C(drv, "risk: 'pay'"));
A("driver 含 risk: 'sensitive'", C(drv, "risk: 'sensitive'") > 0, 'x' + C(drv, "risk: 'sensitive'"));
// 词表：中文被 esbuild 转成 \uXXXX（也可能没转），两种形态任一命中即算过
const hasWord = (src) => (w) => src.includes(w) || src.includes(esc(w));
A('fieldClass 含付款按钮词表（提交订单/立即支付/确认付款）', hasWord(fc)('提交订单') && hasWord(fc)('立即支付') && hasWord(fc)('确认付款'));
A('fieldClass 含敏感字段词表（验证码）', hasWord(fc)('验证码'));
A('agent 含 risk_pay 申报', C(ag, 'risk_pay') > 0, 'x' + C(ag, 'risk_pay'));
A('agent 含 risk 双分支', /res\.risk === 'pay' \|\| res\.risk === 'sensitive'/.test(ag));
A('P0 loop_gone 仍在（没被换丢）', C(allEl, 'loop_gone') > 0, 'x' + C(allEl, 'loop_gone'));
// ★ 等待态 TTL 在**服务端**（toolLoop.ts），服务端不在 asar 里 ⇒ 这条查本地 dist，不查包
const srv = readIf(String.raw`C:\Users\bing\workbuddy-ai\work123\apps\server\dist\toolLoop.js`);
A('P0 等待态 TTL 仍在（服务端 dist）', /WAITING_TTL|21600000/.test(srv));

A('渲染层含 background 视图态', /["']background["']/.test(mSrc));
A('渲染层仍含 fullscreen（用户主动开页仍拉全屏）', /["']fullscreen["']/.test(mSrc));
A('渲染层含 embed（求助卡影子层）', /["']embed["']/.test(mSrc));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
