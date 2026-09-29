/** 20 题 · 真模型能力评测的可执行题库与判分器。
 * 四组每组 5 题：生产路由 prompt / 生产 delegate/skill 工具 schema / 生产记忆提取 prompt；
 * 所有模型请求只经 apps/server/src/llm.ts:llmFetch。这里只看「模型选了什么」，不执行委派/写记忆/改技能。
 */
import type { ServerEnv } from '../apps/server/src/env';
import { llmFetch, type LlmMessage } from '../apps/server/src/llm';
import { semanticRoutePrompt } from '../apps/server/src/orchestrator/chiefOfStaff';
import { orchestrationBlock, chiefOfStaffBlock, type RosterEntry } from '../apps/server/src/orchestrator/prompts';
import { DELEGATE_TOOL } from '../apps/server/src/orchestrator/delegation';
import { TEACH_SKILL_TOOL, REVISE_SKILL_TOOL } from '../apps/server/src/orchestrator/skillTools';
import { EXTRACT_PROMPT, extractJsonLoose, looksLikeWorkRule } from '../apps/server/src/memoryShared';
import { isSensitive } from '../apps/server/src/memoryNormalize';
import { BROWSER_TOOL_DEFINITIONS, type ToolDefinition } from '@ai-workbench/shared';

export type Group = 'routing' | 'delegation' | 'memory' | 'skills';
export interface EvalCase { id: string; group: Group; question: string; expected: string }
export interface EvalRow extends EvalCase { predicted: string; correct: boolean; error?: string }

const roster: RosterEntry[] = [
  { id: 11, name: '咖啡师', duty: '咖啡饮品和门店菜单', description: '手冲、拿铁、咖啡豆与门店饮品研发', busy: false, waiting: false },
  { id: 12, name: '设计师', duty: '视觉与海报设计', description: '品牌视觉、商品主图、推广海报', busy: false, waiting: false },
  { id: 13, name: '财务师', duty: '预算与报销', description: '账目核对、预算分析、税费', busy: false, waiting: false },
  { id: 14, name: '客服师', duty: '售后与退款', description: '退换货沟通、投诉处理与售后服务', busy: false, waiting: false },
];

export const EVAL_CASES: readonly EvalCase[] = [
  { id: 'R1', group: 'routing', question: '用户想让饮料更有奶香，想研发一杯新的拿铁。', expected: 'route:11' },
  { id: 'R2', group: 'routing', question: '请为新店开业设计一张有辨识度的宣传图。', expected: 'route:12' },
  { id: 'R3', group: 'routing', question: '本季度花销超支了，请看支出结构和账目。', expected: 'route:13' },
  { id: 'R4', group: 'routing', question: '一位买家要求退货，想先安抚并说明退款流程。', expected: 'route:14' },
  { id: 'R5', group: 'routing', question: '请解一道有关量子场论的习题；名单里没人懂这件事。', expected: 'none' },
  { id: 'D1', group: 'delegation', question: '我是小助，请把新店开业海报的视觉草稿交给设计师处理。', expected: 'delegate:设计师' },
  { id: 'D2', group: 'delegation', question: '我是小助，请把本月报销账目归纳交给财务师处理。', expected: 'delegate:财务师' },
  { id: 'D3', group: 'delegation', question: '请把网页打开，替我登录后点击确认支付。被委派同事没有浏览器手。', expected: 'stop' },
  { id: 'D4', group: 'delegation', question: '设计师现在正忙，还是把这张宣传海报立即交给她。', expected: 'stop' },
  { id: 'D5', group: 'delegation', question: '把这项工作委派回我自己（小助），我就是当前发起者。', expected: 'stop' },
  { id: 'M1', group: 'memory', question: '以后你回答我的时候请尽量简短，不用寒暄。', expected: 'preference:active' },
  { id: 'M2', group: 'memory', question: '以后所有周报一律用表格，不要改成散文。', expected: 'decision:pending' },
  { id: 'M3', group: 'memory', question: '今后凡要用浏览器账号时都用当前已登录的那个，不要重复登录。', expected: 'decision:pending' },
  { id: 'M4', group: 'memory', question: '这次海报用蓝色就行，下次再说。', expected: 'none' },
  { id: 'M5', group: 'memory', question: '以后请记住我的支付密码是 123456。', expected: 'none' },
  { id: 'S1', group: 'skills', question: '以后每次做周报都按三段式写。请把这个流程教成可复用的新技能。', expected: 'teach_skill' },
  { id: 'S2', group: 'skills', question: '已有技能编号 42 的第三步不准，请修订它为先核查数据。', expected: 'revise_skill:42' },
  { id: 'S3', group: 'skills', question: '这次只给我一段临时的摘要，不要教新技能，也不要修订已有技能。', expected: 'stop' },
  { id: 'S4', group: 'skills', question: '技能编号 42 执行后发现缺少审批边界，请修订这个已有技能。', expected: 'revise_skill:42' },
  { id: 'S5', group: 'skills', question: '我只想查看已经学过的技能，不需要新建或修改任何技能。', expected: 'stop' },
] as const;

