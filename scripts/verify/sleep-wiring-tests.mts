/**
 * 「空闲休眠」接线回归测试（第 24 步）。
 *
 * 分工说明（这条测试**只测接线，不重测判定**）：
 *   判定逻辑（什么时候该睡、红线怎么守）已经在 `sleep-policy-tests.mts` 里穷举过了。
 *   这条测试管的是**另一类**失败 —— 那些纯函数测不到的：
 *     ① 判定写对了，但**没人调用它**（定时器没起 / effect 没接）→ 功能完全没生效；
 *     ② 状态改了，但**界面不跟着变**（tab 上的图标不显示）；
 *     ③ 深休眠了，但 `<webview>` **还挂在 DOM 上** → 内存根本没省下来，白做；
 *     ④ 浅休眠了，但**没去告诉主进程节流** → CPU 没省，白做；
 *     ⑤ 派任务前**忘了唤醒** → AI 面对一张空页，用户以为"AI 不动了"。
 *
 * 这五条正是"功能看起来做了、其实没生效"的典型死法，也是最难手测出来的。
 *
 * 跑法：`npx tsx scripts/verify/sleep-wiring-tests.mts`
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (p: string): string => readFileSync(path.join(ROOT, p), 'utf8');

const ws = read('apps/desktop/src/browser/useBrowserWorkspace.ts');
const panel = read('apps/desktop/src/browser/BrowserPanel.tsx');
const app = read('apps/desktop/src/App.tsx');
const main = read('apps/desktop/electron/main.ts');
const preload = read('apps/desktop/electron/preload.ts');
const shared = read('packages/shared/src/index.ts');
const css = read('apps/desktop/src/browser/styles.css');

let fails = 0;
const log = (...a: unknown[]): void => console.log(a.map(String).join(' '));
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) fails += 1;
  log(`  ${ok ? 'PASS' : '★FAIL'} ${name}${detail ? '  —— ' + detail : ''}`);
};

/** 把注释剥掉：有些断言要查"代码里有没有真的调用"，注释里提到不算 */
const stripComments = (src: string): string =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

