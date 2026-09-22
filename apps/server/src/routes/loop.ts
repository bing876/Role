/**
 * 第 21 步 · 工具循环的 HTTP 面（脑在服务端，手在桌面）。
 *
 *   POST /agent/loop/start  要 JWT。{agentId, goal, pageUrl?, wcId?, conversationId?}
 *        → 建一个循环（消息历史、工具表、步数上限都在服务端），回 {loopId, maxSteps, step}
 *   POST /agent/loop/next   要 JWT。{loopId, agentId?, wcId?, result?}
 *        → 喂回上一个工具的回执（第一次不带），回下一格决策：
 *          {kind:'tool'} 给一个工具 → 桌面在**这张页**上执行
 *          {kind:'ask'}  停下来问用户（原因 + 一个下一步）
 *          {kind:'done'} 收尾（结论/提纲给任务文档用）
 *          {kind:'say'}  模型只是说话，循环停住等新指令
 *          {kind:'stopped'} 已被叫停
 *   POST /agent/loop/stop   要 JWT。{loopId} 或 {wcId}
 *        → 用户喊「停」/ 桌面放下某一路时调；之后这一路再也不调模型。
 *
 * 不串 bot：循环里记着 agentId 与 wcId，`next` 每次都要对上 —— 对不上直接 409，
 * 绝不让 A 智能体的循环把动作打到 B 智能体那张页上。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type {
  AgentLoopDecision,
  AgentLoopInfoResult,
  AgentLoopStartResult,
  LoopToolResult,
  PageSnapshot,
  TaskPauseRecord,
} from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable } from '../db';
import { listPageStates, loadPageState } from '../pageState';
import { loadConversationState } from '../sessionState';
import {
  advance,
  getLoop,
  hasLoop,
  isLoopPaused,
  liveLoopCount,
  runningLoopCount,
  LoopBusyError,
  pauseLoop,
  resumeLoop,
  startLoop,
  stopLoop,
  stopLoopsOfPage,
  stopLoopsOfUser,
  injectUserMessage,
  type LoopStateBrief,
} from '../toolLoop';
import { broadcastLoopEvent, endLoopSse } from '../loopSse';

export interface LoopDeps {
  pool: Pool;
  env: ServerEnv;
  cipher: JsonCipher;
}

function errJson(reply: FastifyReply, code: number, error: string, extra?: Record<string, unknown>): FastifyReply {
  return reply.code(code).send({ error, ...extra });
}

function dbErr(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) {
    return errJson(reply, 503, '数据库连不上：先 npm run db:up（或 docker compose -f apps/server/docker-compose.yml up -d）');
  }
  console.error('[loop] 未分类错误：', (err as Error)?.message ?? String(err));
  return errJson(reply, 500, `服务端错误：${(err as Error)?.message ?? String(err)}`);
}

function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

/** 智能体归属校验：只认自己项目下的智能体（别人的号当不存在） */
async function ownsAgent(pool: Pool, userId: number, agentId: number): Promise<boolean> {
  const r = await pool.query<{ id: string }>(
    'SELECT a.id FROM agents a JOIN projects p ON p.id = a.project_id WHERE a.id = $1 AND p.user_id = $2',
    [agentId, userId],
  );
  return r.rowCount === 1;
}

