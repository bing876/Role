/**
 * 第 27 步 · **保守触发闸**验收（跑真实的 runToolLoop，喂假 hooks）
 *
 * agent.ts 从第 21 步起就刻意不 import electron、全部依赖注入 —— 就是为了能这样单测。
 * 这里不重写循环逻辑，而是让**真循环**跑起来，只看它有没有在正确的时刻调 `raiseHelp`。
 *
 * 核心要证明的两件事：
 *   ① 两个条件**都**满足才弹卡（本地页面信号 ∧ AI 确实卡住了）；
 *   ② 任何一边不满足都不弹 —— 尤其是"页面像登录页但 AI 并没卡住"这条（用户点名的验收项）。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = 'C:/Users/bing/workbuddy-ai/work123';
const SRC = `${ROOT}/apps/desktop/electron/agent.ts`;
const OUT = `${ROOT}/apps/desktop/dist-electron/agent.js`;

// ★ 构建产物是个会动的靶子：先确认它比源码新，否则这次验的是旧代码（本仓库踩过）
const tSrc = fs.statSync(SRC).mtimeMs;
const tOut = fs.statSync(OUT).mtimeMs;
if (tOut < tSrc) {
  console.log(`FAIL  0. 编译产物比源码旧（${OUT}）—— 先 npm run build:electron 再跑本脚本`);
  process.exit(1);
}

const { runToolLoop, pageNeedsHuman } = require(OUT);

// driver.js 只 import type（编译后无运行时依赖），可以直接 require 来测它的纯函数
let driver = null;
try {
  driver = require(`${ROOT}/apps/desktop/dist-electron/driver.js`);
} catch (e) {
  console.log(`（提示：driver.js 没能直接 require，跳过自动恢复判定规则的单测：${e.message}）`);
}

let CHECKS = 0;
let FAILS = 0;
const ok = (name, cond, extra = '') => {
  CHECKS += 1;
  if (cond) console.log(`PASS  ${name}`);
  else {
    FAILS += 1;
    console.log(`FAIL  ${name}${extra ? `   << ${extra}` : ''}`);
  }
};

// ---- 页面快照夹具 -------------------------------------------------------------
const snapCaptcha = {
  url: 'https://x.example/verify',
  title: '请完成安全验证',
  buttons: ['获取验证码', '提交'],
  links: [],
  inputs: ['placeholder=请输入验证码'],
  loginLike: false,
  challengeLike: true,
  inputFields: [{ label: '[敏感·验证码/动态口令] placeholder=请输入验证码', kind: 'sensitive', reason: 'otp_guess' }],
};
const snapLogin = {
  url: 'https://x.example/login',
  title: '登录',
  buttons: ['登录'],
  links: [],
  inputs: [],
  loginLike: true,
  challengeLike: false,
  inputFields: [{ label: '[敏感·密码] name=password', kind: 'sensitive', reason: 'password' }],
};
const snapPlain = {
  url: 'https://x.example/',
  title: '首页',
  buttons: ['搜索'],
  links: [],
  inputs: [],
  loginLike: false,
  challengeLike: false,
  inputFields: [],
};
/** 普通页，但**有一个验证码输入框**（字段级兜底信号） */
const snapOtpFieldOnly = {
  ...snapPlain,
  url: 'https://x.example/step2',
  title: '填写信息',
  inputFields: [{ label: '[敏感·验证码/动态口令] name=smsCode', kind: 'sensitive', reason: 'otp_guess' }],
};
/** ★ 滑块验证页：有验证信号，但页面上**一个敏感输入框都没有**（最容易误判完成的那种） */
const snapSlider = {
  url: 'https://x.example/verify',
  title: '安全验证',
  buttons: ['验证'],
  links: [],
  inputs: [],
  loginLike: false,
  challengeLike: true,
  inputFields: [],
};

const tool = (name, args = {}) => ({ kind: 'tool', call: { id: 'c', name, args }, step: 1 });
const ask = (reason) => ({ kind: 'ask', reason, question: '（提问）', step: 1 });
const done = { kind: 'done', summary: '做完了', document_title: 't', document_outline: [], step: 9 };

