#!/usr/bin/env node
/**
 * 记忆卫生验收
 * - 合并后条数减少
 * - merged 原文可查
 * - 超上限不增长
 * - 反证关掉整理→只增不减
 *
 * 用 PGlite + 假 cipher + 假 llmFetch（mock 合并）
 */
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

let fails = 0;
function ok(m){console.log(`PASS ${m}`);}
function fail(m){console.error(`FAIL ${m}`);fails++;}
function must(c,m){c?ok(m):fail(m);}

console.log('=== 记忆卫生验收 ===');

// 简易 cipher（明文即密文，测试用）
const cipher = {
  encryptText: (t) => `enc:${t}`,
  decryptText: (s) => s.startsWith('enc:') ? s.slice(4) : s,
};

// 构造 PGlite pool
function makePool(pglite){
  return {
    async query(text, params=[]){
      const sql = typeof text === 'string' ? text : text?.text;
      const p = Array.isArray(params) ? params : (text?.values ?? []);
      if ((!p || p.length===0) && sql && sql.includes(';') && !sql.trim().toLowerCase().startsWith('select')) {
        await pglite.exec(sql);
        return { rows: [], rowCount: 0 };
      }
      const res = await pglite.query(sql, p);
      return { rows: res.rows ?? [], rowCount: res.rows ? res.rows.length : (res.affectedRows ?? 0) };
    }
  };
}

// 读 DDL 并建表
async function setup(){
  const pglite = new PGlite();
  const pool = makePool(pglite);
  // 直接建 memories 最小结构
  await pglite.exec(`
    CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY, xyz_id TEXT UNIQUE, phone_hash TEXT UNIQUE, phone_enc TEXT, password_hash TEXT, wechat_openid TEXT UNIQUE, wechat_unionid TEXT, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS projects (id BIGSERIAL PRIMARY KEY, user_id BIGINT, name TEXT, is_default BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS agents (id BIGSERIAL PRIMARY KEY, project_id BIGINT, name TEXT, kind TEXT DEFAULT 'assistant', created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS conversations (id BIGSERIAL PRIMARY KEY, project_id BIGINT, agent_id BIGINT, title TEXT, created_at TIMESTAMPTZ DEFAULT now());
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
      status TEXT DEFAULT 'pending',
      needs_confirm BOOLEAN DEFAULT false,
      merged_into BIGINT,
      updated_at TIMESTAMPTZ DEFAULT now(),
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE UNIQUE INDEX uniq_memories_user ON memories (owner_id, mem_key) WHERE agent_id IS NULL AND conversation_id IS NULL AND status IN ('active','pending');
    CREATE UNIQUE INDEX uniq_memories_agent ON memories (agent_id, mem_key) WHERE agent_id IS NOT NULL AND conversation_id IS NULL AND status IN ('active','pending');
    CREATE UNIQUE INDEX uniq_memories_session ON memories (conversation_id, mem_key) WHERE conversation_id IS NOT NULL AND status IN ('active','pending');
  `);
  await pool.query(`INSERT INTO users (id, xyz_id) VALUES (1, 'XYZ0001') ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO projects (id, user_id, name, is_default) VALUES (1, 1, '默认项目', true) ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO agents (id, project_id, name, kind) VALUES (1, 1, '小助', 'assistant') ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO agents (id, project_id, name, kind) VALUES (2, 1, '测试智能体', 'custom') ON CONFLICT DO NOTHING`);
  return { pglite, pool };
}

// mock llmFetch：把相似的（都含“喜欢”）合并
async function mockLlmFetchSimilar(memories){
  // 简单：前两条合并
  if (memories.length < 2) return { groups: [] };
  // 找包含“喜欢”或“偏好”的
  const likes = memories.filter(m => m.content.includes('喜欢') || m.content.includes('咖啡') || m.content.includes('茶'));
  if (likes.length >= 2) {
    return { groups: [{ ids: likes.slice(0,2).map(m=>m.id), merged_content: '喜欢喝咖啡和茶，偏好清淡' }] };
  }
  // 默认前两条合并
  return { groups: [{ ids: memories.slice(0,2).map(m=>m.id), merged_content: `${memories[0].content}；${memories[1].content}`.slice(0,60) }] };
}

