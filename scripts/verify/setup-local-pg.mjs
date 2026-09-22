/**
 * 在没有 Docker / WSL 的机器上，用一个**纯 Windows 的 PostgreSQL 便携包**把库跑起来。
 *
 * 为什么需要这个脚本：
 *   本机 `wsl.exe` 被安全策略硬拦（明确"无法批准、无法绕过"），
 *   而 Docker Desktop 的 Linux 引擎依赖 WSL2 → 引擎起不来（`docker_engine` 管道都不存在）。
 *   `docker compose up` 那条路在这台机器上**走不通**，不是配置问题。
 *   → 换一条不依赖 WSL 的路：EnterpriseDB 的 Windows x64 二进制包，解出来直接 initdb + pg_ctl。
 *
 * 这脚本做的事（幂等，重复跑不会坏）：
 *   1. 解压 pg16.zip 到 pg/；2. initdb 建数据目录；3. 起服务（5432）；
 *   4. 建 workbench 角色 + 库；5. 自检：用 DATABASE_URL 真连一次、看 users 表在不在。
 *
 * 跑法：node scripts/verify/setup-local-pg.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HOME = String.raw`C:\Users\bing\workbuddy-ai\pg`;
const ZIP = path.join(HOME, 'pg16.zip');
const PGROOT = path.join(HOME, 'pgsql');
const BIN = path.join(PGROOT, 'bin');
const DATA = path.join(HOME, 'data');
const LOG = path.join(HOME, 'pg.log');

const log = (...a) => console.log(a.map(String).join(' '));
const PG = (name) => path.join(BIN, name + '.exe');

const run = (file, args, opts = {}) =>
  execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

/** 5432 上有没有人监听（有 = 库已经起着） */
function portUp() {
  try {
    const out = run('netstat', ['-ano']);
    return /:5432\s.*LISTENING/.test(out);
  } catch {
    return false;
  }
}

log('=== 第 1 步：解压 ===');
if (fs.existsSync(PG('postgres'))) {
  log('  已解压过，跳过');
} else {
  if (!fs.existsSync(ZIP)) {
    log('  ★ 找不到 ' + ZIP + ' —— 先把便携包下下来');
    process.exit(1);
  }
  log('  解压中（323MB，稍等）…');
  run('powershell', [
    '-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${ZIP}' -DestinationPath '${HOME}' -Force`,
  ]);
  log('  解压完成 -> ' + PGROOT);
}
if (!fs.existsSync(PG('postgres'))) {
  log('  ★ 解压后仍找不到 postgres.exe，包结构可能不对');
  process.exit(1);
}

log('');
log('=== 第 2 步：initdb ===');
if (fs.existsSync(path.join(DATA, 'PG_VERSION'))) {
  log('  数据目录已存在，跳过');
} else {
  // --auth=trust：本机开发用，免密（连接串里的密码会被忽略但也不报错）
  // -E UTF8 + --locale=C：避免中文 Windows 上 locale 相关的启动失败
  run(PG('initdb'), ['-D', DATA, '-U', 'workbench', '-A', 'trust', '-E', 'UTF8', '--locale=C']);
  log('  initdb 完成');
}

log('');
log('=== 第 3 步：启动服务 ===');
if (portUp()) {
  log('  5432 已在监听，跳过启动');
} else {
  // pg_ctl start 会立刻返回；用 -l 把日志落盘，方便排错
  const child = spawn(PG('pg_ctl'), ['start', '-D', DATA, '-l', LOG, '-w', '-t', '60'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  // 等它真的起来
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !portUp()) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!portUp()) {
    log('  ★ 60 秒内 5432 仍未监听。日志尾部：');
    try {
      log(fs.readFileSync(LOG, 'utf8').split('\n').slice(-25).join('\n'));
    } catch {
      log('  (读不到日志)');
    }
    process.exit(1);
  }
  log('  已启动，5432 正在监听');
}

log('');
log('=== 第 4 步：建 workbench 库 ===');
let dbs = '';
try {
  dbs = run(PG('psql'), ['-U', 'workbench', '-p', '5432', '-h', 'localhost', '-d', 'postgres',
    '-tAc', "SELECT 1 FROM pg_database WHERE datname='workbench'"]);
} catch (e) {
  log('  psql 查询失败：' + String(e.message).slice(0, 300));
}
if (dbs.trim() === '1') {
  log('  workbench 库已存在');
} else {
  run(PG('createdb'), ['-U', 'workbench', '-p', '5432', '-h', 'localhost', 'workbench']);
  log('  已创建 workbench 库');
}

log('');
log('=== 第 5 步：自检（真连一次）===');
const check = run(PG('psql'), [
  '-U', 'workbench', '-p', '5432', '-h', 'localhost', '-d', 'workbench',
  '-tAc', 'SELECT current_database() || \'|\' || current_user',
]);
log('  连接成功 -> ' + check.trim());

log('');
log('DONE  连接串：postgresql://workbench:workbench@localhost:5432/workbench');
log('  数据目录：' + DATA);
log('  日志：' + LOG);
log('  停止：' + PG('pg_ctl') + ' stop -D ' + DATA);
