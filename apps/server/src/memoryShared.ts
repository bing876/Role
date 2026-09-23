/**
 * 记忆合并第三批 · 统一两套整理逻辑
 *
 * 之前：
 *   - agents.ts/tidy 有自己的 TIDY_PROMPT + writeLayer（只写 preference active）
 *   - memories.ts/extractCore 有自己的 EXTRACT_PROMPT + 写入逻辑（支持 pending/active）
 *   两套都写 memories 表，但提示词、去重、敏感闸、写入路径各有一份，改一处漏一处。
 *
 * 现在：
 *   - 本文件为唯一入口：抽取提示词、JSON 容错、敏感闸、工作规则判定、写入（支持三级作用域）全部收口
 *   - memories.ts 和 agents.ts 都从这里 import，不再各自为政
 *   - memoryNormalize.ts 保持零 import，本文件可以 import 它（单向依赖，不循环）
 */

import type { Pool } from 'pg';
import type { JsonCipher } from './crypto';
import { normalizeText, isSensitive } from './memoryNormalize';

// ---------------------------------------------------------------------------
// JSON 容错（两边原来各有一份一模一样的）
// ---------------------------------------------------------------------------
export function extractJsonLoose(text: string): unknown {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// 提示词（收口到一处，方便后续统一改）
// ---------------------------------------------------------------------------
export const EXTRACT_PROMPT = [
  '你是工作台的“记忆保管员”。从下面的对话/任务记录里，只抽取会改变你今后对该用户行为的记忆。',
  '只输出一个 JSON：{"items":[{"type":"preference|fact|decision","content":"一句话中文","needs_confirm":true或false}]}，没有值得记的就输出 {"items":[]}',
  '铁律：',
  '1. 没有「以后 / 每次 / 默认 / 都 / 别再问我」这类长期信号的，都是一次性指令，不要输出。',
  '2. 「这次用红色就行」这类临时要求、情绪发泄、执行耗时抱怨，一律不要输出。',
  '3. 密码、验证码、身份证号、银行卡号、Cookie、第三方账号的口令：永远不要出现在 content 里（该条直接不输出）。',
  '4. 「以后用当前已登录的浏览器账号」可以记成 decision，但 content 禁止写出账号、邮箱、密码的具体值。',
  '5. type=preference 时 needs_confirm 必须 false；type=decision 时必须 true；fact 仅当会改变以后行为才输出（needs_confirm true），否则不要输出它。',
  '6. 一次最多 5 条。content 一句话中文（30 字内最佳），不要解释、不要引号。',
  '7. 【关键分类】preference 只留给「说话语气 / 长短」这类表达习惯（例：「以后回复尽量短」「别用客套话」）。',
  '   凡是会改变「怎么干活」的工作规则——主题、配色、格式、模板、流程、工具、默认规则、以后每次/所有/都怎么办——',
  '   一律 type=decision、needs_confirm=true（例：「以后所有报告都用蓝色主题」「以后都用表格出」「报告默认三段式」）。',
  '   拿不准就按 decision 处理（宁可让用户确认，也不要静默生效）。',
].join('\n');

export const TIDY_PROMPT = [
  '你是工作台的「记忆整理员」。把下面这段对话**总结**成两条互不混的清单，不要把整段聊天抄进去。',
  '只输出一个 JSON：{"user":[{"content":"一句话中文"}],"project":[{"content":"一句话中文"}]}',
  '分类规矩（拿不准就按这条走）：',
  '- user = 用户记忆库，账号级，**所有智能体都能读到**：只放「这个人」的习惯与口味——说话希望多短、',
  '  喜欢什么风格/设计/配色、聊天希望怎么展示。绝不能放任何具体项目的业务细节、资料、结论。',
  '- project = 项目记忆，**只归当前这个智能体**：只放这件事的业务与资料——这个项目在做什么、',
  '  定过哪些口径/结论/待办、涉及哪些资料。',
  '铁律：',
  '1. 密码、验证码、身份证、银行卡、支付、扫码、Cookie、令牌：一个字都不许出现在 content 里（整条丢掉）。',
  '2. 一次性指令（「这次用红色就行」）、执行耗时、情绪发泄、闲聊寒暄：都不要。',
  '3. content 是一句话中文（30 字内最佳），不要引号、不要解释、不要编号。',
  '4. 没有值得记的就给空数组；每边最多 5 条。',
].join('\n');

// 统一后的整理提示词（第三批新增）：同时带 type + 分层，兼容两套旧输出
export const UNIFIED_TIDY_PROMPT = [
  '你是工作台的「记忆整理员（统一版）」。把下面这段对话总结成两层记忆，不要把整段聊天抄进去。',
  '只输出一个 JSON：{"user":[{"type":"preference|decision|fact","content":"一句话中文","needs_confirm":true或false}],"project":[{"type":"preference|decision|fact","content":"一句话中文","needs_confirm":true或false}]}',
  '分类规矩：',
  '- user = 账号级，所有智能体可见：只放这个人的习惯与口味（语气长短、风格偏好）。',
  '- project = 智能体级，只归当前智能体：放该项目的业务口径、结论、待办、资料要点。',
  '铁律：',
  '1. 没有「以后/每次/默认/都」这类长期信号的，一律不要。',
  '2. 密码、验证码、身份证、银行卡、支付、扫码、Cookie、令牌：一个字都不许出现（整条丢掉）。',
  '3. 一次性指令、耗时抱怨、情绪发泄、闲聊寒暄：都不要。',
  '4. preference 只能是表达习惯（语气长短），needs_confirm 必须 false；decision 必须 needs_confirm true；fact 仅当会改变以后行为才输出（needs_confirm true），否则不输出。',
  '5. 工作规则（主题、配色、格式、模板、流程、默认规则）一律 decision + needs_confirm true。',
  '6. 每边最多 5 条，content 一句话中文 30 字内最佳。',
].join('\n');

// ---------------------------------------------------------------------------
// 工作规则判定（从 memories.ts 收口过来，两边共用）
// ---------------------------------------------------------------------------
const THEME_RULE_RE = /(主题|主题色|配色|样式|风格|模板|版式|布局|字体|字号)/;
const WORK_RULE_RE = /(报告|报表|文档|幻灯片|ppt|界面|格式|流程|规范|标准|默认|字段|单位|语言|图表|表格)/i;
const FORMAT_RULE_RE = /(用|按|走|采用)\s*(蓝色|红色|绿色|深色|浅色|表格|列表|三段|markdown|pdf|word)/i;
const GLOBAL_MARK_RE = /(所有|每次|一律|统统|全部|默认|统一|凡是)/;
const FUTURE_MARK_RE = /(以后|今后|往后|接下来|从现在起|之后|长期)/;

export function looksLikeWorkRule(content: string): boolean {
  const s = String(content ?? '');
  if (!s) return false;
  if (FORMAT_RULE_RE.test(s)) return true;
  const globalOrFuture = GLOBAL_MARK_RE.test(s) || FUTURE_MARK_RE.test(s);
  if (!globalOrFuture) return false;
  return THEME_RULE_RE.test(s) || WORK_RULE_RE.test(s);
}

// ---------------------------------------------------------------------------
// 写入层（统一三级作用域，带敏感闸、去重、pending 处理）
// ---------------------------------------------------------------------------
export interface WriteMemoryInput {
  pool: Pool;
  cipher: JsonCipher;
  ownerId: number;
  agentId?: number | null;
  conversationId?: number | null;
  memKey: string;
  contentEnc: string;
  type: string;
  source: string;
  status: 'active' | 'pending';
  needsConfirm: boolean;
}

export async function writeMemoryRow(input: WriteMemoryInput): Promise<number> {
  const { pool, ownerId, agentId, conversationId, memKey, contentEnc, type, source, status, needsConfirm } = input;
  const aid = Number(agentId);
  const hasAgent = Number.isInteger(aid) && aid > 0;
  const cid = Number(conversationId);
  const hasConv = Number.isInteger(cid) && cid > 0;

  let text: string;
  let values: unknown[];

  if (hasConv && hasAgent) {
    text = `INSERT INTO memories (project_id, agent_id, conversation_id, mem_key, value_enc, owner_id, type, content_encrypted, source, status, needs_confirm)
            VALUES (NULL, $1, $2, $3, $4, $5, $6, $4, $7, $8, $9) ON CONFLICT DO NOTHING`;
    values = [aid, cid, memKey, contentEnc, ownerId, type, source, status, needsConfirm];
  } else if (hasConv) {
    text = `INSERT INTO memories (project_id, agent_id, conversation_id, mem_key, value_enc, owner_id, type, content_encrypted, source, status, needs_confirm)
            VALUES (NULL, NULL, $1, $2, $3, $4, $5, $3, $6, $7, $8) ON CONFLICT DO NOTHING`;
    values = [cid, memKey, contentEnc, ownerId, type, source, status, needsConfirm];
  } else if (hasAgent) {
    text = `INSERT INTO memories (project_id, agent_id, conversation_id, mem_key, value_enc, owner_id, type, content_encrypted, source, status, needs_confirm)
            VALUES (NULL, $1, NULL, $2, $3, $4, $5, $3, $6, $7, $8) ON CONFLICT DO NOTHING`;
    values = [aid, memKey, contentEnc, ownerId, type, source, status, needsConfirm];
  } else {
    text = `INSERT INTO memories (project_id, agent_id, conversation_id, mem_key, value_enc, owner_id, type, content_encrypted, source, status, needs_confirm)
            VALUES (NULL, NULL, NULL, $1, $2, $3, $4, $2, $5, $6, $7) ON CONFLICT DO NOTHING`;
    values = [memKey, contentEnc, ownerId, type, source, status, needsConfirm];
  }

  const r = await pool.query(text, values);
  return r.rowCount ?? 0;
}

// 兼容旧 tidy 的简单写入（只写 preference active，无 pending）
export async function writeTidyLayer(
  pool: Pool,
  cipher: JsonCipher,
  layer: 'user' | 'agent',
  ownerId: number,
  agentId: number | null,
  items: unknown,
  source: string,
  conversationId?: number | null,
): Promise<{ added: number }> {
  const list = Array.isArray(items) ? items.slice(0, 5) : [];
  let added = 0;
  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>;
    const content = typeof o.content === 'string' ? o.content.trim().slice(0, 120) : '';
    if (content.length < 2) continue;
    if (isSensitive(content)) {
      console.warn('[memoryShared] 敏感内容丢弃（tidy）');
      continue;
    }
    const key = normalizeText(content);
    if (!key) continue;
    const enc = cipher.encryptText(content);
    const type = typeof o.type === 'string' && ['preference', 'decision', 'fact'].includes(o.type) ? String(o.type) : 'preference';
    const needs = type === 'preference' ? false : type === 'decision' ? true : Boolean(o.needs_confirm);
    if (type === 'fact' && !needs) continue;
    const status = needs ? 'pending' : 'active';
    const memKey = key;
    const convId = layer === 'user' ? null : conversationId ?? null;
    const aid = layer === 'user' ? null : agentId;
    try {
      added += await writeMemoryRow({
        pool,
        cipher,
        ownerId,
        agentId: aid,
        conversationId: convId,
        memKey,
        contentEnc: enc,
        type,
        source,
        status,
        needsConfirm: needs,
      });
    } catch (err) {
      console.warn('[memoryShared] 写入失败（忽略）：', (err as Error).message);
    }
  }
  return { added };
}
