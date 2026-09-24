/**
 * 批次 J（2026-09-24）| `@某智能体` 中途拉人 —— **确定性解析器**
 * ==================================================================
 *
 * ★ 为什么放在 `packages/shared`：服务端要拿它决定「这轮谁说话」，桌面端要拿它决定
 *   「本轮不许兜底发车」。两端各写一份必然漂移 —— 而 `verify:tools` 那批的历史教训就是
 *   「同一份契约只能有一个实现」。所以这里是**纯函数 + 单一实现**，谁都不许再抄一份。
 *
 * ★ 为什么是「确定性解析」而不是「让模型判断用户想 @ 谁」：
 *   点名是一件用户能一眼验证的事。交给模型判断就会出现「我明明 @ 了研究员，接活的却是建智能体的」
 *   这种没法复现、没法验收的漂移。规则写死 → 每条规则都能配一条反例断言。
 *
 * 规则（逐条对应用户的拍板与验收要求）：
 *   1. **名单精确匹配**：`@` 后面必须**逐字**等于名单里的某个名字。名单外的名字（`@张三`）不算。
 *   2. **邮箱里的 `@` 不算**：`user@example.com`、`first.last@研究员` 这种 —— `@` 左边紧贴
 *      「邮箱本地部字符」（字母/数字/`_`/`.`/`+`/`-`）时，这个 `@` 不是点名，直接跳过。
 *   3. **最长名优先**：名单里同时有 `研究员` 与 `研究员助手` 时，`@研究员助手` 必须命中后者。
 *      （不排序就会命中前者、把「助手」两个字当成任务内容留给模型。）
 *   4. **跨项目不生效**：解析器只认传进来的名单。名单由调用方按「当前项目 + 当前用户」查出来
 *      （服务端 `currentProjectId()` 那一套），所以别项目的智能体压根不在名单里 → 天然不命中。
 *      解析器自己**不查库**：它是纯函数，这样两端都能跑、单测也不需要库。
 *   5. **拍板 1（2026-09-24）**：`@` 必须**紧跟**名字，`@ 研究员`（中间有空格）不算点名。
 *   6. **拍板 2**：一句话只能有一个说话人 → **第一个命中的人**当说话人，其余命中只进 `mentions`
 *      列表（给 SSE meta 用，界面可以显示「还提到了谁」）。
 *   7. **R-B**：第一个命中的就是**当前说话人** → 当作没写 @：`speaker` 为 null、不重新路由、
 *      不报错（`selfMention` 置 true 让调用方知道发生过这件事）。后面还命中了别人时，
 *      那些人仍然只进 `mentions`（不会因为「第一个是自己」就把第二个提成说话人 —— 那等于偷偷换人）。
 *   8. **R-C**：`text` 是**摘掉所有 `@名字` 片段**之后要交给智能体的文本（折叠多余空白 + trim）。
 *      不摘的话模型会把 `@研究员` 当成任务内容的一部分（「用户让我关注研究员？」）。
 *
 * ★ 名字右侧**不**要求边界（`@研究员去查一下报表` 要能命中）：
 *   中文没有词边界，要求右侧是标点/空格会让最自然的写法失效。代价是名单里有 `小助`、
 *   用户写 `@小助手` 时会命中 `小助` 并把「手」留给正文 —— 这靠规则 3（最长名优先）解决：
 *   真有两个相近名字，它们都在名单里，长的会先命中。
 */

/** 名单里的一条：能点名的人（服务端按当前项目查 `agents` 表得到） */
export interface MentionRosterEntry {
  id: number;
  name: string;
}

/** 一次命中（`span` 用来精确摘除，不靠字符串替换 —— 同名出现两次也不会摘错位置） */
export interface MentionHit {
  agentId: number;
  name: string;
  /** `@` 在原文里的下标（含） */
  start: number;
  /** 名字末尾在原文里的下标（不含），即 `text.slice(start, end)` === `@名字` */
  end: number;
}

export interface MentionParseResult {
  /** 说话人：第一个命中的人；没命中 / R-B（@ 的就是当前说话人）时为 null */
  speaker: MentionHit | null;
  /** 全部命中（按出现顺序，含 speaker 自己）；进 SSE meta 的 mention 列表 */
  mentions: MentionHit[];
  /** R-C：摘掉所有 `@名字` 之后、要交给智能体的文本（可能为空串 → 见 textEmpty） */
  text: string;
  /** 摘完只剩空白：用户只写了个 @名字、没写要它做什么。调用方该给一句人话提示，不是 500 */
  textEmpty: boolean;
  /** R-B：@ 的就是当前说话人（已按「当作没写 @」处理） */
  selfMention: boolean;
  /** 写了 `@` 但名单里没有的名字（不影响路由；用于反证与调试，界面可以不显示） */
  unknown: string[];
}

