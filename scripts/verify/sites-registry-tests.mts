/**
 * 站点登记表回归测试（用户实测"漏站点"的直接防线）。
 *
 * 为什么需要它：`detectOpenUrl` 是**纯字符串**判断（脱网、不问模型，见 sites.ts 头注释），
 * 所以「用户说了站点名、表里没有」= 整条开页链路根本不启动，
 * 表现为「说了第二遍还是没反应 / 顶部没开新 tab」——用户 2026-09-19 报的正是这个。
 *
 * 本测试把「必须认识」的站点名钉死；以后新增/删除登记项时这里会先红。
 *
 * 跑法：npx tsx scripts/verify/sites-registry-tests.mts
 */
import { detectOpenUrl, isPureOpenCommand, looksLikeQuestion } from '../../apps/desktop/src/browser/sites';

let fails = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  if (!ok) fails += 1;
  console.log(`  ${ok ? 'PASS' : '★FAIL'} ${name}${extra ? '  —— ' + extra : ''}`);
};

console.log('=== 1. 用户实测报过的两句话（必须认识）===');
for (const [say, expect] of [
  ['打开速卖通官网', 'https://www.aliexpress.com'],
  ['打开chatgpt', 'https://chatgpt.com'],
  ['打开 ChatGPT', 'https://chatgpt.com'],
  ['打开速卖通', 'https://www.aliexpress.com'],
  ['打开速卖通网页', 'https://www.aliexpress.com'],
  ['请打开速卖通官网', 'https://www.aliexpress.com'],
]) {
  const got = detectOpenUrl(say);
  check(`「${say}」→ ${expect}`, got === expect, String(got));
  check('  且判为「纯开页」（页开出来就完事，不白烧一次模型）', isPureOpenCommand(say));
}

console.log('');
console.log('=== 2. 常用电商 / 工具站点 ===');
for (const say of ['打开淘宝', '打开京东', '打开拼多多', '打开1688', '打开阿里巴巴',
                   '打开亚马逊', '打开shopee', '打开temu', '打开shein',
                   '打开gmail', '打开outlook', '打开claude', '打开youtube', '打开推特']) {
  const got = detectOpenUrl(say);
  check(`「${say}」能解析出地址`, typeof got === 'string' && got.startsWith('https://'), String(got));
}

console.log('');
console.log('=== 3. 不该误伤（问句 / 无动词 / 单字母歧义）===');
check('问句不开页：「怎么打开速卖通」', detectOpenUrl('怎么打开速卖通') === null);
check('问句不开页：「chatgpt是什么」', detectOpenUrl('chatgpt是什么') === null);
check('looksLikeQuestion 认可问号', looksLikeQuestion('打开速卖通？'));
check('「打开小红书」不会被单字母 x 抢走', detectOpenUrl('打开小红书') === 'https://www.xiaohongshu.com',
  String(detectOpenUrl('打开小红书')));
check('「打开x」确实打到 x.com', detectOpenUrl('打开x') === 'https://x.com');

console.log('');
console.log('=== 4. 裸域名仍可直连 ===');
check('example.com', detectOpenUrl('打开 example.com') === 'https://example.com');
check('裸域名 ai.com', detectOpenUrl('打开ai.com') === 'https://ai.com', String(detectOpenUrl('打开ai.com')));

console.log('');
console.log(`失败项：${fails}`);
console.log('→ 登记表是「用户说了名字就能开页」的唯一依据；这张表漏了谁，谁就表现为「点了没反应」。');
process.exit(fails > 0 ? 1 : 0);
