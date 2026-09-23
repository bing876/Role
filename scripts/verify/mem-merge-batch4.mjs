#!/usr/bin/env node
/**
 * 记忆合并第四批验收：确认卡
 * - 桌面端有待确认记忆状态与确认/拒绝逻辑
 * - 服务端 /memories/confirm /reject 存在
 * - 统一样式
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

let fails = 0;
function ok(msg) { console.log(`PASS ${msg}`); }
function fail(msg) { console.error(`FAIL ${msg}`); fails += 1; }
function must(cond, msg) { cond ? ok(msg) : fail(msg); }

console.log('=== 记忆合并第四批验收：确认卡 ===');

const appPath = path.join(root, 'apps/desktop/src/App.tsx');
const appContent = fs.readFileSync(appPath, 'utf8');
must(appContent.includes('pendingMem'), 'App.tsx 有 pendingMem 状态');
must(appContent.includes('loadPendingMemory'), 'App.tsx 有 loadPendingMemory');
must(appContent.includes('confirmMemory'), 'App.tsx 有 confirmMemory');
must(appContent.includes('rejectMemory'), 'App.tsx 有 rejectMemory');
must(appContent.includes('confirmAllPending'), 'App.tsx 有 confirmAllPending');
must(appContent.includes('/memories') && appContent.includes('pending'), 'App.tsx 调用 /memories 获取 pending');
must(appContent.includes('/memories/confirm'), 'App.tsx 调用 /memories/confirm');
must(appContent.includes('/memories/reject'), 'App.tsx 调用 /memories/reject');
must(appContent.includes('待确认'), 'App.tsx 有待确认 UI');
must(appContent.includes('memList--pending'), 'App.tsx 有 pending 样式类');

const cssPath = path.join(root, 'apps/desktop/src/styles.css');
const cssContent = fs.readFileSync(cssPath, 'utf8');
must(cssContent.includes('.btn--pending'), 'styles.css 有 btn--pending');
must(cssContent.includes('.memList--pending'), 'styles.css 有 memList--pending');
must(cssContent.includes('.memList__row--pending'), 'styles.css 有 memList__row--pending');
must(cssContent.includes('.memList__actions'), 'styles.css 有 memList__actions');

const memPath = path.join(root, 'apps/server/src/routes/memories.ts');
const memContent = fs.readFileSync(memPath, 'utf8');
must(memContent.includes('/memories/confirm'), 'memories.ts 有 confirm 路由');
must(memContent.includes('/memories/reject'), 'memories.ts 有 reject 路由');
must(memContent.includes('pending'), 'memories.ts 处理 pending');

const agentsPath = path.join(root, 'apps/server/src/routes/agents.ts');
const agentsContent = fs.readFileSync(agentsPath, 'utf8');
must(agentsContent.includes('UNIFIED_TIDY_PROMPT'), 'agents.ts 使用 UNIFIED_TIDY_PROMPT（支持确认卡）');

const sharedPath = path.join(root, 'apps/server/src/memoryShared.ts');
const sharedContent = fs.readFileSync(sharedPath, 'utf8');
must(sharedContent.includes('UNIFIED_TIDY_PROMPT'), 'memoryShared 有 UNIFIED_TIDY_PROMPT');

console.log(`\n=== 结论：失败 ${fails} 项 ===`);
process.exit(fails > 0 ? 1 : 0);
