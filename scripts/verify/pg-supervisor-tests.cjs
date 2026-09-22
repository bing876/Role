// pg-supervisor-tests.cjs —— 验证「应用也管数据库」这条新增能力。
//
// 为什么用 .cjs + 编译产物：`ensurePostgres` 住在
// `apps/desktop/dist-electron/server-supervisor.js`（tsc 产物、不压缩），
// 纯 Node 就能 require —— 它只依赖 node 内置模块，不 import electron。
//
// ★ 必须在**同一个进程内**跑完所有用例：模块级状态（pgInflight）分进程会重新
//   初始化，并发去重那条就测不到了（这个坑在 server-supervisor 那边踩过）。
//
// ★ 为什么不再"跳过"任何一条：第一版直接探 5432，本机 5432 恰好有真 PG 在跑，
//   于是「找不到便携包 / 逃生开关 / 并发去重」三条**全被跳过**，18 条里只有
//   14 条真跑了 —— 最重要的分支恰恰没测到。现在改成用 `WORKBENCH_PG_PORT`
//   指向一个**我们自己控制的临时端口**（默认关着，需要时再开），
//   于是每条分支都能被真实驱动，不再依赖"本机 5432 是开是关"这种偶然。
//
// 用法：node scripts/verify/pg-supervisor-tests.cjs
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const MOD = path.join(REPO, 'apps', 'desktop', 'dist-electron', 'server-supervisor.js');