/** 跑一轮真循环，收集它调过的 raiseHelp / phase */
async function run(scenario) {
  const helps = [];
  const phases = [];
  const events = [];
  let stepIdx = 0;
  const decisions = scenario.decisions;
  const execs = scenario.execs ?? [];
  const hooks = {
    next: async () => decisions[Math.min(stepIdx, decisions.length - 1)],
    exec: async () => {
      const r = execs[Math.min(stepIdx, execs.length - 1)] ?? { ok: true, action: 'read_page' };
      stepIdx += 1;
      return r;
    },
    isPaused: () => Boolean(scenario.paused),
    aborted: () => false,
    emit: (p) => events.push(p),
    raiseHelp: (info) => helps.push(info),
    phase: (n, d, by) => phases.push({ n, d, by }),
    taskStart: async () => null,
    taskStep: async () => undefined,
    taskStatus: async () => undefined,
    sleep: async () => undefined,
    takeAnswers: () => [],
    stopLoop: () => undefined,
    pauseLoop: async () => undefined,
  };
  const reason = await runToolLoop('loop-test', '测试目标', hooks);
  return { helps, phases, events, reason };
}

console.log('=== 第 27 步 · 保守触发闸验收（真 runToolLoop + 假 hooks）===');

// ---------- 条件 A（纯函数）----------
ok('A1. challengeLike 页 → captcha', pageNeedsHuman(snapCaptcha) === 'captcha');
ok('A2. loginLike 页 → login', pageNeedsHuman(snapLogin) === 'login');
ok('A3. 普通页 → null', pageNeedsHuman(snapPlain) === null);
ok('A4. 只有验证码字段（页面级信号缺失）→ captcha（字段级兜底）', pageNeedsHuman(snapOtpFieldOnly) === 'captcha');
ok('A5. 没有快照 → null（不猜）', pageNeedsHuman(null) === null);

// ---------- 正例：两个条件都满足才弹 ----------
const s1 = await run({
  decisions: [tool('type'), tool('type')],
  execs: [
    { ok: false, action: 'type', error: '输入框被遮住了', pageSnapshot: snapCaptcha },
    { ok: false, action: 'type', error: '输入框被遮住了', pageSnapshot: snapCaptcha },
  ],
});
ok('1. 验证码页 + 连续两步失败 → 弹卡（captcha）', s1.helps.length === 1 && s1.helps[0].helpKind === 'captcha', JSON.stringify(s1.helps));
ok('2. 弹卡时如实告诉实现方"页面本来有敏感框"', s1.helps[0]?.hadSensitiveField === true, JSON.stringify(s1.helps[0]));
ok('3. 弹卡时状态记成 AI 发起（pausedBy=agent）', s1.phases.some((p) => p.n === 'paused' && p.by === 'agent'), JSON.stringify(s1.phases));

const s2 = await run({
  decisions: [tool('click'), tool('click'), tool('click')],
  execs: [
    { ok: true, action: 'click', noChange: true, pageSnapshot: snapLogin },
    { ok: true, action: 'click', noChange: true, pageSnapshot: snapLogin },
    { ok: true, action: 'click', noChange: true, pageSnapshot: snapLogin },
  ],
});
ok('4. 登录墙 + 连点三次无变化 → 弹卡（login）', s2.helps.length === 1 && s2.helps[0].helpKind === 'login', JSON.stringify(s2.helps));
// 登录页**本来就有一个 password 框**（那也算敏感框）—— 用户登录完表单消失，正好是"完成"的信号
ok('5. 登录墙场景如实标记"页面本来就有敏感框"', s2.helps[0]?.hadSensitiveField === true, JSON.stringify(s2.helps[0]));

const s2b = await run({
  decisions: [tool('click'), tool('click'), tool('click')],
  execs: [
    { ok: true, action: 'click', noChange: true, pageSnapshot: snapSlider },
    { ok: true, action: 'click', noChange: true, pageSnapshot: snapSlider },
    { ok: true, action: 'click', noChange: true, pageSnapshot: snapSlider },
  ],
});
ok(
  '5b. ★滑块页（一个敏感框都没有）→ 如实标记 hadSensitiveField=false（自动恢复才不会秒判"完成"）',
  s2b.helps.length === 1 && s2b.helps[0].helpKind === 'captcha' && s2b.helps[0].hadSensitiveField === false,
  JSON.stringify(s2b.helps),
);

const s5 = await run({
  decisions: [tool('read_page'), ask('sensitive_field')],
  execs: [{ ok: true, action: 'read_page', pageSnapshot: snapOtpFieldOnly }],
});
ok('6. 服务端挡下敏感输入 + 页面有验证码框 → 弹卡（captcha）', s5.helps.length === 1 && s5.helps[0].helpKind === 'captcha', JSON.stringify(s5.helps));

