/**
 * R4 发车判定 · 源码一致性验证（零依赖，`node` 直接跑）
 * ---------------------------------------------------------------------------
 * 为什么要有这个脚本（它补的是 agent-loop-audit-test.mts 的一个结构性漏洞）：
 *
 *   `scripts/verify/agent-loop-audit-test.mts` 里的 `shouldEnterTaskModeTest`
 *   是 `apps/server/src/routes/chat.ts` 里 `shouldEnterTaskMode` 的**手抄副本**，不是 import。
 *   ⇒ 副本通过 ≠ 线上代码正确。以后谁改了 chat.ts 而忘了改副本（或反过来），
 *     审计用例照样全绿，而真实发车行为已经变了。这类漂移是静默的。
 *
 * 本脚本不抄：直接从 chat.ts **按花括号配平抠出真实函数体**，去掉 TS 类型标注后 eval，
 * 再跑断言 —— 测的永远是仓库里那一份代码。
 *
 * 三段断言：
 *   A. 与 agent-loop-audit-test.mts 完全对齐的 12 条（含标注 "R4 新增" 的 4 条）
 *   B. 反向保护成对断言 —— 照 TOOLBOX 的规矩：收紧一类判定必须同时写
 *      「明确指外部/当前页 → 必须发车」和「明确闲聊/提问 → 不能发车」一对，
 *      只写前者很容易把后者一起掐掉（收紧过头 = 该发的不发）。
 *   C. 结构反证 —— 旧宽松规则（hasPage 一票发车 / length>=15 一票发车 /
 *      搜|查|看 单独发车）必须**真的从可执行代码里消失**，而不是只在注释里被宣布删除。
 *   D. R4 已知保守取舍 —— 按现状固化，行为漂移时会被抓到（详见
 *      docs/待办-R4残留-页面指代无动作词-20260922.md）。
 *
 * 用法：node scripts/verify/r4-intent-source-parity.mjs
 * 退出码：0 = 全通过；1 = 有失败
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAT_TS = path.resolve(HERE, '../../apps/server/src/routes/chat.ts');
const code = readFileSync(CHAT_TS, 'utf8');

/* ------------------------------------------------- 从真源码里抠出那个函数 */
const HEADER = 'const shouldEnterTaskMode = ';
const start = code.indexOf(HEADER);
if (start < 0) {
  console.error('FAIL  chat.ts 里找不到 shouldEnterTaskMode —— 函数被改名/移走了？');
  process.exit(1);
}