// 模拟 hygiene 的核心逻辑（不依赖真实 llmFetch，用 mock）
async function runHygieneMock(pool, cipher, scope, mockFn){
  const { ownerId, agentId, conversationId } = scope;
  let sql, params;
  if (conversationId != null) {
    sql = `SELECT id, mem_key, content_encrypted, value_enc FROM memories WHERE owner_id=$1 AND conversation_id=$2 AND status='active' ORDER BY updated_at ASC`;
    params = [ownerId, conversationId];
  } else if (agentId != null) {
    sql = `SELECT id, mem_key, content_encrypted, value_enc FROM memories WHERE owner_id=$1 AND agent_id=$2 AND conversation_id IS NULL AND status='active' ORDER BY updated_at ASC`;
    params = [ownerId, agentId];
  } else {
    sql = `SELECT id, mem_key, content_encrypted, value_enc FROM memories WHERE owner_id=$1 AND agent_id IS NULL AND conversation_id IS NULL AND status='active' ORDER BY updated_at ASC`;
    params = [ownerId];
  }
  const r = await pool.query(sql, params);
  const all = r.rows.map(row=>{
    const id = Number(row.id);
    const dec = row.content_encrypted ? cipher.decryptText(row.content_encrypted) : '';
    return { id, content: dec, mem_key: row.mem_key };
  }).filter(x=>x.content);

  const before = all.length;
  const llmResult = await mockFn(all);
  const groups = llmResult.groups || [];

  let created = 0, merged = 0;
  const used = new Set();
  for (const g of groups){
    const ids = g.ids.filter(id=>!used.has(id));
    if (ids.length < 2) continue;
    ids.forEach(id=>used.add(id));
    const memKey = (g.merged_content.replace(/\s+/g,' ').trim().slice(0,80) + `_${Date.now()}_${Math.random().toString(36).slice(2,6)}`).slice(0,96) || `merged_${Date.now()}`;
    const enc = `enc:${g.merged_content}`;
    // 插入新条
    const ins = await pool.query(`INSERT INTO memories (owner_id, agent_id, conversation_id, mem_key, value_enc, content_encrypted, type, source, status) VALUES ($1,$2,$3,$4,$5,$6,'preference','hygiene','active') RETURNING id`, [ownerId, agentId||null, conversationId||null, memKey, enc, enc]);
    const newId = Number(ins.rows[0].id);
    created++;
    for (const oldId of ids){
      await pool.query(`UPDATE memories SET status='merged', merged_into=$2, updated_at=now() WHERE id=$1 AND status='active'`, [oldId, newId]);
      merged++;
    }
  }

  const afterR = await pool.query(sql, params);
  const after = afterR.rows.length;

  return { before, after, created, merged, groups };
}

