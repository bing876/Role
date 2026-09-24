#!/usr/bin/env node
/**
 * 记忆合并第二批验收：会话作用域
 * - memories 表加 conversation_id 列，三级作用域
 * - 三级唯一索引
 * - buildMemoryBlock 支持 conversationId，三级合并注入
 * - extractCore 支持 conversationId 写入
 * - chat.ts / loop.ts 传入 conversationId
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

console.log('=== 记忆合并第二批验收：会话作用域 ===');

// 1. db.ts 结构
const dbPath = path.join(root, 'apps/server/src/db.ts');
const dbContent = fs.readFileSync(dbPath, 'utf8');
must(dbContent.includes('conversation_id   BIGINT REFERENCES conversations'), 'db.ts DDL 有 conversation_id');
must(dbContent.includes('ALTER TABLE memories ADD COLUMN IF NOT EXISTS conversation_id'), 'db.ts ALTER 有 conversation_id');
must(dbContent.includes('uniq_memories_user') && dbContent.includes('conversation_id IS NULL'), 'db.ts uniq_memories_user 包含 conversation_id IS NULL');
must(dbContent.includes('uniq_memories_agent') && dbContent.includes('conversation_id IS NULL'), 'db.ts uniq_memories_agent 包含 conversation_id IS NULL');
must(dbContent.includes('uniq_memories_session'), 'db.ts 有 uniq_memories_session');
must(dbContent.includes('idx_memories_conversation'), 'db.ts 有 idx_memories_conversation');
must(dbContent.includes('idx_memories_owner_agent_conv'), 'db.ts 有 idx_memories_owner_agent_conv');

// 2. memories.ts 三级作用域
const memPath = path.join(root, 'apps/server/src/routes/memories.ts');
const memContent = fs.readFileSync(memPath, 'utf8');
must(memContent.includes('conversationId?: number | null'), 'memories.ts buildMemoryBlock 支持 conversationId');
must(memContent.includes('hasConv'), 'memories.ts 有 hasConv 逻辑');
must(memContent.includes('conversation_id = $3') || memContent.includes('conversation_id = $2'), 'memories.ts 查询包含 conversation_id');
must((memContent.includes('conversation_id, mem_key') && memContent.includes('project_id, agent_id, conversation_id')) || memContent.includes('writeMemoryRow'), 'memories.ts 写入包含 conversation_id（或走共享写入）');
must(memContent.includes('extractCore') && memContent.includes('conversationId'), 'memories.ts extractCore 支持 conversationId');
must(memContent.includes('chat_idle') && memContent.includes('convId'), 'memories.ts idle 调度传入 convId');

// 3. chat.ts 传入 conversationId
const chatPath = path.join(root, 'apps/server/src/routes/chat.ts');
const chatContent = fs.readFileSync(chatPath, 'utf8');
/**
 * ★ 2026-09-24（批次 J · @点名换人）改的是**断言的写法**，不是断言的要求。
 *
 * 原来这两条比的是逐字面量的调用串：
 *   `buildMemoryBlock(pool, cipher, claims.sub, message, loopAgentId`
 *   `buildMemoryBlock(pool, cipher, claims.sub, message, agentId`
 * 批次 J 把两处调用的实参改了：
 *   · 检索用的正文从 `message` 换成剥掉 @名字 的 `mentionText`（@名字 不是记忆关键词）；
 *   · 「按谁取记忆」从 `agentId` 换成这一轮的发言人 `turnSpeakerId ?? agentId`（换人轮要读被点名者那一份，
 *     否则第 15 步「项目记忆绝不串号」那条规矩在换人之后就破了）。
 * 字面量散了，但**这条要求一个字没变**：两轮都必须把 convId 传进去（会话级记忆靠它）。
 *
 * 所以改成「把 chat.ts 里所有 buildMemoryBlock 调用抓出来，逐个看最后一个实参」：
 * 比字面量更严（将来新增调用点也会被查到），也不再因为参数改名而假红。
 */
