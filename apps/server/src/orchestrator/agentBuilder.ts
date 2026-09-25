/**
 * 批次 E | 前端引导：对话式建智能体、立刻建好不挡你、第一个智能体自己提议该建哪些同事
 * 修 4：对话式建智能体加兜底——无关键词匹配必须回落 LLM 正常路径
 * 反证:不含关键词的描述必须走 LLM;含「建一个」的普通问句不能建出 agent
 * 2026-09-25 用户重拍(QA-02):修 4 的"先确认再建"撤掉——用户说"建一个销售助手"
 * **一次就建好**,回一句"已建好…",不挡你(二次确认是折中:既不立刻也不三问;
 * 三问引导表留阶段 2)。
 *
 * - 对话式建智能体：用户说"建一个销售助手"→ 立刻建好，不阻塞聊天
 * - 兜底：无关键词匹配回落 LLM；含「建一个」的问句（是什么/怎么建）不建
 * - 第一个智能体提议同事：新项目只有母鸡时，母鸡自动提议该建哪些同事
 * - 砍掉一切仪表盘：不做仪表盘/指派板，协同进对话流
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
 * (2026-09-25 撤)修 4 曾在这里放"待确认意图"内存表 + 确认消息检测的两步确认流;
 * 用户重拍后**说一次就建好**,那套机制整段删除——留着就是死代码。
 * (注释里不写旧函数名:self-check-fixes 按字符串钉"不许回来")
 */

/**
 * 修 4 反证：含「建一个」的普通问句不能建出 agent
 * 检测是否为关于建智能体的疑问句，而非建的意图
 */
export function isQuestionAboutBuilding(message: string): boolean {
  const t = message.trim();
  // 问句特征：是什么/什么意思/怎么建/如何建/为什么/吗/？/?
  if (/(是什么|什么意思|怎么建|如何建|为什么|吗|什么意思|解释一下|介绍一下)/.test(t)) return true;
  if (/建一个.*(是什么|什么意思|吗|？|\?)/.test(t)) return true;
  // 纯询问：建一个智能体是什么意思
  if (/建.*(是什么意思|是什么|怎么)/.test(t)) return true;
  // 以疑问词结尾
  if (/[？?]$/.test(t) && /建/.test(t)) return true;
  return false;
}

/**
 * 对话式建智能体意图检测（修 4 加兜底）
 * 支持：
 * - 建一个销售助手
 * - 创建一个客服，负责处理退款
 * - 我需要一个运营同事，帮我盯店铺数据
 * - 来个设计师
 *
 * 反证：
 * - 不含关键词的描述必须走 LLM（返回 null）
 * - 含「建一个」的普通问句不能建（isQuestionAboutBuilding 拦截）
 */
export function detectBuildIntent(message: string): BuildIntent | null {
  const t = message.trim();
  if (!t) return null;

  // 修 4：先排除问句（反证：含「建一个」的普通问句不能建出 agent）
  if (isQuestionAboutBuilding(t)) return null;

  // 必须包含建/创建/来个/需要等动词 + 助手/同事/智能体/角色（支持客服/销售/运营等短名）
  const buildRe = /(建|创建|新建|来个|来一个|需要|想要|加个|加一个|招个|招一个).{0,12}(助手|同事|智能体|机器人|专员|经理|师|手|员|顾问|管家|客服|销售|运营|开发|设计|产品|测试|调研|写作)/;
  if (!buildRe.test(t)) return null;

  // 排除"我是..."这种自我介绍
  if (/^我是/.test(t) && t.length < 30) return null;

  // 排除过短或纯闲聊：必须有明确的建的动作，且名称>=2
  // 修 4：无关键词匹配必须回落 LLM（此处关键词即建+角色，若无则返回 null 走 LLM）
  if (t.length < 4) return null;

  let name = '';
  let duty = '';

  // 模式1：建一个XXX，负责YYY
  const m1 = t.match(/(?:建|创建|新建|来个|来一个|需要|想要|加个|加一个|招个|招一个)\s*一个?\s*([^\s，。,.!！?？]{2,12})(?:助手|同事|智能体|机器人|专员|经理)?[，。,.!！]?[，,]?\s*(?:负责|帮我|干|做)?\s*(.+)?/);
  if (m1) {
    name = m1[1].trim();
    duty = (m1[2] ?? '').trim().slice(0, 120);
    if (name.length >= 2) {
      if (!duty) {
        duty = `${name}相关工作`;
      }
      // 修 4：确认名称不是疑问词
      if (/(什么|怎么|为什么|如何|吗)/.test(name)) return null;
      return { name: name.slice(0, 24), duty: duty || `${name}相关工作`, raw: t };
    }
  }

  // 模式2：简单：建一个销售
  const m2 = t.match(/(?:建|创建)\s*一个?\s*([^\s，。,.!！?？]{2,12})/);
  if (m2) {
    name = m2[1].trim();
    if (name.length >= 2 && name.length <= 12) {
      if (/(什么|怎么|为什么|如何|吗|意思)/.test(name)) return null;
      return { name: name.slice(0, 24), duty: `${name}相关工作`, raw: t };
    }
  }

  return null;
}

