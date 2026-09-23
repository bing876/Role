#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
let fails=0;
function ok(m){console.log(`PASS ${m}`);}
function fail(m){console.error(`FAIL ${m}`);fails++;}
function must(c,m){c?ok(m):fail(m);}

console.log('=== 总协调人设验收 ===');
const p = path.join(root,'apps/server/src/coordinatorPersona.ts');
must(fs.existsSync(p),'coordinatorPersona.ts 存在');
const c = fs.readFileSync(p,'utf8');
must(c.includes('HEN_PERSONA_BLOCK'),'有 HEN_PERSONA_BLOCK');
must(c.includes('COORDINATOR_PERSONA_BLOCK'),'有 COORDINATOR_PERSONA_BLOCK');
must(c.includes('fixedPersonaForKind'),'有 fixedPersonaForKind');
must(c.includes('hasFixedPersona'),'有 hasFixedPersona');
must(c.includes('项目管家') || c.includes('母鸡'),'文案包含项目管家/母鸡');
must(c.includes('总协调'),'文案包含总协调');
must(!c.includes('import { Pool }'),'不依赖 Pool（纯文本）');
must(!c.includes('from \'pg\''),'不依赖 pg');

console.log(`\n=== 结论：失败 ${fails} 项 ===`);
process.exit(fails>0?1:0);
