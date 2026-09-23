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

console.log('=== 总协调路由：Chief-of-Staff 管家判断自己干/派谁 验收 ===');

const chiefPath = path.join(root,'apps/server/src/orchestrator/chiefOfStaff.ts');
must(fs.existsSync(chiefPath), 'chiefOfStaff.ts 存在（数据/事件做，版式归前端）');
const chief = fs.readFileSync(chiefPath,'utf8');
must(chief.includes('routeTask') && chief.includes('routeByDuty'), 'chiefOfStaff.ts 有 routeTask/routeByDuty');
must(chief.includes('duty_match') && chief.includes('hen_fallback'), 'chiefOfStaff.ts 含职责匹配与管家兜底');
must(chief.includes('【协同·路由】') || chief.includes('协同'), 'chiefOfStaff.ts 写入协同路由标记（进对话流）');
must(chief.includes('isAgentWaiting') || chief.includes('busy'), 'chiefOfStaff.ts 考虑忙/等状态，避免死循环');

const promptsPath = path.join(root,'apps/server/src/orchestrator/prompts.ts');
const prompts = fs.readFileSync(promptsPath,'utf8');
must(prompts.includes('chiefOfStaffBlock') && prompts.includes('总协调路由'), 'prompts.ts 有 chiefOfStaffBlock（管家职责）');
must(prompts.includes('Chief-of-Staff') || prompts.includes('项目管家'), 'prompts.ts 提及项目管家/管家');

const rosterPath = path.join(root,'apps/server/src/orchestrator/roster.ts');
const roster = fs.readFileSync(rosterPath,'utf8');
must(roster.includes('chiefOfStaffBlock'), 'roster.ts 引入 chiefOfStaffBlock 并拼装');
must(roster.includes('orchestrationBlockFor'), 'roster.ts 仍有 orchestrationBlockFor（名单+路由）');

const chatPath = path.join(root,'apps/server/src/routes/chat.ts');
const chat = fs.readFileSync(chatPath,'utf8');
must(chat.includes('routeTask') && chat.includes('logRouteDecision'), 'chat.ts 引入 routeTask 并在未指定 agent 时路由');
must(chat.includes('管家路由') || chat.includes('协同·路由'), 'chat.ts 记录路由到对话流');

const agentsPath = path.join(root,'apps/server/src/routes/agents.ts');
const agents = fs.readFileSync(agentsPath,'utf8');
must(agents.includes('/agents/route'), 'agents.ts 有 /agents/route 只读接口（供前端预判）');
must(agents.includes('routeTask'), 'agents.ts 路由接口调用 routeTask');

console.log(`\n=== 结论：失败 ${fails} 项 ===`);
process.exit(fails>0?1:0);
