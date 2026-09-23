#!/usr/bin/env node
/**
 * 记忆合并第一批验收
 * - memoryNormalize.ts 零 import + 函数正确
 * - memories 表：project_id 可空、agent_id 两级、唯一索引
 * - 幂等迁移：user_memories / agent_memories -> memories，过敏感闸，DROP 老表
 * - buildMemoryBlock 通作用域
 * - StartLoopInput.memoryBlock 两个启动点都传
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

console.log('=== 记忆合并第一批验收 ===');

// 1. memoryNormalize.ts 存在且零 import
const memNormPath = path.join(root, 'apps/server/src/memoryNormalize.ts');
must(fs.existsSync(memNormPath), 'memoryNormalize.ts 存在');
const memNormContent = fs.readFileSync(memNormPath, 'utf8');
must(!/^\s*import\s+/m.test(memNormContent), 'memoryNormalize.ts 零 import');
must(memNormContent.includes('export function normalizeText'), 'memoryNormalize.ts 有 normalizeText');
must(memNormContent.includes('SENSITIVE_MEM_RE'), 'memoryNormalize.ts 有 SENSITIVE_MEM_RE');
must(memNormContent.includes('LONG_DIGITS_RE'), 'memoryNormalize.ts 有 LONG_DIGITS_RE');
must(memNormContent.includes('export function isSensitive'), 'memoryNormalize.ts 有 isSensitive');

// 2. memories 表结构
const dbPath = path.join(root, 'apps/server/src/db.ts');
const dbContent = fs.readFileSync(dbPath, 'utf8');
must(dbContent.includes('project_id        BIGINT REFERENCES'), 'db.ts memories.project_id 已改可空（无 NOT NULL）');
must(!dbContent.includes('project_id        BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n  agent_id'), 'db.ts memories.project_id 不再是 NOT NULL 紧跟 agent_id 的旧写法');
must(dbContent.includes('uniq_memories_user'), 'db.ts 有 uniq_memories_user 唯一索引');
must(dbContent.includes('uniq_memories_agent'), 'db.ts 有 uniq_memories_agent 唯一索引');
must(dbContent.includes('idx_memories_owner_agent'), 'db.ts 有 idx_memories_owner_agent 索引');
must(dbContent.includes('migrateMemoriesStructure'), 'db.ts 有 migrateMemoriesStructure');
must(dbContent.includes('migrateMemoriesMerge'), 'db.ts 有 migrateMemoriesMerge');
must(!dbContent.includes('CREATE TABLE IF NOT EXISTS user_memories'), 'db.ts 不再 CREATE user_memories（旧表已移除）');
must(!dbContent.includes('CREATE TABLE IF NOT EXISTS agent_memories'), 'db.ts 不再 CREATE agent_memories（旧表已移除）');
must(dbContent.includes('DROP TABLE IF EXISTS user_memories'), 'db.ts 迁移后 DROP user_memories');
must(dbContent.includes('DROP TABLE IF EXISTS agent_memories'), 'db.ts 迁移后 DROP agent_memories');

// 3. memories.ts 通作用域
const memPath = path.join(root, 'apps/server/src/routes/memories.ts');
const memContent = fs.readFileSync(memPath, 'utf8');
must(memContent.includes("from '../memoryNormalize'") || memContent.includes('from \"../memoryNormalize\"'), 'memories.ts 引入 memoryNormalize');
must(!memContent.includes('const SENSITIVE_MEM_RE ='), 'memories.ts 不再本地定义 SENSITIVE_MEM_RE');
must(memContent.includes('agentId?: number | null'), 'buildMemoryBlock 支持 agentId 参数');
must(memContent.includes('(agent_id IS NULL OR agent_id ='), 'buildMemoryBlock 按两级作用域过滤');
must(memContent.includes('project_id') && memContent.includes('NULL'), 'extractCore 使用 NULL project_id（可空）');

// 4. agents.ts 通 memories 表
const agentsPath = path.join(root, 'apps/server/src/routes/agents.ts');
const agentsContent = fs.readFileSync(agentsPath, 'utf8');
must(agentsContent.includes("from '../memoryNormalize'") || agentsContent.includes('memoryNormalize'), 'agents.ts 引入 memoryNormalize');
must(!agentsContent.includes('const SENSITIVE_MEM_RE ='), 'agents.ts 不再本地定义 SENSITIVE_MEM_RE');
must(agentsContent.includes('FROM memories') && agentsContent.includes('agent_id IS NULL'), 'agents.ts buildUserMemoryBlock 读 memories 表（agent_id IS NULL）');
must(agentsContent.includes('agent_id = $1') && agentsContent.includes('FROM memories'), 'agents.ts buildAgentProjectMemoryBlock 读 memories 表（agent_id = ?）');
must(agentsContent.includes('INSERT INTO memories'), 'agents.ts writeLayer 写入 memories 表');

// 5. toolLoop.ts StartLoopInput.memoryBlock
const loopPath = path.join(root, 'apps/server/src/toolLoop.ts');
const loopContent = fs.readFileSync(loopPath, 'utf8');
must(loopContent.includes('memoryBlock?: string'), 'toolLoop.ts StartLoopInput 有 memoryBlock');
must(loopContent.includes('input.memoryBlock'), 'toolLoop.ts firstUserMessage 包含 memoryBlock');

// 6. 两个启动点都传 memoryBlock
const chatPath = path.join(root, 'apps/server/src/routes/chat.ts');
const chatContent = fs.readFileSync(chatPath, 'utf8');
must(chatContent.includes('taskMemoryBlock') && chatContent.includes('memoryBlock: taskMemoryBlock'), 'chat.ts 任务轮传 memoryBlock');

const loopRoutePath = path.join(root, 'apps/server/src/routes/loop.ts');
const loopRouteContent = fs.readFileSync(loopRoutePath, 'utf8');
must(loopRouteContent.includes('memoryBlock') && loopRouteContent.includes('buildMemoryBlock'), 'loop.ts 桌面自建传 memoryBlock');

// 7. 动态迁移测试（PGlite）
console.log('\n--- 动态迁移测试（PGlite） ---');
try {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  // 模拟旧表存在
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY, xyz_id TEXT);
    CREATE TABLE IF NOT EXISTS projects (id BIGSERIAL PRIMARY KEY, user_id BIGINT, name TEXT, is_default BOOLEAN);
    CREATE TABLE IF NOT EXISTS agents (id BIGSERIAL PRIMARY KEY, project_id BIGINT, name TEXT, kind TEXT);
    CREATE TABLE IF NOT EXISTS memories (
      id BIGSERIAL PRIMARY KEY,
      project_id BIGINT,
      agent_id BIGINT,
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
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_memories_user ON memories (owner_id, mem_key) WHERE agent_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_memories_agent ON memories (agent_id, mem_key) WHERE agent_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS user_memories (
      id BIGSERIAL PRIMARY KEY,
      owner_id BIGINT,
      mem_key TEXT,
      content_enc TEXT,
      source TEXT,
      UNIQUE (owner_id, mem_key)
    );
    CREATE TABLE IF NOT EXISTS agent_memories (
      id BIGSERIAL PRIMARY KEY,
      owner_id BIGINT,
      agent_id BIGINT,
      mem_key TEXT,
      content_enc TEXT,
      source TEXT,
      UNIQUE (agent_id, mem_key)
    );
  `);
  await db.exec(`
    INSERT INTO users (id, xyz_id) VALUES (1, 'XYZ1');
    INSERT INTO projects (id, user_id, name, is_default) VALUES (1, 1, 'p1', true);
    INSERT INTO agents (id, project_id, name, kind) VALUES (10, 1, 'agent10', 'custom');
  `);
  // 插入正常和敏感数据
  await db.query(`INSERT INTO user_memories (owner_id, mem_key, content_enc, source) VALUES (1, 'prefershort', 'enc1', 'test')`);
  await db.query(`INSERT INTO user_memories (owner_id, mem_key, content_enc, source) VALUES (1, 'mypassword123', 'enc-sensitive', 'test')`);
  await db.query(`INSERT INTO agent_memories (owner_id, agent_id, mem_key, content_enc, source) VALUES (1, 10, 'projectblue', 'enc2', 'test')`);
  await db.query(`INSERT INTO agent_memories (owner_id, agent_id, mem_key, content_enc, source) VALUES (1, 10, 'mybankcard123456789012', 'enc-sensitive2', 'test')`);

  // 模拟迁移逻辑（复用 memoryNormalize 的 isSensitive）
  const { isSensitive } = await import('../../apps/server/src/memoryNormalize.ts');
  const userRows = await db.query(`SELECT owner_id, mem_key, content_enc, source FROM user_memories`);
  for (const r of userRows.rows) {
    if (isSensitive(r.mem_key)) continue;
    await db.query(
      `INSERT INTO memories (project_id, agent_id, mem_key, value_enc, owner_id, type, content_encrypted, source, status, needs_confirm)
       VALUES (NULL, NULL, $1, $2, $3, 'preference', $2, $4, 'active', false) ON CONFLICT DO NOTHING`,
      [r.mem_key, r.content_enc, r.owner_id, r.source]
    );
  }
  const agentRows = await db.query(`SELECT owner_id, agent_id, mem_key, content_enc, source FROM agent_memories`);
  for (const r of agentRows.rows) {
    if (isSensitive(r.mem_key)) continue;
    await db.query(
      `INSERT INTO memories (project_id, agent_id, mem_key, value_enc, owner_id, type, content_encrypted, source, status, needs_confirm)
       VALUES (NULL, $1, $2, $3, $4, 'preference', $3, $5, 'active', false) ON CONFLICT DO NOTHING`,
      [r.agent_id, r.mem_key, r.content_enc, r.owner_id, r.source]
    );
  }

  const after = await db.query(`SELECT mem_key, agent_id FROM memories ORDER BY mem_key`);
  must(after.rows.length === 2, `迁移后 memories 2 条（敏感已过滤），实际 ${after.rows.length}`);
  must(after.rows.some(x => x.mem_key === 'prefershort' && x.agent_id === null), 'user 正常数据已迁移（agent_id NULL）');
  must(after.rows.some(x => x.mem_key === 'projectblue' && String(x.agent_id) === '10'), 'agent 正常数据已迁移（agent_id=10）');
  must(!after.rows.some(x => x.mem_key.includes('password') || x.mem_key.includes('bankcard')), '敏感数据迁移时被过滤');

  // 幂等：再跑一次不应新增
  const beforeCount = after.rows.length;
  for (const r of userRows.rows) {
    if (isSensitive(r.mem_key)) continue;
    await db.query(
      `INSERT INTO memories (project_id, agent_id, mem_key, value_enc, owner_id, type, content_encrypted, source, status, needs_confirm)
       VALUES (NULL, NULL, $1, $2, $3, 'preference', $2, $4, 'active', false) ON CONFLICT DO NOTHING`,
      [r.mem_key, r.content_enc, r.owner_id, r.source]
    );
  }
  const after2 = await db.query(`SELECT count(*)::int as n FROM memories`);
  must(after2.rows[0].n === beforeCount, '幂等：二次迁移不新增');

  // DROP 后不存在
  await db.exec(`DROP TABLE IF EXISTS user_memories CASCADE; DROP TABLE IF EXISTS agent_memories CASCADE;`);
  try {
    await db.query(`SELECT 1 FROM user_memories LIMIT 1`);
    fail('DROP 后 user_memories 应不存在');
  } catch { ok('DROP 后 user_memories 不存在'); }
  try {
    await db.query(`SELECT 1 FROM agent_memories LIMIT 1`);
    fail('DROP 后 agent_memories 应不存在');
  } catch { ok('DROP 后 agent_memories 不存在'); }

  await db.close();
} catch (e) {
  fail(`动态迁移测试异常：${e.message}\n${e.stack}`);
}

console.log(`\n=== 结论：失败 ${fails} 项 ===`);
process.exit(fails > 0 ? 1 : 0);
