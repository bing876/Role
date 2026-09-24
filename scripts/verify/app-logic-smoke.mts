/**
 * 阶段 1 · ① 逻辑抽离的行为验收网 —— 驱动（与另外两张网同一套做法）。
 *
 * 用法：npm run verify:logic
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function main(): Promise<void> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const outDir = join(repoRoot, 'node_modules', '.cache', 'app-logic-smoke');
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, 'ui-test.mjs');

  await build({
    entryPoints: [join(repoRoot, 'scripts', 'verify', 'app-logic-smoke.run.tsx')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    jsx: 'automatic',
    outfile,
    loader: { '.css': 'empty' },
    packages: 'external',
    logLevel: 'warning',
  });

  process.env.SMOKE_REPO = repoRoot;
  await import(pathToFileURL(outfile).href);
}

void main();
