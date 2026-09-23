/**
 * 批次 E | 前端引导：对话式建智能体、立刻建好不挡你、第一个智能体自己提议该建哪些同事
 *
 * - 对话式建智能体：用户说"建一个销售助手"→立即建好，不阻塞聊天
 * - 第一个智能体提议同事：新项目只有母鸡时，母鸡自动提议该建哪些同事
 * - 砍掉一切仪表盘：不做仪表盘/指派板，协同进对话流
 *
 * 数据/接口我们做，版式/文案归用户
 */

import type { Pool } from 'pg';
import type { JsonCipher } from '../crypto';
import { currentProjectId } from '../projectScope';
import { ensureAgentConversation } from '../routes/agents';
import { loadProjectRoster } from './roster';

export interface BuildIntent {
  name: string;
  duty: string;
  who?: string;
  tone?: string;
  raw: string;
}

/**
 * 对话式建智能体意图检测
 * 支持：
 * - 建一个销售助手
 * - 创建一个客服，负责处理退款
 * - 我需要一个运营同事，帮我盯店铺数据
 * - 来个设计师
 */
export function detectBuildIntent(message: string): BuildIntent | null {
  const t = message.trim();
  if (!t) return null;

  // 必须包含建/创建/来个/需要等动词 + 助手/同事/智能体/角色（支持客服/销售/运营等短名）
  const buildRe = /(建|创建|新建|来个|来一个|需要|想要|加个|加一个|招个|招一个).{0,12}(助手|同事|智能体|机器人|专员|经理|师|手|员|顾问|管家|客服|销售|运营|开发|设计|产品|测试|调研|写作)/;
  if (!buildRe.test(t)) return null;

  // 排除"我是..."这种自我介绍
  if (/^我是/.test(t) && t.length < 30) return null;

  // 提取名称：建一个XXX助手 → XXX助手
  // 尝试匹配：建一个(XXX)，XXX是2-10字
  let name = '';
  let duty = '';

  // 模式1：建一个XXX，负责YYY
  const m1 = t.match(/(?:建|创建|新建|来个|来一个|需要|想要|加个|加一个|招个|招一个)\s*一个?\s*([^\s，。,.!！?？]{2,12})(?:助手|同事|智能体|机器人|专员|经理)?[，。,.!！]?[，,]?\s*(?:负责|帮我|干|做)?\s*(.+)?/);
  if (m1) {
    name = m1[1].trim();
    duty = (m1[2] ?? '').trim().slice(0, 120);
    // 如果名称里包含"销售"、"客服"等，保留
    if (name.length >= 2) {
      // 如果 duty 为空，用 name 推断 duty
      if (!duty) {
        duty = `${name}相关工作`;
      }
      // 补全名称：如果没有"助手"后缀，加上
      if (!/(助手|同事|专员|经理|师|手|员|顾问)$/.test(name)) {
        // 保留原名，不强制加后缀
      }
      return { name: name.slice(0, 24), duty: duty || `${name}相关工作`, raw: t };
    }
  }

  // 模式2：简单：建一个销售
  const m2 = t.match(/(?:建|创建)\s*一个?\s*([^\s，。,.!！?？]{2,12})/);
  if (m2) {
    name = m2[1].trim();
    if (name.length >= 2 && name.length <= 12) {
      return { name: name.slice(0, 24), duty: `${name}相关工作`, raw: t };
    }
  }

  return null;
}

/**
 * 立刻建好不挡你：对话式建智能体，立即创建，不阻塞
 * 返回新建的 agent
 */
export async function buildAgentImmediately(
  pool: Pool,
  cipher: JsonCipher,
  userId: number,
  projectId: number,
  asAgentId: number,
  intent: BuildIntent,
): Promise<{ agentId: number; name: string; conversationId: number | null }> {
  // 检查项目归属
  const projCheck = await pool.query('SELECT id FROM projects WHERE id=$1 AND user_id=$2', [projectId, userId]);
  if (projCheck.rowCount === 0) throw new Error('项目不存在或不是你的');

  // 检查调用者权限
  const callerCheck = await pool.query('SELECT id, kind, can_create_agents FROM agents WHERE id=$1 AND project_id=$2', [asAgentId, projectId]);
  if (callerCheck.rowCount === 0) throw new Error('调用者不存在');
  const caller = callerCheck.rows[0] as { kind: string; can_create_agents: boolean };
  if (caller.kind !== 'hen' && caller.kind !== 'assistant' && !caller.can_create_agents) {
    throw new Error('该角色不能建智能体');
  }

  // 创建智能体：立刻建好
  const persona = {
    name: intent.name,
    who: intent.who || `一个专注${intent.name}的同事`,
    tone: intent.tone || '简洁、直接',
    duty: intent.duty,
  };

  const ins = await pool.query<{ id: string }>(
    `INSERT INTO agents (project_id, kind, name, persona_enc, can_create_agents)
     VALUES ($1, 'custom', $2, $3, false) RETURNING id`,
    [projectId, intent.name.slice(0, 24), cipher.encryptJson(persona)],
  );
  const agentId = Number(ins.rows[0].id);

  // 立刻给它建一条空会话（不挡你）
  let convId: number | null = null;
  try {
    convId = await ensureAgentConversation(pool, userId, agentId);
  } catch {
    // 会话建失败不影响主流程
  }

  return { agentId, name: intent.name, conversationId: convId };
}

