/**
 * 一键跑完整编排验收（Windows 友好）。用法：
 *
 *     node scripts/verify/run-orch.mjs
 *
 * ── 为什么需要这个包装（根因，改之前先读）────────────────────────────────
 * `orc-*.mts` 是 **ESM 入口**（`.mts` 恒为 ESM），而 `apps/server` 是个 **CJS 包**
 * （`apps/server/package.json` 没有 `"type": "module"`，`tsconfig.module = CommonJS`）。
 *
 * 于是同一个 `apps/server/src/toolLoop.ts` 会被**加载两次**：
 *   ① 测试文件直接 import → 走 Node 的 **ESM→CJS 桥**（`loadCJSModule`）
 *   ② 桥里跑起来的 CJS 代码内部 `require('../toolLoop')` → 走**普通 require 缓存**
 * 两套模块缓存 ⇒ `toolLoop.ts` 里 `const loops = new Map()` 变成**两个实例**
 * ⇒ `subLoops.resolveLoop()` 查的是另一张空表 ⇒ 结果投不回循环、`deps` 也是 undefined。
 *
 * 症状（6/11 个脚本假红，与编排逻辑**无关**）：
 *   · orc-park        `循环转 waiting_job… 0 !== 1` / `有结果但发起方循环已不在`
 *   · orc-delegate    `编排器还没初始化（initOrchestrator 要在启动时调一次）`
 *   · orc-e2e         `第一次不是 ask：done`
 *   · orc-routes      exit=127
 *
 * 判据（插桩抓到过的原始栈）：`new Error().stack` 里同时出现
 *   `loadCJSModule (node:internal/modules/esm/translators)` 和
 *   `Module._compile (node:internal/modules/cjs/loader)`。
 *
 * ── 这个脚本干的事 ─────────────────────────────────────────────────────
 * **临时**给 `apps/server/package.json` 加 `"type": "module"`（让整张模块图只走一条加载路径），
 * 跑完 `npm run verify:orch` 再**原样还原**（`try/finally`，异常路径也兜住）。
 *
 * ★ 为什么不永久加 `"type": "module"`：`apps/server/tsconfig.json` 是
 *   `"module": "CommonJS"`，永久加上会让编译出来的 `dist/index.js` 变成
 *   「按 ESM 解释的 CJS」，`npm start` / 安装版拉起服务端**直接崩**。
 *   真要永久修，得同时把 tsconfig 改成 NodeNext 并给所有相对 import 补 `.js` 后缀 —— 那是另一件事。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkgPath = path.join(repoRoot, 'apps', 'server', 'package.json');

const original = readFileSync(pkgPath, 'utf8');
let patched = false;

try {
  const pkg = JSON.parse(original);
  if (pkg.type !== 'module') {
    pkg.type = 'module';
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    patched = true;
    console.log('[run-orch] 已临时给 apps/server/package.json 加 "type": "module"（跑完还原）');
  }

  const env = { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: process.env.CODEBUDDY_SAFE_DELETE_ENABLED ?? '0' };
  const r = spawnSync('npm', ['run', 'verify:orch'], { cwd: repoRoot, stdio: 'inherit', shell: true, env });
  process.exitCode = r.status ?? 1;
  console.log(`\n[run-orch] verify:orch 退出码 = ${r.status}`);
} finally {
  if (patched) {
    writeFileSync(pkgPath, original, 'utf8');
    const back = JSON.parse(readFileSync(pkgPath, 'utf8'));
    console.log(`[run-orch] 已还原 apps/server/package.json（type=${String(back.type)}）`);
  }
}
