/**
 * pageDelta 的**定点反证**（纯函数，不起环境、不依赖浏览器）。
 *
 * 为什么要单独写它：
 *   场景 s2 暴露过一个误判 —— 用户停在同一张登录页上自己填完验证码，
 *   地址没变、只有标题从「登录验证」变成「验证通过」，却被判成 `moved`
 *   （=「你已经不在原来那个页面了」），AI 于是凭空问用户「是不是换页面了」。
 *   修完后得有一个**不跑全套场景**就能复验的手段，否则下次有人改 pageDelta 又会悄悄退化。
 *
 * 用法：
 *   node scripts/verify/pagedelta-fixture.mjs
 * 退出码 0 = 全部符合预期；1 = 有退化。
 *
 * ★ 反证手法（用户要求）：把 pageDelta.ts 里那行判定**故意改回**
 *   `urlChanged || titleChanged ? 'moved' : ...`，重新 `npm run build -w @ai-workbench/server`，
 *   再跑本脚本 —— 第 2 条用例必须**从 edited 变回 moved、脚本报错退出**，
 *   这才说明这条用例真的有牙齿，不是摆设。
 */
import { pageDelta } from '../../apps/server/dist/pageDelta.js';

const snap = (o) => ({
  url: o.url ?? 'http://127.0.0.1:8894/captcha',
  title: o.title,
  buttons: o.buttons ?? [],
  links: [],
  inputs: o.inputs ?? [],
  texts: o.texts ?? [],
  inputFields: [],
  loginLike: false,
  overlay: false,
  nodeCount: 0,
});

const BEFORE = snap({
  title: '登录验证',
  buttons: ['提交验证'],
  inputs: ['placeholder=手机号', 'placeholder=短信验证码'],
  texts: ['为了你的账号安全，请先完成验证。', '（等待验证）'],
});

const CASES = [
  {
    name: '① 什么都没动 → unchanged',
    after: snap({
      title: '登录验证',
      buttons: ['提交验证'],
      inputs: ['placeholder=手机号', 'placeholder=短信验证码'],
      texts: ['为了你的账号安全，请先完成验证。', '（等待验证）'],
    }),
    expect: 'unchanged',
    why: '地址标题元素全一致，AI 应该按原计划继续，不该多问一句',
  },
  {
    name: '② 地址没变、只改标题（用户自己填完验证码）→ edited',
    after: snap({
      title: '验证通过 - 示例商城',
      buttons: ['去下单'],
      inputs: [],
      texts: ['手机号 13800000000 已通过验证。', '下一步：确认收货地址并完成下单。'],
    }),
    expect: 'edited',
    why: '★ 这一条就是踩过的坑：判成 moved 会让 AI 说「你已经不在原来那个页面了」，'
      + '而用户从头到尾都在这个网址上 —— 纯属凭空制造困惑',
  },
  {
    name: '③ 地址变了（用户跑去别的网站）→ moved',
    after: snap({
      url: 'http://127.0.0.1:8895/news',
      title: '每日新闻',
      buttons: ['加载更多'],
      texts: ['今日要闻'],
    }),
    expect: 'moved',
    why: '真的换了页面，必须让 AI 知道「严禁 open_url 跳回原地址」',
  },
  {
    name: '④ 没有暂停前快照 → unknown（不许假装没变）',
    before: null,
    after: snap({ title: 'x' }),
    expect: 'unknown',
    why: '没得比就如实说不知道，绝不猜 unchanged',
  },
];

let bad = 0;
for (const c of CASES) {
  const d = pageDelta(c.before === null ? null : BEFORE, c.after);
  const ok = d.kind === c.expect;
  if (!ok) bad += 1;
  console.log('%s %s\n     实际=%s 期望=%s\n     %s',
    ok ? '✅' : '❌', c.name, d.kind, c.expect, c.why);
  if (!ok) {
    console.log('     判定原文：%s', d.brief.slice(0, 160).replace(/\n/g, ' '));
  }
}
console.log('\n%s', bad === 0 ? '全部符合预期（4/4）' : `有 ${bad} 条退化`);
process.exit(bad === 0 ? 0 : 1);
