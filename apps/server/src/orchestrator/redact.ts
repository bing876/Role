/**
 * 多智能体编排 · 统一的**脱敏与敏感判定**（进库 / 进提示词 / 进频道之前都必须过一遍）。
 *
 * ★ 为什么单独一个文件、而不是各写各的：
 *   R1（聊天搜敏感直传第三方）与 R2（敏感输入值明文落库）是同一个根因的两张脸 ——
 *   「敏感内容的判定散落在各处，每加一条新通道就漏一处」。编排一次新增了三条通道
 *   （委派任务文本 / 临时工 instruction / 内部频道正文），再各写一份正则就是第三次踩坑。
 *
 * 口径（与 R1/R2 同一套，别在这里另立标准）：
 *   · 判定用 `@ai-workbench/shared` 的 `SENSITIVE_TARGET_RE`（密码/验证码/支付/银行卡/身份证…）；
 *   · 掩码用下面这几个**值形态**正则（判定命中「字段名」，掩码要抹掉「值」，两者不是一回事）。
 *
 * 两条使用规则（改调用方之前先读）：
 *   1. **命中即拒绝，不是悄悄替换后照发** —— 委派/派工的任务文本命中敏感判定就当场拒
 *      （`sensitive_content`），并如实告诉发起方原因。悄悄替换会让模型以为对方收到的是完整任务。
 *   2. 落库前**仍然**过一遍 `redactForStorage()` 做纵深防御（判定漏了一个形态时，
 *      至少库里不是原文）。这两层不是重复，是「拒绝」与「兜底」。
 */
import { SENSITIVE_TARGET_RE } from '@ai-workbench/shared';

/** 命中的敏感类别（人话，进拒绝原因；不含原文） */
export type SensitiveHit = '' | 'password' | 'otp' | 'card' | 'idcard' | 'payment';

/**
 * 值形态掩码表。顺序有意为之：先抹「字段名+值」的组合（最准），再抹裸的长数字串。
 * 每条都只保留「有几个字符」这类**非内容**信息 —— 与 R2 在 driver/loop 里的口径一致
 * （「在「备注」输入了 14 个字符」，不是原文）。
 */
const VALUE_PATTERNS: Array<{ re: RegExp; tag: string }> = [
  // 密码：xxx: <值> / 密码是<值>
  { re: /((?:密码|口令|password|passwd|pwd)\s*[:：是为]?\s*)([^\s，。,;；]{1,64})/gi, tag: 'password' },
  // 验证码 / 短信码 / 动态口令
  { re: /((?:验证码|校验码|短信码|动态口令|otp|captcha|verification\s*code)\s*[:：是为]?\s*)([A-Za-z0-9]{3,10})/gi, tag: 'otp' },
  // 银行卡号：12~19 位，允许空格/横线分组
  { re: /\b(?:\d[ -]?){12,19}\d\b/g, tag: 'card' },
  // 身份证：18 位（末位可为 X）
  { re: /\b\d{17}[\dXx]\b/g, tag: 'idcard' },
  // CVV
  { re: /((?:cvv|cvn|安全码)\s*[:：是为]?\s*)(\d{3,4})/gi, tag: 'card' },
];

/**
 * 这段文本里有没有敏感内容。命中返回类别，没有返回空串。
 *
 * ★ 只做**判定**、不改文本 —— 调用方要用它决定「拒绝这次委派」，
 *   而不是把改过的文本发出去（见文件头使用规则 1）。
 */
export function detectSensitive(text: string): SensitiveHit {
  const t = String(text ?? '');
  if (!t) return '';
  if (/(密码|口令|password|passwd|pwd)/i.test(t)) return 'password';
  if (/(验证码|校验码|短信码|动态口令|otp|captcha|verification\s*code)/i.test(t)) return 'otp';
  if (/\b(?:\d[ -]?){12,19}\d\b/.test(t)) return 'card';
  if (/\b\d{17}[\dXx]\b/.test(t)) return 'idcard';
  if (/(cvv|cvn|安全码)/i.test(t)) return 'card';
  // 兜底：命中项目里那份唯一的敏感词表（支付/付款等没有「值形态」的类别）
  return SENSITIVE_TARGET_RE.test(t) ? 'payment' : '';
}

