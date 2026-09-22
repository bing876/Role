/**
 * 第 18 步 · 浏览器模块：「打开某站点」→ URL。
 *
 * 识别刻意保守：**先要有开网页的动词，再要能解析出具体目标**（已登记站点 / 裸域名 / 显式 URL）。
 * 只提到关键词（「浏览器一般有几个进程」）不会命中；问句（怎么/如何/吗）也不命中。
 * 全程只做**字符串**判断：不联网、不问模型——猜错就会乱开网页。
 */

/**
 * ★ 第 24 步（用户拍板）：新开一张页**不再默认加载百度**。
 *
 * 原来是 `https://www.baidu.com` —— 用户点「＋」就悄悄发一个对百度的请求，
 * 既慢、又莫名其妙（"我还没说要开什么，凭什么先替我访问一个第三方站点"）。
 *
 * 现在改成工作台**自己的空白起始页**：一个内联的 data: URL，
 *   · **不发任何网络请求**（打开是瞬时的，不依赖网络）；
 *   · 地址栏是空的，等用户自己输；
 *   · 中间列几个常用站点快捷入口，想点哪个点哪个。
 *
 * 用 `about:blank` 与带内容的起始页的差别：
 *   纯 blank 打开后是一片白，用户会发愣「然后呢」；
 *   起始页能在零网络成本的前提下把「你可以干什么」摆出来。
 */
