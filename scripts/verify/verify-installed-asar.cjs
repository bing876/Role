// verify-installed-asar.cjs —— 换装后**读回安装目录的 asar 字节**，确认装上去的是什么。
//
// ★ 为什么必须读字节，不能只对 sha256：
//   2026-09-20 踩过 —— `createPackage` 产出的包 5470291 字节里**只有 3 个非零**
//   （header JSON 与内容区全是 0x00），而 sha256 两边"完全一致"（算的就是那份零字节文件），
//   脚本一路自检通过把空壳装了上去。**哈希一致 ≠ 包是好的。**
//
// ★ 判定四条（缺一不可）：
//   ① 非零比例 > 50%          —— 空壳立刻被抓
//   ② canary 串在包里          —— 装进去的确实是这一版
//   ③ 条目数 > 100            —— header 完整
//   ④ 关键文件**解出来**与刚构建的逐字节一致 —— 堵死"装的是另一份"
//
// 用法：node scripts/verify/verify-installed-asar.cjs
const asar = require('@electron/asar');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RES = String.raw`C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\resources`;
const ASAR = path.join(RES, 'app.asar');
const REPO = path.resolve(__dirname, '..', '..');
const EL = path.join(REPO, 'apps', 'desktop', 'dist-electron');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const rows = [];
const check = (n, ok, d = '') => { rows.push([n, ok, d]); console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? `  [${d}]` : ''}`); };

(async () => {
  if (!fs.existsSync(ASAR)) { console.error('✗ 找不到', ASAR); process.exit(1); }
  const buf = fs.readFileSync(ASAR);
  let nz = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) nz++;
  const ratio = nz / buf.length;

  console.log('=== 安装目录里的 app.asar（读回字节）===');
  console.log(`  路径：${ASAR}`);
  console.log(`  大小：${buf.length} B`);
  console.log(`  sha256：${sha(buf)}`);
  console.log(`  非零字节：${nz} / ${buf.length} = ${(ratio * 100).toFixed(1)}%\n`);

  check('① 非零比例 > 50%（不是零字节空壳）', ratio > 0.5, `${(ratio * 100).toFixed(1)}%`);

  const list = asar.listPackage(ASAR);
  check('③ 条目数 > 100（header 完整）', list.length > 100, `${list.length} 条`);

  const CANARY = '[pg-supervisor]';
  check(`② canary 串在包里（${CANARY}）`, buf.includes(Buffer.from(CANARY, 'utf8')));

  // ④ 把关键文件解出来 —— **按"有没有本轮的新代码"判**，而不是按"与当前构建逐字节一致"判。
  //
  // ★★ 为什么改：2026-09-20 踩到 —— 换装之后，本机有个**外部进程会再次重建
  //    `apps/desktop/dist-electron/*`**（实测 01:34 换装、01:35:19 main.js 又被写了一次）。
  //    于是"拿包里的文件与**当前**构建逐字节比"必然对不上 —— 那是**用例错**，
  //    跟"包里装错了东西"是两回事。构建产物是个会动的靶子，不能当基准。
  //    真正要回答的问题是："**装进去的那份**里有没有我这一版的代码？"
  //    所以改成查 token。逐字节比对降级成**参考信息**（⚠ 而不是 ✗）。
  const norm = (p) => p.replace(/^[\\/]/, '').replace(/[\\/]/g, path.sep);
  const findIn = (suffix) => list.find((x) => x.replace(/[\\/]/g, '/').endsWith(suffix));
  const readIn = (suffix) => {
    const inside = findIn(suffix);
    return inside ? asar.extractFile(ASAR, norm(inside)).toString('utf8') : null;
  };

  const sup = readIn('dist-electron/server-supervisor.js');
  const main = readIn('dist-electron/main.js');
  const pre = readIn('dist-electron/preload.js');
  const renderer = list
    .filter((x) => /\/dist\/assets\/.*\.js$/.test(x.replace(/[\\/]/g, '/')))
    .map((x) => asar.extractFile(ASAR, norm(x)).toString('utf8'))
    .join('\n');

  check('④ 包里能解出 dist-electron/{main,server-supervisor,preload}.js',
    !!(sup && main && pre));
  check('④ 包里能解出渲染层 bundle', renderer.length > 10000, `${renderer.length} 字符`);

  // 参考信息：与当前构建比（对不上只提示，不判负 —— 见上面的原因）
  for (const [f, got] of [['main.js', main], ['server-supervisor.js', sup], ['preload.js', pre]]) {
    const want = fs.readFileSync(path.join(EL, f), 'utf8');
    const same = got === want;
    console.log(`  ${same ? '·' : '⚠'} 参考：包里的 ${f} 与**当前**构建${same ? '一致' : '不一致（产物在换装后被重建过，属预期）'}`);
  }

  // ⑤ 本轮新增能力在**装进去的那份**里真的存在
  check('⑤ server-supervisor.js: ensurePostgres', !!sup && sup.includes('ensurePostgres'));
  check('⑤ server-supervisor.js: clearStalePid', !!sup && sup.includes('clearStalePid'));
  check('⑤ server-supervisor.js: 逃生开关', !!sup && sup.includes('WORKBENCH_NO_AUTOSTART_PG'));
  check('⑤ server-supervisor.js: 拉 PG 用 detached', !!sup && /detached:\s*true/.test(sup));

  // ⑥ 本轮（登录页别再骗人 + 显示验证码）的新代码必须在**装进去的那份**里
  check('⑥ main.js: 会把 [sms:mock] 验证码转给登录页', !!main && main.includes('workbench:sms:mock'));
  check('⑥ preload.js: 暴露了 onSmsMockCode', !!pre && pre.includes('onSmsMockCode'));
  check('⑥ 渲染层: 后端没就绪时显示"正在准备后端"', renderer.includes('正在准备后端'));
  check('⑥ 渲染层: 会核对 /health 的 service 标识', renderer.includes('ai-workbench-server'));
  check('⑥ 渲染层: 登录页会显示"本次验证码"', renderer.includes('本次验证码'));
  check('⑥ 渲染层: 订阅了 onSmsMockCode', renderer.includes('onSmsMockCode'));

  // ⑦ 本轮（后端保活心跳）：启动时拉一次不够，掉了要能自己拉回来
  check('⑦ main.js: 有后端保活心跳（setInterval + ensureServer）',
    !!main && /setInterval\([\s\S]{0,500}ensureServer/.test(main));
  check('⑦ main.js: 心跳里也保活数据库（ensurePostgres quiet）',
    !!main && /setInterval[\s\S]{0,500}ensurePostgres[\s\S]{0,150}quiet:\s*true/.test(main));
  check('⑦ server-supervisor.js: ensurePostgres 支持 quiet（保活不刷日志）',
    !!sup && sup.includes('quiet'));

  // ⑧ 本轮（不弹终端）：spawn PG 不能带 detached
  // ★ 剥注释再判 —— 代码注释里为讲清原因写了 `detached: true` 这串字面量
  const supCode = (sup || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  check('⑧ server-supervisor.js: 拉 PG **不再**用 detached（否则 Windows 新建控制台 → 弹黑窗）',
    !/detached:\s*true/.test(supCode));
  check('⑧ server-supervisor.js: 拉 PG 用 windowsHide', /windowsHide:\s*true/.test(supCode));

  const failed = rows.filter(([, ok]) => !ok).length;
  console.log(`\n通过 ${rows.length - failed} / 失败 ${failed}`);
  console.log(failed === 0
    ? '=== 结论：装上去的就是这一版，包完好 ==='
    : '=== 结论：有问题，别当成功 ===');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('脚本自身出错：', e); process.exit(2); });
