/**
 * 第 6 步：DeepSeek 流式聊天（只做嘴，不做手）。
 *
 *   POST /chat/stream   要 JWT。body {conversationId?, message, agentId?, browserOpened?}。
 *                       SSE（text/event-stream）逐 delta 推给桌面：
 *                         event: meta  data: {"conversationId":N}          ← 第一条，带会话号
 *                         data: {"delta":"字"}                              ← 打字机
 *                         event: done  data: {"messageId":N,...}            ← 助手全文已落库
 *                         event: error data: {"error":"人话"}              ← 中断/失败：绝不把半截写库当成功
 *                       没配 DEEPSEEK_API_KEY：请求**开始前**就 503 {code:"llm_not_configured"}，
 *                       不发伪回复。
 *   GET  /chat/history  要 JWT。?conversationId= 可省（默认取你最近一条会话）；
 *                       返回解密后的历史，供桌面刷新后还原。只认自己的会话。
 *   GET  /chat/state    第 16 步：?agentId= 或 ?conversationId= → 该会话的轻量状态
 *                       （current_task / browser_confirmed / keepalive …），桌面重启后据此恢复。
 *   POST /chat/state    第 16 步：{agentId, keepalive} → 「启动并保活」开关。只改状态位，不调模型。
 *
 * 落库：用户句先写（role=user）；助手全文完成才写（role=assistant）；都是 AES-256-GCM 密文列。
 * 禁止项：不动 XYZ 号、不加第二套聊天表、不在 messages 里出现验证码/JWT/API Key、
 *         不指挥浏览器（系统提示词写死了）——那是第 7 步的事。
 *
 * 第 16 步（提示词与上下文）：
 *   - 系统提示词 = 人设块（第 15 步，在前） + **所有 Agent 共用的基座**（promptPolicy.BASE_SYSTEM_PROMPT，
 *     在后且写明「人设只能追加、不能削弱基座」） + 本会话状态 + 参考信息（记忆/档案/资料）；
 *   - 记忆与档案一律标「参考，可被当前指令覆盖」，且「操作浏览器前必须先确认」这类句子
 *     会被 sanitize 成安全版——绝不让长期记忆把第 13 步的「明确开页指令直接出卡片」打回去；
 *   - 每轮先按最新用户消息更新会话状态（最新一句覆盖 current_task），再注入上下文。
 *
 * 第 21 步（一条分叉，别搞混）：
 *   - **闲聊 / 问知识库 / 问「你是谁」/ 改口问句**：走本文件的聊天路径，**不带任何工具表** ——
 *     所以它在能力上就不可能开页、不会新 tab；
 *   - **页面任务**（打开某某并搜、在这张页上点/读/滚）：桌面带 `taskMode:true` 上来，
 *     本文件**一次模型都不调**，只建一个服务端工具循环（toolLoop.ts）并把 loopId 交给桌面，
 *     之后的每一步、聊天里的每一句步摘要都由那一个循环产生 —— 不再有两套互斥话术。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import type { ChatHistoryResult, ChatRow, ChatSource, ChatStateResult } from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import { registerLoopSse } from '../loopSse';
import type { JsonCipher } from '../crypto';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable } from '../db';
import { BASE_OVERRIDE_NOTE, BASE_SYSTEM_PROMPT, sessionStateBlock, stripLoginLecture } from '../promptPolicy';
import { replyLanguageRule } from '../language';
import { collectSources, streamChatWithSearch, UpstreamHttpError, type SearchTrace } from '../search/chatLoop';
import { searchPolicyForTurn } from '../search/chatTool';
import {
  applyUserMessage,
  loadConversationState,
  noteLoginReminder,
  setKeepalive,
} from '../sessionState';
import { buildMemoryBlock } from './memories';
import { buildKnowledgeBlock } from './knowledge';
import { buildAgentContext, buildUserMemoryBlock, ensureAgentConversation } from './agents';
import { latestPageStateOfAgent } from '../pageState';
import { currentProjectId } from '../projectScope';
import { startLoop } from '../toolLoop';
import { orchestrationBlockFor } from '../orchestrator/roster';

export interface ChatDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

/**
 * 系统提示词的**首句**：只放服务端，绝不进前端。
 * 第 15 步起按当前智能体变；第 16 步起后面统一接基座（人设不能关掉基座）。
 */
function systemPromptHead(agentName: string | null): string {
  return agentName && agentName !== '小助'
    ? `你是用户桌面工作台里的一个 AI 智能体（名字见下面的人设块；没给人设就先用「${agentName}」）。`
    : '你是「小助」，用户桌面工作台里的 AI 同事。';
}

const HISTORY_WINDOW = 24; // 拼给模型的历史条数（含本轮前的最近 24 条）
const MESSAGE_MAX = 2000; // 单条用户输入上限
const UPSTREAM_TIMEOUT_MS = 180_000; // 一次模型请求最长 3 分钟

function errJson(reply: FastifyReply, code: number, error: string, extra?: Record<string, unknown>): FastifyReply {
  return reply.code(code).send({ error, ...extra });
}

function dbErr(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) {
    return errJson(reply, 503, '数据库连不上：先 npm run db:up（或 docker compose -f apps/server/docker-compose.yml up -d）');
  }
  const msg = (err as Error)?.message ?? String(err);
  console.error('[chat] 未分类错误：', msg); // 只打 message；调用方保证 message 里不含密钥
  return errJson(reply, 500, `服务端错误：${msg}`);
}