// 从箭头函数体的第一个 '{' 开始做花括号配平；正则字面量与字符串里的 {} 要跳过
const braceStart = code.indexOf('{', code.indexOf('=>', start));
let depth = 0;
let end = -1;
let inRegex = false;
let inStr = null;
for (let i = braceStart; i < code.length; i++) {
  const c = code[i];
  const prev = code[i - 1];
  if (inStr) {
    if (c === inStr && prev !== '\\') inStr = null;
    continue;
  }
  if (inRegex) {
    if (c === '/' && prev !== '\\') inRegex = false;
    continue;
  }
  if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
  if (c === '/') {
    // '/' 前一个有效字符是 ( = , : & | ! ? { ; 之一 ⇒ 这是正则字面量的开头，不是除号
    const before = code.slice(0, i).trimEnd().slice(-1);
    if ('(=,:&|!?{;'.includes(before) || before === '') { inRegex = true; continue; }
  }
  if (c === '{') depth += 1;
  else if (c === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
}
if (end < 0) {
  console.error('FAIL  花括号配平失败，没能提取完整函数体（chat.ts 结构变了？）');
  process.exit(1);
}

const body = code.slice(braceStart, end);
// 只去掉箭头函数头部的 TS 类型标注；函数体本身是纯 JS，无需转译
const shouldEnterTaskMode = eval(`(msg, hasPage) => ${body}`); // eslint-disable-line no-eval

/* ------------------------------------------------------------ 断言表 */

// A. 与 agent-loop-audit-test.mts 场景 a 的 12 条完全一致
const AUDIT = [
  { msg: '帮我下单', hasPage: false, expected: true },
  { msg: '帮我下单这个商品', hasPage: true, expected: true },
  { msg: '把这个页面上的商品整理一下', hasPage: true, expected: true },
  { msg: '诊断一下我的店铺后台情况', hasPage: false, expected: true },
  { msg: '你好', hasPage: false, expected: false },
  { msg: '你好', hasPage: true, expected: false },
  { msg: '什么是量子力学', hasPage: false, expected: false },
  { msg: '在这个页面搜一下 AI 最新动态', hasPage: true, expected: true },
  // ↓ 这四条在审计用例里标注为 "R4 新增"
  { msg: '今天天气真舒服，早上出门遛弯的时候楼下花坛开了好多月季，心情特别好，你那边天气怎么样啊', hasPage: false, expected: false },
  { msg: '帮我查一下今天北京的天气怎么样', hasPage: false, expected: false },
  { msg: '打开百度，搜索一下今天的新闻', hasPage: false, expected: true },
  { msg: '今天北京天气怎么样', hasPage: true, expected: false },
];

// B. 反向保护（成对）：既要证明「不该发的没发」，也要证明「该发的还在发」
const GUARD = [
  { msg: '打开 https://shop.example.com/item/9 帮我把这双鞋下单', hasPage: false, expected: true, why: '显式 URL' },
  { msg: '访问京东首页', hasPage: false, expected: true, why: '强动作词「访问」' },
  { msg: '在这个页面搜一下同款', hasPage: true, expected: true, why: '弱动作词「搜」+ 页面指代「这个页面」' },
  { msg: '你觉得这次的方案怎么样', hasPage: true, expected: false, why: '无动作词：有活页也不发车' },
  { msg: '解释一下什么是闭包', hasPage: true, expected: false, why: '概念提问：有活页也不发车' },
  { msg: '帮我查一下明天上海的天气', hasPage: true, expected: false, why: '弱动作词但无页面指代 → 走聊天搜索' },
  { msg: '谢谢', hasPage: true, expected: false, why: '感谢' },
  { msg: '写一篇关于秋天的短文', hasPage: false, expected: false, why: '写作类' },
  { msg: '我今天心情不太好想找人聊聊天随便说点什么', hasPage: false, expected: false, why: '>15 字长闲聊不再一票发车' },
  { msg: '我今天心情不太好想找人聊聊天随便说点什么', hasPage: true, expected: false, why: '>15 字长闲聊 + 有活页也不再一票发车' },
];

// D. R4 有意的保守取舍：这些**按设计不发车**（宁可漏发不误发）。
//    固化现状，日后若有人放宽/收紧动作词表，这里会立刻报出来。
const TRADEOFF = [
  { msg: '当前页面上的价格帮我记下来', hasPage: true, expected: false, why: '「记」不在强/弱动作词表 → 不发车（旧逻辑 hasPage 一票发车会发）' },
  { msg: '在这个页面帮我留意一下有没有货', hasPage: true, expected: false, why: '「留意」不在动作词表 → 不发车' },
];

let fail = 0;
const run = (label, cases) => {
  console.log(`\n--- ${label} ---`);
  for (const tc of cases) {
    const actual = shouldEnterTaskMode(tc.msg, tc.hasPage);
    const ok = actual === tc.expected;
    if (!ok) fail += 1;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  hasPage=${String(tc.hasPage).padEnd(5)} => ${String(actual).padEnd(5)}` +
        ` (期望 ${String(tc.expected).padEnd(5)})  "${tc.msg}"${tc.why ? `   [${tc.why}]` : ''}`,
    );
  }
};

console.log('=== R4 发车判定 · 源码一致性验证 ===');
console.log(`被测源码：${path.relative(process.cwd(), CHAT_TS)}`);
console.log(`提取方式：花括号配平抠出真实函数体（${body.length} 字节），非手抄副本`);

run('A. 与 agent-loop-audit-test 对齐（12 条）', AUDIT);
run('B. 反向保护成对断言（10 条）', GUARD);

// C. 结构反证
console.log('\n--- C. 结构反证（旧宽松规则是否真的从可执行代码里消失） ---');
// 「已删除」类只看**函数体切片**；「存在」类看全文（R4 标记注释写在 const 之前）。
// ★ 坑：R4 注释本身在描述旧逻辑（"length>=15 一票发车"字样就在注释里），
//   拿全文去断言「已删除」会误判成还在 —— 必须按 mustBeAbsent 分别取扫描范围。
const fnText = code.slice(start, end);
const STRUCTURAL = [
  { name: 'hasPage 一票发车（if (hasPage) return true）', re: /if\s*\(\s*hasPage\s*\)\s*return\s+true/, mustBeAbsent: true },
  { name: 'length>=15 一票发车', re: /length\s*>=\s*15/, mustBeAbsent: true },
  { name: '弱动作词 搜/查/看 单独一票发车', re: /return\s+true;[\s\S]{0,40}搜\|查\|看/, mustBeAbsent: true },
  { name: 'R4 标记注释（R4 保守收紧（2026-09-22））', re: /R4 保守收紧（2026-09-22）/, mustBeAbsent: false },
  { name: 'STRONG_ACTION 强动作词表', re: /STRONG_ACTION/, mustBeAbsent: false },
  { name: 'WEAK_ACTION 弱动作词表', re: /WEAK_ACTION/, mustBeAbsent: false },
  { name: 'PAGE_REF 页面指代表', re: /PAGE_REF/, mustBeAbsent: false },
];
for (const s of STRUCTURAL) {
  const hit = s.re.test(s.mustBeAbsent ? fnText : code);
  const ok = s.mustBeAbsent ? !hit : hit;
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.mustBeAbsent ? '已删除' : '存在  '}：${s.name}（实测 ${hit ? '命中' : '未命中'}）`);
}

run('D. R4 已知保守取舍（按现状断言，非缺陷）', TRADEOFF);

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : `${fail} 条失败`}（A${AUDIT.length} + B${GUARD.length} + C${STRUCTURAL.length} + D${TRADEOFF.length} = ${AUDIT.length + GUARD.length + STRUCTURAL.length + TRADEOFF.length} 条）===`);
process.exit(fail === 0 ? 0 : 1);
