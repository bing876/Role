/** 片⑤：为 electron-builder extraResources/server 准备可独立运行的 Node 服务。
 * 不拷 .env / test / tsx / 开发仓库；生产依赖用独立 lock `packaging/package-lock.json`。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(dir, '..');
const root = path.resolve(desktop, '../..');
const stage = path.join(desktop, 'packaging');
const require = createRequire(import.meta.url);
const declared = { ...require(path.join(root, 'apps/server/package.json')).dependencies };
delete declared['@ai-workbench/shared']; // 编译共享包作为包内文件直接复制，不走未发布的 npm workspace
const frozen = require(path.join(stage, 'package.json')).dependencies;
if (JSON.stringify(Object.entries(declared).sort()) !== JSON.stringify(Object.entries(frozen).sort()))
  throw Error('packaging/package.json 与服务端生产依赖不同步；先更新 staging lock，再打包');

for (const asset of [path.join(root, 'apps/server/dist/index.js'), path.join(root, 'packages/shared/dist/index.js')]) {
  if (!existsSync(asset)) throw Error(`缺少构建产物：${asset}（先运行 npm run build）`);
}
// Windows Node 22 的 spawnSync(..., 'npm.cmd') 不会像交互式 shell 一样解析 .cmd，
// 必须调用当前 npm CLI 的 JS 入口；stage 为独立锁文件，cwd 指向它而不是主 workspace。
const cli = process.env.npm_execpath;
const npmRunner = cli && existsSync(cli) ? process.execPath : process.platform === 'win32' ? 'cmd.exe' : 'npm';
const ciArgs = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
const args = cli && existsSync(cli) ? [cli, ...ciArgs]
  : process.platform === 'win32' ? ['/d', '/s', '/c', `npm ${ciArgs.join(' ')}`] : ciArgs;
const installed = spawnSync(npmRunner, args, { cwd: stage, stdio: 'inherit', windowsHide: true });
if (installed.error || installed.status !== 0) throw Error(`生产依赖 npm ci 失败：${installed.error?.message ?? installed.status}`);

// 仅清理此脚本生成的 staging 内容；用户原有安装包/源码/数据库一个字节也不碰。
const dist = path.join(stage, 'dist');
rmSync(dist, { recursive: true, force: true });
cpSync(path.join(root, 'apps/server/dist'), dist, { recursive: true });
const shared = path.join(stage, 'node_modules/@ai-workbench/shared');
mkdirSync(path.dirname(shared), { recursive: true });
cpSync(path.join(root, 'packages/shared/dist'), path.join(shared, 'dist'), { recursive: true });
cpSync(path.join(root, 'packages/shared/package.json'), path.join(shared, 'package.json'));
for (const asset of [
  'dist/index.js', 'node_modules/@ai-workbench/shared/dist/index.js',
  'node_modules/@electric-sql/pglite/dist/pglite.wasm',
  'node_modules/@electric-sql/pglite/dist/initdb.wasm',
  'node_modules/@electric-sql/pglite/dist/pglite.data',
]) if (!existsSync(path.join(stage, asset))) throw Error(`打包后端资源缺失：${asset}`);
console.log('[release] server dist + locked production deps + shared + PGlite data/WASM staged (no .env)');