const memCalls = [...chatContent.matchAll(/buildMemoryBlock\(([\s\S]*?)\);/g)].map((m) => m[1].trim());
must(memCalls.length >= 2, `chat.ts 里 buildMemoryBlock 调用 ${memCalls.length} 处（应 ≥2：任务轮 + 闲聊轮）`);
must(
  memCalls.every((c) => /convId\s*\?\?\s*null$/.test(c)),
  'chat.ts 每一处 buildMemoryBlock 都把 convId 作为最后一个实参传进去（任务轮 + 闲聊轮）',
);
must(
  memCalls.some((c) => c.includes('loopAgentId')) && memCalls.some((c) => c.includes('turnSpeakerId')),
  'chat.ts 任务轮按循环的智能体取记忆、闲聊轮按这一轮的发言人取记忆',
);

// 4. loop.ts 传入 conversationId
const loopPath = path.join(root, 'apps/server/src/routes/loop.ts');
const loopContent = fs.readFileSync(loopPath, 'utf8');
must(loopContent.includes('buildMemoryBlock(pool, cipher, claims.sub, goal, agentId') && loopContent.includes('conversationId'), 'loop.ts 传 conversationId');

// 5. agents.ts 过滤 conversation_id
const agentsPath = path.join(root, 'apps/server/src/routes/agents.ts');
const agentsContent = fs.readFileSync(agentsPath, 'utf8');
must(agentsContent.includes('conversation_id IS NULL'), 'agents.ts 查询过滤 conversation_id IS NULL');
must(agentsContent.includes('conversation_id, mem_key') || agentsContent.includes('writeTidyLayer') || agentsContent.includes('writeMemoryRow'), 'agents.ts 写入包含 conversation_id（或走共享写入）');

