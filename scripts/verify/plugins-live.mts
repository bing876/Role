/**
 * 能力与连接 · **真 key 验收**（手动跑，需真实供应商 key）
 *
 * 这是「配测试 key → 搜 XX 真返回摘要 / 画一只猫真出图」那两条**真端到端**。
 * 无 key 时**跳过**（exit 0，不打红），有 key 才真连外部 API 验证。
 *
 * 用法：
 *   # 网页搜索（Tavily）
 *   PLUGINS_TAVILY_KEY=tvly-… npx tsx scripts/verify/plugins-live.mts
 *   # 生成图片（默认通义万相；openai 就 PLUGINS_IMAGE_PROVIDER=openai）
 *   PLUGINS_IMAGE_KEY=sk-… npx tsx scripts/verify/plugins-live.mts
 *   # 两个都验：
 *   PLUGINS_TAVILY_KEY=tvly-… PLUGINS_IMAGE_KEY=sk-… PLUGINS_IMAGE_PROVIDER=dashscope npx tsx scripts/verify/plugins-live.mts
 *
 * ★ 真连外部 API、会花那点免费额度 / token —— 只在你手上有 key、且要验真时跑。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadEnv } from '../../apps/server/src/env';
import { makeCipher } from '../../apps/server/src/crypto';
import { makePool, migrate } from '../../apps/server/src/db';
import { buildApp } from '../../apps/server/src/index';
import { initOrchestrator } from '../../apps/server/src/orchestrator/tools';
import { serverToolRegistry } from '../../apps/server/src/toolRegistry';
import { resolveSearchProviderForUser, resolveImageProviderForUser } from '../../apps/server/src/plugins/resolve';
import type { ImageProvider } from '../../apps/server/src/plugins/providers';

let passes = 0;
let fails = 0;
let skipped = 0;
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

async function main(): Promise<void> {
  log('=== 能力与连接 · 真 key 验收（真连外部 API）===');
  const tavilyKey = (process.env.PLUGINS_TAVILY_KEY || process.env.TAVILY_API_KEY || '').trim();
  const imageKey = (process.env.PLUGINS_IMAGE_KEY || '').trim();
  const imageProvider = (process.env.PLUGINS_IMAGE_PROVIDER || 'dashscope').trim() === 'openai' ? 'openai' : 'dashscope';
  const imageKeyLabel = imageProvider === 'openai' ? 'OPENAI_API_KEY' : 'DASHSCOPE_API_KEY';

  process.env.DATABASE_URL ??= 'pglite://memory';
  process.env.JWT_SECRET ??= 'verify-plugins-live-jwt';
  process.env.DATA_KEY ??= 'k'.repeat(64);
  process.env.PHONE_PEPPER ??= 'verify-plugins-live-pepper';
  process.env.SMS_MOCK ??= '1';
  delete process.env.TAVILY_API_KEY; // 搜索走「抽屉配置」那条路（不靠 env 兜底），验真配置生效

  if (!tavilyKey && !imageKey) {
    log('（没配 key，跳过。要验真：见文件头用法，配 PLUGINS_TAVILY_KEY / PLUGINS_IMAGE_KEY 再跑）');
    process.exit(0);
  }

  const env = loadEnv();
  const cipher = makeCipher(env.dataKey);
  const pool = await makePool(env.databaseUrl);
  await migrate(pool);
  const app = await buildApp(env, pool, cipher);
  initOrchestrator({ pool, env, cipher });

  const H = { 'content-type': 'application/json' };
  const phone = '137' + String(Date.now()).slice(-8);
  const sj = await app.inject({ method: 'POST', url: '/auth/sms/send', headers: H, payload: JSON.stringify({ phone }) });
  const code = (sj.json() as { mock_code?: string }).mock_code;
  const lj = await app.inject({ method: 'POST', url: '/auth/login/sms', headers: H, payload: JSON.stringify({ phone, code }) });
  const token = (lj.json() as { token?: string }).token;
  const auth = { ...H, authorization: `Bearer ${token}` };
  const userId = Number((lj.json() as { user: { id: number } }).user.id);
  const projectId = (JSON.parse((await app.inject({ method: 'GET', url: '/projects', headers: auth })).body) as { currentProjectId: number }).currentProjectId;
  const agent = await pool.query<{ id: string }>('SELECT id FROM agents WHERE project_id = $1 LIMIT 1', [projectId]);
  const agentId = Number(agent.rows[0].id);
  const conv = await pool.query<{ id: string }>("INSERT INTO conversations (project_id, title) VALUES ($1, '真key验收') RETURNING id", [projectId]);
  const convId = Number(conv.rows[0].id);
  const ctx = { loopId: 'verify-plugins-live', userId, agentId, wcId: null, conversationId: convId, snapshot: null };

  // ---- 网页搜索：真连 Tavily ----
  if (tavilyKey) {
    await app.inject({ method: 'POST', url: '/plugins/web_search/config', headers: auth, payload: JSON.stringify({ config: { provider: 'tavily', apiKey: tavilyKey } }) });
    await check('「搜 XX」真返回摘要（Tavily 真出结果）', async () => {
      const provider = await resolveSearchProviderForUser(pool, cipher, userId, env);
      assert.ok(provider, '没解析出搜索供应商');
      const r = await provider.search('2026 年 上海 天气', { maxResults: 5 });
      assert.equal(r.ok, true, `搜索失败：${r.error ?? r.detail}`);
      assert.ok(r.count > 0, `应搜到结果，实际 ${r.count}`);
      assert.ok(r.sources.length > 0, '应带回来源（标题/网址）');
      assert.ok(r.items[0]?.content, '结果应带摘要内容');
      log(`      搜到 ${r.count} 条：${r.sources[0].title}（${r.sources[0].domain}）`);
    });
  } else {
    skipped += 1;
    log('  ○ 跳过：没配 PLUGINS_TAVILY_KEY（搜索真验）');
  }

  // ---- 生成图片：真连 通义万相 / OpenAI ----
  if (imageKey) {
    await app.inject({ method: 'POST', url: '/plugins/image_gen/config', headers: auth, payload: JSON.stringify({ config: { provider: imageProvider, apiKey: imageKey } }) });
    await check(`「画一只猫」真出图（${imageKeyLabel} 真生成 + 落盘 + 进对话流）`, async () => {
      const provider = await resolveImageProviderForUser(pool, cipher, userId);
      assert.ok(provider, '没解析出图片供应商');
      // 走**注册表执行器**（= 循环 advanceInner 的执行路径），验全链路
      const executor = serverToolRegistry.getExecutor('generate_image');
      assert.ok(executor, 'generate_image 没注册执行器');
      const r = await executor.execute({ prompt: '一只猫，扁平插画风格' }, ctx as any);
      assert.equal(r.ok, true, `出图失败：${JSON.stringify({ ok: r.ok, error: (r as any).error, detail: (r as any).detail })}`);
      const filePath = (r.data as { filePath: string }).filePath;
      assert.ok(fs.existsSync(filePath), `项目目录没文件：${filePath}`);
      const size = fs.statSync(filePath).size;
      assert.ok(size > 1024, `图片太小（${size}B），不像真图`);
      log(`      出图成功：${filePath}（${Math.round(size / 1024)}KB）`);
      // 进对话流：会话多了一条 markdown 图片消息
      const msg = await pool.query<{ content_enc: string }>('SELECT content_enc FROM messages WHERE conversation_id=$1 ORDER BY id DESC LIMIT 1', [convId]);
      const text = cipher.decryptText(msg.rows[0].content_enc);
      assert.match(text, /!\[.*\]\(\/projects\/\d+\/images\/.+\)/, `对话流里没图片消息：${text}`);
    });
  } else {
    skipped += 1;
    log(`  ○ 跳过：没配 PLUGINS_IMAGE_KEY（图片真验，provider=${imageProvider}）`);
  }

  log(`\n=== 结论：${passes} PASS / ${fails} FAIL / ${skipped} SKIP ===`);
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('验收脚本自身出错：', err);
  process.exit(1);
});
