/**
 * web_search 唯一定义（收口后单一来源）。
 *
 * 背景见 docs/待办-编排-websearch双定义收口-20260923.md：
 *   之前有两份定义 —— chatTool.ts 的 WEB_SEARCH_TOOL（裸对象，聊天路径自用）
 *   与 orchestrator/search.ts 的 WEB_SEARCH_SERVER_TOOL（ToolDefinition，进注册表）。
 *   名字同为 'web_search'，但 description / parameters / validate 分叉。
 *
 * 收口后：只有这一份 ToolDefinition，聊天路径与编排路径都 import 它。
 *   - description 以聊天路径那份长描述为底（实测调过，含「点明网站不要搜」「已打开谎言」等红线），
 *     已包含敏感信息那一行，与编排那份的敏感提示合并。
 *   - parameters 补上 additionalProperties:false（向更严那份看齐）。
 *   - validate 与执行前敏感闸共用 SENSITIVE_TARGET_RE（单一来源，改一处两边生效）。
 */

import { SENSITIVE_TARGET_RE, type ToolDefinition } from '@ai-workbench/shared';

export const WEB_SEARCH_TOOL_NAME = 'web_search';

/**
 * 一次对话里最多真搜几轮（防止模型来回查个不停）。
 * 到顶之后下一轮会把 tool_choice 设成 none，逼它用已有资料作答（不是报错）。
 */
export const WEB_SEARCH_MAX_ROUNDS = 3;

export const WEB_SEARCH_TOOL_DEFINITION: ToolDefinition = {
  name: WEB_SEARCH_TOOL_NAME,
  description: [
    '联网搜索公开资料，返回若干条结果（标题 / 网址 / 摘要）。',
    '',
    '【该用它】问题需要"此时此刻的外部信息"才能答对时，例如：',
    '  最新新闻 / 时事进展、天气、赛事比分、股价汇率、航班车次、',
    '  某人某公司的最新动态、某个名词或产品的含义与现状、你训练数据里没有或可能过期的信息。',
    '',
    '【不要用它】下面这些一律直接回答，不要搜：',
    '  · 闲聊、问候、感谢、自我介绍、写作、翻译、算术、写代码、解释通用概念；',
    '  · 用户要你去**某个具体网站做具体操作**（打开某站、在那站搜索、登录、下单、比价、出报告）',
    '    —— 那是工作台的"浏览器操作"能力，不是搜索；这种情况下正常回答用户即可，',
    '      不要用搜索去假装你去了那个网站；',
    '  · **用户点明了某个具体网站时（例如「打开必应…」「去淘宝…」「在抖音上…」），绝对不要调用本工具**：',
    '    那是在那个网站上做事，不是让你搜公开资料；也**绝对不要**说「已打开 / 已为你打开」——',
    '    你没有打开网页的能力（打开网页是工作台另一套能力，走的是另一条路）。',
    '  · 你自己已经能确定答案的常识问题（例如「1+1 等于几」）。',
    '  · **问题里含有个人敏感信息时（密码、验证码/短信码、身份证、银行卡/卡号、支付/付款等）**：',
    '    不要调用搜索 —— 本地安全规则会直接拦截这次调用。请直接告诉用户这类问题不能搜，',
    '    请他换个不带敏感信息的问法，或自己到官方渠道核对；不要编造答案。',
    '',
    '【怎么用】一次只提一个具体的 query（用自然的问句或关键词都行）。',
    '如果第一次的结果不够，可以换个 query 再搜一次，但不要反复搜同一个问题。',
    '拿到结果后，用**系统当前语言**（见系统提示词的语言规则）把结论讲给用户，',
    '不要直接把一堆原始摘要倒给用户，也不要输出搜索结果的网址清单当答案。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '要搜索的问题或关键词。尽量具体（例如「2026年9月20日 国内新闻」而不是「新闻」）。',
      },
      topic: {
        type: 'string',
        enum: ['general', 'news'],
        description: '可选。时事/新闻类问题用 news，其余用 general（默认 general）。',
      },
      days: {
        type: 'integer',
        description: '可选，仅 topic=news 时有效：只要最近 N 天（1~30）。问"今天/最近"时填 1~3。',
      },
      max_results: {
        type: 'integer',
        description: '可选：要几条结果（1~20，默认 5）。',
      },
    },
    required: ['query'],
    // 向更严的那份看齐：聊天路径原来有，编排那份没有。模型多传字段时行为一致。
    additionalProperties: false,
  } as any,
  side: 'server',
  kind: 'action',
  timeoutMs: 20_000,
  validate: (args) => {
    const query = typeof args.query === 'string' ? args.query.trim().slice(0, 300) : '';
    if (!query) {
      return { ok: false, reason: 'bad_args', question: '要搜什么没写清楚。给我一个具体的问题或关键词。' };
    }
    if (SENSITIVE_TARGET_RE.test(query)) {
      return {
        ok: false,
        reason: 'blocked_sensitive',
        question:
          '这次搜索的问题里含敏感信息（密码/验证码/银行卡/身份证/支付类），我没有发出去。' +
          '这类问题不能搜，请换个不带敏感信息的问法，或自己到官方渠道核对。',
      };
    }
    const topic = args.topic === 'news' ? 'news' : 'general';
    const days = Number.isFinite(Number(args.days))
      ? Math.min(30, Math.max(1, Math.floor(Number(args.days))))
      : undefined;
    const maxResults = Number.isFinite(Number(args.max_results))
      ? Math.min(20, Math.max(1, Math.floor(Number(args.max_results))))
      : 5;
    return { ok: true, args: { query, topic, ...(days ? { days } : {}), max_results: maxResults } };
  },
};

// 兼容旧 import 路径：编排侧原来叫 WEB_SEARCH_SERVER_TOOL
export const WEB_SEARCH_SERVER_TOOL = WEB_SEARCH_TOOL_DEFINITION;