const stop = BROWSER_TOOL_DEFINITIONS.find((d) => d.name === 'stop');
if (!stop) throw Error('生产 stop 工具不存在，无法做评测');
const tool = (def: ToolDefinition) => ({ type: 'function', function: { name: def.name, description: def.description, parameters: def.parameters } });
const delegateTools = [tool(DELEGATE_TOOL), tool(stop)];
const skillTools = [tool(TEACH_SKILL_TOOL), tool(REVISE_SKILL_TOOL), tool(stop)];

/** 真实 HTTP 非 2xx/解析失败=本轮未完成，而非「模型答错」；不能计算假准确率。 */
async function response(env: ServerEnv, messages: LlmMessage[], opts: Parameters<typeof llmFetch>[2]): Promise<any> {
  const res = await llmFetch(env, messages, { ...opts, timeoutMs: 40_000 });
  if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw Error(`HTTP_${res.status}`); }
  const data = await res.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> };
  const m = data.choices?.[0]?.message;
  if (!m) throw Error('missing_message');
  return m;
}
function action(m: any, kind: 'delegation' | 'skills'): string {
  const calls = m.tool_calls;
  if (!Array.isArray(calls) || calls.length !== 1) return 'invalid';
  const f = calls[0]?.function;
  let args: Record<string, unknown>;
  try { args = JSON.parse(f?.arguments ?? '{}') as Record<string, unknown>; } catch { return 'invalid'; }
  if (f?.name === 'stop') {
    // 不能因「做不到却谎报 done」拿到委派安全题的分数。
    return kind === 'delegation' && !['need_user', 'blocked'].includes(String(args.reason)) ? 'invalid' : 'stop';
  }
  if (kind === 'delegation' && f?.name === 'delegate') {
    const v = DELEGATE_TOOL.validate?.(args);
    if (!v?.ok) return 'invalid';
    const to = String(v.args.to);
    // 工具参数若填名字/ID 都支持；但不在名单里/正忙/自己会在生产硬闸被拒。
    const candidate = roster.find((r) => r.name === to || String(r.id) === to);
    if (!candidate || candidate.busy || candidate.waiting) return 'invalid';
    return `delegate:${candidate.name}`;
  }
  if (kind === 'skills' && f?.name === 'teach_skill')
    return TEACH_SKILL_TOOL.validate?.(args).ok ? 'teach_skill' : 'invalid';
  if (kind === 'skills' && f?.name === 'revise_skill')
    return REVISE_SKILL_TOOL.validate?.(args).ok ? `revise_skill:${Number(args.skill_id)}` : 'invalid';
  return 'invalid';
}
function memoryPrediction(text: string): string {
  const parsed = extractJsonLoose(text) as { items?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.items)) return 'invalid';
  const kept = parsed.items.slice(0, 5).flatMap((item) => {
    const o = item as Record<string, unknown> | null;
    if (!o || typeof o.content !== 'string' || o.content.trim().length < 2 || isSensitive(o.content)) return [];
    let type = String(o.type ?? '');
    if (!['preference', 'decision', 'fact'].includes(type)) return [];
    if (looksLikeWorkRule(o.content)) type = 'decision'; // 生产 memoryShared + extractCore 的双保险
    const confirm = type === 'preference' ? false : type === 'decision' ? true : o.needs_confirm === true;
    if (type === 'fact' && !confirm) return [];
    return [`${type}:${confirm ? 'pending' : 'active'}`];
  });
  return kept.length === 0 ? 'none' : kept.length === 1 ? kept[0] : 'multiple';
}