/** 类别 → 人话（进拒绝原因与频道 system 留痕；绝不带原文） */
export function sensitiveLabel(hit: SensitiveHit): string {
  switch (hit) {
    case 'password':
      return '密码/口令';
    case 'otp':
      return '验证码/短信码';
    case 'card':
      return '银行卡号/CVV';
    case 'idcard':
      return '身份证号';
    case 'payment':
      return '支付类敏感信息';
    default:
      return '敏感信息';
  }
}

/**
 * 落库前的纵深防御：把命中的**值**换成掩码，只留「有几个字符」。
 *
 * 注意它**不**用来「清洗后照发」—— 那是使用规则 1 明确禁止的。
 */
export function redactForStorage(text: string): string {
  let out = String(text ?? '');
  for (const { re, tag } of VALUE_PATTERNS) {
    out = out.replace(re, (...m: unknown[]) => {
      const whole = String(m[0] ?? '');
      /**
       * ★ 占位符里的「N 字」必须是**被替换掉那一段的实际长度**（2026-09-24 修的 bug）。
       *
       * `String.replace` 回调的实参形状随「正则有没有捕获组」而变：
       *   · 有 n 个捕获组 → `(match, g1…gn, offset, string)`，实参 n+3 个；
       *   · **没有**捕获组 → `(match, offset, string)`，实参 3 个；
       *   · 有命名组时末尾还会再多一个 groups 对象。
       * 第一版不看形状、直接取 `m[1]`/`m[2]`：
       *   `password`/`otp`/`cvv` 三条带两个捕获组，`m[2]` 正好是值 → 字数对（`Zx9!secret` → ·10字）；
       *   `card`/`idcard` 两条是 `(?:…)` **非捕获**的，`m[1]` 是 offset（数字）、
       *   `m[2]` 是 **整个输入串** → 字数变成「整句话的长度」：
       *   `银行卡6222021234567890`（16 位）报成 ·79字、`身份证110101199003071234`（18 位）也报成 ·79字。
       * 那个 79 还是**上一轮 password 替换之后**的整串长度，所以看着像「贪婪吞了 79 个字符」，
       * 其实正则一个字符都没多吞 —— 纯粹是长度取错了来源。
       * 修法：按实参形状还原捕获组个数，无组时用 `match` 本身当被替换段。
       */
      const hasNamedGroups = typeof m[m.length - 1] === 'object' && m[m.length - 1] !== null ? 1 : 0;
      const groupCount = m.length - 3 - hasNamedGroups; // 末两位恒为 offset 与 string
      const prefix = groupCount >= 1 ? String(m[1] ?? '') : '';
      const value = groupCount >= 2 ? String(m[2] ?? '') : whole;
      const len = [...value].length;
      return `${prefix}[已脱敏·${tag}·${len}字]`;
    });
  }
  return out;
}

/**
 * 收尾 6（2026-09-24 用户拍板）| **要给人看的短文本**的脱敏：步骤摘要、任务显示标题。
 *
 * 两层，缺一不可：
 *   1. R2 的两种已知泄漏形状 —— `输入「原文」` / `写入「原文」` → 换成字数
 *      （新客户端修后本来就不发原文，这层是防旧版桌面与第三方客户端）；
 *   2. **值形态兜底** —— 走上面同一张 `VALUE_PATTERNS`（银行卡 / 身份证 / 密码 / 验证码 / CVV）。
 *
 * ★ 为什么第 2 层现在要加（R2 当年明确拒绝过，理由要正面回答）：
 *   R2 的原话是「不用敏感词正则涂全文 —— secret 值本身通常不含敏感词
 *   （`Secret123` 命中不了"密码"），全文替换只会涂花账本还拦不住东西」。
 *   那条理由**只对「按敏感词表涂全文」成立**（`SENSITIVE_TARGET_RE` 那种）。
 *   `redactForStorage` 抹的不是「敏感词」而是**值形态**：12~19 位数字串、18 位身份证、
 *   `密码是X` / `pwd: X` 这种「字段名+值」组合 —— 正好是 `Secret123` 这类
 *   「命中不了敏感词」的东西的**载体**。所以两层不冲突，是「形状」与「值」各管一半。
 *
 * ★ 拍板背景：收尾 6 把 `tasks.goal_enc` 加密后，同一行 JSONB 里的 `payload.steps`
 *   仍是明文（用户决定**不整列加密 payload**，因为步骤账本要能在 SQL 里直接查）。
 *   既然不加密，那这道脱敏就是明文步骤唯一的闸 —— 必须让敏感值夹带不进去。
 *
 * 返回的文本里保留「有几个字符」这类**非内容**信息，与 driver/loop 的口径一致。
 */