/**
 * 邮箱本地部字符：`@` 左边紧贴这些字符时，这个 `@` 属于邮箱/句柄，不是点名。
 * 只列 RFC 5322 里最常见的这几个就够 —— 规则要能一句话讲清，比覆盖全更重要。
 */
const EMAIL_LOCAL_CHAR = /[A-Za-z0-9_.+\-]/;

/** `@` 之后最多往后看几个字符找名字（防止在超长消息上退化成 O(n·m) 的全量比对） */
const MAX_NAME_LEN = 64;

/**
 * 解析一句话里的 `@点名`。
 *
 * @param text   用户原文（**不要**先 trim：下标要跟原文对齐，否则 span 摘除会错位）
 * @param roster 能点名的人（调用方按当前项目/用户查好；空名单 → 永远不命中）
 * @param currentAgentId 当前这一路本来是谁在说话（R-B 用；不知道就不传）
 */
export function parseMention(
  text: string,
  roster: MentionRosterEntry[],
  currentAgentId?: number | null,
): MentionParseResult {
  const src = String(text ?? '');
  const empty: MentionParseResult = {
    speaker: null,
    mentions: [],
    text: src.trim().replace(/\s+/g, ' '),
    textEmpty: src.trim().length === 0,
    selfMention: false,
    unknown: [],
  };
  if (!src || !Array.isArray(roster) || roster.length === 0) return empty;

  /**
   * 名单先按名字长度**降序**排一次（规则 3：最长名优先）。
   * 同长的按 id 升序，保证「同样输入永远同样结果」—— 确定性解析不能依赖数组的偶然顺序。
   */
  const sorted = roster
    .filter((x) => x && typeof x.name === 'string' && x.name.length > 0 && Number.isInteger(x.id))
    .slice()
    .sort((a, b) => b.name.length - a.name.length || a.id - b.id);
  if (sorted.length === 0) return empty;

  const mentions: MentionHit[] = [];
  const unknown: string[] = [];

  for (let i = 0; i < src.length; i += 1) {
    if (src[i] !== '@') continue;
    // 规则 2：邮箱里的 @ 不算（左边紧贴邮箱本地部字符 → 这是 user@host 的一部分）
    if (i > 0 && EMAIL_LOCAL_CHAR.test(src[i - 1])) continue;
    // 规则 5（拍板 1）：@ 必须紧跟名字，中间有空格就不算点名
    const at = i + 1;
    if (at >= src.length) continue;
    const hit = sorted.find((x) => {
      const n = x.name;
      return n.length <= MAX_NAME_LEN && src.startsWith(n, at);
    });
    if (hit) {
      mentions.push({ agentId: hit.id, name: hit.name, start: i, end: at + hit.name.length });
      i = at + hit.name.length - 1; // 跳过整段，名字里的 @ 不会被二次解析
      continue;
    }
    // 名单外：记下「用户写了个 @ 但没这个人」，不当点名处理（规则 1）
    const word = src.slice(at, at + MAX_NAME_LEN).match(/^[^\s，。！？；：、,.!?;:()（）【】[\]]+/);
    if (word && word[0]) unknown.push(word[0]);
  }

  // R-C：按 span 从后往前摘，前面的下标才不会失效
  let out = src;
  for (let k = mentions.length - 1; k >= 0; k -= 1) {
    const h = mentions[k];
    out = out.slice(0, h.start) + out.slice(h.end);
  }
  const clean = out.replace(/\s+/g, ' ').trim();

  // 拍板 2 + R-B
  const first = mentions[0] ?? null;
  const selfMention = !!first && currentAgentId != null && first.agentId === currentAgentId;
  return {
    speaker: first && !selfMention ? first : null,
    mentions,
    text: clean,
    textEmpty: clean.length === 0,
    selfMention,
    unknown,
  };
}

/**
 * 给日志/接口用的**非敏感**摘要（绝不带消息正文，正文可能含密码卡号）。
 * 只报「命中了谁、几个、正文还剩几个字」—— 排查「@ 了没反应」时够用。
 */
export function mentionSummary(r: MentionParseResult): string {
  if (r.mentions.length === 0) {
    return r.unknown.length > 0 ? `点名未命中（名单外 ${r.unknown.length} 个）` : '无点名';
  }
  const who = r.mentions.map((m) => `#${m.agentId}`).join(',');
  return (
    `点名 ${r.mentions.length} 处（${who}）` +
    (r.speaker ? `→ 说话人 #${r.speaker.agentId}` : r.selfMention ? '→ 就是当前说话人，按没写 @ 处理' : '→ 不改说话人') +
    `，正文剩 ${[...r.text].length} 字`
  );
}
