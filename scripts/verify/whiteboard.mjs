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

console.log('=== 批次 B | 项目共享白板 验收 ===');

const dbPath = path.join(root,'apps/server/src/db.ts');
const db = fs.readFileSync(dbPath,'utf8');
must(db.includes('project_whiteboard'), 'db.ts 含 project_whiteboard 表（项目简报）');
must(db.includes('uniq_project_whiteboard'), 'db.ts 白板有唯一索引防重');
must(!db.includes('group_chats'), 'db.ts 未建 group_chats 表（项目即群）');

const wbPath = path.join(root,'apps/server/src/orchestrator/whiteboard.ts');
must(fs.existsSync(wbPath), 'whiteboard.ts 存在（数据/事件做）');
const wb = fs.readFileSync(wbPath,'utf8');
must(wb.includes('buildWhiteboardBlock') && wb.includes('项目简报'), 'whiteboard.ts 有 buildWhiteboardBlock 项目简报');
must(wb.includes('listWhiteboard') && wb.includes('postWhiteboard'), 'whiteboard.ts 有 list/post 白板');
must(wb.includes('needs_confirm') || wb.includes('待确认'), 'whiteboard.ts 贴白板=待确认记忆卡');
must(wb.includes('所有成员自动注入') || wb.includes('自动注入'), 'whiteboard.ts 注释提及所有成员自动注入');

const routesPath = path.join(root,'apps/server/src/routes/whiteboard.ts');
must(fs.existsSync(routesPath), 'routes/whiteboard.ts 存在');
const routes = fs.readFileSync(routesPath,'utf8');
must(routes.includes('/projects/:id/whiteboard') && routes.includes('GET'), 'whiteboard 路由有 GET 列表');
must(routes.includes('POST') && routes.includes('whiteboard'), 'whiteboard 路由有 POST 贴白板');
must(routes.includes('confirm') && routes.includes('reject'), 'whiteboard 路由有确认/拒绝卡（待确认记忆卡）');

const chatPath = path.join(root,'apps/server/src/routes/chat.ts');
const chat = fs.readFileSync(chatPath,'utf8');
must(chat.includes('buildWhiteboardBlock') && chat.includes('whiteboardBlock'), 'chat.ts 注入白板块（所有成员自动注入）');
must(chat.includes('项目共享白板') || chat.includes('白板'), 'chat.ts 提及白板');

const indexPath = path.join(root,'apps/server/src/index.ts');
const index = fs.readFileSync(indexPath,'utf8');
must(index.includes('registerWhiteboardRoutes'), 'index.ts 注册白板路由');

const sharedPath = path.join(root,'packages/shared/src/index.ts');
const shared = fs.readFileSync(sharedPath,'utf8');
must(shared.includes('WhiteboardView') && shared.includes('项目简报'), 'shared 含 WhiteboardView 类型（项目简报）');

const handoffPath = path.join(root,'apps/server/src/orchestrator/handoff.ts');
must(fs.existsSync(handoffPath), 'handoff.ts 仍存在（批次 A 保留）');

console.log(`\n=== 结论：失败 ${fails} 项 ===`);
process.exit(fails>0?1:0);
