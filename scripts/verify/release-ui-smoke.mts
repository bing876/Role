/** 真 AuthScreen/LocalFirstRun 打入 jsdom，验证新安装卡与既有登录页的保留。 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const out = join(root, 'node_modules/.cache/release-ui/run.mjs');
mkdirSync(dirname(out), { recursive: true });
await build({ entryPoints: [join(root, 'scripts/verify/release-ui-smoke.run.tsx')], bundle: true,
  platform: 'node', format: 'esm', target: 'node20', jsx: 'automatic', outfile: out,
  loader: { '.css': 'empty' }, packages: 'external' });
await import(pathToFileURL(out).href);
