/**
 * 第 26 步验收 · 第 1 层：**桌面本地路由**（真实判定函数，不是复刻逻辑）。
 *
 * 为什么要单独测这一层：聊天那条路上，「要不要开浏览器」是**桌面本地**判的
 * （纯字符串、脱网、不问模型，见 sites.ts / intent.ts 头注释）——
 * 模型根本没机会参与。所以"AI 有没有把搜索和浏览器搞混"这件事，
 * 有一半答案在这一层：本地会不会**误开页**。
 *
 * 本脚本**只读、只调用**这些函数，一行都不改它们
 * （本步的硬约束：不碰浏览器触发逻辑、驾驶循环、浏览器 UI）。
 *
 * 跑法：npx tsx scripts/verify/search-vs-browser-routing.mts
 */
import { detectOpenUrl, detectUnknownOpenTarget, isPureOpenCommand } from '../../apps/desktop/src/browser/sites';
import { detectBrowseIntent } from '../../apps/desktop/src/browser/intent';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function chk(id: string, ok: boolean, detail = ''): boolean {
  if (ok) pass += 1;
  else {
    fail += 1;
    failures.push(`${id} ${detail}`.trim());
  }
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id}${detail ? ' — ' + detail : ''}`);
  return Boolean(ok);
}

/** 安全调用：某个判定函数签名不匹配时不要炸掉整轮，如实记为 FAIL */
function safe<T>(fn: () => T): { ok: boolean; value: T | null; err?: string } {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, value: null, err: (e as Error).message };
  }
}

type Expect = 'search' | 'browser' | 'neither';

interface Case {
  q: string;
  expect: Expect;
  why: string;
}

const CASES: Case[] = [
  // ---------- 类 1：该走「联网搜索」，**绝不该**开浏览器 ----------
  { q: '今天有什么新闻', expect: 'search', why: '需要外部最新信息，但不涉及具体网站操作' },
  { q: '今天北京天气怎么样', expect: 'search', why: '实时信息类问题' },
  { q: '最近 OpenAI 有什么新消息', expect: 'search', why: '事件进展类问题' },
  { q: '2026年诺贝尔物理学奖颁给了谁', expect: 'search', why: '训练数据之外的事实' },
  { q: '帮我查一下"碳化硅"主要用在哪', expect: 'search', why: '查资料类，但不需要去某个站操作' },

  // ---------- 类 2：该走「浏览器操作」 ----------
  { q: '打开抖音搜索附近的火锅店，给我出一份报告', expect: 'browser', why: '点名网站 + 具体操作 + 要产出' },
  { q: '打开必应帮我查一下今天的美元汇率', expect: 'browser', why: '点名网站 + 在站内做事' },
  { q: '打开淘宝帮我比一下这两款耳机的价格', expect: 'browser', why: '点名网站 + 站内比价' },

  // ---------- 类 3：都不用（凭常识直接答） ----------
  { q: '1加1等于几', expect: 'neither', why: '常识，直接答' },
  { q: '帮我写一段自我介绍，我是做跨境电商的', expect: 'neither', why: '写作任务，直接答' },
  { q: '你好', expect: 'neither', why: '闲聊' },

  /**
   * ---------- 附加：边界样本（用来**定位**本地判定的漏判/误判，不是"应该过"的用例）----------
   * 这几条是本步跑出来之后补的，专门钉住"点名了网站、但桌面认不出来"的空档。
   * 它们**可能红** —— 红了就是真问题，不许为了让它们变绿去改判定逻辑（那属于浏览器触发代码）。
   */
  { q: '帮我在必应上查一下今天的美元汇率', expect: 'browser', why: '点名了站点，但动词是"在…上"（不是"打开/去"）' },
  { q: '帮我去京东看看这个商品有没有货', expect: 'browser', why: '点名了站点 + "去…看看"' },
  { q: '帮我查一下今天的美元汇率', expect: 'search', why: '没点名站点 → 应该走轻量搜索' },
];

console.log('=== 桌面本地路由：每一句"会不会开浏览器" ===\n');

for (const c of CASES) {
  const open = safe(() => detectOpenUrl(c.q));
  const unknown = safe(() => detectUnknownOpenTarget(c.q));
  // 场景 A：当前**没有**打开任何页（activeTab = null ⇒ 桌面不会发车）
  const browseNoTab = safe(() => detectBrowseIntent(c.q));
  /**
   * 场景 B：当前**已经开着一张页**（这是最容易被误判的场景 ——
   * 用户开着浏览器，随口问一句"今天有什么新闻"，桌面会不会把这句话当成
   * "在这张页上干活"从而去驾驶浏览器？）
   */
  const browseWithTab = safe(() => detectBrowseIntent(c.q));

  const opensBrowser = open.ok && open.value !== null;
  const asksUserForSite = unknown.ok && unknown.value !== null;
  const drivesBrowser = (browseNoTab.ok && browseNoTab.value !== null) || (browseWithTab.ok && browseWithTab.value !== null);

  const tag = `「${c.q}」`;
  console.log(`--- ${tag}  期望=${c.expect}  (${c.why})`);
  console.log(`    detectOpenUrl          → ${open.ok ? JSON.stringify(open.value) : 'ERR ' + open.err}`);
  console.log(`    detectUnknownOpenTarget→ ${unknown.ok ? JSON.stringify(unknown.value) : 'ERR ' + unknown.err}`);
  console.log(`    detectBrowseIntent     → ${browseNoTab.ok ? JSON.stringify(browseNoTab.value) : 'ERR ' + browseNoTab.err}`);
  console.log('');

  if (!open.ok || !unknown.ok || !browseNoTab.ok) {
    chk(`${tag} 判定函数可调用`, false, `open=${open.err ?? 'ok'} unknown=${unknown.err ?? 'ok'} browse=${browseNoTab.err ?? 'ok'}`);
    continue;
  }

  if (c.expect === 'search') {
    chk(`${tag} 不开浏览器`, !opensBrowser, opensBrowser ? `却解析出 ${open.value}` : 'detectOpenUrl=null');
    chk(`${tag} 不向用户要网址`, !asksUserForSite, asksUserForSite ? `却要求补网址：${unknown.value}` : 'null');
    chk(`${tag} 不驱动浏览器`, !drivesBrowser, drivesBrowser ? `detectBrowseIntent=${JSON.stringify(browseNoTab.value)}` : 'null');
  } else if (c.expect === 'browser') {
    chk(`${tag} 会开浏览器`, opensBrowser, opensBrowser ? String(open.value) : '★ detectOpenUrl=null（认不出站点 ⇒ 整条开页链路不启动）');
  } else {
    chk(`${tag} 不开浏览器`, !opensBrowser, opensBrowser ? `却解析出 ${open.value}` : 'null');
    chk(`${tag} 不向用户要网址`, !asksUserForSite, asksUserForSite ? `却要求补网址：${unknown.value}` : 'null');
    chk(`${tag} 不驱动浏览器`, !drivesBrowser, drivesBrowser ? `detectBrowseIntent=${JSON.stringify(browseNoTab.value)}` : 'null');
  }
}

/**
 * ============================================================================
 * 第 26 步收尾 · 问题 A / B 专项用例（用户拍板的方案 C：两个都修）
 * ============================================================================
 *
 * 这一节是**新增**的，专门钉住这次修的两个具体场景。
 * 每一条都写清楚"为什么是这个期望"，避免以后有人靠猜改判定。
 */

console.log('\n\n########## 问题 A 专项：开着一张页时，「查资料」不能被当成「在页面上干活」 ##########\n');

/** A-1：这些句子即使**当前正开着一张页**，也不能去驾驶浏览器（该走轻量搜索） */
const A_LOOKUP: Array<[string, string]> = [
  ['帮我查一下今天的美元汇率', '用户报的原句：要的是一条信息，不是"操作这张页"'],
  ['帮我搜一下今天的新闻', '同上（"搜一下"单独出现时不指向页面）'],
  ['查一下碳化硅主要用在哪', '"查资料"的说法 + 没指页面'],
  ['今天北京天气怎么样', '本来就不命中（保底不回归）'],
];
for (const [q, why] of A_LOOKUP) {
  const got = detectBrowseIntent(q);
  chk(`A-1「${q}」不驱动浏览器（${why}）`, got === null, got ? `★ 却得到 ${JSON.stringify(got)}` : 'null');
}

/** A-2：这些句子**必须仍然**发车 —— 它们是"在当前这张页上干活" */
const A_PAGE: Array<[string, string]> = [
  ['在这个页面搜一下 AI', '明确指了这张页'],
  ['在当前页面上搜一下 AI', '★ 这条第一版被我改坏过：被当成"认不出『当前页面』"'],
  ['读一下当前页面', '读当前页 = 只有在页面上才成立'],
  ['往下滚一屏看看', '滚动 = 只有在页面上才成立（浏览器验收用的就是这句）'],
  ['点一下那个按钮', '点击 = 只有在页面上才成立'],
  ['刷新一下', '刷新 = 只有在页面上才成立'],
  ['帮我查一下这个订单', '「这个」指向眼前的东西（页面上那个订单）'],
  ['在搜索框里输入 天气', '输入框 = 页面元素'],
];
for (const [q, why] of A_PAGE) {
  const got = detectBrowseIntent(q);
  chk(`A-2「${q}」仍然发车（${why}）`, got !== null, got ? JSON.stringify(got) : '★ 掉回聊天了（页面操作被吞）');
  // 这些句子也**不该**被当成开页 / 认不出 —— 它们是在当前页干活
  chk(`A-2「${q}」不额外开页`, detectOpenUrl(q) === null, String(detectOpenUrl(q)));
  chk(`A-2「${q}」不向用户要网址`, detectUnknownOpenTarget(q) === null, String(detectUnknownOpenTarget(q)));
}

console.log('\n\n########## 问题 B 专项：「在 X 上…」句式 ##########\n');

/** B-1：点名了登记表里的站点 → 必须能开出地址 */
const B_ON_SITE: Array<[string, string]> = [
  ['帮我在必应上查一下今天的美元汇率', 'https://www.bing.com'],
  ['在京东上比一下这两款耳机的价格', 'https://www.jd.com'],
  ['在抖音上搜一下附近的火锅店', 'https://www.douyin.com'],
  ['在淘宝上看看有没有货', 'https://www.taobao.com'],
  ['在知乎上找找有没有类似的问题', 'https://www.zhihu.com'],
];
for (const [q, want] of B_ON_SITE) {
  const got = detectOpenUrl(q);
  chk(`B-1「${q}」能解析出站点`, got === want, `得到 ${JSON.stringify(got)}（期望 ${want}）`);
  // 有活要干 ⇒ 不是"纯开页"，得发车
  chk(`B-1「${q}」判为「还有活要干」（不是纯开页）`, !isPureOpenCommand(q));
  // 互斥：能开页就不能同时说"认不出"
  chk(`B-1「${q}」不判为认不出`, detectUnknownOpenTarget(q) === null, String(detectUnknownOpenTarget(q)));
}

/** B-2：★★ 防误报 —— 「在 X 上」的 X 不是站点名时，什么都不能做（陈述 / 泛名词） */
const B_NOT_SITE: Array<[string, string]> = [
  ['我在百度上看到一条新闻', '陈述句（"看到"是感知动词，不是干活的指令）'],
  ['我在淘宝上买了个东西', '陈述句'],
  ['在电脑上查一下今天的新闻', '"电脑"不是站点名（泛名词）'],
  ['在网上查一下今天的新闻', '"网"是单字泛名词'],
  ['在这里查一下资料', '页面指代，不是站点名'],
];
for (const [q, why] of B_NOT_SITE) {
  chk(`B-2「${q}」不开页（${why}）`, detectOpenUrl(q) === null, String(detectOpenUrl(q)));
  chk(`B-2「${q}」不误报"认不出"（${why}）`, detectUnknownOpenTarget(q) === null,
    `★ 却得到 ${JSON.stringify(detectUnknownOpenTarget(q))}`);
}

/** B-3：真认不出的站点名，要**报对名字**（不能报"上"后面那截） */
const B_UNKNOWN: Array<[string, string]> = [
  ['在某某商城上查一下有没有货', '某某商城'],
  ['在Acme官网上查一下有没有货', 'Acme官网'],
];
for (const [q, want] of B_UNKNOWN) {
  const got = detectUnknownOpenTarget(q);
  chk(`B-3「${q}」报出的是站点名本身`, got === want, `得到 ${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`);
}

console.log('\n\n########## E. 边界扫描沉淀（A/B 修复后，自己扫出来的误判面）##########\n');
/**
 * ★★ 这一组是**我自己做对抗性扫描扫出来的**，不是简报里的用例。
 *
 * 背景：A/B 两处修复最怕的不是"没修好"，而是**改出新误判**。
 *   修复前 `detectUnknownOpenTarget` 会把「厨房」「打开设置」「看到一条新闻」这类
 *   **根本不是站点名**的东西报成"认不出" ⇒ 用户收到一句
 *   「我认不出『厨房』是哪个网站」，属于把 bug 从"不吭声"换成"添乱"。
 *
 * 每条都写清判据，方便日后回归时判断"期望值本身是不是写错了"。
 */

/** E-1：物理场所 / 家居物品 —— 绝不能当成站点名（否则弹"认不出"） */
const E_PLACE: Array<[string, string]> = [
  ['在厨房里看看有什么吃的', '「厨房」是物理场所'],
  ['在图书馆里查资料', '「图书馆」是物理场所'],
  ['在卧室里躺着', '「卧室」是物理场所'],
  ['在公园里散步', '「公园」是物理场所'],
  ['在沙发上躺一会儿', '「沙发」是家具'],
  ['在纸上写一下', '「纸」是物品'],
];
for (const [q, why] of E_PLACE) {
  chk(`E-1「${q}」不开页（${why}）`, detectOpenUrl(q) === null, String(detectOpenUrl(q)));
  chk(`E-1「${q}」不误报"认不出"（${why}）`, detectUnknownOpenTarget(q) === null,
    `★ 却得到 ${JSON.stringify(detectUnknownOpenTarget(q))}`);
}

/** E-2：**明确指外部**的对象 —— 不能判成"在当前页干活"（那会去驾驶浏览器） */
const E_EXTERNAL: Array<[string, string]> = [
  ['读一下《三体》第一章讲了啥', '书名号 = 明确的外部作品'],
  ['读一下那篇论文的摘要', '「那篇论文」不是眼前这张页'],
  ['看一下网上怎么说', '「网上」= 泛指'],
  ['读一下我的笔记', '「我的笔记」不是当前页'],
  ['帮我看一下这段代码什么意思', '「这段代码」不是网页'],
];
for (const [q, why] of E_EXTERNAL) {
  chk(`E-2「${q}」不判为页面操作（${why}）`, detectBrowseIntent(q) === null,
    `★ 却得到 ${JSON.stringify(detectBrowseIntent(q))}`);
}

/**
 * E-3：**明确指当前页** —— 必须保住页面操作。
 *
 * ★ 这一组是 E-2 的**反向保护**：收紧"查资料"判定时最容易顺手把这些也掐掉，
 *   那会让「读一下当前页面」这类正当请求发不出车（功能倒退）。
 */
const E_CURRENT: Array<[string, string]> = [
  ['读一下当前页面的正文', '显式指代'],
  ['看一下这个页面上写了什么', '显式指代'],
  ['读一下这个网页的内容', '显式指代'],
  ['在当前页面上搜一下 AI', '显式指代 + 任务动词'],
  ['往下滚一屏', '只有页面上才成立的动作'],
  ['点一下那个按钮', '只有页面上才成立的动作'],
  ['在搜索框里输入 天气', '页面元素名，且含任务动词「搜索」'],
];
for (const [q, why] of E_CURRENT) {
  chk(`E-3「${q}」仍判为页面操作（${why}）`, detectBrowseIntent(q) !== null,
    '★ 页面操作被掐掉了 —— 功能倒退');
  chk(`E-3「${q}」不误报"认不出"（${why}）`, detectUnknownOpenTarget(q) === null,
    `★ 却得到 ${JSON.stringify(detectUnknownOpenTarget(q))}`);
}

/** E-4：页面元素名 —— 一定不是站点名 */
for (const [q, why] of [
  ['在输入框里填上我的邮箱', '「输入框」是页面元素'],
  ['在地址栏里输入网址', '「地址栏」是页面元素'],
] as Array<[string, string]>) {
  chk(`E-4「${q}」不误报"认不出"（${why}）`, detectUnknownOpenTarget(q) === null,
    `★ 却得到 ${JSON.stringify(detectUnknownOpenTarget(q))}`);
}

/**
 * E-5：**真模糊**（只观察，不断言）—— 记下来给用户拍板，不擅自定对错。
 *
 * 「这篇文章 / 这个新闻」在**开着页**时最自然的指代就是眼前那张页 ⇒
 * 判成页面操作是**设计意图**，不是 bug。但反过来说也可能指别处，所以只记录现状。
 */
/**
 * E-6：**已知边界**（只记录，不断言）—— 第三轮对抗扫描（否定句 / 疑问 / 英文）扫出来的，
 *     每一条都**带设计取舍**，所以按规矩**只报告、不擅自改**：
 *
 *   ① 否定句「不要打开百度」「别打开抖音」→ 现在**仍会开页**。
 *      正解不是简单加个否定词表：「不要打开百度，打开必应」这种**复合指令**里，
 *      否定只作用于前半句 —— 一刀切会让后半句也发不出车。
 *   ② 「打开百度是什么意思」→ 现在会开页。看起来该按疑问句放过，
 *      但「是什么意思」同时是**页面操作**的常见说法（「读一下这是什么意思」= 读当前页），
 *      加进 `looksLikeQuestion` 会把后者一起掐掉 ⇒ 必须先想清楚怎么区分。
 *   ③ 英文指令「open baidu」→ 能开。★ **这一条不是缺陷**：`VERB` 里本来就有
 *      `open|go to|load`（第 24 步就这么设计的），所以它属于**有意支持**的能力。
 *      列在这里只是让"英文指令"这件事在报告里有出处，不需要改。
 *
 * ⚠️ 剩下三条是**已知的、有意留下的**边界，不是"还没发现的问题"。
 */
/** E-7：**裸动词**不该弹浏览器（第三轮扫描扫出来的） */
for (const [q, why] of [
  ['上', '裸「上」——VERB 里有它，但光一个「上」不是指令'],
  ['去', '裸「去」'],
  ['在沙发上', '「在 X 上」形状但没有动作'],
] as Array<[string, string]>) {
  chk(`E-7「${q}」不开页（${why}）`, detectOpenUrl(q) === null,
    `★ 却得到 ${JSON.stringify(detectOpenUrl(q))?.slice(0, 40)}`);
}
/**
 * ★ 反向保护：**明确开页动词**的空目标仍要落到主页（「打开浏览器」这类真用法）。
 *   收紧 E-7 时最容易顺手把这条也掐掉。
 */
chk('E-7「打开」仍落到默认主页（明确开页动词的空目标）',
  (detectOpenUrl('打开') ?? '').startsWith('data:'), String(detectOpenUrl('打开')).slice(0, 30));

console.log('\n--- E-6 已知边界（带设计取舍，等拍板；只记录不断言）---');
for (const [q, now] of [
  ['不要打开百度', '仍会开页（否定句）'],
  ['别打开抖音', '仍会开页（否定句）'],
  ['打开百度是什么意思', '仍会开页（疑问）'],
  ['open baidu', '会开页 —— **设计如此**（VERB 里本来就有 open|go to|load），不是缺陷'],
] as Array<[string, string]>) {
  const o = detectOpenUrl(q);
  console.log(`  [INFO]「${q}」→ ${o ? '开页 ' + String(o).slice(0, 40) : '不开页'}｜现状：${now}`);
}

console.log('\n--- E-5 模糊指代（仅观察，不断言）---');
for (const q of ['读一下这篇文章讲了啥', '看一下这个新闻的详情', '读一下这篇文章']) {
  const b = detectBrowseIntent(q);
  console.log(`  [INFO]「${q}」→ ${b ? '页面操作（在开着页时会去驾驶浏览器）' : '聊天路径'}`);
}

console.log('\n\n########## 回归：原有的「打开 X」链路一行都没被影响 ##########\n');
for (const [q, want, pure] of [
  ['打开必应', 'https://www.bing.com', true],
  ['打开抖音搜索附近的火锅店，给我出一份报告', 'https://www.douyin.com', false],
  ['打开淘宝帮我比一下这两款耳机的价格', 'https://www.taobao.com', false],
  ['打开速卖通官网', 'https://www.aliexpress.com', true],
  ['打开 example.com', 'https://example.com', true],
] as Array<[string, string, boolean]>) {
  chk(`R「${q}」仍能开页`, detectOpenUrl(q) === want, String(detectOpenUrl(q)));
  chk(`R「${q}」纯开页判定=${pure}`, isPureOpenCommand(q) === pure, String(isPureOpenCommand(q)));
}

console.log(`\n===== 汇总：${pass} PASS / ${fail} FAIL =====`);
if (fail > 0) console.log('失败项：\n - ' + failures.join('\n - '));
process.exitCode = fail === 0 ? 0 : 1;
