/**
 * 第 26 步验收 · 第 2 层：**模型自己怎么选**（真实 DeepSeek 调用，不是复刻逻辑）。
 *
 * 被测对象就是服务端聊天路径用的那个函数：`dist/search/chatLoop.js` 的
 * `streamChatWithSearch` —— 所以这里是**真跑被测代码**，不是另写一套模拟。
 *
 * 每题记录三件事（都是真实执行痕迹，不是"应该没问题"）：
 *   ① 模型有没有要求联网搜索（以及它自己拟的 query）；
 *   ② 最终回答正文；
 *   ③ 回答语言是不是中文（验证"回答语言跟随系统设置"这条原则）。
 *
 * 边界：不 import 任何浏览器相关模块、不 import llm 之外的桌面代码。
 *
 * 跑法：node scripts/verify/search-tool-decision.mjs
 *      node scripts/verify/search-tool-decision.mjs --only=1,6
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ENV_PATH = path.join(ROOT, 'apps', 'server', '.env');
const DIST = path.join(ROOT, 'apps', 'server', 'dist');
const OUT_DIR = path.join(ROOT, '.workbuddy-ai', 'search-tool-test');

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(',').map((s) => s.trim())) : null;

let pass = 0;
let fail = 0;
const failures = [];
const infos = [];

function chk(id, ok, detail = '') {
  if (ok) pass += 1;
  else {
    fail += 1;
    failures.push(`${id} ${detail}`.trim());
  }
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id}${detail ? ' — ' + detail : ''}`);
  return Boolean(ok);
}

/** 只记录、不计分：用于"这条路径在产品里不可达"的观察值 */
function info(id, detail = '') {
  infos.push(`${id} ${detail}`.trim());
  console.log(`[INFO] ${id}${detail ? ' — ' + detail : ''}`);
}

function loadDotEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const CASES = [
  // ---- 类 1：该走搜索（≥2）----
  { id: '1', q: '今天有什么新闻', expect: 'search' },
  { id: '2', q: '今天北京天气怎么样', expect: 'search' },
  { id: '3', q: '最近 OpenAI 有什么新消息', expect: 'search' },
  { id: '4', q: '2026年诺贝尔物理学奖颁给了谁', expect: 'search' },
  { id: '5', q: '帮我查一下今天特斯拉的股价', expect: 'search' },
  /**
   * 类 1 的"边界样本"：**稳定的通用知识**。
   *
   * 期望是 `either`：模型直接答（不搜）是**正确且更好**的（更快、不花额度），
   * 真去搜也不算错 —— 所以只断言"不许开浏览器 / 不许谎称打开网页"。
   *
   * ⚠️ 这一条是**改过期望**的，如实记录：第一版我把它写成 `expect: 'search'`，
   *    实测模型直接答了且答案正确。复盘结论是**我的用例设计错了**（工具描述里
   *    明确写着"解释通用概念不要搜"），不是代码 bug —— 所以改成 `either` 并把理由写在这里，
   *    而不是去调提示词把它"改成会搜"。
   */
  { id: '5b', q: '帮我查一下"碳化硅"主要用在哪', expect: 'either' },
  // ---- 类 2：该走浏览器（≥2）----
  { id: '6', q: '打开抖音搜索附近的火锅店，给我出一份报告', expect: 'browser' },
  { id: '7', q: '打开必应帮我查一下今天的美元汇率', expect: 'browser' },
  { id: '8', q: '打开淘宝帮我比一下这两款耳机的价格', expect: 'browser' },
  // ---- 类 3：都不用（≥2）----
  { id: '9', q: '1加1等于几', expect: 'neither' },
  { id: '10', q: '帮我写一段自我介绍，我是做跨境电商的', expect: 'neither' },
  { id: '11', q: '你好', expect: 'neither' },
];

const hasCJK = (s) => /[\u4e00-\u9fa5]/.test(s);
/**
 * 语言检查加强版：不许**夹整句外文**（实测踩过：中文回答前面挂了一句
 * "I'll open Bing and look up today's USD exchange rate for you."）。
 * 判据：找出连续的、只由 ASCII 字母/标点组成且长度 ≥ 25 的片段。
 */
