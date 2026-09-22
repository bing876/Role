/**
 * AI 工作台最小后端（第 21 步：账号 + 流式聊天 + **服务端工具循环**）。
 *
 * 接口面：GET /health（免，含第 16 步的 llmCalls 计数 + 第 21 步的 liveLoops/loopMaxSteps）
 *           + /auth/*（账号）
 *           + /chat/stream、/chat/history、/chat/state（聊天 + 第 16 步会话状态/保活）
 *           + /agent/loop/start|next|stop（**第 21 步工具循环：脑在这一侧**）
 *           + /agent/next-action、/agent/task/*（老的单步接口，已改成同一引擎的适配器）
 *           + /knowledge、/knowledge/upload（第 11 步资料原文密文知识库，要 JWT）
 *           + /agents*、/memory/*（第 15 步多智能体 + 两层记忆，要 JWT）。
 * 第 16 步：所有模型调用都收口到 llm.ts（计数 + [llm] 日志），空闲/保活路径一次都不调。
 * 第 21 步：任务轮的循环（消息历史 / 工具表 / 步数上限 / 提示词）**只在服务端 toolLoop.ts**，
 * 桌面只当「手」：拿工具 → 在**当前智能体**那张 webview 上执行 → 回执喂回模型。
 * 服务器**不直接碰浏览器**：也拿不到 CDP，执行与叫停都在本地。监听 127.0.0.1。
 * 明确没有：邮箱登录、真微信、无头浏览器、Playwright/Puppeteer。
 */
import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { loadEnv } from './env';
import type { Pool } from 'pg';
import { makePool, migrate } from './db';
import { makeCipher } from './crypto';
import { llmCallCount } from './llm';
import { registerAuthRoutes } from './routes/auth';
import { registerChatRoutes } from './routes/chat';
import { registerAgentRoutes } from './routes/agent';
import { registerMemoryRoutes, startIdleScheduler } from './routes/memories';
import { registerKnowledgeRoutes, KNOWLEDGE_MAX_UPLOAD_BYTES } from './routes/knowledge';
import { registerMultiAgentRoutes } from './routes/agents';
import { registerProjectRoutes } from './routes/projects';
import { registerLoopRoutes } from './routes/loop';
import { liveLoopCount, runningLoopCount, agentLoopActiveWindowMs } from './toolLoop';
import { pageStateCount } from './pageState';

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = makePool(env.databaseUrl);
  const cipher = makeCipher(env.dataKey);
  const app = Fastify({ logger: false });

  // 桌面 dev 是 http://localhost:5173、生产是 file://（Origin: null）——回显来源即可；
  // 服务只听 127.0.0.1，不暴露局域网。
  // 第 19 步：DELETE 是新增的方法（删知识库资料）。带 authorization 头的 DELETE 会先发
  // OPTIONS 预检，这里不列出来就会被浏览器拦在门外（前端只看到「连不上后端」，很像服务没起）。
  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] });
  // 第 11 步：只给知识库上传用。文件只在内存解析，不保存原始上传文件。
  await app.register(multipart, {
    limits: { files: 1, fields: 4, parts: 5, fileSize: KNOWLEDGE_MAX_UPLOAD_BYTES },
  });

  app.get('/health', async () => {
    let db: 'up' | 'down' = 'down';
    try {
      await pool.query('SELECT 1');
      db = 'up';
    } catch {
      /* 库没起也不让健康检查崩：桌面要能区分“后端没起”和“后端起了库没起” */
    }
    return {
      ok: true,
      service: 'ai-workbench-server',
      db,
      sms: env.smsMock ? 'mock' : 'http',
      llm: env.deepseekApiKey ? 'configured' : 'missing', // 只报有没有配，绝不回显 key
      // 第 16 步：模型调用**累计次数**。保活/空闲挂着时这个数不动，就是「不调 LLM」的证据。
      llmCalls: llmCallCount(),
      // 第 21 步：工具循环（脑在服务端）。loopMaxSteps = 每轮步数上限
      // （配置项 AGENT_LOOP_MAX_STEPS，默认 10，8~12）。
      loopMaxSteps: env.agentLoopMaxSteps,
      // liveLoops = **最近 liveLoopsWindowMs 毫秒内有推进**的循环数（真正活着的那几路）。
      // runningLoops = 状态还是 running 的循环数（旧口径，含「挂着没人驱动」的）。
      // 两者一起看才有意义：running 高、live 低 = 有循环虚挂着，不是真在跑。
      // 窗口配置项 AGENT_LOOP_ACTIVE_WINDOW_MS，默认 60000（5s~600s）。
      liveLoops: liveLoopCount(),
      runningLoops: runningLoopCount(),
      liveLoopsWindowMs: agentLoopActiveWindowMs(),
      // 子阶段 A：按页（wcId）分片的实时状态现在在册几张页（证明分片真的按页建起来了）
      pageStates: pageStateCount(),
      time: new Date().toISOString(),
    };
  });

  registerAuthRoutes(app, { pool, env, cipher });
  registerChatRoutes(app, { pool, env, cipher });
  registerAgentRoutes(app, { pool, env, cipher });
  // 第 10 步：用户档案记忆（确认后才注入）；闲置 15 分钟的自动提取靠这个扫描
  registerMemoryRoutes(app, { pool, env, cipher });
  // 第 11 步：资料上传/列表；聊天检索块在 chat.ts 单独接入，不碰驾驶员 JSON。
  registerKnowledgeRoutes(app, { pool, env, cipher });
  // 第 15 步：智能体（添加/引导表人设/删）+ 两层记忆（user_memories 账号级、agent_memories 智能体级）。
  registerMultiAgentRoutes(app, { pool, env, cipher });
  // 子阶段 2-A：项目（智能体的上层容器）—— 建/列/改名/设为当前；建项目会连带建一只母鸡。
  registerProjectRoutes(app, { pool, env, cipher });
  // 第 21 步：网页工具循环（脑在服务端；工具 open_url/read_page/click/type/scroll/stop，
  // 执行在桌面主进程的现有 driver 上）。/chat/stream 的任务轮与它共用同一份 session_state。
  registerLoopRoutes(app, { pool, env, cipher });
  startIdleScheduler({ pool, env, cipher });

  // ★ 迁移必须**带重试**（2026-09-20 修）。
  //
  // 原来这里是 `try { await migrate(pool) } catch { 打一句警告 }` —— 只跑一次。
  // 问题：PostgreSQL 崩溃恢复期间**端口已经监听、但任何查询都报**
  // `the database system is starting up`（本机实测空窗 ~32 秒）。
  // 桌面端刚把库拉起来就立刻拉服务端，migrate 正好撞进这个窗口 → 失败，
  // 然后**永远不再重试** —— 服务端带着一个没建表的库跑到天荒地老。
  //
  // 现在：后台重试，最多 2 分钟。成功打「数据库表就绪」，一直失败才打错误。
  // 放在 app.listen **之后**（不 await）—— 不能让建表把端口挡住，
  // 否则桌面端等的 30 秒就白等了。
  void migrateWithRetry(pool);

  await app.listen({ port: env.port, host: '0.0.0.0' });
  console.log(
    `[server] http://0.0.0.0:${env.port} —— GET /health；短信模式：${env.smsMock ? 'mock（验证码只进本日志）' : 'http 网关'}` +
      `；模型：${env.deepseekApiKey ? `已配置（${env.deepseekModel} @ ${env.deepseekBaseUrl}）` : '未配置（/chat/stream 与 /agent/next-action 会明确拒绝并提示填 DEEPSEEK_API_KEY）'}`,
  );
}

