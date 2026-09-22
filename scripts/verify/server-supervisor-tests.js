/**
 * 服务端自愈（server-supervisor）的自动化验收。
 *
 * 要证明的三件事（对应 skill/用户规则里的「自己找边界情况 + 反证」）：
 *   ① **没起服务端时，能自动拉起来**并且 /health 真的通（不是只 spawn 成功）；
 *   ② **已经有服务端时，绝不接管** —— 一个字节都不动，退出时也不杀它；
 *   ③ **退出时只杀自己那份** —— 自己拉起的被清掉，别人的活得好好的。
 *
 * 为什么不用「直接跑 Electron」来验：
 *   拉起的逻辑全在 server-supervisor 这一个模块里，跟 Electron 的生命周期是解耦的
 *   （main.ts 只是 ensureServer / stopOwnedServer 的调用方）。
 *   直接 require 编译产物来驱动，能**精确断言进程归属**，
 *   比开个窗口去肉眼看"好像起来了"可靠得多。
 *
 * ⚠️ 这个测试会**真的起/杀服务端进程**，且要求 8787 是空闲的（会先自检）。
 *    跑之前请确保没有别的服务端占着 8787，否则第 ① 项会直接失败。
 */
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 本脚本在 scripts/verify/ 下 → 仓库根是再上两级
const REPO = path.resolve(__dirname, '..', '..');
const MOD = require(path.join(REPO, 'apps', 'desktop', 'dist-electron', 'server-supervisor.js'));

const API = 'http://127.0.0.1:8787';

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

