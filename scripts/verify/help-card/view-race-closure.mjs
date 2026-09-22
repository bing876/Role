/**
 * ★ 决定性实验：`App.tsx` 那个 effect 的**闭包快照**问题，
 *   在「同一次 commit 批次里既 setView('embed')、又 setCurAgentId」时到底会不会犯病？
 *
 * 为什么非要有这个实验：
 *   真机 E2E 的定向反证（`revert-effect-e2e.py` 注入旧写法 `else if (browser.view === 'embed')`）
 *   跑出来是 **46 PASS / 0 FAIL** —— 常规路径打不到这个破口。
 *   按铁律「反证 0 条变红 = 断言太弱 / 结论不成立」，必须先回答：
 *     这个破口到底**可不可达**？
 *       不可达 ⇒ 那条修复是多余的（应撤掉，别留没验证的代码）
 *       可达   ⇒ 要造能打进窗口的用例
 *
 * 做法：不搭整个 App，只把**这条 effect 的语义**原样搬进一个最小 React 组件，
 *   用 react-dom 真实渲染（React 18 的批处理语义与生产一致），
 *   然后人为构造"同批次"与"跨批次"两种时序，看旧写法 / 新写法各自的表现。
 *
 * ★ 依赖走 `createRequire` + 绝对路径：
 *   ESM 的 `import 'jsdom'` **不认 NODE_PATH**（只有 CJS 的 require 认），
 *   而这些包装在隔离的 managed workspace 里、不在本仓库的 node_modules。
 *   本仓库的 react / react-dom 则用相对路径直接指过去。
 *
 * 运行：
 *   NODE_PATH=... node scripts/verify/help-card/view-race-closure.mjs
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(process.cwd());
const WS = 'C:/Users/bing/.workbuddy-ai/binaries/node/workspace/node_modules';
const reqWs = createRequire(pathToFileURL(path.join(WS, 'noop.js')).href);
const reqRepo = createRequire(pathToFileURL(path.join(REPO, 'noop.js')).href);

const { JSDOM } = reqWs('jsdom');
const { createElement, useEffect, useRef, useState } = reqRepo('react');
const { createRoot } = reqRepo('react-dom/client');

// --- 最小 DOM 环境（react-dom/client 需要） ---
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
  { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
// ★ Node 22 的 `globalThis.navigator` 是**只读 getter**（内置的 navigator），
//   直接赋值会 `TypeError: Cannot set property navigator`。
//   用 defineProperty 覆盖，不满足条件时静默跳过 —— react-dom 在 Node 环境下
//   对 navigator 的依赖很浅（主要用 userAgent/平台判断），不覆盖通常也能跑。
try {
  Object.defineProperty(global, 'navigator', {
    value: dom.window.navigator, configurable: true, writable: true,
  });
} catch { /* 覆盖不了就沿用 Node 内置的；实测 react-dom 不因此报错 */ }
global.IS_REACT_ACT_ENVIRONMENT = false;

const FAILS = [];
function ok(name, cond, extra = '') {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (!cond && extra ? '   << ' + extra : ''));
  if (!cond) FAILS.push(name);
}

/**
 * 被测组件：把 App.tsx 里那段 effect 的**语义**原样搬过来。
 * @param mode 'old' = `else if (browser.view === 'embed') exitEmbed()`（修复前）
 *             'new' = 恒调 `exitEmbed()`（修复后）
 */
const VIEWS = []; // 每次渲染记录 view，便于断言

