/**
 * `npm run live` —— 一条命令起整套桌面工作台，自动登录并停在**登录后的工作台界面**。
 *
 * 这个文件是**薄启动器**：真正的起栈 / 登录 / 截图的逻辑在
 * `scripts/verify/live-demo.py` 里（用 Python 驱动 CDP，已验证稳定）。
 *
 * 为什么不把逻辑直接写在这里：
 *   本项目根 node_modules 里**没有 `ws` 包**，而 Node 原生 WebSocket 在这台机器的
 *   Electron CDP 上会「连上但收不到 id 回包」（Runtime.enable 直接超时）。
 *   Python 侧用的是 `websocket-client`，已经在 UI-1 的 101 条验收里反复用稳了。
 *   所以这里只负责「找 Python → 传参 → 转达输出」，不重写一遍驱动。
 *
 * 用法：
 *   npm run live                # 起栈 → 登录 → 截图 → 自动收尾退出
 *   npm run live -- --keep      # 同上，但窗口**留着**，Ctrl+C 结束
 *
 * 端口：默认全部走独立端口（后端 8788 / vite 5274 / CDP 9334），
 * 不碰你已经在跑的 8787 / 5173。可用环境变量覆盖：WB_API_PORT / WB_VITE_PORT / WB_CDP_PORT。
 *
 * ⚠️ 关于「窗口能不能一直开着」：
 *   如果这个命令是在 agent 会话里被工具拉起的，子进程会随工具任务回收一起被杀
 *   （实测：启动正常、登录成功，约 60~80 秒后静默 code=1 退出，日志无异常）。
 *   想真正长期开着，请**在你自己的终端**里跑 `npm run live -- --keep`。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'verify', 'live-demo.py');

/** 找可用的 Python：优先本机托管环境（装了 websocket-client），再退回 PATH。 */
const CANDIDATES = [
  process.env.WB_PYTHON,
  'C:/Users/bing/.workbuddy/binaries/python/envs/default/Scripts/python.exe',
  'C:/Users/bing/.workbuddy-ai/binaries/python/versions/3.13.12/python.exe',
].filter(Boolean);

const python = CANDIDATES.find((p) => existsSync(p)) || 'python';

const args = [SCRIPT];
if (process.argv.includes('--keep')) args.push('--keep');
if (process.argv.includes('--no-keep')) args.push('--no-keep');

console.log(`[live] python = ${python}`);
console.log(`[live] 脚本   = ${SCRIPT}`);

const child = spawn(python, args, {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    WB_API_PORT: process.env.WB_API_PORT || '8788',
    WB_VITE_PORT: process.env.WB_VITE_PORT || '5274',
    WB_CDP_PORT: process.env.WB_CDP_PORT || '9334',
  },
});

child.on('exit', (code, signal) => {
  if (signal) console.log(`[live] 被信号 ${signal} 结束`);
  process.exit(code ?? 0);
});
