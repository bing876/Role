/**
 * M0 冒烟网的驱动 —— 与 `orc-channels-ui.mts` 同一套做法：
 * 用 esbuild 把 `.run.tsx` 打成一个 ESM 包（CSS 置空、包依赖 external）再执行。
 *
 * 为什么不直接 `tsx` 跑 `.run.tsx`：那里面 import 了 `App.tsx`，而 App → browser/*
 * 有 `import './styles.css'` 这类 CSS 副作用导入，Node 下加载不了；另外 jsdom 的全局
 * **必须**在 `react-dom` 被 import 之前铺好，所以那些 import 只能动态写在顶层 await 里
 * （CJS 不支持顶层 await → 产物必须是 ESM）。
 *
 * 用法：npm run verify:shell  /  npm run verify:shell -- --update-golden
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function main(): Promise<void> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  /**
   * ★ 产物必须落在**仓库内**：`packages: 'external'` 之后，产物里的 `import 'react'`
   *   要靠 Node 向上找 `node_modules`；落到 /tmp 就一路找到根目录也找不到。
   *   `node_modules/.cache/` 本来就被 git 忽略。
   */
  const outDir = join(repoRoot, 'node_modules', '.cache', 'app-shell-smoke');
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, 'ui-test.mjs');

  await build({
    entryPoints: [join(repoRoot, 'scripts', 'verify', 'app-shell-smoke.run.tsx')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    jsx: 'automatic',
    outfile,
    // CSS 是纯副作用导入（真实打包由 vite 处理，`build:renderer` 那边已经验过）
    loader: { '.css': 'empty' },
    // 包依赖 external（理由见 orc-channels-ui.mts：CJS 链卷进 ESM 会炸，且会出两份 React）
    packages: 'external',
    logLevel: 'warning',
    // 让 run.tsx 里的 --update-golden 透传
    banner: { js: '// 由 app-shell-smoke.mts 打包生成，请勿手改' },
  });

  // 仓库根交给 run.tsx（它的 import.meta.url 指向缓存目录，推不出仓库根）
  process.env.SMOKE_REPO = repoRoot;
  await import(pathToFileURL(outfile).href);
}

void main();
