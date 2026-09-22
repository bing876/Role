/**
 * 服务端守护：让「后端没起」这件事从**报错**变成**自动修好**。
 *
 * 背景（用户实际遇到过的现象）：
 *   桌面端与服务端是**两个独立进程**，桌面端自己不打包也不拉起服务端
 *   （见项目 MEMORY：架构边界）。所以只要服务端没在跑，
 *   桌面端就停在登录页、红字写「连不上后端 http://127.0.0.1:8787」。
 *   重启电脑后尤其容易撞上 —— 用户得记得手动去跑 `npm run dev:server`。
 *
 * 这个模块做的事：
 *   ① 探测 8787 通不通；
 *   ② 不通就**后台拉起**服务端；
 *   ③ 关应用时，**只停我们自己拉起的那一份**。
 *
 * ★ 三条自我约束（都是刻意的设计决定，别改坏）：
 *
 *   1. **绝不碰用户手动起的服务端。**
 *      如果 8787 上本来就有服务端（探测通），我们一个字节都不动它 ——
 *      不接管、不重启、退出时也不杀。只有「我们 spawn 出来的那个 child 进程」
 *      才会被我们 kill。靠记 child 句柄来保证，不靠 PID 猜。
 *
 *   2. **起的是构建产物 `node dist/index.js`，不是 `tsx watch`。**
 *      普通用户双击应用时不该依赖 devDependencies（tsx）和源码目录。
 *      产物不在就退回 tsx（开发者机器上通常有），两者都没有才放弃并如实报告。
 *
 *   3. **失败不阻塞窗口。**
 *      拉不起来就照常开窗，让登录页显示它本来那句红字（那是准确的），
 *      同时把真实原因打到日志。**不弹 Modal 挡住用户**、不假装成功。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import os from 'node:os';
import type * as fs from 'node:fs';
import path from 'node:path';

/** 默认后端地址（与渲染层 `API_BASE()` 的默认值保持一致）。 */
const DEFAULT_API_BASE = 'http://127.0.0.1:8787';

/** 探测 /health 的单次超时：localhost 不该慢，2 秒足够。 */
const PROBE_TIMEOUT_MS = 2000;

/** 轮询等待服务端就绪的总时长（数据库迁移在冷启动时会占几秒）。 */
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 500;

/** 我们亲手 spawn 出来的服务端进程。null = 没起过 / 已经退出。 */
let ownedServer: ChildProcess | null = null;

/**
 * 是否**曾经**在 8787 上看到过一个「不是我们起的」服务端（用户手动开的 / 上一次留下的）。
 *
 * ★ 这个标志是必需的：`ensureServer` 一启动就被调用，而主窗口 / 内嵌页
 *   可能各自触发一次；没有它就会**同时**探测（都探不到，因为服务端还没起来），
 *   于是**并发 spawn 两个服务端** —— 第二个必然 EADDRINUSE 崩掉，
 *   日志会呈现"服务端起来了又崩了"的假象（跟 execPath 那个坑的表现一模一样）。
 *
 * ★★ 它**只用来去重**，绝不能用来「永久认定后端可用」（2026-09-19 踩到）：
 *   原来 `ensureServer` 开头写着 `if (externalServerSeen) return true;` —— 连 probe
 *   都不做。后果：只要启动时 8787 上碰巧有任何东西在监听（比如别的排查进程、
 *   上一次没退干净的旧服务端），应用就把它记成「后端可用」并**从此不再检查**。
 *   那个进程后来死了，应用也不知情、更不会自愈 → 用户点登录一路失败，
 *   而应用自认为一切正常。现在改成**只做去重 + 每次重新探活**（见 ensureServer）。
 */
let externalServerSeen = false;

/** 进行中的 ensureServer 调用：并发的调用方共享同一次结果，不再各起一份。 */
let inflight: Promise<boolean> | null = null;

/** 服务端就绪后，下次探测的宽限期（避免刚起来就被自己误判为"通了但不是我"）。 */
const RECENT_READY_MS = 60_000;
let lastReadyAt = 0;

/**
 * 是否允许自动拉起。
 *
 * 默认开；`WORKBENCH_NO_AUTOSTART_SERVER=1` 可关掉（联调 / 排障用）。
 * ★ 故意**不**做成 settings 里的可调项：那是 shared 的 WorkbenchSettings，
 *   加一个字段要动共享类型 + 默认值 + 区间表，为一个逃生开关不值得。
 *   真要长期关掉，用环境变量就够了。
 */
