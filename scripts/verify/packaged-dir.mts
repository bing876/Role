/** 片⑤ · 只在 `npm run package:dir` 成功后运行：从真正的 unpacked 目录
 * 用里面的 Electron 可执行文件（RunAsNode fuse）起真正的 server 资源，首跑建库并重启。
 * 这不是 GUI 安装/签名/可视化验收；目标 OS 上应由 CI/真机各运行一次。
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { preparePackagedRuntime } from '../../apps/desktop/electron/packaged-runtime';

const release = resolve(import.meta.dirname, '../../apps/desktop/release');
const product = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../apps/desktop/package.json'), 'utf8')).build.productName as string;
function locate(): { executable: string; resources: string } {
  if (process.platform === 'darwin') {
    const candidates = readdirSync(release).filter((name) => name.startsWith('mac'));
    assert.equal(candidates.length, 1, '只接受一个 mac 目录包');
    const apps = readdirSync(join(release, candidates[0])).filter((name) => name.endsWith('.app'));
    assert.deepEqual(apps, [`${product}.app`]);
    const app = join(release, candidates[0], apps[0], 'Contents');
    return { executable: join(app, 'MacOS', product), resources: join(app, 'Resources') };
  }
  const dir = join(release, process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked');
  const files = readdirSync(dir).filter((name) => {
    const file = join(dir, name);
    if (!statSync(file).isFile()) return false;
    if (process.platform === 'win32') return name === `${product}.exe`;
    return !name.includes('sandbox') && !name.includes('crashpad') && (statSync(file).mode & 0o111) !== 0;
  });
  assert.equal(files.length, 1, '安装目录应有且只有一个应用可执行入口');
  return { executable: join(dir, files[0]), resources: join(dir, 'resources') };
}

const { executable, resources } = locate();
assert.ok(existsSync(executable), '打包目录可执行文件不存在');
const scratch = mkdtempSync(join(tmpdir(), 'ai-workbench-unpacked-'));
let child: ChildProcess | null = null;
let logs = '';
try {
  const userData = join(scratch, 'userData');
  const first = preparePackagedRuntime(userData, resources);
  assert.ok(first.serverDir.startsWith(resources), '只能从真正包目录读取服务端');
  assert.ok(!existsSync(join(first.serverDir, '.env')), '安装目录不能含 .env');
  const port = await new Promise<number>((ok, fail) => {
    const server = createServer(); server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => ok(port));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const launch = (env: Record<string, string>) => {
    logs = '';
    const proc = spawn(executable, [join(resources, 'server/dist/index.js')], {
      cwd: join(resources, 'server'),
      env: { ...process.env, ...env, PORT: String(port), ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '', NODE_PATH: '' },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-4000); });
    proc.stderr?.on('data', (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-4000); });
    proc.on('error', (err) => { logs = (logs + err.message).slice(-4000); });
    child = proc;
  };
  const ready = async (empty: boolean) => {
    const deadline = Date.now() + 70_000;
    while (Date.now() < deadline) {
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null || child.killed)
        throw Error(`安装目录二进制提前退出：${logs}`);
      try {
        const health = await fetch(base + '/health', { signal: AbortSignal.timeout(2000) });
        const body = await health.json() as { service: string; db: string };
        if (body.service === 'ai-workbench-server' && body.db === 'up') {
          const res = await fetch(base + '/auth/onboarding');
          if (res.ok && (await res.json() as { available: boolean }).available === empty) return;
        }
      } catch { /* 迁移/首次 PGlite initdb 还在进行 */ }
      await delay(450);
    }
    throw Error(`安装目录二进制/数据库未就绪：${logs}`);
  };
  const stop = async () => {
    const proc = child; child = null;
    if (!proc || proc.exitCode !== null) return;
    const wait = new Promise<void>((ok) => proc.once('exit', () => ok()));
    proc.kill();
    await Promise.race([wait, delay(12_000, undefined, { ref: false }).then(() => { throw Error('包内进程无法停机'); })]);
  };

  launch(first.serverEnv);
  await ready(true);
  const denied = await fetch(base + '/auth/onboarding', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'packaged-password' }) });
  assert.equal(denied.status, 403);
  const created = await fetch(base + '/auth/onboarding', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbench-bootstrap-secret': first.bootstrapSecret },
    body: JSON.stringify({ password: 'packaged-password' }) });
  assert.equal(created.status, 200, `包内首跑建号失败：${logs}`);
  const session = await created.json() as { token: string; user: { xyz_id: string } };
  assert.match(session.user.xyz_id, /^XYZ\d{5,7}$/);
  await stop();
  assert.ok(existsSync(join(userData, 'local-runtime', 'db')), '包内 PGlite 没写到私有 userData');

  const second = preparePackagedRuntime(userData, resources);
  assert.equal(second.serverEnv.DATA_KEY, first.serverEnv.DATA_KEY);
  assert.notEqual(second.bootstrapSecret, first.bootstrapSecret);
  launch(second.serverEnv);
  await ready(false);
  const login = await fetch(base + '/auth/login/xyz', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ xyz: session.user.xyz_id, password: 'packaged-password' }) });
  assert.equal(login.status, 200, `包内重启后无法登录：${logs}`);
  const me = await fetch(base + '/auth/me', { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(me.status, 200, '包内重启后旧 JWT 不可用');
  await stop();
  console.log('目录包 PASS 3 / FAIL 0（实际包内 Electron-as-Node 可执行文件 + resources/server + 首跑 PGlite/建号 + 重启；不代表 GUI/安装器真机验收）');
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const proc = child;
    const wait = new Promise<void>((ok) => proc.once('exit', () => ok()));
    proc.kill();
    await Promise.race([wait, delay(3000, undefined, { ref: false })]);
  }
  rmSync(scratch, { recursive: true, force: true });
}
