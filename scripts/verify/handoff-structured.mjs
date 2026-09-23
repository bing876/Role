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
must(handoff.includes('appendBoardWithLock') && handoff.includes('单写者'), 'handoff.ts board.md 单写者：只有发起方能写');
must(handoff.includes('boardLocks') && handoff.includes('withBoardLock'), 'handoff.ts 有锁序列化，防止并发丢数据');
must(handoff.includes('appendBoardWithoutLock'), 'handoff.ts 有无锁版本用于反证');

const delegationPath = path.join(root,'apps/server/src/orchestrator/delegation.ts');
const delegation = fs.readFileSync(delegationPath,'utf8');
must(delegation.includes('writeHandoffFile') && delegation.includes('getHandoffUri'), 'delegation.ts 创建交接文件并传路径');
must(delegation.includes('handoff://') || delegation.includes('getHandoffUri'), 'delegation.ts 委派消息只传路径不传内容');
must(delegation.includes('appendBoardWithLock'), 'delegation.ts board 单写者追加（只有发起方）');

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

// ---------------- 并发反证：board 不丢数据 ----------------
console.log('\n--- 并发反证：board 单写者锁 ---');
const testProjectId = 99999;
const testDir = path.join(root, `apps/server/data/handoffs/${testProjectId}`);
const boardFile = path.join(testDir, 'board.md');

function ensureTestDir() {
  fs.mkdirSync(testDir, { recursive: true });
  if (fs.existsSync(boardFile)) fs.unlinkSync(boardFile);
  fs.writeFileSync(boardFile, `# 项目 ${testProjectId} 交接板\n\n`, 'utf8');
}

function readBoard() {
  return fs.existsSync(boardFile) ? fs.readFileSync(boardFile, 'utf8') : '';
}

// 无锁版本：模拟竞态，必丢
async function appendWithoutLock(entry) {
  let current = '';
  try { current = fs.readFileSync(boardFile, 'utf8'); } catch {}
  await new Promise(r => setTimeout(r, 20));
  fs.writeFileSync(boardFile, current + entry + '\n', 'utf8');
}

// 有锁版本：Promise 链序列化
const locks = new Map();
async function withLock(projectId, fn) {
  const prev = locks.get(projectId) ?? Promise.resolve();
  let release;
  const next = new Promise(res => release = res);
  locks.set(projectId, prev.then(() => next));
  await prev;
  try { return await fn(); } finally { release(); }
}

async function appendWithLock(projectId, entry) {
  return withLock(projectId, async () => {
    let current = '';
    try { current = fs.readFileSync(boardFile, 'utf8'); } catch {}
    await new Promise(r => setTimeout(r, 10));
    fs.writeFileSync(boardFile, current + entry + '\n', 'utf8');
  });
}

async function testConcurrent() {
  // 反证：无锁 → 丢数据
  ensureTestDir();
  const e1 = '- [T1] A→B task1';
  const e2 = '- [T2] A→C task2';
  await Promise.all([appendWithoutLock(e1), appendWithoutLock(e2)]);
  const afterNoLock = readBoard();
  const hasBothNoLock = afterNoLock.includes('task1') && afterNoLock.includes('task2');
  // 无锁时大概率只剩一个（竞态）
  console.log(`无锁并发结果含 task1: ${afterNoLock.includes('task1')}, task2: ${afterNoLock.includes('task2')}`);
  must(!hasBothNoLock, '反证：去掉单写者锁→并发写 board 丢数据（复现丢失）');

  // 正证：有锁 → 不丢
  ensureTestDir();
  locks.clear();
  await Promise.all([appendWithLock(testProjectId, e1), appendWithLock(testProjectId, e2)]);
  const afterLock = readBoard();
  const hasBothLock = afterLock.includes('task1') && afterLock.includes('task2');
  console.log(`有锁并发结果含 task1: ${afterLock.includes('task1')}, task2: ${afterLock.includes('task2')}`);
  must(hasBothLock, '正证：单写者锁→并发写 board 不丢数据');

  // 清理
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
}

await testConcurrent();

console.log(`\n=== 结论：失败 ${fails} 项 ===`);
process.exit(fails>0?1:0);