/**
 * 第一个智能体自己提议该建哪些同事
 * 当项目只有母鸡/小助时，母鸡自动提议
 */
export interface ColleagueSuggestion {
  name: string;
  duty: string;
  reason: string;
}

export function proposeColleaguesForProject(projectName: string, existingCount: number): ColleagueSuggestion[] {
  if (existingCount > 1) return []; // 已有多个智能体，不再提议

  const name = projectName.toLowerCase();
  const suggestions: ColleagueSuggestion[] = [];

  // 电商相关
  if (/(电商|店铺|淘宝|天猫|京东|拼多多|抖店|小红书|带货|选品)/.test(projectName)) {
    suggestions.push(
      { name: '运营助手', duty: '盯店铺数据、分析流量转化、优化标题和详情页', reason: '电商项目通常需要运营盯数据' },
      { name: '客服助手', duty: '处理客户咨询、退款、投诉，维护好评率', reason: '客服是电商的基础' },
      { name: '销售助手', duty: '跟进客户、促进成交、维护客户关系', reason: '销售直接关联成交' },
    );
  }
  // 技术/开发
  else if (/(技术|开发|编程|代码|产品|研发|app|网站|系统)/.test(projectName)) {
    suggestions.push(
      { name: '开发助手', duty: '写代码、修bug、做技术调研', reason: '技术项目需要开发' },
      { name: '产品助手', duty: '整理需求、写PRD、跟进进度', reason: '产品是开发的前置' },
      { name: '测试助手', duty: '测功能、写测试用例、提bug', reason: '质量保障' },
    );
  }
  // 内容/写作
  else if (/(内容|写作|文案|运营|自媒体|公众号|写作|编辑)/.test(projectName)) {
    suggestions.push(
      { name: '写作助手', duty: '写文章、改文案、做内容策划', reason: '内容项目核心是写作' },
      { name: '审校助手', duty: '审稿、改错、优化表达', reason: '提升内容质量' },
    );
  }
  // 默认：通用型提议
  else {
    suggestions.push(
      { name: '调研助手', duty: '搜资料、做调研、整理信息', reason: '帮你快速了解一个领域' },
      { name: '整理助手', duty: '整理文档、做总结、建知识库', reason: '把信息变得有序' },
      { name: '执行助手', duty: '执行具体任务、操作浏览器、完成待办', reason: '把想法落地' },
    );
  }

  return suggestions.slice(0, 3);
}

/**
 * 为新项目母鸡自动写入一条提议同事的消息（进对话流，不弹仪表盘）
 */
export async function seedColleagueProposal(
  pool: Pool,
  cipher: JsonCipher,
  userId: number,
  projectId: number,
  projectName: string,
  henAgentId: number,
): Promise<void> {
  try {
    const roster = await loadProjectRoster(pool, userId, projectId, null);
    if (roster.length > 1) return; // 已有多个，不再提议

    const suggestions = proposeColleaguesForProject(projectName, roster.length);
    if (suggestions.length === 0) return;

    const convId = await ensureAgentConversation(pool, userId, henAgentId);
    if (!convId) return;

    const text = `我是项目管家，刚为项目「${projectName}」就位。\n\n看了项目名字，我建议先建这几位同事，立刻就能帮你干活（对话里说"建一个XXX"就建好，不挡你）：\n\n${suggestions.map((s, i) => `${i + 1}. **${s.name}**：${s.duty}（${s.reason}）`).join('\n')}\n\n你直接说"建一个${suggestions[0].name}"或"把${suggestions.map((s) => s.name).join('、')}都建了"，我立刻建好。`;

    await pool.query("INSERT INTO messages (conversation_id, role, content_enc) VALUES ($1, 'assistant', $2)", [
      convId,
      cipher.encryptText(text),
    ]);
  } catch (err) {
    console.warn('[agentBuilder] 提议同事失败（忽略）：', (err as Error).message);
  }
}
