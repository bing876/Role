/** 模型设置 UI：打包真实 React feature 到 jsdom，验密钥生命周期 / JWT / 切账号。 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(repo, 'node_modules', '.cache', 'model-ui', 'run.mjs');
mkdirSync(dirname(out), { recursive: true });
await build({ entryPoints: [join(repo, 'scripts/verify/model-ui-smoke.run.tsx')], bundle: true,
  platform: 'node', format: 'esm', target: 'node20', jsx: 'automatic', outfile: out,
  loader: { '.css': 'empty' }, packages: 'external' });
await import(pathToFileURL(out).href);