export function registerLoopRoutes(app: FastifyInstance, { pool, env }: LoopDeps): void {
  app.post('/agent/loop/start', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期（工具循环需要第 5 步的 JWT）');
    if (!env.deepseekApiKey) {
      return errJson(reply, 503, '未配置模型：在 apps/server/.env 填 DEEPSEEK_API_KEY 后重启 npm run dev:server', {
        code: 'llm_not_configured',
      });
    }
    const b = req.body as
      | { agentId?: unknown; goal?: unknown; pageUrl?: unknown; wcId?: unknown; conversationId?: unknown }
      | null;
    const goal = typeof b?.goal === 'string' ? b.goal.trim().slice(0, 500) : '';
    if (!goal) return errJson(reply, 400, 'goal 不能为空（先告诉我要完成什么）');
    const agentIdRaw = Number(b?.agentId);
    const agentId = Number.isInteger(agentIdRaw) && agentIdRaw > 0 ? agentIdRaw : null;
    if (agentId !== null) {
      try {
        if (!(await ownsAgent(pool, claims.sub, agentId))) return errJson(reply, 404, '智能体不存在或不是你的');
      } catch (err) {
        return dbErr(reply, err);
      }
    }
    const wcIdRaw = Number(b?.wcId);
    const wcId = Number.isInteger(wcIdRaw) && wcIdRaw > 0 ? wcIdRaw : null;
    const convIdRaw = Number(b?.conversationId);
    const conversationId = Number.isInteger(convIdRaw) && convIdRaw > 0 ? convIdRaw : null;

    // 会话状态（第 16 步那一份，循环与聊天共用；空会话就传 null）
    let state: LoopStateBrief | null = null;
    if (conversationId !== null) {
      try {
        const s = await loadConversationState(pool, conversationId);
        state = {
          current_task: s.current_task,
          browser_confirmed: s.browser_confirmed,
          login_required: s.login_required,
          already_told_user_login_themselves: s.already_told_user_login_themselves,
          last_page_summary: s.last_page_summary,
        };
      } catch (err) {
        return dbErr(reply, err);
      }
    }

    const session = startLoop(env, {
      userId: claims.sub,
      agentId,
      conversationId,
      wcId,
      goal,
      pageUrl: typeof b?.pageUrl === 'string' ? b.pageUrl.trim().slice(0, 500) : '',
      state,
    });
    console.log(
      `[loop] 新循环 ${session.id}（智能体 ${agentId ?? '-'}，页 ${wcId ?? '-'}，上限 ${session.maxSteps} 步）：${goal.slice(0, 40)}`,
    );
    return {
      loopId: session.id,
      agentId: session.agentId,
      maxSteps: session.maxSteps,
      step: session.step,
    } satisfies AgentLoopStartResult;
  });

  app.post('/agent/loop/next', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = req.body as { loopId?: unknown; agentId?: unknown; wcId?: unknown; result?: unknown } | null;
    const loopId = typeof b?.loopId === 'string' ? b.loopId.trim() : '';
    if (!loopId) return errJson(reply, 400, 'loopId 必填');
    const session = getLoop(loopId);
    if (!session) return errJson(reply, 404, '这个循环不存在或已过期（重新下指令即可）');
    if (session.userId !== claims.sub) return errJson(reply, 404, '这个循环不存在或不是你的');

    /**
     * 不串 bot 的硬闸：智能体 / 那张页都必须和建循环时一致。
     * 桌面两路并行（两个智能体各一张页）时，这一条挡住「A 的循环点到 B 的页上」。
     *
     * ⚠️ 写法上有一个**必须守住**的坑（改这里前先读完）：
     *   早先的写法是 `Number.isInteger(x) && x !== session.x` —— 看着更严谨，
     *   实际上**不传参数就整条校验被短路掉了**：`Number(undefined)` = NaN，
     *   `Number.isInteger(NaN)` = false，`false && ...` 直接跳过后面的比较。
     *   于是"我不传 agentId"比"我传错 agentId"更容易通过，闸门形同虚设。
     *
     *   现在按「**会话有约束 ⇒ 调用方必须自证相符**」来写：
     *     ① 建循环时没记 agentId/wcId（`session.x === null`）→ 无可比对，放行；
     *     ② 记了 → 调用方必须传一个**有效的正整数**，且**必须相等**。
     *        `NaN !== 7` 天然为真，所以"不传 / 传 null / 传字符串 / 传小数"一律落进 409，
     *        不再需要 `Number.isInteger` 当前置条件（它的位置错了）。
     */
    const agentIdRaw = Number(b?.agentId);
    if (session.agentId !== null && agentIdRaw !== session.agentId) {
      return errJson(
        reply,
        409,
        `这个循环属于智能体 ${session.agentId}，不是 ${Number.isFinite(agentIdRaw) ? agentIdRaw : '（没传/非法）'}——没有执行任何动作。`,
        { code: 'agent_mismatch' },
      );
    }
    const wcIdRaw = Number(b?.wcId);
    if (session.wcId !== null && wcIdRaw !== session.wcId) {
      return errJson(reply, 409, '这个循环只操作它自己那张页，别的页我不碰——没有执行任何动作。', {
        code: 'page_mismatch',
      });
    }

    const raw = b?.result as Partial<LoopToolResult> | undefined;
    const result: LoopToolResult | null = raw
      ? {
          ok: Boolean(raw.ok),
          detail: typeof raw.detail === 'string' ? raw.detail.slice(0, 500) : undefined,
          error: typeof raw.error === 'string' ? raw.error.slice(0, 500) : undefined,
          noChange: Boolean(raw.noChange),
          refused: typeof raw.refused === 'string' ? raw.refused.slice(0, 300) : undefined,
          userAnswer: typeof raw.userAnswer === 'string' ? raw.userAnswer.slice(0, 300) : undefined,
          page: raw.page && typeof raw.page === 'object' ? raw.page : undefined,
        }
      : null;

    try {
      if (result) {
        if (result.ok) {
          broadcastLoopEvent(loopId, 'note', { level: 'info', text: `步骤已执行完成${result.detail ? `：${result.detail}` : ''}` });
        } else {
          broadcastLoopEvent(loopId, 'note', { level: 'warn', text: `上一步未达成预期${result.error ? `：${result.error}` : ''}` });
        }
      }

      const decision: AgentLoopDecision = await advance(env, session, result);

      // 实时向 SSE 长连接推送 AI 步骤与人话进展
      if (decision.kind === 'tool') {
        const desc = formatToolDesc(decision.call);
        broadcastLoopEvent(loopId, 'step', { step: session.step + 1, call: decision.call, description: desc });
        broadcastLoopEvent(loopId, null, { delta: `\n\n**步骤 ${session.step + 1}**：${desc}` });
      } else if (decision.kind === 'done') {
        broadcastLoopEvent(loopId, 'step', { step: session.step, phase: 'done', summary: decision.summary });
        broadcastLoopEvent(loopId, null, { delta: `\n\n🎉 **任务完成**\n${decision.summary || ''}` });
        endLoopSse(loopId, { conversationId: session.conversationId, done: true });
      } else if (decision.kind === 'ask') {
        broadcastLoopEvent(loopId, 'ask', { reason: decision.reason, question: decision.question, step: session.step });
        broadcastLoopEvent(loopId, null, { delta: `\n\n⚠️ **需要协助**：${decision.question}` });
      } else if (decision.kind === 'say') {
        broadcastLoopEvent(loopId, null, { delta: `\n\n${decision.text}` });
      } else if (decision.kind === 'stopped') {
        broadcastLoopEvent(loopId, 'stopped', { reason: decision.reason });
        endLoopSse(loopId, { stopped: true });
      }

      return { decision };
    } catch (err) {
      /**
       * 子阶段 A：同一条循环被并发推进 → **409**，把「被拒了、什么都没发生」说清楚。
       * 这不是服务端故障，是调用方重试/双发，所以不能混进 500。
       */
      if (err instanceof LoopBusyError) {
        return errJson(reply, 409, err.message, { code: err.code, loopId: err.loopId });
      }
      console.error('[loop] 推进失败：', (err as Error)?.message ?? String(err));
      return errJson(reply, 500, `推进循环失败：${(err as Error)?.message ?? String(err)}`);
    }
  });

  app.post('/agent/loop/stop', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = req.body as { loopId?: unknown; wcId?: unknown; reason?: unknown } | null;
    const reason = typeof b?.reason === 'string' ? b.reason.slice(0, 60) : 'user_stop';
    const loopId = typeof b?.loopId === 'string' ? b.loopId.trim() : '';
    if (loopId) {
      const session = getLoop(loopId);
      if (session && session.userId !== claims.sub) return errJson(reply, 404, '这个循环不存在或不是你的');
      endLoopSse(loopId, { stopped: true, reason });
      const ok = stopLoop(loopId, reason);
      return { ok, stopped: ok ? 1 : 0, live: liveLoopCount() };
    }
    const wcIdRaw = Number(b?.wcId);
    if (Number.isInteger(wcIdRaw)) {
      const n = stopLoopsOfPage(claims.sub, wcIdRaw);
      return { ok: true, stopped: n, live: liveLoopCount() };
    }
    // 都不带 = 全停（登出 / 全局停止）
    const n = stopLoopsOfUser(claims.sub);
    return { ok: true, stopped: n, live: liveLoopCount() };
  });

  app.post('/agent/loop/note', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录');
    const b = req.body as { loopId?: unknown; level?: unknown; text?: unknown } | null;
    const loopId = typeof b?.loopId === 'string' ? b.loopId.trim() : '';
    const text = typeof b?.text === 'string' ? b.text.trim() : '';
    if (loopId && text) {
      broadcastLoopEvent(loopId, 'note', { level: b?.level || 'info', text });
      broadcastLoopEvent(loopId, null, { delta: `\n> ℹ️ ${text}` });
    }
    return { ok: true };
  });

  /**
   * POST /agent/loop/message —— 任务执行中注入补充指令/追问。
   * 不打断当前 Agent Loop，而是将上下文动态注入消息历史，供下一步规划决策。
   */
  app.post('/agent/loop/message', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录');
    const b = req.body as { loopId?: unknown; message?: unknown } | null;
    const loopId = typeof b?.loopId === 'string' ? b.loopId.trim() : '';
    const message = typeof b?.message === 'string' ? b.message.trim() : '';
    if (!loopId || !message) return errJson(reply, 400, 'loopId 和 message 必填');
    const session = getLoop(loopId);
    if (!session) return errJson(reply, 404, '任务循环不存在或已结束');
    if (session.userId !== claims.sub) return errJson(reply, 403, '无权操作该循环');
    injectUserMessage(session, message);
    broadcastLoopEvent(loopId, 'note', { level: 'info', text: `已将补充指令追加至任务上下文：${message}` });
    broadcastLoopEvent(loopId, null, { delta: `\n\n💬 **用户补充指令**：${message}` });
    return { ok: true, queued: true };
  });

  // -------------------------------------------------------------------------
  // 阶段简报 · 方案 B：暂停（挂起）→ 重新感知 → 继续
  //
  // 三个接口，形状与既有的 /agent/loop/start|next|stop 保持一致（JWT、loopId、
  // 归属校验都复用同一套），所以正式 UI 与临时测试按钮走的是同一条路。
  // -------------------------------------------------------------------------

  /**
   * POST /agent/loop/pause —— **挂起**这一路（不是终止）。
   *
   * 与 `/agent/loop/stop` 的区别必须说清楚，否则调用方会选错：
   *   - stop = 「不干了」：循环进终态，再 next 永远回 stopped，继续不了；
   *   - pause = 「先歇一下」：消息历史/步数/目标/暂停前快照全留着，调 resume 就能原地继续。
   *
   * `pausedBy` 本次只接受调用方显式传值（默认 'user'）；将来人工介入卡片
   * 触发暂停时传 'system' / 'guard:*' 即可，本接口与表结构都不用改。
   */
  app.post('/agent/loop/pause', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = req.body as { loopId?: unknown; pausedBy?: unknown; page?: unknown } | null;
    const loopId = typeof b?.loopId === 'string' ? b.loopId.trim() : '';
    if (!loopId) return errJson(reply, 400, 'loopId 必填');
    const session = getLoop(loopId);
    if (!session) return errJson(reply, 404, '这个循环不存在或已过期');
    if (session.userId !== claims.sub) return errJson(reply, 404, '这个循环不存在或不是你的');

    const by = typeof b?.pausedBy === 'string' && b.pausedBy.trim() ? b.pausedBy.trim().slice(0, 40) : 'user';
    // `page` = 桌面端在**暂停那一刻**真读到的当前页，用它当变化判定的基线
    //（没有就用循环里的旧快照，行为跟以前一样）。
    const page = b?.page && typeof b.page === 'object' ? (b.page as PageSnapshot) : null;
    const pause = pauseLoop(loopId, { by, page });
    if (!pause) {
      // 终态循环不接受挂起（它已经没法「继续」了）——明确说出来，别静默成功
      return errJson(reply, 409, `这个循环已经处于 ${session.status}（终态），不能再挂起。要重新开始请新建循环。`, {
        code: 'loop_settled',
      });
    }

    // 落库（best-effort：库挂了不该拦住暂停本身，内存里那份已经生效了）
    let recordId: number | null = null;
    try {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO task_pauses (user_id, loop_id, agent_id, wc_id, goal, paused_by, paused_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [claims.sub, loopId, session.agentId, session.wcId, session.goal, by],
      );
      recordId = r.rows[0] ? Number(r.rows[0].id) : null;
    } catch (err) {
      console.error('[loop] 暂停记录落库失败（不影响挂起本身）：', (err as Error)?.message ?? String(err));
    }
    console.log(
      `[loop] 暂停 ${loopId}（by=${by}，页 ${session.wcId ?? '-'}，记录 ${recordId ?? '未落库'}）` +
        `—— 消息历史保留 ${session.messages.length} 条 / 已走 ${session.step} 步`,
    );
    return {
      ok: true,
      loopId,
      paused: true,
      pausedAt: pause.at,
      pausedBy: pause.by,
      recordId,
      live: liveLoopCount(),
    };
  });

  /**
   * POST /agent/loop/resume —— **解除挂起**并做一次重新感知。
   *
   * `page` 是调用方在「继续」时**先 read_page 拿到的当前真实页面**。
   * 带上它，服务端才能回答「用户在我暂停期间动没动这个页面」；
   * 不带也能继续，但 delta 会如实判成 unknown。
   */
  app.post('/agent/loop/resume', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = req.body as { loopId?: unknown; page?: unknown } | null;
    const loopId = typeof b?.loopId === 'string' ? b.loopId.trim() : '';
    if (!loopId) return errJson(reply, 400, 'loopId 必填');
    const session = getLoop(loopId);
    /**
     * ★ P0 止血（2026-09-21）：这两处 404 必须带一个**可区分的语义码**。
     *
     * 桌面端以前是笼统 `catch`，于是「网络抖一下 / 服务端忙一下」也会弹
     * 「上下文没了，要重新开始吗」。那种误报的代价不是多打扰一次，而是
     * 用户会被训练成不看内容就点「重新开始」—— 等真丢了历史的那次，安全网也失效了。
     *
     * 所以只有 `code: 'loop_gone'`（= 确实找不到这条循环：过期被回收 / 服务端重启过）
     * 才允许桌面端弹「要重新开始吗」；其它失败一律走「暂时接不上，稍后再试」。
     *
     * 注意下面那条 `userId` 不匹配的 404 **不带**这个码 —— 那不是"过期"，
     * 是"这不是你的循环"，不该引导用户去重新开始。
     */
    if (!session) return errJson(reply, 404, '这个循环不存在或已过期', { code: 'loop_gone' });
    if (session.userId !== claims.sub) return errJson(reply, 404, '这个循环不存在或不是你的');

    const page = b?.page && typeof b.page === 'object' ? (b.page as PageSnapshot) : null;
    const r = resumeLoop(loopId, page);
    if (!r) return errJson(reply, 404, '这个循环不存在或已过期', { code: 'loop_gone' });

    // 闭合库里那条「未解除」的挂起记录（顺带把判定结果写进去当取证）
    try {
      await pool.query(
        `UPDATE task_pauses SET resumed_at = now(), delta_kind = $3
          WHERE loop_id = $1 AND user_id = $2 AND resumed_at IS NULL`,
        [loopId, claims.sub, r.delta.kind],
      );
    } catch (err) {
      console.error('[loop] 闭合暂停记录失败（不影响恢复本身）：', (err as Error)?.message ?? String(err));
    }
    console.log(
      `[loop] 继续 ${loopId}（resumed=${r.resumed}，delta=${r.delta.kind}，` +
        `url变=${r.delta.urlChanged} 标题变=${r.delta.titleChanged}）`,
    );
    return {
      ok: true,
      loopId,
      resumed: r.resumed,
      delta: r.delta,
      live: liveLoopCount(),
    };
  });

  /**
   * GET /agent/loop/pauses —— 暂停记录（**重启后恢复显示**的读口 + 验收取证口）。
   *
   *   ?loopId=xxx → 那一条循环的所有暂停记录
   *   ?open=1     → 只看「还没解除」的那几条（应用重启后 UI 靠它还原「哪几路是暂停中」）
   *   不带参数     → 自己名下最近 50 条
   */
  app.get('/agent/loop/pauses', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const q = req.query as { loopId?: unknown; open?: unknown } | null;
    const loopId = typeof q?.loopId === 'string' && q.loopId.trim() ? q.loopId.trim() : null;
    const openOnly = q?.open === '1' || q?.open === 'true';
    try {
      const where: string[] = ['user_id = $1'];
      const args: unknown[] = [claims.sub];
      if (loopId) {
        args.push(loopId);
        where.push(`loop_id = $${args.length}`);
      }
      if (openOnly) where.push('resumed_at IS NULL');
      const r = await pool.query<{
        id: string;
        loop_id: string;
        agent_id: string | null;
        wc_id: string | null;
        goal: string | null;
        paused_by: string;
        paused_at: string;
        resumed_at: string | null;
        delta_kind: string | null;
      }>(
        `SELECT id, loop_id, agent_id, wc_id, goal, paused_by, paused_at, resumed_at, delta_kind
           FROM task_pauses
          WHERE ${where.join(' AND ')}
          ORDER BY paused_at DESC
          LIMIT 50`,
        args,
      );
      const records: TaskPauseRecord[] = r.rows.map((x) => ({
        id: Number(x.id),
        loopId: x.loop_id,
        resumed: x.resumed_at !== null,
        pausedBy: x.paused_by,
        pausedAt: new Date(x.paused_at).getTime(),
        resumedAt: x.resumed_at ? new Date(x.resumed_at).getTime() : null,
        agentId: x.agent_id === null ? null : Number(x.agent_id),
        wcId: x.wc_id === null ? null : Number(x.wc_id),
        goal: x.goal ?? undefined,
        deltaKind: x.delta_kind ?? undefined,
        /**
         * ★ 本批次新增的两个字段（回答的是**两个不同的问题**，别只看一个）。
         *
         * `inMemory` —— 「这条循环的会话对象**还在不在服务端内存里**」（字面事实）。
         *   单独给一个字段、不复用 `resumed`，因为两者语义不同、变化时机也不同：
         *     · `resumed`   = 「用户点没点过继续」（历史结论，落库后不该被内存状态改写）；
         *     · `inMemory`  = 「此刻还在不在内存」（实时事实，会随 TTL / 重启自己变）。
         *   服务端重启后，库里两条都长成 `resumed_at IS NULL`，只有本字段能把它们分开。
         *
         * `resumable` —— 「现在点『继续』**还能不能真的接回来**」（能不能用）。
         *
         *   ⚠️ 为什么必须有它、不能拿 `inMemory` 当"能不能继续"用（实测踩出来的）：
         *      `stopLoop()` 只把 `status` 改成 `'stopped'`（终态），
         *      **并不把会话从 `loops` Map 里删掉** —— 它要等 TTL 到期才被 sweep 清走。
         *      所以一条**已经停掉、永远接不回来**的循环，`inMemory` 仍然是 `true`。
         *      回归脚本里就是这么抓到它的：`stop` 之后 `inMemory` 依然为 true。
         *      只看 `inMemory` 的 UI 会给用户一个"点了没反应"的继续按钮。
         *
         *      正确判据 = 在内存里 **且** 处于挂起态：
         *        挂起（paused）= 能继续；停止（stopped）= 终态，接不回来。
         *      这也正是本文件下方回填 `resumed` 用的同一个条件。
         */
        inMemory: hasLoop(x.loop_id),
        resumable: hasLoop(x.loop_id) && isLoopPaused(x.loop_id),
      }));
      /**
       * 顺带回「内存里现在是不是还挂着」—— 库里那条可能因为进程重启而没闭合。
       *
       * ★ 只有「循环**还在内存里**且不是挂起态」才能断定它已经恢复了。
       *   循环不在内存（服务端重启过 / TTL 到期）时必须**维持库里的结论**：
       *   `resumed_at IS NULL` 的真实含义是「用户从没点过继续」，
       *   不能因为内存里查不到就报成「已恢复」—— 那样应用重启后
       *   「哪几路还暂停着」会凭空消失，正是本阶段要避免的事。
       */
      for (const rec of records) {
        if (!rec.resumed && hasLoop(rec.loopId) && !isLoopPaused(rec.loopId)) rec.resumed = true;
      }
      return { count: records.length, records };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  /**
   * ★ GET /agent/loop/info?loopId=xxx —— 这条循环的**权威身份**（agentId / wcId / 状态）。
   *
   * 为什么需要它（这是修 #1 时发现的配套缺口）：
   *   `/agent/loop/next` 的归属硬闸要求调用方**自证** agentId 与建循环时一致。
   *   但循环不一定由桌面主进程创建 —— 渲染层的 `/chat/stream` 任务轮也会建，
   *   那时主进程手里只有一个 `loopId`，**并不知道它属于哪个智能体**，
   *   于是 `agentId` 传成 null → 被硬闸判成"不匹配" → 整条路 `brain_failed`。
   *   （真实回归：暂停/继续验收里三路全挂，见 docs/acceptance/p1-fix。）
   *
   *   硬闸不能因为"调用方不知道"就放行（那就退回成漏洞了），
   *   正确做法是**让它能问到**：主进程在开跑前拿 loopId 换一次权威身份，
   *   之后每一步都原样回传。这样硬闸保持严格，而合法调用方永远拿得到正确的值。
   *
   * 只回**调用方自己的**循环（别人的当不存在，回 404，不泄漏"这个 loopId 存不存在"）。
   */
  app.get('/agent/loop/info', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const q = req.query as { loopId?: unknown } | null;
    const loopId = typeof q?.loopId === 'string' ? q.loopId.trim() : '';
    if (!loopId) return errJson(reply, 400, 'loopId 必填');
    const session = getLoop(loopId);
    if (!session || session.userId !== claims.sub) {
      return errJson(reply, 404, '这个循环不存在或已过期（重新下指令即可）');
    }
    return {
      loopId: session.id,
      agentId: session.agentId,
      wcId: session.wcId,
      status: session.status,
      step: session.step,
      maxSteps: session.maxSteps,
    } satisfies AgentLoopInfoResult;
  });

  /** 诊断用：当前有几路循环活着（不泄漏内容，只看个数） */
  app.get('/agent/loop/live', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    // live = 真在推进的；running = 状态还是 running 的（含挂着没人驱动的）。
    // 差值本身就是排错信号，所以两个都回。
    return { live: liveLoopCount(), running: runningLoopCount() };
  });

  /**
   * 子阶段 A · **按页（wcId）分片的状态读接口**（诊断 / 验收取证用）。
   *
   *   GET /agent/loop/state?wcId=123 → 这一张页自己的状态
   *   GET /agent/loop/state          → 自己名下所有在册的页
   *
   * 只回**调用方自己的**页（条目里记着 userId；别人的页当不存在，回 404）。
   * 为什么要有它：分片状态是不是真的按页分开，必须能**读出来对照**，
   * 光看「两个循环都在跑」证明不了「状态没有互相覆盖」。
   */
  app.get('/agent/loop/state', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const q = req.query as { wcId?: unknown } | null;
    const wcIdRaw = Number(q?.wcId);
    if (Number.isInteger(wcIdRaw)) {
      const st = loadPageState(wcIdRaw);
      if (!st || st.userId !== claims.sub) return errJson(reply, 404, '这张页没有在册的分片状态（或不是你的）');
      return { wcId: wcIdRaw, state: st };
    }
    const mine = listPageStates().filter((x) => x.userId === claims.sub);
    return { count: mine.length, pages: mine };
  });
}

function formatToolDesc(call: { name: string; args?: unknown }): string {
  const args = (call?.args ?? {}) as Record<string, unknown>;
  if (call.name === 'open_url') return `打开网址 ${String(args.url ?? '')}`;
  if (call.name === 'click') return `点击「${String(args.target ?? '')}」`;
  if (call.name === 'type') return `在「${String(args.target ?? '')}」中输入 "${String(args.text ?? '')}"${args.submit ? ' 并回车提交' : ''}`;
  if (call.name === 'read_page') return '查看并分析当前页面内容';
  if (call.name === 'scroll') return `向${args.direction === 'up' ? '上' : '下'}滚动页面`;
  if (call.name === 'stop') return `结束任务：${String(args.conclusion ?? args.reason ?? '')}`;
  return `调用工具 ${call.name}`;
}
