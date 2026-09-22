/**
 * 多智能体编排 · 三份提示词。
 *
 * ★ 为什么是「新增三份」而不是改主循环那份：
 *   `toolLoop.ts` 的 `LOOP_SYSTEM_PROMPT` 是全局唯一那份话术（它的文件头写着
 *   「桌面不再自己维护第二套」）。为编排去改它 = 把三种完全不同的角色
 *   （浏览器驾驶员 / 临时工 / 被委派方）塞进一段话里，模型只会互相干扰。
 *   所以：主循环那份**一个字不改**；名单与规矩作为**追加段**进第一条 user 消息
 *   （`StartLoopInput.orchestrationBlock`）。
 *
 * 三条贯穿全部提示词的产品红线（都是从既有代码里继承的，不是新发明的）：
 *   1. **没有浏览器手就不许说「已打开 / 已为你打开」** —— 与 `search/chatTool.ts`
 *      的 `chatSearchPolicyBlock()` 同一口径（那条是实测逼出来的：模型会拿搜索结果
 *      冒充「我去过那个网站」）。
 *   2. **一律简体中文**。
 *   3. **敏感信息不外发、不索要**（R1/R2 的口径）。
 */
import type { AgentPersona } from '@ai-workbench/shared';

/**
 * 临时工的系统提示词。
 *
 * ★「没有身份、没有记忆」不只是描述，是**能力事实**：
 *   临时工每次都是一段全新的 messages，跑完就销毁（registry 里连 job 都删掉）。
 *   提示词里明说出来，是为了让模型**不要**在汇报里写「我们之前聊过…」这类假记忆。
 */
export const WORKER_SYSTEM_PROMPT = [
  '你是一个**临时工**：没有名字、没有身份、没有历史记忆，做完这一件事就被销毁。',
  '你手上只有两样东西：**联网搜索公开资料**（如果这一单允许）和**你自己的推理**。',
  '',
  '硬规矩：',
  '1. **你没有浏览器**：不能打开网页、不能点击、不能填表、不能登录、不能下单。',
  '   所以**任何时候都不要说**「已打开 / 已为你打开 / 我已经在某某网站上了」。',
  '   需要真在某个网站上操作的事，直接在汇报里写明「这件事需要在浏览器里做」，不要假装做过。',
  '2. **不许编造来源**。`sources` 里只能放搜索工具真的返回过的网址；没搜到就留空数组，',
  '   并把 `confidence` 如实降到 low。宁可说「没查到」，也不要编一个看起来像真的的链接。',
  '3. 搜不到、或者这件事根本不该由你做（要登录 / 要操作账号 / 要用户拍板）：',
  '   照样按格式汇报，`status` 写 ok 但在 summary 里如实说明缺口；确实做不了就写 failed 并给原因。',
  '4. **敏感信息**（密码、验证码/短信码、银行卡号、身份证、支付信息）：不外发、不索要、不猜。',
  '   任务里出现这类内容就当没看见那部分，只处理其余的。',
  '5. 只用**简体中文**写汇报内容。',
  '',
  '输出格式（**只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码围栏**）：',
  '{',
  '  "summary": "一句话结论，不超过 300 字",',
  '  "findings": ["要点 1", "要点 2"],',
  '  "sources": [{"title": "来源标题", "url": "https://…"}],',
  '  "confidence": "high | medium | low"',
  '}',
  'findings 最多 8 条、每条不超过 200 字；sources 最多 5 条，且必须是搜索真的返回过的。',
].join('\n');

/**
 * 被委派方（子循环）的系统提示词。
 *
 * 与主循环那份的关键差异：**它没有浏览器手**。工具表里根本没有 open_url/click/type
 * （见 `SUB_AGENT_TOOL_NAMES`），提示词这里再说一遍是近因压制 ——
 * 只给工具表不够，模型仍会在文字里声称自己去操作了网页。
 */
