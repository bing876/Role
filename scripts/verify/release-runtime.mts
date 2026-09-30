/** 片⑤ · production path：staged server（脱离仓库 node_modules）+ Electron supervisor + 真持久 PGlite + 一次性建号。
 * 不依赖 Chromium/目标系统 GUI；包目录本身还须单独 package:dir/真机启动验收。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { preparePackagedRuntime } from '../../apps/desktop/electron/packaged-runtime';
import { ensureServer, getServerState, markLocalRuntimeUnavailable, probe, stopOwnedServer } from '../../apps/desktop/electron/server-supervisor';
import { makePool } from '../../apps/server/src/db';
import { loadEnv } from '../../apps/server/src/env';

const root = resolve(import.meta.dirname, '../..');
const stage = join(root, 'apps/desktop/packaging');
const build = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).build;
assert.equal(build.electronVersion, JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')).version, '包版本/本机源码版本不可不同');
assert.equal(build.win.target[0], 'nsis'); assert.equal(build.mac.target[0], 'dmg');
assert.equal(build.extraResources?.[0]?.from, 'packaging'); assert.equal(build.extraResources?.[0]?.to, 'server');
assert.ok(existsSync(join(stage, 'node_modules/@electric-sql/pglite/dist/pglite.wasm')));
assert.ok(!existsSync(join(stage, '.env')));
// electron-builder v26 的过滤器会在 `from=packaging` 时**无条件跳过**其根下 node_modules
// （即便写了 node_modules/**/*）！用它自己的真实 FileMatcher + copyFiles 装配隔离包内资源。
// 之前只 cpSync(stage) 的独立副本为绿，但 Win/mac 真实 --dir 目录都缺 pglite。
const builderRequire = createRequire(import.meta.url);
const { getFileMatchers, copyFiles } = builderRequire('app-builder-lib/out/fileMatcher') as {
  getFileMatchers: (config: unknown, name: string, to: string, options: unknown) => Array<{
    from: string; to: string; createFilter: () => (file: string, stat: ReturnType<typeof statSync>) => boolean;
  }>;
  copyFiles: (matchers: unknown) => Promise<void>;
};
const desktopDir = join(root, 'apps/desktop');
const matcherOptions = { defaultSrc: desktopDir, macroExpander: (v: string) => v,
  customBuildOptions: {}, globalOutDir: join(desktopDir, 'release') };
const targetResources = join(root, 'apps/desktop/release/probe/resources');
const matchers = getFileMatchers(build, 'extraResources', targetResources, matcherOptions);
for (const asset of [
  'node_modules/@electric-sql/pglite/package.json',
  'node_modules/@electric-sql/pglite/dist/pglite.wasm',
  'node_modules/@electric-sql/pglite/dist/initdb.wasm',
  'node_modules/@electric-sql/pglite/dist/pglite.data',
  'node_modules/@ai-workbench/shared/dist/index.js',
]) {
  const file = join(stage, asset);
  assert.ok(matchers.some((m) => m.from === join(stage, 'node_modules') &&
    m.to === join(targetResources, 'server/node_modules') && m.createFilter()(file, statSync(file))),
  `electron-builder 真实过滤器未纳入 ${asset}，安装目录缺后端依赖`);
}