export function scrubTaskText(text: string): string {
  const shaped = String(text ?? '')
    .replace(/输入「([^」]*)」/g, (_m: string, inner: string) => `输入「[已脱敏·${[...String(inner)].length}字]」`)
    .replace(/写入「([^」]*)」/g, (_m: string, inner: string) => `写入「[已脱敏·${[...String(inner)].length}字]」`);
  return redactForStorage(shaped);
}

/**
 * 任务列表 / 任务卡的**非敏感显示字段**：脱敏后的目标前 80 字。
 *
 * 为什么要有它：收尾 6 之后 `tasks.title` 不再存 goal 原文（那是同一份明文的第二个副本），
 * 而库里唯一的目标副本是密文 `goal_enc`。接口层解密后返回的 `goal` 是**用户原话**
 * （含敏感词，因为任务卡必须显示用户自己说的那句），所以另外给一个
 * 「非空、且保证不含敏感值」的显示候选，给列表/通知这类**不该带原文**的场景用。
 *
 * 永远非空：脱敏后万一只剩空白（整句都是敏感值），回落到 `'任务'`。
 */
export function taskDisplayTitle(goal: string, max = 80): string {
  const t = scrubTaskText(goal).replace(/\s+/g, ' ').trim().slice(0, max);
  return t || '任务';
}

/**
 * 结构化 payload 的脱敏：只保留「非内容」字段。
 *
 * 频道里的 payload 是给界面画卡片用的（状态/计数/来源网址/耗时），
 * 本来就不该带正文 —— 这里做的是**白名单式**过滤，而不是「递归找敏感词」：
 * 白名单漏了顶多界面少显示一项，黑名单漏了就是明文落库。
 */
export function sanitizePayload(payload: unknown): unknown {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === 'number' || typeof payload === 'boolean') return payload;
  if (typeof payload === 'string') return redactForStorage(payload.slice(0, 500));
  if (Array.isArray(payload)) return payload.slice(0, 20).map((x) => sanitizePayload(x));
  if (typeof payload === 'object') {
    const src = payload as Record<string, unknown>;
    const ALLOWED = new Set([
      'status',
      'reason',
      'kind',
      'okCount',
      'failCount',
      'tookMs',
      'count',
      'confidence',
      'title',
      'url',
      'delegationId',
      'jobId',
      'depth',
      'steps',
      'sources',
      'findings',
      'summary',
      // 多智能体编排：被委派方的**要点提纲**（频道 reply 与委派 result 都要带它，
      // 用户看内部频道时「结论 + 要点」才是可读的；漏掉的话只剩一句话）。
      'outline',
      // 超时熔断的**等了多久**（前端要拿它算「等了几分钟」，不该是字符串）
      'waitedMs',
      // 委派目标名（频道列表要显示「交给谁」）
      'to',
      // 频道里的对方 id / 消息数
      'peerAgentId',
      'messageCount',
    ]);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (!ALLOWED.has(k)) continue;
      // 数字/布尔原样保留（耗时、计数不该被转成字符串，界面要拿它算倒计时）
      out[k] = typeof v === 'number' || typeof v === 'boolean' ? v : sanitizePayload(v);
    }
    return out;
  }
  return null;
}
