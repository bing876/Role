/**
 * 回答语言的**唯一真相来源**（第 26 步）。
 *
 * 原则（用户 2026-09-20 明确）：
 *   **AI 回答的语言，跟随「整个系统当前的语言设置」** ——
 *   既不跟随用户提问的语言，也**不跟随联网搜回来的资料语言**。
 *
 * 具体到当前：系统只有中文一种语言 ⇒ 默认 `zh-CN`。
 * 所以「搜到一堆英文资料」也照样用**简体中文**回答用户，
 * **不需要**为"搜索翻译"单独写任何规则 —— 那是这条通用原则的自然结果。
 *
 * 以后怎么接多语言（现在不做，只是留好口子）：
 *   1. 把 `currentReplyLanguage()` 改成读「用户设置 / 会话设置 / 请求头」；
 *   2. 各调用方**不用改** —— 它们只认 `replyLanguageRule()` 的返回值；
 *   3. 新增语言时在 `LANGUAGE_LABELS` 里补一行即可。
 * 换句话说：语言的来源只有这一处，将来换来源不用重构业务逻辑。
 */

/** 系统当前支持的语言（按 BCP-47）。现在只有中文一种，是**有意的**，不是遗漏。 */
export const SUPPORTED_REPLY_LANGUAGES = ['zh-CN'] as const;

/** 没有显式设置时用的语言 */
export const DEFAULT_REPLY_LANGUAGE = 'zh-CN';

/** 语言 → 给模型看的名字（写提示词时用它，别把 BCP-47 码丢给模型） */
const LANGUAGE_LABELS: Record<string, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
};

export type ReplyLanguage = string;

/**
 * 当前该用什么语言回答。
 *
 * 现在恒返回默认值。以后加语言切换时，**只改这一个函数**（比如读入参/设置），
 * 调用方（chat 路由、提示词拼装）一行都不用动。
 */
export function currentReplyLanguage(): ReplyLanguage {
  return DEFAULT_REPLY_LANGUAGE;
}

/** 给模型看的语言名；不认识的语言码原样返回（总比丢掉好） */
export function replyLanguageLabel(lang: ReplyLanguage = currentReplyLanguage()): string {
  return LANGUAGE_LABELS[lang] ?? lang;
}

/**
 * 注入系统提示词的「回答语言」规则。
 *
 * 写得直白是因为它要盖住一个很容易犯的错：**模型看到英文资料就跟着用英文答**。
 * 所以这里明确「不跟随提问语言、不跟随资料语言」。
 */
export function replyLanguageRule(lang: ReplyLanguage = currentReplyLanguage()): string {
  const label = replyLanguageLabel(lang);
  return (
    `回答语言：**始终用${label}**回答（这是系统当前的语言设置）。\n` +
    `- 不要因为用户这句是外文、或你查到的资料是外文，就换成外文回答；把内容用${label}讲清楚。\n` +
    `- **连开场白、过渡句、总结句也必须是${label}**，不要在回答里夹整句外文` +
    `（实测踩过：模型在中文回答前面加了一句英文 "I'll open Bing and look up …"）。\n` +
    `- 专有名词、人名、产品名可以保留原文（必要时在括号里给${label}说明），但整句必须是${label}。`
  );
}
