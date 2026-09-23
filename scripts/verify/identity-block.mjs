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

console.log('=== 人设固定注入验收 ===');
const p = path.join(root,'apps/server/src/identityBlock.ts');
must(fs.existsSync(p),'identityBlock.ts 存在');
const c = fs.readFileSync(p,'utf8');
must(c.includes('buildIdentityBlock'),'有 buildIdentityBlock');
must(c.includes('IDENTITY_FIXED_NOTE'),'有 IDENTITY_FIXED_NOTE');
must(c.includes('fixedPersonaForKind') || c.includes('coordinatorPersona'),'引入 coordinatorPersona');
must(c.includes('personaStatus') || c.includes('pending'),'处理 pending/ready');
must(c.includes('优先级高于') || c.includes('固定身份'),'文案包含优先级/固定身份');
must(c.includes('validatePersonaInput'),'有 validatePersonaInput（建完能改人设校验）');

const agentsPath = path.join(root,'apps/server/src/routes/agents.ts');
const agentsContent = fs.readFileSync(agentsPath,'utf8');
must(agentsContent.includes('identityBlock'),'agents.ts 引入 identityBlock');
must(agentsContent.includes('buildIdentityBlock'),'agents.ts 使用 buildIdentityBlock');
must(agentsContent.includes('/agents/:id/persona') && agentsContent.includes('GET'), 'agents.ts 有 GET /agents/:id/persona（建完可查）');
must(agentsContent.includes('建完能改人设') || agentsContent.includes('无论 pending 还是 ready'), 'agents.ts 允许建完改人设');

console.log(`\n=== 结论：失败 ${fails} 项 ===`);
process.exit(fails>0?1:0);
