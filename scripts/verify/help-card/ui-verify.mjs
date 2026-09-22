/**
 * 第 27 步 · 人工介入卡片 —— **真实渲染层**验收（无头 Chromium + 真 DOM/真 CSS/真布局）
 *
 * 为什么要这么搭：本机 agent 环境**起不了 GUI Electron 进程**（试过直接跑 / 重定向 /
 * Python 生成 GBK .cmd / 关沙箱 / 后台跑，全部被 SIGTERM），所以拿不到"真 Electron 窗口"。
 * 但本次要验的东西里，**大头是渲染层**（卡片在不在消息流里、视觉分不分得清、
 * 几何跟不跟得上、卡片里有没有输入控件）—— 这些用真浏览器 + 真 CSS 引擎验，
 * 证据强度足够，而且比"读代码觉得没问题"硬得多。
 *
 * 做法：
 *   1. 起一个静态服务，把**构建产物** apps/desktop/dist 原样发出去（验的就是真产物）；
 *   2. 用 addInitScript 装一个**假的 window.workbench 桥** + 一个假的 <webview> 自定义元素
 *      （真实 Electron 里 <webview> 是 Chromium 认得的宿主标签，普通 Chromium 不认，
 *       所以补一个同名自定义元素，提供 getWebContentsId()，让渲染层能认出"哪张页"）；
 *   3. 用假桥把主进程会发的 'agent' / 'state' / 'open' 事件推给渲染层，观察真实反应。
 *
 * ★ 这里**不测**（它们在主进程/服务端，见 node 逻辑验收脚本）：
 *   保守触发闸、challengeLike 页面判定、pausedBy 在主进程侧的传播、恢复链路。
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/bing/.workbuddy-ai/binaries/node/workspace/node_modules/playwright-core');

const DIST = 'C:/Users/bing/workbuddy-ai/work123/apps/desktop/dist';
const CHROME =
  'C:/Users/bing/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';
// ★ 端口让系统分配（传 0），不写死 —— 写死 5199 会和别的验收/残留进程抢，
//   表现是"上一次全绿、这次 4 条红"，查半天查不到原因（本套件真踩过一次）。
let PORT = 0;
const API = 'http://127.0.0.1:8799';
const WC_ID = 7001;

// ---- 断言计数（真数，不写死常量）--------------------------------------------
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
const near = (a, b, tol = 2) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

// ---- 静态服务：原样发构建产物 -------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(DIST, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(path.normalize(DIST)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
PORT = server.address().port;
console.log(`（静态服务已起在 127.0.0.1:${PORT}）`);

// ---- 假桥 + 假 webview -------------------------------------------------------
const INIT = ({ api, token, wcId }) => {
  localStorage.setItem('workbench.apiBase', api);
  localStorage.setItem('workbench.token', token);

  /**
   * 假 <webview>。
   *
   * ★ 不能用 customElements.define('webview', ...) —— **自定义元素名必须含连字符**，
   *   `webview` 会当场抛 SyntaxError，而且它会打断整个 addInitScript，
   *   表现是"桥没装上、但页面看起来正常"（极难查）。所以改成包一层 createElement。
   */
  const origCreate = document.createElement.bind(document);
  document.createElement = (tag, opts) => {
    const el = origCreate(tag, opts);
    if (String(tag).toLowerCase() === 'webview') {
      el.getWebContentsId = () => wcId;
      el.focus = () => {};
      el.executeJavaScript = () => Promise.resolve(undefined);
    }
    return el;
  };

  const listeners = {};
  window.__emit = (event, payload) => {
    for (const cb of listeners[event] ?? []) cb(payload);
  };
  window.__calls = [];
  const rec = (name, ...args) => {
    window.__calls.push({ name, args });
  };

  const taskState = { phase: 'idle', detail: 'idle', step: 0, blocked: false, wcId, pausedBy: null };
  window.__setTaskState = (patch) => Object.assign(taskState, patch);

  const base = {
    platform: 'win32',
    appVersion: '0.1.0-uitest',
    ping: async () => 'pong',
    on: (event, cb) => {
      (listeners[event] ||= []).push(cb);
      return () => {
        listeners[event] = (listeners[event] ?? []).filter((x) => x !== cb);
      };
    },
    getTaskState: async () => ({ ...taskState }),
    pauseTask: async () => {
      rec('pauseTask');
      return { ...taskState };
    },
    resumeTask: async (w) => {
      rec('resumeTask', w);
      return { ...taskState };
    },
    agentDrop: async (w) => {
      rec('agentDrop', w);
    },
    agentLanes: async () => [wcId],
    browserOwner: async () => undefined,
    browserThrottle: async () => ({ ok: true }),
    syncSession: async () => undefined,
    getSettings: async () => ({
      maxConcurrentAgentTasks: 20,
      maxBrowserInstances: 4,
      resourceGuardEnabled: 0,
      resourceSampleMs: 5000,
      resourceMemHealthMB: 3072,
      resourceMemWarnMB: 4096,
      resourceCpuHealthPct: 20,
      resourceCpuWarnPct: 35,
      resourceSysMemGuard: 0,
      resourceSysMemFloorMB: 1536,
    }),
    setSettings: async (p) => p,
  };
  // 未列出的方法一律当"存在的空实现"——免得某个次要通道缺失把整页打挂
  window.workbench = new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      return async (...args) => {
        rec(String(k), ...args);
        return undefined;
      };
    },
  });
};

