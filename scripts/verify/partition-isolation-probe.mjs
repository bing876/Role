/**
 * 怀疑 1 验证：`partition` 能不能被用来读到**别的项目**的登录态？
 *
 * ## 命题拆成两半，都要证明
 *   (A) **分区之间确实是隔离的** —— 否则"换 partition"根本不算绕过
 *       （如果所有分区共享 cookie，那分区就没起到隔离作用，问题反而更严重但性质不同）；
 *   (B) **任何代码都能按名字拿到任意分区的 session** —— 且应用层**没有**任何闸门
 *       拦住"渲染层指定一个不属于自己的 partition"。
 *   (A)+(B) 同时成立 → 换 partition 就能拿到别的项目的登录态 → 怀疑成立。
 *
 * ## 本探针做什么
 *   1. 用 `session.fromPartition()` 造两个项目分区，往 A 里塞一个 cookie；
 *      确认 B 里读不到（证明 A 的隔离是真的）。
 *   2. 再"以第三方身份"按名字取回 A 的 session，确认能读到那个 cookie
 *      （证明**没有访问控制**：知道分区名就能拿到里面的凭证）。
 *   3. 检查主进程有没有 `will-attach-webview` 闸门（渲染层指定 partition 的唯一拦截点）。
 *
 * ⚠️ 本机 Electron 必须加 `--no-sandbox`，否则渲染进程会
 *    `exit_code=-1073741510` 崩掉（环境限制，非代码问题）。
 *
 * 用法：
 *   cd apps/desktop && npx electron ../../scripts/verify/partition-isolation-probe.mjs --no-sandbox
 */
import { app, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const MAIN_TS = path.join(REPO, 'apps', 'desktop', 'electron', 'main.ts');
const BROWSER_PANEL = path.join(REPO, 'apps', 'desktop', 'src', 'browser', 'BrowserPanel.tsx');

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

function read(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

// 分区名规则（与 main.ts 的 PROJECT_PARTITION_RE / url.ts 的 partitionFor 保持一致）
const PA = 'persist:workbench-browser-project-101';
const PB = 'persist:workbench-browser-project-202';

async function main() {
  console.log('='.repeat(70));
  console.log('怀疑 1 验证：partition 能否绕过项目隔离');
  console.log('='.repeat(70));

  // ---------------------------------------------------------------- (A)
  console.log('\n[A] 两个项目分区之间是否真的隔离');
  const sa = session.fromPartition(PA);
  const sb = session.fromPartition(PB);

  await sa.cookies.set({
    url: 'https://example.com/',
    name: 'project101_session',
    value: 'SECRET_OF_PROJECT_101',
    domain: 'example.com',
    path: '/',
    secure: true,
  });

  const inA = await sa.cookies.get({ name: 'project101_session' });
  const inB = await sb.cookies.get({ name: 'project101_session' });
  chk(inA.length === 1, 'A 分区里确实写进了 cookie', '读回 %d 条' % inA.length);
  chk(inB.length === 0, '★ B 分区读不到 A 的 cookie（隔离是真的）', '读回 %d 条' % inB.length);

  // ---------------------------------------------------------------- (B)
  console.log('\n[B] 换个"身份"按名字取 A 的 session，能不能拿到里面的凭证');
  // 关键：这里没有任何"我是谁"的校验 —— 只要知道分区名就能取到 session 对象
  const saAgain = session.fromPartition(PA);
  const stolen = await saAgain.cookies.get({ name: 'project101_session' });
  chk(saAgain === sa, '按名字取回的是同一个 session 对象（无访问控制）');
  chk(stolen.length === 1 && stolen[0].value === 'SECRET_OF_PROJECT_101',
      '★ 知道分区名就能读到里面的凭证（没有任何鉴权）',
      '读到 %d 条' % stolen.length);

  // 顺便证明"分区名是可猜的"：它只是 projectId，是自增小整数
  chk(/workbench-browser-project-(\d+)/.test(PA),
      '★ 分区名是可猜的（`persist:workbench-browser-project-<projectId>`，id 是小整数）');

  // ---------------------------------------------------------------- (C)
  console.log('\n[C] 应用层有没有闸门拦住"渲染层指定任意 partition"');
  const mainSrc = read(MAIN_TS);
  /**
   * ★ 这一节在 2026-09-20 之后**反了过来**，这是有意的，不要改回去：
   *   修复前它断言"主进程**没有** will-attach-webview"（那是漏洞的成立条件之一）；
   *   修复后主进程已经注册了这道闸，所以现在断言的是"**有**"。
   *   探针的职责是**如实描述当前代码**，不是永久保留一条当时的结论 ——
   *   留着一条明知已不成立的红灯，只会让后来人以为环境坏了。
   *
   *   (A)(B) 两节仍然有效：它们说的是 Electron **本身**的机制
   *   （分区之间确实隔离、`session.fromPartition` 无访问控制），那是不会变的底座。
   */
  chk(/\.on\(\s*'will-attach-webview'/.test(mainSrc),
      '★ 主进程**已注册** will-attach-webview 分区闸（修复后）',
      '没注册的话渲染层写什么分区就用什么分区');
  chk(/decideWebviewPartition/.test(mainSrc),
      '分区闸用的是可单独验证的纯判定函数');
  chk(/PROJECT_PARTITION_RE\.exec\(storage\)/.test(mainSrc),
      '主进程另外还用正则**读**分区名（下载归属用）');
  const panel = read(BROWSER_PANEL);
  chk(/partition=\{partitionFor\(t\.projectId\)\}/.test(panel),
      'partition 仍由渲染层在 <webview> 上指定（所以主进程那道闸是必需的）');

  console.log('\n' + '='.repeat(70));
  console.log('结果：' + total + ' 条断言，' + fails.length + ' 条失败');
  for (const f of fails) console.log('   ✗ ' + f);
  console.log('='.repeat(70));
  app.exit(fails.length ? 1 : 0);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error('探针异常：', e);
    app.exit(2);
  }),
);
