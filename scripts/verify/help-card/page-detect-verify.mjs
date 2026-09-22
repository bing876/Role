/**
 * 第 27 步 · **页面级判定**验收：`challengeLike`（验证码/滑块页）与 `loginLike`（登录墙）
 *
 * 关键点：这里跑的是**从 driver.ts 里现抽出来的真代码**（`PAGE_HELPERS` 那段模板字符串），
 * 不是抄一份 —— 抄一份的话产品代码改了测试也不会红，等于没测。
 *
 * 在**真 Chromium** 里跑（真 CSS、真 getComputedStyle、真 layout），
 * 所以 `visible()` / 文本扫描 / iframe 穿透这些行为都是真的。
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/bing/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core');

const CHROME =
  'C:/Users/bing/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';
const DRIVER = 'C:/Users/bing/workbuddy-ai/work123/apps/desktop/electron/driver.ts';
// ★ 端口让系统分配，不写死（写死会和别的验收抢端口，表现是偶发失败）
let PORT = 0;

// ---- 从产品源码里抽页面脚本（不复制，改了产品代码这里就会跟着变）--------------
const src = fs.readFileSync(DRIVER, 'utf8');
const TAG = 'const PAGE_HELPERS = `';
const s0 = src.indexOf(TAG);
if (s0 < 0) throw new Error('抽不到 PAGE_HELPERS —— driver.ts 的结构变了，先修测试');
const s = s0 + TAG.length;
const e = src.indexOf('`;', s);
const PAGE_HELPERS = src.slice(s, e);
if (!PAGE_HELPERS.includes('challengeish')) throw new Error('抽出来的脚本里没有 challengeish —— 抽取位置不对');
console.log(`（已从 driver.ts 抽取页面脚本 ${PAGE_HELPERS.length} 字符，含 challengeish）`);

let CHECKS = 0;
let FAILS = 0;
const ok = (name, cond, extra = '') => {
  CHECKS += 1;
  if (cond) console.log(`PASS  ${name}`);
  else {
    FAILS += 1;
    console.log(`FAIL  ${name}${extra ? `   << ${extra}` : ''}`);
  }
};

// ---- 夹具 -------------------------------------------------------------------
const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const FIXTURES = {
  // ① 真·短信验证码页：标题有验证词 + 有验证码输入框 + 有"获取验证码"按钮
  '/captcha-otp': page(
    '请完成安全验证',
    '<h2>请完成安全验证</h2><label>验证码</label><input placeholder="请输入验证码" maxlength="6">' +
      '<button>获取验证码</button><button>提交</button>',
  ),
  // ② 滑块验证页：**没有任何输入框**，只有滑块容器 + 一颗"验证"按钮
  '/captcha-slider': page(
    '安全验证',
    '<h2>安全验证</h2><div class="captcha-slider"><span class="slider-btn">拖动滑块完成验证</span></div><button>验证</button>',
  ),
  // ③ ★关键反例：一篇**讲验证码的文章** —— 有关键词、但没有任何"落脚点"
  '/article-about-captcha': page(
    '什么是验证码？一篇文章讲清楚',
    '<h1>什么是验证码？</h1><p>验证码是用来区分人和机器的一种手段。</p><p>常见的验证码有图形验证码和短信验证码。</p>',
  ),
  // ④ 经典登录墙：password 框 + 登录按钮，标题只有"登录"（不含验证词）
  '/login-classic': page(
    '登录',
    '<h2>登录</h2><input name="username"><input type="password" name="password"><button>登录</button>',
  ),
  // ⑤ 登录 + 短信验证码（两个信号同时成立）
  '/login-with-otp': page(
    '请登录',
    '<h2>请登录</h2><input type="password" name="password"><label>短信验证码</label>' +
      '<input name="smsCode" placeholder="验证码"><button>登录</button>',
  ),
  // ⑥ 普通搜索页：两个信号都该是 false
  '/search-normal': page('百度一下', '<input name="wd" placeholder="搜索"><button>百度一下</button>'),
  // ⑦ 普通表单页：按钮文案是"提交"（**不在**验证动作词表里），不该被判成验证码页
  '/form-address': page(
    '填写收货地址',
    '<h2>填写收货地址</h2><input name="address" placeholder="详细地址"><button>提交</button>',
  ),
  // ⑧ ★反例：验证词在标题上，但"落脚点"是**隐藏的** —— 不该算
  '/captcha-hidden': page(
    '安全验证',
    '<h2>安全验证</h2><input placeholder="请输入验证码" style="display:none">' +
      '<button style="display:none">获取验证码</button><p>页面已加载完成</p>',
  ),
  // ⑨ URL 命中登录词（页面本身没有任何登录字样）
  '/passport/login': page('欢迎回来', '<h2>欢迎回来</h2><p>请稍候…</p>'),
  // ⑩ 同源 iframe 里才是登录页（第 23 步的 loginish 支持）
  '/frame-host': page(
    '欢迎',
    '<h2>欢迎</h2><iframe src="/passport/login"></iframe>',
  ),
};

const server = http.createServer((req, res) => {
  const p = (req.url || '/').split('?')[0];
  const html = FIXTURES[p] ?? page('未知', '<h2>未知页面</h2>');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
PORT = server.address().port;

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });

const detect = async (path) => {
  const p = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await p.goto(`http://127.0.0.1:${PORT}${path}`, { waitUntil: 'load' });
  await p.addScriptTag({ content: PAGE_HELPERS });
  const out = await p.evaluate(() => {
    const h = window.__wbHelper;
    if (!h) return { err: 'helper 没装上' };
    return { challengeLike: h.challengeish(), loginLike: h.loginish(), hasOtpish: typeof h.otpish === 'function' };
  });
  await p.close();
  return out;
};

console.log('\n=== 第 27 步 · 页面级判定验收（真 Chromium 跑产品源码）===');

const r1 = await detect('/captcha-otp');
ok('1. 短信验证码页 → challengeLike=true', r1.challengeLike === true, JSON.stringify(r1));
ok('2. 短信验证码页 → loginLike=false（没有 password 框，不该报登录墙）', r1.loginLike === false, JSON.stringify(r1));

const r2 = await detect('/captcha-slider');
ok('3. 滑块验证页（无任何输入框）→ challengeLike=true', r2.challengeLike === true, JSON.stringify(r2));

const r3 = await detect('/article-about-captcha');
ok('4. ★反例：讲验证码的文章（有关键词、无落脚点）→ challengeLike=false', r3.challengeLike === false, JSON.stringify(r3));

const r4 = await detect('/login-classic');
ok('5. 经典登录墙 → loginLike=true', r4.loginLike === true, JSON.stringify(r4));
ok('6. 经典登录墙 → challengeLike=false（有 password 框**不等于**验证码页）', r4.challengeLike === false, JSON.stringify(r4));

const r5 = await detect('/login-with-otp');
ok('7. 登录页 + 短信验证码 → 两个信号都成立', r5.loginLike === true && r5.challengeLike === true, JSON.stringify(r5));

const r6 = await detect('/search-normal');
ok('8. 普通搜索页 → 两个信号都 false', r6.loginLike === false && r6.challengeLike === false, JSON.stringify(r6));

const r7 = await detect('/form-address');
ok('9. 普通表单页（按钮是"提交"）→ challengeLike=false', r7.challengeLike === false, JSON.stringify(r7));

const r8 = await detect('/captcha-hidden');
ok('10. ★反例：验证码框/按钮都是隐藏的 → challengeLike=false', r8.challengeLike === false, JSON.stringify(r8));

const r9 = await detect('/passport/login');
ok('11. URL 命中 login → loginLike=true', r9.loginLike === true, JSON.stringify(r9));

const r10 = await detect('/frame-host');
ok('12. 同源 iframe 里才是登录页 → loginLike=true（第 23 步的穿透没退化）', r10.loginLike === true, JSON.stringify(r10));

ok('13. helper 暴露了 otpish（字段级兜底可用）', r1.hasOtpish === true, JSON.stringify(r1));

console.log(`\n=== 结果：${CHECKS - FAILS}/${CHECKS} PASS，${FAILS} FAIL ===`);
process.exit(FAILS === 0 ? 0 : 1);