/**
 * 建表（migrate）带重试 —— 见上面调用处的注释。
 *
 * 为什么不能只跑一次：PostgreSQL 崩溃恢复期间端口已监听、但查询会报
 * `the database system is starting up`（本机实测空窗 ~32 秒）。
 * 桌面端拉起库之后立刻拉起服务端，正好撞进这个窗口。
 *
 * 重试节奏：每 3 秒一次、最多 40 次（≈2 分钟）。
 * 第一次失败就打一句「暂未连通」让用户知道，之后只在最终结果时再打日志，
 * 免得 40 行一样的警告把日志刷爆。
 */
async function migrateWithRetry(pool: Pool): Promise<void> {
  const MAX_TRIES = 40;
  const RETRY_INTERVAL_MS = 3000;

  for (let i = 1; i <= MAX_TRIES; i++) {
    try {
      await migrate(pool);
      console.log(
        '[server] 数据库表就绪（users/projects/agents/sms_codes/conversations/messages/tasks/memories/knowledge_documents/knowledge_chunks/user_memories/agent_memories）',
      );
      if (i > 1) console.log(`[server] （建表在第 ${i} 次尝试成功 —— 之前库还在恢复中）`);
      return;
    } catch (err) {
      const msg = (err as Error).message;
      if (i === 1) {
        console.warn('[server] 数据库暂未连通，服务照常起（/auth 会回 503 提示）：', msg);
      }
      if (i === MAX_TRIES) {
        console.error(
          `[server] 建表重试 ${MAX_TRIES} 次（约 ${(MAX_TRIES * RETRY_INTERVAL_MS) / 1000} 秒）仍失败：`,
          msg,
        );
        return;
      }
      await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
    }
  }
}

main().catch((err) => {
  console.error('[server] 启动失败：', (err as Error).message);
  process.exit(1);
});
