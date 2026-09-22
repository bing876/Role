/**
 * #2 验证：主进程不再能被渲染层当成「任意地址的请求发起器 + JWT 外带通道」。
 *
 * ## 验证思路（为什么这么测）
 * 真正要证明的命题有两条，缺一不可：
 *   (a) **能力被砍掉** —— 渲染层递进来的 token 已经不再被使用，且非回环地址被拒；
 *   (b) **场景没被弄坏** —— 「刷新后主进程没会话」这个真实场景仍有通道可走
 *       （`syncSession`），否则就是把一个真实功能改坏了。
 *
 * (a) 里"非回环地址被拒"这条，直接跑 Electron 太重（本机 Electron 进程沙箱还有
 * 已知的环境崩溃）。所以这里**把 `isLoopbackBase` 的真实函数体从 main.ts 里抽出来**，
 * 在当前进程里求值后跑真值表 —— 测的是**线上那份代码的原文**，不是抄一份副本
 * （抄副本只能证明"我抄对了"，证明不了"线上是对的"）。
 *
 * 其余用静态断言：产物 `dist-electron/main.js` 是 tsc 输出、**不压缩**，
 * 所以可以按标识符检索 —— 这是本机能做的最强证据（见工作区记忆的换装自检口径）。
 *
 * 用法： node scripts/verify/p1-item2-verify.js
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const MAIN_TS = path.join(REPO, 'apps', 'desktop', 'electron', 'main.ts');
const PRELOAD_TS = path.join(REPO, 'apps', 'desktop', 'electron', 'preload.ts');
const DIST_MAIN = path.join(REPO, 'apps', 'desktop', 'dist-electron', 'main.js');
const APP_TSX = path.join(REPO, 'apps', 'desktop', 'src', 'App.tsx');

let fails = [];
let total = 0;
function chk(cond, label, detail) {
  total++;
  if (cond) {
    console.log('  PASS  ' + label);
  } else {
    console.log('  FAIL  ' + label + (detail ? '   ' + detail : ''));
    fails.push(label);
  }
  return cond; // ← 必须有：漏了它，调用方的 `if (!chk(...))` 会永远为真
}

function read(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

/** 从源码里把某个函数的**原文**抽出来（按大括号配平，不靠正则贪心）。 */
function extractFunction(src, name) {
  const sig = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*(?::\\s*[\\w<>\\[\\]|\\s]+)?\\s*\\{');
  const m = sig.exec(src);
  if (!m) return null;
  let i = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, j + 1);
    }
  }
  return null;
}

/**
 * 定位一个 ipcMain.handle 处理器，返回它的代码正文。
 *
 * ★ 必须锚在 `ipcMain.handle('通道名'` 上，**不能**用裸通道名 indexOf ——
 *   tsc 保留注释，而注释里也会提到同一个通道名（例如"见 workbench:session:sync"），
 *   裸 indexOf 会命中**注释**，于是取的窗口里根本没有代码，断言集体假失败。
 *   （踩过：6 条断言全红，实际代码是对的。）
 */
function handlerBody(distSrc, channel, span = 4000) {
  const re = new RegExp("ipcMain\\.handle\\(\\s*'" + channel + "'");
  const m = re.exec(distSrc);
  if (!m) return null;
  return distSrc.slice(m.index, m.index + span);
}

console.log('='.repeat(70));
console.log('#2 验证：主进程请求发起能力与 JWT 外带通道是否已封死');
console.log('='.repeat(70));

const mainSrc = read(MAIN_TS);
const preloadSrc = read(PRELOAD_TS);
const distMain = read(DIST_MAIN);
const appSrc = read(APP_TSX);

// --------------------------------------------------------------------------
// 1) isLoopbackBase 真值表 —— 用 main.ts 里的**原文**跑
// --------------------------------------------------------------------------
console.log('\n[1] isLoopbackBase 真值表（取自 main.ts 原文）');
const fnSrc = extractFunction(mainSrc, 'isLoopbackBase');
if (!chk(!!fnSrc, '能从 main.ts 抽出 isLoopbackBase 原文', '抽不到就无法验证，先查函数是否被改名')) {
  console.log('\n结果：' + total + ' 条断言，' + fails.length + ' 条失败');
  process.exitCode = 1;
  return;
}
// 把 TS 的类型标注去掉后求值（这个函数只有参数类型标注，无其它 TS 语法）
const jsSrc = fnSrc.replace(/function\s+isLoopbackBase\s*\(([^)]*)\)\s*:\s*boolean/,
                            (_m, args) => 'function isLoopbackBase(' + args.replace(/:\s*string/g, '') + ')');
const isLoopbackBase = eval('(' + jsSrc + ')');