let passed = 0;
const check = (message: string) => { console.log(`  ✓ ${message}`); passed++; };
const scratch = mkdtempSync(join(tmpdir(), 'ai-workbench-release-'));
const resources = join(scratch, 'resources');
const userData = join(scratch, 'userData');
function getPort(): Promise<number> {
  return new Promise((ok, fail) => { const s = createServer(); s.on('error', fail);
    s.listen(0, '127.0.0.1', () => { const port = (s.address() as { port: number }).port; s.close(() => ok(port)); }); });
}
const port = await getPort();
const base = `http://127.0.0.1:${port}`;
const get = async (route: string) => fetch(base + route);
const post = (route: string, password: string, secret?: string) => fetch(base + route, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-workbench-bootstrap-secret': secret } : {}) },
  body: JSON.stringify({ password }),
});
async function waitForOnboarding(available: boolean): Promise<void> {
  const end = Date.now() + 40_000;
  while (Date.now() < end) {
    try {
      const r = await get('/auth/onboarding');
      if (r.status === 200) {
        const j = await r.json() as { available: boolean; local: boolean };
        if (j.local && j.available === available) return;
      }
    } catch { /* migrate may still be starting */ }
    await delay(300);
  }
  throw Error(`本地后端建表/首跑状态超时（期望 available=${available}）`);
}
async function waitDown(): Promise<void> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) { if (!(await probe(base))) return; await delay(100); }
  throw Error('owned server did not stop');
}
let logs = '';
const relay = (s: string) => { logs += s.slice(-300); if (logs.length > 4000) logs = logs.slice(-4000); };
let active = false;
try {
  // 真调用 electron-builder 自己的复制实现，而非手写 cpSync 放宽过滤条件。
  await copyFiles(getFileMatchers(build, 'extraResources', resources, matcherOptions));
  for (const asset of [
    'package.json', 'dist/index.js', 'node_modules/@electric-sql/pglite/package.json',
    'node_modules/@electric-sql/pglite/dist/pglite.wasm',
    'node_modules/@electric-sql/pglite/dist/pglite.data',
    'node_modules/@ai-workbench/shared/dist/index.js',
  ]) assert.ok(existsSync(join(resources, 'server', asset)), `builder 真复制后仍缺 ${asset}`);
  assert.ok(!existsSync(join(resources, 'server/.env')));
  check('electron-builder 原生过滤器 + copyFiles 真复制后，PGlite/data/WASM/shared 都在包内');

  // 包资源缺失时优先失败，不创建任何 userData 密钥。
  assert.throws(() => preparePackagedRuntime(join(scratch, 'uncreated'), join(scratch, 'missing')),
    /安装包缺少后端资源/);
  assert.ok(!existsSync(join(scratch, 'uncreated/local-runtime')));
  check('缺包资源 fail-closed（不能扫描开发仓库，也不先生成密钥）');

  const runtime = preparePackagedRuntime(userData, resources);
  assert.equal(runtime.serverEnv.ENABLE_DEV_MOCK_LLM, '0', '生产安装包不能继承开发 shell 的模拟模型开关');
  const mockOverrides = { ...runtime.serverEnv, DEEPSEEK_API_KEY: 'mock:dev-only' };
  const previous = new Map<string, string | undefined>(Object.keys(mockOverrides)
    .map((key): [string, string | undefined] => [key, process.env[key]]));
  try {
    Object.assign(process.env, mockOverrides);
    assert.throws(() => loadEnv(), /安装包本地模式不能启用模拟模型/);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const keyFile = join(userData, 'local-runtime/local-runtime.json');
  const rawKeys = readFileSync(keyFile, 'utf8');
  const keys = JSON.parse(rawKeys) as { dataKey: string; jwtSecret: string; phonePepper: string };
  assert.equal(new Set(Object.values(keys).filter((v) => typeof v === 'string')).size, 3);
  if (process.platform !== 'win32') assert.equal((await import('node:fs')).statSync(keyFile).mode & 0o777, 0o600);
  const another = preparePackagedRuntime(join(scratch, 'other-user'), resources);
  assert.notEqual(another.serverEnv.DATA_KEY, runtime.serverEnv.DATA_KEY, '不能多台机器共享同一把 key');
  const restarted = preparePackagedRuntime(userData, resources);
  assert.equal(restarted.serverEnv.DATA_KEY, runtime.serverEnv.DATA_KEY);
  assert.notEqual(restarted.bootstrapSecret, runtime.bootstrapSecret, '临时引导口令每次进程随机更新');
  assert.equal(readFileSync(keyFile, 'utf8'), rawKeys);
  check('首跑私有目录 0700/密钥文件 0600；三把随机独立密钥、重启不变，bootstrap secret 不落盘');

  // 真实 supervisor 使用 app.isPackaged 所走的 runtime 分支，不是直接起另一个测试版服务。
  runtime.serverEnv.PORT = String(port);
  assert.equal(await ensureServer(base, relay, runtime), true, logs);
  active = true;
  await waitForOnboarding(true);
  const health = await (await get('/health')).json() as { db: string; sms: string; service: string };
  assert.equal(health.service, 'ai-workbench-server'); assert.equal(health.db, 'up'); assert.equal(health.sms, 'http');
  assert.equal(getServerState().ownedByUs, true);
  assert.equal(await (await post('/auth/onboarding', 'reasonable-password')).status, 403);
  assert.equal(await (await post('/auth/onboarding', 'reasonable-password', '0'.repeat(64))).status, 403);
  assert.equal(await (await post('/auth/onboarding', 'short', runtime.bootstrapSecret)).status, 400);
  assert.equal((await get('/auth/onboarding')).status, 200);
  check('独立包内服务真 HTTP+PGlite 建表；仅本机随机 secret 可建号，弱密码拒绝，生产 mock 短信关闭');

  const [a, b] = await Promise.all([
    post('/auth/onboarding', 'reasonable-password', runtime.bootstrapSecret),
    post('/auth/onboarding', 'reasonable-password', runtime.bootstrapSecret),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], `并发只能建一个账号，实际 ${a.status}/${b.status}`);
  const session = await (a.status === 200 ? a : b).json() as { token: string; user: { xyz_id: string; has_password: boolean; phone_masked: string | null }; project: { name: string }; agents: Array<{ name: string }> };
  assert.match(session.user.xyz_id, /^XYZ\d{5,7}$/);
  assert.equal(session.user.has_password, true);
  assert.equal(session.user.phone_masked, null);
  assert.equal(session.project.name, '默认项目');
  assert.equal(session.agents[0].name, '小助');
  assert.equal(await (await post('/auth/onboarding', 'another-password', runtime.bootstrapSecret)).status, 409);
  assert.deepEqual(await (await get('/auth/onboarding')).json(), { available: false, local: true });
  assert.ok(!rawKeys.includes(session.token));
  check('并发首跑只建一个带 scrypt 密码的 XYZ + 默认项目 + 小助；二次建号 409');

  stopOwnedServer(); active = false; await waitDown();
  // 子进程退出后直接读同一份持久 PGlite 文件（不是内存桩或仓库数据库）。
  const pool = makePool(runtime.serverEnv.DATABASE_URL);
  try {
    const u = await pool.query<{ xyz_id: string; password_hash: string; phone_hash: string | null; phone_enc: string | null }>('SELECT xyz_id, password_hash, phone_hash, phone_enc FROM users');
    assert.equal(u.rowCount, 1);
    assert.equal(u.rows[0].xyz_id, session.user.xyz_id);
    assert.ok(u.rows[0].password_hash.startsWith('scrypt$'));
    assert.equal(u.rows[0].phone_hash, null); assert.equal(u.rows[0].phone_enc, null);
    assert.ok(!u.rows[0].password_hash.includes('reasonable-password'));
    const p = await pool.query('SELECT id FROM projects WHERE is_default=true'); assert.equal(p.rowCount, 1);
    const agents = await pool.query<{ can_create_agents: boolean }>('SELECT can_create_agents FROM agents WHERE name=$1', ['小助']);
    assert.equal(agents.rows[0].can_create_agents, true);
    const messages = await pool.query('SELECT id FROM messages');
    assert.equal(messages.rowCount, 0, '首进不许自动写搭团队提议（历史老数据不删）');
  } finally { await pool.end(); }
  check('直接读真持久库：一个用户/项目/有建人权限的小助，无自动团队提议；密码只存 scrypt，手机号无明文');

  // 重启同一个包，数据库/签名 key 必须仍可复用（token 可验、密码可登）。
  restarted.serverEnv.PORT = String(port);
  assert.equal(await ensureServer(base, relay, restarted), true, logs);
  active = true;
  await waitForOnboarding(false);
  const login = await fetch(`${base}/auth/login/xyz`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ xyz: session.user.xyz_id, password: 'reasonable-password' }) });
  assert.equal(login.status, 200);
  const secondSession = await login.json() as { token: string; user: { xyz_id: string } };
  assert.equal(secondSession.user.xyz_id, session.user.xyz_id);
  for (const token of [session.token, secondSession.token]) {
    const me = await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(me.status, 200, '重启后旧 JWT 必须仍可验');
  }
  const secretAgain = readFileSync(keyFile, 'utf8'); assert.equal(secretAgain, rawKeys);
  check('真实子进程重启后旧 XYZ/密码能登录，旧库/密钥未覆盖');

  stopOwnedServer(); active = false; await waitDown();
  writeFileSync(keyFile, '{corrupted', 'utf8');
  assert.throws(() => preparePackagedRuntime(userData, resources), /密钥文件损坏/);
  writeFileSync(keyFile, rawKeys, 'utf8');
  // 用仅限临时样本的私有文件模拟丢钥匙；有 DB 必拒绝重新生成。
  rmSync(keyFile);
  assert.throws(() => preparePackagedRuntime(userData, resources), /密钥文件缺失/, 'missing_key_should_fail_closed');
  writeFileSync(keyFile, rawKeys, { mode: 0o600 });
  if (process.platform !== 'win32') {
    chmodSync(keyFile, 0o644);
    assert.throws(() => preparePackagedRuntime(userData, resources), /权限过宽/);
    chmodSync(keyFile, 0o600);
  }
  assert.equal(preparePackagedRuntime(userData, resources).serverEnv.DATA_KEY, runtime.serverEnv.DATA_KEY);
  check('坏/丢密钥及权限过宽一律 fail-closed，恢复原钥匙后数据不变');

  // 外部服务即使返回同一个 service 标记也不能被安装包当成自己的库（也不能 kill）。
  const occupiedPort = await getPort();
  const foreign = (await import('node:http')).createServer((_req, res) => {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ service: 'ai-workbench-server' }));
  });
  await new Promise<void>((ok) => foreign.listen(occupiedPort, '127.0.0.1', ok));
  try {
    assert.equal(await ensureServer(`http://127.0.0.1:${occupiedPort}`, relay, runtime), false);
    assert.equal(getServerState().ownedByUs, false);
    assert.equal((await fetch(`http://127.0.0.1:${occupiedPort}/health`)).status, 200);
  } finally { await new Promise<void>((ok) => foreign.close(() => ok())); }
  markLocalRuntimeUnavailable('本地运行态检查失败');
  assert.equal(getServerState().lastError, '本地运行态检查失败');
  check('外部占用端口不接管、不杀、不把别人的后端当本地数据库');

  console.log(`上线运行态 PASS ${passed} / FAIL 0（真 staging + 真子进程/PGlite；Win/mac 安装 GUI 另验）`);
} catch (err) {
  console.error(`上线运行态 FAIL ${passed}: ${(err as Error).stack ?? err}${logs ? `\nserver logs: ${logs.slice(-1000)}` : ''}`);
  process.exitCode = 1;
} finally {
  if (active) { stopOwnedServer(); await waitDown().catch(() => undefined); }
  rmSync(scratch, { recursive: true, force: true });
}
