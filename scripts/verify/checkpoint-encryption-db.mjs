#!/usr/bin/env node
/**
 * 收尾 1 | 复验 loop_checkpoints 加密 —— **直接查真库**，不读源码、不信别的验收脚本。
 *
 * 为什么要有这个脚本：上一轮分支分叉 + 合并冲突，`verify_fixes.mjs` 当时的「修 1 加密反证」
 * 只是在脚本里自己造了一个 cipher 加密一段字符串，再断言密文里没有明文 ——
 * **根本没碰数据库，也没碰 checkpoint.ts 的真实落库路径**。合并就算吃掉了加密，它照样 PASS。
 *
 * 这里走的是真链路：
 *   真服务端（tsx 跑 apps/server/src/index.ts，mock LLM）
 *   → 真登录（/auth/sms/send + /auth/login/sms）
 *   → /agent/loop/start（goal 带敏感词）→ /agent/loop/next 推进几步（每步都会落 checkpoint）
 *   → 用 pg 直连**真 PostgreSQL**：
 *       SELECT goal, goal_enc, messages, messages_enc FROM loop_checkpoints ORDER BY updated_at DESC LIMIT 3;
 *   → 断言 goal IS NULL、messages = '[]'、goal_enc / messages_enc 以 gcm$ 开头、
 *     整行 row_to_json 里**搜不到任何一个敏感词**；
 *   → 再用同一把 DATA_KEY 解密，确认密文能还原（证明不是「写了个乱码」凑数）。
 *
 * 用法：
 *   VERIFY_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/db node scripts/verify/checkpoint-encryption-db.mjs
 *   （库需要是一个**可以随便写的测试库**：脚本会建表、插用户，不会删别人的数据）
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { Client } = require(require.resolve('pg', { paths: [path.join(ROOT, 'apps/server')] }));

const DB = process.env.VERIFY_DATABASE_URL;
if (!DB) {
  console.error('需要 VERIFY_DATABASE_URL（指向一个可写的测试库）');
  process.exit(2);
}
const PORT = Number(process.env.VERIFY_PORT || 18787);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_KEY = crypto.randomBytes(32).toString('hex');
const SENSITIVE = ['银行卡6222021234567890', '密码Zx9!secret', '身份证110101199003071234'];
const GOAL = `帮我查一下 ${SENSITIVE[0]} 的余额，登录用 ${SENSITIVE[1]}，实名 ${SENSITIVE[2]}`;

let failed = false;
function check(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failed = true;
}

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), 'apps/server/src/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: DB,
      JWT_SECRET: crypto.randomBytes(24).toString('hex'),
      DATA_KEY,
      PHONE_PEPPER: crypto.randomBytes(32).toString('hex'),
      NODE_ENV: 'development',
      SMS_MOCK: '1',
      DEEPSEEK_API_KEY: 'mock',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  return { child, getLog: () => log };
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await fn()) return;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function j(method, url, body, token) {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${text.slice(0, 200)}`);
  return data;
}

function openGcm(payload, dataKey) {
  const key = /^[0-9a-fA-F]{64}$/.test(dataKey) ? Buffer.from(dataKey, 'hex') : crypto.createHash('sha256').update(dataKey).digest();
  const [tag, iv, auth, ct] = payload.split('$');
  if (tag !== 'gcm') throw new Error('not gcm');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(auth, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

const { child, getLog } = startServer();
try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 30_000, '服务端 /health');
  // 迁移是 listen 之后后台跑的，等表出来
  await waitFor(() => getLog().includes('数据库表就绪'), 60_000, '迁移完成');

  const phone = `139${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const sent = await j('POST', '/auth/sms/send', { phone });
  const login = await j('POST', '/auth/login/sms', { phone, code: sent.mock_code });
  const token = login.token;
  check(typeof token === 'string' && token.length > 20, '真登录拿到 JWT');

  const agents = await j('GET', '/agents', null, token);
  const agentList = agents.agents ?? agents.items ?? agents;
  const agentId = Array.isArray(agentList) && agentList[0] ? Number(agentList[0].id) : null;

  const start = await j('POST', '/agent/loop/start', { goal: GOAL, agentId, wcId: 7 }, token);
  const loopId = start.loopId;
  check(typeof loopId === 'string', `建循环 ${loopId}`);

  // 推进两步：第一步模型决定 read_page（落 pending checkpoint），第二步回报结果（落 executed checkpoint）
  const d1 = await j('POST', '/agent/loop/next', { loopId, agentId, wcId: 7, result: null }, token);
  const call1 = d1.decision?.call;
  await j(
    'POST',
    '/agent/loop/next',
    {
      loopId,
      agentId,
      wcId: 7,
      result: { ok: true, detail: `页面里写着 ${SENSITIVE[0]}`, page: { url: 'https://bank.example/', title: '网银' } },
    },
    token,
  );
  console.log(`      第一步决策：${d1.decision?.kind} ${call1?.name ?? ''}`);

  // checkpoint 是 fire-and-forget 写的，给它一点时间落盘
  await new Promise((r) => setTimeout(r, 800));

  const c = new Client({ connectionString: DB });
  await c.connect();
  const rows = (
    await c.query(
      'SELECT id, goal, goal_enc, messages, messages_enc FROM loop_checkpoints ORDER BY updated_at DESC LIMIT 3',
    )
  ).rows;
  const whole = (
    await c.query('SELECT row_to_json(t)::text AS j FROM loop_checkpoints t WHERE id = $1', [loopId])
  ).rows[0]?.j ?? '';
  await c.end();

  console.log('\n--- SELECT goal, goal_enc, messages, messages_enc FROM loop_checkpoints ORDER BY updated_at DESC LIMIT 3 ---');
  for (const r of rows) {
    console.log(
      JSON.stringify({
        id: r.id,
        goal: r.goal,
        goal_enc: r.goal_enc ? r.goal_enc.slice(0, 28) + '…' : r.goal_enc,
        messages: r.messages,
        messages_enc: r.messages_enc ? r.messages_enc.slice(0, 28) + '…' : r.messages_enc,
      }),
    );
  }
  console.log('');

  // 全表兜底扫一遍：不管是哪条循环写的，库里任何一行都不许出现敏感词
  const c2 = new Client({ connectionString: DB });
  await c2.connect();
  const leak = (
    await c2.query(
      `SELECT count(*)::int AS n FROM loop_checkpoints t WHERE row_to_json(t)::text LIKE ANY($1)`,
      [SENSITIVE.map((s) => `%${s}%`)],
    )
  ).rows[0].n;
  await c2.end();
  check(leak === 0, `全表 row_to_json 扫描：含敏感词的行数 = ${leak}`);

  const row = rows.find((r) => r.id === loopId);
  if (process.env.VERIFY_EXPECT_NO_ROW === '1') {
    // 变异模式：服务端故意没拿到 cipher → 期望 fail-closed，一行都不落，而不是落明文
    check(!row, 'fail-closed：没有 cipher 时这条循环的 checkpoint 一行都没写');
  } else {
    check(!!row, '本次循环的 checkpoint 真的落库了（不是空表凑出来的 PASS）');
  }
  if (row) {
    check(row.goal === null, `goal 列为 NULL（实际：${JSON.stringify(row.goal)}）`);
    check(Array.isArray(row.messages) && row.messages.length === 0, `messages 列为 '[]'（实际：${JSON.stringify(row.messages).slice(0, 60)}）`);
    check(typeof row.goal_enc === 'string' && row.goal_enc.startsWith('gcm$'), 'goal_enc 以 gcm$ 开头');
    check(typeof row.messages_enc === 'string' && row.messages_enc.startsWith('gcm$'), 'messages_enc 以 gcm$ 开头');
    for (const s of SENSITIVE) check(!whole.includes(s), `整行 row_to_json 里读不到「${s}」`);
    check(!/[\u4e00-\u9fa5]{2,}/.test(row.goal_enc + row.messages_enc), '密文列里一个中文字都没有');
    // 反向：同一把钥匙能解回原文 → 证明是真加密，不是把内容丢了
    const goalBack = openGcm(row.goal_enc, DATA_KEY);
    const msgsBack = JSON.parse(openGcm(row.messages_enc, DATA_KEY));
    check(goalBack === GOAL, '用 DATA_KEY 解 goal_enc 能还原原始 goal');
    check(Array.isArray(msgsBack) && msgsBack.length >= 2 && JSON.stringify(msgsBack).includes(SENSITIVE[0]), `解 messages_enc 能还原 ${msgsBack.length} 条消息（含敏感词，说明加密的是真内容）`);
  }
} catch (err) {
  console.error('FAIL  脚本异常：', err.message);
  console.error(getLog().split('\n').slice(-30).join('\n'));
  failed = true;
} finally {
  child.kill('SIGTERM');
}
console.log(failed ? '\n=== 收尾1 加密复验：FAIL ===' : '\n=== 收尾1 加密复验：全部 PASS ===');
process.exit(failed ? 1 : 0);