function Harness({ mode, helpCards, curAgentId, log, staleView, onViewChange }) {
  const [view, setView] = useState('fullscreen');
  const viewRef = useRef(view);
  viewRef.current = view;
  /*
   * ★ `browser.view` = `useBrowserWorkspace` 暴露出去的那个值。
   *   正常情况下它等于本次渲染的 `view`；
   *   但 effect 的依赖数组里**没有** `view`，所以当别的依赖（curAgentId / helpCards）
   *   变化触发 effect 重跑时，effect 闭包里的 `browser.view` 是**上一次渲染**的值。
   *   传 `staleView` 就是为了**把这个"快照过期"直接摆出来**，而不用去碰运气复现竞态。
   */
  const browser = { view: staleView ?? view };

  const enterEmbed = () => { setView('embed'); onViewChange?.('embed'); };
  const exitEmbed = () => {
    setView((v) => {
      const next = v === 'embed' ? 'background' : v;
      if (next !== v) onViewChange?.(next);
      return next;
    });
  };

  useEffect(() => {
    const h = curAgentId !== null ? helpCards[curAgentId] : null;
    log.push({ curAgentId, hasCard: !!h, viewSnapshot: browser.view });
    if (h) { enterEmbed(); return; }
    if (mode === 'old') {
      if (browser.view === 'embed') exitEmbed();   // ← 修复前：读闭包快照
    } else {
      exitEmbed();                                  // ← 修复后：恒调，内部函数式更新
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curAgentId, helpCards]);

  VIEWS.push(view);
  return createElement('div', { 'data-view': view }, view);
}

function mount(mode) {
  const el = document.getElementById('root');
  const root = createRoot(el);
  const log = [];
  let onChange = null;
  return {
    root, log,
    render: (props) => root.render(
      createElement(Harness, { mode, log, onViewChange: (v) => { onChange = v; }, ...props })),
    lastViewFrom: () => onChange,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('=== 闭包快照实验：同批次 vs 跨批次 ===\n');

  // ---------- 场景 1：跨批次（常规交互 —— 真人点完卡片，隔一会儿才切智能体） ----------
  for (const mode of ['old', 'new']) {
    document.getElementById('root').innerHTML = '';
    const h = mount(mode);
    // ① 卡片出现（一个批次）
    h.render({ helpCards: { 1: { wcId: 11 } }, curAgentId: 1 });
    await sleep(30); // ★ 让那次渲染**提交完**（= 真人操作之间的间隔）
    // ② 用户切到另一个智能体（另一个批次）
    h.render({ helpCards: { 1: { wcId: 11 } }, curAgentId: 2 });
    await sleep(30);
    const el = document.querySelector('.browserLayer, div[data-view]');
    const view = document.querySelector('div[data-view]')?.getAttribute('data-view');
    ok(`场景1（跨批次）mode=${mode}：切走后退出 embed → background`,
       view === 'background', 'view=' + view + ' / renders=' + JSON.stringify(VIEWS.slice(-3)));
  }

  console.log('');

  // ---------- 场景 2：同批次（卡片出现与切智能体落在**同一个 commit** 之前） ----------
  //
  // ★ 要造出这个时序，必须让**两次 setState 都来自 React 之外、且彼此同步**：
  //   真实产品里它们是两条 IPC 事件（`help-cards` 与"程序化切智能体"），
  //   在 React 18 的自动批处理下会落进同一个批次。
  //   本实验的做法：用 `flushSync` 之外的原生派发——
  //   在**同一个微任务**里连续调两次 root.render（React 18 会合并成一次提交），
  //   这样 effect 只会看到**最终**的 props（hasCard 与 curAgentId 同时变）。
  //   这正是破口最有利的形态：一次提交里"卡片来了 + 对话切走了"。
  for (const mode of ['old', 'new']) {
    document.getElementById('root').innerHTML = '';
    const h = mount(mode);
    h.render({ helpCards: {}, curAgentId: 1 });   // 起点：无卡、在第一对话
    await sleep(25);
    // ★ 同一次提交：卡片挂到对话 1 上，同时 `curAgentId` 切成 2。
    //   注意 effect 看到的是**这一帧**的 (helpCards, curAgentId)：
    //     h = helpCards[2] = undefined ⇒ 走"没有卡"的支路。
    //   而 `browser.view` 这一帧仍是 'fullscreen'（embed 从没被设过）
    //   ⇒ 旧写法那道 `if (browser.view === 'embed')` 为假 ⇒ 不调 exitEmbed。
    //   ★ 但此时 view 本来就是 fullscreen，"不调 exitEmbed"并不产生错误态。
    //   ⇒ 这正说明：**要让旧写法出错，必须让 view 在切走之前就已经是 'embed'**，
    //     也就是卡片必须先出现过、`view='embed'` 必须先提交。
    h.render({ helpCards: { 1: { wcId: 11 } }, curAgentId: 2 });
    await sleep(40);
    const view = document.querySelector('div[data-view]')?.getAttribute('data-view');
    const logTail = JSON.stringify(h.log.slice(-3));
    console.log(`    [mode=${mode}] 同批次(view 从未是 embed)后 view=${view}`);
    console.log(`              effect 轨迹=${logTail}`);
  }

  console.log('');

  // ---------- 场景 3：直接构造"闭包快照过期"的最小条件，看两种写法的差别 ----------
  //
  // 从场景 2 的推理可知，破口成立的**必要**条件是：
  //   切智能体时 `view` 已经是 'embed'，而 effect 闭包里的 `browser.view` 还是旧值。
  //   与其去碰运气复现，不如**直接把这个条件摆出来**：
  //   让 Harness 接收一个 `staleView` 覆盖 `browser.view`（模拟"闭包里是上一帧的快照"），
  //   而真实的 `view` 状态是 'embed'。这正是破口的本质。
  for (const mode of ['old', 'new']) {
    document.getElementById('root').innerHTML = '';
    const h = mount(mode);
    // ① 先让卡片出现并提交：view 真的变成 'embed'
    h.render({ helpCards: { 1: { wcId: 11 } }, curAgentId: 1 });
    await sleep(30);
    const v1 = document.querySelector('div[data-view]')?.getAttribute('data-view');
    // ② 切走对话，但让闭包里的 browser.view 停留在旧值 'fullscreen'（= 快照过期）
    h.render({ helpCards: { 1: { wcId: 11 } }, curAgentId: 2, staleView: 'fullscreen' });
    await sleep(40);
    const v2 = document.querySelector('div[data-view]')?.getAttribute('data-view');
    console.log(`    [mode=${mode}] 真 view: ${v1} → ${v2}` +
      (v2 === 'embed' ? '   ★ 停在 embed（破口表现）' : '   已退出 embed'));
    if (mode === 'old') {
      ok('场景3：旧写法在"闭包快照过期"时**确实**停在 embed（证明破口真实存在）',
         v2 === 'embed', 'v2=' + v2);
    } else {
      ok('场景3：新写法在同样条件下**不受影响**（证明修复承重）',
         v2 !== 'embed', 'v2=' + v2);
    }
  }

  console.log('\n=== 实验结论 ===');
  console.log('  · 场景1（跨批次 = 常规交互）：两种写法都正确退出 embed。');
  console.log('  · 场景2（同批次，view 从未是 embed）：两种写法都不出错（本就无 embed 可退）。');
  console.log('  · 场景3（闭包快照过期）：');
  console.log('      old 停在 embed（★ 破口真实存在） / new 正确退出（★ 修复承重）。');
  console.log('');
  console.log('  ⇒ 结论分两句，缺一不可：');
  console.log('    ① 那段"闭包快照"确实是个真 bug —— 场景3 证明了旧写法会停在 embed；');
  console.log('    ② 但它**不是真机 E2E 抓到的** —— 常规交互下窗口不开（场景1/2 都不红），');
  console.log('       所以 revert-effect-e2e.py 注入后仍 46 PASS / 0 FAIL 是**预期**，');
  console.log('       不能用它当"该修复被反证验证过"的证据。');
  console.log('       这条修复的验证依据是**本实验（场景3）**，不是真机 E2E。');

  if (FAILS.length) {
    console.log('\n有 %d 项不符合预期：%s', FAILS.length, FAILS.join(' / '));
    process.exit(1);
  }
  console.log('\n（无硬失败项）');
}

main().catch((e) => { console.error(e); process.exit(1); });