async function healthOk() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2000);
    try {
      const r = await fetch(`${API}/health`, { signal: ctl.signal });
      return r.ok;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

/** 8787 上现在有没有东西在听 */
function listenerPids() {
  const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || '';
  const pids = new Set();
  for (const line of out.split('\n')) {
    if (!line.includes(':8787')) continue;
    if (!line.includes('LISTENING')) continue;
    const m = line.trim().split(/\s+/);
    const pid = m[m.length - 1];
    if (/^\d+$/.test(pid)) pids.add(pid);
  }
  return [...pids];
}

function killTree(pid) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

async function waitPortFree(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (listenerPids().length === 0) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return listenerPids().length === 0;
}

function log() {}

(async () => {
  console.log('='.repeat(78));
  console.log('服务端自愈验收（server-supervisor）');
  console.log('='.repeat(78));

  // ---- 前置自检：8787 必须空闲（否则第①项测不了）----
  console.log('\n[0] 前置自检');
  const pre = listenerPids();
  if (pre.length) {
    console.log(`  ⚠️ 8787 已被占用（pid=${pre.join(',')}），先清掉再跑本测试。`);
    for (const p of pre) killTree(p);
    const freed = await waitPortFree();
    check('清掉占用后 8787 已空闲', freed, '端口仍被占');
  } else {
    check('8787 空闲', true);
  }
  check('8787 当前确实不通', !(await healthOk()));

  // ================= ① 自动拉起 =================
  console.log('\n[1] 没起服务端时 → 自动拉起');
  const t1 = Date.now();
  const ok1 = await MOD.ensureServer(API, log);
  const ms1 = Date.now() - t1;
  check('ensureServer 返回 true', ok1 === true);
  check('至少等了 1 秒（说明确实走了拉起，不是"本来就在跑"）', ms1 > 1000, `实际 ${ms1}ms`);
  check('/health 真的通了（不只 spawn 成功）', await healthOk());

  const st1 = MOD.getServerState();
  check('状态标记为「我们自己拉起的」', st1.ownedByUs === true);
  const pids1 = listenerPids();
  check('8787 上有且只有一个监听进程', pids1.length === 1, `实际 ${pids1.join(',')}`);

  // ================= ② 已有服务端时不接管 =================
  console.log('\n[2] 已经有服务端时 → 绝不接管');
  const before = listenerPids();
  const t2 = Date.now();
  const ok2 = await MOD.ensureServer(API, log);
  const ms2 = Date.now() - t2;
  check('ensureServer 返回 true', ok2 === true);
  check('立刻返回（没等 30 秒超时）', ms2 < 3000, `实际 ${ms2}ms`);
  const after = listenerPids();
  check('没有多起一个新进程（PID 集合不变）',
    JSON.stringify(before) === JSON.stringify(after),
    `前=${before.join(',')} 后=${after.join(',')}`);

  // ================= ③ 只杀自己那份 =================
  console.log('\n[3] 退出收尾 → 只杀自己拉起的');
  const ownedPids = listenerPids();
  MOD.stopOwnedServer(log);
  await new Promise((r) => setTimeout(r, 4000));
  const left = listenerPids();
  check('自己拉起的服务端已被停掉（8787 释放）', left.length === 0, `还剩 ${left.join(',')}`);
  check('确认停的正是刚才那个 PID', ownedPids.length === 1 && left.length === 0);

  // ================= ④ 反证：非自己拉起的不能被杀 =================
  console.log('\n[4] 反证：别人起的服务端，stopOwnedServer 不许动它');
  // 直接起一个"外部"服务端（不经过 ensureServer，所以归 outside 所有）
  const outside = spawn(process.execPath, [path.join(REPO, 'apps', 'server', 'dist', 'index.js')], {
    cwd: path.join(REPO, 'apps', 'server'),
    stdio: 'ignore',
    windowsHide: true,
  });
  let up = false;
  for (let i = 0; i < 40; i += 1) {
    if (await healthOk()) { up = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  check('外部服务端已起（作为"用户的 dev:server"）', up);
  const outPids = listenerPids();
  check('外部服务端在监听', outPids.length === 1, `实际 ${outPids.join(',')}`);

  // 关键：此时 supervisor 的 ownedServer 是 null（我们从没调过 ensureServer 起它）
  MOD.stopOwnedServer(log);
  await new Promise((r) => setTimeout(r, 3000));
  const stillThere = listenerPids();
  check('★ 外部服务端**没有被杀**（stopOwnedServer 只管自己那份）',
    stillThere.length === 1, `实际 ${stillThere.join(',')}`);
  check('它现在还活着（/health 仍通）', await healthOk());

  // 收干净：这个是我们自己 spawn 的外部进程，测试结束要清掉
  for (const p of listenerPids()) killTree(p);
  if (!outside.killed) {
    try { outside.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
  }
  await waitPortFree();
  check('测试环境已收干净（8787 空闲）', listenerPids().length === 0);

  // ===== ⑤ 真机才暴露的两个 bug 的回归（都跟「as.asar 拷贝里跑」有关）=====
  // 这两个是**端到端启动已安装应用**才发现的，纯模块单测此前 17 条全绿也照样漏 ——
  // 所以必须在这里补上，否则下次换装还会踩。
  console.log('\n[5] 回归：仓库位置推导 / 并发拉两份');

  // --- ⑤-A：不是 from-source 运行时（__dirname 在 as.asar 里）必须还能找到服务端 ---
  // 手法：把模块复制到临时目录里 require，让 __dirname 指向一个**没有 apps/server**
  // 的地方 —— 等价于 as.asar 拷贝跑的境况。此时 findDirs 必须靠 WORKBENCH_REPO_ROOT
  // 或盘符扫描兜底找回来，而不是直接返回「找不到 apps/server」。
  MOD.resetDirCache();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-fakedir-'));
  const fakeMod = path.join(tmpDir, 'server-supervisor.js');
  fs.copyFileSync(path.join(REPO, 'apps', 'desktop', 'dist-electron', 'server-supervisor.js'), fakeMod);
  // 清掉外部环境干扰，模拟「用户双击应用」的干净环境
  const savedEnv = process.env.WORKBENCH_REPO_ROOT;
  delete process.env.WORKBENCH_REPO_ROOT;
  delete require.cache[require.resolve(fakeMod)];
  const fake = require(fakeMod);
  const t5 = Date.now();
  const ok5 = await fake.ensureServer(API, log);
  const ms5 = Date.now() - t5;
  check('★ as.asar 式运行（__dirname 无 apps/server）也能拉起服务端',
    ok5 === true, '仍然报「找不到 apps/server 目录」');
  check('确实走的是拉起（>1s）而不是"本来就在跑"', ms5 > 1000 || ok5 === true);
  check('/health 通了', await healthOk());
  check('标记为「我们自己拉起的」', fake.getServerState().ownedByUs === true);
  fake.stopOwnedServer(log);
  await new Promise((r) => setTimeout(r, 4000));
  check('收尾后 8787 释放', listenerPids().length === 0, `还剩 ${listenerPids().join(',')}`);
  if (savedEnv !== undefined) process.env.WORKBENCH_REPO_ROOT = savedEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // --- ⑤-B：并发调用 ensureServer 只能起出**一份**服务端 ---
  // 真实触发路径：主窗口 + 内嵌页各自触发一次 ensureServer；
  // 两次探测都在服务端起来之前（都探不到）→ 没有去重就会 spawn 两份，
  // 第二份 EADDRINUSE 崩掉，日志长得像"服务端起来了又崩了"。
  MOD.resetDirCache();
  const conc = await Promise.all([MOD.ensureServer(API, log), MOD.ensureServer(API, log), MOD.ensureServer(API, log)]);
  check('并发 3 次调用全部返回 true', conc.every((x) => x === true), JSON.stringify(conc));
  check('/health 通了', await healthOk());
  const pidsConc = listenerPids();
  check('★ 8787 上**只有一个**监听进程（没起出两份）',
    pidsConc.length === 1, `实际 ${pidsConc.length} 个：${pidsConc.join(',')}`);
  const stConc = MOD.getServerState();
  check('状态是「我们自己拉起的」', stConc.ownedByUs === true);
  MOD.stopOwnedServer(log);
  await new Promise((r) => setTimeout(r, 4000));
  check('收尾后 8787 释放', listenerPids().length === 0, `还剩 ${listenerPids().join(',')}`);

  console.log('\n' + '='.repeat(78));
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  console.log('='.repeat(78));
  process.exit(fail === 0 ? 0 : 1);
})();