function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

/** 把任意历史行解密成人话文本；密文坏了（比如换过 DATA_KEY）不炸，给占位 */
function safeDecrypt(cipher: JsonCipher, enc: string): string {
  try {
    return cipher.decryptText(enc);
  } catch {
    return '（这条记录解密失败：DATA_KEY 可能换过）';
  }
}

/**
 * 找/建当前用户的一条会话。owner 校验全走 projects.user_id，别人的会话号直接当不存在。
 *
 * 第 15 步：多了 agentId。**一个智能体一份聊天**——没带会话号时优先按智能体找它自己那条，
 * 绝不去捡「本账号最近一条会话」（那可能是别的智能体的，会串聊天）。
 */
async function resolveConversation(
  pool: Pool,
  userId: number,
  conversationId: number | null,
  seedTitle: string,
  agentId: number | null = null,
): Promise<{ id: number } | { err: string; status: number }> {
  if (conversationId !== null) {
    const own = await pool.query<{ id: string }>(
      'SELECT c.id FROM conversations c JOIN projects p ON p.id = c.project_id WHERE c.id = $1 AND p.user_id = $2',
      [conversationId, userId],
    );
    if (own.rowCount !== 1) return { err: '会话不存在或不是你的', status: 404 };
    return { id: Number(own.rows[0].id) };
  }
  // 第 15 步：带智能体号 → 只认这个智能体自己的会话（没有就建一条给它）
  if (agentId !== null) {
    const owned = await pool.query<{ id: string }>(
      'SELECT a.id FROM agents a JOIN projects p ON p.id = a.project_id WHERE a.id = $1 AND p.user_id = $2',
      [agentId, userId],
    );
    if (owned.rowCount !== 1) return { err: '智能体不存在或不是你的', status: 404 };
    const conv = await ensureAgentConversation(pool, userId, agentId);
    if (conv === null) return { err: '建会话失败（智能体或项目缺失）', status: 500 };
    return { id: conv };
  }
  /**
   * 子阶段 2-A：没带智能体号时的兜底 —— 在**当前使用中的项目**里找最近一条会话。
   * （原来写死 `p.is_default = true`，也就是永远只看默认项目；现在跟着「当前项目」走。）
   */
  const curProject = await currentProjectId(pool, userId);
  if (curProject === null) return { err: '当前账号还没有项目（请重新登录一次让建号流程补上）', status: 500 };
  const latest = await pool.query<{ id: string }>(
    'SELECT c.id FROM conversations c JOIN projects p ON p.id = c.project_id WHERE p.user_id = $1 AND c.project_id = $2 ORDER BY c.id DESC LIMIT 1',
    [userId, curProject],
  );
  if (latest.rowCount === 1) return { id: Number(latest.rows[0].id) };
  // 当前项目里的「常驻智能体」：优先自带小助，其次母鸡（新建的项目里只有母鸡）
  const a = await pool.query<{ id: string }>(
    "SELECT id FROM agents WHERE project_id = $1 AND kind IN ('assistant', 'hen') ORDER BY (kind = 'assistant') DESC, id ASC LIMIT 1",
    [curProject],
  );
  // 第 16 步 fixup：有「小助」就走原子的找/建（和 /chat/state、历史加载同一个入口），
  // 免得这条兜底路径和它们并发时又插出第二条会话。
  if (a.rowCount === 1) {
    const conv = await ensureAgentConversation(pool, userId, Number(a.rows[0].id));
    if (conv !== null) return { id: conv };
  }
  const ins = await pool.query<{ id: string }>(
    'INSERT INTO conversations (project_id, agent_id, title) VALUES ($1, $2, $3) RETURNING id',
    [curProject, null, seedTitle.slice(0, 24) || '小助会话'],
  );
  return { id: Number(ins.rows[0].id) };
}

/**
 * 子阶段 A（读侧改动点）：会话级状态为空时，用该智能体名下**最近被碰过的那张页**补上。
 *
 * 为什么需要它：任务轮（`/chat/stream` + taskMode）**不再**把 `current_task` 等写进
 * `conversations`（那是「同一智能体两路并发互相覆盖」的根因），于是桌面的
 * 「当前任务 / 本会话已同意用浏览器」那一行会断档。这里**只填空**：
 * 会话级有值就以会话级为准（闲聊轮写进去的东西照旧优先），没有才用页级兜底。
 * 多路并行时给的是「最近动过的那一路」，与左栏横幅的聚合口径一致。
 */
async function mergeLatestPageState(
  pool: Pool,
  conversationId: number,
  base: Awaited<ReturnType<typeof loadConversationState>>,
): Promise<typeof base> {
  try {
    const r = await pool.query<{ agent_id: string | null }>('SELECT agent_id FROM conversations WHERE id = $1', [
      conversationId,
    ]);
    const agentId = Number(r.rows[0]?.agent_id);
    if (!Number.isInteger(agentId) || agentId <= 0) return base;
    const ps = latestPageStateOfAgent(agentId);
    if (!ps) return base;
    return {
      ...base,
      current_task: base.current_task || ps.current_task,
      last_page_summary: base.last_page_summary || ps.last_page_summary,
      browser_confirmed: base.browser_confirmed || ps.browser_confirmed,
      login_required: base.login_required || ps.login_required,
    };
  } catch {
    // 补不上就照旧回会话级：这只是显示层的兜底，不该让读状态这个接口失败
    return base;
  }
}

