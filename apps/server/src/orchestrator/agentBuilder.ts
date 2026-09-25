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

  // 排除"我是..."这种自我介绍
  if (/^我是/.test(t) && t.length < 30) return null;

  // 排除过短或纯闲聊：必须有明确的建的动作，且名称>=2
  // 修 4：无关键词匹配必须回落 LLM（此处关键词即建+角色，若无则返回 null 走 LLM）
  if (t.length < 4) return null;

  // 必须包含建/创建/来个/需要等动词 + 助手/同事/智能体/角色（支持客服/销售/运营等短名）
  const buildRe = /(建|创建|新建|来个|来一个|需要|想要|加个|加一个|招个|招一个).{0,12}(助手|同事|智能体|机器人|专员|经理|师|手|员|顾问|管家|客服|销售|运营|开发|设计|产品|测试|调研|写作)/;

  if (buildRe.test(t)) {
    let name = '';
    let duty = '';

    // 模式1：建一个XXX，负责YYY（量词「一个 / 个」整体可选 —— 旧的 `一个?` 把「一」写成必填,
    // 「建个老王 / 来个设计师」这类没带「一」的说法全被漏掉）
    const m1 = t.match(/(?:建|创建|新建|来个|来一个|需要|想要|加个|加一个|招个|招一个)\s*(?:一个|个)?\s*([^\s，。,.!！?？]{2,12})(?:助手|同事|智能体|机器人|专员|经理)?[，。,.!！]?[，,]?\s*(?:负责|帮我|干|做)?\s*(.+)?/);
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

    // 模式2：简单：建一个销售（量词同模式 1 的修正）
    const m2 = t.match(/(?:建|创建|新建|来个|来一个|加个|加一个|招个|招一个|需要|想要)\s*(?:一个|个)?\s*([^\s，。,.!！?？]{2,12})/);
    if (m2) {
      name = m2[1].trim();
      if (name.length >= 2 && name.length <= 12) {
        if (/(什么|怎么|为什么|如何|吗|意思)/.test(name)) return null;
        return { name: name.slice(0, 24), duty: `${name}相关工作`, raw: t };
      }
    }
  }

  // ★ 产品交互规格 C1（2026-09-25）：说「建/创建 XXX」→ XXX 是**任意名字**（小美/老王…），
  //   不再要求名字里带角色词。名字到边界为止，疑问词/非名词/任务对象一律不建（回落 LLM）。
  return detectAnyNameBuild(t);
}

/**
 * C1 任意名字路径：建/创建/新建/来个… + 名字(2~12字,到边界为止) + 可选职责。
 *
 * 边界 = 标点 / 职责引导词（帮我/负责/干/做…）/ 时刻词（每天/早上…）/ 动作字（盯/写/查/搜…）。
 * 从长到短试名字（先 12 后 2）——「数据分析师帮我盯数据」的名字是 5 字的「数据分析师」，
 * 不是 2 字的「数据」；但「小美，帮我盯店铺数据」的名字是 2 字的「小美」。
 *
 * 三道不建的闸（反证必须全红）：
 *  - 疑问词名字（什么/怎么/为什么/如何/吗/意思）
 *  - 非名词（帮助/忙/建议/关系/问题/风险… —— 「我需要帮助」不能建出个叫「帮助」的同事）
 *  - 任务对象（文件夹/文档/网页/账号/密码… —— 「帮我建个文件夹」是活，不是同事）
 * 角色词结尾（师/员/助手/顾问/管家…）豁免任务对象闸：「数据分析师」含「数据」但它是角色。
 */
const ANYNAME_VERB_RE = /^(?:请|拜托|麻烦|帮我|给我|我)?\s*(?:建|创建|新建|来个|来一个|加个|加一个|招个|招一个|需要|想要)\s*(?:一个|个|一位|名)?\s*(.+)$/;
const NAME_BOUNDARY_AT = /^(?:[，,。！!？?；;\s]|帮我|负责|干|做|去做|去|每天|每周|每[月天]|早[上中]|下午|晚上|凌晨|中午|半夜|盯|写|查|搜|整理|分析|处理|跟进|优化|维护|总结|汇报|给我|看看|推荐)/;
const NAME_STOP_RE = /(帮助|帮忙|忙|力|一下|建议|意见|关系|信任|印象|评价|认识|了解|学习|工作|生活|心情|状态|水平|效率|质量|能力|习惯|态度|观点|想法|主意|安排|预算|成本|利润|收入|价格|费用|开支|存款|贷款|利息|股票|基金|保险|税务|财务|问题|困难|挑战|障碍|瓶颈|短板|优势|劣势|机会|威胁|危机|事故|故障|错误|缺陷|漏洞|隐患|风险|计划|方案|规划|策略|措施|方法|技巧|经验|知识|信息|消息|通知|提醒|日程|会议|活动|任务|项目|工程|建设|建立|建造)/;
const TASK_OBJECT_RE = /(文件夹|文件|表格|文档|网页|网站|页面|主页|账号|账户|密码|口令|链接|网址|按钮|图标|模板|表单|报告|简历|名片|海报|合同|发票|账单|订单|快递|商品|店铺|门店|应用|APP|软件|系统|平台|工具|脚本|代码|程序|模型|接口|组件|模块|功能|小程序|博客|公众号)/i;
const ROLE_END_RE = /(?:师|员|手|管家|顾问|助手|专员|经理|总监|专家|教练|医生|律师|会计|编辑|主播|博主|作家|画家)$/;

export function detectAnyNameBuild(t: string): BuildIntent | null {
  const m = t.match(ANYNAME_VERB_RE);
  if (!m) return null;
  const rest = m[1].trim();
  if (rest.length < 2) return null;
  // 建设/建立/建造/建筑/建模/建议/建言 = 普通词汇，不是建智能体
  if (/^(设|立|造|筑|模|议|言)/.test(rest)) return null;

  for (let len = Math.min(12, rest.length); len >= 2; len--) {
    const isEnd = len === rest.length;
    if (!isEnd && !NAME_BOUNDARY_AT.test(rest.slice(len))) continue;
    const name = rest.slice(0, len);
    // 名字里带标点 = 边界没切对（「小美，帮我…」的名字只能是「小美」，不能吞到「小美，帮我」）
    if (/[,，。！!？?；;\s]/.test(name)) continue;
    if (/(什么|怎么|为什么|如何|吗|意思)/.test(name)) continue;
    const blocked = !ROLE_END_RE.test(name) && (NAME_STOP_RE.test(name) || TASK_OBJECT_RE.test(name));
    if (blocked) continue;
    let duty = rest.slice(len)
      .replace(/^[，,。！!？?；;\s]+/, '')
      .replace(/^(?:帮我|负责|干|做|去做|去|给我|看看|推荐|每天|每周|每[月天]|早[上中]|下午|晚上|凌晨|中午|半夜)/, '')
      .trim();
    if (!duty) duty = `${name}相关工作`;
    return { name: name.slice(0, 24), duty: duty.slice(0, 120), raw: t };
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

  /**
   * 产品交互规格 C1（2026-09-25）：建好即 **ready**（人设已带默认值，立刻能聊、左栏即现真名）。
   * 「三问」不再是挡路的 pending 引导表，而是桌面在输入框上方摆的**一行 chips**（可点/可自己写/
   * 可跳过）——纯可选精调：答完/跳过调 POST /agents/:id/persona 细化人设，用户直接打字则 chips
   * 自行消失、人设保持默认。不挡你、不二次确认。
   */
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