// 6. 动态三级作用域测试（PGlite）
console.log('\n--- 动态三级作用域测试（PGlite） ---');
try {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY, xyz_id TEXT);
    CREATE TABLE IF NOT EXISTS projects (id BIGSERIAL PRIMARY KEY, user_id BIGINT, name TEXT, is_default BOOLEAN);
    CREATE TABLE IF NOT EXISTS agents (id BIGSERIAL PRIMARY KEY, project_id BIGINT, name TEXT, kind TEXT);
    CREATE TABLE IF NOT EXISTS conversations (id BIGSERIAL PRIMARY KEY, project_id BIGINT, agent_id BIGINT, title TEXT);
    CREATE TABLE IF NOT EXISTS memories (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT,
      agent_id BIGINT,
      conversation_id BIGINT,
      mem_key TEXT NOT NULL,
      value_enc TEXT NOT NULL,
      owner_id BIGINT,
      type TEXT DEFAULT 'preference',
      content_encrypted TEXT,
      source TEXT,
      status TEXT DEFAULT 'active',
      needs_confirm BOOLEAN DEFAULT false,
      updated_at TIMESTAMPTZ DEFAULT now(),
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_memories_user ON memories (owner_id, mem_key) WHERE agent_id IS NULL AND conversation_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_memories_agent ON memories (agent_id, mem_key) WHERE agent_id IS NOT NULL AND conversation_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_memories_session ON memories (conversation_id, mem_key) WHERE conversation_id IS NOT NULL;
  `);
  await db.exec(`
    INSERT INTO users (id, xyz_id) VALUES (1, 'XYZ1');
    INSERT INTO projects (id, user_id, name, is_default) VALUES (1, 1, 'p1', true);
    INSERT INTO agents (id, project_id, name, kind) VALUES (10, 1, 'agent10', 'custom');
    INSERT INTO conversations (id, project_id, agent_id, title) VALUES (100, 1, 10, '会话100');
    INSERT INTO conversations (id, project_id, agent_id, title) VALUES (101, 1, 10, '会话101');
  `);
  // 插入三级数据
  await db.query(`INSERT INTO memories (project_id, agent_id, conversation_id, mem_key, value_enc, owner_id, type, content_encrypted, source, status, needs_confirm) VALUES (NULL, NULL, NULL, 'k1', 'enc1', 1, 'preference', 'enc1', 'test', 'active', false)`);
  await db.query(`INSERT INTO memories (project_id, agent_id, conversation_id, mem_key, value_enc, owner_id, type, content_encrypted, source, status, needs_confirm) VALUES (NULL, 10, NULL, 'k2', 'enc2', 1, 'preference', 'enc2', 'test', 'active', false)`);
  await db.query(`INSERT INTO memories (project_id, agent_id, conversation_id, mem_key, value_enc, owner_id, type, content_encrypted, source, status, needs_confirm) VALUES (NULL, 10, 100, 'k3', 'enc3', 1, 'preference', 'enc3', 'test', 'active', false)`);
  await db.query(`INSERT INTO memories (project_id, agent_id, conversation_id, mem_key, value_enc, owner_id, type, content_encrypted, source, status, needs_confirm) VALUES (NULL, NULL, 101, 'k4', 'enc4', 1, 'preference', 'enc4', 'test', 'active', false)`);

  // 查询：账号级 only
  const qAccount = await db.query(`SELECT mem_key FROM memories WHERE owner_id=1 AND agent_id IS NULL AND conversation_id IS NULL`);
  must(qAccount.rows.length === 1 && qAccount.rows[0].mem_key === 'k1', '账号级查询只返回 k1');

  // 查询：智能体级（账号+智能体）
  const qAgent = await db.query(`SELECT mem_key FROM memories WHERE owner_id=1 AND ((agent_id IS NULL AND conversation_id IS NULL) OR (agent_id=10 AND conversation_id IS NULL)) ORDER BY mem_key`);
  must(qAgent.rows.length === 2 && qAgent.rows.map(r=>r.mem_key).join(',') === 'k1,k2', '智能体级查询返回 k1,k2');

  // 查询：会话100（账号+智能体+会话100）
  const qConv100 = await db.query(`SELECT mem_key FROM memories WHERE owner_id=1 AND ((agent_id IS NULL AND conversation_id IS NULL) OR (agent_id=10 AND conversation_id IS NULL) OR (conversation_id=100)) ORDER BY mem_key`);
  must(qConv100.rows.length === 3 && qConv100.rows.map(r=>r.mem_key).join(',') === 'k1,k2,k3', '会话100查询返回 k1,k2,k3');

  // 查询：会话101（账号+会话101，不包含会话100的k3）
  const qConv101 = await db.query(`SELECT mem_key FROM memories WHERE owner_id=1 AND ((agent_id IS NULL AND conversation_id IS NULL) OR (conversation_id=101)) ORDER BY mem_key`);
  must(qConv101.rows.length === 2 && qConv101.rows.map(r=>r.mem_key).join(',') === 'k1,k4', '会话101查询返回 k1,k4（不包含k3）');

  // 唯一性：会话级唯一
  try {
    await db.query(`INSERT INTO memories (project_id, agent_id, conversation_id, mem_key, value_enc, owner_id, type, content_encrypted, source, status, needs_confirm) VALUES (NULL, 10, 100, 'k3', 'enc_dup', 1, 'preference', 'enc_dup', 'test', 'active', false)`);
    fail('会话级重复插入应被唯一索引拦截');
  } catch {
    ok('会话级唯一索引生效（重复k3被拦截）');
  }

  // 唯一性：账号级唯一
  try {
    await db.query(`INSERT INTO memories (project_id, agent_id, conversation_id, mem_key, value_enc, owner_id, type, content_encrypted, source, status, needs_confirm) VALUES (NULL, NULL, NULL, 'k1', 'enc_dup', 1, 'preference', 'enc_dup', 'test', 'active', false)`);
    fail('账号级重复插入应被唯一索引拦截');
  } catch {
    ok('账号级唯一索引生效（重复k1被拦截）');
  }

  await db.close();
} catch (e) {
  fail(`动态三级测试异常：${e.message}\n${e.stack}`);
}

console.log(`\n=== 结论：失败 ${fails} 项 ===`);
process.exit(fails > 0 ? 1 : 0);
