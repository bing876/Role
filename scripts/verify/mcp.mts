/**
 * 能力与连接 · 片2 · **MCP 通用桥 · 验收**（无外部 key 版，进主 verify 链）
 *
 * 覆盖（真库 pglite + 真 app + 真加密；MCP 端是一个**真** HTTP server 讲 MCP JSON-RPC 协议，
 * 不是 mock 掉协议本身）：
 *   ① 设置加 server：POST /mcp/servers 连本地 MCP server → 真拉 tools/list → 落库 → 回工具。
 *   ② 列 server：GET /mcp/servers 回 name/url/tools，**绝不**回 auth（无 bearerToken 明文）。
 *   ③ 注册成插件：MCP 工具以命名空间化名进**全局注册表**（serverToolRegistry.get 命中）。
 *   ④ 拼进循环工具表：mainLoopToolNamesWithMcp 给该用户回 MCP 工具名（叠加在浏览器工具后）。
 *   ⑤ 真执行：走注册表执行器 executeMcpTool → 真调本地 MCP server 的 tools/call → 拿回结果。
 *   ⑥ auth 加密落本地：mcp_servers.auth_enc **不含**明文 token（真加密，解回一致）。
 *   ⑦ 归属硬闸：换一个用户执行该 MCP 工具 → not_found（串号直接失败）。
 *   ⑧ 反证前置：DELETE /mcp/servers/:id 后，该用户工具表里 MCP 工具消失（mcpToolNamesForUser=[]）。
 *
 * 反证：scripts/verify/mcp-revert-proof.py（拆桥 = 循环工具表不再拼 MCP 名 → 必红）。
 *
 * 用法：npx tsx scripts/verify/mcp.mts
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
import { getLoop, stopLoop } from '../../apps/server/src/toolLoop';
import { validateMcpEndpoint } from '../../apps/server/src/plugins/mcp';
import { mcpToolNamesForUser, mcpToolNameFor, executeMcpTool, ensureMcpToolsRegistered } from '../../apps/server/src/plugins/mcpRegistry';
import { mainLoopToolNamesWithMcp } from '../../apps/server/src/plugins/mcpLoop';

let passes = 0;
let fails = 0;
const log = (...a: unknown[]) => console.log(a.map(String).join(' '));
const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try {
    await fn();
    passes += 1;
    log(`  ✓ ${name}`);
  } catch (err) {
    fails += 1;
    log(`  ✗ ${name}`);
    log(`      ${(err as Error)?.message?.split('\n').slice(0, 6).join('\n      ') ?? String(err)}`);
  }
};

/** 一个**真** MCP server（HTTP + JSON-RPC 2.0）：initialize / notifications/initialized / tools/list / tools/call */
function startStubMcpServer(): Promise<{ url: string; close: () => Promise<void>; calls: { method: string; name?: string; args?: Record<string, unknown> }[] }> {
  const calls: { method: string; name?: string; args?: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      let msg: { id?: number | string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      try {
        msg = JSON.parse(body || '{}');
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'bad json' } }));
        return;
      }
      calls.push({ method: msg.method ?? '?', name: msg.params?.name, args: msg.params?.arguments });
      const respond = (payload: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'verify-mcp-session' });
        res.end(JSON.stringify(payload));
      };
      switch (msg.method) {
        case 'initialize':
          respond({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'stub-mcp', version: '1.0' } } });
          return;
        case 'notifications/initialized':
          res.writeHead(202).end();
          return;
        case 'tools/list':
          respond({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              tools: [
                { name: 'echo', description: '回声：把 text 原样返回', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
                { name: 'add', description: '两数相加', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
              ],
            },
          });
          return;
        case 'tools/call': {
          const args = msg.params?.arguments ?? {};
          let text = '';
          if (msg.params?.name === 'echo') text = `echo:${String(args.text ?? '')}`;
          else if (msg.params?.name === 'add') text = String(Number(args.a ?? 0) + Number(args.b ?? 0));
          else text = 'unknown tool';
          respond({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: false } });
          return;
        }
        default:
          respond({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((r) => server.close(() => r())), calls });
    });
  });
}

