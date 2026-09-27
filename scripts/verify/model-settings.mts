/** 真模型接入 · 生产 app + PGlite + 真实 llmFetch HTTP 出口（只有上游模型由本机协议桩替代）。
 * 真 DeepSeek 准确率另跑 eval:model:live；此脚本绝不声称测到真模型。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadEnv } from '../../apps/server/src/env';
import { makeCipher } from '../../apps/server/src/crypto';
import { makePool, migrate } from '../../apps/server/src/db';
import { buildApp } from '../../apps/server/src/index';
import { llmFetch } from '../../apps/server/src/llm';
import { routeBySemantic } from '../../apps/server/src/orchestrator/chiefOfStaff';
import { runWorkerPool } from '../../apps/server/src/orchestrator/workers';
import { loadUserModelSetting } from '../../apps/server/src/modelSettings';

let passes = 0; let fails = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passes++; console.log(`  ✓ ${name}`); }
  catch (e) { fails++; console.log(`  ✗ ${name}: ${(e as Error).message.slice(0, 500)}`); }
}
interface Call { auth: string; path: string; body: Record<string, any> }
const calls: Call[] = [];
async function upstream() {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => raw += c);
    req.on('end', () => {
      const path = req.url ?? '';
      if (path === '/leak') { calls.push({ auth: String(req.headers.authorization || ''), path, body: {} }); res.end('leaked'); return; }
      if (!path.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
      const body = JSON.parse(raw) as Record<string, any>;
      calls.push({ auth: String(req.headers.authorization || ''), path, body });
      if (path.startsWith('/redirect/')) {
        res.writeHead(307, { location: '/leak' }).end();
        return;
      }
      const msgs: Array<{ content: string }> = body.messages ?? [];
      const text = msgs.map((m) => m.content).join('\n');
      const answer = text.includes('候选智能体') ? '{"choice":11,"reason":"职责匹配"}' :
        text.includes('临时工') ? '{"summary":"已汇报","findings":[],"confidence":"high"}' : 'OK';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }));
    });
  });
  return new Promise<{ base: string; close: () => Promise<void> }>((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
      close: () => new Promise((r) => srv.close(() => r())) }));
  });
}

async function main() {
  console.log('=== 模型配置：真库 + 真 JWT + 真生产 llmFetch/worker/路由 + 本机上游桩 ===');
  process.env.DATABASE_URL = 'pglite://memory';
  process.env.JWT_SECRET ??= 'verify-model-jwt-secret';
  process.env.DATA_KEY ??= 'verify-model-data-key-64-chars';
  process.env.PHONE_PEPPER ??= 'verify-model-pepper-64-chars';
  process.env.SMS_MOCK = '1';
  delete process.env.ENABLE_DEV_MOCK_LLM;
  const stub = await upstream();
  const env = { ...loadEnv(), deepseekApiKey: 'verify-env-key', deepseekBaseUrl: stub.base, deepseekModel: 'env-chat' };
  const cipher = makeCipher(env.dataKey);
  const pool = await makePool(env.databaseUrl);
  await migrate(pool);
  const app = await buildApp(env, pool, cipher);
  try {
    const json = { 'content-type': 'application/json' };
    async function login(phone: string) {
      const sent = await app.inject({ method: 'POST', url: '/auth/sms/send', headers: json, payload: { phone } });
      const code = sent.json().mock_code;
      const r = await app.inject({ method: 'POST', url: '/auth/login/sms', headers: json, payload: { phone, code } });
      const token = r.json().token; assert.ok(token);
      const auth = { ...json, authorization: `Bearer ${token}` };
      const me = await app.inject({ method: 'GET', url: '/auth/me', headers: auth });
      return { auth, id: Number(me.json().user.id) };
    }
    const a = await login('137' + String(Date.now()).slice(-8));
    const b = await login('138' + String(Date.now()).slice(-8));
    const api = (who: typeof a, method: 'GET' | 'POST' | 'DELETE', path: string, payload?: object) =>
      app.inject({ method, url: path, headers: who.auth, ...(payload ? { payload } : {}) });
    const call = async (userId: number, tag: string) => {
      const r = await llmFetch(env, [{ role: 'user', content: '验收调用' }], { tag, userId, timeoutMs: 5000 });
      assert.equal(r.status, 200);
      return calls.at(-1)!;
    };
    await check('① JWT 门禁；无本地行仅继承 env，绝不回 key', async () => {
      assert.equal((await app.inject({ method: 'GET', url: '/model/config' })).statusCode, 401);
      const av = await api(a, 'GET', '/model/config'); assert.equal(av.statusCode, 200);
      assert.equal(av.json().source, 'env'); assert.equal(av.json().apiKeyMasked, '****');
      assert.ok(!av.body.includes('verify-env-key'));
      assert.equal((await api(b, 'GET', '/model/config')).json().source, 'env');
    });
    await check('② 类型/URL/mock key 严格校验，非法配置没有落库/外呼', async () => {
      const n = calls.length;
      for (const input of [
        { provider: 'deepseek', apiKey: 'mock' },
        { provider: 'deepseek', apiKey: '****' },
        { provider: 'custom', model: 'm', baseUrl: 'http://outside.example', apiKey: 'test' },
        { provider: 'deepseek', apiKey: 42 },
        { provider: 'custom', model: 'm', baseUrl: 'https://user:pass@example.com', apiKey: 'test' },
      ]) assert.equal((await api(a, 'POST', '/model/config', input)).statusCode, 400);
      assert.equal(calls.length, n);
      assert.equal((await loadUserModelSetting(pool, cipher, a.id)).kind, 'missing');
    });
    await check('③ 本账号保存 DeepSeek→AES-GCM 密文、GET 仅 ****、B 看不到 A 本地配置', async () => {
      const r = await api(a, 'POST', '/model/config', { provider: 'deepseek', apiKey: 'verify-user-A-key', model: 'test-model-A', baseUrl: stub.base });
      assert.equal(r.statusCode, 200, r.body);
      assert.ok(!r.body.includes('verify-user-A-key'));
      const view = await api(a, 'GET', '/model/config');
      assert.equal(view.json().source, 'local'); assert.equal(view.json().model, 'test-model-A');
      assert.equal(view.json().apiKeyMasked, '****'); assert.ok(!view.body.includes('verify-user-A-key'));
      assert.equal((await api(b, 'GET', '/model/config')).json().source, 'env');
      const row = await pool.query<{ config_enc: string }>('SELECT config_enc FROM plugin_configs WHERE user_id=$1 AND plugin_id=$2', [a.id, 'model']);
      assert.ok(row.rows[0].config_enc.startsWith('gcm$'));
      assert.ok(!row.rows[0].config_enc.includes('verify-user-A-key'));
      assert.equal(cipher.decryptJson<{ apiKey: string }>(row.rows[0].config_enc).apiKey, 'verify-user-A-key');
    });
    await check('④ /model/test 真走 llmFetch 请求体+Bearer；A 与 B 密钥/模型严格隔离', async () => {
      assert.equal((await api(a, 'POST', '/model/test', {})).json().ok, true);
      assert.equal(calls.at(-1)?.auth, 'Bearer verify-user-A-key');
      assert.equal(calls.at(-1)?.body.model, 'test-model-A');
      assert.equal((await api(b, 'POST', '/model/test', {})).json().ok, true);
      assert.equal(calls.at(-1)?.auth, 'Bearer verify-env-key');
      assert.equal(calls.at(-1)?.body.model, 'env-chat');
    });
    await check('⑤ chat/tool/extract/delegate/worker 标签全部经过同一当前用户配置', async () => {
      for (const tag of ['chat/stream', 'agent/loop:next-action', 'memories/extract:test', 'delegate', 'orc/worker#1#report']) {
        const hit = await call(a.id, tag);
        assert.equal(hit.auth, 'Bearer verify-user-A-key', tag);
        assert.equal(hit.body.model, 'test-model-A', tag);
        assert.equal(hit.body.messages.at(-1)?.content, '验收调用');
      }
    });
    await check('⑥ 真 worker 池/语义路由传播 userId，不意外退回 env key', async () => {
      const batch = await runWorkerPool({ env, userId: a.id, jobId: 'verify',
        tasks: [{ title: '提要', instruction: '提取三个要点' }], allowSearch: false, concurrency: 1,
        perWorkerTimeoutMs: 5000, budgetMs: 6000, maxSearchRounds: 0 });
      assert.equal(batch.reports.length, 1);
      assert.equal(calls.at(-1)?.auth, 'Bearer verify-user-A-key');
      const decision = await routeBySemantic('来杯拿铁', [
        { id: 11, name: '咖啡师', duty: '制作咖啡饮品', busy: false, waiting: false },
        { id: 12, name: '视觉师', duty: '海报设计', busy: false, waiting: false },
      ], env, a.id);
      assert.equal(decision?.toAgentId, 11); assert.equal(calls.at(-1)?.auth, 'Bearer verify-user-A-key');
    });
    await check('⑦ 同供应商同地址只改模型保留密钥；换供应商/地址不填新 key 必拒', async () => {
      assert.equal((await api(a, 'POST', '/model/config', { provider: 'deepseek', model: 'test-model-A2', baseUrl: stub.base, apiKey: '' })).statusCode, 200);
      assert.equal((await call(a.id, 'chat/stream')).body.model, 'test-model-A2');
      const n = calls.length;
      assert.equal((await api(a, 'POST', '/model/config', { provider: 'openai', model: 'test-openai', baseUrl: stub.base })).statusCode, 400);
      assert.equal((await api(a, 'POST', '/model/config', { provider: 'deepseek', model: 'm', baseUrl: stub.base + '/new' })).statusCode, 400);
      assert.equal(calls.length, n);
      assert.equal((await call(a.id, 'chat/stream')).auth, 'Bearer verify-user-A-key');
    });
    await check('⑧ 兼容端点 307 禁重定向，旧 key 不流向 /leak', async () => {
      const r = await api(a, 'POST', '/model/config', { provider: 'custom', model: 'redir-model', baseUrl: stub.base + '/redirect', apiKey: 'verify-redir-key' });
      assert.equal(r.statusCode, 200, r.body);
      const test = await api(a, 'POST', '/model/test', {});
      assert.equal(test.json().ok, false);
      assert.ok(!calls.some((c) => c.path === '/leak'));
    });
    await check('⑨ 坏密文在 env 有 key 时仍 fail-closed；GET invalid/test拒绝/chat 503/无外呼', async () => {
      await pool.query('UPDATE plugin_configs SET config_enc=$3 WHERE user_id=$1 AND plugin_id=$2', [a.id, 'model', 'gcm$bad$corrupted$data']);
      const n = calls.length;
      const view = await api(a, 'GET', '/model/config');
      assert.equal(view.json().source, 'invalid'); assert.equal(view.json().apiKeySet, false);
      assert.equal((await api(a, 'POST', '/model/test', {})).statusCode, 400);
      await assert.rejects(() => llmFetch(env, [{ role: 'user', content: '不要外呼' }], { tag: 'chat/stream', userId: a.id }), /配置解密或校验失败/);
      const chat = await api(a, 'POST', '/chat/stream', { message: '测试不可调用' });
      assert.equal(chat.statusCode, 503); assert.equal(chat.json().code, 'llm_not_configured');
      assert.equal(calls.length, n);
      assert.equal((await call(b.id, 'chat/stream')).auth, 'Bearer verify-env-key');
    });
    await check('⑩ 清空坏本地配置后才允许回退 env；A/B 无串号', async () => {
      assert.equal((await api(a, 'DELETE', '/model/config')).statusCode, 200);
      assert.equal((await api(a, 'GET', '/model/config')).json().source, 'env');
      assert.equal((await call(a.id, 'chat/stream')).auth, 'Bearer verify-env-key');
      assert.equal((await loadUserModelSetting(pool, cipher, a.id)).kind, 'missing');
    });
    console.log(`=== 模型配置：PASS ${passes} / FAIL ${fails}（HTTP 上游为本地协议桩，非真实准确率） ===`);
    if (fails) process.exitCode = 1;
  } finally { await app.close(); await pool.end(); await stub.close(); }
}
main().catch((err) => { console.error('模型验收异常：', (err as Error).message); process.exitCode = 1; });