const FOREIGN_SENTENCE = /[A-Za-z][A-Za-z0-9,'"()\- ]{24,}[.!?]/;
/** 轻量检查：回答里有没有"我已经替你打开了某个网站"这类谎话 */
const CLAIMS_OPENED = /(已(经)?(为|帮)?你?(打开|开启)|已经打开|已为你打开|我已打开)/;

async function main() {
  const env = loadDotEnv(ENV_PATH);
  const serverEnv = {
    deepseekApiKey: env.DEEPSEEK_API_KEY ?? '',
    deepseekBaseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    deepseekModel: env.DEEPSEEK_MODEL || 'deepseek-chat',
    tavilyApiKey: env.TAVILY_API_KEY ?? '',
    tavilyBaseUrl: env.TAVILY_BASE_URL || 'https://api.tavily.com',
  };
  if (!serverEnv.deepseekApiKey) {
    console.error('未配置 DEEPSEEK_API_KEY，无法测试');
    process.exitCode = 2;
    return;
  }

  const { streamChatWithSearch } = await import(pathToFileURL(path.join(DIST, 'search', 'chatLoop.js')).href);
  const { BASE_SYSTEM_PROMPT, BASE_OVERRIDE_NOTE } = await import(
    pathToFileURL(path.join(DIST, 'promptPolicy.js')).href
  );
  const { replyLanguageRule } = await import(pathToFileURL(path.join(DIST, 'language.js')).href);
  const { chatSearchPolicyBlock, searchPolicyForTurn } = await import(
    pathToFileURL(path.join(DIST, 'search', 'chatTool.js')).href
  );

  // ---------- 0. 提示词注入规则（钉住"两条提示词不许自相矛盾"）----------
  console.log('=== 0. 提示词注入规则 ===');
  chk('0.1 没开页的那一轮 → 注入搜索说明', searchPolicyForTurn({ pageOpenedThisTurn: false }).length > 0);
  chk(
    '0.2 已开页的那一轮（纯开页指令）→ **不注入**',
    searchPolicyForTurn({ pageOpenedThisTurn: true }) === '',
    '（否则与基座"直接说已经打开"自相矛盾）',
  );
  chk(
    '0.3 搜索说明里明确禁止谎称打开',
    /不要说/.test(chatSearchPolicyBlock()) && /没有/.test(chatSearchPolicyBlock()),
  );
  chk(
    '0.4 基座确实要求"纯开页指令直接说已经打开"（所以 0.2 这条闸是必需的，不是摆设）',
    /网页卡片已经开好了/.test(BASE_SYSTEM_PROMPT),
  );
  console.log('');

  /**
   * 系统提示词用**真实的基座**（dist 里那份），加上本步新增的两块：
   * 回答语言规则 + 「本轮手边有什么」。刻意不带人设/记忆/知识库 ——
   * 那些要走数据库，与本步要验的"要不要搜"无关。
   */
  const systemPrompt = [
    '你是「小助」，用户桌面工作台里的 AI 同事。',
    BASE_OVERRIDE_NOTE,
    BASE_SYSTEM_PROMPT,
    replyLanguageRule(),
    chatSearchPolicyBlock(),
  ]
    .filter((x) => x && x.trim())
    .join('\n\n');

  console.log('Tavily 联网搜索 · 模型决策真机验收（第 26 步）');
  console.log(`模型：${serverEnv.deepseekModel}\n`);

  const records = [];

  for (const c of CASES) {
    if (ONLY && !ONLY.has(c.id)) continue;
    console.log(`\n========== #${c.id} 「${c.q}」  期望路径=${c.expect} ==========`);

    const searchEvents = [];
    let text = '';
    const started = Date.now();
    let err = null;
    try {
      const out = await streamChatWithSearch(
        serverEnv,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: c.q },
        ],
        {
          tag: `verify/search-decision#${c.id}`,
          signal: AbortSignal.timeout(90_000),
          onDelta: (d) => {
            text += d;
          },
          onSearch: (e) => {
            searchEvents.push(e);
            console.log(`   [search事件] ${JSON.stringify(e)}`);
          },
          onError: (m) => {
            err = m;
            console.log(`   [SSE错误] ${m}`);
          },
        },
      );
      text = out.text;
      records.push({ id: c.id, q: c.q, expect: c.expect, searches: out.searches, text, err, ms: Date.now() - started });
    } catch (e) {
      err = `${e?.name}: ${e?.message}`;
      records.push({ id: c.id, q: c.q, expect: c.expect, searches: [], text, err, ms: Date.now() - started });
    }

    const searched = (records[records.length - 1].searches ?? []).length > 0;
    console.log(`   耗时 ${Date.now() - started}ms，搜索 ${searched ? '有' : '无'}`);
    console.log(`   回答：${text.replace(/\s+/g, ' ').slice(0, 300)}${text.length > 300 ? '…' : ''}`);

    if (err) {
      chk(`#${c.id} 没有异常`, false, err);
      continue;
    }

    if (c.expect === 'search') {
      chk(`#${c.id} 该搜索→确实调了 web_search`, searched, searched ? `query=${records[records.length - 1].searches[0].query}` : '★ 没有调用搜索工具');
      chk(`#${c.id} 该搜索→没有声称打开了网页`, !CLAIMS_OPENED.test(text), '（搜索路径不该出现"已为你打开"）');
    } else if (c.expect === 'browser') {
      /**
       * ★ 类 2 在本脚本里**刻意不做硬断言** —— 这条路径在产品里**不可达**。
       *
       * 核实过程（不是为了让测试变绿，是把路径先弄清楚）：
       *   · 「打开必应帮我查一下今天的美元汇率」在真实链路里由**桌面本地判定**接管：
       *     `detectOpenUrl` 直接返回 `https://www.bing.com`（证据见
       *     `search-vs-browser-routing.mts` 的同名用例，PASS），桌面随即开页并带上
       *     `taskMode: true`（`App.tsx`：`pendingDrive()` 非空就带），这一轮走的是
       *     **服务端工具循环 toolLoop.ts**，那一套工具表里**没有** `web_search`。
       *   · 也就是说：本脚本把这句话单独喂给聊天路径，造出了一个**产品不会走的**分支。
       *     在这个人造分支里，模型有时会顺手搜一下（3 轮里 2 轮）—— 那是"这条分支的行为"，
       *     不是"产品把浏览器任务用搜索敷衍了"。
       *   · 真正的闸门（"点名站点 → 走浏览器"）在**路由层**，由另一个脚本硬断言。
       *     按"断言必须真打到被测路径"的规矩，这里只能记 INFO，不能算 FAIL。
       */
      info(
        `#${c.id} 该开浏览器→本路径不可达，仅作参考：模型${searched ? '**调用了**搜索工具（' + JSON.stringify(records[records.length - 1].searches.map((s) => s.query)) + '）' : '没有调用搜索工具'}`,
        '真实链路走浏览器（见 search-vs-browser-routing.mts）',
      );
      chk(
        `#${c.id} 该开浏览器→没有把搜索包装成"我去过那个网站"`,
        !/我(已经)?(联网)?搜(到|索到|了一下)/.test(text),
        '（这条与路径无关：任何情况下都不许用搜索冒充网站操作）',
      );
    } else if (c.expect === 'either') {
      chk(`#${c.id} 边界样本→没有谎称打开了网页`, !CLAIMS_OPENED.test(text), '（搜或不搜都行，但不许说"已打开"）');
      chk(`#${c.id} 边界样本→确实答了内容`, text.trim().length > 0);
    } else {
      chk(`#${c.id} 都不用→没有多余地联网`, !searched, searched ? `★ 却去搜了` : '未调用搜索工具');
    }

    // 语言原则：不管资料是什么语言，回答都要是中文（且不许夹整句外文）
    if (text.trim()) {
      /**
       * 「是中文」的判据要放宽一档：纯数字/符号答案（实测「1+1=2。」）本身没有语言属性，
       * 不该判红。所以：含中文 ✅，或者压根没有成词的拉丁文（说明是数字/符号）✅。
       */
      const languageNeutral = !/[A-Za-z]{3,}/.test(text);
      chk(
        `#${c.id} 回答语言=中文（跟随系统设置）`,
        hasCJK(text) || languageNeutral,
        hasCJK(text) ? `前 40 字：${text.slice(0, 40)}` : '（纯数字/符号答案，无语言属性）',
      );
      chk(
        `#${c.id} 不夹整句外文`,
        !FOREIGN_SENTENCE.test(text),
        (text.match(FOREIGN_SENTENCE) ?? [''])[0].slice(0, 70),
      );
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const p = path.join(OUT_DIR, `decision-${stamp}.json`);
  writeFileSync(p, JSON.stringify({ at: new Date().toISOString(), model: serverEnv.deepseekModel, records }, null, 2), 'utf8');
  console.log(`\n取证落盘：${path.relative(ROOT, p)}`);
  console.log(`\n===== 汇总：${pass} PASS / ${fail} FAIL =====`);
  if (infos.length > 0) {
    console.log(`（另有 ${infos.length} 条 INFO：路径在产品里不可达的观察值，不计分）`);
    for (const i of infos) console.log('   · ' + i);
  }
  if (fail > 0) console.log('失败项：\n - ' + failures.join('\n - '));
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('脚本自身异常：', e);
  process.exitCode = 2;
});
