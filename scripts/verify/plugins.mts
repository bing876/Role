/**
 * 能力与连接（2026-09-27）· 验收（**无 key 版**，进主 verify 链）
 *
 * 覆盖（真库 pglite + 真 app + 真加密，全程不连外部 API / 不烧钱）：
 *   ① 注册表：GET /plugins 四个原生插件（web_search / image_gen / github / feishu），元数据 / tools / configFields 对。
 *   ② 配置加密落本地：POST 存 key → 读回**打码**（****），库里 config_enc **不含明文 key**（真加密，往返可解）。
 *   ③ 状态翻转：存后 GET /plugins 该插件 绿(configured/enabled)。
 *   ④ 接进循环引擎：generate_image 注册进服务端工具表；用 **stub 供应商**走一遍注册表执行器
 *      → 真落项目目录（磁盘有文件）+ 真写一条 markdown 图片消息进对话流 + 回执带 served url。
 *   ⑤ 图片取回：GET /projects/:id/images/:file 原样回（content-type image/png）。
 *   ⑥ 未配置降级：web_search 没配 → 工具执行器回 not_configured（不发注定失败的请求）；
 *      test 接口没配 → 400。
 *
 * 「配测试 key → 搜 XX 真返回摘要 / 画一只猫真出图」需要**真实供应商 key**，走
 *   `verify:plugins:live`（scripts/verify/plugins-live.mts，手动跑，见文件头）。
 *
 * 反证：scripts/verify/plugins-revert-proof.py（拔插件 = 拆 generate_image 注册 → 循环调不到它 → 必红）。
 *
 * 用法：npx tsx scripts/verify/plugins.mts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadEnv } from '../../apps/server/src/env';
import { makeCipher } from '../../apps/server/src/crypto';
import { makePool, migrate } from '../../apps/server/src/db';
import { buildApp } from '../../apps/server/src/index';
import { initOrchestrator } from '../../apps/server/src/orchestrator/tools';
import { serverToolRegistry, browserToolNamesFor } from '../../apps/server/src/toolRegistry';
import { setImageProviderResolverForTest, setSearchProviderResolverForTest } from '../../apps/server/src/plugins/resolve';
import { getProjectImageDir } from '../../apps/server/src/plugins/paths';
import type { ImageProvider } from '../../apps/server/src/plugins/providers';

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
    log(`      ${(err as Error)?.message?.split('\n').slice(0, 5).join('\n      ') ?? String(err)}`);
  }
};

/** 一个 1x1 红色像素 PNG（stub 供应商「生成」出来的图，验真用） */
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

interface Plugin {
  id: string;
  name: string;
  description: string;
  tools: string[];
  configFields: Array<{ key: string; type: string }>;
  status: string;
  enabled: boolean;
}

