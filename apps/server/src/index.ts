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
import { makePool, migrate, migrateTaskGoalEncryption } from './db';
import { makeCipher, type JsonCipher } from './crypto';
import { llmCallCount } from './llm';
import { registerAuthRoutes } from './routes/auth';
import { registerChatRoutes } from './routes/chat';
import { registerAgentRoutes } from './routes/agent';
import { registerMemoryRoutes, startIdleScheduler } from './routes/memories';
import { registerKnowledgeRoutes, KNOWLEDGE_MAX_UPLOAD_BYTES } from './routes/knowledge';
import { registerMultiAgentRoutes } from './routes/agents';
import { registerProjectRoutes } from './routes/projects';
import { registerLoopRoutes } from './routes/loop';
import { registerChannelRoutes } from './routes/channels';
import { registerRoutineRoutes } from './routes/routines';
import { registerHandoffRoutes } from './routes/handoffs';
import { registerWhiteboardRoutes } from './routes/whiteboard';
import { registerSkillsRoutes } from './routes/skills';
import { registerComputerVisibilityRoutes } from './routes/computerVisibility';
import { initOrchestrator } from './orchestrator/tools';
import { startRoutineSweeper } from './orchestrator/routines';
import { setCheckpointDeps } from './toolLoop';
import { restoreLoops } from './orchestrator/checkpoint';
import { jobStats } from './orchestrator/registry';
import { subLoopCount } from './orchestrator/subLoops';
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
      // 多智能体编排：在飞的后台子任务（临时工批次 / 委派）+ 累计计数。
      // jobs.byKind 两个数一起看才有意义：delegate 一直不为 0 = 有委派没收到尾（该查熔断）。
      jobs: jobStats(),
      subLoops: subLoopCount(),
      orchestration: env.orch.enabled ? 'on' : 'off',
      delegateTimeoutMs: env.orch.delegateTimeoutMs,
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
  // 多智能体编排：内部频道的**只读**接口（用户看智能体之间怎么交流的）
  registerChannelRoutes(app, { pool, env, cipher });
  // 定时/事件触发（Routines）：描述=长期规矩，对话=一次活
  registerRoutineRoutes(app, { pool, env, cipher });
  // 批次 A | 交接结构化：项目工作区 handoffs/ + board.md 单写者
  registerHandoffRoutes(app, { pool, env, cipher });
  // 批次 B | 项目共享白板：项目简报，所有成员自动注入；贴白板=待确认记忆卡
  registerWhiteboardRoutes(app, { pool, env, cipher });
  // 批次 F | Skills — teach-a-task 落成 skills 表
  registerSkillsRoutes(app, { pool, env, cipher });
  // 批次 H | 电脑三级可见度 — Status/Preview/Takeover，默认收起
  registerComputerVisibilityRoutes(app, { pool, env, cipher });
  /**
   * 多智能体编排 · 装编排能力（web_search / spawn_workers / delegate 三个服务端工具 + 名额表）。
   *
   * ★ 必须在 `registerLoopRoutes` **之后**、服务开始收请求**之前**装：
   *   `startLoop` 只记工具**名字**，真正解析发生在每次 `advance` 调模型前。
   *   装晚了的话，第一个请求会拿到一张「名字在册、实现不在册」的工具表。
   * ★ 只装一次（`initOrchestrator` 自己有闸）：env 是启动时读的，跑起来不会变。
   * ★ 关掉它 = `ORCHESTRATION_TOOLS=0`：三个工具都不注册，主循环工具表回到改动前那张，
   *   `LOOP_SYSTEM_PROMPT` 从头到尾没改过一个字 —— 所以关掉就是**完全回到旧行为**。
   */
  initOrchestrator({ pool, env, cipher });
  // 修 1：checkpoint 加密，传入 cipher，落库为密文，SELECT 读不到明文
  setCheckpointDeps(pool, cipher);
  startIdleScheduler({ pool, env, cipher });
  startRoutineSweeper(pool, cipher, 60_000);
  // 批次 D | 重启恢复：借 LangGraph checkpoint 思路，循环状态落库，服务重启能续跑正在进行的 job（修 1 已加密）
  void (async () => {
    try {
      const { restoreLoopFromCheckpoint } = await import('./toolLoop');
      const restored = await restoreLoops(pool, (partial) => {
        restoreLoopFromCheckpoint(partial as any);
      }, cipher);
      if (restored > 0) console.log(`[server] 重启恢复完成：${restored} 个循环已恢复（已解密）`);
    } catch (err) {
      console.warn('[checkpoint] 重启恢复失败（忽略）：', (err as Error).message);
    }
  })();

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

  /**
   * ★ 收尾 6：把历史明文 goal 回填成密文（`task_pauses.goal` → `goal_enc`；
   *   `tasks.payload.goal` / `tasks.title` → `goal_enc`）。
   *
   * 同样**不 await**、放在 listen 之后：回填要逐行加解密，老库可能有几千行，
   * 不能让桌面端等的那 30 秒耗在这里；期间读接口走「解密优先、回退旧列」，
   * 所以回填没跑完也不影响功能（只是那几行暂时还是明文）。
   *
   * 与 migrateWithRetry 分开跑、各自重试：建表成功不代表回填成功（比如 DATA_KEY 缺失时
   * migrateTaskGoalEncryption 会 fail-closed 跳过），两件事的失败原因和重试节奏都不同。
   */
  void migrateTaskEncryptionWithRetry(pool, cipher);

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