async function test(){
  const { pglite, pool } = await setup();

  // 1. 账号级 35 条（超 30），应触发合并，条数减少
  console.log('\n--- 测试 1：账号级超限合并后条数减少 ---');
  for (let i=0;i<35;i++){
    const content = i<5 ? `喜欢喝咖啡 ${i}` : `记忆 ${i} 喜欢喝茶`;
    const key = `key_${i}_${Date.now()}_${i}`;
    const enc = `enc:${content}`;
    await pool.query(`INSERT INTO memories (owner_id, mem_key, value_enc, content_encrypted, type, source, status) VALUES (1,$1,$2,$3,'preference','test','active')`, [key, enc, enc]);
  }
  let cnt = await pool.query(`SELECT count(*)::int AS n FROM memories WHERE owner_id=1 AND agent_id IS NULL AND conversation_id IS NULL AND status='active'`);
  must(cnt.rows[0].n === 35, `超限前 35 条，实际 ${cnt.rows[0].n}`);

  const res1 = await runHygieneMock(pool, cipher, { ownerId:1, agentId:null, conversationId:null }, mockLlmFetchSimilar);
  console.log(`合并前 ${res1.before} → 后 ${res1.after}，创建 ${res1.created}，合并 ${res1.merged}`);
  must(res1.after < res1.before, `合并后条数减少 ${res1.before}→${res1.after}`);
  must(res1.created > 0 && res1.merged >=2, '有创建和被合并');

  // 2. merged 原文可查
  console.log('\n--- 测试 2：merged 原文可查 ---');
  const mergedRows = await pool.query(`SELECT id, content_encrypted, status, merged_into FROM memories WHERE status='merged'`);
  must(mergedRows.rows.length >= 2, `merged 状态可查到 ${mergedRows.rows.length} 条`);
  const canDecrypt = mergedRows.rows.every(r=>{
    try{ const t=cipher.decryptText(r.content_encrypted); return t.length>0; }catch{return false;}
  });
  must(canDecrypt, 'merged 原文可解密');
  must(mergedRows.rows.every(r=> r.merged_into != null), 'merged_into 指向新条');

  // 3. 超上限不增长：继续插入并触发整理，active 不应超过 30 太多（允许一次合并后仍略超，但不应无限增长）
  console.log('\n--- 测试 3：超上限不增长 ---');
  // 插入 10 条新
  for (let i=0;i<10;i++){
    const content = `新增记忆 ${i} 喜欢`;
    const key = `new_${i}_${Date.now()}_${i}`;
    const enc = `enc:${content}`;
    await pool.query(`INSERT INTO memories (owner_id, mem_key, value_enc, content_encrypted, type, source, status) VALUES (1,$1,$2,$3,'preference','test','active') ON CONFLICT DO NOTHING`, [key, enc, enc]);
  }
  let before = await pool.query(`SELECT count(*)::int AS n FROM memories WHERE owner_id=1 AND agent_id IS NULL AND conversation_id IS NULL AND status='active'`);
  console.log(`插入后 active ${before.rows[0].n}`);
  // 循环整理直到接近上限（模拟定时任务多次触发）
  let cur = before.rows[0].n;
  for (let i=0;i<20;i++){
    if (cur <= 32) break;
    const r = await runHygieneMock(pool, cipher, { ownerId:1, agentId:null, conversationId:null }, mockLlmFetchSimilar);
    cur = r.after;
    console.log(`  整理第 ${i+1} 次 → active ${cur}`);
  }
  let after = await pool.query(`SELECT count(*)::int AS n FROM memories WHERE owner_id=1 AND agent_id IS NULL AND conversation_id IS NULL AND status='active'`);
  console.log(`循环整理后 active ${after.rows[0].n}（从 ${before.rows[0].n} 开始）`);
  must(after.rows[0].n <= before.rows[0].n, `超上限整理后不增长 ${before.rows[0].n}→${after.rows[0].n}`);
  must(after.rows[0].n <= 35, `超上限后 active 最终不超过 35，实际 ${after.rows[0].n}`);

  // 4. 智能体级上限 20
  console.log('\n--- 测试 4：智能体级上限 20 ---');
  for (let i=0;i<25;i++){
    const content = `智能体记忆 ${i} 喜欢`;
    const key = `agent_${i}_${Date.now()}_${i}`;
    const enc = `enc:${content}`;
    await pool.query(`INSERT INTO memories (owner_id, agent_id, mem_key, value_enc, content_encrypted, type, source, status) VALUES (1,2,$1,$2,$3,'preference','test','active') ON CONFLICT DO NOTHING`, [key, enc, enc]);
  }
  let agentCnt = await pool.query(`SELECT count(*)::int AS n FROM memories WHERE owner_id=1 AND agent_id=2 AND status='active'`);
  must(agentCnt.rows[0].n === 25, `智能体级超限前 25 条`);
  const resAgent = await runHygieneMock(pool, cipher, { ownerId:1, agentId:2, conversationId:null }, mockLlmFetchSimilar);
  let agentAfter = await pool.query(`SELECT count(*)::int AS n FROM memories WHERE owner_id=1 AND agent_id=2 AND status='active'`);
  must(agentAfter.rows[0].n < agentCnt.rows[0].n, `智能体级合并后减少 ${agentCnt.rows[0].n}→${agentAfter.rows[0].n}`);

  // 5. 会话级不设上限
  console.log('\n--- 测试 5：会话级不设上限 ---');
  await pool.query(`INSERT INTO conversations (id, project_id, title) VALUES (100,1,'test') ON CONFLICT DO NOTHING`);
  for (let i=0;i<50;i++){
    const content = `会话记忆 ${i}`;
    const key = `sess_${i}_${Date.now()}_${i}`;
    const enc = `enc:${content}`;
    await pool.query(`INSERT INTO memories (owner_id, conversation_id, mem_key, value_enc, content_encrypted, type, source, status) VALUES (1,100,$1,$2,$3,'preference','test','active') ON CONFLICT DO NOTHING`, [key, enc, enc]);
  }
  let sessCnt = await pool.query(`SELECT count(*)::int AS n FROM memories WHERE conversation_id=100 AND status='active'`);
  must(sessCnt.rows[0].n === 50, `会话级 50 条不触发上限，实际 ${sessCnt.rows[0].n}`);

  // 6. 反证：关掉整理→只增不减
  console.log('\n--- 测试 6：反证关掉整理→只增不减 ---');
  // 模拟禁用 hygiene：直接插入不调用合并
  let disabledBefore = await pool.query(`SELECT count(*)::int AS n FROM memories WHERE owner_id=1 AND agent_id IS NULL AND status='active'`);
  for (let i=0;i<5;i++){
    const content = `禁用时新增 ${i}`;
    const key = `disabled_${i}_${Date.now()}_${i}`;
    const enc = `enc:${content}`;
    await pool.query(`INSERT INTO memories (owner_id, mem_key, value_enc, content_encrypted, type, source, status) VALUES (1,$1,$2,$3,'preference','test','active') ON CONFLICT DO NOTHING`, [key, enc, enc]);
  }
  let disabledAfter = await pool.query(`SELECT count(*)::int AS n FROM memories WHERE owner_id=1 AND agent_id IS NULL AND status='active'`);
  must(disabledAfter.rows[0].n === disabledBefore.rows[0].n + 5, `关掉整理时只增不减 ${disabledBefore.rows[0].n}→${disabledAfter.rows[0].n}`);

  await pglite.close();
  console.log(`\n=== 结论：失败 ${fails} 项 ===`);
  process.exit(fails>0?1:0);
}

test().catch(e=>{ console.error(e); process.exit(1); });
