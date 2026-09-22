/**
 * _heal-driver3.cjs —— 在**同一个进程内**完成「活→死→再查」，才能覆盖模块级状态。
 *
 * 为什么必须同进程：
 *   `externalServerSeen` 是模块级变量。如果分两次进程跑，第二次进程里它又是 false，
 *   老短路分支根本走不到 —— 反证就会假 PASS（这个坑我踩过一次）。
 *
 * 用法：node _heal-driver3.cjs <repoRoot> <port> <startedAtMs>
 *   脚本自己负责：先查一次（此时桩活着）→ 等一个信号文件表明桩已死 → 再查一次
 */
const path = require('path');
const fs = require('fs');

const REPO = process.argv[2];
const PORT = process.argv[3];
const FLAG = process.argv[4]; // 桩被杀后会写这个文件；本脚本轮询等它
const base = `http://127.0.0.1:${PORT}`;

(async () => {
  let mod;
  try {
    mod = require(path.join(REPO, 'apps', 'desktop', 'dist-electron', 'server-supervisor.js'));
  } catch (e) {
    console.log('RESULT ' + JSON.stringify({ error: 'require failed: ' + e.message }));
    process.exit(1);
  }
  const logs = [];
  const log = (m) => logs.push(m);

  // ---- 阶段 1：桩还活着 ----
  const first = await mod.ensureServer(base, log);
  const s1 = mod.getServerState();

  // ---- 等外部把桩杀掉 ----
  const t0 = Date.now();
  while (!fs.existsSync(FLAG)) {
    if (Date.now() - t0 > 60000) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 800));

  // ---- 阶段 2：桩已死，同一个模块实例里再查 ----
  const second = await mod.ensureServer(base, log);
  const s2 = mod.getServerState();

  console.log('RESULT ' + JSON.stringify({
    first, second,
    s1: { reachable: s1.reachable, ownedByUs: s1.ownedByUs },
    s2: { reachable: s2.reachable, ownedByUs: s2.ownedByUs, lastError: s2.lastError },
    logs,
  }));
  process.exit(0);
})();
