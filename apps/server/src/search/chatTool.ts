/**
 * 第 26 步：把「联网搜索」注册成模型手边可调用的**一个工具**（function calling）。
 *
 * 收口后：唯一定义活在 `./toolDef.ts`，本文件只保留：
 *   - 兼容 re-export（旧路径仍可用）
 *   - 搜索策略提示词块（chatSearchPolicyBlock / searchPolicyForTurn）
 *   - isWebSearchToolName 辅助
 *
 * 旧的 WEB_SEARCH_TOOL 常量已删除，改为从统一定义派生（见 toolDef.ts）。
 * chatLoop.ts 现在直接从 toolDef.ts 取定义，不再依赖本文件的裸对象。
 */

import {
  WEB_SEARCH_TOOL_DEFINITION,
  WEB_SEARCH_TOOL_NAME as UNIFIED_NAME,
  WEB_SEARCH_MAX_ROUNDS as UNIFIED_MAX,
} from './toolDef';

/** 工具名。单一来源：toolDef.ts */
export const WEB_SEARCH_TOOL_NAME = UNIFIED_NAME;

/**
 * 一次对话里最多真搜几轮（防止模型来回查个不停）。
 * 单一来源：toolDef.ts
 */
export const WEB_SEARCH_MAX_ROUNDS = UNIFIED_MAX;

/**
 * 兼容：旧代码 import { WEB_SEARCH_TOOL } 的路径仍可用。
 * 它是从统一定义派生的 OpenAI function tool（与注册表 toOpenAITools 输出一致）。
 * 新代码应直接从 toolDef.ts 取 WEB_SEARCH_TOOL_DEFINITION 或用 registry。
 */
export const WEB_SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: WEB_SEARCH_TOOL_DEFINITION.name,
    description: WEB_SEARCH_TOOL_DEFINITION.description,
    parameters: WEB_SEARCH_TOOL_DEFINITION.parameters,
  },
} as const;

/** 模型请求过的工具名是不是我们的搜索工具 */
export function isWebSearchToolName(name: string | undefined | null): boolean {
  return String(name ?? '') === WEB_SEARCH_TOOL_NAME;
}

/**
 * 注入聊天路径系统提示词的「本轮手边有什么」说明。
 *
 * 为什么必须显式写出来（实测逼出来的）：
 *   只把工具表递给模型时，它会在**用户点明了网站**的情况下（「打开必应帮我查汇率」）
 *   仍然调 `web_search`，并且在回答里写「已打开必应」+ 夹一整句英文开场白
 *   —— 既"用搜索敷衍了浏览器任务"，又撒了一个"我打开了网页"的谎。
 *   工具描述里已经写了规则，但**系统提示词的近因位置**更能压住它，
 *   所以这里再说一遍，并且明确"你没有打开网页的能力"。
 */
export function chatSearchPolicyBlock(): string {
  return [
    '本轮你手边多了一个工具：**联网搜索（web_search）**。',
    '- 它只是"查公开资料"，**不会打开任何网页**：界面上不会出现网页卡片，你**没有**打开网站的能力，',
    '  所以**任何时候都不要说**「已打开 / 已为你打开 / 我已经在某某网站上了」这类话。',
    '- 需要"此时此刻的外部信息"（新闻、天气、行情、赛事、某人某公司近况）时才用它；',
    '  常识、算术、写作、翻译、闲聊直接回答，不要搜。',
    '- **用户点明了某个具体网站、要你在那上面做事时（「打开某站…」「去某站…」），不要调用搜索工具**，',
    '  也不要用搜索的结果去冒充"我去过那个网站"。',
    '- 判据很机械，照着执行即可：**用户这一句里只要出现了某个网站 / App 的名字**',
    '  （必应、百度、淘宝、京东、抖音、小红书、亚马逊…），那件事就属于"去那个网站做"，',
    '  **一律不要调用搜索工具** —— 哪怕它听起来很像"查个资料"。',
  ].join('\n');
}

/**
 * ★ 本轮的搜索说明该不该注入。
 *
 * 为什么必须分情况（这是我自己第一版写错、被"两条提示词打架"逼出来的）：
 *   `chatSearchPolicyBlock()` 里有一句硬话「你**没有**打开网站的能力，不许说已打开」；
 *   而基座提示词（BASE_SYSTEM_PROMPT）对「打开百度」这类**纯开页**指令要求
 *   「直接用一句话说明已经打开」（那一刻桌面确实已经把页开好了）。
 *   两者同时在系统提示词里 = **自相矛盾**，模型会拒绝承认它打开了页面。
 *
 * 真实链路（`App.tsx` 的发送逻辑）：
 *   · 「打开百度」这种纯开页 → 桌面开了页、**不带 taskMode** → 走聊天路径，但**带 `browserOpened`**；
 *   · 「打开百度搜天气」这种带活的 → 带 taskMode → 走工具循环（另一套提示词，本函数不参与）。
 * 所以判据就是"这一轮桌面有没有报『网页已经开好了』"（即 `browserOpened` 有没有值）：
 *   开了页 → **不注入**本块（让基座的话生效）；
 *   没开页 → 注入本块（把"不许谎称打开网页"这条压住）。
 */
export function searchPolicyForTurn(opts: { pageOpenedThisTurn: boolean }): string {
  return opts.pageOpenedThisTurn ? '' : chatSearchPolicyBlock();
}