const enabled = process.env.WORKBENCH_NO_AUTOSTART_SERVER !== '1';

/** 服务端就绪后回调（用于把状态告诉渲染层）。 */
type StateListener = (state: ServerState) => void;
const listeners = new Set<StateListener>();

export interface ServerState {
  /** 8787 现在通不通 */
  reachable: boolean;
  /** 这一次是不是我们自己拉起来的 */
  ownedByUs: boolean;
  /** 最近一次失败原因（成功时为 null） */
  lastError: string | null;
}

let state: ServerState = { reachable: false, ownedByUs: false, lastError: null };

function setState(patch: Partial<ServerState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) {
    try {
      fn(state);
    } catch {
      /* 监听者自己出错不影响主流程 */
    }
  }
}

export function getServerState(): ServerState {
  return state;
}

export function onServerState(fn: StateListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 探测一次后端是否可用。任何异常都当成「不可用」，不往外抛。
 *
 * ★★ 只回 200 是不够的（2026-09-19 踩到）：8787 上任何一个返回 200 的东西
 *   （别的调试进程、静态站、随便一个 mock）都会被当成"后端已就绪"，
 *   于是应用不再拉起真正的服务端，之后所有 /auth 请求全打到一个不懂业务的进程上。
 *   所以这里**必须核对身份**：/health 的响应体里要看得到本服务的标识。
 */
export async function probe(apiBase: string = DEFAULT_API_BASE): Promise<boolean> {
  const url = `${apiBase.replace(/\/+$/, '')}/health`;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) return false;
      const body = (await res.json().catch(() => null)) as { service?: unknown } | null;
      // 服务端 index.ts 里 /health 会带 service:'ai-workbench-server'。
      return body?.service === 'ai-workbench-server';
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** 一个候选位置（服务端目录 + 用来找 node / 依赖的仓库根）。 */
interface ServerLocation {
  serverDir: string;
  repoRoot: string;
}

/** 常见盘符，用于「开发机目录扫描」兜底。 */
const COMMON_DRIVES = ['C:', 'D:', 'E:', 'F:', 'G:', 'H:'];

/** 一个位置是否真的能当服务端跑（有构建产物或源码入口，外加一个可用的启动方式）。 */
function isValidServerDir(serverDir: string): boolean {
  if (!existsSync(path.join(serverDir, 'package.json'))) return false;
  return (
    existsSync(path.join(serverDir, 'dist', 'index.js')) ||
    existsSync(path.join(serverDir, 'src', 'index.ts'))
  );
}

/**
 * 判断一个目录「像不像仓库根」：有 apps/<name>，且那个 apps 目录里确实有料。
 * 只做**正判**（命中即返回），不做反向排除 —— 免得误判把真仓库漏掉。
 */
function looksLikeRepoRoot(dir: string, serverDirName: string): boolean {
  const serverDir = path.join(dir, 'apps', serverDirName);
  return isValidServerDir(serverDir);
}

/**
 * 一个目录是否**不该**往下递归（明显的系统 / 依赖 / 缓存目录）。
 *
 * ★ 白名单反过来做（只往「像工作区的目录」里钻）在实测中漏掉了本仓库：
 *   真实路径是 `C:\Users\bing\workbuddy-ai\work123` —— `bing` 和 `workbuddy-ai`
 *   都不在"Users/Projects/Code"这类名单里，两级都进不去。
 *   所以这里改成**黑名单**：禁止往系统与依赖目录里钻，其余都允许（有深度上限兜底）。
 */
const SKIP_DIR = /^(\.|node_modules$|AppData$|Application Data$|\$Recycle\.Bin$|System Volume Information$|Windows$|Program Files( \(x86\))?$|ProgramData$|Recovery$|PerfLogs$|OneDriveTemp$|Tencent$|leidian$|WeGameApps$|XboxGames$|inetpub$|KRECYCLE$|BitCenter$|KABU-Codex-Test$|Documents and Settings$|All Users$|Default User$|desktop\.ini$|pagefile\.sys$|swapfile\.sys$|DumpStack\.log(\.tmp)?$|hiberfil\.sys$|config\.msi$|pagefile\.sys$)/i;

/** 递归深度上限。仓库根到 apps/server 只差 1 级，4 级足够覆盖 `D:\code\xxx\repo` 这类布局。 */
const SCAN_MAX_DEPTH = 4;

/** 递归时最多访问多少个目录（防止在超大磁盘上跑成"卡住"）。 */
const SCAN_MAX_VISITS = 4000;

/**
 * 在常见盘符里**广度优先**找「像本仓库根」的目录。
 *
 * ★ 为什么需要扫描：用户桌面上的那份应用是**从 app.asar 拷贝跑的**，
 *   它不在仓库里 —— `__dirname` 是 `...\resources\app.asar\dist-electron`，
 *   往上一级是 `app.asar` 文件本身（不是目录），默认推导必然落空。
 *   而本项目的实际用法就是「开发机 + 已安装应用」并存，所以必须能找回仓库。
 *
 * 找不到不报错（只是慢一点 + 走「不可拉起」分支如实报告），所以：
 *   - 黑名单跳过系统/依赖目录（见 SKIP_DIR）
 *   - 有深度上限与访问上限，最坏情况也只是多花几十毫秒
 *   - 命中即返回，不做全盘遍历
 *
 * 判定一律走 isValidServerDir（要有 package.json + dist/index.js 或 src/index.ts），
 * 不靠目录名猜 —— 免得把别的项目的 `apps/server` 误认成我们的。
 */
function scanForRepo(serverDirName: string): ServerLocation | null {
  const rootDirs: string[] = [];
  for (const d of COMMON_DRIVES) {
    try {
      readdirSync(`${d}\\`);
      rootDirs.push(`${d}\\`);
    } catch {
      /* 盘不存在 / 没权限 */
    }
  }

  let visits = 0;
  // 广度优先：一层层往外扩，先近后远，命中即停。
  let frontier: Array<{ dir: string; depth: number }> = rootDirs.map((dir) => ({ dir, depth: 0 }));

  while (frontier.length > 0 && visits < SCAN_MAX_VISITS) {
    const next: Array<{ dir: string; depth: number }> = [];
    for (const { dir, depth } of frontier) {
      // ① 先判这个目录本身是不是仓库根
      if (looksLikeRepoRoot(dir, serverDirName)) {
        const serverDir = path.join(dir, 'apps', serverDirName);
        return { serverDir, repoRoot: dir };
      }
      // ② 到了深度上限就不再往下
      if (depth >= SCAN_MAX_DEPTH) continue;

      let entries: fs.Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      visits += 1;
      for (const ent of entries) {
        if (!ent.isDirectory()) continue; // 只钻目录（符号链接不算，避免成环）
        if (SKIP_DIR.test(ent.name)) continue;
        next.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * 找到服务端目录与仓库根。按「确定性」从高到低依次尝试：
 *
 *   ① 显式环境变量 `WORKBENCH_REPO_ROOT` —— 最可靠，用户/脚本可指定；
 *   ② 默认推导（as 源码树运行：dist-electron 的 ../.. 就是仓库根）；
 *   ③ 常见盘符扫描兜底（as.asar 拷贝运行：推导必然落空，只能扫）。
 *
 * 全部失败返回 null → 走「不可拉起」分支（如实报告，不假装成功）。
 * 结果会缓存（仓库位置不会在进程生命周期内变），扫描只发生一次。
 */
let dirsCache: ServerLocation | null | undefined;
function findDirs(): ServerLocation | null {
  if (dirsCache !== undefined) return dirsCache;

  // ① 环境变量优先
  const explicit = process.env.WORKBENCH_REPO_ROOT;
  if (explicit) {
    const serverDir = path.join(explicit, 'apps', 'server');
    if (isValidServerDir(serverDir)) {
      dirsCache = { serverDir, repoRoot: explicit };
      return dirsCache;
    }
  }

  const appRoot = path.resolve(__dirname, '..');

  // ② 默认推导：dist-electron → apps/desktop → 仓库根
  {
    const repoRoot = path.resolve(appRoot, '..', '..');
    const serverDir = path.join(repoRoot, 'apps', 'server');
    if (isValidServerDir(serverDir)) {
      dirsCache = { serverDir, repoRoot };
      return dirsCache;
    }
  }

  // ③ 盘符扫描兜底（as.asar 拷贝运行的场景）
  dirsCache = scanForRepo('server');
  return dirsCache;
}

/** 供测试 / 排障：清掉位置缓存，让下一次 findDirs 重新计算。 */
export function resetDirCache(): void {
  dirsCache = undefined;
}

/**
 * 找到可用的 **node 可执行文件**。
 *
 * ★★ 这里是本模块最阴的一个坑，务必看懂再改：
 *
 *   **绝不能用 `process.execPath` 去起服务端。**
 *   在 Electron 进程里 `process.execPath` 指向的是 **`electron.exe` 自己**，
 *   不是 node。拿它 spawn 结果就是**又起了一个 Electron 实例**：
 *   那个实例在本机会因为 GPU 沙箱问题崩溃（FATAL:gpu_process_host... Goodbye，
 *   退出码 2147483651），日志还跟服务端输出混在一起 ——
 *   真实故障现象是：**看日志像"服务端起来了又崩了"，实际上服务端压根没跑过**，
 *   8787 自始至终不通。（第一版就是这么写的，单测全绿、真机必挂。）
 *
 *   为什么单测没发现：单测是在**纯 Node** 下 require 这个模块的，
 *   那时 `process.execPath` 确实是 node.exe —— 环境不同，行为不同。
 *   教训：凡是依赖 `process.execPath` / `process.versions.electron` 这类
 *   **运行宿主相关**的值，单测必须补一条"在 Electron 里跑"的真机验证。
 *
 * 优先 `ELECTRON_RUN_AS_NODE` 语义下可用的自身；取不到再去找系统 node。
 */
function findNodeBinary(serverDir: string, repoRoot: string): string | null {
  // ① Electron 自带「以 node 模式运行」的能力：同一个可执行文件 + 这个环境变量
  //    会让 electron.exe 表现得像个纯 node（不初始化 Chromium，也就不会崩）。
  //    这是最稳的一条 —— 不依赖用户机器上装没装 node。
  if (process.versions.electron) {
    return process.execPath; // 配合下面 spawn 时注入 ELECTRON_RUN_AS_NODE=1
  }

  // ② 已经就是纯 node（单测 / CLI 场景）：直接用
  if (!process.versions.electron && /node(\.exe)?$/i.test(process.execPath)) {
    return process.execPath;
  }

  // ③ 兜底：常见的 node 安装位置
  const guesses = [
    path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'node.cmd' : 'node'),
    process.platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/local/bin/node',
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\nodejs\\node.exe' : '/usr/bin/node',
  ];
  for (const g of guesses) {
    if (existsSync(g)) return g;
  }
  void serverDir;
  return null;
}

/** 决定用什么命令起服务端：优先构建产物，退回 tsx。 */
function pickCommand(
  serverDir: string,
  repoRoot: string,
): { cmd: string; args: string[]; why: string; extraEnv: Record<string, string> } | null {
  const distEntry = path.join(serverDir, 'dist', 'index.js');
  if (existsSync(distEntry)) {
    const nodeBin = findNodeBinary(serverDir, repoRoot);
    if (nodeBin) {
      // 在 Electron 里跑时，必须让 electron.exe 以 node 模式启动（否则又变成起 Electron）
      const extraEnv: Record<string, string> =
        process.versions.electron && nodeBin === process.execPath
          ? { ELECTRON_RUN_AS_NODE: '1' }
          : {};
      const why = extraEnv.ELECTRON_RUN_AS_NODE
        ? 'electron.exe + ELECTRON_RUN_AS_NODE=1 跑 dist/index.js（构建产物）'
        : 'node dist/index.js（构建产物）';
      return { cmd: nodeBin, args: [distEntry], why, extraEnv };
    }
  }

  const srcEntry = path.join(serverDir, 'src', 'index.ts');
  if (!existsSync(srcEntry)) return null;

  // ★ tsx 的位置**两处都要找**：npm workspaces 会把依赖**提升到仓库根**的
  //   node_modules/.bin，所以 apps/server/node_modules/.bin/tsx 在本机并不存在
  //   （实测：只有 node_modules/.bin/tsx 有）。只查 server 包内会误判「没有 tsx」。
  const candidates = [
    path.join(serverDir, 'node_modules', '.bin', 'tsx'),
    path.join(repoRoot, 'node_modules', '.bin', 'tsx'),
  ];
  for (const base of candidates) {
    for (const ext of process.platform === 'win32' ? ['.cmd', ''] : ['']) {
      const p = base + ext;
      if (existsSync(p)) {
        return { cmd: p, args: ['watch', srcEntry], why: `tsx watch src/index.ts（${p}）`, extraEnv: {} };
      }
    }
  }
  return null;
}

/**
 * 确保后端可用：通就直接返回；不通就拉起来并等它就绪。
 *
 * @returns 就绪=true；拉不起来=false（**不抛异常**，调用方照常开窗）
 */
export async function ensureServer(
  apiBase: string = DEFAULT_API_BASE,
  log: (msg: string) => void = () => {},
): Promise<boolean> {
  // ① 我们自己拉起来的那个还活着且刚就绪过 → 直接返回，不再探测、不再 spawn。
  //    （这一条是安全的短路：`ownedServer` 是我们自己的 child 句柄，
  //      它没退出就说明进程真的还在；且 60 秒内刚探测通过，没必要反复打。）
  if (ownedServer && Date.now() - lastReadyAt < RECENT_READY_MS) {
    return true;
  }

  // ② 并发去重：多个调用方同时进来时共享第一次的结果。
  //    没有这一步，探测 → 拉起之间会有竞态，可能起出两份服务端。
  if (inflight) return inflight;
  inflight = doEnsureServer(apiBase, log).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doEnsureServer(
  apiBase: string,
  log: (msg: string) => void,
): Promise<boolean> {
  // ★★ 每次都要**真的探一次**，不能因为"以前见过外部服务端"就跳过。
  //
  // 这里曾经写成 `if (externalServerSeen) return true;`（连 probe 都不做），
  // 结果把「启动那一刻有个东西在 8787 上监听」当成了永久事实：
  // 那个进程一死，应用仍报 reachable=true，不自愈也不报错，用户登录一律失败。
  // 现在 probe 是无条件的，`externalServerSeen` 退化成纯粹的日志/状态区分用。
  if (await probe(apiBase)) {
    if (!externalServerSeen) {
      log('[server-supervisor] 8787 已有服务端在跑，直接用（不接管、退出时也不动它）。');
    }
    externalServerSeen = true;
    setState({ reachable: true, ownedByUs: false, lastError: null });
    return true;
  }

  // 走到这里说明 8787 现在**确实不通**（不管以前见过谁）—— 该自愈就自愈。
  if (externalServerSeen) {
    log('[server-supervisor] 之前见过的外部服务端已不在 8787 上（可能已退出），改为自动拉起。');
    externalServerSeen = false;
  }
  lastReadyAt = 0;

  if (!enabled) {
    log('[server-supervisor] 自动拉起已被 WORKBENCH_NO_AUTOSTART_SERVER 关闭，跳过。');
    setState({ reachable: false, ownedByUs: false, lastError: '自动拉起已被环境变量关闭' });
    return false;
  }

  const dirs = findDirs();
  if (!dirs) {
    const msg = '找不到 apps/server 目录（打包环境？）—— 无法自动拉起，请手动启动服务端。';
    log(`[server-supervisor] ${msg}`);
    setState({ reachable: false, ownedByUs: false, lastError: msg });
    return false;
  }
  const { serverDir, repoRoot } = dirs;

  const picked = pickCommand(serverDir, repoRoot);
  if (!picked) {
    const msg = 'apps/server 下既没有 dist/index.js 也没有可用的 tsx —— 无法自动拉起。';
    log(`[server-supervisor] ${msg}`);
    setState({ reachable: false, ownedByUs: false, lastError: msg });
    return false;
  }

  log(`[server-supervisor] 8787 不通，自动拉起：${picked.why}`);
  try {
    // detached:false —— 让它挂在本进程的子进程表里，
    // 应用退出时我们才管得住它（Windows 上 detached 会另开进程组，反而更难清）。
    const child = spawn(picked.cmd, picked.args, {
      cwd: serverDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      // extraEnv 里是 ELECTRON_RUN_AS_NODE=1（在 Electron 里跑时必需，
      // 否则又起一个 Electron、必崩）。见 findNodeBinary 的注释。
      // ★ 同时**必须清掉** VITE_DEV_SERVER_URL：那是给渲染层指向 vite 的，
      //   服务端拿到它没有意义，但继承下去会让某些路径误判"这是 dev 桌面进程"。
      env: { ...process.env, ...picked.extraEnv, VITE_DEV_SERVER_URL: '' },
      windowsHide: true,
    });
    ownedServer = child;

    // 服务端日志透传到主进程控制台，便于排查（前缀区分，免得跟 Electron 日志混）
    const relay = (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      if (text) log(`[server] ${text}`);
    };
    child.stdout?.on('data', relay);
    child.stderr?.on('data', relay);

    child.on('exit', (code, signal) => {
      log(`[server-supervisor] 服务端退出：code=${code} signal=${signal ?? '无'}`);
      if (ownedServer === child) {
        ownedServer = null;
        setState({ reachable: false, ownedByUs: false });
      }
    });
    child.on('error', (err) => {
      log(`[server-supervisor] 拉起失败：${err.message}`);
      if (ownedServer === child) ownedServer = null;
    });
  } catch (err) {
    const msg = `拉起异常：${(err as Error).message}`;
    log(`[server-supervisor] ${msg}`);
    setState({ reachable: false, ownedByUs: false, lastError: msg });
    return false;
  }

  // 等它就绪（数据库迁移 + 建表在冷启动时要几秒）
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe(apiBase)) {
      log('[server-supervisor] ✅ 服务端已就绪。');
      lastReadyAt = Date.now();
      setState({ reachable: true, ownedByUs: true, lastError: null });
      return true;
    }
    // 进程已经死了就别再干等
    if (!ownedServer) break;
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }

  const msg = `等了 ${READY_TIMEOUT_MS / 1000} 秒后端仍未就绪（详见上方 [server] 日志）。`;
  log(`[server-supervisor] ⚠️ ${msg}`);
  setState({ reachable: false, ownedByUs: false, lastError: msg });
  return false;
}

/**
 * 退出时收尾：**只杀我们自己拉起的那一个**。
 *
 * 用户手动起的服务端（ownedByUs=false / ownedServer=null）一根汗毛都不碰。
 */
export function stopOwnedServer(log: (msg: string) => void = () => {}): void {
  const child = ownedServer;
  if (!child) {
    log('[server-supervisor] 没有自己拉起的服务端，无需收尾。');
    return;
  }
  ownedServer = null;
  log(`[server-supervisor] 收尾：停掉我们自己拉起的服务端（pid=${child.pid}）。`);
  try {
    if (process.platform === 'win32' && child.pid) {
      // Windows 上 tsx/node 常带子进程，taskkill /T 连子孙一起收，避免留孤儿。
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      child.kill('SIGTERM');
    }
  } catch (err) {
    log(`[server-supervisor] 收尾失败（不影响退出）：${(err as Error).message}`);
  }
}

/* ===========================================================================
 * PostgreSQL 守护（2026-09-20 新增）
 *
 * 为什么需要它（用户实际报的现象）：
 *   用户填好手机号 + 验证码点登录 → 红字「数据库没连上」。
 *   实测：8787 上跑着**我们自己的**服务端（身份标识正确、自愈也没问题），
 *   但 `/health` 报 `db:"down"` —— 因为 **5432 上根本没有 PostgreSQL**。
 *
 *   服务端能自愈、数据库不能，于是「打开应用就能登录」这件事仍然不成立：
 *   用户必须先记得去双击 start-dev.cmd，而且 PG 被关掉后没人把它拉起来。
 *   这一节就是把这个缺口补上，跟服务端自愈同一个思路。
 *
 * ★ 两条自我约束（与服务端一致）：
 *   1. **绝不碰用户手动起的 PG**：5432 通了就什么都不做。
 *   2. **退出时不杀 PG**：它是本机共享的数据库服务，不是应用的从属进程。
 *      杀掉它会让下次启动重新走 30 多秒的崩溃恢复，反而更糟。
 *      （服务端不同：那是我们 spawn 的、只服务本应用，所以退出要收尾。）
 *
 * ★ 已知限制（如实写在代码里，别假装没有）：
 *   这里只等「端口监听」，不等「真正能查询」。PG 崩溃恢复期间端口已开、
 *   但查询会报 `the database system is starting up`（实测空窗 ~32 秒）。
 *   服务端那边用「迁移带重试」兜住这个窗口（见 apps/server/src/index.ts），
 *   两边配合才算完整 —— 只做一边会在恢复窗口里翻车。
 * ========================================================================= */

/** PostgreSQL 默认端口。 */
const PG_DEFAULT_PORT = 5432;

/**
 * 当前要守护的 PostgreSQL 端口。
 *
 * 默认 5432；`WORKBENCH_PG_PORT` 可覆盖 —— 与 `WORKBENCH_PG_HOME` 同一个理由：
 * 换机器 / 起第二个实例 / 自动化测试需要换个端口时，不用改代码。
 *
 * ★ 故意**每次调用都重新读**，不在模块加载时固化成常量：
 *   测试要在同一个进程里换端口跑不同分支（模块级 const 只读一次就换不动了），
 *   而模块级状态（pgInflight）又必须同进程才能验到并发去重 —— 两者只能这样共存。
 */
export function getPgPort(): number {
  const raw = Number.parseInt(process.env.WORKBENCH_PG_PORT ?? '', 10);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : PG_DEFAULT_PORT;
}

/** 探测端口的单次超时：本机连接不该慢。 */
const PG_PROBE_TIMEOUT_MS = 1000;

/** 等 PostgreSQL 端口起来的时长（冷启动 + 崩溃恢复可能到 30 秒以上）。 */
const PG_READY_TIMEOUT_MS = 90_000;
const PG_POLL_INTERVAL_MS = 500;

/** 进行中的 ensurePostgres：并发调用共享同一次结果（同 ensureServer 的道理）。 */
let pgInflight: Promise<boolean> | null = null;

/**
 * PostgreSQL 便携包的位置。
 *
 * 默认 `~/workbuddy-ai/pg2`（本机的实际布局，见项目 MEMORY）。
 * `WORKBENCH_PG_HOME` 可覆盖 —— 换机器 / 换路径时不用改代码。
 */
export function getPgHome(): string {
  return process.env.WORKBENCH_PG_HOME || path.join(os.homedir(), 'workbuddy-ai', 'pg2');
}

/** TCP 探一个端口通不通。任何异常都当「不通」，不往外抛。 */
function isPortOpen(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port });
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * 某个 PID 是否真的活着。
 *
 * ★ 必须**按纯数字比对**：本机 `tasklist` 读不到非 ASCII 进程名
 *   （实测全表 394 行里含非 ASCII 的是 0 行，而「AI 工作台.exe」明明在跑），
 *   所以绝不能按进程名找进程。
 */
function isPidAlive(pid: number): boolean {
  try {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return (r.stdout ?? '').includes(`"${pid}"`);
  } catch {
    return false;
  }
}

/**
 * 清掉**陈旧的** `postmaster.pid`。
 *
 * ★ 这是本机 PG 最阴的一个坑：上次 postgres 被硬杀时不会自己清 pid 文件，
 *   下次启动 PG 看到它以为「实例已在运行」，于是**直接退出**，
 *   而且 `pg.log` 里连一行新日志都没有 —— 表现成"起了但没反应"，极难排查。
 *
 * 只有在 pid 里的进程**确实不存在**时才删；还活着就原样不动（那可能是
 * 一个正在启动中的 PG，删它的 pid 文件会真的搞坏它）。
 */
function clearStalePid(dataDir: string, log: (msg: string) => void): void {
  const pidFile = path.join(dataDir, 'postmaster.pid');
  if (!existsSync(pidFile)) return;

  let pid = 0;
  try {
    pid = Number.parseInt(readFileSync(pidFile, 'utf8').split('\n')[0].trim(), 10);
  } catch {
    /* 读不出来就当没有 */
  }

  if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) {
    log(`[pg-supervisor] postmaster.pid 里的进程 ${pid} 还活着 —— 不动它。`);
    return;
  }

  try {
    rmSync(pidFile, { force: true });
    log(
      `[pg-supervisor] 清掉陈旧 postmaster.pid（PID ${pid > 0 ? pid : '?'} 已不存在）——` +
        ` 否则 PostgreSQL 会静默拒绝启动。`,
    );
  } catch (err) {
    log(`[pg-supervisor] 清 pid 文件失败（不影响后续尝试）：${(err as Error).message}`);
  }
}

/**
 * 确保 PostgreSQL 可用：5432 通就直接返回；不通就拉起来并等端口就绪。
 *
 * @returns 可用=true；拉不起来=false（**不抛异常**，调用方照常开窗）
 */
export async function ensurePostgres(
  log: (msg: string) => void = () => {},
  /**
   * `quiet: true` = 只在**真的要动手**时才打日志。
   * 给「每 10 秒一次」的保活心跳用 —— 否则「已有 PostgreSQL 在跑」这句会每 10 秒刷一行，
   * 把真正有用的日志淹掉。
   */
  opts: { quiet?: boolean } = {},
): Promise<boolean> {
  const port = getPgPort();
  // ★ 每次都真的探一次（同 ensureServer 的教训）：不能因为"以前见过"就跳过。
  if (await isPortOpen(port, PG_PROBE_TIMEOUT_MS)) {
    if (!opts.quiet) {
      log(`[pg-supervisor] ${port} 已有 PostgreSQL 在跑，直接用（不接管、退出时也不动它）。`);
    }
    return true;
  }

  if (pgInflight) return pgInflight;
  pgInflight = doEnsurePostgres(log).finally(() => {
    pgInflight = null;
  });
  return pgInflight;
}

async function doEnsurePostgres(log: (msg: string) => void): Promise<boolean> {
  const port = getPgPort();

  if (process.env.WORKBENCH_NO_AUTOSTART_PG === '1') {
    log('[pg-supervisor] 自动拉起已被 WORKBENCH_NO_AUTOSTART_PG 关闭，跳过。');
    return false;
  }

  const home = getPgHome();
  const exe = path.join(home, 'pg', 'bin', 'postgres.exe');
  const dataDir = path.join(home, 'data');

  if (!existsSync(exe) || !existsSync(dataDir)) {
    log(
      `[pg-supervisor] 找不到本机 PostgreSQL 便携包（${exe}）—— 不自动拉起。` +
        ` 请先双击仓库根目录的 start-dev.cmd 起库。`,
    );
    return false;
  }

  // 先清陈旧 pid，否则 PG 会静默拒绝启动
  clearStalePid(dataDir, log);

  log(`[pg-supervisor] ${port} 不通，自动拉起 PostgreSQL：${exe} -D ${dataDir}`);
  try {
    // ★★ 这里**绝不能**加 `detached: true` —— 实测会**弹出控制台窗口**。
    //
    // 为什么（2026-09-20 实测，`scripts/verify/pg-launch-window-test.cjs`）：
    //   `postgres.exe` 是**控制台程序**。Node 的 `windowsHide` 会传 `CREATE_NO_WINDOW`，
    //   但 `detached: true` 在 Windows 上会带上 `DETACHED_PROCESS` —— 两者冲突，
    //   结果是 Windows **给 PG 新建一个控制台**，在 Win11 上由 Windows Terminal 承载，
    //   于是屏幕上多出一个黑窗（标题就是 postgres.exe 的路径）。
    //   实测：`detached:true + windowsHide:true` → 窗口 +1；**去掉 detached → 窗口 +0**。
    //
    // 「PG 要活过应用退出」这件事**不靠 detached**：Windows 不会因为父进程退出而杀掉子进程，
    //   加上 `unref()` 让事件循环不被它挂住就够了。
    //   （另外我们**从不主动杀 PG** —— 见 stopOwnedServer 只处理 ownedServer。）
    const child = spawn(exe, ['-D', dataDir], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    log(`[pg-supervisor] 拉起 PostgreSQL 失败：${(err as Error).message}`);
    return false;
  }

  const deadline = Date.now() + PG_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isPortOpen(port, PG_PROBE_TIMEOUT_MS)) {
      log(`[pg-supervisor] ✅ PostgreSQL 已就绪（${port} 已监听）。`);
      return true;
    }
    await new Promise((r) => setTimeout(r, PG_POLL_INTERVAL_MS));
  }

  log(
    `[pg-supervisor] ⚠️ 等了 ${PG_READY_TIMEOUT_MS / 1000} 秒 ${port} 仍未监听 ——` +
      ` 请双击 start-dev.cmd 手动起库。`,
  );
  return false;
}