const s8 = await run({
  decisions: [tool('read_page'), ask('need_user')],
  execs: [{ ok: true, action: 'read_page', pageSnapshot: snapLogin }],
});
ok('7. 模型自己说"被卡住了" + 登录墙 → 弹卡（login）', s8.helps.length === 1 && s8.helps[0].helpKind === 'login', JSON.stringify(s8.helps));

// ---------- ★反例：条件 A 不满足 → 不弹 ----------
const s3 = await run({
  decisions: [tool('open_url'), tool('click'), done],
  execs: [
    { ok: true, action: 'open_url', pageSnapshot: snapLogin },
    { ok: true, action: 'click', pageSnapshot: snapLogin },
  ],
});
ok('8. ★反例：页面像登录页，但 AI 正常导航+点击后做完 → **不弹卡**', s3.helps.length === 0 && s3.reason === 'done', JSON.stringify({ helps: s3.helps, reason: s3.reason }));

const s4 = await run({
  decisions: [tool('click'), tool('click')],
  execs: [
    { ok: false, action: 'click', error: '点不到', pageSnapshot: snapPlain },
    { ok: false, action: 'click', error: '点不到', pageSnapshot: snapPlain },
  ],
});
ok('9. ★反例：AI 确实卡住了（连败两步），但页面不像验证码/登录页 → **不弹卡**', s4.helps.length === 0 && s4.reason === 'stuck', JSON.stringify({ helps: s4.helps, reason: s4.reason }));

const s6 = await run({
  decisions: [tool('read_page'), ask('need_info')],
  execs: [{ ok: true, action: 'read_page', pageSnapshot: snapLogin }],
});
ok('10. ★反例：模型只是问一句资料（need_info）+ 页面像登录页 → **不弹卡**（不算"卡在页面上"）', s6.helps.length === 0, JSON.stringify(s6.helps));

const s7 = await run({
  decisions: [tool('read_page'), ask('step_budget')],
  execs: [{ ok: true, action: 'read_page', pageSnapshot: snapLogin }],
});
ok('11. ★反例：一轮步数走满（step_budget）+ 页面像登录页 → **不弹卡**', s7.helps.length === 0, JSON.stringify(s7.helps));

// ---------- 用户主动暂停：不该被当成 AI 求助 ----------
const s10 = await run({ decisions: [tool('click')], execs: [], paused: true });
ok('12. 用户按暂停 → 状态记成 pausedBy=user（不是 agent）', s10.phases.some((p) => p.n === 'paused' && p.by === 'user'), JSON.stringify(s10.phases));
ok('13. 用户按暂停 → 不弹求助卡', s10.helps.length === 0, JSON.stringify(s10.helps));

// ---------- 同一次循环里不重复弹 ----------
ok('14. 一次循环最多弹一张卡（三次触发点里只算一次）', s1.helps.length === 1 && s2.helps.length === 1 && s5.helps.length === 1, JSON.stringify([s1.helps.length, s2.helps.length, s5.helps.length]));

// ---------- 自动恢复观察的判定规则（防"卡片刚弹就被自己收掉"）----------
if (driver?.shouldFinishSensitiveWatch) {
  const F = driver.shouldFinishSensitiveWatch;
  // 老行为（requireSensitiveField=false → had 初值 true）
  const a = { had: true };
  ok('15. 老行为：页面上没有敏感框 → 判定完成（不回归）', F(false, a) === true);
  const b = { had: true };
  ok('16. 老行为：页面上有敏感框 → 不判定完成', F(true, b) === false && b.had === true);
  // 第 27 步新行为（requireSensitiveField=true → had 初值 false）
  const c = { had: false };
  ok('17. ★滑块页（初值 false，页面一直没有敏感框）→ **绝不**判定完成', F(false, c) === false);
  const d = { had: false };
  ok('18. ★滑块页：即使连着轮询多次也一直不判定完成', F(false, d) === false && F(false, d) === false && F(false, d) === false);
  const e = { had: false };
  F(false, e); // 先空轮一次
  ok('19. 敏感框中途出现 → 记下"本来有"（仍然不判完成）', F(true, e) === false && e.had === true);
  ok('20. 敏感框随后消失 → 这时才判定完成（用户处理完了）', F(false, e) === true);
} else {
  ok('15~20. driver.shouldFinishSensitiveWatch 单测', false, '拿不到 driver.js，自动恢复判定规则**未被机器验证**');
}

console.log(`\n=== 结果：${CHECKS - FAILS}/${CHECKS} PASS，${FAILS} FAIL ===`);
process.exit(FAILS === 0 ? 0 : 1);
