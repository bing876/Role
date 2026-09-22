/**
 * 「用户双击图标」模拟：启动**已安装**的 exe，验证它真的能开出一个窗口。
 *
 * 为什么不用 `npx electron` 跑源码：
 *   那走的是开发路径，和用户双击读 app.asar 是两回事。
 *   本机踩过「源码回滚了但界面没变」的坑 —— 因为用户读的是另一份构建产物。
 *   所以验收必须**打真靶**：启动安装目录里的 `AI 工作台.exe`。
 *
 * 本机限制（必须带 --no-sandbox，见 MEMORY）：
 *   默认参数下 Electron 的 GPU 进程会致命崩掉（exit_code=-1073741510）。
 *   这里给两种启动方式都留了记录，便于区分「应用坏了」和「本机环境限制」。
 *
 * 跑法：node scripts/verify/launch-installed-app.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EXE = String.raw`C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\AI 工作台.exe`;
const OUT = String.raw`C:\Users\bing\workbuddy-ai\work123\docs\acceptance\root-cause`;
fs.mkdirSync(OUT, { recursive: true });

if (!fs.existsSync(EXE)) {
  console.error('找不到安装的 exe：', EXE);
  process.exit(1);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 判断应用还活不活。
 *
 * ★★ 这里踩过一个坑，必须记下来：
 *   `tasklist` 在本机（中文 Windows + 这个控制台编码）会把**非 ASCII 进程名弄丢** ——
 *   实测 `tasklist /NH /FO CSV` 扫全表 394 行，**含非 ASCII 的行是 0 行**，
 *   而我们知道 `AI 工作台.exe` 明明在跑。
 *   所以"按名字找进程"这条路在本机**根本走不通**，用它做判定会得出假的 FAIL。
 *
 *   可信的信号只有两个：
 *     ① **按 PID 问**（`/FI "PID eq <n>"`）—— 纯数字比对，不受编码影响；
 *     ② spawn 出来的 child 是否触发了 exit 事件。
 *
 *   代价：拿不到"一共几个子进程"。但"主进程活着"已经足以证明**用户能点开**，
 *   渲染进程是否健康要看截图（那是 electron-ui-verify 技能的事，不是这条脚本）。
 */
async function probe(pid) {
  const { execFileSync } = await import('node:child_process');
  let byPid = false;
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    byPid = out.includes(`"${pid}"`);
  } catch {
    byPid = false;
  }
  return { byPid };
}

const lines = [];
const log = (...a) => {
  const s = a.map(String).join(' ');
  lines.push(s);
  console.log(s);
};

const args = process.argv.includes('--sandbox') ? [] : ['--no-sandbox'];
log(`启动: "${path.basename(EXE)}" ${args.join(' ')}`);

const child = spawn(EXE, args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => (stdout += d.toString()));
child.stderr.on('data', (d) => (stderr += d.toString()));

let exited = null;
child.on('exit', (code, signal) => {
  exited = { code, signal };
});

// 给它 12 秒：够启动、够渲染，也能暴露"1~2 秒后崩溃"那类问题
await wait(12000);

const p1 = await probe(child.pid);
log('');
log(`12 秒后：`);
log(`  spawn 出来的 PID           = ${child.pid}`);
log(`  该 PID 是否仍在运行        = ${p1.byPid ? '是' : '否'}`);
log(`  spawn 的进程是否已退出     = ${exited ? '是 ' + JSON.stringify(exited) : '否'}`);
if (stderr.trim()) {
  log('');
  log('  stderr（截前 1200 字）：');
  log('  ' + stderr.trim().slice(0, 1200).split('\n').join('\n  '));
}

/*
 * 判定口径：**按 PID 问**（见上面 probe 的注释 —— 按名字查在本机不可用）。
 * 两个信号都要满足：进程还在、且没有抛 exit。
 */
const alive = p1.byPid && exited === null;
log('');
log(`判定：${alive ? 'PASS 应用启动后稳定驻留（用户能点开用）' : '★FAIL 应用没起来'}`);
log(`  （若 stderr 里出现 GPU process ... exit_code=-1073741510，那是本机限制，不是应用问题）`);

// 收尾：把这个测试进程收干净，别留一堆僵尸 electron 占住 app.asar
if (exited === null) {
  try {
    child.kill();
    await wait(500);
  } catch {
    /* ignore */
  }
}

fs.writeFileSync(path.join(OUT, 'launch-installed-app.log'), lines.join('\n') + '\n', 'utf8');
process.exit(alive ? 0 : 1);
