/**
 * 片⑤：安装包本地运行态。只在 app.isPackaged 的主进程调用；不 import Electron，
 * 所以可用独立临时 userData 验证，不需要 Chromium / 真机窗口。
 *
 * 密钥只在 userData 私有目录，绝不回退到仓库 .env、示例常量或重新生成旧库的钥匙。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from 'node:fs';
import path from 'node:path';

type Keys = { version: 1; dataKey: string; jwtSecret: string; phonePepper: string };
export interface PackagedRuntime {
  serverDir: string;
  /** 只给 Electron 的服务端子进程。不要打印、不要发往 renderer。 */
  serverEnv: Record<string, string>;
  /** 仅供主进程→本机服务端首跑建号使用（每次进程启动重新生成）。 */
  bootstrapSecret: string;
}
const valid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const privateMode = (file: string, mask: number): void => {
  const stat = lstatSync(file);
  if (!stat.isDirectory() && !stat.isFile() || stat.isSymbolicLink()) throw new Error('本地运行态路径不是普通文件或目录');
  if (process.platform !== 'win32' && (stat.mode & mask) !== 0) throw new Error('本地运行态权限过宽，请检查 userData');
};

/** 创建新安装的随机钥匙，或只读原钥匙；任意损坏直接失败，不覆盖旧密文。 */
function loadKeys(directory: string): Keys {
  const file = path.join(directory, 'local-runtime.json');
  if (!existsSync(file)) {
    const keys: Keys = {
      version: 1,
      dataKey: randomBytes(32).toString('hex'),
      jwtSecret: randomBytes(32).toString('hex'),
      phonePepper: randomBytes(32).toString('hex'),
    };
    // wx 阻止并发覆盖；首次写失败可能留下部分文件，下次必须 fail-closed，由用户修复/恢复备份。
    const fd = openSync(file, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(keys)}\n`, 'utf8'); }
    finally { closeSync(fd); }
  }
  privateMode(file, 0o077);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 4096) throw new Error('本地密钥文件无效（或过大）');
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error('本地密钥文件损坏；不会覆盖原有数据库或重新生成密钥'); }
  const keys = parsed as Partial<Keys> | null;
  if (!keys || keys.version !== 1 || !valid(keys.dataKey) || !valid(keys.jwtSecret) || !valid(keys.phonePepper) ||
      keys.dataKey === keys.jwtSecret || keys.dataKey === keys.phonePepper || keys.jwtSecret === keys.phonePepper)
    throw new Error('本地密钥文件损坏；不会覆盖原有数据库或重新生成密钥');
  return keys as Keys;
}

export function preparePackagedRuntime(userData: string, resourcesPath: string): PackagedRuntime {
  const serverDir = path.join(resourcesPath, 'server');
  // 文件缺失时绝不误扫开发者的工作区，不能一边用安装包 GUI、一边用旧仓库后端。
  for (const asset of ['package.json', 'dist/index.js', 'node_modules/@electric-sql/pglite/package.json',
    'node_modules/@electric-sql/pglite/dist/pglite.wasm', 'node_modules/@electric-sql/pglite/dist/initdb.wasm',
    'node_modules/@electric-sql/pglite/dist/pglite.data', 'node_modules/@ai-workbench/shared/dist/index.js']) {
    if (!existsSync(path.join(serverDir, asset))) throw new Error(`安装包缺少后端资源：${asset}`);
  }
  const privateDir = path.join(userData, 'local-runtime');
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  privateMode(privateDir, 0o077);
  const databaseDir = path.join(privateDir, 'db');
  if (existsSync(databaseDir) && !existsSync(path.join(privateDir, 'local-runtime.json')))
    throw new Error('本地数据库还在但密钥文件缺失；不会重新生成密钥或覆盖旧数据');
  const keys = loadKeys(privateDir);
  const bootstrapSecret = randomBytes(32).toString('hex');
  return {
    serverDir,
    bootstrapSecret,
    serverEnv: {
      DATABASE_URL: `pglite://${databaseDir}`,
      DATA_KEY: keys.dataKey,
      JWT_SECRET: keys.jwtSecret,
      PHONE_PEPPER: keys.phonePepper,
      WORKBENCH_LOCAL_MODE: '1',
      WORKBENCH_BOOTSTRAP_SECRET: bootstrapSecret,
      NODE_ENV: 'production',
      SMS_MOCK: '0',
      ENABLE_DEV_MOCK_LLM: '0', // 不能继承开发机 shell 里的假模型开关
      PORT: '8787',
    },
  };
}
