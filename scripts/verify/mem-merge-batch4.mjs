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
/**
 * ★ 批次 M · 阶段 1① 片 2（逻辑抽离）：这三条原先在 App.tsx 里 grep 端点字符串，
 *   代码搬进 `features/memory/useMemory.ts` 后它们会假红。**只改指向，不放宽**：
 *   仍要求端点在**生产源码**里、且同一个文件里确实有 fetch 调用（不是写字面量摆着）。
 */
const memLogicPath = path.join(root, 'apps/desktop/src/features/memory/useMemory.ts');
const memLogic = fs.readFileSync(memLogicPath, 'utf8');
const isListCall = (l) => /\/memories(?![-\w/])/.test(l) && /(authFetchJson|fetch)\s*[<(]/.test(l);
must(memLogic.split('\n').some(isListCall) && memLogic.includes('pending'), '记忆逻辑（features/memory）调用 /memories 获取 pending');
must(memLogic.includes("'/memories/confirm'") && /(authFetchJson|fetch)\s*[<(]/.test(memLogic), '记忆逻辑（features/memory）调用 /memories/confirm');
must(memLogic.includes("'/memories/reject'"), '记忆逻辑（features/memory）调用 /memories/reject');
/**
 * 规格 C4（2026-09-25）：确认从侧栏抽屉搬进**对话流** —— App 挂载 <MemoryConfirmCard/>
 * （.memConfirmCard 一族,design/17-mem-confirm.css）;旧侧栏抽屉的类不再许出现。
 */
must(appContent.includes('MemoryConfirmCard'), 'C4：App.tsx 在对话流里挂 MemoryConfirmCard');
must(appContent.includes('memConfirmFlow'), 'C4：确认卡渲染在聊天流容器（.memConfirmFlow）里');
must(!appContent.includes('memList--pending'), 'C4：侧栏抽屉式待确认面板已移除');
must(!appContent.includes('memList__row--pending'), 'C4：抽屉里的待确认行已移除');

/**
 * 规格 C4（2026-09-25）：确认卡样式随组件走 design/17-mem-confirm.css（编号规矩）。
 * 这里检查「设计系统整体」而不是钉死某个文件 —— 规则随组件走，位置会变。
 */
const designDir = path.join(root, 'apps/desktop/src/design');
const cssContent = fs.readdirSync(designDir)
  .filter((f) => f.endsWith('.css'))
  .map((f) => fs.readFileSync(path.join(designDir, f), 'utf8'))
  .join('\n');
must(cssContent.includes('.memConfirmCard'), 'C4：设计 CSS 有确认卡（.memConfirmCard）');
must(cssContent.includes('.memConfirmCard__btn--go'), 'C4：确认卡有「确认，生效」主按钮样式');
// 负向断言要先剥注释（注释里提到旧类名不算规则在场）
const cssNoComments = cssContent.replace(/\/\*[\s\S]*?\*\//g, '');
must(!cssNoComments.includes('.memList--pending'), 'C4：抽屉旧规则已从设计 CSS 删除');
must(!cssNoComments.includes('.btn--pending'), 'C4：抽屉按钮旧规则已从设计 CSS 删除');

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
