/**
 * 批次 F | Skills — teach-a-task 落成 skills 表
 *
 * 触发条件+步骤+决策规则+产出要求+审批边界，命中时注入 identityBlock 已留好的技能槽，跑完能自我修订
 *
 * 设计：
 * - skills 表：name, trigger_condition(明文用于匹配), steps_enc, decision_rules_enc, output_requirements_enc, approval_boundary_enc, status, version, usage_count
 * - 加密：所有敏感字段走 JsonCipher.encryptText，与 messages 同一套
 * - 命中：buildSkillBlock 按 trigger_condition 关键词匹配当前用户消息，命中时注入
 * - 注入位置：identityBlock 已留好的技能槽（buildIdentityBlock 追加 skillBlock）
 * - 自我修订：usage_count + last_used_at 更新；reviseSkill 接口允许 agent 或用户在跑完后修订
 *
 * 反证：
 * - 无触发条件匹配 → 不注入（回落普通聊天）
 * - 触发但已 archived → 不注入
 */

import type { Pool } from 'pg';
import type { JsonCipher } from '../crypto';
import { REFERENCE_PREFIX, sanitizeReferenceLine } from '../promptPolicy';
import { normalizeText } from '../memoryNormalize';

export interface SkillRow {
  id: string;
  user_id: string;
  project_id: string | null;
  agent_id: string | null;
  name: string;
  trigger_condition: string;
  trigger_enc: string | null;
  steps_enc: string | null;
  decision_rules_enc: string | null;
  output_requirements_enc: string | null;
  approval_boundary_enc: string | null;
  status: string;
  version: string;
  usage_count: string;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillView {
  id: number;
  userId: number;
  projectId: number | null;
  agentId: number | null;
  name: string;
  triggerCondition: string;
  steps: string[];
  decisionRules: string;
  outputRequirements: string;
  approvalBoundary: string;
  status: 'active' | 'archived';
  version: number;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function safeDecrypt(cipher: JsonCipher, enc: string | null): string {
  if (!enc) return '';
  try {
    return cipher.decryptText(enc);
  } catch {
    return '';
  }
}

function safeDecryptJson(cipher: JsonCipher, enc: string | null): string[] {
  if (!enc) return [];
  try {
    const txt = cipher.decryptText(enc);
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

export function toSkillView(row: SkillRow, cipher: JsonCipher): SkillView | null {
  try {
    // 优先解密，兼容明文 trigger_condition
    const trigger = safeDecrypt(cipher, row.trigger_enc) || row.trigger_condition || '';
    const steps = safeDecryptJson(cipher, row.steps_enc);
    const decision = safeDecrypt(cipher, row.decision_rules_enc);
    const output = safeDecrypt(cipher, row.output_requirements_enc);
    const approval = safeDecrypt(cipher, row.approval_boundary_enc);
    return {
      id: Number(row.id),
      userId: Number(row.user_id),
      projectId: row.project_id ? Number(row.project_id) : null,
      agentId: row.agent_id ? Number(row.agent_id) : null,
      name: row.name,
      triggerCondition: trigger,
      steps,
      decisionRules: decision,
      outputRequirements: output,
      approvalBoundary: approval,
      status: row.status as any,
      version: Number(row.version ?? 1),
      usageCount: Number(row.usage_count ?? 0),
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

export async function listSkills(pool: Pool, cipher: JsonCipher, userId: number, projectId: number | null): Promise<SkillView[]> {
  const q = projectId !== null
    ? await pool.query<SkillRow>('SELECT * FROM skills WHERE user_id=$1 AND (project_id=$2 OR project_id IS NULL) AND status=$3 ORDER BY updated_at DESC LIMIT 50', [userId, projectId, 'active'])
    : await pool.query<SkillRow>('SELECT * FROM skills WHERE user_id=$1 AND status=$2 ORDER BY updated_at DESC LIMIT 50', [userId, 'active']);
  return q.rows.map((r) => toSkillView(r, cipher)).filter((x): x is SkillView => x !== null);
}

export async function createSkill(
  pool: Pool,
  cipher: JsonCipher,
  input: {
    userId: number;
    projectId?: number | null;
    agentId?: number | null;
    name: string;
    triggerCondition: string;
    steps: string[];
    decisionRules?: string;
    outputRequirements?: string;
    approvalBoundary?: string;
  },
): Promise<SkillView | null> {
  const name = input.name.trim().slice(0, 60);
  const trigger = input.triggerCondition.trim().slice(0, 500);
  if (!name || !trigger) return null;
  const steps = (input.steps ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
  const decision = (input.decisionRules ?? '').trim().slice(0, 1000);
  const output = (input.outputRequirements ?? '').trim().slice(0, 1000);
  const approval = (input.approvalBoundary ?? '').trim().slice(0, 1000);

  const triggerEnc = cipher.encryptText(trigger);
  const stepsEnc = cipher.encryptText(JSON.stringify(steps));
  const decisionEnc = decision ? cipher.encryptText(decision) : null;
  const outputEnc = output ? cipher.encryptText(output) : null;
  const approvalEnc = approval ? cipher.encryptText(approval) : null;

  const r = await pool.query<SkillRow>(
    `INSERT INTO skills (user_id, project_id, agent_id, name, trigger_condition, trigger_enc, steps_enc, decision_rules_enc, output_requirements_enc, approval_boundary_enc, status, version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',1)
     RETURNING *`,
    [input.userId, input.projectId ?? null, input.agentId ?? null, name, trigger, triggerEnc, stepsEnc, decisionEnc, outputEnc, approvalEnc],
  );
  return toSkillView(r.rows[0], cipher);
}

export async function reviseSkill(
  pool: Pool,
  cipher: JsonCipher,
  userId: number,
  skillId: number,
  patch: {
    triggerCondition?: string;
    steps?: string[];
    decisionRules?: string;
    outputRequirements?: string;
    approvalBoundary?: string;
  },
): Promise<SkillView | null> {
  const cur = await pool.query<SkillRow>('SELECT * FROM skills WHERE id=$1 AND user_id=$2', [skillId, userId]);
  if (cur.rowCount === 0) return null;
  const row = cur.rows[0];
  const current = toSkillView(row, cipher);
  if (!current) return null;

  const trigger = patch.triggerCondition !== undefined ? patch.triggerCondition.trim().slice(0, 500) : current.triggerCondition;
  const steps = patch.steps !== undefined ? patch.steps.map((s) => String(s).trim()).filter(Boolean).slice(0, 20) : current.steps;
  const decision = patch.decisionRules !== undefined ? patch.decisionRules.trim().slice(0, 1000) : current.decisionRules;
  const output = patch.outputRequirements !== undefined ? patch.outputRequirements.trim().slice(0, 1000) : current.outputRequirements;
  const approval = patch.approvalBoundary !== undefined ? patch.approvalBoundary.trim().slice(0, 1000) : current.approvalBoundary;

  const triggerEnc = cipher.encryptText(trigger);
  const stepsEnc = cipher.encryptText(JSON.stringify(steps));
  const decisionEnc = decision ? cipher.encryptText(decision) : null;
  const outputEnc = output ? cipher.encryptText(output) : null;
  const approvalEnc = approval ? cipher.encryptText(approval) : null;

  const r = await pool.query<SkillRow>(
    `UPDATE skills SET trigger_condition=$2, trigger_enc=$3, steps_enc=$4, decision_rules_enc=$5, output_requirements_enc=$6, approval_boundary_enc=$7, version=version+1, updated_at=now()
     WHERE id=$1 AND user_id=$8 RETURNING *`,
    [skillId, trigger, triggerEnc, stepsEnc, decisionEnc, outputEnc, approvalEnc, userId],
  );
  if (r.rowCount === 0) return null;
  return toSkillView(r.rows[0], cipher);
}

export async function archiveSkill(pool: Pool, userId: number, skillId: number): Promise<boolean> {
  const r = await pool.query(`UPDATE skills SET status='archived', updated_at=now() WHERE id=$1 AND user_id=$2 AND status='active'`, [skillId, userId]);
  return (r.rowCount ?? 0) === 1;
}

export async function touchSkillUsage(pool: Pool, skillId: number): Promise<void> {
  try {
    await pool.query(`UPDATE skills SET usage_count=usage_count+1, last_used_at=now(), updated_at=now() WHERE id=$1`, [skillId]);
  } catch {}
}

/**
 * 技能匹配与注入块
 * 按 trigger_condition 关键词匹配当前用户消息（简单字面匹配，后续批次 G 可升级为语义检索）
 * 命中时返回结构化块，注入到 identityBlock 技能槽
 */
export async function buildSkillBlock(pool: Pool, cipher: JsonCipher, userId: number, projectId: number | null, currentMessage: string): Promise<{ block: string; matched: SkillView[] }> {
  try {
    const skills = await listSkills(pool, cipher, userId, projectId);
    if (skills.length === 0) return { block: '', matched: [] };
    const msgLower = currentMessage.toLowerCase();
    const matched: SkillView[] = [];
    for (const s of skills) {
      const triggerLower = s.triggerCondition.toLowerCase();
      // 简单匹配：触发条件中的关键词出现在消息中，或消息包含技能名
      const triggerWords = triggerLower.split(/[,，\s]+/).filter((w) => w.length >= 2);
      const hit = triggerWords.some((w) => msgLower.includes(w)) || msgLower.includes(s.name.toLowerCase());
      if (hit) matched.push(s);
    }
    if (matched.length === 0) return { block: '', matched: [] };
    // 最多注入 2 个技能，避免上下文过长
    const top = matched.slice(0, 2);
    const lines: string[] = [];
    lines.push('【已命中技能·teach-a-task（按触发条件匹配，注入 identityBlock 技能槽）】');
    lines.push(REFERENCE_PREFIX);
    for (const s of top) {
      lines.push(`技能「${s.name}」v${s.version}（触发：${sanitizeReferenceLine(s.triggerCondition)}）：`);
      if (s.steps.length > 0) {
        lines.push(`- 步骤：${s.steps.map((st, i) => `${i + 1}. ${sanitizeReferenceLine(st)}`).join('；')}`);
      }
      if (s.decisionRules) lines.push(`- 决策规则：${sanitizeReferenceLine(s.decisionRules)}`);
      if (s.outputRequirements) lines.push(`- 产出要求：${sanitizeReferenceLine(s.outputRequirements)}`);
      if (s.approvalBoundary) lines.push(`- 审批边界：${sanitizeReferenceLine(s.approvalBoundary)}`);
      lines.push(`- （使用 ${s.usageCount} 次，自我修订：跑完后可调用 revise_skill 更新）`);
    }
    // 更新使用计数（异步，不阻塞）
    for (const s of top) {
      void touchSkillUsage(pool, s.id);
    }
    return { block: lines.join('\n'), matched: top };
  } catch (err) {
    console.warn('[skills] 注入块拼装失败（忽略）：', (err as Error).message);
    return { block: '', matched: [] };
  }
}
