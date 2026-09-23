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

console.log('=== 定时/事件触发：Routines 验收 ===');

const dbPath = path.join(root,'apps/server/src/db.ts');
const db = fs.readFileSync(dbPath,'utf8');
must(db.includes('agent_routines'), 'db.ts 含 agent_routines 表');
must(db.includes('trigger_type') && db.includes('interval'), 'db.ts 定义 interval/cron/event 触发类型');
must(db.includes('task_template'), 'db.ts 有 task_template（对话=一次活）');
must(db.includes('Routines') || db.includes('例行') || db.includes('长期规矩'), 'db.ts 注释提及 Routines/长期规矩');

const routinesPath = path.join(root,'apps/server/src/orchestrator/routines.ts');
must(fs.existsSync(routinesPath), 'routines.ts 存在（数据/事件做，版式归前端）');
const routines = fs.readFileSync(routinesPath,'utf8');
must(routines.includes('computeNextRun') && routines.includes('interval'), 'routines.ts 有 computeNextRun 支持 interval');
must(routines.includes('cron'), 'routines.ts 支持 cron（每天 HH:MM）');
must(routines.includes('triggerByEvent'), 'routines.ts 有 triggerByEvent（事件触发）');
must(routines.includes('【协同·例行】'), 'routines.ts 写入【协同·例行】进对话流（折叠摘要）');
must(routines.includes('startRoutineSweeper'), 'routines.ts 有 startRoutineSweeper 定时扫');

const routesPath = path.join(root,'apps/server/src/routes/routines.ts');
must(fs.existsSync(routesPath), 'routes/routines.ts 存在');
const routes = fs.readFileSync(routesPath,'utf8');
must(routes.includes('/routines') && (routes.includes('POST') || routes.includes('app.post')), 'routes/routines.ts 有 CRUD 接口');
must(routes.includes('trigger'), 'routes/routines.ts 有手动触发接口');

const indexPath = path.join(root,'apps/server/src/index.ts');
const index = fs.readFileSync(indexPath,'utf8');
must(index.includes('registerRoutineRoutes') && index.includes('startRoutineSweeper'), 'index.ts 注册 Routines 路由并启动扫');

const sharedPath = path.join(root,'packages/shared/src/index.ts');
const shared = fs.readFileSync(sharedPath,'utf8');
must(shared.includes('RoutineView') && shared.includes('RoutineTriggerType'), 'shared 含 RoutineView 类型（五概念之一 Prompts 的长期形态）');

const chatPath = path.join(root,'apps/server/src/routes/chat.ts');
const chat = fs.readFileSync(chatPath,'utf8');
must(chat.includes('triggerByEvent') && chat.includes('message'), 'chat.ts 收到用户消息触发 event Routines');

const delegationPath = path.join(root,'apps/server/src/orchestrator/delegation.ts');
const delegation = fs.readFileSync(delegationPath,'utf8');
must(delegation.includes('triggerByEvent') && delegation.includes('delegation_done'), 'delegation.ts 完成时触发 delegation_done 事件');

console.log(`\n=== 结论：失败 ${fails} 项 ===`);
process.exit(fails>0?1:0);
