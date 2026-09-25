/**
 * 人设固定注入 · 单一来源
 *
 * 背景：
 *   - 之前人设块的拼装散在 agents.ts 的 buildAgentContext 里，且与记忆块混在一起
 *   - 长期记忆里若有「以后都按 X 风格说话」这类句子，可能把用户填的人设覆盖掉
 *   - 需要一个文件把「人设是谁、怎么注入、优先级多高」收口，保证人设固定且高于记忆
 *
 * 规矩：
 *   - 本文件只做纯文本与纯函数，不碰数据库、不碰 fetch
 *   - 注入时明确标注「固定身份，不可被参考信息覆盖」，与 promptPolicy 的优先级表一致
 *   - 人设块在前、基座在后、记忆在最后（见 chat.ts 拼装顺序），且带「只能追加、不能削弱基座」说明
 */

import type { AgentPersona } from '@ai-workbench/shared';
import { HEN_NAME, XIAOZHU_PERSONA } from './coordinatorPersona';
import { fixedPersonaForKind, HEN_PERSONA_BLOCK } from './coordinatorPersona';

export const IDENTITY_FIXED_NOTE = '（固定身份，优先级高于所有参考信息与长期记忆；参考信息只能在此基础上追加细节，不能削弱或改写它。）';
export const IDENTITY_OVERRIDE_NOTE = '（基座规则在下面，优先级更高：这份人设只能在此基础上追加说话风格与专长，不能削弱基座。）';

export interface IdentityInput {
  id: number;
  name: string;
  kind: string;
  persona: AgentPersona | null;
  personaStatus: 'pending' | 'ready';
  /** 批次 F | Skills 技能槽：命中时注入，已在 chat.ts / toolLoop 拼好 */
  skillBlock?: string;
}

/**
 * 人设的逐行人话（who/tone/duty/antiJobs/description）。
 * G2：antiJobs（不干什么）与 description（整份人设）也是人设的一部分，一并注入。
 * 空字段自动跳过。
 */
function personaLines(p: AgentPersona): string[] {
  return [
    p.who ? `它是谁：${p.who}` : '',
    p.tone ? `怎么说话：${p.tone}` : '',
    p.duty ? `干什么：${p.duty}` : '',
    p.antiJobs ? `不干什么：${p.antiJobs}` : '',
    p.description ? `整份人设：${p.description}` : '',
  ].filter(Boolean);
}

/**
 * 构建人设块（固定注入）
 * - 有固定人设的 kind（hen/coordinator/worker）：直接返回固定块
 * - 自带小助（assistant）：小助默认身份（管家）+ 技能槽
 * - pending 或无 persona：返回引导提示，提醒用户填表
 * - 正常 custom：返回用户填的人设（含 antiJobs/description）
 */
export function buildIdentityBlock(input: IdentityInput): string {
  const { id, name, kind, persona, personaStatus, skillBlock } = input;

  // 固定人设优先（母鸡/总协调/临时工）
  const fixed = fixedPersonaForKind(kind);
  if (fixed) {
    const base = kind === 'hen' ? [HEN_PERSONA_BLOCK, IDENTITY_FIXED_NOTE].join('\n') : [fixed, IDENTITY_FIXED_NOTE].join('\n');
    return skillBlock?.trim() ? [base, skillBlock.trim()].join('\n\n') : base;
  }

  if (kind === 'assistant') {
    // G2（2026-09-25）：小助 = 项目管家，有固定默认身份（用户给的「小助配置」）。
    // 建号时已写进 persona；存量账号（persona 为 NULL）回落 XIAOZHU_PERSONA 同一份默认。
    // 小助也需要技能槽（用户教的任务），拼在人设块之后。
    const p: AgentPersona = persona ?? XIAOZHU_PERSONA;
    const block = [
      '【当前智能体是「小助」——这个项目的管家/总协调（固定身份）】',
      IDENTITY_FIXED_NOTE,
      ...personaLines(p),
      `（ID：${id}，当前名：${name}）`,
    ].filter(Boolean)
      .join('\n');
    return skillBlock?.trim() ? [block, skillBlock.trim()].join('\n\n') : block;
  }

  if (personaStatus === 'pending' || !persona) {
    // 兼容存量空壳 pending（旧数据）；新流程（规格 C1）建好即 ready + 默认人设，
    // 「三问」走桌面输入框上方的 chips（可选精调），不经过这条引导。
    const pendingBlock = [
      '【当前智能体还没设定】用户刚点了「添加」，会话里已经摆好一张引导表，但他还没填完。',
      '这一轮不要展开长聊、不要自己编人设：只回一两句，请他在上面的引导表里写下',
      '「名称 / 它是谁 / 怎么说话 / 干什么」，并说明填完点确认后你就按那份描述干活。',
      IDENTITY_FIXED_NOTE,
    ].join('\n');
    return skillBlock?.trim() ? [pendingBlock, skillBlock.trim()].join('\n\n') : pendingBlock;
  }

  const personaBlock = [
    '【当前智能体的人设（用户在引导表里亲自填的）】',
    IDENTITY_OVERRIDE_NOTE,
    `名称：${persona.name}`,
    ...personaLines(persona),
    IDENTITY_FIXED_NOTE,
    `（ID：${id}，当前名：${name}）`,
  ]
    .filter(Boolean)
    .join('\n');
  return skillBlock?.trim() ? [personaBlock, skillBlock.trim()].join('\n\n') : personaBlock;
}

/**
 * 构建可编辑的人设快照（用于 GET /agents/:id/persona 返回）
 */
export function personaSnapshot(persona: AgentPersona | null): AgentPersona | null {
  if (!persona) return null;
  return {
    name: persona.name,
    who: persona.who,
    tone: persona.tone,
    duty: persona.duty,
    antiJobs: persona.antiJobs,
    description: persona.description,
  };
}

/**
 * 校验用户提交的人设（与 agents.ts 的 oneLine 逻辑一致，但收口到一处）。
 * G2：antiJobs（不干什么）与 description（整份人设）也在校验范围内 —— 都可填、可空。
 */
export function validatePersonaInput(raw: Record<string, unknown>): { ok: true; persona: AgentPersona } | { ok: false; error: string } {
  const oneLine = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const name = oneLine(raw.name, 24);
  if (!name) return { ok: false, error: '至少给它起个名称（名称不能为空）' };
  const persona: AgentPersona = {
    name,
    who: oneLine(raw.who, 120),
    tone: oneLine(raw.tone, 120),
    duty: oneLine(raw.duty, 120),
  };
  const antiJobs = oneLine(raw.antiJobs, 240);
  if (antiJobs) persona.antiJobs = antiJobs;
  const description = oneLine(raw.description, 600);
  if (description) persona.description = description;
  return { ok: true, persona };
}