/**
 * 立刻建好不挡你：对话式建智能体，立即创建，不阻塞
 * (2026-09-25 起:命中 detectBuildIntent 就直接调这个,没有中间确认)
 */
export async function buildAgentImmediately(
  pool: Pool,
  cipher: JsonCipher,
  userId: number,
  projectId: number,
  asAgentId: number,
  intent: BuildIntent,
): Promise<{ agentId: number; name: string; conversationId: number | null }> {
  const projCheck = await pool.query('SELECT id FROM projects WHERE id=$1 AND user_id=$2', [projectId, userId]);
  if (projCheck.rowCount === 0) throw new Error('项目不存在或不是你的');

  const callerCheck = await pool.query('SELECT id, kind, can_create_agents FROM agents WHERE id=$1 AND project_id=$2', [asAgentId, projectId]);
  if (callerCheck.rowCount === 0) throw new Error('调用者不存在');
  const caller = callerCheck.rows[0] as { kind: string; can_create_agents: boolean };
  if (caller.kind !== 'hen' && caller.kind !== 'assistant' && !caller.can_create_agents) {
    throw new Error('该角色不能建智能体');
  }

  const persona = {
    name: intent.name,
    who: intent.who || `一个专注${intent.name}的同事`,
    tone: intent.tone || '简洁、直接',
    duty: intent.duty,
  };

  const ins = await pool.query<{ id: string }>(
    `INSERT INTO agents (project_id, kind, name, persona, persona_status, can_create_agents)
     VALUES ($1, 'custom', $2, $3, 'ready', false) RETURNING id`,
    [projectId, intent.name.slice(0, 24), JSON.stringify(persona)],
  );
  const agentId = Number(ins.rows[0].id);

  let convId: number | null = null;
  try {
    convId = await ensureAgentConversation(pool, userId, agentId);
  } catch {}

  return { agentId, name: intent.name, conversationId: convId };
}

export interface ColleagueSuggestion {
  name: string;
  duty: string;
  reason: string;
}

export function proposeColleaguesForProject(projectName: string, existingCount: number): ColleagueSuggestion[] {
  if (existingCount > 1) return [];

  const suggestions: ColleagueSuggestion[] = [];

  if (/(电商|店铺|淘宝|天猫|京东|拼多多|抖店|小红书|带货|选品)/.test(projectName)) {
    suggestions.push(
      { name: '运营助手', duty: '盯店铺数据、分析流量转化、优化标题和详情页', reason: '电商项目通常需要运营盯数据' },
      { name: '客服助手', duty: '处理客户咨询、退款、投诉，维护好评率', reason: '客服是电商的基础' },
      { name: '销售助手', duty: '跟进客户、促进成交、维护客户关系', reason: '销售直接关联成交' },
    );
  } else if (/(技术|开发|编程|代码|产品|研发|app|网站|系统)/.test(projectName)) {
    suggestions.push(
      { name: '开发助手', duty: '写代码、修bug、做技术调研', reason: '技术项目需要开发' },
      { name: '产品助手', duty: '整理需求、写PRD、跟进进度', reason: '产品是开发的前置' },
      { name: '测试助手', duty: '测功能、写测试用例、提bug', reason: '质量保障' },
    );
  } else if (/(内容|写作|文案|运营|自媒体|公众号|写作|编辑)/.test(projectName)) {
    suggestions.push(
      { name: '写作助手', duty: '写文章、改文案、做内容策划', reason: '内容项目核心是写作' },
      { name: '审校助手', duty: '审稿、改错、优化表达', reason: '提升内容质量' },
    );
  } else {
    suggestions.push(
      { name: '调研助手', duty: '搜资料、做调研、整理信息', reason: '帮你快速了解一个领域' },
      { name: '整理助手', duty: '整理文档、做总结、建知识库', reason: '把信息变得有序' },
      { name: '执行助手', duty: '执行具体任务、操作浏览器、完成待办', reason: '把想法落地' },
    );
  }

  return suggestions.slice(0, 3);
}

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
    if (roster.length > 1) return;

    const suggestions = proposeColleaguesForProject(projectName, roster.length);
    if (suggestions.length === 0) return;

    const convId = await ensureAgentConversation(pool, userId, henAgentId);
    if (!convId) return;

    const text = `我是项目管家，刚为项目「${projectName}」就位。

看了项目名字，我建议先建这几位同事，立刻就能帮你干活（对话里说"建一个XXX"就建好，不挡你）：

${suggestions.map((s, i) => `${i + 1}. **${s.name}**：${s.duty}（${s.reason}）`).join('\n')}

你直接说"建一个${suggestions[0].name}"或"把${suggestions.map((s) => s.name).join('、')}都建了"，我立刻建好。`;

    await pool.query("INSERT INTO messages (conversation_id, role, content_enc) VALUES ($1, 'assistant', $2)", [
      convId,
      cipher.encryptText(text),
    ]);
  } catch (err) {
    console.warn('[agentBuilder] 提议同事失败（忽略）：', (err as Error).message);
  }
}