async function main(): Promise<void> {
  log('=== 能力与连接 · 验收（真库 pglite + 真 app + 真加密，无外部 key）===');
  process.env.DATABASE_URL ??= 'pglite://memory';
  process.env.JWT_SECRET ??= 'verify-plugins-jwt-secret';
  process.env.DATA_KEY ??= 'k'.repeat(64);
  process.env.PHONE_PEPPER ??= 'verify-plugins-pepper';
  process.env.SMS_MOCK ??= '1';
  // 确保「没配 env 搜索 key」→ 才能验「未配置降级」（env 兜底不生效）
  delete process.env.TAVILY_API_KEY;

  const env = loadEnv();
  const cipher = makeCipher(env.dataKey);
  const pool = await makePool(env.databaseUrl);
  await migrate(pool);
  const app = await buildApp(env, pool, cipher);
  // 注册服务端工具（含 web_search / generate_image），用本测试的 deps
  initOrchestrator({ pool, env, cipher });

  // 登录（SMS mock）
  const H = { 'content-type': 'application/json' };
  const phone = '137' + String(Date.now()).slice(-8);
  const sj = await app.inject({ method: 'POST', url: '/auth/sms/send', headers: H, payload: JSON.stringify({ phone }) });
  const code = (sj.json() as { mock_code?: string }).mock_code;
  const lj = await app.inject({ method: 'POST', url: '/auth/login/sms', headers: H, payload: JSON.stringify({ phone, code }) });
  const token = (lj.json() as { token?: string }).token;
  assert.ok(token, '登录失败');
  const auth = { ...H, authorization: `Bearer ${token}` };
  const userId = Number((lj.json() as { user: { id: number } }).user.id);

  const projRes = await app.inject({ method: 'GET', url: '/projects', headers: auth });
  const projectId = (JSON.parse(projRes.body) as { currentProjectId: number }).currentProjectId;

  // ---------------------------------------------------------------------------
  await check('① GET /plugins 返回四个原生插件（旧两项 + GitHub/飞书），元数据 / tools / configFields 齐', async () => {
    const res = await app.inject({ method: 'GET', url: '/plugins', headers: auth });
    assert.equal(res.statusCode, 200, `GET /plugins ${res.statusCode} ${res.body}`);
    const list = (JSON.parse(res.body) as { plugins: Plugin[] }).plugins;
    assert.equal(list.length, 4, `应有 4 个插件，实际 ${list.length}`);
    const gh = list.find((p) => p.id === 'github');
    const fs = list.find((p) => p.id === 'feishu');
    assert.deepEqual(gh?.tools, ['github_list_issues', 'github_read_issue'], '新 GitHub 工具清单不完整');
    assert.deepEqual(fs?.tools, ['feishu_list_files', 'feishu_read_doc'], '新飞书工具清单不完整');
    assert.ok(gh?.configFields.some((f) => f.key === 'apiToken' && f.type === 'secret'), 'GitHub Token 应为 secret');
    assert.ok(fs?.configFields.some((f) => f.key === 'appSecret' && f.type === 'secret'), '飞书 App Secret 应为 secret');
    const ws = list.find((p) => p.id === 'web_search');
    const img = list.find((p) => p.id === 'image_gen');
    assert.ok(ws && img, '缺 web_search 或 image_gen');
    assert.deepEqual(ws!.tools, ['web_search'], `web_search.tools 应为 ['web_search']，实际 ${JSON.stringify(ws!.tools)}`);
    assert.deepEqual(img!.tools, ['generate_image'], `image_gen.tools 应为 ['generate_image']，实际 ${JSON.stringify(img!.tools)}`);
    assert.ok(ws!.description.length > 10, 'web_search 缺 description（给 AI 判断何时用）');
    assert.ok(img!.configFields.some((f) => f.key === 'apiKey' && f.type === 'secret'), 'image_gen 缺 apiKey secret 字段');
    assert.ok(ws!.configFields.some((f) => f.key === 'apiKey' && f.type === 'secret'), 'web_search 缺 apiKey secret 字段');
  });

  await check('② 未配置时两个插件都是 灰(unconfigured)', async () => {
    const res = await app.inject({ method: 'GET', url: '/plugins', headers: auth });
    const list = (JSON.parse(res.body) as { plugins: Plugin[] }).plugins;
    for (const p of list) assert.equal(p.status, 'unconfigured', `${p.id} 初始应为 unconfigured，实际 ${p.status}`);
  });

  await check('③ 存 key → 读回打码(****)，库里 config_enc 不含明文 key（真加密、往返可解）', async () => {
    const secret = 'sk-verify-image-1234567890';
    const sv = await app.inject({
      method: 'POST',
      url: '/plugins/image_gen/config',
      headers: auth,
      payload: JSON.stringify({ config: { provider: 'dashscope', apiKey: secret, model: 'wanx-v1' } }),
    });
    assert.equal(sv.statusCode, 200, `POST config ${sv.statusCode} ${sv.body}`);
    const svJson = sv.json() as { configured: boolean; fields: Record<string, { set: boolean; masked: boolean; value: string }> };
    assert.equal(svJson.configured, true, '存完应 configured=true');
    assert.equal(svJson.fields.apiKey.masked, true, 'apiKey 读回应 masked');
    assert.equal(svJson.fields.apiKey.value, '****', `apiKey 读回应打码 ****，实际 ${svJson.fields.apiKey.value}`);

    // 库里密文不含明文 key（真加密），且 cipher 能解回来（往返一致）
    const row = await pool.query<{ config_enc: string }>('SELECT config_enc FROM plugin_configs WHERE user_id=$1 AND plugin_id=$2', [userId, 'image_gen']);
    assert.ok(row.rows[0], 'plugin_configs 里没有这行');
    const enc = row.rows[0].config_enc;
    assert.ok(!enc.includes(secret), '★ 库里 config_enc 含明文 key —— 没加密！');
    const dec = cipher.decryptJson<Record<string, string>>(enc);
    assert.equal(dec.apiKey, secret, 'cipher 解不开（往返不一致）');
    assert.equal(dec.provider, 'dashscope', 'provider 没存进去');
  });

  await check('④ 状态翻转：存后 image_gen 变 绿(configured/enabled)，web_search 仍灰', async () => {
    const res = await app.inject({ method: 'GET', url: '/plugins', headers: auth });
    const list = (JSON.parse(res.body) as { plugins: Plugin[] }).plugins;
    const img = list.find((p) => p.id === 'image_gen')!;
    const ws = list.find((p) => p.id === 'web_search')!;
    assert.equal(img.status, 'configured', `image_gen 应 configured，实际 ${img.status}`);
    assert.equal(img.enabled, true, 'image_gen 应 enabled');
    assert.equal(ws.status, 'unconfigured', `web_search 不该变，实际 ${ws.status}`);
  });

  await check('⑤ generate_image 注册进服务端工具表 + 主循环工具名表', async () => {
    assert.ok(serverToolRegistry.get('generate_image'), 'generate_image 没注册进服务端工具表（循环调不到）');
    const names = browserToolNamesFor(env);
    assert.ok(names.includes('generate_image'), `主循环工具表缺 generate_image：${names.join(',')}`);
    assert.ok(names.includes('web_search'), `主循环工具表缺 web_search：${names.join(',')}`);
  });

  // 用 stub 供应商走一遍**注册表执行器**（= 循环 advanceInner 的执行路径）
  await check('⑥ 接进循环引擎：stub 供应商真落项目目录 + 真写图片消息进对话流 + 回执带 url', async () => {
    // 建一个会话（对话流要有地方落）
    const conv = await pool.query<{ id: string }>(
      "INSERT INTO conversations (project_id, title) VALUES ($1, '图片验收会话') RETURNING id",
      [projectId],
    );
    const convId = Number(conv.rows[0].id);
    const agent = await pool.query<{ id: string }>('SELECT id FROM agents WHERE project_id = $1 LIMIT 1', [projectId]);
    const agentId = Number(agent.rows[0].id);

    // 塞 stub 供应商（不连外部 API）
    const stub: ImageProvider = {
      generateImage: async () => ({ ok: true, detail: 'stub 图', bytes: ONE_PX_PNG, ext: 'png', tookMs: 5 }),
      test: async () => ({ ok: true, detail: 'stub ok' }),
    };
    setImageProviderResolverForTest(async () => stub);
    const beforeMsgs = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1', [convId]);
    const executor = serverToolRegistry.getExecutor('generate_image');
    assert.ok(executor, 'generate_image 没有执行器');
    const ctx = { loopId: 'verify-plugins-loop', userId, agentId, wcId: null, conversationId: convId, snapshot: null };
    const r = await executor.execute({ prompt: '一只猫' }, ctx as any);
    assert.equal(r.ok, true, `executor 应 ok，实际 ${JSON.stringify({ ok: r.ok, error: (r as any).error, detail: (r as any).detail })}`);
    const url = (r.data as { url: string; filePath: string }).url;
    const filePath = (r.data as { url: string; filePath: string }).filePath;
    assert.ok(url.startsWith(`/projects/${projectId}/images/`), `url 应是项目图片路径，实际 ${url}`);
    assert.ok(fs.existsSync(filePath), `★ 项目目录里没文件（没落盘）：${filePath}`);
    assert.ok(getProjectImageDir(projectId).startsWith, 'image dir helper ok');
    // 对话流：多了一条 markdown 图片消息
    const afterMsgs = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1', [convId]);
    assert.ok(afterMsgs.rows[0].n > beforeMsgs.rows[0].n, `对话流没新增图片消息（before=${beforeMsgs.rows[0].n} after=${afterMsgs.rows[0].n}）`);
    const lastMsg = await pool.query<{ content_enc: string }>('SELECT content_enc FROM messages WHERE conversation_id=$1 ORDER BY id DESC LIMIT 1', [convId]);
    const text = cipher.decryptText(lastMsg.rows[0].content_enc);
    assert.match(text, /!\[.*\]\(\/projects\/\d+\/images\/.+\)/, `消息不是 markdown 图片：${text}`);
    // 把生成的 url 留给 ⑦（取回）
    (main as any).__servedUrl = url;
  });

  await check('⑦ GET /projects/:id/images/:file 原样取回（content-type image/png）', async () => {
    const url = (main as any).__servedUrl as string;
    if (!url) throw new Error('没有可取回的 url');
    const res = await app.inject({ method: 'GET', url, headers: auth });
    assert.equal(res.statusCode, 200, `取图片 ${res.statusCode} ${res.body}`);
    assert.match(res.headers['content-type'] as string, /image\/png/, `content-type 应 image/png，实际 ${res.headers['content-type']}`);
    assert.equal(res.rawPayload.length, ONE_PX_PNG.length, '取回的字节与落盘不一致');
  });

  await check('⑧ web_search 未配置 → 工具执行器回 not_configured（不发注定失败的请求）', async () => {
    setSearchProviderResolverForTest(null); // 用真实解析（无 db 配置、无 env）→ 应 null
    const { executeWebSearchViaProvider } = await import('../../apps/server/src/orchestrator/search');
    const { resolveSearchProviderForUser } = await import('../../apps/server/src/plugins/resolve');
    const provider = await resolveSearchProviderForUser(pool, cipher, userId, env);
    assert.equal(provider, null, '没配置时应解析出 null 供应商');
    const r = await executeWebSearchViaProvider(provider, { query: '某某新闻' });
    assert.equal(r.ok, false, '未配置应 ok=false');
    assert.equal((r as any).error, 'not_configured', `应是 not_configured，实际 ${(r as any).error}`);
  });

  await check('⑨ POST /plugins/:id/test 未配置 → 400（没 key 测不了）', async () => {
    const res = await app.inject({ method: 'POST', url: '/plugins/web_search/test', headers: auth, payload: '{}' });
    assert.equal(res.statusCode, 400, `未配置 test 应 400，实际 ${res.statusCode} ${res.body}`);
    assert.equal((res.json() as { code?: string }).code, 'not_configured');
  });

  await check('⑩ DELETE /plugins/:id/config 清空（=拔配置）→ 状态回灰', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/plugins/image_gen/config', headers: auth });
    assert.equal(res.statusCode, 200, `DELETE config ${res.statusCode}`);
    const list = (JSON.parse((await app.inject({ method: 'GET', url: '/plugins', headers: auth })).body) as { plugins: Plugin[] }).plugins;
    assert.equal(list.find((p) => p.id === 'image_gen')!.status, 'unconfigured', '清空后应回 unconfigured');
  });

  setImageProviderResolverForTest(null);
  setSearchProviderResolverForTest(null);

  log(`\n=== 结论：${passes} PASS / ${fails} FAIL ===`);
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('验收脚本自身出错：', err);
  process.exit(1);
});
