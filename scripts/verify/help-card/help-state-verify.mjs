/**
 * 第 27 步 · **主进程接线**验收（求助状态机 helpState.ts，喂假依赖）
 *
 * 为什么要单测这一层：它是最容易"读代码觉得对、实际时序错"的地方 ——
 *   卡片刚弹就被自己收掉、自动与手动几乎同时到导致恢复两次、观察窗没被停掉、
 *   定时器泄漏。这些都不在主进程之外可见，只能靠假依赖把它们**逼出来**。
 *
 * ★ 这一层不产生任何输入能力：只发文案事件、只挂观察、只请求恢复。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = 'C:/Users/bing/workbuddy-ai/work123';
const SRC = `${ROOT}/apps/desktop/electron/helpState.ts`;
const OUT = `${ROOT}/apps/desktop/dist-electron/helpState.js`;

// ★ 构建产物是会动的靶子：先确认它比源码新，否则这次验的是旧代码
if (!fs.existsSync(OUT) || fs.statSync(OUT).mtimeMs < fs.statSync(SRC).mtimeMs) {
  console.log(`FAIL  0. 编译产物不存在或比源码旧（${OUT}）—— 先 npm run build:electron`);
  process.exit(1);
}
const { createHelpHub, HELP_MANUAL_HINT_MS } = require(OUT);

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

/** 造一个带全部假依赖的求助中心，并把每次调用都记下来 */
function makeHub(overrides = {}) {
  const rec = { emits: [], paused: [], watches: [], resumes: [], logs: [], timers: [] };
  let watchSeq = 0;
  const deps = {
    emit: (payload, wcId) => rec.emits.push({ payload, wcId }),
    markAgentPaused: (wcId, detail) => rec.paused.push({ wcId, detail }),
    startWatch: (wcId, onDone, opts) => {
      const id = ++watchSeq;
      const entry = { id, wcId, onDone, opts, stopped: false };
      rec.watches.push(entry);
      return () => {
        entry.stopped = true;
      };
    },
    requestResume: (wcId) => rec.resumes.push(wcId),
    goalOf: () => '把资料抄下来',
    agentOf: () => 1,
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      rec.timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      if (t) t.cleared = true;
    },
    log: (m) => rec.logs.push(m),
    ...overrides,
  };
  return { hub: createHelpHub(deps), rec };
}

const CAPTCHA = { helpKind: 'captcha', question: '要过人机验证', hint: '请直接在页面上完成验证。', hadSensitiveField: true };
const SLIDER = { helpKind: 'captcha', question: '要过滑块验证', hint: '请直接在页面上拖动滑块。', hadSensitiveField: false };
const LOGIN = { helpKind: 'login', question: '需要先登录', hint: '请直接在页面上登录。', hadSensitiveField: true };

console.log('=== 第 27 步 · 主进程求助接线验收（helpState，假依赖）===');

// ---------- 1. 求助：记账 + 发事件 + 记成 AI 发起 + 挂观察 ----------
{
  const { hub, rec } = makeHub();
  hub.raise(7, CAPTCHA);
  const helpEvt = rec.emits.find((e) => e.payload.kind === 'help');
  ok('1.1 求助后这张页有卡在册', hub.has(7) === true && hub.size() === 1);
  ok('1.2 往聊天区发了 help 事件（带 wcId，落回正确的对话）', helpEvt?.wcId === 7 && helpEvt.payload.helpKind === 'captcha', JSON.stringify(rec.emits));
  ok('1.3 help 事件里只有文案，没有任何输入/字段值', !('input' in (helpEvt?.payload ?? {})) && !('value' in (helpEvt?.payload ?? {})));
  ok('1.4 状态记成「AI 发起的暂停」', rec.paused.length === 1 && /AI 在等你处理/.test(rec.paused[0].detail), JSON.stringify(rec.paused));
  ok('1.5 挂了自动恢复观察', rec.watches.length === 1 && rec.watches[0].wcId === 7);
  ok('1.6 挂了 2 分钟手动兜底提示', rec.timers.length === 1 && rec.timers[0].ms === HELP_MANUAL_HINT_MS, JSON.stringify(rec.timers.map((t) => t.ms)));
  ok('1.7 记录里留住了目标（恢复时要接回它）', hub.get(7)?.goal === '把资料抄下来');
}

// ---------- 2. requireSensitiveField 的取值（防"卡片刚弹就被收掉"）----------
{
  const a = makeHub();
  a.hub.raise(7, CAPTCHA); // 页面本来就有敏感框
  ok('2.1 页面本来有敏感框 → 允许用「框消失」当完成信号', a.rec.watches[0].opts.requireSensitiveField === false, JSON.stringify(a.rec.watches[0].opts));
  const b = makeHub();
  b.hub.raise(7, SLIDER); // 滑块页：一个敏感框都没有
  ok('2.2 ★滑块页 → 只认导航/标题变化（否则 1.2 秒就自己收卡）', b.rec.watches[0].opts.requireSensitiveField === true, JSON.stringify(b.rec.watches[0].opts));
}

