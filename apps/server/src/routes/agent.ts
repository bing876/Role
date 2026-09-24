/**
 * 第 7 步：云端驾驶员的**单步**接口（第 21 步起只是兼容壳）+ 任务记账。
 *
 *   POST /agent/next-action  要 JWT。{taskId?, goal, stepsSummary[], snapshot, paused?}
 *     → 第 21 步：**引擎、工具表、提示词全部复用 toolLoop.ts**（同一份 LOOP_SYSTEM_PROMPT、
 *       同一份 LOOP_TOOLS、同一套参数校验），这里只把「模型选的工具」翻成桌面能执行的
 *       BrowserAction 返回。**不再是第二套话术**——桌面现在走 /agent/loop/*，
 *       这个接口留着是为了不把老路径打断，行为与新循环一致。
 *   POST /agent/task/start  {goal} → tasks 表记一条 running（payload.steps=[]），返回 {taskId}
 *   POST /agent/task/step   {taskId, summary, ok} → 追加一步“人话摘要”（绝不存整页 HTML/快照）
 *   POST /agent/task/status {taskId, status} → running/paused/done/failed
 *   GET  /agent/task/current → 我最近一条任务（桌面刷新后还原任务卡用）
 *
 * 循环本体（消息历史 + 步数上限）在服务端 toolLoop.ts；执行在桌面主进程（现有 driver）。
 * 用户暂停时本地先停手，这里是第二道闸。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AgentActionRequest, AgentActionResponse, PageSnapshot } from '@ai-workbench/shared';
import type { BrowserAction } from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import type { JsonCipher } from '../crypto';
import { bearerFrom, verifyToken } from '../crypto';
import { isDbUnreachable } from '../db';
import { llmFetch } from '../llm';
import { notifyUser } from '../notify';
import { buildMemoryBlock, triggerTaskExtract } from './memories';
import { scrubTaskText, taskDisplayTitle } from '../orchestrator/redact';
import { decideOnce } from '../toolLoop';
import { currentProjectId } from '../projectScope';

export interface AgentDeps {
  pool: Pool;
  env: ServerEnv;
  /** 第 8 步：done 的结果文档要加密进 tasks.result_enc（复用第 5 步 AES-256-GCM） */
  cipher: JsonCipher;
}

/** 第 8 步「任务结束整理」提示词（只在服务端；编造是红线） */
const WRAP_PROMPT = [
  '你是工作台的“任务收尾员”。根据任务目标、步骤摘要和最后看到的页面要点，把已完成任务整理成结果。',
  '只输出一个 JSON：{"summary":"给聊天窗口的短结论（可扫读，不要过程流水账）","document_title":"文档标题","document_markdown":"完整 Markdown：## 目标 / ## 结论 / ## 要点列表 / ## 来源 / ## 没做成的事","unread_hint":"红点旁极短提示，例如：调研结果已生成"}',
  '不要编造没在输入里出现过的数字和原文；找不到就写「未找到」。',
  'document_markdown 里禁止出现手机号、验证码、密码、token、API Key。',
  '来源网址只能引用输入里出现过的 url。',
].join('\n')

function errJson(reply: FastifyReply, code: number, error: string, extra?: Record<string, unknown>): FastifyReply {
  return reply.code(code).send({ error, ...extra });
}

function dbErr(reply: FastifyReply, err: unknown): FastifyReply {
  if (isDbUnreachable(err)) {
    return errJson(reply, 503, '数据库连不上：先 npm run db:up（或 docker compose -f apps/server/docker-compose.yml up -d）');
  }
  console.error('[agent] 未分类错误：', (err as Error)?.message ?? String(err));
  return errJson(reply, 500, `服务端错误：${(err as Error)?.message ?? String(err)}`);
}

function authed(req: FastifyRequest, env: ServerEnv) {
  const token = bearerFrom(req.headers.authorization);
  return token ? verifyToken(token, env.jwtSecret) : null;
}

/** 从模型回复里抠第一个 JSON 对象（容忍 ``` 围栏和前后废话）——第 8 步收尾整理在用 */
function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 任务归属校验：tasks JOIN projects，只认自己的（收尾 6：带上密文目标列 goal_enc） */
async function ownTask(pool: Pool, taskId: number, userId: number) {
  const r = await pool.query<{ id: string; status: string; title: string | null; payload: unknown; unread: boolean; result_enc: string | null; goal_enc: string | null }>(
    'SELECT t.id, t.status, t.title, t.payload, t.unread, t.result_enc, t.goal_enc FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1 AND p.user_id = $2',
    [taskId, userId],
  );
  return r.rowCount === 1 ? r.rows[0] : null;
}