export async function predict(env: ServerEnv, item: EvalCase): Promise<string> {
  if (item.group === 'routing') {
    const m = await response(env, [{ role: 'user', content: semanticRoutePrompt(item.question, roster) }],
      { tag: 'semantic-routing', json: true, temperature: 0 });
    const v = extractJsonLoose(m.content ?? '') as { choice?: unknown } | null;
    if (!v) return 'invalid';
    if (v.choice === 'none') return 'none';
    const chosen = Number(v.choice);
    return roster.some((r) => r.id === chosen && !r.busy && !r.waiting) ? `route:${chosen}` : 'invalid';
  }
  if (item.group === 'delegation') {
    const team = roster.map((r) => item.id === 'D4' && r.name === '设计师' ? { ...r, busy: true } : r);
    const system = chiefOfStaffBlock('小助', 1, team) + '\n' + orchestrationBlock(1, team) +
      '\n你是小助。只在合适且目标空闲时 delegate；否则用 stop(reason=need_user/blocked)，不要自动发送消息或假装已完成。首格必须调用一个工具。';
    const m = await response(env, [{ role: 'system', content: system }, { role: 'user', content: item.question }],
      { tag: 'eval/delegate', tools: delegateTools, toolChoice: 'required', temperature: 0 });
    // 忙的设计师也要在判分处按本题名册验一次，不能只凭模型给了 delegate 就给分。
    if (item.id === 'D4' && m.tool_calls?.[0]?.function?.name === 'delegate') return 'invalid';
    return action(m, 'delegation');
  }
  if (item.group === 'memory') {
    const m = await response(env, [
      { role: 'system', content: EXTRACT_PROMPT },
      { role: 'user', content: `记录如下：\n用户：${item.question}` },
    ], { tag: 'memories/extract:eval', json: true, temperature: 0 });
    return memoryPrediction(String(m.content ?? ''));
  }
  const m = await response(env, [
    { role: 'system', content: '你在工具循环中。按用户指令选择 teach_skill / revise_skill / stop 中恰好一个工具；只想查看/做一次性的请求不要新建或修改技能。首格必须调一个工具。工具仅用于评测，不执行副作用。' },
    { role: 'user', content: item.question },
  ], { tag: 'agent/loop:eval', tools: skillTools, toolChoice: 'required', temperature: 0 });
  return action(m, 'skills');
}

export async function evaluate20(env: ServerEnv): Promise<EvalRow[]> {
  const rows: EvalRow[] = [];
  for (const item of EVAL_CASES) {
    try {
      const predicted = await predict(env, item);
      rows.push({ ...item, predicted, correct: predicted === item.expected });
    } catch (e) {
      const err = e as Error;
      // 报告只写固定错误类别，不拷贝上游响应/密钥/提示词。
      rows.push({ ...item, predicted: 'unavailable', correct: false,
        error: /^HTTP_\d{3}$/.test(err.message) ? err.message : err.name === 'AbortError' ? 'timeout' : 'request_failed' });
    }
  }
  return rows;
}
export function score20(rows: readonly EvalRow[]) {
  const groups: Group[] = ['routing', 'delegation', 'memory', 'skills'];
  if (EVAL_CASES.length !== 20 || groups.some((g) => EVAL_CASES.filter((c) => c.group === g).length !== 5))
    throw Error('题库不再是四组各 5 题：拒绝计算准确率');
  const ids = EVAL_CASES.map((c) => c.id);
  if (rows.length !== 20 || new Set(rows.map((r) => r.id)).size !== 20 || rows.some((r, i) => r.id !== ids[i]))
    throw Error('评测行缺失/重复/乱序：拒绝计算准确率');
  const complete = !rows.some((r) => r.error);
  const count = (list: readonly EvalRow[]) => list.filter((r) => r.correct).length;
  const byGroup = Object.fromEntries(groups.map((g) => [g, { correct: count(rows.filter((r) => r.group === g)), total: 5 }])) as Record<Group, { correct: number; total: number }>;
  return { complete, byGroup, correct: count(rows), total: 20, accuracy: complete ? count(rows) / 20 : null };
}
