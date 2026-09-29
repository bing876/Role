/**
 * `packages/shared/dist` 存在性 + 新鲜度守护（2026-09-29 治理片）。
 *
 * ## 背景：为什么会有这个脚本
 *
 * `packages/shared` 的 `main` 指向 `./dist/index.js`，而**整个验证链从不 build shared**
 * （`verify:typecheck` 用的是 `tsc --noEmit`）。所有验收脚本 `require('@ai-workbench/shared')`
 * 都解析到 `dist/`。所以 dist 不在，整条链第一步就崩。
 *
 * 历史上因此出过事故（批次 J，`scripts/verify/mention-parse.mts` ⑩ 段有完整记录）：
 * `.gitignore` 写着 `dist/`，但 `dist/index.js`、`tools.js` 是当年 `git add -f` 进去的
 * —— **部分跟踪**。新增 `mention.ts` 后编译出的 `dist/mention.js` 被 ignore 规则挡住没进库，
 * 而**已跟踪**的 `dist/index.js` 里写着 `__exportStar(require("./mention"))`。
 * 后果：新克隆不跑 `npm run build -w @ai-workbench/shared` 就起服务端 →
 * `ERR_MODULE_NOT_FOUND`，**启动即崩**；而开发机上永远复现不了（本地 dist 是全的）。
 *
 * ## 2026-09-29 的处置
 *
 * 把 16 个 dist 文件**整个取消跟踪**（`git rm --cached`），改成"靠 build 生成"：
 *   ① `packages/shared/package.json` 加 `"prepare": "npm run build"`
 *      —— 实测 `npm install` 会触发它，dist 从零重新生成，且与被跟踪的那份**逐字节一致**。
 *   ② 本脚本接管"dist 不在 / dist 过期"这两种新的失败形态。
 *
 * ## 为什么必须同时上 ②
 *
 * 取消跟踪后，"部分跟踪"这个坑没了，但换来两个新坑：
 *   · **不在**：有人 `--ignore-scripts` 装依赖，或 prepare 失败 → dist 没有 → 链第一步崩。
 *     本脚本把它变成一句人话，而不是 `ERR_MODULE_NOT_FOUND`。
 *   · **过期**：改了 `src/*.ts` 忘了 build → 测试和产品跑的是**旧代码**，
 *     而现象是"我改了却没生效"，极难排。这是比"不在"更阴的坑。
 *
 * 反证口径：
 *   · 删掉 `packages/shared/dist` → 「dist 必须在」红
 *   · `touch packages/shared/src/tools.ts` → 「dist 不能比 src 旧」红
 *
 * 用法：npx tsx scripts/verify/shared-dist-fresh.mts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const SHARED = path.join(ROOT, 'packages', 'shared');
const SRC = path.join(SHARED, 'src');
const DIST = path.join(SHARED, 'dist');

let pass = 0;
const ok = (name: string): void => {
  pass += 1;
  console.log(`  PASS ${name}`);
};

function main(): void {
  // ---- ① dist 必须在 ----
  if (!fs.existsSync(DIST)) {
    console.error(
      'FAIL packages/shared/dist 不存在。\n' +
        '  它的 main 指向 ./dist/index.js，而验证链从不 build shared —— 现在整条链会崩。\n' +
        '  正解：npm install（会触发 packages/shared 的 prepare → npm run build）。\n' +
        '  如果你是用 --ignore-scripts 装的，手动补一次：npm run build -w @ai-workbench/shared',
    );
    process.exit(1);
  }
  ok('packages/shared/dist 存在（npm install 的 prepare 已生成它）');

  const entry = path.join(DIST, 'index.js');
  assert.ok(fs.existsSync(entry), `dist/index.js 不在：${entry}`);
  ok('dist/index.js 在（main 指向它，缺了全链第一步就 ERR_MODULE_NOT_FOUND）');

  // ---- ② dist 不能比 src 旧（逐个源文件对账）----
  const srcFiles = fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith('.ts'))
    .sort();
  assert.ok(srcFiles.length > 0, 'src 里一个 .ts 都没有 —— 路径认错了，这是假绿');

  const stale: string[] = [];
  for (const f of srcFiles) {
    const out = path.join(DIST, f.replace(/\.ts$/, '.js'));
    if (!fs.existsSync(out)) {
      stale.push(`${f} → 没有编译产物 ${path.basename(out)}`);
      continue;
    }
    const sMtime = fs.statSync(path.join(SRC, f)).mtimeMs;
    const oMtime = fs.statSync(out).mtimeMs;
    // 容许 2 秒误差：某些文件系统的 mtime 粒度是 1 秒，同一次 build 里
    // 源与产物的时间戳可能相等或差几毫秒，卡太紧会假红。
    if (oMtime + 2000 < sMtime) stale.push(`${f} 比它的产物新（改了没 build）`);
  }
  assert.deepEqual(stale, [], `dist 过期/缺失：\n  ${stale.join('\n  ')}`);
  ok(`dist 不比 src 旧（逐个核对 ${srcFiles.length} 个源文件：${srcFiles.join(', ')}）`);

  // ---- ③ 一份都不该被跟踪（否则又回到"部分跟踪"的老坑）----
  let tracked: string[] = [];
  try {
    tracked = execFileSync('git', ['ls-files', 'packages/shared/dist'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
  } catch {
    // git 不可用（比如把仓库当普通目录拷走）：跳过这一条，不作数也不算失败
    console.log('  （git 不可用：跳过「一份都不跟踪」核对）');
  }
  if (tracked.length > 0) {
    assert.deepEqual(
      tracked,
      [],
      `packages/shared/dist 还有 ${tracked.length} 个文件被跟踪 —— 又回到"部分跟踪"的老坑。\n` +
        '  正解：git rm --cached packages/shared/dist/*（.gitignore 已有 dist/，文件留在磁盘上）',
    );
  } else {
    ok('packages/shared/dist 一份都没被跟踪（靠 build 生成，不再有"部分跟踪"坑）');
  }

  console.log(`\n=== shared dist 守护：${pass} PASS / 0 FAIL ===`);
}

main();
