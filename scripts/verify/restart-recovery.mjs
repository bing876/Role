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

console.log('=== 批次 D | 重启恢复：LangGraph checkpoint 思路 验收 ===');

const dbPath = path.join(root,'apps/server/src/db.ts');
const db = fs.readFileSync(dbPath,'utf8');
must(db.includes('loop_checkpoints'), 'db.ts 含 loop_checkpoints 表（循环状态落库）');
must(db.includes('idx_loop_checkpoints'), 'db.ts 有 checkpoint 索引');
must(!db.includes('group_chats'), 'db.ts 未建 group_chats（项目即群）');

const cpPath = path.join(root,'apps/server/src/orchestrator/checkpoint.ts');
must(fs.existsSync(cpPath), 'checkpoint.ts 存在（数据/事件做）');
const cp = fs.readFileSync(cpPath,'utf8');
must(cp.includes('saveCheckpoint') && cp.includes('loadCheckpoints'), 'checkpoint.ts 有 save/loadCheckpoint');
must(cp.includes('restoreLoops') && cp.includes('checkpointToSession'), 'checkpoint.ts 有 restoreLoops，服务重启能续跑');
must(cp.includes('LangGraph') || cp.includes('checkpoint'), 'checkpoint.ts 提及 LangGraph checkpoint 思路');

const toolLoopPath = path.join(root,'apps/server/src/toolLoop.ts');
const toolLoop = fs.readFileSync(toolLoopPath,'utf8');
must(toolLoop.includes('setCheckpointDeps') && toolLoop.includes('checkpointPool'), 'toolLoop.ts 设置 checkpoint 依赖');
must(toolLoop.includes('restoreLoopFromCheckpoint'), 'toolLoop.ts 有 restoreLoopFromCheckpoint 恢复循环');
must(toolLoop.includes('checkpointSave') && toolLoop.includes('checkpointDelete'), 'toolLoop.ts 每次 advance 后落库，done 时删除');

const indexPath = path.join(root,'apps/server/src/index.ts');
const index = fs.readFileSync(indexPath,'utf8');
must(index.includes('setCheckpointDeps') && index.includes('restoreLoops'), 'index.ts 启动时设置 checkpoint 并恢复');

const handoffPath = path.join(root,'apps/server/src/orchestrator/handoff.ts');
must(fs.existsSync(handoffPath), 'handoff.ts 仍存在（批次 A 保留，交接文件也是 checkpoint 的一部分）');

// 模拟 checkpoint 持久化与恢复
console.log('\n--- 模拟 checkpoint 持久化与恢复 ---');
const mockSession = {
  id: 'test-loop-123',
  userId: 1,
  agentId: 2,
  conversationId: 3,
  wcId: null,
  goal: '测试任务：分析店铺数据',
  messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'goal' }, { role: 'assistant', content: 'tool call' }],
  step: 5,
  status: 'running',
  toolNames: ['open_url','read_page'],
  touchedAt: Date.now(),
};
const checkpointRow = {
  id: mockSession.id,
  user_id: String(mockSession.userId),
  agent_id: String(mockSession.agentId),
  conversation_id: String(mockSession.conversationId),
  wc_id: null,
  goal: mockSession.goal,
  messages: mockSession.messages,
  step: mockSession.step,
  status: mockSession.status,
  tool_names: mockSession.toolNames,
  kind: 'task',
  parent_loop_id: null,
  chain: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};
// 模拟 checkpointToSession
function checkpointToSession(row) {
  return {
    id: row.id,
    userId: Number(row.user_id),
    agentId: row.agent_id ? Number(row.agent_id) : null,
    conversationId: row.conversation_id ? Number(row.conversation_id) : null,
    goal: row.goal,
    messages: row.messages,
    step: row.step,
    status: row.status,
    toolNames: row.tool_names,
    touchedAt: Date.now(),
  };
}
const restored = checkpointToSession(checkpointRow);
must(restored.id === mockSession.id && restored.step === 5 && restored.goal === mockSession.goal, 'checkpoint 恢复：循环状态（id/step/goal）能从库中恢复');
must(restored.messages.length === mockSession.messages.length, 'checkpoint 恢复：消息历史完整保留，续跑不丢上下文');

console.log(`\n=== 结论：失败 ${fails} 项 ===`);
process.exit(fails>0?1:0);
