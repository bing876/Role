/**
 * 多智能体编排 · **临时工运行时**。
 *
 * 临时工是什么（与「智能体」的本质区别，改这里前先读）：
 *
 *   | | 智能体 | 临时工 |
 *   |---|---|---|
 *   | 身份 | 有（agents 表、persona、自己的会话） | **没有** |
 *   | 记忆 | 两层记忆 + 会话历史 | **没有**（每次都是全新 messages） |
 *   | 寿命 | 长期 | 一件事做完就销毁（registry 里连 job 都删掉） |
 *   | 能力 | 浏览器手（主循环）/ 检索+推理（被委派方） | **只有检索 + 推理** |
 *   | 交付 | 自由对话 | **结构化汇报**（WorkerReport） |
 *
 * 所以本文件里没有任何「查 agents 表 / 建会话 / 写记忆」的代码 —— 不是漏了，是**不该有**。
 *
 * 三条实现约束（都是实测/审计逼出来的，别顺手改）：
 *   1. **单个失败不影响同批**：用 allSettled 语义，逐条给 status。发起方看到的是
 *      「3 个里 1 个超时」，不是整批失败 —— 整批失败会让模型重派一遍，费用翻倍。
 *   2. **并发有上限**（WORKER_CONCURRENCY）：一次 spawn_workers 最多 5 个任务，
 *      但同时只跑 3 个 —— 5 路模型调用同时打上游很容易撞限流。
 *   3. **每个工人独立超时 + 整批有预算**：到点没回来的按 `status='timeout'` 汇报。
 *      绝不让一个工人把整批吊住（那等于把 R8「模型挂死 90 秒零反馈」放大 5 倍）。
 */
import type { ChatSource, WorkerBatchResult, WorkerReport, WorkerTaskSpec } from '@ai-workbench/shared';
import type { ServerEnv } from '../env';
import { llmFetch, type LlmMessage } from '../llm';
import { WEB_SEARCH_SERVER_TOOL, formatSearchForModel, runWebSearch } from './search';
import { WORKER_SYSTEM_PROMPT } from './prompts';
import { redactForStorage } from './redact';

/** 汇报字段的硬上限（模型给多长都截到这里，防一段自由文本吃掉发起方的上下文） */
const SUMMARY_MAX = 300;
const FINDINGS_MAX = 8;
const FINDING_LEN_MAX = 200;
const SOURCES_MAX = 5;

export interface RunWorkerPoolInput {
  env: ServerEnv;
  jobId: string;
  tasks: WorkerTaskSpec[];
  /** false / 未配置 Tavily / 轮数为 0 → 自动降级成纯推理（不报错） */
  allowSearch: boolean;
  concurrency: number;
  perWorkerTimeoutMs: number;
  budgetMs: number;
  maxSearchRounds: number;
  /** job 被熔断时置 true（工人们会在下一个检查点自己收手） */
  signal?: { aborted: boolean };
  /** 过程注记（发起方循环的日志 / 频道留痕用） */
  onProgress?: (workerId: string, text: string) => void;
}

/**
 * 跑一批临时工，返回**顺序与入参严格一致**的汇报数组。
 *
 * 顺序必须是确定性的：发起方的模型要能把「第 2 个任务的汇报」对上「第 2 个任务」，
 * 顺序一乱，结论就张冠李戴（而且验收脚本没法断言）。
 */
export async function runWorkerPool(input: RunWorkerPoolInput): Promise<WorkerBatchResult> {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1_000, input.budgetMs);
  const reports: Array<WorkerReport | null> = input.tasks.map(() => null);
  /**
   * ★ 每个工人一个 AbortController。**必须**有它：
   *   只靠 `withTimeout` 返回兜底值的话，被放弃的那个工人**仍在后台跑完整个模型调用**
   *   （llmFetch 自己 60s 超时）—— 等于「超时了还在烧钱」，正是 R9 记的那类无底洞。
   *   abort 之后上游请求当场断，工人在 catch 里返回，不再有第二次模型调用。
   */
  const controllers: AbortController[] = [];

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= input.tasks.length) return;
      if (input.signal?.aborted || Date.now() >= deadline) {
        reports[i] = timeoutReport(i, input.tasks[i], startedAt);
        continue;
      }
      const left = deadline - Date.now();
      const budget = Math.max(1_000, Math.min(input.perWorkerTimeoutMs, left));
      const ac = new AbortController();
      controllers.push(ac);
      reports[i] = await withTimeout(
        runOneWorker(input, i, input.tasks[i], budget, ac.signal),
        budget,
        () => {
          ac.abort(); // 到点：把上游请求一起掐掉，不留后台调用
          return timeoutReport(i, input.tasks[i], startedAt);
        },
      );
    }
  };

  const lanes = Math.max(1, Math.min(input.concurrency, input.tasks.length));
  try {
    await Promise.all(Array.from({ length: lanes }, () => worker()));
  } finally {
    // 整批结束（含 job 被熔断）：把所有还在飞的请求掐掉
    for (const ac of controllers) ac.abort();
  }

  const finalReports = reports.map((r, i) => r ?? timeoutReport(i, input.tasks[i], startedAt));
  return {
    jobId: input.jobId,
    reports: finalReports,
    okCount: finalReports.filter((r) => r.status === 'ok').length,
    failCount: finalReports.filter((r) => r.status !== 'ok').length,
    tookMs: Date.now() - startedAt,
  };
}