/** 转发上游 SSE 时只回给桌面这三类事件；这里统一走 JSON.stringify 防换行截断 */
function sse(res: { write(c: string): unknown }, ev: string | null, data: unknown): void {
  res.write(`${ev ? `event: ${ev}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
}

export function registerChatRoutes(app: FastifyInstance, { pool, env, cipher }: ChatDeps): void {
  // ------------------------------------------------------------------ 聊天流
  app.post('/chat/stream', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期（聊天需要第 5 步的 JWT）');

    const body = req.body as
      | {
          conversationId?: unknown;
          message?: unknown;
          browserOpened?: unknown;
          agentId?: unknown;
          /** 第 21 步：这一轮是「页面任务」，交给服务端工具循环（不再并行第二套话术） */
          taskMode?: unknown;
          /** 第 21 步：这一轮要在哪张页上干活 */
          pageUrl?: unknown;
          /** 第 21 步：那张页的 guest webContents id（循环记着它，挡住串到别的 bot） */
          wcId?: unknown;
        }
      | null;
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) return errJson(reply, 400, 'message 不能为空');
    /**
     * 第 13 步：桌面判断出这是一句「开网页指令」时，会在发这句的同时把已经打开的网址带上来。
     * 它只是系统提示词的一个开关（不是网页内容、不进历史、不落库），用来告诉小助：
     * 网页已经在聊天卡片里打开并加载好了，别再让用户点「确认 / 开始任务」。
     */
    const openedUrl = typeof body?.browserOpened === 'string' ? body.browserOpened.trim().slice(0, 500) : '';
    /**
     * 第 17 步：光给一长串 URL，模型会从**历史**里捡站点名 ——
     * 实测在百度那张页上干活，它却回「好，我在当前页面（必应）搜…」（因为上一轮聊的是必应）。
     * 这里把站点名单独算出来，明写「这一轮只操作这一张页、别提前面出现过的站点」。
     * 纯字符串解析，不联网、不猜。
     */
    const openedHost = (() => {
      try {
        return new URL(openedUrl).host.replace(/^www\./i, '');
      } catch {
        return '';
      }
    })();
    if (message.length > MESSAGE_MAX) return errJson(reply, 400, `单条消息最长 ${MESSAGE_MAX} 字`);
    let conversationId: number | null = null;
    if (body?.conversationId !== undefined && body?.conversationId !== null && body?.conversationId !== '') {
      const n = Number(body.conversationId);
      if (!Number.isInteger(n) || n <= 0) return errJson(reply, 400, 'conversationId 要是正整数（或干脆不传）');
      conversationId = n;
    }
    // 第 15 步：当前智能体号。只在没带会话号时用来定位「它自己那条会话」。
    let agentId: number | null = null;
    if (body?.agentId !== undefined && body?.agentId !== null && body?.agentId !== '') {
      const n = Number(body.agentId);
      if (!Number.isInteger(n) || n <= 0) return errJson(reply, 400, 'agentId 要是正整数（或干脆不传）');
      agentId = n;
    }

    if (!env.deepseekApiKey) {
      // 明确拒绝，绝不用假回复冒充模型
      return errJson(reply, 503, '未配置模型：在 apps/server/.env 填 DEEPSEEK_API_KEY 后重启 dev:server', {
        code: 'llm_not_configured',
      });
    }

    try {
      const conv = await resolveConversation(pool, claims.sub, conversationId, message, agentId);
      if ('err' in conv) return errJson(reply, conv.status, conv.err);
      const convId = conv.id;

      /**
       * 第 16 步：每轮先按**本轮最新消息**更新会话状态，再拿它拼上下文。
       * 规则见 sessionState.applyUserMessage：最新一句覆盖 current_task；「继续 / 按我上一条」
       * 或本轮带了 browserOpened（桌面已直接出卡片）→ browser_confirmed = true，
       * 于是同一会话后续的普通点击/搜索/滚动/读页都不再问。
       *
       * 子阶段 A：**任务轮**（带 taskMode + wcId）额外传 `page` —— 任务态落进**按 wcId 分片**的
       * 存储，不再覆写 conversations 那几列（同一智能体两路并发时互相覆盖的根因就在那几列）。
       */
      const taskWcIdRaw = Number(body?.wcId);
      const taskWcId = Number.isInteger(taskWcIdRaw) && taskWcIdRaw > 0 ? taskWcIdRaw : null;
      const state = await applyUserMessage(pool, convId, message, {
        browserOpened: openedUrl,
        page: body?.taskMode === true && taskWcId !== null ? { wcId: taskWcId, userId: claims.sub, agentId } : null,
      });

      // 1) 先读历史（不含本句），再落用户消息
      const hist = await pool.query<{ role: string; content_enc: string }>(
        'SELECT role, content_enc FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2',
        [convId, HISTORY_WINDOW],
      );
      const history = hist.rows
        .reverse()
        .filter((r) => r.role === 'user' || r.role === 'assistant')
        .map((r) => {
          const content = safeDecrypt(cipher, r.content_enc);
          /**
           * 第 16 步验收第 ④ 条：本会话已经提醒过「自己登录」之后，
           * 历史里的同类安全提示句不再喂给模型 —— 否则它会照抄旧话，变成每轮都提醒。
           * 只改**喂给模型的上下文**，不改库里存的消息、也不改界面上显示的。
           */
          return {
            role: r.role as 'user' | 'assistant',
            content:
              r.role === 'assistant' && state.already_told_user_login_themselves
                ? stripLoginLecture(content)
                : content,
          };
        });
      const um = await pool.query<{ id: string }>(
        "INSERT INTO messages (conversation_id, role, content_enc) VALUES ($1, 'user', $2) RETURNING id",
        [convId, cipher.encryptText(message)],
      );
      const userMessageId = Number(um.rows[0].id);

      /**
       * 服务端自主意图判断：是否进入任务模式（taskMode）。
       * 废除必须依赖前端本地正则预判的硬性拦截，支持"帮我下单"、"诊断店铺"等各种自然语言指令。
       */
      /**
       * R4 保守收紧（2026-09-22）：发车判定收紧，修复“几乎所有聊天都发车”的问题。
       * 旧逻辑：hasPage => true 一票发车；动作词含 搜/查/看；length>=15 一票发车。
       * 新逻辑（保守）：
       *   1. 问候/感谢 -> 聊天
       *   2. 纯概念提问（什么是/解释一下...）且无强动作词 -> 聊天
       *   3. 显式 URL -> 任务
       *   4. 有活页时：只有强动作词，或 弱动作词(搜/查/看)+页面指代(这个页面/当前页/页面上...) 才发车
       *   5. 无活页时：只有强动作词才发车，弱动作词一律走聊天搜索
       *   6. 删除 length>=15 一票发车
       */
      const shouldEnterTaskMode = (msg: string, hasPage: boolean): boolean => {
        const t = (msg ?? '').trim();
        if (!t) return false;
        // 1. 纯问候/纯闲聊/感谢 -> 走普通聊天
        if (/^(你好|您好|hi|hello|哈喽|早上好|中午好|晚上好|早安|晚安|嗨|你是谁|做个自我介绍|介绍一下你自己|谢谢|感谢|多谢|thx|thanks)[!！。？?~～\s]*$/i.test(t)) {
          return false;
        }
        // 2. 纯概念提问且无强动作词 -> 走普通聊天（普通聊天自带 web_search）
        if (/^(什么是|解释一下|科普一下|写一首|写一篇|写一段|帮我写代码)/.test(t)) {
          if (!/(打开|访问|浏览|点击|填|输入|登录|注册|下单|买|购|订|选|抓取|整理|分析|诊断|爬取|刷新|滚动|关闭|切换|http)/.test(t)) {
            return false;
          }
        }
        // 3. 显式 URL -> 任务（用户贴了链接要打开）
        if (/https?:\/\//i.test(t)) {
          return true;
        }
        // 强动作词：明确的浏览器/交易操作，不含模糊的 搜/查/看
        const STRONG_ACTION = /(打开|访问|浏览|点击|填|输入|登录|注册|下单|买|购|订|选|抓取|整理|分析|诊断|爬取|刷新|滚动|关闭|切换)/;
        // 弱动作词：搜/查/看，单独出现时走聊天搜索，只有配合页面指代才算浏览器任务
        const WEAK_ACTION = /(搜|查|看)/;
        const PAGE_REF = /(这个页面|当前页|当前页面|这张页|页面上|页面里|在这里|在这张|在这页|此页面)/;

        if (hasPage) {
          // 有活页时：强动作词 => 任务；弱动作词 + 页面指代 => 任务；其余 => 聊天
          if (STRONG_ACTION.test(t)) return true;
          if (WEAK_ACTION.test(t) && PAGE_REF.test(t)) return true;
          return false;
        } else {
          // 无活页时：只有强动作词才发车，弱动作词一律走聊天
          if (STRONG_ACTION.test(t)) return true;
          return false;
        }
      };

      const hasActivePage = Boolean(taskWcId || openedUrl || (typeof body?.pageUrl === 'string' && body.pageUrl.trim()));
      const isExplicitTask = body?.taskMode === true;
      const isTaskMode = isExplicitTask || shouldEnterTaskMode(message, hasActivePage);

      /**
       * 第 21 步 · 任务轮：**这一轮不进聊天模型，交给工具循环**。
       *
       * 任务轮 SSE 保持长连：禁止在推送开场白后立即 res.end()，
       * 将主进程每一步执行状态（step / note / result）通过 SSE 实时推回聊天界面。
       */
      if (isTaskMode) {
        const pageUrl = typeof body?.pageUrl === 'string' ? body.pageUrl.trim().slice(0, 500) : '';
        // 子阶段 A：wcId 在上一段已经解析过（taskWcId），这里直接复用，别再解析第二遍
        const wcId = taskWcId;
        // 循环记的智能体以**会话自己的 agent_id** 为准（比请求里的 agentId 更权威）
        const convAgent = await pool.query<{ agent_id: string | null }>('SELECT agent_id FROM conversations WHERE id = $1', [convId]);
        const convAgentId = Number(convAgent.rows[0]?.agent_id);
        const loopAgentId = Number.isInteger(convAgentId) && convAgentId > 0 ? convAgentId : agentId;
        // 记忆合并第二批：任务轮三级作用域（账号级+智能体级+会话级）
        let taskMemoryBlock: string | undefined;
        try {
          taskMemoryBlock = await buildMemoryBlock(pool, cipher, claims.sub, message, loopAgentId ?? null, convId ?? null);
        } catch (err) {
          console.warn('[chat] 任务轮记忆块拼装失败（忽略，照常建循环）：', (err as Error).message);
        }

        const loop = startLoop(env, {
          userId: claims.sub,
          agentId: loopAgentId,
          conversationId: convId,
          wcId,
          goal: message,
          pageUrl: pageUrl || openedUrl,
          // 多智能体编排：同项目同事名单（与 /agent/loop/start 走同一个拼装函数，
          // 两条入口给的名单必须一模一样 —— 否则「聊天里能委派、任务里不能」就成了玄学）。
          // 出错/没开编排 → undefined，startLoop 那边走「不加这一段」的老路。
          orchestrationBlock: await orchestrationBlockFor(pool, env, claims.sub, loopAgentId),
          memoryBlock: taskMemoryBlock,
          state: {
            current_task: state.current_task,
            browser_confirmed: state.browser_confirmed,
            login_required: state.login_required,
            already_told_user_login_themselves: state.already_told_user_login_themselves,
            last_page_summary: state.last_page_summary,
          },
        });
        const host = openedHost || (() => {
          try {
            return new URL(pageUrl).host.replace(/^www\./i, '');
          } catch {
            return '';
          }
        })();
        const opening = `好，我在${host ? `「${host}」` : '当前'}这张页上动手了，做完把结果给你。`;
        await pool.query<{ id: string }>(
          "INSERT INTO messages (conversation_id, role, content_enc) VALUES ($1, 'assistant', $2) RETURNING id",
          [convId, cipher.encryptText(opening)],
        );
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          'access-control-allow-origin': req.headers.origin ?? '*',
        });
        sse(res, 'meta', { conversationId: convId, userMessageId, agentId: loop.agentId });
        sse(res, 'loop', { loopId: loop.id, maxSteps: loop.maxSteps, agentId: loop.agentId, pageUrl: pageUrl || openedUrl, wcId });
        sse(res, null, { delta: opening });
        
        // ★ 核心修复：保持长连，不调用 res.end()！注册 SSE 订阅供主进程步骤广播
        registerLoopSse(loop.id, res, convId);
        return;
      }

      // 第 10 步：该用户已确认的档案记忆注入系统提示词（无记忆=空串，行为与第 9 步一致）
      // 第 16 步：它只是**参考**（buildMemoryBlock 自己带「可被当前指令覆盖」的表头）。
      // 记忆合并第二批：三级作用域，支持按 owner+agent+conversation 过滤
      const memBlock = await buildMemoryBlock(pool, cipher, claims.sub, message, agentId ?? null, convId ?? null);
      // 第 15 步 · 两层记忆 + 当前智能体人设：
      //   - 用户记忆库（账号级）：所有智能体都读得到，是「这个人」的习惯/口味；
      //   - 项目记忆（智能体级）：**只**读当前会话所属智能体那一份，绝不串号；
      //   - 人设：引导表填完就按它干活；没填完只让模型引导用户去填表，不许空人设乱聊。
      const agentCtx = await buildAgentContext(pool, cipher, claims.sub, convId, agentId);
      const userMemoryBlockRaw = await buildUserMemoryBlock(pool, cipher, claims.sub);
      // 第 11 步：知识库资料是与 memories 完全独立的、仅聊天用的上下文位置。
      // buildKnowledgeBlock 只按当前 owner 的加密片段做关键词字面匹配；空命中/异常都返回空，
      // 不进 agent 的驾驶员 JSON，也不触碰第 10 步的确认逻辑。
      // 子阶段 2-A：**按这条会话所属项目**检索（知识库现在有项目归属，不能跨项目串资料）。
      const convProject = await pool.query<{ project_id: string }>(
        'SELECT project_id FROM conversations WHERE id = $1',
        [convId],
      );
      const convProjectId = Number(convProject.rows[0]?.project_id);
      const knowledgeBlock = Number.isInteger(convProjectId) && convProjectId > 0
        ? await buildKnowledgeBlock(pool, cipher, claims.sub, message, convProjectId)
        : '';
      // 第 13 步：网页已开好时的当轮补充约束（只在带上 browserOpened 的那一轮出现）
      const browserContext = openedUrl
        ? `（本轮补充：用户要开网页，工作台浏览器卡片已经打开并加载 ${openedUrl}${
            openedHost ? `（站点：${openedHost}）` : ''
          }，就在这句下面的聊天里。
网页已经开好了，**不要再让用户点确认、不要再说「确认后我开始操作」**，直接用一句话说明你已经打开了这个网页。
**这一轮你只操作这一张页（${openedHost || openedUrl}）**：说「当前页面」时必须说对站点名，
不要提历史里出现过的别的站点（那些和这一轮无关）。
${
  state.already_told_user_login_themselves
    ? '登录提醒本会话已经说过，这一轮**不要再提**「密码/验证码自己在卡片里输」「我不代填」这类话。'
    : '提醒他可以直接在卡片里点、可以直接把验证码/密码打在网页自己的输入框里（你不会代填、也不会留存）。'
}
如果他还交代了具体要做的事，说你会在卡片里接着做，不要谎称已经做完。）`
        : '';

      /**
       * 第 16 步验收第 ④ 条（登录提醒最多一次）：模型会**照抄自己历史里的安全提醒**——
       * 光在状态块里写一句「已经提醒过」压不住。这里把这条硬性要求放到**系统提示词最末**，
       * 紧贴用户消息，利用近因位置把它按住。
       */
      const loginTail = state.already_told_user_login_themselves
        ? '（本轮硬性要求：本会话你已经提醒过用户「自己在网页卡片里输账号密码验证码」了，所以这一轮' +
          '**不要再写**这类安全提示，也不要写「我不代填 / 我不留存 / 不索要密码」。' +
          '要区分两件事：说「你还得先登录」是可以的（这是任务状态，不是安全提示）；' +
          '说「账号、密码、验证码你自己输，我不代填」就不行——这句本会话已经说过了。' +
          '历史里你之前的同类提醒是旧话，不要照抄。）'
        : '';

      /**
       * 第 16 步 · 系统提示词拼装顺序（顺序本身也是规矩）：
       *   ① 首句（小助 / 某个智能体）
       *   ② 人设块（第 15 步，**在前**）
       *   ③ 基座（所有 Agent 共用，**在后**并写明「人设只能追加、不能削弱基座」）
       *   ④ 本会话状态（current_task / browser_confirmed / keepalive…）
       *   ⑤ 参考信息（记忆/档案/资料，全部标明可被当前指令覆盖）
       * 这样人设与长期记忆都压不住基座，也不会把第 13 步打回「确认后我开始操作」。
       */
      /**
       * 第 16 步 fixup（验收第 ② 条）：本轮只要 current_task 被换掉，就在状态块里明说
       * 「旧目标作废」——模型最爱在这种情况下把旧任务搬回来，让用户在新旧目标之间二选一
       * （实测：「请问你现在想让我做什么：继续在 YouTube 上操作，还是去抖店看订单数据？」）。
       * task_switched 由 applyUserMessage 算好（不落库）。
       */
      const systemParts = [
        systemPromptHead(agentCtx.agentName),
        agentCtx.personaBlock,
        BASE_OVERRIDE_NOTE,
        BASE_SYSTEM_PROMPT,
        /**
         * 第 26 步：回答语言规则。
         *
         * 原则是「**AI 回答的语言跟随系统当前的语言设置**」，不是跟随提问语言、
         * 更不是跟随联网搜回来的资料语言 —— 所以查回一堆英文资料也照样用中文答，
         * 不需要为"搜索翻译"另写任何规则。
         *
         * 语言来源只有 `language.ts` 一处（现在恒为 zh-CN）；以后加语言切换时
         * 只改那一个函数，这里与其它调用方都不用动。
         */
        replyLanguageRule(),
        /**
         * 第 26 步：本轮手边有什么（只有搜索工具、没有开页能力）。
         *
         * ★ **只在"这一轮桌面没报网页已开好"时注入**：
         *   「打开百度」这类**纯开页**指令会走聊天路径并带上 `browserOpened`（桌面确实开好页了），
         *   那一轮基座要求"直接说已经打开"，与这里的"不许说已打开"是矛盾的，
         *   所以那一轮**不注入**本块（见 `searchPolicyForTurn` 的注释）。
         */
        searchPolicyForTurn({ pageOpenedThisTurn: Boolean(openedUrl) }),
        sessionStateBlock(state),
        userMemoryBlockRaw,
        agentCtx.projectMemoryBlock,
        memBlock,
        knowledgeBlock,
        browserContext,
        loginTail,
      ].filter((x) => x && x.trim());

      /**
       * 2) 起「搜索感知」的一轮：**模型自己决定**要不要联网查资料。
       *
       * 第 26 步：这里唯一的工具是 `web_search`（轻量、无界面、不启动浏览器）；
       * 浏览器那套工具**不在这条路上**（它只在 taskMode 的工具循环里给），
       * 所以闲聊轮在能力上就不可能开页 —— 这一点与第 21 步的设计一致，没有被改动。
       *
       * 本地**不做任何关键词判定**：模型说查就查、说不查就不查。
       * 不搜索的那一轮只发一次模型请求（和原来完全一样）；只有模型真要查资料时才多一轮。
       *
       * 第一轮请求在 streamChatWithSearch 内部发起，**上游确认可用之前不开 SSE** ——
       * 所以「连不上 / 上游 HTTP 非 2xx」照旧是普通 JSON 错误（与第 6 步行为一致）。
       */
      const ac = new AbortController();
      const deadline = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
      const onClose = (): void => ac.abort(); // 桌面关了窗口/按停：上游掐掉，半截不落库

      let sseResRef: ServerResponse | null = null;
      /**
       * 读 SSE 响应对象。
       *
       * 为什么要包一层函数：它只在 `openSse` 这个闭包里被赋值，
       * TS 的控制流分析看不到闭包里的赋值 ⇒ 直接读 `sseResRef` 会被收窄成 `null`，
       * 后面 `res.end()` 就报「Property 'end' does not exist on type 'never'」。
       * 过一次函数调用就能拿到声明的真实类型（这是编译期的写法问题，不是运行时逻辑）。
       */
      const getSseRes = (): ServerResponse | null => sseResRef;
      /** 上游第一次确认可用时劫持连接、写 SSE 头与 meta（只做一次） */
      const openSse = (): void => {
        if (sseResRef) return;
        reply.hijack();
        sseResRef = reply.raw;
        const r = sseResRef;
        r.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          'access-control-allow-origin': req.headers.origin ?? '*',
        });
        sse(r, 'meta', { conversationId: convId, userMessageId, agentId: agentCtx.agentId });
        req.raw.on('close', onClose);
      };

      let full = '';
      let searches: SearchTrace[] = [];
      let upstreamDone = false;
      try {
        const out = await streamChatWithSearch(
          env,
          [
            { role: 'system', content: systemParts.join('\n\n') },
            ...history,
            { role: 'user', content: message },
          ],
          {
            tag: 'chat/stream',
            signal: ac.signal,
            onUpstreamReady: openSse,
            onDelta: (d) => {
              const r = getSseRes();
              if (r) sse(r, null, { delta: d });
            },
            /** 第 26 步：搜索状态单独推一条事件 —— 桌面拿它显示「正在搜索：xxx」 */
            onSearch: (e) => {
              const r = getSseRes();
              if (r) sse(r, 'search', e);
            },
            /** 已经开流之后的错误（开流前的错误走下面的 catch，回 JSON） */
            onError: (m) => {
              const r = getSseRes();
              if (r) sse(r, 'error', { error: m });
            },
          },
        );
        full = out.text;
        searches = out.searches;
        upstreamDone = out.upstreamDone;
      } catch (err) {
        clearTimeout(deadline);
        req.raw.removeListener('close', onClose);
        const msg = (err as Error).message || '未知错误';
        const r0 = getSseRes();
        if (r0) {
          // 已经开流了，只能走 SSE 错误
          try {
            sse(r0, 'error', { error: `模型连接中断：${msg}；回复未完成，没有存入历史` });
            r0.end();
          } catch {
            /* 客户端早走了 */
          }
          return;
        }
        if (err instanceof UpstreamHttpError) {
          console.error('[chat] 上游 HTTP', err.status, err.brief); // 上游 body 不含我们的 key；也只截 200 字
          return errJson(reply, 502, `模型服务返回 HTTP ${err.status}：${err.brief || '（无详情）'}`);
        }
        return errJson(reply, 502, `模型服务连不上：${msg}（检查 DEEPSEEK_BASE_URL / 网络）`);
      }

      const streamRes = getSseRes();
      if (!upstreamDone || !streamRes) {
        // 半截不算成功（错误已经由 onError 推给桌面）：**不落库**
        clearTimeout(deadline);
        req.raw.removeListener('close', onClose);
        try {
          streamRes?.end();
        } catch {
          /* 客户端早走了 */
        }
        return;
      }

      // 3) 助手全文完成才落库；再回 done
      try {
        /**
         * 第 26 步：本轮命中的网页来源（按网址去重、最多 8 条）。
         * 没搜过就是空数组 —— 落库存 NULL，界面上就不渲染"来源"这一块。
         *
         * ★ 落库是**必须**的：桌面流式结束后是本地追加消息、切会话才重拉 /chat/history。
         *   不落库的话，来源标注一切走会话就没了（只有刚答完那一刻能看到）。
         */
        const sources = collectSources(searches);
        const am = await pool.query<{ id: string }>(
          "INSERT INTO messages (conversation_id, role, content_enc, sources) VALUES ($1, 'assistant', $2, $3) RETURNING id",
          [convId, cipher.encryptText(full), sources.length > 0 ? JSON.stringify(sources) : null],
        );
        // 第 16 步：这轮是在让用户自己去网页里登录 → 记「已提醒过」，之后不再重复长篇提醒。
        await noteLoginReminder(pool, convId, full).catch(() => undefined);
        if (searches.length > 0) {
          console.log(
            `[chat] 本轮联网搜索 ${searches.length} 次：` +
              searches.map((s) => `${s.error === 'blocked_sensitive' ? '[已拦截·敏感查询]' : s.query.slice(0, 60)}(${s.results}条${s.error ? `/${s.error}` : ''})`).join('、') +
              `；来源 ${sources.length} 个`,
          );
        }
        sse(streamRes, 'done', {
          conversationId: convId,
          messageId: Number(am.rows[0].id),
          contentLength: full.length,
          searches: searches.length,
          /** 界面拿它渲染气泡下方的可点来源；空数组 = 这条没搜过 */
          sources,
        });
      } catch (err) {
        sse(streamRes, 'error', { error: `回复完成但入库失败：${(err as Error).message}` });
      } finally {
        clearTimeout(deadline);
        req.raw.removeListener('close', onClose);
        streamRes.end();
      }
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // ------------------------------------------------------------------ 历史
  app.get('/chat/history', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期（历史需要第 5 步的 JWT）');
    const q = req.query as { conversationId?: unknown; agentId?: unknown } | null;
    let conversationId: number | null = null;
    if (q?.conversationId !== undefined && q?.conversationId !== '') {
      const n = Number(q.conversationId);
      if (!Number.isInteger(n) || n <= 0) return errJson(reply, 400, 'conversationId 要是正整数');
      conversationId = n;
    }
    // 第 15 步：切智能体时按 agentId 拉「它自己那条会话」的历史——不会串到别的智能体
    let agentId: number | null = null;
    if (q?.agentId !== undefined && q?.agentId !== '') {
      const n = Number(q.agentId);
      if (!Number.isInteger(n) || n <= 0) return errJson(reply, 400, 'agentId 要是正整数');
      agentId = n;
    }
    try {
      const conv = await resolveConversation(pool, claims.sub, conversationId, '', agentId);
      if ('err' in conv) {
        // 历史接口对「一条会话都没有」宽容返回空，其余错误照报
        if (conversationId === null) {
          const empty: ChatHistoryResult = { conversationId: null, messages: [] };
          return empty;
        }
        return errJson(reply, conv.status, conv.err);
      }
      /**
       * 第 19 步 fixup：这里原来是 `ORDER BY id ASC LIMIT 200` —— 那是**最老**的 200 条。
       * 会话一旦超过 200 条，刷新/重启后桌面只能看到开头的旧消息，中间整段（包括刚刚
       * 那条带来源的回答）在 DOM 里根本不存在，看起来像「聊天记录丢了 / 知识库来源没生效」。
       * 桌面的诉求是「刷新后还原最近聊的」，所以取**最新** 200 条，再按 id 升序回给前端
       * （前端按数组顺序渲染，顺序不能反）。
       */
      const rows = await pool.query<{
        id: string;
        role: string;
        content_enc: string;
        created_at: string;
        sources: ChatSource[] | null;
      }>(
        `SELECT id, role, content_enc, created_at, sources FROM (
           SELECT id, role, content_enc, created_at, sources FROM messages
           WHERE conversation_id = $1 ORDER BY id DESC LIMIT 200
         ) AS recent ORDER BY id ASC`,
        [conv.id],
      );
      const out: ChatHistoryResult = {
        conversationId: conv.id,
        messages: rows.rows.map((r) => ({
          id: Number(r.id),
          role: r.role === 'assistant' ? 'assistant' : 'user',
          text: safeDecrypt(cipher, r.content_enc),
          /**
           * 第 26 步：来源标注要**能活过刷新和切会话**。
           * JSONB 由 pg 直接反序列化成对象数组；NULL / 非数组（脏数据）一律当"没有来源"。
           */
          sources: Array.isArray(r.sources) ? r.sources : undefined,
          created_at: r.created_at,
        })) satisfies ChatRow[],
      };
      return out;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // ------------------------------------------- 第 16 步：会话状态（读 / 保活开关）
  /**
   * 桌面重启后靠它恢复：当前任务目标、本会话是否已确认过浏览器、是否在监听。
   * 只认自己的会话（走 projects.user_id），别人的号当不存在。
   */
  app.get('/chat/state', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期（会话状态需要第 5 步的 JWT）');
    const q = req.query as { conversationId?: unknown; agentId?: unknown } | null;
    const convIdRaw = Number(q?.conversationId);
    const agentIdRaw = Number(q?.agentId);
    const hasConvId = Number.isInteger(convIdRaw) && convIdRaw > 0;
    const hasAgentId = Number.isInteger(agentIdRaw) && agentIdRaw > 0;
    /**
     * 一个 id 都没带就**直接回空**，不往下走 resolveConversation：
     * 那条兜底分支在账号还没有会话时会 INSERT 一条（GET 产生写副作用，不能接受）。
     * 桌面的 loadAgentState 永远带 agentId，所以这里只是堵住口子。
     */
    if (!hasConvId && !hasAgentId) return { conversationId: null, state: null } satisfies ChatStateResult;
    try {
      const conv = await resolveConversation(
        pool,
        claims.sub,
        hasConvId ? convIdRaw : null,
        '',
        hasAgentId ? agentIdRaw : null,
      );
      if ('err' in conv) return errJson(reply, conv.status, conv.err);
      const base = await loadConversationState(pool, conv.id);
      /**
       * 子阶段 A（读侧改动点）：桌面的「当前任务 / 最后一页」那一行读的就是这个接口。
       * 任务轮不再把任务态写进 conversations 了，所以这里在**会话级为空**时，
       * 用该智能体名下**最近被碰过的那张页**的分片状态补上 —— 显示不断档，
       * 也**不会**用页级去盖会话级已有的值（闲聊轮写进去的东西照旧优先）。
       */
      const state = await mergeLatestPageState(pool, conv.id, base);
      return { conversationId: conv.id, state } satisfies ChatStateResult;
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  /**
   * 「启动并保活」：把该智能体的会话标记为监听态。
   * 保活**不等于**会一直调模型——空闲时服务端一次 LLM 都不调（看 /health 的 llmCalls），
   * 有新消息才走本文件的 /chat/stream。也不起新进程、不开新窗口、不做计费看板。
   */
  app.post('/chat/state', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = (req.body ?? {}) as { agentId?: unknown; conversationId?: unknown; keepalive?: unknown };
    const agentIdRaw = Number(b.agentId);
    const convIdRaw = Number(b.conversationId);
    if (typeof b.keepalive !== 'boolean') return errJson(reply, 400, 'keepalive 要是 true/false');
    try {
      const conv = await resolveConversation(
        pool,
        claims.sub,
        Number.isInteger(convIdRaw) && convIdRaw > 0 ? convIdRaw : null,
        '',
        Number.isInteger(agentIdRaw) && agentIdRaw > 0 ? agentIdRaw : null,
      );
      if ('err' in conv) return errJson(reply, conv.status, conv.err);
      const state = await setKeepalive(pool, conv.id, b.keepalive);
      return { conversationId: conv.id, state } satisfies ChatStateResult;
    } catch (err) {
      return dbErr(reply, err);
    }
  });
}