const cases = [
  ['http://127.0.0.1:8787', true, '标准回环（本产品默认后端）'],
  ['http://127.0.0.1:8791', true, '换端口的本机开发'],
  ['http://localhost:8787', true, 'localhost 写法'],
  ['https://localhost:8443', true, 'https + localhost'],
  ['http://[::1]:8787', true, 'IPv6 回环'],
  ['http://127.0.0.1', true, '不带端口'],
  ['http://127.0.0.1.evil.com/', false, '★ 前缀伪装：以 127.0.0.1 开头但实为外域'],
  ['http://localhost.evil.com/', false, '★ 前缀伪装：localhost.evil.com'],
  ['https://evil.com/', false, '★ 纯外域'],
  ['http://192.168.1.10:8787', false, '★ 内网其它主机（不是本机回环）'],
  ['http://10.0.0.5/', false, '★ 内网段'],
  ['file:///etc/passwd', false, '★ 非 http(s) 协议'],
  ['javascript:alert(1)', false, '★ 伪协议'],
  ['', false, '空串'],
  ['not a url', false, '非法 URL'],
  ['http://127.0.0.1:8787@evil.com/', false, '★ userinfo 伪装：真实主机是 evil.com'],
];
for (const [input, want, why] of cases) {
  const got = isLoopbackBase(input);
  chk(got === want, `isLoopbackBase(${JSON.stringify(input)}) === ${want}`, `实际 ${got}（${why}）`);
}

// --------------------------------------------------------------------------
// 2) 下载处理器：token 只认主进程内存，不再读渲染层传进来的
// --------------------------------------------------------------------------
console.log('\n[2] workbench:doc:download：token 只认主进程内存');
const dlBody = handlerBody(distMain, 'workbench:doc:download');
chk(!!dlBody, '产物里能找到 doc:download 处理器（锚在 ipcMain.handle 上）');
if (dlBody) {
  chk(!/tokenRaw/.test(dlBody),
      '★ 处理器不再引用 tokenRaw（渲染层递进来的 token 已彻底不用）',
      '仍出现 tokenRaw');
  chk(/const token = agentJwt;/.test(dlBody),
      '★ token 一律取自主进程内存 agentJwt',
      '找不到 `const token = agentJwt;`');
  chk(/isLoopbackBase\(wantedBase\)/.test(dlBody),
      '★ 地址经过 isLoopbackBase 白名单',
      '地址没走白名单');
  chk(/只允许下载本机后端/.test(dlBody), '拒绝时给人话（不是静默失败）');
}
chk(/ipcMain\.handle\('workbench:doc:download',\s*async\s*\(_event,\s*taskIdRaw:\s*unknown,\s*apiBaseRaw:\s*unknown\)/.test(mainSrc),
    '★ 处理器签名只剩 3 个参数（token 参数已从入口删掉）');

// --------------------------------------------------------------------------
// 3) preload 桥：downloadDoc 不再暴露 token；新增 syncSession
// --------------------------------------------------------------------------
console.log('\n[3] preload 桥面');
chk(/downloadDoc:\s*\(taskId:\s*number,\s*apiBase:\s*string\)\s*=>/.test(preloadSrc),
    '★ downloadDoc 签名不再接收 token');
chk(/syncSession:\s*\(apiBase:\s*string,\s*token:\s*string\)\s*=>/.test(preloadSrc),
    '★ 新增显式 syncSession 通道');
chk(/ipcRenderer\.invoke\('workbench:session:sync',\s*apiBase,\s*token\)/.test(preloadSrc),
    'syncSession 正确转发到主进程');

// --------------------------------------------------------------------------
// 4) 场景没被弄坏：刷新后仍有通道把登录态同步给主进程
// --------------------------------------------------------------------------
console.log('\n[4] 「刷新后主进程没会话」场景仍可用（不能只砍不补）');
const sb = handlerBody(distMain, 'workbench:session:sync');
chk(!!sb, '主进程注册了 session:sync 处理器');
if (sb) {
  chk(/isLoopbackBase\(base\)/.test(sb), 'syncSession 也走回环白名单（同一个口子不能只堵一半）');
  chk(/agentJwt = tokenRaw\.trim\(\)/.test(sb), 'syncSession 能写入 agentJwt');
  chk(/typeof tokenRaw === 'string'/.test(sb),
      '只接受字符串（传 undefined 不会被误当成"清空"）');
}
chk(/void window\.workbench\?\.syncSession\?\.\(API_BASE\(\), saved\)/.test(appSrc),
    '★ F5 静默恢复成功后同步一次（这正是原来那个场景）');
chk(/void window\.workbench\?\.syncSession\?\.\(API_BASE\(\), sess\.token\)/.test(appSrc),
    '登录成功后同步一次');
chk(/void window\.workbench\?\.syncSession\?\.\(API_BASE\(\), ''\)/.test(appSrc),
    '登出时清空主进程那份凭证');
chk(!/downloadDoc\(curTask\.id,\s*API_BASE\(\),\s*session\.token\)/.test(appSrc),
    '★ 渲染层不再把 session.token 递给下载接口');

// --------------------------------------------------------------------------
// 5) agent:start 的地址也走白名单（不能只堵下载这一个口子）
// --------------------------------------------------------------------------
console.log('\n[5] agent:start 的 apiBase 同样受限');
chk(/apiBase\s*&&\s*isLoopbackBase\(apiBase\)/.test(mainSrc),
    '★ agent:start 也只放行回环地址（同一个风险面别只堵一半）');

console.log('\n' + '='.repeat(70));
console.log('结果：' + total + ' 条断言，' + fails.length + ' 条失败');
for (const f of fails) console.log('   ✗ ' + f);
console.log('='.repeat(70));
// ★ 用 exitCode 而不是 process.exit()：
//   在 Windows 上 stdout 是异步的，process.exit() 会**丢掉还没落盘的输出** ——
//   现象是"脚本明明跑完了，日志却只剩开头几行"（踩过）。
process.exitCode = fails.length ? 1 : 0;
