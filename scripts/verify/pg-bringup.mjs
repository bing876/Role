/**
 * 在没有 Docker / WSL 的 Windows 机器上，用**精简版 PostgreSQL 二进制**把库跑起来。
 *
 * 背景（为什么不能用 docker compose）：
 *   本机 `wsl.exe` 被安全策略硬拦（明确"无法批准、无法绕过"），
 *   而 Docker Desktop 的 Linux 引擎依赖 WSL2 → 引擎起不来（`docker_engine` 管道都不存在）。
 *   `docker compose up` 这条路在这台机器上**走不通**。
 *   → 换一条不依赖 WSL 的路：zonky 的 Windows 嵌入式 PG（22MB jar，解开就是 binaries）。
 *
 * ★ 为什么用 node spawn 而不是 bash 直接跑：
 *   Git Bash 执行这些 .exe 会报 `Exec format error`（shell 兼容问题，不是二进制坏了——
 *   文件头确实是 MZ）。node 的 spawn 走 Win32 API，能正常拉起来。
 *
 * 幂等：重复跑不会破坏已有数据目录。
 *
 * 跑法：node scripts/verify/pg-bringup.mjs [initdb|start|status|stop]
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const HOME = String.raw`C:\Users\bing\workbuddy-ai\pg2`;
const BIN = path.join(HOME, 'pg', 'bin');
const DATA = path.join(HOME, 'data');
const LOG = path.join(HOME, 'pg.log');

const exe = (n) => path.join(BIN, `${n}.exe`);
const log = (...a) => console.log(a.map(String).join(' '));

/** 跑一个 exe，返回 {code, out, err} —— 用 spawnSync 拉，避开 Git Bash 的 Exec format error */
function runExe(name, args, timeoutMs = 90000) {
  const r = spawnSync(exe(name), args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    code: r.status ?? -1,
    out: (r.stdout || '').toString(),
    err: (r.stderr || '').toString(),
    signal: r.signal,
  };
}

/** 5432 是否可连（比 netstat 更直接：真的 TCP 握手） */
function portOpen(port = 5432, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

const cmd = process.argv[2] || 'all';

if (cmd === 'initdb' || cmd === 'all') {
  log('=== initdb ===');
  if (fs.existsSync(path.join(DATA, 'PG_VERSION'))) {
    log('  数据目录已存在，跳过');
  } else {
    fs.mkdirSync(DATA, { recursive: true });
    const r = runExe('initdb', [
      '-D', DATA,
      '-U', 'workbench',
      '-A', 'trust',
      '-E', 'UTF8',
      '--locale=C',
      // 注意：不要加 --pwfile —— 它会挂住等 stdin。
      // -A trust（免密）下根本不需要密码文件。
    ], 120000);
    log('  exit code =', r.code, r.signal ? '(signal ' + r.signal + ')' : '');
    if (r.out.trim()) log('  stdout:\n' + r.out.split('\n').slice(-15).map((l) => '    ' + l).join('\n'));
    if (r.err.trim()) log('  stderr:\n' + r.err.split('\n').slice(-15).map((l) => '    ' + l).join('\n'));
    if (r.code !== 0) process.exit(1);
    log('  ✓ initdb 完成');
  }
}

if (cmd === 'start' || cmd === 'all') {
  log('');
  log('=== 启动 postgres ===');
  if (await portOpen()) {
    log('  5432 已在监听，跳过');
  } else {
    // -l 落盘日志；detached 让它活过本进程
    const child = spawn(exe('pg_ctl'), ['start', '-D', DATA, '-l', LOG, '-w', '-t', '60'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    const deadline = Date.now() + 60000;
    let up = false;
    while (Date.now() < deadline) {
      if (await portOpen()) {
        up = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!up) {
      log('  ★ 60 秒内 5432 未起来。日志尾部：');
      try {
        log(fs.readFileSync(LOG, 'utf8').split('\n').slice(-30).join('\n'));
      } catch {
        log('  （读不到日志）');
      }
      process.exit(1);
    }
    log('  ✓ 已启动，5432 监听中');
  }
}

if (cmd === 'status' || cmd === 'all') {
  log('');
  log('=== 状态 ===');
  log('  5432 可连:', (await portOpen()) ? '是' : '否');
}