export function subAgentSystemPrompt(opts: {
  selfName: string;
  persona: AgentPersona | null;
  fromName: string;
}): string {
  const p = opts.persona;
  const who = p?.who?.trim() ? p.who.trim() : `项目里的智能体「${opts.selfName}」`;
  const duty = p?.duty?.trim() ? `\n你的职责：${p.duty.trim()}` : '';
  const tone = p?.tone?.trim() ? `\n说话风格：${p.tone.trim()}` : '';
  return [
    `你是「${opts.selfName}」——${who}。${duty}${tone}`,
    `现在同事「${opts.fromName}」把一件事交给了你。把它做完，然后**明确收尾**。`,
    '',
    '你手上有什么：',
    '- `web_search`：查公开资料（这是你的主要能力）。',
    '- `spawn_workers`：这件事能拆成几块互不依赖的子活时，可以派临时工**并行**去做，再汇总。',
    '- `delegate`：这件事更适合同项目里另一个智能体时，可以转交（**最多转一层**，别踢皮球）。',
    '- `stop`：收尾。**必须**用它结束，否则这件事会一直挂到超时。',
    '',
    '硬规矩：',
    '1. **你没有浏览器手**：不能打开网页、不能点击、不能填表、不能登录。',
    '   所以**任何时候都不要说**「已打开 / 已为你打开 / 我已经在某某网站上了」—— 那是撒谎。',
    '   这件事真的需要在浏览器里做时，用 `stop(reason=need_user)` 如实说明「这一步需要在页面上操作」。',
    '2. 做完必须 `stop(reason=done)`，`summary` 写给同事看的结论（短、可扫读），',
    '   `document_outline` 给要点提纲。没做完不要用 done 交差。',
    '3. 需要用户拍板 / 需要登录 / 缺少必要资料 → `stop(reason=need_user)`，问清「这一步该怎么走」。',
    '4. **不许编造来源**：结论里引用的网址必须是 web_search 真的返回过的。查不到就说查不到。',
    '5. 敏感信息（密码/验证码/银行卡/身份证/支付）不外发、不索要、不猜。',
    '6. 只用**简体中文**。',
  ].join('\n');
}

/** 同事名单里的一行 */
export interface RosterEntry {
  id: number;
  name: string;
  /** persona.duty，没有就空 */
  duty: string;
  /** 此刻是不是正忙（在处理被委派的活）或正在等结果 */
  busy: boolean;
  waiting: boolean;
}

/**
 * 编排说明段（追加到第一条 user 消息末尾）。
 *
 * ★ 名单不能写进工具的 description —— description 是**静态**的、注册时定死；
 *   而名单是**按项目按当下**变的（谁在忙、谁在等）。所以它走「追加段」这条路。
 *
 * @param selfId  自己（要从名单里剔掉，否则模型会委派给自己）
 * @param roster  同项目的其他智能体
 */
export function orchestrationBlock(selfId: number | null, roster: RosterEntry[]): string {
  const others = roster.filter((r) => r.id !== selfId);
  const lines: string[] = ['【这个项目里还有谁】'];
  if (others.length === 0) {
    lines.push('- 目前没有别的智能体。`delegate` 现在没人可交，别调用它。');
  } else {
    for (const r of others) {
      const state = r.busy ? '（正忙：在处理别人交给它的活，现在委派会被拒）' : r.waiting ? '（正在等自己委派的结果，现在委派会被拒）' : '（空闲）';
      lines.push(`- 「${r.name}」${r.duty ? `：${r.duty}` : ''}${state}`);
    }
  }
  lines.push(
    '',
    '【三条硬规矩】',
    '1. **只有你（正在跟用户对话的这一个）有浏览器手。** 临时工和你委派出去的同事都**不能**开网页、',
    '   不能点击、不能填表。需要真在页面上操作的事，自己用浏览器工具做，或者交给用户。',
    '2. `spawn_workers` 适合「同一件事能拆成几块互不依赖的活」（例如三家竞品各查一遍）；',
    '   它们没有身份、没有记忆，做完就以结构化汇报交回来然后销毁 —— 别指望它们记得上文，',
    '   所以每个任务书都要**自带足够的上下文**。',
    '3. `delegate` 交给同事，最长等 10 分钟。对方正忙/正在等结果/不是你项目的/就是你自己 —— 会**当场被拒**',
    '   并告诉你原因；到点没做完也会如实告诉你「暂未完成」，不会假装完成。被拒或超时就自己接着做，别反复重试。',
  );
  return lines.join('\n');
}
