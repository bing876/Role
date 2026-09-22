/**
 * 「认不出的站点」回归测试（第 24 步）。
 *
 * 这条 bug 的原始症状（用户原话）：
 *   「我输入了一个豆包，然后我的消息里面显示了打开了 page，但是我的浏览器里面没有」
 *
 * 根因链（我在源码里逐行确认过）：
 *   ① 豆包不在 SITES 登记表 → `detectOpenUrl('打开豆包')` 返回 null；
 *   ② `detectOpenUrl` 返回 null 后，App.tsx **没有拦住**这句话，
 *      它照样走 `/chat/stream` 发给了模型；
 *   ③ 模型看到一个「打开」的动词，就自己编了一句「已为你打开豆包」；
 *   ④ 用户看到「消息说打开了」但「浏览器里没有」—— 只有那句回复在撒谎。
 *
 * 所以本测试要证明两件事：
 *   A. 这些站点现在**认得出了**（补表）；
 *   B. 真的认不出时，`detectUnknownOpenTarget` 能识别出来，
 *      并且**不误报**（闲聊、提问、非站点目标都不能命中）。
 *
 * B 的防误报是重点：如果它什么都命中，用户说「打开这个文件」也会被回一句
 * 「我认不出这个网站」—— 那是把 bug 从"撒谎"换成"添乱"，一样不行。
 */
import { detectOpenUrl, detectUnknownOpenTarget } from '../../apps/desktop/src/browser/sites';

let fails = 0;
const lines: string[] = [];
const log = (...a: string[]) => {
  const s = a.map(String).join(' ');
  lines.push(s);
  console.log(s);
};
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fails += 1;
  log(`  ${ok ? 'PASS' : '★FAIL'} ${name}${detail ? '  —— ' + detail : ''}`);
};

log('');
log('=== ① 用户报的那两个站点，现在认得出了（补表）===');
for (const [say, want] of [
  ['打开豆包', 'https://www.doubao.com'],
  ['打开千问', 'https://www.tongyi.com'],
  ['打开通义千问', 'https://www.tongyi.com'],
  ['打开deepseek', 'https://chat.deepseek.com'],
  ['打开kimi', 'https://kimi.moonshot.cn'],
  ['打开文心一言', 'https://yiyan.baidu.com'],
  ['打开腾讯元宝', 'https://yuanbao.tencent.com'],
  ['打开grok', 'https://grok.com'],
  ['打开copilot', 'https://copilot.microsoft.com'],
] as const) {
  const got = detectOpenUrl(say);
  check(`「${say}」`, got === want, `得到 ${JSON.stringify(got)}`);
}

log('');
log('=== ② 原来就认得的不受影响（防回归）===');
for (const [say, want] of [
  ['打开chatgpt', 'https://chatgpt.com'],
  ['打开速卖通官网', 'https://www.aliexpress.com'],
  ['打开淘宝', 'https://www.taobao.com'],
  ['打开百度', 'https://www.baidu.com'],
] as const) {
  check(`「${say}」`, detectOpenUrl(say) === want, `得到 ${JSON.stringify(detectOpenUrl(say))}`);
}

log('');
log('=== ③ ★ 认不出的开页指令，必须识别出来（不能再让模型编）===');
/*
 * ★ 这一节的用例必须都是**专名形态** —— 用户说出了一个具体的站名，只是表里没有。
 *   我第一版在这里放了「打开那个卖鞋的站」「打开我们公司内网」，那是**归类错了**：
 *   这两句里压根没出现具体站名（"站"/"内网"是泛类名词，跟"文件""报告"同类），
 *   它们属于第 ④ 节「目标不是站点名」，不属于"认不出这个站"。
 *   测试当场把分类错误暴露了出来 —— 这正是写测试的意义。
 */
for (const say of ['打开小红mall', '打开某某商城', '打开某某网', '打开Acme官网']) {
  const got = detectUnknownOpenTarget(say);
  check(`「${say}」判为认不出`, got !== null, `识别的目标 = ${JSON.stringify(got)}`);
}

log('');
log('=== ④ ★★ 防误报：不能把"不是开页"的也当成认不出 ===');
log('   （这一节比 ③ 更重要 —— 误报会把 bug 从"撒谎"换成"添乱"）');
const shouldNotCatch: Array<[string, string]> = [
  ['你好', '闲聊'],
  ['谢谢你', '闲聊'],
  ['你是谁', '提问'],
  ['怎么打开豆包', '提问'],
  ['豆包是什么', '提问'],
  ['打开这个文件', '目标不是站点名（"文件"是泛类名词）'],
  ['打开我昨天写的报告', '目标不是站点名（"报告"是泛类名词）'],
  ['打开那个卖鞋的站', '目标不是站点名（"站"是泛类名词，且含指示代词）'],
  ['打开我们公司内网', '目标不是站点名（"内网"是泛类名词）'],
  ['打开一下', '空目标'],
  ['打开浏览器', '泛指'],
  ['打开百度', '表里有的'],
  ['打开chatgpt', '表里有的'],
  ['打开example.com', '裸域名能直连'],
  ['打开 https://abc.com', '显式 URL'],
  ['打开淘宝搜天气', '前缀命中已登记站点'],
];
for (const [say, why] of shouldNotCatch) {
  const got = detectUnknownOpenTarget(say);
  check(`「${say}」不该判为认不出（${why}）`, got === null, `却得到 ${JSON.stringify(got)}`);
}

log('');
log('=== ⑤ 两个判定必须互斥（同一个输入不能既开页又认不出）===');
const both: string[] = [];
for (const say of [
  '打开豆包', '打开chatgpt', '打开淘宝', '打开某某商城', '怎么打开豆包',
  '打开这个文件', '打开浏览器', '打开example.com',
]) {
  if (detectOpenUrl(say) !== null && detectUnknownOpenTarget(say) !== null) both.push(say);
}
check('★ 没有任何输入同时命中两个判定', both.length === 0, both.join(' | ') || '0 例');

log('');
log('=== 结论 ===');
log(`  失败项：${fails}`);
log('  登记表是「用户说了名字就能开页」的唯一依据；');
log('  而「认不出」必须如实告知 —— 绝不能让模型替我们编一句「已打开」。');

process.exit(fails > 0 ? 1 : 0);