/**
 * 收尾 6 | goal 密文回填带重试 —— 与上面的 `migrateWithRetry` 同一套节奏（3 秒 × 40 次 ≈ 2 分钟）。
 *
 * 为什么要重试而不是跑一次：
 *   1. 建表也是后台重试的，回填可能在 `goal_enc` 列还不存在时就跑（列不存在 → 结构性错误 → 重试）；
 *   2. PostgreSQL 崩溃恢复期同样会让这几条 UPDATE 报错；
 *   3. 回填是**幂等**的（`WHERE goal_enc IS NULL`），重试不会重复加密、也不会覆盖已回填的行。
 *
 * ★ 只在「结构性失败」时重试。单行加密失败由 migrateTaskGoalEncryption 自己计数并保留原样，
 *   不抛出来 —— 那种错误重试 40 次也一样失败，只会把日志刷爆。
 * ★ 一行都没动（老库本来就是干净的 / 已经回填过）时不打日志，免得每次启动都多一行噪音。
 */
async function migrateTaskEncryptionWithRetry(pool: Pool, cipher: JsonCipher): Promise<void> {
  const MAX_TRIES = 40;
  const RETRY_INTERVAL_MS = 3000;

  for (let i = 1; i <= MAX_TRIES; i++) {
    try {
      const r = await migrateTaskGoalEncryption(pool, cipher);
      if (r.skipped) {
        // cipher 缺失是 fail-closed 跳过（明文原样留着，不写兜底）—— 这里 cipher 是启动时
        // makeCipher(env.dataKey) 造出来的，正常路径进不来；真进来说明有人改了启动顺序。
        console.warn('[server] goal 密文回填被跳过（没拿到 cipher）：明文行保留，下次启动再试');
        return;
      }
      if (r.pauses || r.tasks || r.failed) {
        console.log(
          `[server] goal 密文回填完成：task_pauses ${r.pauses} 条、tasks ${r.tasks} 条` +
            (r.failed ? `（另有 ${r.failed} 条加密失败，明文保留待下次）` : '') +
            (i > 1 ? `；在第 ${i} 次尝试成功` : ''),
        );
      }
      return;
    } catch (err) {
      const msg = (err as Error).message;
      if (i === 1) console.warn('[server] goal 密文回填暂未完成（表可能还没建好，继续重试）：', msg);
      if (i === MAX_TRIES) {
        console.error(
          `[server] goal 密文回填重试 ${MAX_TRIES} 次（约 ${(MAX_TRIES * RETRY_INTERVAL_MS) / 1000} 秒）仍失败：`,
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