/**
 * 收尾 6 | 读任务目标：**解密优先，回退旧位置**。
 *
 * 库里可能同时存在三种行，都得读出目标（加密不能把功能吃掉 —— 任务文档的「## 目标」、
 * `/agent/task/current` 给桌面还原任务卡、收尾喂给模型的提示词，全都要它）：
 *   1. 新行 / 回填过的老行：`goal_enc` 有值                    → 解密返回；
 *   2. 还没回填的老行：`payload.goal` 是明文                    → 原样返回；
 *   3. 更老的行：只剩 `title`（当年存的是 goal 前 80 字）        → 原样返回。
 *
 * 解密失败（DATA_KEY 换过 / 密文损坏）时不抛，退回 2、3；打警告但**不带任何内容**。
 */
function taskGoalFromRow(
  row: { goal_enc?: string | null; payload?: unknown; title?: string | null },
  c: JsonCipher | null | undefined,
): string {
  if (c && row.goal_enc) {
    try {
      const g = c.decryptText(row.goal_enc);
      if (typeof g === 'string' && g) return g;
    } catch (err) {
      console.warn('[agent] tasks.goal_enc 解密失败，回退 payload/title：', (err as Error)?.message ?? String(err));
    }
  }
  const payload = (row.payload && typeof row.payload === 'object' ? row.payload : {}) as { goal?: unknown };
  if (typeof payload.goal === 'string' && payload.goal) return payload.goal;
  return row.title ?? '';
}

/**
 * 收尾 6 | 写回 payload 前**摘掉明文 goal 键**。
 *
 * 为什么必须有它：`task/step` 与 `task/finish` 都是「读 payload → 改几个键 → 整个写回」。
 * 老行的 payload 里还躺着明文 goal，只要原样展开写回，加密就等于白做
 * （新写的 goal_enc 有了，明文那份还在同一行里）。所以每次写回都过这一道。
 */
function payloadWithoutGoal(payload: unknown): Record<string, unknown> {
  const src = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  delete out.goal;
  return out;
}

/**
 * R2（2026-09-22）：步骤摘要入库前脱敏。
 *
 * 收尾 6（2026-09-24 用户拍板）**加强**了这个函数：实现搬到 `orchestrator/redact.ts`
 * 的 `scrubTaskText`（脱敏的单一来源），在 R2 原来那两种「引号里的输入原文」形状之外，
 * 再加一层**值形态兜底**（银行卡 / 身份证 / 密码 / 验证码 / CVV）。
 *
 * R2 当年拒绝过第 2 层，理由是「secret 值本身通常不含敏感词（`Secret123` 命中不了"密码"），
 * 全文替换只会涂花账本还拦不住东西」—— 那条理由只对「按敏感词表涂全文」成立；
 * `redactForStorage` 抹的是**值形态**（12~19 位数字串、18 位身份证、`密码是X`），
 * 正好是 `Secret123` 这类东西的载体。详见 redact.ts 里 `scrubTaskText` 的注释。
 *
 * ★ 为什么现在必须加强：用户拍板 `tasks.payload` **不整列加密**（步骤账本要能在 SQL 里直接查），
 *   那这道脱敏就是明文 `payload.steps` 唯一的闸。
 */
function scrubStepSummary(summary: string): string {
  return scrubTaskText(summary);
}

/** 第 8 步：兜底文档——没配 Key 或模型乱答时，用已落库字段拼一份**不编造**的 Markdown */
function buildFallbackDoc(goal: string, steps: string[], done: Record<string, unknown>): { summary: string; title: string; markdown: string; hint: string } {
  const str = (v: unknown, d: string): string => (typeof v === 'string' && v.trim() ? v.trim() : d);
  const summary = str(done.summary, '任务已完成（细节见文档）');
  const title = str(done.document_title, '任务记录');
  const outline = Array.isArray(done.document_outline) ? (done.document_outline as unknown[]).map(String).slice(0, 12) : [];
  const lines = [
    `# ${title}`,
    '',
    '## 目标',
    goal || '未找到',
    '',
    '## 结论',
    summary,
    '',
    '## 要点',
    ...(outline.length ? outline.map((x) => `- ${x}`) : ['- 未找到（模型未配置或未能整理，以下为原始步骤）']),
    '',
    '## 步骤摘要',
    ...(steps.length ? steps.map((x) => `- ${x}`) : ['- 未找到']),
    '',
    '> 本文档由任务记录字段兜底生成（第 8 步）；未接入模型整理，也未编造任何页面数据。',
  ];
  return { summary, title, markdown: lines.join('\n'), hint: '任务结果已生成' };
}

