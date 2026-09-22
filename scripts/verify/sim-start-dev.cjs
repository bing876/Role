// sim-start-dev.cjs —— 在**单次进程内**完整模拟 start-dev.cmd 的四步流程并验证。
//
// 为什么需要它：agent 工具调用一结束，派生进程会被全部回收，
// 所以我不能在调用 A 里起 PG、再到调用 B 里验证（PG 那时已经死了）。
// 必须在同一个进程里「起 → 等 → 验 → 报」一气呵成。
//
// 用法：node scripts/verify/sim-start-dev.cjs
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

const HOME = process.env.USERPROFILE || 'C:\\Users\\bing';
const PG_HOME = path.join(HOME, 'workbuddy-ai', 'pg2');
const PG_BIN = path.join(PG_HOME, 'pg', 'bin');
const PG_DATA = path.join(PG_HOME, 'data');
const PG_LOG = path.join(PG_HOME, 'pg.log');
const REPO = path.resolve(__dirname, '..', '..');
const NODE = process.execPath;

const out = [];
const say = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function portOpen(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// 直接 SELECT 1（不依赖外部脚本，省得再踩路径坑）
async function dbQueryable() {
  const { Client } = require(path.join(REPO, 'node_modules', 'pg'));
  const c = new Client({
    connectionString: 'postgresql://workbench:workbench@localhost:5432/workbench',
  });
  try {
    await c.connect();
    await c.query('SELECT 1');
    await c.end();
    return { ok: true };
  } catch (e) {
    try { await c.end(); } catch {}
    return { ok: false, err: String(e && e.message ? e.message : e).split('\n')[0] };
  }
}

(async () => {
  // ---------- [1/4] 清陈旧 pid ----------
  const pidFile = path.join(PG_DATA, 'postmaster.pid');
  if (fs.existsSync(pidFile)) {
    const first = fs.readFileSync(pidFile, 'utf8').split('\n')[0].trim();
    let alive = false;
    try {
      const r = spawn.sync('tasklist', ['/FI', `PID eq ${first}`, '/NH', '/FO', 'CSV']);
      alive = r.stdout.toString().includes(`"${first}"`);
    } catch {}
    say(`[1/4] 发现 postmaster.pid（PID=${first}），进程存活=${alive}`);
    if (!alive) {
      fs.unlinkSync(pidFile);
      say('      该进程已不存在 → 删除 pid 文件');
    } else {
      say('      进程仍在运行 → （脚本会 pg_ctl stop -m fast）此处直接复用');
    }
  } else {
    say('[1/4] 无 pid 残留');
  }

  // ---------- [2/4] 起 PG ----------
  if (await portOpen(5432)) {
    say('[2/4] 5432 已在监听，跳过启动');
  } else {
    say('[2/4] 启动 PostgreSQL...');
    const pg = spawn(path.join(PG_BIN, 'postgres.exe'), ['-D', PG_DATA], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    pg.unref();
    say(`      已 spawn，PID=${pg.pid}`);
    let opened = false;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      if (await portOpen(5432)) { opened = true; say(`      端口 5432 就绪（${i + 1}s）`); break; }
    }
    if (!opened) {
      say('      ✗ 90 秒内 5432 没起来。pg.log 末尾：');
      try {
        const t = fs.readFileSync(PG_LOG, 'utf8').trim().split('\n').slice(-8).join('\n');
        say(t);
      } catch {}
      fs.writeFileSync(path.join(REPO, 'docs', 'acceptance', 'root-cause', 'sim-start-dev.log'), out.join('\n'));
      process.exit(1);
    }
  }

  // ---------- 等库真正可查询（★ 端口通 != 可用） ----------
  say('      等待数据库真正接受查询...');
  let q = null, waited = 0;
  for (let i = 0; i < 240; i++) {
    q = await dbQueryable();
    waited = i + 1;
    if (q.ok) break;
    await sleep(1000);
  }
  if (q.ok) say(`      ✓ 数据库可接受查询（${waited}s）`);
  else say(`      ✗ ${waited}s 后仍不可查询：${q.err}`);

  // ---------- [3/4] 起服务端 ----------
  say('[3/4] 检查 8787...');
  if (await portOpen(8787)) {
    say('      8787 已在监听（可能是应用自己拉起的）');
  } else {
    if (!q.ok) {
      say('      ✗ 库还不可用，跳过起服务端（起了也会降级）');
      fs.writeFileSync(path.join(REPO, 'docs', 'acceptance', 'root-cause', 'sim-start-dev.log'), out.join('\n'));
      process.exit(1);
    }
    say('      启动服务端...');
    const srv = spawn(NODE,
      [path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
      { cwd: path.join(REPO, 'apps', 'server'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    srv.stdout.on('data', d => out.push('[srv] ' + d.toString().trimEnd()));
    srv.stderr.on('data', d => out.push('[srv!] ' + d.toString().trimEnd()));
    let up = false;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      if (await portOpen(8787)) { up = true; break; }
    }
    say(up ? '      服务端端口就绪' : '      ✗ 60s 内 8787 没起来');
  }

  // ---------- [4/4] 验证 /health db=up ----------
  say('[4/4] 轮询 /health...');
  let hp = null;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch('http://127.0.0.1:8787/health');
      hp = await r.json();
      if (hp.db === 'up') break;
    } catch {}
    await sleep(1000);
  }
  say('      /health = ' + JSON.stringify(hp));
  say('');
  say(hp && hp.db === 'up' && hp.service === 'ai-workbench-server'
    ? '=== 结论：链路完好，可以登录（双击 start-dev.cmd 后打开应用）==='
    : '=== 结论：链路有问题，见上 ===');

  fs.writeFileSync(path.join(REPO, 'docs', 'acceptance', 'root-cause', 'sim-start-dev.log'), out.join('\n') + '\n', 'utf8');
  process.exit(0);
})();