// ---------- 3. 自动感知：收卡 + 请求恢复 ----------
{
  const { hub, rec } = makeHub();
  hub.raise(7, CAPTCHA);
  rec.watches[0].onDone();
  ok('3.1 自动感知到页面变化 → 收了卡并通知渲染层', hub.has(7) === false && rec.emits.some((e) => e.payload.kind === 'help-clear' && e.payload.reason === 'page_changed'), JSON.stringify(rec.emits));
  ok('3.2 自动感知 → 请求恢复一次（走既有「继续」链路）', rec.resumes.length === 1 && rec.resumes[0] === 7, JSON.stringify(rec.resumes));
  ok('3.3 观察窗与定时器都停了（不留泄漏）', rec.watches[0].stopped === true && rec.timers[0].cleared === true);
}

// ---------- 4. ★自动与手动几乎同时到 → 只恢复一次 ----------
{
  const { hub, rec } = makeHub();
  hub.raise(7, CAPTCHA);
  const onDone = rec.watches[0].onDone;
  hub.clear(7, 'manual'); // 用户先点了「我处理好了」
  onDone(); // 紧接着页面也变了
  ok('4.1 已经手动收过卡 → 自动信号不再重复请求恢复', rec.resumes.length === 0, JSON.stringify(rec.resumes));
  const { hub: h2, rec: r2 } = makeHub();
  h2.raise(7, CAPTCHA);
  r2.watches[0].onDone();
  r2.watches[0].onDone(); // 同一路连续来两次
  ok('4.2 自动信号连来两次 → 也只恢复一次', r2.resumes.length === 1, JSON.stringify(r2.resumes));
}

// ---------- 5. 手动收卡 ----------
{
  const { hub, rec } = makeHub();
  hub.raise(7, LOGIN);
  const first = hub.clear(7, 'manual');
  const second = hub.clear(7, 'manual');
  ok('5.1 手动收卡返回"原本有"', first === true);
  ok('5.2 重复收卡是幂等的（第二次返回 false、不再发事件）', second === false && rec.emits.filter((e) => e.payload.kind === 'help-clear').length === 1, JSON.stringify(rec.emits));
  ok('5.3 手动路径**不**自己请求恢复（由「继续」那条链路负责）', rec.resumes.length === 0, JSON.stringify(rec.resumes));
  ok('5.4 手动收卡把观察窗停了', rec.watches[0].stopped === true);
}

// ---------- 6. 同一张页重复求助：只留最新一张，且不刷屏 ----------
{
  const { hub, rec } = makeHub();
  hub.raise(7, LOGIN);
  hub.raise(7, CAPTCHA);
  ok('6.1 重复求助只留最新一张', hub.size() === 1 && hub.get(7)?.helpKind === 'captcha', JSON.stringify(hub.get(7)));
  ok('6.2 旧的观察窗被停掉（不会两个观察同时挂着）', rec.watches[0].stopped === true && rec.watches[1].stopped === false, JSON.stringify(rec.watches.map((w) => w.stopped)));
  ok('6.3 中间不产生多余的 help-clear（不刷屏）', rec.emits.filter((e) => e.payload.kind === 'help-clear').length === 0, JSON.stringify(rec.emits));
  ok('6.4 两次求助各发一次 help 事件', rec.emits.filter((e) => e.payload.kind === 'help').length === 2);
}

// ---------- 7. 2 分钟兜底提示 ----------
{
  const { hub, rec } = makeHub();
  hub.raise(7, CAPTCHA);
  rec.timers[0].fn();
  ok('7.1 到点还没处理 → 提示还有手动按钮', rec.emits.some((e) => e.payload.kind === 'note' && /我处理好了/.test(e.payload.text)), JSON.stringify(rec.emits));
  const { hub: h2, rec: r2 } = makeHub();
  h2.raise(7, CAPTCHA);
  h2.clear(7, 'manual');
  r2.timers[0].fn();
  ok('7.2 已经处理完了 → 兜底提示不再打扰', !r2.emits.some((e) => e.payload.kind === 'note'), JSON.stringify(r2.emits));
}

// ---------- 8. 全局收卡 ----------
{
  const { hub, rec } = makeHub();
  hub.raise(7, CAPTCHA);
  hub.raise(8, LOGIN);
  hub.clearAll('aborted');
  ok('8.1 全局收卡把每一张都收掉并各通知一次', hub.size() === 0 && rec.emits.filter((e) => e.payload.kind === 'help-clear').length === 2, JSON.stringify(rec.emits));
  ok('8.2 全局收卡把所有观察窗都停了', rec.watches.every((w) => w.stopped === true), JSON.stringify(rec.watches.map((w) => w.stopped)));
}

console.log(`\n=== 结果：${CHECKS - FAILS}/${CHECKS} PASS，${FAILS} FAIL ===`);
process.exit(FAILS === 0 ? 0 : 1);