export function registerAgentRoutes(app: FastifyInstance, { pool, env, cipher }: AgentDeps): void {
  // ------------------------------------------------- 第 21 步：兼容壳（同一引擎）
  /**
   * 老的单步接口。**不再自己写提示词、也不再自己解析 JSON 动作** ——
   * 直接调 toolLoop.decideOnce（同一份 LOOP_SYSTEM_PROMPT + 同一份 LOOP_TOOLS +
   * 同一套参数校验），把模型选的工具翻成一个 BrowserAction 返回。
   *
   * 桌面现在走 /agent/loop/*，这里留着是为了不把老路径打断；两边行为一致，
   * 所以不存在「两套互斥话术」。
   */
  app.post('/agent/next-action', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期（驾驶员接口需要第 5 步的 JWT）');
    if (!env.deepseekApiKey) {
      return errJson(reply, 503, '未配置模型：在 apps/server/.env 填 DEEPSEEK_API_KEY 后重启 npm run dev:server', {
        code: 'llm_not_configured',
      });
    }
    const body = req.body as AgentActionRequest | null;
    const goal = typeof body?.goal === 'string' ? body.goal.trim().slice(0, 500) : '';
    if (!goal) return errJson(reply, 400, 'goal 不能为空（先告诉我要完成什么）');
    const snapshot = body?.snapshot;
    if (!snapshot || typeof snapshot.url !== 'string') return errJson(reply, 400, 'snapshot 需要 read_page 的当前页快照');
    const steps = Array.isArray(body?.stepsSummary) ? body.stepsSummary.filter((x) => typeof x === 'string').slice(-12) : [];
    const paused = Boolean(body?.paused);

    try {
      // 第 10 步：驾驶员同样吃“已确认记忆”（pending 不会出现在这里——只查 active）
      const memBlock = await buildMemoryBlock(pool, cipher, claims.sub, goal);
      const out = await decideOnce(env, {
        goal,
        stepsSummary: steps,
        snapshot,
        paused,
        memoryBlock: memBlock,
      });
      return { action: out.action, note: out.note } satisfies AgentActionResponse;
    } catch (err) {
      const msg =
        (err as Error)?.name === 'TimeoutError'
          ? '模型响应超时（90s），本轮没执行任何动作'
          : `模型服务连不上：${(err as Error).message}`;
      return errJson(reply, 502, msg);
    }
  });

  // ---------------------------------------------------------------- 任务记账
  app.post('/agent/task/start', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const goal = typeof (req.body as { goal?: unknown } | null)?.goal === 'string' ? String((req.body as { goal: string }).goal).trim() : '';
    if (!goal) return errJson(reply, 400, 'goal 不能为空');
    try {
      // 子阶段 2-A：任务挂到**当前使用中的项目**（没有就回落默认项目）
      const projectId = await currentProjectId(pool, claims.sub);
      if (projectId === null) return errJson(reply, 500, '当前账号没有项目（重新登录一次让建号流程补上）');
      /**
       * ★ 收尾 6（fail-closed）：目标只以**密文**进库。
       *
       *   · `goal_enc` = AES-256-GCM 密文（与 messages/memories 同一把 DATA_KEY）；
       *   · `payload` 里**不再有 goal 键**（只有 steps / doc）；
       *   · `title` 恒 NULL —— 它当年存的是 `goal.slice(0,80)`，是同一份明文的第二个副本，
       *     留着它，「加密 goal」对不到 80 字的目标（绝大多数）就等于没加密。
       *     title 在服务端只被当作 goal 的兜底读，没有任何界面直接展示它。
       *
       * 加密失败（cipher 没注入 / encryptText 抛错）→ **直接 500，任务不建**。
       * 绝不允许「加密不行就退回明文 payload 先把任务建起来」——那正是 R2 记录的事故形状：
       * 用户说「帮我在备注里填：我的密码是 Secret123」，密码就明文躺在 PG 的 JSONB 里、备份可见。
       * 少建一条任务的代价是用户重试一次；写一条明文的代价是敏感数据落盘。
       */
      let goalEnc: string;
      try {
        if (!cipher) throw new Error('未注入 cipher（DATA_KEY 缺失）');
        goalEnc = cipher.encryptText(goal);
      } catch (err) {
        console.error('[agent] 任务目标加密失败，拒绝建任务（不回退明文）：', (err as Error)?.message ?? String(err));
        return errJson(reply, 500, '任务目标加密失败：这条任务没有建，请重试（服务端绝不把目标明文落库）', {
          code: 'goal_encrypt_failed',
        });
      }
      const t = await pool.query<{ id: string }>(
        "INSERT INTO tasks (project_id, status, title, payload, goal_enc) VALUES ($1, 'running', NULL, $2::jsonb, $3) RETURNING id",
        [projectId, JSON.stringify({ steps: [] }), goalEnc],
      );
      return { taskId: Number(t.rows[0].id) };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.post('/agent/task/step', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = req.body as { taskId?: unknown; summary?: unknown; ok?: unknown } | null;
    const taskId = Number(b?.taskId);
    const summary = typeof b?.summary === 'string' ? scrubStepSummary(b.summary).slice(0, 300) : '';
    if (!Number.isInteger(taskId) || !summary) return errJson(reply, 400, 'taskId / summary 必填');
    try {
      const t = await ownTask(pool, taskId, claims.sub);
      if (!t) return errJson(reply, 404, '任务不存在或不是你的');
      // 收尾 6：payload 整体写回前必须过 payloadWithoutGoal —— 否则老行里的明文 goal 会被原样抄回去
      const payload = payloadWithoutGoal(t.payload) as { steps?: string[] };
      const steps = [...(payload.steps ?? []), `${summary}${b?.ok === false ? '（失败）' : ''}`].slice(-50);
      await pool.query('UPDATE tasks SET payload = $2::jsonb, updated_at = now() WHERE id = $1', [
        taskId,
        JSON.stringify({ ...payload, steps }),
      ]);
      return { ok: true, stepCount: steps.length };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.post('/agent/task/status', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = req.body as { taskId?: unknown; status?: unknown } | null;
    const taskId = Number(b?.taskId);
    const status = String(b?.status ?? '');
    if (!Number.isInteger(taskId) || !['running', 'paused', 'done', 'failed'].includes(status)) {
      return errJson(reply, 400, 'taskId 必填；status ∈ running/paused/done/failed');
    }
    try {
      const t = await ownTask(pool, taskId, claims.sub);
      if (!t) return errJson(reply, 404, '任务不存在或不是你的');
      await pool.query('UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1', [taskId, status]);
      if (status === 'done' || status === 'failed') {
        // 收尾 6：payload 里已经没有明文 goal 了，记忆提取的 transcript 要用**解密后的目标**，
        // 否则「任务目标：」这一行会变成空 —— 那是功能退化，不是安全加固。
        triggerTaskExtract({ pool, env, cipher }, claims.sub, taskId, {
          ...payloadWithoutGoal(t.payload),
          goal: taskGoalFromRow(t, cipher),
        });
      }
      return { ok: true };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

// ============================================================ 第 8 步：done 的收尾
  // finish：调模型整理一次（可缺）→ 兜底不卡死 → 文档密文入 result_enc → unread=true → 通知桩
  app.post('/agent/task/finish', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const b = req.body as { taskId?: unknown; summary?: unknown; document_title?: unknown; document_outline?: unknown; pagePoints?: unknown } | null;
    const taskId = Number(b?.taskId);
    if (!Number.isInteger(taskId)) return errJson(reply, 400, 'taskId 必填');
    try {
      const t = await ownTask(pool, taskId, claims.sub);
      if (!t) return errJson(reply, 404, '任务不存在或不是你的');
      // 收尾 6：payload 摘掉明文 goal 后再写回；目标走解密（老行自动回退明文列）
      const payload = payloadWithoutGoal(t.payload) as { steps?: string[] };
      const goal = taskGoalFromRow(t, cipher);
      const steps = payload.steps ?? [];
      const doneBits = {
        summary: typeof b?.summary === 'string' ? b.summary.slice(0, 400) : '',
        document_title: typeof b?.document_title === 'string' ? b.document_title.slice(0, 120) : '',
        document_outline: Array.isArray(b?.document_outline) ? (b.document_outline as unknown[]).slice(0, 12) : [],
      };
      let doc = buildFallbackDoc(goal, steps, doneBits as unknown as Record<string, unknown>);
      if (env.deepseekApiKey) {
        // 只整理一次；模型连不上/乱答都退回兜底，绝不让收尾卡死
        try {
          const points = Array.isArray(b?.pagePoints) ? (b.pagePoints as unknown[]).map(String).slice(0, 12) : [];
          const r = await llmFetch(
            env,
            [
              { role: 'system', content: WRAP_PROMPT },
              {
                role: 'user',
                content: [
                  `任务目标：${goal}`,
                  `步骤摘要：\n${steps.map((x, i) => `${i + 1}. ${x}`).join('\n') || '（无）'}`,
                  `驾驶员 done 结论：${doneBits.summary || '（无）'}`,
                  `要点提纲：${doneBits.document_outline.join(' / ') || '（无）'}`,
                  `最后页面要点（仅标题/按钮级，不含整页）：\n${points.join('\n') || '（无）'}`,
                ].join('\n\n'),
              },
            ],
            { tag: 'agent/task/finish', json: true, temperature: 0.2 },
          );
          if (r.ok) {
            const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
            const parsed = extractJson(data.choices?.[0]?.message?.content ?? '');
            if (parsed && typeof parsed === 'object') {
              const o = parsed as Record<string, unknown>;
              const md = typeof o.document_markdown === 'string' ? o.document_markdown.slice(0, 20_000) : '';
              if (md.trim()) {
                doc = {
                  summary: (typeof o.summary === 'string' && o.summary.trim()) ? o.summary.slice(0, 400) : doc.summary,
                  title: (typeof o.document_title === 'string' && o.document_title.trim()) ? o.document_title.slice(0, 120) : doc.title,
                  markdown: md,
                  hint: (typeof o.unread_hint === 'string' && o.unread_hint.trim()) ? o.unread_hint.slice(0, 24) : doc.hint,
                };
              }
            }
          }
        } catch (err) {
          console.warn('[agent] 收尾整理未用模型（走兜底，任务仍算完成）：', (err as Error).message);
        }
      }
      await pool.query(
        "UPDATE tasks SET status = 'done', unread = true, result_enc = $2, payload = $3::jsonb, updated_at = now() WHERE id = $1",
        [
          taskId,
          cipher.encryptText(doc.markdown),
          JSON.stringify({ ...payload, doc: { summary: doc.summary, title: doc.title, hint: doc.hint, outline: doneBits.document_outline } }),
        ],
      );
      try {
        // R2 全面加固（2026-09-22）：通知文案不再带 goal 明文（goal 可能含密码/卡号），只带任务号与 hint
        notifyUser(claims.sub, `${doc.hint}（任务 #${taskId}）`);
      } catch (err) {
        // 通知挂了不碍事：说明书钉死——任务仍算 done，红点和文档都在
        console.warn('[agent] 通知失败（忽略，不影响任务）：', (err as Error).message);
      }
      triggerTaskExtract({ pool, env, cipher }, claims.sub, taskId, {
        ...(payload as Record<string, unknown>),
        // 收尾 6：同上 —— 记忆提取要拿到解密后的目标，不能因为 payload 里没有 goal 就丢了这一行
        goal,
        doc: { summary: doc.summary },
      } as never);
      return { ok: true, unread: true, unreadHint: doc.hint, docTitle: doc.title };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // 下载前取文档（密文解回）；老任务没存过 result_enc 就用字段兜底再生成
  app.get('/agent/task/doc', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const q = req.query as { taskId?: unknown } | null;
    const taskId = Number(q?.taskId);
    if (!Number.isInteger(taskId)) return errJson(reply, 400, 'taskId 必填');
    try {
      const t = await ownTask(pool, taskId, claims.sub);
      if (!t) return errJson(reply, 404, '任务不存在或不是你的');
      const payload = payloadWithoutGoal(t.payload) as { steps?: string[]; doc?: { summary?: string; title?: string; outline?: string[] } };
      let markdown: string;
      if (t.result_enc) {
        try {
          markdown = cipher.decryptText(t.result_enc);
        } catch {
          return errJson(reply, 500, '文档解密失败：DATA_KEY 可能换过');
        }
      } else {
        const bits = { summary: payload.doc?.summary ?? '', document_title: payload.doc?.title ?? '', document_outline: payload.doc?.outline ?? [] };
        // 收尾 6：兜底文档的「## 目标」走 taskGoalFromRow（解密优先，老行回退明文列）
        markdown = buildFallbackDoc(taskGoalFromRow(t, cipher), payload.steps ?? [], bits as unknown as Record<string, unknown>).markdown;
      }
      const title = (payload.doc?.title ?? '任务记录').replace(/[\\/:*?"<>|\r\n]+/g, ' ').slice(0, 60) || '任务记录';
      return { title, markdown };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  // 看完即读：红点灭
  app.post('/agent/task/read', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    const taskId = Number((req.body as { taskId?: unknown } | null)?.taskId);
    if (!Number.isInteger(taskId)) return errJson(reply, 400, 'taskId 必填');
    try {
      const t = await ownTask(pool, taskId, claims.sub);
      if (!t) return errJson(reply, 404, '任务不存在或不是你的');
      await pool.query('UPDATE tasks SET unread = false, updated_at = now() WHERE id = $1', [taskId]);
      return { ok: true, unread: false };
    } catch (err) {
      return dbErr(reply, err);
    }
  });

  app.get('/agent/task/current', async (req: FastifyRequest, reply) => {
    const claims = authed(req, env);
    if (!claims) return errJson(reply, 401, '未登录或登录已过期');
    try {
      const r = await pool.query<{ id: string; status: string; title: string | null; payload: unknown; unread: boolean; goal_enc: string | null }>(
        'SELECT t.id, t.status, t.title, t.payload, t.unread, t.goal_enc FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.user_id = $1 ORDER BY t.id DESC LIMIT 1',
        [claims.sub],
      );
      if (r.rowCount !== 1) return { task: null };
      const row = r.rows[0];
      const payload = payloadWithoutGoal(row.payload) as { steps?: string[]; doc?: { summary?: string; title?: string; hint?: string; outline?: string[] } };
      // 收尾 6：桌面刷新后还原任务卡靠 goal —— 解密优先，老行回退明文列，
      // 用户看到的还是原来那句话（加密不能变成「任务卡上目标空了」）
      const goal = taskGoalFromRow(row, cipher);
      return {
        task: {
          id: Number(row.id),
          status: row.status,
          goal,
          /**
           * ★ 收尾 6 条件1（2026-09-24）：**非敏感的显示字段**，给「不该带用户原话」的场景用
           *   （任务列表行、系统通知、日志、将来的托盘提示）。
           *
           * 与 `goal` 的区别必须说清楚，两者都非空、但用途不同：
           *   · `goal`         = 用户原话（解密后的完整目标）。任务卡详情要它，
           *                      所以它**可能含敏感词** —— 那是用户自己写进去的，
           *                      界面不显示原文就等于把功能吃掉；
           *   · `displayTitle` = 同一句话过 `scrubTaskText` 脱敏后的前 80 字，
           *                      **保证不含银行卡/身份证/密码/验证码/CVV 的值**，
           *                      且永远非空（整句都是敏感值时回落到「任务」）。
           *
           * 为什么现算不入库：`tasks.title` 已经停用（它当年存 `goal.slice(0,80)`，
           * 是同一份明文的第二个副本）。再存一份脱敏摘要就是第三个副本，
           * 而且脱敏规则一改，库里那份立刻变成「看起来脱敏了其实是旧规则」的陈迹。
           * 现算的代价只是每次请求跑几条正则。
           */
          displayTitle: taskDisplayTitle(goal),
          steps: payload.steps ?? [],
          unread: Boolean(row.unread),
          summary: payload.doc?.summary ?? '',
          docTitle: payload.doc?.title ?? '',
          unreadHint: payload.doc?.hint ?? '',
          outline: payload.doc?.outline ?? [],
        },
      };
    } catch (err) {
      return dbErr(reply, err);
    }
  });
}