export const START_PAGE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>新标签页</title>
<style>
  html,body{height:100%%;margin:0}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;
       font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#3c3c43;
       background:#fbfbfd;-webkit-user-select:none;user-select:none}
  .brand{font-size:15px;font-weight:500;color:#8a8a8f;letter-spacing:.02em}
  .grid{display:flex;flex-wrap:wrap;gap:10px;max-width:520px;justify-content:center;padding:0 24px}
  a{display:flex;align-items:center;justify-content:center;min-width:88px;padding:11px 16px;
    border:1px solid #e6e6ea;border-radius:12px;background:#fff;color:#3c3c43;
    text-decoration:none;font-size:13px;transition:border-color .15s,background .15s}
  a:hover{border-color:#c9c9d0;background:#f6f6f8}
  .hint{font-size:12px;color:#a0a0a6;text-align:center;line-height:1.8;padding:0 24px}
</style></head><body>
<div class="brand">新标签页</div>
<div class="grid">
  <a href="https://www.baidu.com" target="_blank">百度</a>
  <a href="https://www.taobao.com" target="_blank">淘宝</a>
  <a href="https://www.douyin.com" target="_blank">抖音</a>
  <a href="https://chatgpt.com" target="_blank">ChatGPT</a>
  <a href="https://www.doubao.com" target="_blank">豆包</a>
  <a href="https://www.aliexpress.com" target="_blank">速卖通</a>
</div>
<div class="hint">在上面地址栏输入网址，或点上面的入口。<br>也可以直接在聊天里说「打开某网站」。</div>
</body></html>`;

/** 起始页的地址（data: URL；用 encodeURIComponent 保证中文标题等不出错） */
export const HOME_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(START_PAGE_HTML);

/**
 * 这个地址是不是「起始页」。
 *
 * 用途：判断「当前这张页是不是还没去过任何真实站点」——
 * 比如同站复用、或点「＋」时不要因为"两个 data: 页同名"就误当成同一个站。
 */
export function isStartPage(url: string): boolean {
  return typeof url === 'string' && url.startsWith('data:text/html');
}

/** 登记站点：名字 → 首页。匹配先全等、再前缀（「打开百度搜天气」也能落在百度） */
const SITES: Array<[string, string]> = [
  ['baidu', 'https://www.baidu.com'],
  ['百度', 'https://www.baidu.com'],
  ['douyin', 'https://www.douyin.com'],
  ['抖音', 'https://www.douyin.com'],
  // 第 16 步：补上「油管」这类口语站点名——验收里就有一条「改口打开油管」，
  // 名字不在表里的话 detectOpenUrl 会返回 null，页开不出来，看着像「改口没生效」。
  ['youtube', 'https://www.youtube.com'],
  ['油管', 'https://www.youtube.com'],
  ['youku', 'https://www.youku.com'],
  ['优酷', 'https://www.youku.com'],
  ['抖店', 'https://fxg.jinritemai.com'],
  ['jinritemai', 'https://fxg.jinritemai.com'],
  ['toutiao', 'https://www.toutiao.com'],
  ['头条', 'https://www.toutiao.com'],
  ['kuaishou', 'https://www.kuaishou.com'],
  ['快手', 'https://www.kuaishou.com'],
  ['xiaohongshu', 'https://www.xiaohongshu.com'],
  ['小红书', 'https://www.xiaohongshu.com'],
  ['weibo', 'https://weibo.com'],
  ['微博', 'https://weibo.com'],
  ['zhihu', 'https://www.zhihu.com'],
  ['知乎', 'https://www.zhihu.com'],
  ['bilibili', 'https://www.bilibili.com'],
  ['b站', 'https://www.bilibili.com'],
  ['哔哩哔哩', 'https://www.bilibili.com'],
  ['taobao', 'https://www.taobao.com'],
  ['淘宝', 'https://www.taobao.com'],
  ['tmall', 'https://www.tmall.com'],
  ['天猫', 'https://www.tmall.com'],
  ['jingdong', 'https://www.jd.com'],
  ['jd', 'https://www.jd.com'],
  ['京东', 'https://www.jd.com'],
  ['pinduoduo', 'https://mobile.yangkeduo.com'],
  ['pdd', 'https://mobile.yangkeduo.com'],
  ['拼多多', 'https://mobile.yangkeduo.com'],
  ['meituan', 'https://www.meituan.com'],
  ['美团', 'https://www.meituan.com'],
  ['eleme', 'https://www.ele.me'],
  ['饿了么', 'https://www.ele.me'],
  ['ctrip', 'https://www.ctrip.com'],
  ['携程', 'https://www.ctrip.com'],
  ['12306', 'https://www.12306.cn'],
  ['qq', 'https://www.qq.com'],
  ['腾讯', 'https://www.qq.com'],
  ['wangyi', 'https://www.163.com'],
  ['163', 'https://www.163.com'],
  ['网易', 'https://www.163.com'],
  ['sina', 'https://www.sina.com.cn'],
  ['新浪', 'https://www.sina.com.cn'],
  ['github', 'https://github.com'],
  ['google', 'https://www.google.com'],
  ['谷歌', 'https://www.google.com'],
  ['必应', 'https://www.bing.com'],
  ['bing', 'https://www.bing.com'],
  // ★ 第 23 步补：用户实测「打开速卖通官网」「打开chatgpt」都开不出来 ——
  //   这两个名字不在表里，detectOpenUrl 返回 null，于是整条开页链路根本不启动，
  //   用户看到的就是「说了第二遍还是没反应」。
  //   登记表是**纯字符串**匹配（脱网、不问模型），所以常用站点必须显式列出来。
  ['速卖通', 'https://www.aliexpress.com'],
  ['aliexpress', 'https://www.aliexpress.com'],
  ['阿里巴巴', 'https://www.alibaba.com'],
  ['alibaba', 'https://www.alibaba.com'],
  ['1688', 'https://www.1688.com'],
  ['chatgpt', 'https://chatgpt.com'],
  ['openai', 'https://chatgpt.com'],
  ['claude', 'https://claude.ai'],
  ['gemini', 'https://gemini.google.com'],
  // 国产 AI（用户报「打开豆包 / 打开千问」没反应 —— 这两个当时都不在表里）
  ['豆包', 'https://www.doubao.com'],
  ['doubao', 'https://www.doubao.com'],
  ['千问', 'https://www.tongyi.com'],
  ['通义', 'https://www.tongyi.com'],
  ['通义千问', 'https://www.tongyi.com'],
  ['tongyi', 'https://www.tongyi.com'],
  ['qwen', 'https://www.tongyi.com'],
  ['deepseek', 'https://chat.deepseek.com'],
  ['kimi', 'https://kimi.moonshot.cn'],
  ['月之暗面', 'https://kimi.moonshot.cn'],
  ['文心一言', 'https://yiyan.baidu.com'],
  ['文心', 'https://yiyan.baidu.com'],
  ['智谱', 'https://chatglm.cn'],
  ['chatglm', 'https://chatglm.cn'],
  ['讯飞星火', 'https://xinghuo.xfyun.cn'],
  ['星火', 'https://xinghuo.xfyun.cn'],
  ['元宝', 'https://yuanbao.tencent.com'],
  ['腾讯元宝', 'https://yuanbao.tencent.com'],
  ['grok', 'https://grok.com'],
  ['perplexity', 'https://www.perplexity.ai'],
  ['copilot', 'https://copilot.microsoft.com'],
  ['gmail', 'https://mail.google.com'],
  ['谷歌邮箱', 'https://mail.google.com'],
  ['outlook', 'https://outlook.live.com'],
  ['youtube', 'https://www.youtube.com'],
  ['油管', 'https://www.youtube.com'],
  ['twitter', 'https://x.com'],
  ['推特', 'https://x.com'],
  ['x', 'https://x.com'],
  ['facebook', 'https://www.facebook.com'],
  ['ins', 'https://www.instagram.com'],
  ['instagram', 'https://www.instagram.com'],
  ['linkedin', 'https://www.linkedin.com'],
  ['reddit', 'https://www.reddit.com'],
  ['amazon', 'https://www.amazon.com'],
  ['亚马逊', 'https://www.amazon.com'],
  ['temu', 'https://www.temu.com'],
  ['shopee', 'https://shopee.com'],
  ['lazada', 'https://www.lazada.com'],
  ['wish', 'https://www.wish.com'],
  ['shein', 'https://www.shein.com'],
  ['douban', 'https://www.douban.com'],
  ['豆瓣', 'https://www.douban.com'],
  ['juejin', 'https://juejin.cn'],
  ['掘金', 'https://juejin.cn'],
  ['csdn', 'https://www.csdn.net'],
  ['stackoverflow', 'https://stackoverflow.com'],
  ['weixin', 'https://wx.qq.com'],
  ['微信', 'https://wx.qq.com'],
  ['example.com', 'https://example.com'],
];

/** 没指定站点时的说法 */
const GENERIC = /^(浏览器|网页|网址|浏览器窗口|网页版|一个网页|下网页|个网页)$/;

/** 开网页动词。长的排前面，避免「去一下」被单个「去」截断 */
const VERB = /(打开|開啟|开启|启动|啟動|訪問|访问|浏览|瀏覽|去一下|去个|去個|上个|上一下|进一下|看一下|看下|去|上|进|open|go\s*to|load)/i;

/** 站点名后面常见的零碎后缀，去掉再匹配 */
const TAIL = /(首页|首頁|官网|官網|网站|網站|网页|網頁|看看|一下|瞅瞅|瞧瞧|看看|吧|呢|啊)$/;

const BARE_DOMAIN = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

/** 问句不开网页（「怎么打开百度」是提问不是指令）——intent.ts 也复用它 */
export function looksLikeQuestion(t: string): boolean {
  return /^(怎么|如何|为什么|為什麽|怎样|怎樣|啥|什么|試試|是不是|能不能|可以)/.test(t) || /吗|嗎|？|\?/.test(t);
}

/**
 * ★★ 第 26 步（用户拍板的方案 C · 问题 B）：「在 X 上 / 在 X 里」句式。
 *
 * 用户报的原始症状：「帮我在必应上查一下今天的美元汇率」
 *   —— **既没被识别成开页**（动词表 `VERB` 里没有「在…上」这种说法，
 *      剥出来的是「上」后面那截「查一下今天的美元汇率」，落不到任何站点），
 *   **也没被识别成「认不出的站点」**（同一套剥壳逻辑，目标同样是错的那一截），
 *   于是整句落回普通聊天：页没开、也没真的查到东西。
 *
 * 这一类的形态是「**在 + 站点名 + 上/里/中 + 干活**」：
 *   在必应上查一下汇率 / 在京东上比一下价格 / 在抖音上搜一下火锅
 *
 * ★ 为什么必须**同时**要求「干活动词」：只有「在 X 上」不算指令 ——
 *   「我在百度上看到一条新闻」是**陈述**，把它当开页指令就是新的误判。
 *   （「看到 / 听说 / 见过」这类感知动词不在 `ON_SITE_VERB` 里，所以不会被抓。）
 */
const ON_SITE_VERB =
  /(查一下|查一查|查查|查询|查找|查个|搜一下|搜一搜|搜搜|搜索|搜个|找一下|找一找|找找|比一下|比比|比价|看一下|看看|看下|读一下|读读|点一下|点开|点击|填一下|登录|下单|购买|下载|收藏|关注|评论|发布|刷新|翻页|操作)/;
const ON_SITE = /在\s*([^\s，,。；;！!？?）)】"'「」]{1,20}?)\s*(?:上|里|中|里面|上面)/;

/**
 * ★★ 第 26 步收尾补：「在 X 上/里/中」这个**句式形状**（不管有没有干活动词）。
 *
 * 为什么需要它单独存在：`VERB` 里有一个**裸「上」**（因为「上淘宝看看」是真用法），
 *   于是任何「在 X 上…」的句子，只要没被 `ON_SITE_VERB` 认定成指令，就会掉进动词路径、
 *   被那个「上」咬住，剥出「上」**后面**那截当目标 ——
 *   实测：「在沙发上躺一会儿」被报成「我认不出『躺一会儿』是哪个网站」。
 *
 * 判据：只要句子是这个形状，那个「上/里/中」就是**句式的一部分、不是动词** ⇒
 *   **不再走动词路径**。（形状成立但剥不出站点名时，如实说"认不出"或干脆交给聊天路径，
 *   都远比报一个错名字好。）
 */
const ON_SHAPE = /在\s*[^\s，,。；;！!？?）)】"'「」]{1,20}?\s*(?:上|里|中|里面|上面)/;

/**
 * 从「在 X 上…」句式里剥出 X（**原样**，不做登记表匹配）。
 * 不是这类句式、或句子里没有明确的干活动词，就返回 null。
 */
export function targetFromOnPattern(raw: string): string | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  if (!ON_SITE_VERB.test(t)) return null;
  const m = ON_SITE.exec(t);
  return m ? m[1].trim() : null;
}

/**
 * 登记表查名字：全等优先，再前缀（「打开百度搜天气」也算要开百度）。
 * 查不到返回 null。
 */
function lookupSite(name: string): string | null {
  const lower = name.toLowerCase();
  const exact = SITES.find(([n]) => n === lower || n === name);
  if (exact) return exact[1];
  const prefixed = SITES.find(([n]) => n.length >= 2 && lower.startsWith(n.toLowerCase()));
  return prefixed ? prefixed[1] : null;
}

/**
 * 「在 X 上」里的 X 常见、但**根本不是站点名**的说法。
 *
 * 为什么必须有这条：「在电脑上查一下」「在网上查一下」是完全正常的说法，
 * 不加拦的话会被回一句「我认不出『电脑』是哪个网站」——
 * 那是把误判从"不吭声"换成了"添乱"，比原问题更糟。
 *
 * ★★ 第 26 步收尾补：**物理场所 / 家居物品**也属于这一类，原来漏在表外。
 *   实测：「在厨房里看看有什么吃的」会被「在 X 里」句式剥出 X=「厨房」，
 *   而它长度、字符集、无指示代词全都合格 ⇒ 用户会收到「我认不出『厨房』是哪个网站」。
 *
 * ⚠️ 这张表只放**位置无关的场所/物品**，不要往里塞真站名 ——
 *   真站名靠 `lookupSite()` 命中，不靠这里放行。
 */
const NOT_SITE_ON =
  /^(电脑|手機|手机|平板|網|网|网上|網上|互联网|网络|本地|这里|这儿|那里|那边|这边|上面|下面|公司|家|家里|线下|现实|电话|纸上|地图|账|账面|实际|理论|原则|基础|整体|大体|基本|事实|历史|世界|市场|行业|流程|公开资料|公开信息|厨房|廚房|臥室|卧室|客厅|客廳|房間|房间|屋里|屋裏|床上|桌上|桌子上|墙上|牆上|车里|車裏|车上|路上|街上|公园|公園|超市|商场|商場|医院|醫院|学校|學校|教室|办公室|辦公室|会议室|會議室|会场|會場|图书馆|圖書館|地铁|地鐵|公交|飞机|飛機|火车|火車|电视|電視|报纸|報紙|杂志|雜誌|广播|廣播|餐厅|餐廳|食堂|洗手间|衛生間|卫生间|厕所|厕所|陽台|阳台|院子|门口|門口|楼下|樓下|楼上|樓上|沙发|沙發|椅子|桌子|床边|床邊|窗外)$/;


/**
 * 「不是站点名」的字面特征（指示代词 / 助词 / 标点）。
 *
 * ★ 这条是测试逼出来的：我第一版只做了"纯中英文数字"的字面检查，
 *   结果「打开这个文件」「打开我昨天写的报告」都被判成了认不出 —— 测试当场抓到两条误报。
 */
const NOT_A_SITE = /[这个那哪些什么我的你他她它了的吗呢吧啊哦呀咿矣焉哉？!！。，、；：]/;

/**
 * 含这些**动作 / 感知**词的目标一定不是站点名。
 *
 * 为什么单列一条：「我在百度上看到一条新闻」是**陈述**，
 * 而「在 X 上」剥出来的 X 会是「看到一条新闻」—— 长度、字符集、无指示代词，
 * 上面那些判据全都放它过去，于是用户会收到「我认不出『看到一条新闻』是哪个网站」。
 * 这一类必须是**零误报**的（比"漏报"重要得多）。
 */
const NOT_SITE_VERB =
  /(看到|看到|听说|聽説|见过|見過|找到|想到|说到|說道|写到|寫到|买到|買到|收到|发了|發了|写了|寫了|看了|买了|買了|去了|来了|來了|做过|做過|说过|説過|搜过|搜過|查过|查過)/;

/**
 * ★ 明确指代「眼前这张页 / 这个网页」的说法。
 *
 * 放在 sites.ts 而不是 intent.ts，是因为**两边都要用**：
 *   · intent.ts  —— 「有页面指代 ⇒ 这是页面操作，不是查资料」；
 *   · sites.ts   —— 「认不出的站点名**不能**是页面指代」（否则
 *     「在当前页面上搜一下 AI」会被回一句「我认不出『当前页面』」，
 *     而它本来是**该发车**的页面操作 —— 这是测试当场抓到的回归）。
 * intent.ts 从这里 import，避免两份词表各写各的、日后改一处漏一处。
 */
export const PAGE_REF =
  /(这个页面|这页面|当前页面|当前这张|这张页面|这张页|这页|本页|该页|当前页|这个网页|这网页|这个网站|这网站|当前网站|这个站|本站|页面上|网页上|网站上|这个卡片|这张卡片|当前卡片|在这里|在这儿|在这页|在页面上|在网站上|它上面)/;

/**
 * **明确的开页动词** —— 只有这些动词的「空目标」才等于"要开浏览器"（落到默认主页）。
 *
 * ★★ 第 26 步收尾补：`VERB` 里除「打开」外还有**裸「上」/「去」/「看」/「查」**
 *   （因为「上淘宝看看」是真用法）。于是光敲一个「上」或「去」时，剥出的目标为空，
 *   原来会**无条件** `return HOME_URL` ⇒ 用户什么都没说，浏览器却弹出一张主页。
 *   实测：「上」→ 打开主页。
 */
const OPEN_VERB_ONLY = /(打开|開啟|开启|启动|啟動|访问|訪問|浏览|瀏覽)/;

/**
 * 目标**以动词开头** ⇒ 它是「动词 + 宾语」，不是站点名。
 *
 * 典型：「打开设置」「查一下汇率」「看看这个」。
 * ⚠️ 必须在 `lookupSite()` 之后用（否则会误伤「去哪儿」这类真站名）。
 */
const NOT_SITE_VERB_PREFIX =
  /^(打开|開啓|开启|啟動|启动|訪問|访问|浏览|瀏覽|去|上|进|進|看|查|搜|找|比|点|點|填|登录|登入|下单|购买|下载|收藏|关注|评论|发布|刷新|翻页|读|讀|了解|试试|帮)/;

/**
 * 页面元素名词 —— 一定不是站点名。
 *
 * ★ 这条是**新用例当场抓出来的**：「在搜索框里输入 天气」会被「在 X 里」句式剥出「搜索框」，
 *   而它恰好含「搜索」（一个任务动词），所以前面几道闸全都放它过去，
 *   用户会收到「我认不出『搜索框』是哪个网站」—— 而那句话本来是**该发车**的页面操作。
 *   所以必须在**目标**这一侧再拦一道。
 */
const NOT_SITE_ELEMENT =
  /(搜索框|输入框|搜索栏|地址栏|输入栏|导航栏|工具栏|侧边栏|滚动条|进度条|按钮|图标|菜单|标签页|标签|下拉框|下拉菜单|选项|复选框|单选框|弹窗|对话框|表单|标题|正文|段落|列表|表格|图片|视频|音频|评论|回复|附件|链接|文件|文件夹|页面|网页|网站|网址|卡片)$/;

/**
 * 这个字符串**像不像一个站点名**（用于「认不出」的判定）。
 *
 * 抽成公共函数，是因为现在有**两条**路径都要做同一套判断：
 *   ① `detectOpenUrl` 剥出来的目标；②「在 X 上」句式里的 X。
 * 两边判据必须完全一致，否则「同一个名字，一条路说认不出、另一条路说能开」。
 */
function looksLikeSiteName(site: string): boolean {
  if (!site) return false;
  // 站点名至少两个字：单字（「网」「上」「x」）几乎不可能是用户想指的站
  if (site.length < 2) return false;
  if (NOT_SITE_ON.test(site)) return false;
  if (NOT_SITE_VERB.test(site)) return false;
  if (NOT_SITE_ELEMENT.test(site)) return false;
  // 页面指代（「当前页面」「这个网站」）绝不是站点名 —— 那是"在眼前这张页上干活"
  if (PAGE_REF.test(site)) return false;
  /**
   * 只认「像站点名」的目标。这一步是**防误报的关键** ——
   * 如果什么都算"认不出"，用户说「打开这个文件」也会被回一句「我认不出这个网站」，
   * 那是把 bug 从"撒谎"换成"添乱"，一样不行。
   *
   * 站点名的实际形态：短、干净，基本是「专名」——豆包 / 千问 / 小红mall / 公司内网。
   * 而下面这些**不是站点名**，必须放过：
   *   · 含指示代词：「这个 / 那个 / 这个页 / 刚才那个」
   *   · 含助词/量词性词：「的 / 了 / 我 / 你 / 昨天 / 报告」（「我昨天写的报告」）
   *   · 太长（> 12 个字基本是在描述一件事，不是在报站点名）
   */
  if (NOT_A_SITE.test(site)) return false;
  if (!/^[\u4e00-\u9fa5a-zA-Z0-9][\u4e00-\u9fa5a-zA-Z0-9\-]*$/.test(site)) return false;
  if (site.length > 12) return false;
  // 登记表里有（含前缀命中）→ 说明能开，不算认不出（双保险，避免逻辑改动后错报）
  if (lookupSite(site)) return false;
  /**
   * ★★ 第 26 步收尾补：目标是「**动词 + 宾语**」而不是站名。
   *
   * 为什么必须补：`VERB` 里有**裸「上」**（因为「上淘宝看看」是真用法），
   *   于是「在这台电脑上打开设置」会先被咬住那个「上」，剥出的目标变成
   *   「打开设置」⇒ 用户收到「我认不出『打开设置』是哪个网站」。
   *
   * 放在 `lookupSite()` 之**后**：先让登记表说话——「去哪儿」「上海」这类**真的以动词开头的站名**
   *   会在上一行就被放行，不会被误伤。
   */
  if (NOT_SITE_VERB_PREFIX.test(site)) return false;
  return true;
}

/**
 * 从一句用户原话里解析出要打开的网页地址；不是开网页指令就返回 null。
 */
export function detectOpenUrl(raw: string): string | null {
  const t = (raw ?? '').trim();
  if (!t || t.length > 200 || looksLikeQuestion(t)) return null;

  // 1) 显式 URL：带开网页动词，或整句基本就是这个地址
  const m = t.match(/https?:\/\/[^\s，,。；;！!？?）)】"'「」]+/i);
  if (m) {
    const verb = VERB.test(t);
    // 整句就是个地址（允许首尾几个零碎字符）时，不必强求动词
    if (verb || m[0].length >= t.length - 3) return m[0];
  }

  /**
   * 1.5) ★ 第 26 步：「在 X 上…」句式。
   *      放在动词路径**之前** —— 因为 VERB 会先咬住那个「上」字，
   *      剥出来的目标就变成「上」后面那截（「查一下今天的美元汇率」），永远落不到站点。
   */
  if (ON_SHAPE.test(t)) {
    const onTarget = targetFromOnPattern(t);
    if (onTarget) {
      const hit = lookupSite(onTarget);
      if (hit) return hit;
    }
    // ★ 形状成立就**到此为止**：那个「上」是句式的一部分，走动词路径只会剥出错误目标。
    //   没登记时交给 detectUnknownOpenTarget 去决定"如实说认不出"还是"什么都不说"。
    return null;
  }

  // 2) 动词 + 目标
  const vm = VERB.exec(t);
  if (!vm) return null;

  // 先剥动词后的零碎量词（「打开一下淘宝」→「淘宝」），再反复剥后缀
  let site = t
    .slice(vm.index + vm[0].length)
    .trim()
    .replace(/\s+/g, '')
    .replace(/^(一下|一|个|下|個)+/, '');
  // 反复剥后缀（「打开百度首页看看」→「百度」）
  for (let i = 0; i < 3; i += 1) {
    const next = site.replace(TAIL, '');
    if (next === site) break;
    site = next;
  }
  // 「打开」这类**明确开页动词**的空目标 → 落到默认主页（如「打开浏览器」）；
  // 裸「上」/「去」/「看」的空目标 → 不是开页指令（见 OPEN_VERB_ONLY 注释）
  if (!site) return OPEN_VERB_ONLY.test(t) ? HOME_URL : null;
  if (GENERIC.test(site)) return HOME_URL;

  const lower = site.toLowerCase();
  // 全等优先
  const exact = SITES.find(([name]) => name === lower || name === site);
  if (exact) return exact[1];
  // 裸域名（含 www.baidu.com / example.com）
  if (BARE_DOMAIN.test(lower)) return `https://${lower}`;
  // 前缀：「打开百度搜天气」也算要开百度
  const prefixed = SITES.find(([name]) => name.length >= 2 && lower.startsWith(name.toLowerCase()));
  if (prefixed) return prefixed[1];
  return null;
}

/**
 * ★ 认不出的「开页」指令（第 24 步补）。
 *
 * 背景（用户报的原始症状）：
 *   用户说「打开豆包」，但豆包**不在登记表**里 → `detectOpenUrl` 返回 null
 *   → 桌面**没有开任何页**、也**没有带 `browserOpened`** 上去
 *   → 但用户那句话**照样发给了模型**，模型看到一个「打开」的动词，
 *     就**自己编了一句「已经为你打开豆包」**。
 *   用户看到的是：「消息里说打开了，浏览器里压根没有」——而屏幕上没有任何东西是错的，
 *   只有那句回复在撒谎。
 *
 * 所以要区分三种「detectOpenUrl 返回 null」：
 *   ① 压根不是开页意图（闲聊 / 提问）        → 什么都不做（现状就对）
 *   ② 是开页意图，但**站点名不在表里**        → 必须**如实告诉用户"我没认出这个站点"**
 *   ③ 是开页意图，目标是个裸域名              → 上面已经处理（不会走到这儿）
 *
 * 这个函数只判 ②：**像在指一个具体站点，但表里查不到**。
 * 判定纯字符串、脱网、不问模型 —— 和 detectOpenUrl 同一套剥壳逻辑。
 *
 * @returns 用户想开的那个名字（给提示语用），不是这类情况则返回 null
 */
export function detectUnknownOpenTarget(raw: string): string | null {
  const t = (raw ?? '').trim();
  if (!t || t.length > 200 || looksLikeQuestion(t)) return null;
  // 显式 URL 归 detectOpenUrl 管（会成功），不算"认不出"
  if (/https?:\/\//i.test(t)) return null;

  /**
   * ★ 第 26 步：「在 X 上…」句式里，要开的站点名就是 **X**，
   *   而不是「上」后面那截。
   *
   *   改之前：「在某某商城上查一下有没有货」→ 动词路径咬住「上」→ 目标成了
   *   「查一下有没有货」→ 回一句「我认不出『查一下有没有货』是哪个网站」。
   *   名字错得离谱，用户只会更迷惑。
   *
   *   这里**直接返回**（不走下面的动词路径）：不管 X 像不像站点名，
   *   「上」后面那截都绝不是答案。像站点名就如实说认不出；不像（「在电脑上」）
   *   就返回 null，交给聊天路径，**不要**编一个"认不出"。
   */
  if (ON_SHAPE.test(t)) {
    const onTarget = targetFromOnPattern(t);
    // ★ 形状成立就到此为止：剥不出目标（比如「在沙发上躺一会儿」没有干活动词）时，
    //   绝不能继续走动词路径 —— 那条路会咬住裸「上」，把「躺一会儿」当成站点名报出去。
    if (!onTarget) return null;
    return looksLikeSiteName(onTarget) ? onTarget : null;
  }

  const vm = VERB.exec(t);
  if (!vm) return null;

  let site = t
    .slice(vm.index + vm[0].length)
    .trim()
    .replace(/\s+/g, '')
    .replace(/^(一下|一|个|下|個)+/, '');
  for (let i = 0; i < 3; i += 1) {
    const next = site.replace(TAIL, '');
    if (next === site) break;
    site = next;
  }
  // 「打开浏览器」这类泛指 / 空目标 → 落到主页，不算认不出
  if (!site || GENERIC.test(site)) return null;
  // 裸域名能直连 → 不算认不出
  if (BARE_DOMAIN.test(site.toLowerCase())) return null;

  return looksLikeSiteName(site) ? site : null;
}

/**
 * 第 18 步：这句是不是**纯开页**（只说「打开某站」，没有别的活要干）。
 *
 * 为什么要分清：
 *   - 纯开页（「打开百度」「打开必应」「打开浏览器」）→ 页开出来就完事了，
 *     交给工作区（看顶栏的 tab）就行，**不发车**——否则每开一张页聊天里就多一条
 *     「任务完成 · 某某已打开」，正是本步要治的刷屏，还白烧一次「读页 → 问模型」。
 *   - 带活的（「打开百度搜天气」）→ 照旧发车交给驾驶员。
 *
 * 判定纯字符串、和 detectOpenUrl 同一套剥壳逻辑，不联网不问模型。
 */
export function isPureOpenCommand(raw: string): boolean {
  const t = (raw ?? '').trim();
  if (!t || t.length > 200 || looksLikeQuestion(t)) return false;

  // 整句就是个地址（首尾只许几个零碎字符）
  const m = t.match(/https?:\/\/[^\s，,。；;！!？?）)】"'「」]+/i);
  if (m && m[0].length >= t.length - 3) return true;

  const vm = VERB.exec(t);
  if (!vm) return false;

  let site = t
    .slice(vm.index + vm[0].length)
    .trim()
    .replace(/\s+/g, '')
    .replace(/^(一下|一|个|下|個)+/, '');
  for (let i = 0; i < 3; i += 1) {
    const next = site.replace(TAIL, '');
    if (next === site) break;
    site = next;
  }
  // 「打开浏览器」这类没点名站点的，也算纯开页（落默认主页）
  if (!site || GENERIC.test(site)) return true;

  const lower = site.toLowerCase();
  if (SITES.some(([name]) => name === lower || name === site)) return true;
  if (BARE_DOMAIN.test(lower)) return true;
  return false; // 「打开百度搜天气」：还有活要干
}
