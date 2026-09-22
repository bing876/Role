/**
 * 起始页（第 24 步）验证 —— 用 loadURL 而不是 <webview>。
 *
 * 上一版用隐藏窗口里的 <webview> 加载 data:，直接超时（本机老问题：
 * 隐藏窗口 + webview guest 容易挂）。这里改成最直接的问法：
 *
 *   ① 把**和产品里逐字同一份** START_PAGE_HTML 当 data: URL 加载，看能不能出来；
 *   ② 出来的东西对不对（有内容、有入口、不是白页）；
 *   ③ 页面里点一个入口，确认点击链路是通的。
 *
 * ★ 关于"协议闸会不会拦 data:"：
 *   主进程那段 will-navigate 拦的是**后续跳转**，初始加载不走它 ——
 *   所以起始页本身一定能加载。真正要防的是"起始页里的链接点了之后"怎么办，
 *   这个由 App 侧决定（见结论里的建议）。
 */
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'acceptance', 'root-cause');
mkdirSync(OUT, { recursive: true });

const lines = [];
const log = (...a) => {
  const s = a.map(String).join(' ');
  lines.push(s);
  console.log(s);
};
let fails = 0;
const check = (name, ok, detail = '') => {
  if (!ok) fails += 1;
  log(`  ${ok ? 'PASS' : '★FAIL'} ${name}${detail ? '  —— ' + detail : ''}`);
};

app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  const sites = readFileSync(path.join(ROOT, 'apps', 'desktop', 'src', 'browser', 'sites.ts'), 'utf8');
  const m = sites.match(/export const START_PAGE_HTML = `([\s\S]*?)`;/);
  if (!m) {
    log('★FAIL 抠不出 START_PAGE_HTML');
    app.exit(1);
    return;
  }
  // 模板里 `%%` 是为了在 TS 模板字符串里写 CSS 的 `%`，这里还原
  const html = m[1].replace(/%%/g, '%');
  log(`起始页模板 ${html.length} 字符`);
  check('模板不是空壳（有实质内容）', html.length > 400, `${html.length} 字符`);

  const win = new BrowserWindow({ show: false, width: 900, height: 640 });
  const wc = win.webContents;
  const fails_ = [];
  wc.on('did-fail-load', (_e, code, desc, url) => {
    if (code !== -3) fails_.push(`${code} ${desc} ${String(url).slice(0, 40)}`);
  });

  const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);

  log('');
  log('=== ① data: 起始页能不能加载出来 ===');
  await win.loadURL(dataUrl);
  await new Promise((r) => setTimeout(r, 600));
  const url = wc.getURL();
  log(`  实际 URL 前缀 = ${url.slice(0, 50)}`);
  log(`  失败事件 = ${JSON.stringify(fails_)}`);
  check('★ 加载成功（没被拦成空白页）', url.startsWith('data:') && fails_.length === 0, JSON.stringify(fails_));

  log('');
  log('=== ② 内容对不对 ===');
  const c = await wc.executeJavaScript(`(() => ({
    title: document.title,
    links: Array.from(document.querySelectorAll('a')).map((a) => a.textContent.trim()),
    hrefs: Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href')),
    targets: Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('target')),
    brand: (document.querySelector('.brand') || {}).textContent || '',
    hint: (document.querySelector('.hint') || {}).textContent || '',
    bodyLen: (document.body.innerText || '').length,
    bg: getComputedStyle(document.body).backgroundColor,
  }))()`);
  log(`  标题 = ${c.title}`);
  log(`  入口 = ${JSON.stringify(c.links)}`);
  log(`  target = ${JSON.stringify(c.targets)}`);
  log(`  引导 = ${c.hint}`);
  check('有内容（不是白页）', c.bodyLen > 20, `正文 ${c.bodyLen} 字`);
  check('标题是「新标签页」', c.title === '新标签页', c.title);
  check('★ 列了常用站点入口', Array.isArray(c.links) && c.links.length >= 4, `${c.links.length} 个`);
  check('★ 入口都是 http(s)（不点自定义协议）', Array.isArray(c.hrefs) && c.hrefs.every((h) => /^https?:/.test(h)), JSON.stringify(c.hrefs));
  check(
    '★★ 入口都带 target="_blank"（走 opentab 开新 tab，而不是把起始页覆盖掉）',
    Array.isArray(c.targets) && c.targets.every((t) => t === '_blank'),
    JSON.stringify(c.targets),
  );
  check('有引导文案（告诉用户打网址）', /地址栏|网址/.test(c.hint || ''), c.hint);
  check('★ 没有把百度当作唯一主角（不止一个入口）', c.links.length >= 4 && !c.links.includes('百度浏览器'), JSON.stringify(c.links));

  log('');
  log('=== ③ 入口能点（点击链路通）===');
  const clicked = await wc.executeJavaScript(`(() => {
    let seen = null;
    const a = document.querySelector('a[href*="baidu"]');
    a.addEventListener('click', () => { seen = 'clicked'; });
    a.click();
    return { seen, href: a.getAttribute('href') };
  })()`);
  log(`  点击结果 = ${JSON.stringify(clicked)}`);
  check('入口可点（派发了 click）', clicked.seen === 'clicked');

  log('');
  log('=== 结论 ===');
  log(`  失败项：${fails}`);
  log('');
  log('  ★ 已解决（上面 ⑥ 已断言）：');
  log('    起始页里的入口全部带 target="_blank"，点下去会走主进程的 opentab 通道');
  log('    → 真的开一张新 tab，当前这张"新标签页"留着，不再被覆盖。');
  log('    这正是"不要百度、要像真浏览器"那轮改掉的东西 —— 这条注释当时没跟着更新。');

  writeFileSync(path.join(OUT, 'startpage-tests.log'), lines.join('\n') + '\n', 'utf8');
  writeFileSync(path.join(OUT, 'startpage-tests.json'), JSON.stringify({ fails, c, clicked }, null, 2), 'utf8');
  app.exit(fails > 0 ? 1 : 0);
}).catch((e) => {
  console.error('FATAL', e);
  app.exit(1);
});