const PASS = [];
const FAIL = [];
function check(name, ok, detail = '') {
  (ok ? PASS : FAIL).push(name + (detail ? `  [${detail}]` : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个临时监听，返回 {port, close}。 */
function listen(port = 0) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => {
      resolve({
        port: srv.address().port,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

/** 借一个当前空闲的端口号，然后**立刻关掉**（得到一个"确定没人听"的端口）。 */
async function freePort() {
  const s = await listen(0);
  const p = s.port;
  await s.close();
  return p;
}

async function portOpen(port, timeout = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** 造一个"看起来像便携包"的假目录：pg/bin/postgres.exe + data/。 */
function makeFakePgHome(tag) {
  const home = path.join(os.tmpdir(), `pg-sup-${tag}-${Date.now()}`);
  fs.mkdirSync(path.join(home, 'pg', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  // 必须放一个**真能执行**的 exe：0 字节文件会让 spawn 触发 'error' 事件，
  // 而 doEnsurePostgres 没有监听 'error' → 未处理的 error 事件会把测试进程直接搞崩。
  fs.copyFileSync('C:\\Windows\\System32\\where.exe', path.join(home, 'pg', 'bin', 'postgres.exe'));
  return home;
}

const cleanups = [];

(async () => {
  if (!fs.existsSync(MOD)) {
    console.error('✗ 找不到编译产物，先跑 npm run build:electron：', MOD);
    process.exit(1);
  }
  const mod = require(MOD);

  // 全程不碰真库：默认把端口指向一个"没人听"的临时端口。
  // 每条例外自己覆盖。
  delete process.env.WORKBENCH_PG_HOME;
  delete process.env.WORKBENCH_NO_AUTOSTART_PG;

  // ---------- 1) 导出面 ----------
  check('导出了 ensurePostgres', typeof mod.ensurePostgres === 'function');
  check('导出了 getPgHome', typeof mod.getPgHome === 'function');
  check('导出了 getPgPort', typeof mod.getPgPort === 'function');

  // ---------- 2) getPgHome 尊重环境变量 ----------
  {
    const custom = 'C:\\tmp\\pg-custom';
    process.env.WORKBENCH_PG_HOME = custom;
    check('getPgHome 尊重 WORKBENCH_PG_HOME', mod.getPgHome() === custom, mod.getPgHome());
    delete process.env.WORKBENCH_PG_HOME;
    const def = mod.getPgHome();
    check('getPgHome 默认落在 ~/workbuddy-ai/pg2',
      def.replace(/\\/g, '/').toLowerCase().endsWith('/workbuddy-ai/pg2'), def);
  }

  // ---------- 3) getPgPort：默认 / 覆盖 / 非法值回落 ----------
  {
    delete process.env.WORKBENCH_PG_PORT;
    check('getPgPort 默认 5432', mod.getPgPort() === 5432, String(mod.getPgPort()));
    process.env.WORKBENCH_PG_PORT = '5544';
    check('getPgPort 尊重 WORKBENCH_PG_PORT', mod.getPgPort() === 5544, String(mod.getPgPort()));
    for (const bad of ['abc', '0', '-1', '99999', '']) {
      process.env.WORKBENCH_PG_PORT = bad;
      check(`getPgPort 非法值 ${JSON.stringify(bad)} 回落 5432`, mod.getPgPort() === 5432,
        String(mod.getPgPort()));
    }
    delete process.env.WORKBENCH_PG_PORT;
  }

  // ---------- 4) 端口已通 → 原样返回 true、明确不接管 ----------
  {
    const srv = await listen(0);
    process.env.WORKBENCH_PG_PORT = String(srv.port);
    const logs = [];
    const r = await mod.ensurePostgres((m) => logs.push(m));
    check('端口已通时 ensurePostgres 返回 true', r === true, String(r));
    check('端口已通时明确说"不接管、不动它"',
      logs.some((l) => l.includes('已有 PostgreSQL 在跑') && l.includes('不动它')),
      logs.join(' | ').slice(0, 120));
    check('★ 端口已通时绝不尝试拉起（没有"自动拉起"日志）',
      !logs.some((l) => l.includes('自动拉起 PostgreSQL')));
    await srv.close();
    delete process.env.WORKBENCH_PG_PORT;
  }

  // ---------- 5) 找不到便携包 → false、不抛、给出可执行下一步 ----------
  {
    process.env.WORKBENCH_PG_PORT = String(await freePort());
    process.env.WORKBENCH_PG_HOME = path.join(os.tmpdir(), 'no-such-pg-home-' + Date.now());
    const logs = [];
    let threw = null;
    let r = null;
    try {
      r = await mod.ensurePostgres((m) => logs.push(m));
    } catch (e) {
      threw = e;
    }
    check('找不到便携包时不抛异常', threw === null, threw ? String(threw.message) : '');
    check('找不到便携包时返回 false', r === false, String(r));
    check('★ 日志说清是"找不到便携包"（不是别的分支）',
      logs.some((l) => l.includes('找不到本机 PostgreSQL 便携包')),
      logs.join(' | ').slice(0, 160));
    check('日志给出了可执行下一步（提示 start-dev.cmd）',
      logs.some((l) => l.includes('start-dev.cmd')), logs.join(' | ').slice(0, 160));
    check('★ 这条分支不该出现"自动拉起 PostgreSQL"',
      !logs.some((l) => l.includes('自动拉起 PostgreSQL')));
    delete process.env.WORKBENCH_PG_HOME;
    delete process.env.WORKBENCH_PG_PORT;
  }

  // ---------- 6) 逃生开关 WORKBENCH_NO_AUTOSTART_PG=1 ----------
  {
    process.env.WORKBENCH_PG_PORT = String(await freePort());
    // 故意**给一个不存在的包路径**：如果开关没生效，日志会出现"找不到便携包"。
    process.env.WORKBENCH_PG_HOME = path.join(os.tmpdir(), 'no-such-pg-home-' + Date.now());
    process.env.WORKBENCH_NO_AUTOSTART_PG = '1';
    const logs = [];
    const r = await mod.ensurePostgres((m) => logs.push(m));
    check('WORKBENCH_NO_AUTOSTART_PG=1 时返回 false', r === false, String(r));
    check('开关生效时日志写明"已被 WORKBENCH_NO_AUTOSTART_PG 关闭"',
      logs.some((l) => l.includes('WORKBENCH_NO_AUTOSTART_PG') && l.includes('关闭')),
      logs.join(' | ').slice(0, 160));
    check('★ 开关**短路在**找包之前（没有"找不到便携包"日志）',
      !logs.some((l) => l.includes('找不到本机 PostgreSQL 便携包')),
      logs.join(' | ').slice(0, 160));
    delete process.env.WORKBENCH_NO_AUTOSTART_PG;
    delete process.env.WORKBENCH_PG_HOME;
    delete process.env.WORKBENCH_PG_PORT;
  }

  // ---------- 7) 陈旧 postmaster.pid 必须被清掉（否则 PG 静默拒启动） ----------
  {
    const home = makeFakePgHome('stale');
    cleanups.push(home);
    const pidFile = path.join(home, 'data', 'postmaster.pid');
    // 造一个几乎不可能存在的 PID
    const bogus = 999999;
    fs.writeFileSync(pidFile, `${bogus}\n127.0.0.1\n5432\n`);

    const srv = await listen(0);          // 先占住端口…（下面立刻关掉）
    const port = srv.port;
    await srv.close();                    // …再关掉，得到"确定没人听"的端口

    process.env.WORKBENCH_PG_PORT = String(port);
    process.env.WORKBENCH_PG_HOME = home;

    const logs = [];
    const p = mod.ensurePostgres((m) => logs.push(m));
    // 让它跑完 clearStalePid + spawn，再打开端口让轮询成功收尾（否则要等 90s）
    await sleep(800);
    const opened = await listen(port);
    const r = await p;

    check('★ 陈旧 pid 被识别并清掉',
      logs.some((l) => l.includes('清掉陈旧 postmaster.pid')), logs.join(' | ').slice(0, 200));
    check('陈旧 pid 文件确实从磁盘上消失了', !fs.existsSync(pidFile));
    check('端口起来后 ensurePostgres 返回 true', r === true, String(r));
    check('★ 拉起日志用的是我们指定的端口（不是写死的 5432）',
      logs.some((l) => l.includes(`${port} 不通，自动拉起`)),
      logs.join(' | ').slice(0, 200));
    await opened.close();
    delete process.env.WORKBENCH_PG_HOME;
    delete process.env.WORKBENCH_PG_PORT;
  }

  // ---------- 8) 活着的 pid 不许动（删了会真搞坏正在启动的 PG） ----------
  {
    const home = makeFakePgHome('alive');
    cleanups.push(home);
    const pidFile = path.join(home, 'data', 'postmaster.pid');

    // 起一个真活着、会活到我们杀它的进程，拿它的 pid 当"活着的 PG"
    const live = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
    cleanups.push(() => { try { live.kill(); } catch { /* ignore */ } });
    await sleep(300);
    fs.writeFileSync(pidFile, `${live.pid}\n127.0.0.1\n5432\n`);

    const port = await freePort();
    process.env.WORKBENCH_PG_PORT = String(port);
    process.env.WORKBENCH_PG_HOME = home;

    const logs = [];
    const p = mod.ensurePostgres((m) => logs.push(m));
    await sleep(800);
    const opened = await listen(port);
    const r = await p;

    check('★ 活着的 pid 明确"不动它"',
      logs.some((l) => l.includes('还活着') && l.includes('不动它')), logs.join(' | ').slice(0, 200));
    check('★ 活着的 pid 文件必须还在（没被误删）', fs.existsSync(pidFile));
    check('★ 不该出现"清掉陈旧"（那是误删）',
      !logs.some((l) => l.includes('清掉陈旧')), logs.join(' | ').slice(0, 200));
    check('活 pid 场景下仍能等到端口并返回 true', r === true, String(r));
    await opened.close();
    delete process.env.WORKBENCH_PG_HOME;
    delete process.env.WORKBENCH_PG_PORT;
  }

  // ---------- 9) 并发去重：同时来 3 次，只应拉起一次 ----------
  {
    const home = makeFakePgHome('concurrent');
    cleanups.push(home);
    const port = await freePort();
    process.env.WORKBENCH_PG_PORT = String(port);
    process.env.WORKBENCH_PG_HOME = home;

    const logs = [];
    const p = Promise.all([
      mod.ensurePostgres((m) => logs.push(m)),
      mod.ensurePostgres((m) => logs.push(m)),
      mod.ensurePostgres((m) => logs.push(m)),
    ]);
    await sleep(800);
    const opened = await listen(port);
    const rs = await p;

    const startLogs = logs.filter((l) => l.includes('自动拉起 PostgreSQL')).length;
    check('★ 并发 3 次**恰好**拉起一次（没有各起一份）', startLogs === 1, `拉起日志 ${startLogs} 条`);
    check('并发 3 次都拿到同一个 true', rs.length === 3 && rs.every((x) => x === true),
      JSON.stringify(rs));
    await opened.close();
    delete process.env.WORKBENCH_PG_HOME;
    delete process.env.WORKBENCH_PG_PORT;
  }

  // ---------- 10) 主进程真的按「先库后服务端」调用它（源码层） ----------
  {
    const mainTs = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'electron', 'main.ts'), 'utf8');
    check('main.ts 引入了 ensurePostgres',
      /import\s*\{[^}]*ensurePostgres[^}]*\}\s*from\s*'\.\/server-supervisor'/.test(mainTs));
    check('main.ts 在 whenReady 里调用了 ensurePostgres', /ensurePostgres\(/.test(mainTs));
    // ★ 顺序：必须先库后服务端 —— 服务端启动时会 migrate，库没起就白跑
    const iPg = mainTs.indexOf('ensurePostgres(');
    const iSrv = mainTs.indexOf('ensureServer(undefined');
    check('★ 顺序正确：ensurePostgres 在 ensureServer 之前',
      iPg > -1 && iSrv > -1 && iPg < iSrv, `pg@${iPg} srv@${iSrv}`);
  }

  // ---------- 11) 服务端 migrate 带重试 ----------
  {
    const idx = fs.readFileSync(path.join(REPO, 'apps', 'server', 'src', 'index.ts'), 'utf8');
    check('服务端有 migrateWithRetry', /migrateWithRetry/.test(idx));
    check('migrateWithRetry 是后台跑（void 调用，不 await）', /void\s+migrateWithRetry\(/.test(idx));
    check('migrateWithRetry 有重试上限常量', /MAX_TRIES/.test(idx));
    check('★ 旧写法（只 migrate 一次 + 静默降级）已移除',
      !/try\s*\{\s*await\s+migrate\(pool\);[\s\S]{0,200}?catch[\s\S]{0,200}?暂未连通/.test(idx));
  }

  for (const c of cleanups) {
    try { typeof c === 'function' ? c() : fs.rmSync(c, { recursive: true, force: true }); }
    catch { /* ignore */ }
  }

  console.log('=== pg-supervisor-tests ===');
  for (const p of PASS) console.log('  ✓ ' + p);
  for (const f of FAIL) console.log('  ✗ ' + f);
  console.log(`\n通过 ${PASS.length} / 失败 ${FAIL.length}`);
  process.exit(FAIL.length ? 1 : 0);
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(2);
});
