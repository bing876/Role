/**
 * 批次 F | Skills 工具 — teach_skill / revise_skill
 *
 * 让 agent 在执行完任务后能自我修订技能，或在对话中直接教一个新技能
 * 注册为 side='server' 工具，执行器直接写库
 */

import type { ToolDefinition, LoopToolResult } from '@ai-workbench/shared';
import { registerServerTool, type ServerExecutionContext } from '../toolRegistry';
import { orchestratorDeps } from './tools';
import { createSkill, reviseSkill } from './skills';

export const TEACH_SKILL_TOOL: ToolDefinition = {
  name: 'teach_skill',
  description: [
    '教一个可复用的技能（teach-a-task），落成 skills 表，下次命中触发条件时自动注入。',
    '【何时用】用户说“以后都这样做”“把这个流程记下来”或你发现一个可复用的固定流程时。',
    '【字段】name(≤60字) 技能名，trigger_condition(≤500字) 触发条件，steps(1~20条) 步骤，',
    'decision_rules(≤1000字) 决策规则，output_requirements(≤1000字) 产出要求，approval_boundary(≤1000字) 审批边界。',
    '【注意】触发条件要写具体关键词，便于下次命中；步骤要可执行，不要写“看情况”。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名，≤60字' },
      trigger_condition: { type: 'string', description: '触发条件，≤500字，写关键词' },
      steps: { type: 'array', items: { type: 'string' }, description: '步骤列表，1~20条' },
      decision_rules: { type: 'string', description: '决策规则，≤1000字' },
      output_requirements: { type: 'string', description: '产出要求，≤1000字' },
      approval_boundary: { type: 'string', description: '审批边界，≤1000字' },
    },
    required: ['name', 'trigger_condition', 'steps'],
  },
  side: 'server',
  kind: 'action',
  timeoutMs: 15000,
  validate: (args) => {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    const trigger = typeof args.trigger_condition === 'string' ? args.trigger_condition.trim() : '';
    const steps = Array.isArray(args.steps) ? (args.steps as unknown[]).map((x) => String(x).trim()).filter(Boolean) : [];
    if (!name || name.length > 60) return { ok: false, reason: 'bad_args', question: '技能名必填且≤60字' };
    if (!trigger || trigger.length > 500) return { ok: false, reason: 'bad_args', question: '触发条件必填且≤500字' };
    if (steps.length === 0 || steps.length > 20) return { ok: false, reason: 'bad_args', question: '步骤必填 1~20 条' };
    return { ok: true, args: { name, trigger_condition: trigger, steps, decision_rules: args.decision_rules, output_requirements: args.output_requirements, approval_boundary: args.approval_boundary } };
  },
};

export const REVISE_SKILL_TOOL: ToolDefinition = {
  name: 'revise_skill',
  description: [
    '修订一个已有技能（自我修订），跑完任务后根据实际执行情况更新步骤/规则/产出要求。',
    '【何时用】技能执行完发现步骤不准、缺审批边界、产出要求不对时，立刻修订，下次更准。',
    '【字段】skill_id 必填，其余为可选覆盖：trigger_condition, steps, decision_rules, output_requirements, approval_boundary。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      skill_id: { type: 'number', description: '要修订的技能 ID' },
      trigger_condition: { type: 'string', description: '新触发条件，≤500字' },
      steps: { type: 'array', items: { type: 'string' }, description: '新步骤列表' },
      decision_rules: { type: 'string', description: '新决策规则' },
      output_requirements: { type: 'string', description: '新产出要求' },
      approval_boundary: { type: 'string', description: '新审批边界' },
    },
    required: ['skill_id'],
  },
  side: 'server',
  kind: 'action',
  timeoutMs: 15000,
  validate: (args) => {
    const id = Number(args.skill_id);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: 'bad_args', question: 'skill_id 必须是正整数' };
    return { ok: true, args: { skill_id: id, trigger_condition: args.trigger_condition, steps: args.steps, decision_rules: args.decision_rules, output_requirements: args.output_requirements, approval_boundary: args.approval_boundary } };
  },
};

async function executeTeachSkill(args: Record<string, unknown>, ctx: ServerExecutionContext): Promise<LoopToolResult> {
  try {
    const { pool, cipher } = orchestratorDeps();
    const skill = await createSkill(pool, cipher, {
      userId: ctx.userId,
      projectId: null,
      agentId: ctx.agentId ?? null,
      name: String(args.name),
      triggerCondition: String(args.trigger_condition),
      steps: (args.steps as string[]) ?? [],
      decisionRules: typeof args.decision_rules === 'string' ? args.decision_rules : undefined,
      outputRequirements: typeof args.output_requirements === 'string' ? args.output_requirements : undefined,
      approvalBoundary: typeof args.approval_boundary === 'string' ? args.approval_boundary : undefined,
    });
    if (!skill) return { ok: false, error: 'create_failed', detail: '创建技能失败' };
    return { ok: true, detail: `已学会技能「${skill.name}」v${skill.version}，触发：${skill.triggerCondition}`, data: { skillId: skill.id, name: skill.name } };
  } catch (err) {
    return { ok: false, error: 'teach_failed', detail: `教技能失败：${(err as Error).message}` };
  }
}

async function executeReviseSkill(args: Record<string, unknown>, ctx: ServerExecutionContext): Promise<LoopToolResult> {
  try {
    const { pool, cipher } = orchestratorDeps();
    const patch: any = {};
    if (typeof args.trigger_condition === 'string') patch.triggerCondition = args.trigger_condition;
    if (Array.isArray(args.steps)) patch.steps = args.steps;
    if (typeof args.decision_rules === 'string') patch.decisionRules = args.decision_rules;
    if (typeof args.output_requirements === 'string') patch.outputRequirements = args.output_requirements;
    if (typeof args.approval_boundary === 'string') patch.approvalBoundary = args.approval_boundary;
    const skill = await reviseSkill(pool, cipher, ctx.userId, Number(args.skill_id), patch);
    if (!skill) return { ok: false, error: 'not_found', detail: '技能不存在或不是你的' };
    return { ok: true, detail: `已修订技能「${skill.name}」到 v${skill.version}`, data: { skillId: skill.id, version: skill.version } };
  } catch (err) {
    return { ok: false, error: 'revise_failed', detail: `修订失败：${(err as Error).message}` };
  }
}

export function registerSkillTools(): void {
  try {
    registerServerTool(TEACH_SKILL_TOOL, { execute: executeTeachSkill });
    registerServerTool(REVISE_SKILL_TOOL, { execute: executeReviseSkill });
    console.log('[skills] 已注册 teach_skill / revise_skill');
  } catch (err) {
    console.warn('[skills] 注册技能工具失败（忽略）：', (err as Error).message);
  }
}
