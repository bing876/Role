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
 * - G4：成功且用过工具的任务自动录成 pending 技能（工具序列+触发条件+决策要点），
 *   对话流转确认卡，用户 POST /skills/confirm 才 active（rejected=用户明确不要）
 *
 * 反证：
 * - 无触发条件匹配 → 不注入（回落普通聊天）
 * - 触发但已 archived → 不注入
 * - 触发但 pending → 不注入（没确认 = 永不影响行为，同 memories 口径）
 */

import type { Pool } from 'pg';
import type { JsonCipher } from '../crypto';
import { REFERENCE_PREFIX, sanitizeReferenceLine } from '../promptPolicy';
import { normalizeText } from '../memoryNormalize';
import { writeCollabToProjectChat } from './collabChat';

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
  /** G4 起：pending=自动录制待确认（不注入）/ rejected=用户明确不要（不注入）/ archived=归档 */
  status: 'active' | 'archived' | 'pending' | 'rejected';
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
    /** G4：自动录制的技能先落 pending（不注入），用户确认后才 active。手动教学照旧直接 active。 */
    status?: 'active' | 'pending';
  },
): Promise<SkillView | null> {
  const name = input.name.trim().slice(0, 60);
  const trigger = input.triggerCondition.trim().slice(0, 500);
  if (!name || !trigger) return null;
  const steps = (input.steps ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
  const decision = (input.decisionRules ?? '').trim().slice(0, 1000);
  const output = (input.outputRequirements ?? '').trim().slice(0, 1000);
  const approval = (input.approvalBoundary ?? '').trim().slice(0, 1000);
  const status = input.status === 'pending' ? 'pending' : 'active';

  const triggerEnc = cipher.encryptText(trigger);
  const stepsEnc = cipher.encryptText(JSON.stringify(steps));
  const decisionEnc = decision ? cipher.encryptText(decision) : null;
  const outputEnc = output ? cipher.encryptText(output) : null;
  const approvalEnc = approval ? cipher.encryptText(approval) : null;

  const r = await pool.query<SkillRow>(
    `INSERT INTO skills (user_id, project_id, agent_id, name, trigger_condition, trigger_enc, steps_enc, decision_rules_enc, output_requirements_enc, approval_boundary_enc, status, version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)
     RETURNING *`,
    [input.userId, input.projectId ?? null, input.agentId ?? null, name, trigger, triggerEnc, stepsEnc, decisionEnc, outputEnc, approvalEnc, status],
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

/**
 * G4 | pending 技能的确认 / 拒绝（同 memories confirm|reject 口径）
 *
 * - 只动**自己**的、**当前是 pending** 的行（重复确认/别人先点了/已归档 → 0 行,如实报 404）
 * - confirm → active（此后 buildSkillBlock 才会按 trigger 注入）
 * - reject  → rejected（留痕不删：用户明确说不要,但保留记录;rejected 永不注入）
 */
export async function decidePendingSkill(
  pool: Pool,
  userId: number,
  skillId: number,
  target: 'active' | 'rejected',
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE skills SET status=$2, updated_at=now() WHERE id=$1 AND user_id=$3 AND status='pending'`,
    [skillId, target, userId],
  );
  return (r.rowCount ?? 0) === 1;
}

/**
 * G4 | 把「成功且用过工具」的任务录成 pending 技能（不静默生效）
 *
 * 内容口径（最小版,全走 skills 表现有字段,敏感字段密文）：
 * - trigger_condition = 任务目标 goal（明文列只用于字面匹配,同 skills 表现有约定;密文进 trigger_enc）
 * - steps            = 任务的步骤账本（**工具序列**：driver 每执行一次工具记一条「步 N：…」）
 * - decision_rules   = 驾驶员 done 结论（决策要点;走 finish 时才有）
 * - output           = 结果文档标题（产出要求,能对上「当时要的是什么」）
 *
 * 「用过工具」判定：steps 里至少有一条 `步 N：`（driver 工具执行记账格式）。
 * 只有「收尾：…」没有工具步的任务（没真正动手）不录。
 *
 * 闸：
 * - 落 **pending**：buildSkillBlock/listSkills 只认 active,没确认永不注入、永不影响行为;
 * - 同 user + 同 project + 同 trigger 已有 pending/active → 不重复录（重复跑同任务不刷屏）;
 * - 落库后往**项目主会话**写一张【协同·技能】确认卡（复用 collabChat,纯服务端）;
 * - 任何一步失败只 warn —— 录技能是锦上添花,绝不能拖垮任务 done 本身。
 *
 * 返回 null 表示没录（没工具步/目标为空/重复/落库失败）,调用方不感知细节。
 */
export async function recordTaskAsPendingSkill(
  pool: Pool,
  cipher: JsonCipher,
  input: {
    userId: number;
    projectId: number;
    taskId: number;
    /** 解密后的任务目标（明文;触发条件来源） */
    goal: string;
    /** 任务步骤账本（payload.steps） */
    steps: string[];
    /** 驾驶员 done 结论（决策要点;可缺） */
    doneSummary?: string;
    /** 结果文档标题（可缺） */
    docTitle?: string;
  },
): Promise<{ skillId: number; name: string; toolStepCount: number } | null> {
  try {
    const goal = input.goal.trim();
    if (!goal) return null;
    // 「用过工具」闸：至少一条工具执行步（driver 记账格式「步 N：…」）
    const toolStepCount = input.steps.filter((s) => /^步 \d+：/.test(s)).length;
    if (toolStepCount === 0) return null;

    const name = goal.slice(0, 60);
    const trigger = goal.slice(0, 500);

    // 去重闸：同 user + 同 project + 同 trigger 已有 pending/active → 不再录第二张卡
    const dup = await pool.query(
      `SELECT 1 FROM skills WHERE user_id=$1 AND project_id=$2 AND trigger_condition=$3 AND status IN ('pending','active') LIMIT 1`,
      [input.userId, input.projectId, trigger],
    );
    if ((dup.rowCount ?? 0) > 0) return null;

    const skill = await createSkill(pool, cipher, {
      userId: input.userId,
      projectId: input.projectId,
      name,
      triggerCondition: trigger,
      steps: input.steps,
      decisionRules: input.doneSummary,
      outputRequirements: input.docTitle,
      status: 'pending',
    });
    if (!skill) return null;

    // 确认卡：进项目主会话（纯服务端,前端按【协同·技能】前缀渲染折叠卡）
    await writeCollabToProjectChat(pool, cipher, input.projectId, {
      kind: 'skill',
      fromId: 0,
      fromName: '任务记录',
      toId: 0,
      toName: '',
      detail:
        `任务 #${input.taskId}「${name}」完成（用了 ${toolStepCount} 步工具）。` +
        `要把这次存成技能吗？确认后会注入同类任务；拒绝则丢弃。（待确认技能 #${skill.id}，接口 POST /skills/confirm {"id":${skill.id}}）`,
      status: 'pending',
    });

    return { skillId: skill.id, name: skill.name, toolStepCount };
  } catch (err) {
    console.warn('[skills] G4 任务技能录制失败（忽略,不影响任务完成）：', (err as Error).message);
    return null;
  }
}
