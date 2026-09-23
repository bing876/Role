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

console.log('=== 批次 A | 交接结构化（最高优先）验收 ===');

const handoffPath = path.join(root,'apps/server/src/orchestrator/handoff.ts');
must(fs.existsSync(handoffPath), 'handoff.ts 存在（项目工作区 handoffs/ + board.md）');
const handoff = fs.readFileSync(handoffPath,'utf8');
must(handoff.includes('getHandoffDir') && handoff.includes('board.md'), 'handoff.ts 定义 handoffs/ 目录与 board.md');
must(handoff.includes('writeHandoffFile') && handoff.includes('目标') && handoff.includes('输入') && handoff.includes('产出要求') && handoff.includes('审批边界'), 'handoff.ts 每个委派一个文件，含 目标/输入/产出要求/审批边界');
must(handoff.includes('getHandoffUri') && handoff.includes('handoff://'), 'handoff.ts 委派消息只传路径 handoff://');
must(handoff.includes('appendBoardWithLock'), 'handoff.ts board.md 追加入口 appendBoardWithLock');
// 收尾 2：进程内 Promise 链锁（boardLocks / appendBoardWithoutLock）已换成落库锁 board_locks。
//   这里只做结构检查；真正的并发 + 重启反证在 scripts/verify/board-lock-db.mjs（连真库、多进程、kill -9）。
must(handoff.includes('board_locks') && handoff.includes('FOR UPDATE'), 'handoff.ts 用 board_locks 行锁（跨进程/跨重启）');
must(!/new Map<number, Promise<void>>/.test(handoff), 'handoff.ts 不再有进程内 Promise 链锁');

const delegationPath = path.join(root,'apps/server/src/orchestrator/delegation.ts');
const delegation = fs.readFileSync(delegationPath,'utf8');
must(delegation.includes('writeHandoffFile') && delegation.includes('getHandoffUri'), 'delegation.ts 创建交接文件并传路径');
must(delegation.includes('handoff://') || delegation.includes('getHandoffUri'), 'delegation.ts 委派消息只传路径不传内容');
must(/appendBoardWithLock\(pool,/.test(delegation), 'delegation.ts 追加 board 时把 pool 传给落库锁');

const routesPath = path.join(root,'apps/server/src/routes/handoffs.ts');
must(fs.existsSync(routesPath), 'routes/handoffs.ts 存在（项目工作区 API）');
const routes = fs.readFileSync(routesPath,'utf8');
must(routes.includes('/projects/:id/handoffs/board'), 'handoff 路由有 board.md 读取');
must(routes.includes('/projects/:id/handoffs'), 'handoff 路由有列表与单文件读取');

const indexPath = path.join(root,'apps/server/src/index.ts');
const index = fs.readFileSync(indexPath,'utf8');
must(index.includes('registerHandoffRoutes'), 'index.ts 注册 handoff 路由');

const sharedPath = path.join(root,'packages/shared/src/index.ts');
const shared = fs.readFileSync(sharedPath,'utf8');
must(!shared.includes('group_chats'), 'shared 未建 group_chats 表（项目本身就是容器，天然群）');

// ---------------- 并发反证 ----------------
// 原来这里是脚本**自己复刻**一把进程内锁再测它 —— 测的不是生产代码，而且单进程里进程内锁当然不丢。
// 收尾 2 起改为：scripts/verify/board-lock-db.mjs（真库、独立进程、kill -9 模拟重启）。

console.log(`\n=== 结论：失败 ${fails} 项 ===`);
process.exit(fails>0?1:0);
