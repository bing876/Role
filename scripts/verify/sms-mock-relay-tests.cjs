// sms-mock-relay-tests.cjs —— 验证「主进程把 mock 验证码转给登录页」这条新通道。
//
// 为什么单独测：这条通道的**输入是服务端打印的一行文本**，输出是渲染层的一个回调。
// 中间那步是个正则 —— 正则写错不会报错，只会**静默不显示验证码**，
// 而现象和"服务端没打印"一模一样，极难排查。所以要把真代码里的那个正则抠出来直接打。
//
// ★ 抠的是**编译产物**里的正则（apps/desktop/dist-electron/main.js），不是这里另抄一份 ——
//   另抄一份只能证明"我抄对了"，证明不了"发出去的那份是对的"。
//
// 用法：node scripts/verify/sms-mock-relay-tests.cjs
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const MAIN = path.join(REPO, 'apps', 'desktop', 'dist-electron', 'main.js');
const PRELOAD = path.join(REPO, 'apps', 'desktop', 'dist-electron', 'preload.js');

const PASS = [];
const FAIL = [];
const check = (n, ok, d = '') => { (ok ? PASS : FAIL).push(n + (d ? `  [${d}]` : '')); };

(async () => {
  if (!fs.existsSync(MAIN)) { console.error('✗ 先构建主进程：npm run build:electron -w @ai-workbench/desktop'); process.exit(1); }
  const mainJs = fs.readFileSync(MAIN, 'utf8');

  // ---- 1) 从**产物**里抠出那条正则 ----
  // 产物形态： const m = /\[sms:mock\][^\n]*?(\d{3})\*+(\d{4})[^\n]*?验证码\s*(\d{6})/.exec(msg);
  // ★ 注意：源文件里写的是 `\[sms:mock\]`（带转义反斜杠），
  //   第一版我按 `[sms:mock]` 去搜 → 搜不到，报"正则不存在"的假红。
  //   改成"按行找 sms:mock + .exec(，再截出两个斜杠之间"的稳妥做法。
  const line = mainJs.split('\n').find((l) => l.includes('sms:mock') && l.includes('.exec('));
  const start = line ? line.indexOf('/') : -1;
  const end = line ? line.lastIndexOf('/.exec(') : -1;
  const src = start >= 0 && end > start ? line.slice(start, end + 1) : '';
  check('① 产物里能找到 [sms:mock] 解析正则', !!src, src || '没找到');
  if (!src) { report(); return; }
  const re = eval(src); // eslint-disable-line no-eval —— 测的就是产物里那条

  // ---- 2) 拿服务端**真实打印**的那行去打 ----
  // 真实格式（从 pg-guard-e2e 的日志里抄的）：
  //   [server] [sms:mock] → 186****4441 验证码 379857（5 分钟内有效；仅开发模式打印）
  const real = '[server] [sms:mock] → 186****4441 验证码 379857（5 分钟内有效；仅开发模式打印）';
  const g = re.exec(real);
  check('② 能解析出真实的验证码行', !!g, g ? g[0].slice(0, 50) : '没匹配');
  check('③ 验证码取到 6 位且正确', !!g && g[3] === '379857', g ? g[3] : '');
  check('④ 脱敏手机号还原成 186****4441', !!g && `${g[1]}****${g[2]}` === '186****4441',
    g ? `${g[1]}****${g[2]}` : '');

  // ---- 3) 反例：不该被匹配的东西 ----
  const negatives = [
    ['普通服务端日志', '[server] http://127.0.0.1:8787 —— GET /health；短信模式：mock（验证码只进本日志）'],
    ['数据库日志', '[server] 数据库表就绪（users/projects/agents）'],
    ['别的 6 位数但不是验证码', '[server] 监听端口 8787 成功，耗时 123456 微秒'],
  ];
  for (const [name, line] of negatives) {
    check(`⑤ 反例不误报：${name}`, re.exec(line) === null);
  }

  // ---- 4) 通道两端的名字必须一致（不然发出去没人收，静默失效）----
  const CH = 'workbench:sms:mock';
  check(`⑥ 主进程会发 ${CH}`, mainJs.includes(CH));
  const pre = fs.readFileSync(PRELOAD, 'utf8');
  check(`⑦ preload 订阅同一个通道名 ${CH}`, pre.includes(CH));
  check('⑧ preload 暴露了 onSmsMockCode', pre.includes('onSmsMockCode'));
  const sharedDts = path.join(REPO, 'packages', 'shared', 'dist', 'index.d.ts');
  check('⑨ shared 类型里有 onSmsMockCode（否则渲染层用不了）',
    fs.existsSync(sharedDts) && fs.readFileSync(sharedDts, 'utf8').includes('onSmsMockCode'));

  report();
})();

function report() {
  console.log('=== sms-mock-relay-tests ===');
  for (const p of PASS) console.log('  ✓ ' + p);
  for (const f of FAIL) console.log('  ✗ ' + f);
  console.log(`\n通过 ${PASS.length} / 失败 ${FAIL.length}`);
  process.exit(FAIL.length ? 1 : 0);
}