log('');
log('=== ① 判定真的被调用（不是写了没人用）===');
{
  check('useBrowserWorkspace 引入了判定函数 decideSleep', /import\s*\{[^}]*decideSleep[^}]*\}\s*from\s*'\.\/sleepPolicy'/.test(ws));
  check('★ 有定时扫描（不调用 = 功能完全没生效）', /setInterval\(\s*sweepSleep/.test(ws) || /setInterval\(\s*\(\)\s*=>\s*sweepSleep/.test(ws));
  check('定时器在卸载时清掉（不漏 interval）', /clearInterval\(timer\)/.test(ws));
  check('★ 挂载后先扫一次（应用重启后本来就有一堆留下的页）', /sweepSleep\(\);\s*\n\s*return/.test(ws));
  check('扫描频率是分钟级（不是每秒空转）', /30_000/.test(ws), '30 秒');
}

log('');
log('=== ② 状态真的落进 tab（界面才看得到）===');
{
  check('★ applySleep 会把结果写进 tab.sleep', /\{\s*\.\.\.t,\s*sleep:\s*want\s*\}|sleep:\s*want/.test(ws));
  check('唤醒时会清掉 sleep（不然图标一直挂着）', /sleep:\s*undefined/.test(ws));
  check('★ 状态没变就不 commit（避免每 30 秒无谓重渲染）', /if\s*\(changed\)\s*commitPages/.test(ws));
}

log('');
log('=== ③ ★★ 深休眠真的卸载 <webview>（否则内存根本没省）===');
{
  const p = stripComments(panel);
  check(
    '★★ 深休眠走占位卡分支，不渲染 webview',
    /deepSleeping[\s\S]{0,120}return\s*\(/.test(p) && /browserPanel__slept/.test(p),
  );
  check(
    '★ 占位卡在 webview 之前 return（顺序反了就永远卸载不掉）',
    p.indexOf('deepSleeping') > 0 && p.indexOf('deepSleeping') < p.indexOf('<webview'),
    `deepSleeping@${p.indexOf('deepSleeping')} <webview@${p.indexOf('<webview')}`,
  );
  check(
    '★★ 只卸载 deep，**不卸载 shallow**（浅休眠的意义就是页还活着）',
    /t\.sleep === 'deep'/.test(p) && !/t\.sleep === 'shallow'[\s\S]{0,60}return/.test(p),
  );
  check(
    '★★ 红线双保险：drivingIds 里的页拒绝卸载',
    /t\.sleep === 'deep'\s*&&\s*!ws\.drivingIds\.includes\(t\.id\)/.test(p),
  );
  check('占位卡有「唤醒」按钮（用户有掌控感，不必非得切过去）', /wakeAndActivate/.test(p) && /唤醒/.test(p));
}

log('');
log('=== ④ ★ 浅休眠真的去告诉主进程节流（否则 CPU 没省）===');
{
  check('渲染层调了 browserThrottle', /browserThrottle/.test(ws));
  check('★ 判定浅休眠时置 true', /t\.sleep === 'shallow'/.test(ws) && /browserThrottle[^\n]*want/.test(stripComments(ws)));
  check('对齐以 pages / drivingIds 变化为触发（任何来源的唤醒都会跟上）', /\},\s*\[pages,\s*drivingIds\]\)/.test(ws));
  check('preload 暴露了 browserThrottle', /browserThrottle\s*:/.test(preload));
  check('shared 类型里有 browserThrottle', /browserThrottle\s*:/.test(shared));
  check('主进程有对应的 IPC handler', /workbench:browser:throttle/.test(main));
  check('★ 主进程真的调了 setBackgroundThrottling', /setBackgroundThrottling\(/.test(main));
  check(
    '★★ 主进程**拒绝**节流正在被驾驶的页（节流会让 CDP 点击失灵 —— 那正是前几轮修的 bug）',
    /throttle\s*&&\s*isDriving[\s\S]{0,60}return\s*\{\s*ok:\s*false/.test(main),
  );
}

log('');
log('=== ⑤ ★ 派任务前唤醒（否则 AI 面对空页，用户以为"AI 不动了"）===');
{
  const a = stripComments(app);
  check('★ 主聊天路径（prepareDrive）有唤醒拦截', /prepareDrive[\s\S]{0,400}sleepOf\(/.test(a));
  check('★ 「继续/开始任务」路径（startAgentTask）也有', /startAgentTask[\s\S]{0,900}sleepOf\(/.test(a));
  check('唤醒后再 awaitWebContentsId（顺序反了照样拿不到句柄）', (() => {
    for (const fn of ['prepareDrive', 'startAgentTask']) {
      const start = a.indexOf(fn);
      if (start < 0) return false;
      const seg = a.slice(start, start + 1400);
      const iSleep = seg.indexOf('sleepOf(');
      const iAwait = seg.indexOf('awaitWebContentsId(');
      if (iSleep < 0 || iAwait < 0 || iSleep > iAwait) return false;
    }
    return true;
  })());
  check('★ 唤醒时告诉了用户（否则"先叫醒"这件事无从得知）', /叫醒|打盹/.test(a));
  check('深休眠等更久（要重新加载）', /deep'\s*\?\s*650/.test(a));
}

log('');
log('=== ⑥ 唤醒路径完整（切 tab 自动唤醒 = Chrome 行为）===');
{
  const w = stripComments(ws);
  check('★ activate 里判断了休眠并唤醒', /activate[\s\S]{0,600}if\s*\(t\.sleep\)/.test(w));
  check('★ 唤醒后**重新计算**元素再聚焦（深休眠那张之前根本没挂载）', /wakeTab[\s\S]{0,300}webviewRefs\.current\[tabId\][\s\S]{0,80}focus/.test(w));
  check('手工唤醒有宽限期（否则刚醒又被判睡、图标会闪）', /wakeGraceRef/.test(w) && /WAKE_GRACE_MS/.test(w));
  // 参数形态是 `const wakeTab = (tabId: number, manual = true) => ...`，
  // 中间有 ` = `，所以不能写成紧邻的 `wakeTab\s*\(`（第一版就是这么写错的）。
  check(
    '系统唤醒不记宽限（干活需要它醒，干完照常睡回去）',
    /const wakeTab\s*=\s*\(\s*tabId:\s*number,\s*manual\s*=\s*true\s*\)/.test(w) &&
      /if\s*\(manual\)\s*wakeGraceRef/.test(w),
  );
}

log('');
log('=== ⑦ 其余细节 ===');
{
  const p = stripComments(panel);
  check('标签上的图标带上了"闲置多久"', /humanizeIdle\(ws\.idleMsOf\(/.test(p));
  check('有自动休眠总开关（用户能关掉）', /setSleepEnabled/.test(p));
  check('开关的两种文案都在', /自动休眠 开/.test(p) && /自动休眠 关/.test(p));
  check('占位卡样式是**不透明**的（底下已经没页面了）', /\.browserPanel__slept\s*\{[\s\S]{0,300}background:\s*#f/.test(css));
  check('占位卡给别的智能体时不露脸（与 --off 同语义）', /\.browserPanel__slept--off/.test(css));
  // 深休眠唤醒后要回到"最后在的那个地址"，不能退回开页时的首页
  check('★ 唤醒后按当前 url 恢复（不是退回 bootUrl，否则丢掉会话中的导航）', /isStartPage\(t\.url\)\s*\?\s*t\.bootUrl\s*:\s*t\.url|t\.url\s*&&\s*t\.url !== t\.bootUrl/.test(p));
}

log('');
log('=== 结论 ===');
log(`  失败项：${fails}`);
log('  判定归判定、接线归接线 —— 判定对了但没人调用，功能一样是零。');
process.exit(fails > 0 ? 1 : 0);
