/** 片3 · GitHub + 飞书原生连接器：真 pglite + 真 app + 真工具注册表 + 真本地 HTTP 上游。
 * 模拟的只有「第三方 HTTP API 响应」，实际 GitHub/飞书 provider、JWT、加密、loop 走生产代码。
 * 真 token 的公网验收单列 verify:connectors:live，不把本地上游说成公网。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadEnv } from '../../apps/server/src/env';
import { makeCipher } from '../../apps/server/src/crypto';
import { makePool, migrate } from '../../apps/server/src/db';
import { buildApp } from '../../apps/server/src/index';
import { initOrchestrator } from '../../apps/server/src/orchestrator/tools';
import { serverToolRegistry, browserToolNamesFor } from '../../apps/server/src/toolRegistry';
import type { ServerExecutionContext } from '../../apps/server/src/toolRegistry';

let passes = 0; let fails = 0;
async function check(title: string, fn: () => Promise<void> | void) {
  try { await fn(); passes++; console.log(`  ✓ ${title}`); }
  catch (e) { fails++; console.log(`  ✗ ${title}\n    ${String((e as Error).message).slice(0, 600)}`); }
}
const requests: Array<{ method: string; path: string; auth?: string; body: any }> = [];
function createUpstream() {
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c) => text += c);
    req.on('end', () => {
      let body: any;
      try { body = JSON.parse(text); } catch { body = {}; }
      const path = req.url || '';
      requests.push({ method: req.method || '', path, auth: req.headers.authorization, body });
      const send = (j: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.method === 'GET' && path === '/user' && req.headers.authorization === 'Bearer verify-gh-pat') return send({ login: 'verify-user' });
      if (req.method === 'GET' && path.startsWith('/repos/octocat/Hello-World/issues?') && req.headers.authorization === 'Bearer verify-gh-pat')
        return send([{ number: 7, title: '真正的 issue', state: 'open', html_url: 'https://github.com/octocat/Hello-World/issues/7', body: '修正文', user: { email: 'do-not-leak' } },
          { number: 8, title: '其实是 PR', pull_request: { url: '...' } }]);
      if (req.method === 'GET' && path === '/repos/octocat/Hello-World/issues/7' && req.headers.authorization === 'Bearer verify-gh-pat')
        return send({ number: 7, title: '真正的 issue', state: 'open', body: '问题描述', html_url: 'https://github.com/octocat/Hello-World/issues/7' });
      if (req.method === 'POST' && path === '/open-apis/auth/v3/tenant_access_token/internal') {
        if (body.app_id === 'cli_verify' && body.app_secret === 'verify-fs-secret') return send({ code: 0, tenant_access_token: 't-test-feishu', expire: 7200 });
        return send({ code: 10003, msg: 'bad auth' });
      }
      if (req.method === 'GET' && path.startsWith('/open-apis/drive/v1/files') && req.headers.authorization === 'Bearer t-test-feishu')
        return send({ code: 0, data: { files: [{ name: '项目周报', type: 'docx', token: 'abc123', url: 'https://example.com/doc' }] } });
      if (req.method === 'GET' && path === '/open-apis/docx/v1/documents/abc123/raw_content' && req.headers.authorization === 'Bearer t-test-feishu')
        return send({ code: 0, data: { content: '本周进度：已完成连接器。' } });
      return send({ code: 403, msg: 'invalid or not found' }, 403);
    });
  });
  return new Promise<{ base: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise((done) => server.close(() => done())) }));
  });
}

async function main() {
  console.log('=== 片3 · 原生连接器：真库 + 真 HTTP 上游协议 + 真服务端工具 ===');
  process.env.DATABASE_URL ??= 'pglite://memory';
  process.env.JWT_SECRET ??= 'verify-connector-jwt-secret';
  process.env.DATA_KEY ??= 'k'.repeat(64);
  process.env.PHONE_PEPPER ??= 'verify-connector-pepper';
  process.env.SMS_MOCK ??= '1';
  process.env.ENABLE_DEV_MOCK_LLM = '1';
  const env = loadEnv(); const cipher = makeCipher(env.dataKey);
  const pool = await makePool(env.databaseUrl); await migrate(pool);
  const app = await buildApp(env, pool, cipher); initOrchestrator({ pool, env, cipher });
  const upstream = await createUpstream();
  const H = { 'content-type': 'application/json' };
  async function login(phone: string) {
    const send = await app.inject({ method: 'POST', url: '/auth/sms/send', headers: H, payload: { phone } });
    const code = (send.json() as { mock_code: string }).mock_code;
    const res = await app.inject({ method: 'POST', url: '/auth/login/sms', headers: H, payload: { phone, code } });
    const token = (res.json() as { token: string }).token; assert.ok(token);
    const auth = { ...H, authorization: `Bearer ${token}` };
    const me = (await app.inject({ method: 'GET', url: '/auth/me', headers: auth })).json() as { user: { id: number } };
    return { auth, id: me.user.id };
  }
  const u = await login('137' + String(Date.now()).slice(-8));
  const ctx = { userId: u.id } as ServerExecutionContext;
  const run = (name: string, args: Record<string, unknown>, context = ctx) => {
    const exec = serverToolRegistry.getExecutor(name);
    assert.ok(exec, `连接器「${name}」没注册进引擎`);
    return exec.execute(args, context);
  };
  await check('① 原生元数据：GET /plugins 含 GitHub/飞书工具 + 配置字段；未配灰', async () => {
    const r = await app.inject({ method: 'GET', url: '/plugins', headers: u.auth });
    assert.equal(r.statusCode, 200);
    const list = (r.json() as { plugins: Array<{ id: string; enabled: boolean; tools: string[]; configFields: Array<{ key: string; type: string }> }> }).plugins;
    const gh = list.find((p) => p.id === 'github'); const fs = list.find((p) => p.id === 'feishu');
    assert.ok(gh && fs); assert.equal(gh.enabled, false); assert.equal(fs.enabled, false);
    assert.deepEqual(gh.tools, ['github_list_issues', 'github_read_issue']);
    assert.deepEqual(fs.tools, ['feishu_list_files', 'feishu_read_doc']);
    assert.ok(gh.configFields.some((f) => f.key === 'apiToken' && f.type === 'secret'));
    assert.ok(fs.configFields.some((f) => f.key === 'appSecret' && f.type === 'secret'));
    assert.ok(browserToolNamesFor(env).includes('github_list_issues'), '主循环工具名含 GitHub');
    assert.ok(browserToolNamesFor(env).includes('feishu_read_doc'), '主循环工具名含飞书');
  });
  await check('② 未配 key：执行器/测试端点 fail-closed，不外呼', async () => {
    const n = requests.length;
    for (const [tool, args] of [['github_list_issues', { owner: 'octocat', repo: 'Hello-World' }],
      ['feishu_read_doc', { documentId: 'abc123' }]] as const) {
      const result = await run(tool, args); assert.equal(result.ok, false); assert.equal(result.error, 'not_configured');
    }
    const t = await app.inject({ method: 'POST', url: '/plugins/github/test', headers: u.auth, payload: '{}' });
    assert.equal(t.statusCode, 400);
    assert.equal(requests.length, n, '不应碰上游');
  });
  await check('③ POST 配 GitHub/飞书 → AES 密文；GET 打码；列表翻绿', async () => {
    for (const [id, config] of [
      ['github', { apiToken: 'verify-gh-pat', baseUrl: upstream.base }],
      ['feishu', { appId: 'cli_verify', appSecret: 'verify-fs-secret', baseUrl: upstream.base }],
    ] as const) {
      const res = await app.inject({ method: 'POST', url: `/plugins/${id}/config`, headers: u.auth, payload: { config } });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().configured, true);
      const view = await app.inject({ method: 'GET', url: `/plugins/${id}/config`, headers: u.auth });
      assert.ok(!view.body.includes('verify-gh-pat') && !view.body.includes('verify-fs-secret'));
      assert.equal(view.json().fields[id === 'github' ? 'apiToken' : 'appSecret'].value, '****');
      const row = await pool.query<{ config_enc: string }>('SELECT config_enc FROM plugin_configs WHERE user_id=$1 AND plugin_id=$2', [u.id, id]);
      assert.ok(!row.rows[0].config_enc.includes('verify-'), '库里不含明文 key');
    }
    const list = (await app.inject({ method: 'GET', url: '/plugins', headers: u.auth })).json() as { plugins: Array<{ id: string; enabled: boolean }> };
    assert.equal(list.plugins.find((p) => p.id === 'github')?.enabled, true);
    assert.equal(list.plugins.find((p) => p.id === 'feishu')?.enabled, true);
  });
  await check('④ 测试连通：真 GET GitHub /user + 飞书 POST tenant_access_token', async () => {
    for (const id of ['github', 'feishu']) {
      const res = await app.inject({ method: 'POST', url: `/plugins/${id}/test`, headers: u.auth, payload: '{}' });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().ok, true, res.body);
    }
    assert.ok(requests.some((r) => r.path === '/user' && r.auth === 'Bearer verify-gh-pat'));
    assert.ok(requests.some((r) => r.path.includes('tenant_access_token/internal') && r.body.app_secret === 'verify-fs-secret'));
  });
  await check('⑤ github_list_issues 真执行：滤 PR / 只回白名单字段', async () => {
    const r = await run('github_list_issues', { owner: 'octocat', repo: 'Hello-World', state: 'open' });
    assert.equal(r.ok, true, r.detail); const issues = r.data as Array<{ number: number; title: string }>;
    assert.equal(issues.length, 1); assert.equal(issues[0].number, 7);
    assert.ok(!JSON.stringify(r).includes('do-not-leak'), '非白名单 user.email 不得透传');
  });
  await check('⑥ github_read_issue 真执行：拿 issue 正文', async () => {
    const r = await run('github_read_issue', { owner: 'octocat', repo: 'Hello-World', number: 7 });
    assert.equal(r.ok, true, r.detail); assert.ok(JSON.stringify(r.data).includes('问题描述'));
  });
  await check('⑦ feishu_list_files 真执行：取得应用有权文件白名单', async () => {
    const r = await run('feishu_list_files', {}); assert.equal(r.ok, true, r.detail);
    assert.equal((r.data as Array<{ name: string }>)[0].name, '项目周报');
  });
  await check('⑧ feishu_read_doc 真执行：取得已授权 docx 正文', async () => {
    const r = await run('feishu_read_doc', { documentId: 'abc123' }); assert.equal(r.ok, true, r.detail);
    assert.ok(JSON.stringify(r.data).includes('本周进度'));
  });
  await check('⑨ 第二用户无配置：调连接器不串号、不外呼', async () => {
    const other = await login('138' + String(Date.now()).slice(-8));
    assert.notEqual(other.id, u.id);
    const n = requests.length;
    for (const name of ['github_list_issues', 'feishu_read_doc']) {
      const args = name === 'github_list_issues' ? { owner: 'octocat', repo: 'Hello-World' } : { documentId: 'abc123' };
      const r = await run(name, args, { userId: other.id } as ServerExecutionContext);
      assert.equal(r.ok, false); assert.equal(r.error, 'not_configured');
    }
    assert.equal(requests.length, n);
  });
  await check('⑩ 路径参数恶意注入：executor 纵深校验，未外呼', async () => {
    const n = requests.length;
    for (const [tool, args] of [['github_list_issues', { owner: '../secret', repo: 'Hello-World' }],
      ['feishu_read_doc', { documentId: '../../unsafe' }]] as const) {
      const r = await run(tool, args); assert.equal(r.ok, false); assert.equal(r.error, 'bad_args');
    }
    assert.equal(requests.length, n);
  });
  await check('⑪ 清空飞书配置→工具回 not_configured（不退回 env）', async () => {
    const d = await app.inject({ method: 'DELETE', url: '/plugins/feishu/config', headers: u.auth });
    assert.equal(d.statusCode, 200);
    const n = requests.length;
    const r = await run('feishu_read_doc', { documentId: 'abc123' });
    assert.equal(r.ok, false); assert.equal(r.error, 'not_configured'); assert.equal(requests.length, n);
  });
  await upstream.close(); await app.close(); await pool.end();
  console.log(`=== 片3 · 原生连接器：PASS ${passes} / FAIL ${fails} ===`);
  process.exitCode = fails ? 1 : 0;
}
main().catch((err) => { console.error('CONNECTORS FATAL', (err as Error).message); process.exitCode = 1; });