async function main(): Promise<void> {
  log('=== 片2 · MCP 通用桥 · 验收（真库 pglite + 真 app + 真加密 + 真本地 MCP server）===');
  process.env.DATABASE_URL ??= 'pglite://memory';
  process.env.JWT_SECRET ??= 'verify-mcp-jwt-secret';
  process.env.DATA_KEY ??= 'k'.repeat(64);
  process.env.PHONE_PEPPER ??= 'verify-mcp-pepper';
  process.env.SMS_MOCK ??= '1';
  process.env.ENABLE_DEV_MOCK_LLM = '1'; // 建真循环（不请求上游模型）

  const env = loadEnv();
  const cipher = makeCipher(env.dataKey);
  const pool = await makePool(env.databaseUrl);
  await migrate(pool);
  const app = await buildApp(env, pool, cipher);
  initOrchestrator({ pool, env, cipher });

  const mcp = await startStubMcpServer();

  // 登录（SMS mock）
  const H = { 'content-type': 'application/json' };
  const phone = '139' + String(Date.now()).slice(-8);
  const sj = await app.inject({ method: 'POST', url: '/auth/sms/send', headers: H, payload: JSON.stringify({ phone }) });
  const code = (sj.json() as { mock_code?: string }).mock_code;
  const lj = await app.inject({ method: 'POST', url: '/auth/login/sms', headers: H, payload: JSON.stringify({ phone, code }) });
  const token = (lj.json() as { token?: string }).token;
  assert.ok(token, '登录失败');
  const auth = { ...H, authorization: `Bearer ${token}` };
  const me = (await app.inject({ method: 'GET', url: '/auth/me', headers: auth })).json() as { user: { id: number } };
  const userId = me.user.id;

  const BEARER = 'sk-verify-mcp-secret-token-0001';

  await check('① 设置加 server：POST /mcp/servers 连本地 MCP server → 真拉工具 → 落库', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/mcp/servers',
      headers: auth,
      payload: JSON.stringify({ name: 'stub', url: mcp.url, auth: { bearerToken: BEARER } }),
    });
    assert.equal(r.statusCode, 200, `POST /mcp/servers ${r.statusCode}: ${r.body}`);
    const j = r.json() as { ok: boolean; id: number; toolCount: number; tools: { name: string }[] };
    assert.equal(j.ok, true);
    assert.equal(j.toolCount, 2, '应拉到 2 个工具（echo / add）');
    const names = j.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['add', 'echo']);
    assert.ok(Number.isInteger(j.id) && j.id > 0, '应有 server 行 id');
    // 真连了：stub 收到 initialize + tools/list
    assert.ok(mcp.calls.some((c) => c.method === 'initialize'), 'stub 应收到 initialize 握手');
    assert.ok(mcp.calls.some((c) => c.method === 'tools/list'), 'stub 应收到 tools/list');
  });

  let serverId = 0;
  await check('② 列 server：GET /mcp/servers 回工具，但**绝不**回 auth（无明文 token）', async () => {
    const r = await app.inject({ method: 'GET', url: '/mcp/servers', headers: auth });
    assert.equal(r.statusCode, 200, r.body);
    const j = r.json() as { servers: Array<{ id: number; name: string; url: string; hasAuth: boolean; tools: { name: string }[] }> };
    assert.equal(j.servers.length, 1);
    serverId = j.servers[0].id;
    assert.equal(j.servers[0].name, 'stub');
    assert.equal(j.servers[0].hasAuth, true, '应标记「配了 auth」（但不回明文）');
    assert.deepEqual(j.servers[0].tools.map((t) => t.name).sort(), ['add', 'echo']);
    assert.ok(!r.body.includes(BEARER), `响应里绝不含明文 token：\n${r.body}`);
    assert.ok(!JSON.stringify(j).includes('bearerToken'), '不应回 bearerToken 字段');
    const plugins = await app.inject({ method: 'GET', url: '/plugins', headers: auth });
    assert.equal(plugins.statusCode, 200, '插件注册表可读');
    const list = (plugins.json() as { plugins: Array<{ id: string; tools: string[] }> }).plugins;
    const mcpPlugin = list.find((p) => p.id === `mcp_s${serverId}`);
    assert.ok(mcpPlugin, 'MCP server 应真注册成 /plugins 里的插件，不仅是工具表');
    assert.deepEqual(mcpPlugin.tools.sort(), [mcpToolNameFor(serverId, 'echo'), mcpToolNameFor(serverId, 'add')].sort());
    assert.ok(!plugins.body.includes(BEARER), '插件注册表绝不带鉴权明文');
  });

  await check('③ 注册成插件：MCP 工具以命名空间化名进全局注册表', async () => {
    const names = await ensureMcpToolsRegistered(pool, cipher, userId, serverToolRegistry);
    assert.equal(names.length, 2, `应有 2 个命名空间化名字，实际 ${names.length}: ${names}`);
    for (const n of names) {
      assert.ok(serverToolRegistry.get(n), `全局注册表应有工具「${n}」`);
    }
    const echoName = mcpToolNameFor(serverId, 'echo');
    const def = serverToolRegistry.get(echoName);
    assert.ok(def, 'echo 工具已注册');
    assert.equal(def!.side, 'server');
  });

  await check('④ 拼进循环工具表：mainLoopToolNamesWithMcp 回 MCP 名（叠加在浏览器工具后）', async () => {
    const names = await mainLoopToolNamesWithMcp(pool, cipher, userId, env);
    assert.ok(names && names.length > 0, '该用户有 MCP 工具 → 应返回非空工具名');
    const base = browserToolNamesFor(env);
    assert.equal(names!.slice(0, base.length).join(','), base.join(','), '前段 = 基础浏览器工具表（顺序不变）');
    assert.ok(names!.includes(mcpToolNameFor(serverId, 'echo')), '含 echo 的 MCP 名');
    assert.ok(names!.includes(mcpToolNameFor(serverId, 'add')), '含 add 的 MCP 名');
  });

  await check('⑤ 真执行：走注册表执行器 → 真调本地 MCP server 的 tools/call → 拿回结果', async () => {
    const echoName = mcpToolNameFor(serverId, 'echo');
    const executor = serverToolRegistry.getExecutor(echoName);
    assert.ok(executor, '模型工具名能在正式注册表里找到执行器');
    const res = await executor!.execute({ text: '你好，MCP' }, { userId } as any);
    assert.equal(res.ok, true, `echo 应成功：${res.detail} ${res.error}`);
    assert.ok(String(res.data?.result).includes('echo:你好，MCP'), `结果应含 echo 回文，实际 ${res.data?.result}`);
    // add：真算 2+3=5
    const addName = mcpToolNameFor(serverId, 'add');
    const res2 = await executeMcpTool(addName, { a: 2, b: 3 }, { userId } as any, pool, cipher);
    assert.equal(res2.ok, true, res2.error);
    assert.equal(String(res2.data?.result), '5', `2+3 应回 "5"，实际 ${res2.data?.result}`);
    assert.ok(mcp.calls.some((c) => c.method === 'tools/call' && c.name === 'echo'), 'stub 应收到 echo 的 tools/call');
  });

  await check('⑥ 真 HTTP /agent/loop/start：当前用户工具表包含 MCP 两工具（不是测试手拼）', async () => {
    const r = await app.inject({ method: 'POST', url: '/agent/loop/start', headers: auth,
      payload: { goal: '用 echo 回声', wcId: 99231, pageUrl: 'https://example.com/' } });
    assert.equal(r.statusCode, 200, `真建循环失败：${r.statusCode} ${r.body}`);
    const loopId = (r.json() as { loopId: string }).loopId;
    const s = getLoop(loopId);
    assert.ok(s, '循环已落进生产会话表');
    assert.ok(s.toolNames?.includes(mcpToolNameFor(serverId, 'echo')), '真路由把 MCP 工具拼进会话工具名表');
    assert.ok(s.toolNames?.includes(mcpToolNameFor(serverId, 'add')), '两个工具都可调');
    stopLoop(loopId);
  });

  await check('⑦ auth 加密落本地：auth_enc 不含明文 token，且能解回一致', async () => {
    const r = await pool.query<{ auth_enc: string }>('SELECT auth_enc FROM mcp_servers WHERE id = $1', [serverId]);
    const enc = r.rows[0].auth_enc;
    assert.ok(enc, 'auth_enc 应有值');
    assert.ok(!enc.includes(BEARER), '密文里绝不含明文 token');
    const dec = cipher.decryptJson<{ bearerToken?: string }>(enc);
    assert.equal(dec.bearerToken, BEARER, '解回应与明文一致（真加密往返）');
  });

  await check('⑧ 归属硬闸：换用户执行该 MCP 工具 → not_found（串号直接失败）', async () => {
    const otherPhone = '138' + String(Date.now()).slice(-8);
    const s2 = await app.inject({ method: 'POST', url: '/auth/sms/send', headers: H, payload: JSON.stringify({ phone: otherPhone }) });
    const c2 = (s2.json() as { mock_code?: string }).mock_code;
    const l2 = await app.inject({ method: 'POST', url: '/auth/login/sms', headers: H, payload: JSON.stringify({ phone: otherPhone, code: c2 }) });
    const t2 = (l2.json() as { token?: string }).token;
    const otherAuth = { ...H, authorization: `Bearer ${t2}` };
    const otherMe = (await app.inject({ method: 'GET', url: '/auth/me', headers: otherAuth })).json() as { user: { id: number } };
    const otherUserId = otherMe.user.id;
    assert.notEqual(otherUserId, userId, '应是另一个用户');
    const echoName = mcpToolNameFor(serverId, 'echo');
    const res = await executeMcpTool(echoName, { text: 'x' }, { userId: otherUserId } as any, pool, cipher);
    assert.equal(res.ok, false, '别人的用户执行你的 MCP 工具应失败');
    assert.equal(res.error, 'not_found');
    // 另一个用户工具表里不该有这个 server 的工具
    const otherNames = await mcpToolNamesForUser(pool, cipher, otherUserId);
    assert.equal(otherNames.length, 0, '另一个用户没有挂 server → 工具表里没有 MCP 工具');
  });

  await check('⑨ 安全输入：禁止公网 HTTP、URL 凭据/查询参数/跳转目标', async () => {
    assert.throws(() => validateMcpEndpoint('http://api.example.com/mcp'), /HTTPS/);
    assert.throws(() => validateMcpEndpoint('https://user:secret@example.com/mcp'), /用户名/);
    assert.throws(() => validateMcpEndpoint('https://example.com/mcp?token=leak'), /查询参数/);
    assert.ok(validateMcpEndpoint(mcp.url).startsWith('http://127.0.0.1:'));
    const r = await app.inject({ method: 'POST', url: '/mcp/servers', headers: auth,
      payload: { name: 'bad', url: 'http://169.254.169.254/latest/meta-data' } });
    assert.equal(r.statusCode, 400, '禁止借 server URL 打云元数据 HTTP');
  });

  await check('⑩ 反证前置：DELETE 后该用户工具表里 MCP 工具消失，旧执行器不能重用', async () => {
    const before = await mcpToolNamesForUser(pool, cipher, userId);
    assert.equal(before.length, 2, '删前应有 2 个');
    const del = await app.inject({ method: 'DELETE', url: `/mcp/servers/${serverId}`, headers: auth });
    assert.equal(del.statusCode, 200, del.body);
    const after = await mcpToolNamesForUser(pool, cipher, userId);
    assert.equal(after.length, 0, '删后该用户工具表里 MCP 工具应消失');
    const plugins = (await app.inject({ method: 'GET', url: '/plugins', headers: auth })).json() as { plugins: Array<{ id: string }> };
    assert.ok(!plugins.plugins.some((p) => p.id === `mcp_s${serverId}`), '删后插件注册表里也应消失');
    const oldExecutor = serverToolRegistry.getExecutor(mcpToolNameFor(serverId, 'echo'));
    assert.ok(oldExecutor, '全局注册表仍有旧条目（append-only）');
    const oldResult = await oldExecutor!.execute({ text: '不能再调用' }, { userId } as any);
    assert.equal(oldResult.ok, false, '删后旧条目不得再发上游请求');
    assert.equal(oldResult.error, 'not_found');
  });

  await mcp.close();
  log('');
  log(`=== 片2 · MCP 通用桥：PASS ${passes} / FAIL ${fails} ===`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  log('FATAL', err);
  process.exit(1);
});
