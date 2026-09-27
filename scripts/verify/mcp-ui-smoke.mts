/** 片2 · 桌面设置「添加 MCP server」jsdom 真组件行为验收（无浏览器安装）。 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(repo, 'node_modules', '.cache', 'mcp-ui', 'run.mjs');
mkdirSync(dirname(out), { recursive: true });
await build({ entryPoints: [join(repo, 'scripts/verify/mcp-ui-smoke.run.tsx')], bundle: true, platform: 'node',
  format: 'esm', target: 'node20', jsx: 'automatic', outfile: out, loader: { '.css': 'empty' }, packages: 'external' });
await import(pathToFileURL(out).href);