// ---- 假后端 ----------------------------------------------------------------
const json = (obj) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`);
});

await page.addInitScript(INIT, { api: API, token: 'fake-token-for-uitest', wcId: WC_ID });
await page.route(`${API}/**`, async (route) => {
  const u = new URL(route.request().url());
  const p = u.pathname;
  if (p === '/auth/me')
    return route.fulfill(
      json({
        user: { id: 1, xyz_id: 'XYZ10001', has_password: false, phone_masked: '138****8000' },
        project: { id: 1, name: '默认项目', isCurrent: true },
        agents: [{ id: 1, name: '小助' }],
      }),
    );
  if (p === '/health') return route.fulfill(json({ ok: true, service: 'ai-workbench-server', db: 'up', sms: 'mock' }));
  if (p === '/projects') return route.fulfill(json({ projects: [{ id: 1, name: '默认项目', isCurrent: true }], currentProjectId: 1 }));
  if (p === '/agents')
    return route.fulfill(
      json({
        agents: [
          {
            id: 1,
            name: '小助',
            kind: 'assistant',
            deletable: false,
            projectId: 1,
            personaStatus: 'ready',
            persona: null,
            conversationId: 11,
          },
        ],
      }),
    );
  if (p === '/chat/history')
    return route.fulfill(
      json({
        conversationId: 11,
        // 刻意灌够条数，让 .chat 真的撑出滚动条 —— 否则"滚聊天卡片跟着走"根本测不到
        messages: [
          { id: 1, role: 'user', text: '帮我打开某个要登录的页面，把里面的资料抄下来' },
          { id: 2, role: 'assistant', text: '好，我开始操作。' },
          ...Array.from({ length: 28 }, (_, i) => ({
            id: 10 + i,
            role: i % 2 === 0 ? 'user' : 'assistant',
            text: `第 ${i + 1} 轮对话：这一步是为了把聊天区撑高，好验证卡片真的跟着消息流一起滚。`,
          })),
        ],
      }),
    );
  if (p === '/chat/state')
    return route.fulfill(
      json({
        conversationId: 11,
        state: {
          conversationId: 11,
          current_task: '',
          latest_user_intent: '',
          browser_confirmed: false,
          login_required: false,
          sensitive_action: false,
          last_page_summary: '',
          already_told_user_login_themselves: false,
          keepalive: false,
        },
      }),
    );
  if (p === '/agent/task/current') return route.fulfill(json({ task: null }));
  if (p === '/knowledge') return route.fulfill(json({ documents: [] }));
  if (p === '/memory/user' || p.endsWith('/memory')) return route.fulfill(json({ items: [] }));
  return route.fulfill(json({}));
});

console.log('=== 第 27 步 · 人工介入卡片 · 渲染层验收（真 DOM/CSS/布局）===');
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });

// 等登录态静默恢复 + 聊天区出现
await page.waitForSelector('.chat', { timeout: 15000 });
await page.waitForFunction(() => document.querySelectorAll('.msg').length >= 2, null, { timeout: 15000 });

// ---------- 场景 0：先开一张页（用户全屏看浏览器）----------
await page.evaluate(() => window.__emit('open', 'https://example.com/login'));
await page.waitForSelector('webview', { timeout: 10000 });
await page.waitForTimeout(400);

const layerClass0 = await page.getAttribute('.browserLayer', 'class').catch(() => null);
ok('0.1 开页后浏览器层是全屏态（browserLayer，无 --embed）', layerClass0 === 'browserLayer', `class=${layerClass0}`);

// ---------- 场景 1：AI 主动求助 → 卡片出现在聊天流里 ----------
await page.evaluate(
  ({ wcId }) =>
    window.__emit(
      'agent',
      JSON.stringify({
        kind: 'help',
        helpKind: 'captcha',
        question: '这一页要过人机验证（验证码 / 滑块），这一步我没法替你完成。',
        hint: '请在下面这块页面里直接完成验证。我不会代填验证码，也不会代点提交。',
        wcId,
      }),
    ),
  { wcId: WC_ID },
);
await page.waitForSelector('.helpCard', { timeout: 8000 });
await page.waitForTimeout(500);

ok('1.1 求助卡出现在聊天区（.chat 内）', await page.$('.chat .helpCard') !== null);
const cardSiblings = await page.evaluate(() => {
  const card = document.querySelector('.helpCard');
  const parent = card?.parentElement;
  // ★ 消息是 .chat 的**孙**节点（外层还有一层 <div key> 包裹），不能用 :scope > .msg
  //   去数 —— 那样永远是 0（第一次就踩了这个，差点误判成"卡片不在消息流里"）。
  const msgs = [...document.querySelectorAll('.chat .msg')];
  const before = msgs.filter(
    (m) => (card.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_PRECEDING) !== 0,
  ).length;
  return {
    parentIsChat: parent?.classList.contains('chat') === true,
    totalMsgs: msgs.length,
    msgsBefore: before,
  };
});
ok('1.2 卡片是聊天流的子节点（不是钉在外面的独立区域）', cardSiblings.parentIsChat, JSON.stringify(cardSiblings));
ok('1.3 卡片排在已有消息之后（跟着消息流走）', cardSiblings.msgsBefore >= 2, JSON.stringify(cardSiblings));

// ---------- 场景 2：自动切回聊天视图 ----------
const layerClass1 = await page.getAttribute('.browserLayer', 'class');
ok('2.1 求助触发后浏览器层自动切到求助卡模式（browserLayer--embed）', /browserLayer--embed/.test(layerClass1 ?? ''), `class=${layerClass1}`);
ok('2.2 求助卡模式下不再有全屏工作区（顶栏/地址栏已让位）', await page.evaluate(() => {
  const tabs = document.querySelector('.browserPanel__tabs');
  return !tabs || getComputedStyle(tabs).display === 'none';
}));

// ---------- 场景 3：几何跟随（影子层核心）----------
const geo1 = await page.evaluate(() => {
  const holder = document.querySelector('.helpCard__stage');
  const stage = document.querySelector('.browserPanel__stage');
  const wv = document.querySelector('webview');
  const h = holder.getBoundingClientRect();
  const s = stage.getBoundingClientRect();
  return {
    expected: {
      left: Math.round(h.left - s.left),
      top: Math.round(h.top - s.top),
      width: Math.round(h.width),
      height: Math.round(h.height),
    },
    actual: {
      left: parseFloat(wv.style.left),
      top: parseFloat(wv.style.top),
      width: parseFloat(wv.style.width),
      height: parseFloat(wv.style.height),
    },
    wvClass: wv.className,
    wvParent: wv.parentElement?.className ?? '',
  };
});
ok('3.1 目标页拿到了 embed 类（露脸的是它）', /browserPanel__view--embed/.test(geo1.wvClass), geo1.wvClass);
ok('3.2 webview 仍在原来的舞台里（DOM 没被搬走）', /browserPanel__stage/.test(geo1.wvParent), geo1.wvParent);
ok('3.3 页面几何与卡片占位区对齐', near(geo1.actual.left, geo1.expected.left) && near(geo1.actual.top, geo1.expected.top), JSON.stringify(geo1));
ok('3.4 页面尺寸与卡片占位区一致（且不是 0×0）', geo1.actual.width > 100 && near(geo1.actual.width, geo1.expected.width) && near(geo1.actual.height, geo1.expected.height), JSON.stringify(geo1));

// 滚动聊天区 → 几何要跟着走（先确认聊天区**真的**滚得动，否则这条断言是假的）
const scrollInfo = await page.evaluate(() => {
  const chat = document.querySelector('.chat');
  return { scrollHeight: chat.scrollHeight, clientHeight: chat.clientHeight };
});
ok('3.5 聊天区确实撑出了滚动条（否则下面那条滚动断言是空跑）', scrollInfo.scrollHeight > scrollInfo.clientHeight, JSON.stringify(scrollInfo));

const topBefore = geo1.actual.top;
await page.evaluate(() => {
  document.querySelector('.chat').scrollTop = 120;
});
await page.waitForTimeout(400);
const geo2 = await page.evaluate(() => {
  const holder = document.querySelector('.helpCard__stage');
  const stage = document.querySelector('.browserPanel__stage');
  const wv = document.querySelector('webview');
  const h = holder.getBoundingClientRect();
  const s = stage.getBoundingClientRect();
  return {
    chatScrollTop: document.querySelector('.chat').scrollTop,
    expectedTop: Math.round(h.top - s.top),
    actualTop: parseFloat(wv.style.top),
    clip: wv.style.clipPath,
  };
});
ok(
  '3.6 滚动聊天后页面几何跟着走（影子层跟随生效）',
  near(geo2.actualTop, geo2.expectedTop) && geo2.actualTop !== topBefore,
  JSON.stringify({ ...geo2, topBefore }),
);

// ---------- 场景 4：安全红线（卡片里没有任何输入/代填能力）----------
const safety = await page.evaluate(() => {
  const card = document.querySelector('.helpCard');
  const bad = card.querySelectorAll('input, textarea, select, form, [contenteditable="true"]');
  const submitish = [...card.querySelectorAll('button')].filter((b) =>
    /(提交|确认提交|发送验证码|填写|登录|验证|保存)/.test(b.textContent ?? ''),
  );
  return {
    badCount: bad.length,
    badTags: [...bad].map((e) => e.tagName.toLowerCase()),
    submitCount: submitish.length,
    submitTexts: submitish.map((b) => (b.textContent ?? '').trim()),
    html: card.innerHTML,
  };
});
ok('4.1 卡片内没有任何输入控件（input/textarea/select/form/contenteditable）', safety.badCount === 0, JSON.stringify(safety.badTags));
ok('4.2 卡片内没有"提交/验证/登录/填写"这类代填动作按钮', safety.submitCount === 0, JSON.stringify(safety.submitTexts));
ok('4.3 卡片 HTML 里不含 password / 输入类 type', !/type=["']?(password|text|tel|number)/i.test(safety.html));
ok('4.4 卡片里的真实页面是"真页面"（就是那个一直挂着的 webview）', geo1.wvClass.includes('embed') && safety.badCount === 0);

// ---------- 场景 5：视觉区分（用户接管 vs AI 求助）----------
const visualAgent = await page.evaluate(async () => {
  window.__setTaskState({ phase: 'paused', detail: 'AI 在等你处理（验证码 / 滑块）', pausedBy: 'agent' });
  await new Promise((r) => setTimeout(r, 1500));
  const el = document.querySelector('.driveState');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { cls: el.className, text: el.textContent, color: cs.color, bg: cs.backgroundColor, border: cs.borderColor };
});
const visualUser = await page.evaluate(async () => {
  window.__setTaskState({ phase: 'paused', detail: '已暂停 — 自动操作已停止', pausedBy: 'user' });
  await new Promise((r) => setTimeout(r, 1500));
  const el = document.querySelector('.driveState');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { cls: el.className, text: el.textContent, color: cs.color, bg: cs.backgroundColor, border: cs.borderColor };
});

ok('5.1 AI 求助有专属样式类 driveState--agent', /driveState--agent/.test(visualAgent?.cls ?? ''), JSON.stringify(visualAgent));
ok('5.2 用户接管有专属样式类 driveState--user', /driveState--user/.test(visualUser?.cls ?? ''), JSON.stringify(visualUser));
ok('5.3 两种情况的文案不同且说得清是谁发起', /AI 主动求助/.test(visualAgent?.text ?? '') && /你主动接管/.test(visualUser?.text ?? ''), `${visualAgent?.text} || ${visualUser?.text}`);
ok('5.4 两种情况的颜色不同（背景色）', visualAgent?.bg !== visualUser?.bg, `${visualAgent?.bg} vs ${visualUser?.bg}`);
ok('5.5 两种情况的颜色不同（文字色）', visualAgent?.color !== visualUser?.color, `${visualAgent?.color} vs ${visualUser?.color}`);
ok('5.6 两种情况的图标不同', (visualAgent?.text ?? '').slice(0, 2) !== (visualUser?.text ?? '').slice(0, 2), `${visualAgent?.text?.slice(0, 2)} vs ${visualUser?.text?.slice(0, 2)}`);

// ---------- 场景 6：手动「我处理好了」按钮 → 走既有 resumeTask 通道 ----------
const clicked = await page.evaluate(async () => {
  window.__calls.length = 0;
  const btn = [...document.querySelectorAll('.helpCard button')].find((b) => /我处理好了/.test(b.textContent ?? ''));
  if (!btn) return { found: false };
  btn.click();
  await new Promise((r) => setTimeout(r, 600));
  return { found: true, calls: window.__calls };
});
ok('6.1 卡片上有「我处理好了，继续」按钮', clicked.found === true);
ok('6.2 点它走的是既有 resumeTask 通道（点名那张页）', (clicked.calls ?? []).some((c) => c.name === 'resumeTask' && c.args[0] === WC_ID), JSON.stringify(clicked.calls));
ok('6.3 点完卡片收起', await page.$('.helpCard') === null);
ok('6.4 点完退出求助卡模式（层回到全屏）', !/browserLayer--embed/.test((await page.getAttribute('.browserLayer', 'class')) ?? ''));

// ---------- 场景 7：主进程自动感知完成 → help-clear 事件收卡 ----------
await page.evaluate(
  ({ wcId }) =>
    window.__emit('agent', JSON.stringify({ kind: 'help', helpKind: 'login', question: '这一页需要先登录。', hint: '请直接在这块页面里登录。', wcId })),
  { wcId: WC_ID },
);
await page.waitForSelector('.helpCard', { timeout: 8000 });
await page.waitForTimeout(300);
ok('7.1 再次求助能重新弹卡（login 场景）', await page.$('.helpCard') !== null);
await page.evaluate(({ wcId }) => window.__emit('agent', JSON.stringify({ kind: 'help-clear', reason: 'page_changed', wcId })), { wcId: WC_ID });
await page.waitForTimeout(500);
ok('7.2 收到 help-clear 后卡片收起', await page.$('.helpCard') === null);
ok('7.3 收到 help-clear 后退出求助卡模式', !/browserLayer--embed/.test((await page.getAttribute('.browserLayer', 'class')) ?? ''));

ok('8.1 全程渲染层无 JS 报错', pageErrors.length === 0, pageErrors.join(' | '));

console.log(`\n=== 结果：${CHECKS - FAILS}/${CHECKS} PASS，${FAILS} FAIL ===`);
process.exit(FAILS === 0 ? 0 : 1);