function timeoutReport(i: number, task: WorkerTaskSpec, startedAt: number): WorkerReport {
  return {
    id: `w${i + 1}`,
    title: String(task?.title ?? `任务 ${i + 1}`).slice(0, 60),
    status: 'timeout',
    summary: '',
    findings: [],
    sources: [],
    confidence: 'low',
    error: '这个临时工到点没回来（整批预算或单个超时用完），如实报超时 —— 没有假装完成。',
    tookMs: Date.now() - startedAt,
  };
}

/** 给一个 Promise 套硬超时；到点返回兜底值（原 Promise 的结果被丢弃） */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((res) => {
    timer = setTimeout(() => res(fallback()), Math.max(1, ms));
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 一个临时工的完整一生：查（可选）→ 想 → 输出严格 JSON */
async function runOneWorker(
  input: RunWorkerPoolInput,
  index: number,
  task: WorkerTaskSpec,
  budgetMs: number,
  signal: AbortSignal,
): Promise<WorkerReport> {
  const id = `w${index + 1}`;
  const startedAt = Date.now();
  const title = String(task?.title ?? `任务 ${index + 1}`).slice(0, 60);
  const base = { id, title };
  try {
    const messages: LlmMessage[] = [
      { role: 'system', content: WORKER_SYSTEM_PROMPT },
      { role: 'user', content: workerTaskPrompt(task, index) },
    ];
    const sources: ChatSource[] = [];
    let rounds = 0;
    const canSearch = input.allowSearch && input.maxSearchRounds > 0;
    const tools = canSearch ? [WEB_SEARCH_SERVER_TOOL] : undefined;

    // 检索阶段：最多 maxSearchRounds 轮；模型不调工具就直接进汇总阶段
    while (canSearch && rounds < input.maxSearchRounds) {
      if (input.signal?.aborted) break;
      const r = await llmFetch(input.env, messages, {
        tag: `orc/worker#${id}#${rounds + 1}`,
        temperature: 0.2,
        timeoutMs: Math.max(1_000, Math.min(budgetMs, 60_000)),
        tools: tools as unknown[],
        toolChoice: 'auto',
        signal,
      });
      if (!r.ok) break;
      const data = (await r.json()) as {
        choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{
          id?: string; type?: string; function?: { name?: string; arguments?: string }
        }> | null } }>;
      };
      const msg = data.choices?.[0]?.message;
      const calls = (msg?.tool_calls ?? []).filter((c) => c?.function?.name === 'web_search');
      if (calls.length === 0) break; // 模型觉得不用再搜了
      const first = calls[0];
      let args: Record<string, unknown> = {};
      try {
        const parsed = first.function?.arguments ? JSON.parse(first.function.arguments) : {};
        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
      } catch {
        args = {};
      }
      const callId = typeof first.id === 'string' && first.id ? first.id : `call_${id}_${rounds + 1}`;
      messages.push({
        role: 'assistant',
        content: typeof msg?.content === 'string' ? msg.content : '',
        tool_calls: [
          {
            id: callId,
            type: 'function',
            function: { name: 'web_search', arguments: JSON.stringify(args) },
          },
        ],
      });
      const query = String(args.query ?? '').trim().slice(0, 300);
      const res = await runWebSearch(input.env, {
        query,
        topic: args.topic === 'news' ? 'news' : 'general',
        maxResults: typeof args.max_results === 'number' ? args.max_results : 5,
      });
      // ★ 日志与频道注记都**不记 query 原文**（R1 的口径：拦下来的更不能记）
      input.onProgress?.(id, res.ok ? `已搜索（${res.count} 条结果）` : `搜索未成功（${res.error ?? '无结果'}）`);
      for (const s of res.sources) if (sources.length < SOURCES_MAX) sources.push(s);
      messages.push({ role: 'tool', tool_call_id: callId, content: formatSearchForModel(query, res) });
      rounds += 1;
    }

    // 汇总阶段：强制纯 JSON（不给工具，tool_choice=none）
    const finalMsgs: LlmMessage[] = [
      ...messages,
      { role: 'user', content: '现在按系统提示词里的格式，只输出那一个 JSON 对象。' },
    ];
    const fr = await llmFetch(input.env, finalMsgs, {
      tag: `orc/worker#${id}#report`,
      temperature: 0.1,
      timeoutMs: Math.max(1_000, Math.min(budgetMs, 60_000)),
      toolChoice: 'none',
      signal,
    });
    if (!fr.ok) {
      return {
        ...base,
        status: 'failed',
        summary: '',
        findings: [],
        sources,
        confidence: 'low',
        error: `汇总这一步模型服务返回 HTTP ${fr.status}，没有拿到汇报。`,
        tookMs: Date.now() - startedAt,
      };
    }
    const fdata = (await fr.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
    const text = String(fdata.choices?.[0]?.message?.content ?? '');
    return parseReport(base, text, sources, startedAt);
  } catch (err) {
    // 一个工人炸了不影响同批 —— 这里吞掉，逐条给 status
    const msg = (err as Error)?.message ?? String(err);
    return {
      ...base,
      status: 'failed',
      summary: '',
      findings: [],
      sources: [],
      confidence: 'low',
      error: `这个临时工执行出错：${msg.slice(0, 200)}`,
      tookMs: Date.now() - startedAt,
    };
  }
}

/** 临时工的任务书（**自带上下文** —— 它没有记忆，看不到发起方的对话） */
function workerTaskPrompt(task: WorkerTaskSpec, index: number): string {
  const lines = [
    `这是第 ${index + 1} 件事：${String(task?.title ?? '').slice(0, 60)}`,
    '',
    '要做的事：',
    String(task?.instruction ?? '').slice(0, 600),
  ];
  const ctx = String(task?.context ?? '').trim();
  if (ctx) {
    lines.push('', '发起方已有的资料（你可以直接用，不必重查）：', ctx.slice(0, 2000));
  }
  lines.push('', '（提醒：你没有身份、没有记忆、没有浏览器。做完就按格式汇报。）');
  return lines.join('\n');
}

/**
 * 解析汇报 JSON。
 *
 * ★ 解析失败**不当成整批失败**：把原文截断放进 summary、status 记 failed、原因如实写。
 *   发起方至少能看到「这个工人说了什么但格式不对」，比一句「失败」有用。
 */
export function parseReport(
  base: { id: string; title: string },
  text: string,
  sources: ChatSource[],
  startedAt: number,
): WorkerReport {
  const raw = String(text ?? '').trim();
  const obj = extractJson(raw);
  if (!obj) {
    return {
      ...base,
      status: 'failed',
      summary: raw.slice(0, SUMMARY_MAX),
      findings: [],
      sources: sources.slice(0, SOURCES_MAX),
      confidence: 'low',
      error: '汇报不是合法 JSON（已把原文截断放进 summary，没有丢内容）。',
      tookMs: Date.now() - startedAt,
    };
  }
  const summary = redactForStorage(String(obj.summary ?? '')).slice(0, SUMMARY_MAX);
  const findingsRaw = Array.isArray(obj.findings) ? obj.findings : [];
  const findings = findingsRaw
    .slice(0, FINDINGS_MAX)
    .map((x) => redactForStorage(String(x ?? '')).slice(0, FINDING_LEN_MAX))
    .filter(Boolean);
  const sourcesRaw = Array.isArray(obj.sources) ? obj.sources : [];
  const modelSources: ChatSource[] = sourcesRaw
    .slice(0, SOURCES_MAX)
    .map((s) => {
      const o = (s ?? {}) as Record<string, unknown>;
      const url = String(o.url ?? '').trim().slice(0, 500);
      if (!/^https?:\/\//i.test(url)) return null;
      let domain = '';
      try {
        domain = new URL(url).host.replace(/^www\./i, '');
      } catch {
        return null;
      }
      return { title: String(o.title ?? '').slice(0, 200), url, domain };
    })
    .filter((x): x is ChatSource => x !== null);
  /**
   * ★ 只信**搜索真的返回过**的网址：模型给的 url 必须在实际搜索结果里出现过。
   *   这是「不许编造来源」的确定性执行 —— 光在提示词里写是不够的。
   */
  const realUrls = new Set(sources.map((s) => s.url));
  const verified = modelSources.filter((s) => realUrls.has(s.url));
  const confidence = obj.confidence === 'high' || obj.confidence === 'medium' ? obj.confidence : 'low';
  return {
    ...base,
    status: 'ok',
    summary,
    findings,
    sources: verified,
    confidence,
    tookMs: Date.now() - startedAt,
  };
}

/** 从模型输出里抠出第一个 JSON 对象（容忍 ```json 围栏与前后废话） */
export function extractJson(text: string): Record<string, unknown> | null {
  const t = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
  if (!t) return null;
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(t.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
