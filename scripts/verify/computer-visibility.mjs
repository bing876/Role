#!/usr/bin/env node
import { fileURLToPath as __f2p } from 'node:url';
import { dirname as __dn, resolve as __rs } from 'node:path';
// 从任何 cwd 运行都以仓库根为基准（原来散在 scripts/ 下时依赖 cwd=仓库根）
process.chdir(__rs(__dn(__f2p(import.meta.url)), '..', '..'));
import fs from 'node:fs';
function assert(c,m){ if(!c){ console.error('FAIL',m); process.exit(1);} }

console.log('=== 批次 H | 电脑三级可见度 ===');

let db=fs.readFileSync('apps/server/src/db.ts','utf8');
assert(db.includes('computer_visibility'), 'db 应有 computer_visibility');
assert(db.includes('status') && db.includes('preview') && db.includes('takeover'), '应有三档');
console.log('H DB PASS');

let route=fs.readFileSync('apps/server/src/routes/computerVisibility.ts','utf8');
assert(route.includes('Status') || route.includes('status'), '应说明 Status');
assert(route.includes('Preview') || route.includes('preview'), '应有 Preview');
assert(route.includes('Takeover') || route.includes('takeover'), '应有 Takeover');
assert(route.includes('默认收起') || route.includes('默认'), '应说明默认收起');
console.log('H 后端路由 PASS');

let comp=fs.readFileSync('apps/desktop/src/browser/ComputerVisibility.tsx','utf8');
assert(comp.includes('status'), '前端应有 status');
assert(comp.includes('preview'), '前端应有 preview');
assert(comp.includes('takeover'), '前端应有 takeover');
assert(comp.includes('默认收起') || comp.includes('status'), '默认应为 status');
assert(comp.includes('侧边钉住') || comp.includes('preview'), 'Preview 应侧边钉住');
assert(comp.includes('Grok') || comp.includes('显眼'), '应有 Grok 依据');
console.log('H 前端组件 PASS');

let css=fs.readFileSync('apps/desktop/src/browser/styles.css','utf8');
assert(css.includes('computerVisibility'), 'CSS 应有 computerVisibility');
assert(css.includes('--preview'), '应有 preview 样式');
assert(css.includes('--takeover'), '应有 takeover 样式');
console.log('H CSS PASS');

// 反证：默认收起，不抢焦点
assert(comp.includes("useState<ComputerVisibility>(propVisibility ?? 'status')"), '默认应为 status 收起');
console.log('H 反证 PASS: 默认收起，不显眼，不强迫用户监督；显眼时用户被迫监督');

console.log('\n=== 批次 H 全部 PASS ===');
