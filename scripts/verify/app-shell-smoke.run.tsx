/**
 * 批次 M · M0 冒烟网 —— **真正跑起来的那一半**。
 *
 * 由 `scripts/verify/app-shell-smoke.mts` 用 esbuild 打包后执行
 * （要加载 `.tsx` 与 CSS 导入；CSS 由 driver 置空）。
 *
 * 这一层要挡住的是**结构性事故**，不是像素：M1'–M8' 会把 3714 行的 App.tsx 拆成
 * 外壳 + 7 个 feature，任何一次「顺手加个 wrapper」「把面板挪进条件渲染」都可能把
 * `<webview>` 从它原来的父节点上摘下来 —— 而 `browser/` 里的驾驶坐标全部来自
 * 页内 `getBoundingClientRect`，**元素一被卸载重建，正在跑的那张页当场没了、点击坐标全废**
 * （收尾 7 的 `.browserLayer--bg` 注释与 `panel-visibility-coupling-probe.py` 都在守这条）。
 *
 * 所以本脚本用 **jsdom 挂载整个 `<App/>`**（不是抄一份组件、不是只渲染 BrowserPanel），
 * 走**真实路径**把一张页开出来（主进程 `open` 事件 → `browser.openFromMain` → `openUrl`），
 * 然后钉两件事：
 *   ① **祖先链 golden**：`<webview>` 到 `html` 的每一层 `tag.className` 逐字节一致；
 *   ② **节点身份**：切换可见度档位 / 切换浏览器视图 / 切换智能体之后，
 *      **还是同一个 DOM 元素对象**（不是「长得一样的新元素」）。
 *
 * ⚠️ 硬规则的准确表述（见 批次M 侦查报告 §4.2）：**除了三条有意路径**——
 *   ① `allTabs` 归零（关光所有页）、② 该页进入**深休眠**、③ `key={t.id}` 变化——
 *    之外，祖先链与节点身份必须逐字节不变。**写成「webview 永远不卸载」是错的**，
 *    按那种写法测会在这三条上假红。本脚本对路径 ① 是**正向断言**（关光页就必须卸载）。
 *
 * 用法（一般由 npm script 调）：
 *   npm run verify:shell
 *   npm run verify:shell -- --update-golden     # 只在你确认链变更是有意的时候用
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

/**
 * ★ 仓库根**不能**从 `import.meta.url` 推：本文件会被 esbuild 打进
 *   `node_modules/.cache/app-shell-smoke/ui-test.mjs` 再执行，那时
 *   `import.meta.url` 指向缓存目录（第一次跑就把 golden 写进了 node_modules/docs/…）。
 *   由 driver 通过环境变量传进来，兜底才用 cwd。
 */
const REPO = process.env.SMOKE_REPO ?? process.cwd();
const GOLDEN = join(REPO, 'docs', 'acceptance', 'app-shell', 'webview-ancestor-chain.golden.json');
const UPDATE_GOLDEN = process.argv.includes('--update-golden');

// ---------------------------------------------------------------------------
// 输出小工具（与 orc-channels-ui.run.tsx 同一套口径）
// ---------------------------------------------------------------------------
let passes = 0;
let fails = 0;
const log = (s = ''): void => console.log(s);
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passes += 1;
    log(`  ✓ ${name}`);
  } catch (err) {
    fails += 1;
    log(`  ✗ ${name}`);
    log(`      ${(err as Error).message.split('\n').slice(0, 4).join('\n      ')}`);
  }
}

// ---------------------------------------------------------------------------
// 1. jsdom 全局（★ 必须在 import react-dom **之前**铺好）
// ---------------------------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
/** 不设这个，act() 会退化并打「not configured to support act(...)」，断言可能在 effect 跑完前就执行 */
g.IS_REACT_ACT_ENVIRONMENT = true;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(g, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
for (const k of ['HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage']) {
  const v = (dom.window as unknown as Record<string, unknown>)[k];
  if (v !== undefined) g[k] = typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(dom.window) : v;
}
/** jsdom 没有这两个：App / HelpCard / 浏览器层会用到，给最小实现 */
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
if (!(dom.window as unknown as { matchMedia?: unknown }).matchMedia) {
  (dom.window as unknown as Record<string, unknown>).matchMedia = () => ({
    matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  });
}

// ---------------------------------------------------------------------------
// 2. 桥桩（window.workbench）—— 记录调用，并让测试能**真的触发主进程事件**
// ---------------------------------------------------------------------------
const bridgeCalls: string[] = [];
const handlers = new Map<string, (payload?: unknown) => void>();
const bridge = new Proxy(
  {
    isElectron: false,
    apiBase: () => '',
    token: () => null,
    /**
     * ★ 被**直接 await / .then** 的桥方法必须给真值，不能交给 Proxy 的兜底空实现：
     *   `bridge.getSettings().then(setSettings)` 返回 undefined 会把 settings 置空，
     *   下一次渲染读 settings.maxConcurrentAgentTasks 当场崩（第一次跑就是这么崩的）。
     *   值抄自 App.tsx 的 SETTINGS_FALLBACK（主进程是权威，这里是首帧兜底）。
     */
    getSettings: async () => ({
      maxConcurrentAgentTasks: 20,
      maxBrowserInstances: 4,
      resourceGuardEnabled: 1,
      resourceSampleMs: 5000,
      resourceMemHealthMB: 3072,
      resourceMemWarnMB: 4096,
      resourceCpuHealthPct: 20,
      resourceCpuWarnPct: 35,
      resourceSysMemGuard: 0,
      resourceSysMemFloorMB: 1536,
    }),
    setSettings: async (patch: Record<string, unknown>) => patch,
    /**
     * ★ 这类方法**直接返回退订函数**（不是走 bridge.on），Proxy 的兜底会返回 Promise
     *   把它破坏成 `off is not a function` —— 登出回到登录页时 AuthScreen 会立刻踩到。
     *   签名见 shared：`onSmsMockCode(cb) => () => void`。
     */
    onSmsMockCode: () => () => {},
    resourceSnapshot: async () => null,
    resourceInstances: async () => [],
    agentLanes: async () => [],
    /** 主进程 → 渲染层的唯一订阅口（App 用 bridge.on('open' | 'agent' | 'settings' …)） */
    on: (channel: string, handler: (payload?: unknown) => void) => {
      handlers.set(channel, handler);
      bridgeCalls.push(`on(${channel})`);
      return () => handlers.delete(channel);
    },
  } as Record<string, unknown>,
  {
    get(target, prop) {
      const key = String(prop);
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        bridgeCalls.push(`${key}(${args.length})`);
        return Promise.resolve(undefined);
      };
    },
  },
);
(dom.window as unknown as Record<string, unknown>).workbench = bridge;
/** 触发一条主进程事件（真实路径：App 的 effect 里注册的 bridge.on 处理函数） */
const emitBridge = (channel: string, payload?: unknown): number => {
  const h = handlers.get(channel);
  if (!h) return 0;
  h(payload);
  return 1;
};

// ---------------------------------------------------------------------------
// 3. fetch 桩 —— App 启动要打一串接口；未识别的路径记下来（不许静默假装成功）
// ---------------------------------------------------------------------------
const requestedPaths: string[] = [];
const PROJECT = { id: 7, name: '默认项目', isCurrent: true, isDefault: true, henAgentId: null };
const AGENTS = [
  { id: 97, name: '小助', kind: 'assistant', deletable: false, projectId: 7, personaStatus: 'ready', persona: null, conversationId: 501, status: 'idle' },
  { id: 98, name: '卡布', kind: 'worker', deletable: true, projectId: 7, personaStatus: 'ready', persona: null, conversationId: 502, status: 'idle' },
];
const STATE = {
  conversationId: 501, current_task: '', latest_user_intent: '', browser_confirmed: false,
  login_required: false, sensitive_action: false, last_page_summary: '', already_told_user_login_themselves: false, keepalive: false,
};
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const path = raw.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  requestedPaths.push(path);
  if (path === '/auth/me') return json({ user: { id: 1, phone: '13800000000', xyz: '' }, project: PROJECT, agents: [{ id: 97, name: '小助' }] });
  if (path === '/projects') return json({ projects: [PROJECT], currentProjectId: 7 });
  if (path === '/agents') return json({ agents: AGENTS });
  if (path === '/chat/state') return json({ conversationId: 501, state: STATE });
  if (path === '/chat/history') return json({ conversationId: 501, messages: [] });
  if (path === '/memory/user' || path.startsWith('/agents/') && path.endsWith('/memory')) return json({ items: [] });
  if (path === '/memories') return json({ items: [], pending: [] });
  if (path === '/knowledge') return json({ documents: [] });
  if (path === '/agent/task/current') return json({ task: null });
  if (path === '/settings') return json({});
  if (path.includes('/visibility')) return json({ visibility: 'status' });
  if (path === '/health') return json({ ok: true, service: 'ai-workbench' });
  return json({});
}) as typeof fetch;

dom.window.localStorage.setItem('workbench.token', 'smoke-token');

// ---------------------------------------------------------------------------
// 4. 真正 import（必须在全局铺好之后）
// ---------------------------------------------------------------------------
const { act } = await import('react-dom/test-utils');
const { createRoot } = await import('react-dom/client');
const React = (await import('react')).default;
const App = (await import('../../apps/desktop/src/App')).default;

/** 反复 flush 微任务 + 定时器，让 effect / await 链跑完 */
async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
async function waitFor(name: string, pred: () => boolean, rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (pred()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`等不到条件：${name}`);
}

const doc = dom.window.document;
const q = (sel: string): Element | null => doc.querySelector(sel);
const qa = (sel: string): Element[] => Array.from(doc.querySelectorAll(sel));

// ---------------------------------------------------------------------------
// 5. 工具：祖先链 / 节点身份
// ---------------------------------------------------------------------------
/**
 * `<webview>` → 根：每一层的 `tag.块与元素名`。
 *
 * ★ 为什么要剥掉 BEM **修饰符**（`--bg` / `--embed` / `--off` …）：
 *   它们正是「**只改看得见多少、不改跑不跑**」的实现方式 ——
 *   `.browserLayer--bg`（后台运行）与 `.browserPanel--embed`（求助卡）都是**有意**变化的，
 *   把它们算进 golden 会让每一次正常的视图切换都假红。
 *   而「结构」= 标签 + 块/元素名（`browserPanel__stage` / `computerVisibility__host` …），
 *   多加一层 wrapper、把面板塞进别人 children，都会在这里立刻现形。
 */
function normalizeClass(raw: string | null): string {
  return (raw ?? '')
    .split(/\s+/)
    .filter((t) => t && !t.includes('--'))
    .sort()
    .join('.');
}
function ancestorChain(el: Element): string[] {
  const out: string[] = [];
  let cur: Element | null = el;
  while (cur) {
    const cls = normalizeClass(cur.getAttribute('class'));
    out.push(cls ? `${cur.tagName.toLowerCase()}.${cls}` : cur.tagName.toLowerCase());
    cur = cur.parentElement;
  }
  return out;
}
/** 给元素打一个不可见的身份标记（属性上不出现，纯 JS 侧） */
let identitySeq = 0;
function markIdentity(el: Element): string {
  identitySeq += 1;
  const id = `smoke-${identitySeq}`;
  (el as unknown as Record<string, unknown>).__smokeIdentity = id;
  return id;
}
const identityOf = (el: Element | null): string | undefined =>
  el ? ((el as unknown as Record<string, unknown>).__smokeIdentity as string | undefined) : undefined;

/** 点一个按钮（jsdom + React 17+ 的点击要走 MouseEvent） */
function click(el: Element | null, label: string): void {
  assert.ok(el, `找不到可点的元素：${label}`);
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

// ---------------------------------------------------------------------------
// 6. 开跑
// ---------------------------------------------------------------------------
const root = createRoot(doc.getElementById('root') as HTMLElement);
await act(async () => {
  root.render(React.createElement(App));
});
await flush();

log('');
log('=== M0 · 冒烟网：三列 + webview 宿主 + 祖先链/节点身份 ===');
log('');

log('--- ① 外壳三列 ---');
await check('左侧栏（aside.sidebar）在', () => {
  assert.ok(q('aside.sidebar'), 'aside.sidebar 不见了');
});
await check('中列（main.middle）在，且它不是整页唯一内容', () => {
  assert.ok(q('main.middle'), 'main.middle 不见了');
});
await check('右列聊天区（.chat）+ 输入条（.inputBar）都在，且都属于 main.middle', () => {
  const chat = q('.chat');
  const bar = q('.inputBar');
  assert.ok(chat, '.chat 不见了');
  assert.ok(bar, '.inputBar 不见了');
  const middle = q('main.middle') as Element;
  assert.ok(middle.contains(chat as Node), '.chat 不在 main.middle 里');
  assert.ok(middle.contains(bar as Node), '.inputBar 不在 main.middle 里');
});
await check('已经越过登录页（不是停在 AuthScreen）', () => {
  assert.ok(!q('.authWrap'), '还停在登录页 —— 说明 /auth/me 没走通');
  assert.ok(requestedPaths.includes('/auth/me'), '根本没请求 /auth/me');
});

log('');
log('--- ② 初始不应有浏览器层（路径 ① 的前置条件）---');
await check('还没有开页时，.browserLayer 不存在', () => {
  assert.ok(q('.browserLayer') === null, `.browserLayer 凭空出现了（class=${q('.browserLayer')?.getAttribute('class')}）`);
});
await check('桥上已经注册了 open / opentab 订阅（主进程开页的唯一入口）', () => {
  assert.ok(handlers.has('open'), '没有注册 open 处理函数');
  assert.ok(handlers.has('opentab'), '没有注册 opentab 处理函数');
});

log('');
log('--- ③ 走真实路径开一张页（主进程 open 事件）---');
const PAGE_URL = 'https://example.com/';
let opened = 0;
await act(async () => {
  opened = emitBridge('open', PAGE_URL);
  await new Promise((resolve) => setTimeout(resolve, 0));
});
await check('open 事件被 App 接住并开出页', () => {
  assert.equal(opened, 1, 'bridge.on("open") 没注册处理函数');
});
await check('.browserLayer 出现，且它是 main.middle 的孩子', async () => {
  await waitFor('.browserLayer 出现', () => q('.browserLayer') !== null);
  const layer = q('.browserLayer') as Element;
  assert.equal(layer.parentElement?.tagName.toLowerCase(), 'main', `.browserLayer 的父节点不是 main（是 ${layer.parentElement?.tagName}）`);
});
await check('BrowserPanel 与 ComputerVisibility 都在浏览器层里，且互为**兄弟**', () => {
  const layer = q('.browserLayer') as Element;
  const panel = layer.querySelector('.browserPanel');
  const vis = layer.querySelector('.computerVisibility');
  assert.ok(panel, '.browserPanel 不在浏览器层里');
  assert.ok(vis, '.computerVisibility 不在浏览器层里');
  // ★ 不要用 assert.equal(a, b) 传 DOM 元素：失败时 Node 会 inspect 整个 jsdom 元素图，
  //   环形 + 巨大 → 进程被 OOM 杀掉（退出码 137），于是「该红的注入」变成「整条网崩掉」。
  //   这个坑是 反证脚本 R1 抓出来的（见报告 §13）。
  assert.ok(
    panel!.parentElement === vis!.parentElement,
    `两者不再是兄弟：panel 的父是 ${panel!.parentElement?.getAttribute('class')}，可见度组件的父是 ${vis!.parentElement?.getAttribute('class')}`,
  );
});
await check('webview 宿主（.browserPanel__stage）里真的有一个 <webview>', async () => {
  await waitFor('<webview> 出现', () => q('webview') !== null);
  const wv = q('webview') as Element;
  const stage = q('.browserPanel__stage') as Element;
  assert.ok(stage.contains(wv), '<webview> 不在舞台里');
});

log('');
log('--- ④ 祖先链 golden（逐字节）---');
const wvEl = q('webview') as Element;
const chainNow = ancestorChain(wvEl);
log(`  当前链（由内到外）：${chainNow.join('  ←  ')}`);
await check('祖先链与 golden 一致', () => {
  const rel = 'docs/acceptance/app-shell/webview-ancestor-chain.golden.json';
  /**
   * ★ 只有显式 `--update-golden` 才写。
   *   绝不能「文件不在就自动写」—— 那样任何一次误改结构都会**顺手把 golden 改成错的**，
   *   反证脚本（app-shell-smoke-revert.py）更是会全绿通过，等于没网。
   */
  if (UPDATE_GOLDEN) {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, JSON.stringify({ note: 'M0 冒烟网：<webview> 的祖先链 golden。除三条有意卸载路径外必须逐字节不变。BEM 修饰符（--bg/--embed/--off）不算结构，已归一化。', chain: chainNow }, null, 2) + '\n', 'utf8');
    log(`    （已按 --update-golden 重写 golden：${rel}）`);
    return;
  }
  assert.ok(existsSync(GOLDEN), `golden 文件不存在：${rel}（首次生成请显式跑 npm run verify:shell -- --update-golden）`);
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { chain: string[] };
  assert.deepEqual(chainNow, golden.chain, `祖先链变了！golden=${golden.chain.join(' ← ')} 现在=${chainNow.join(' ← ')}`);
});

log('');
log('--- ⑤ 节点身份：切档 / 切视图 / 切智能体，都不许换元素 ---');
const identity = markIdentity(wvEl);
const baselineChain = ancestorChain(wvEl);
const assertSameNode = (what: string): void => {
  /**
   * ★ 用**元素对象本身**判断，不用 querySelector('webview')：
   *   后者只会拿到文档里第一个 webview —— 期间若又开了一张新页（例如顶栏「🌐 浏览器」
   *   在没有标签页时会顺手开一张），第一个可能就是别人了，那是**假红**。
   *   这里要的是：「我标记的那个元素，还在不在 DOM 里」。
   */
  assert.ok(doc.contains(wvEl), `${what} 之后原来那个 <webview> 已经不在文档里（被卸载重建）`);
  const el = wvEl;
  assert.equal(identityOf(el), identity, `${what} 之后 <webview> 换成了新元素（老元素被卸载重建）`);
  const now = ancestorChain(el as Element);
  assert.ok(
    JSON.stringify(now) === JSON.stringify(baselineChain),
    `${what} 之后祖先链变了：\n        golden=${baselineChain.join(' ← ')}\n        现在 =${now.join(' ← ')}`,
  );
};

await check('切可见度档位（status → preview → takeover ×3）不换 webview 元素', async () => {
  const btns = qa('.computerVisibility__actions button');
  assert.equal(btns.length, 3, `档位按钮不是 3 个（${btns.length} 个）`);
  for (const b of btns) {
    await act(async () => {
      click(b, '可见度档位');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush(2);
    assertSameNode('切可见度档位');
  }
});
await check('切浏览器视图（全屏 ↔ 后台）不换 webview 元素', async () => {
  /**
   * 先切回「有页的那个智能体」：顶栏「🌐 浏览器」在**当前智能体没有标签页**时会顺手
   * `openNewTab()`，那会往舞台上再挂一张页，让后面「关光所有页」那一段变得不干净。
   */
  await act(async () => {
    click(qa('aside.sidebar .contact')[0], '切回第一个智能体');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await flush(2);
  // 只看「对话 / 浏览器」两颗（顶栏还可能有「编辑人设」等按钮，点它们会开弹窗，与视图无关）
  const btns = qa('.workbenchNav__btn').filter((b) => /对话|浏览器/.test(b.textContent ?? ''));
  assert.equal(btns.length, 2, `顶栏视图按钮不是 2 颗（${btns.length} 颗）`);
  let viewChanges = 0;
  for (const b of btns) {
    await act(async () => {
      click(b, '顶栏模式切换');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush(2);
    assertSameNode('切顶栏模式');
    viewChanges += 1;
  }
  assert.equal(viewChanges, 2, '两颗视图按钮没有都点到');
  // 真的切过：层上必须出现过文档化的三态 class（不然这段是空动作，断言等于没写）
  const seen = q('.browserLayer')?.getAttribute('class') ?? '';
  assert.ok(/browserLayer/.test(seen), `层的 class 读不到：${seen}`);
});
await check('视图切换前后，.browserLayer 的 class 始终在文档化的三态里', () => {
  const ALLOWED = new Set(['browserLayer', 'browserLayer browserLayer--bg', 'browserLayer browserLayer--embed']);
  const cls = q('.browserLayer')?.getAttribute('class') ?? '';
  assert.ok(ALLOWED.has(cls), `出现了计划外的层 class：${JSON.stringify(cls)}（要么改了可见度机制，要么在层上加样式捷径）`);
});

await check('切智能体（换一个人）不换 webview 元素', async () => {
  const contacts = qa('aside.sidebar .contact');
  assert.ok(contacts.length >= 2, `左栏智能体不足 2 个（${contacts.length} 个）`);
  for (const c of contacts) {
    await act(async () => {
      click(c, '智能体行');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush(2);
    assertSameNode('切智能体');
  }
});

log('');
log('--- ⑥ 路径 ①（有意卸载）：关光所有页 → 必须卸载 ---');
await check('关掉最后一张页后，.browserLayer 与 <webview> 一起消失', async () => {
  // 上一段把当前智能体切走了（那张页属于第一个智能体），先切回去 —— 顶栏只列当前智能体的 tab
  const first = qa('aside.sidebar .contact')[0];
  await act(async () => {
    click(first, '切回第一个智能体');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await flush(3);
  const closeBtns = qa('.browserTab__x');
  assert.ok(closeBtns.length >= 1, '没有关页按钮（browserTab__x）');
  for (const b of closeBtns) {
    await act(async () => {
      click(b, '关页');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush(2);
  }
  await waitFor('浏览器层消失', () => q('.browserLayer') === null && q('webview') === null);
  assert.ok(q('webview') === null, `<webview> 应该随最后一张页一起卸载（还有 ${qa('webview').length} 个）`);
});

log('');
log('--- ⑦ 样式红线：宿主与舞台不许被 display:none / 尺寸归零 ---');
await check('styles.css 里 .browserLayer / .browserPanel__stage 没有 display:none / 0 尺寸', () => {
  const css = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'styles.css'), 'utf8');
  const browser = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'browser', 'styles.css'), 'utf8');
  const stripped = (css + browser).replace(/\/\*[\s\S]*?\*\//g, '').replace(/min-height\s*:\s*0/g, '');
  for (const sel of ['.browserLayer', '.browserPanel__stage', '.browserPanel']) {
    // ★ 用 (?![-\w]) 而不是 \b：`\b` 在 `-` 前也成立，会把 `.browserLayer--embed .driveBar{display:none}`
    //   当成 `.browserLayer` 自己的规则（第一次跑就误报了）
    const re = new RegExp('\\' + sel + '(?![-\\w])[^{}]*\\{([^}]*)\\}', 'g');
    for (const m of stripped.matchAll(re)) {
      const body = m[1];
      assert.ok(!/display\s*:\s*none/.test(body), `${sel} 里出现了 display:none`);
      assert.ok(!/(?<!min-)height\s*:\s*0/.test(body), `${sel} 里出现了 height:0`);
      assert.ok(!/(?<!min-)width\s*:\s*0/.test(body), `${sel} 里出现了 width:0`);
    }
  }
  // 内联样式这条 CSS 文件里查不到，单独查一次
  const layerEl = q('.browserLayer') as HTMLElement | null;
  if (layerEl) {
    const inline = layerEl.getAttribute('style') ?? '';
    assert.ok(!/display\s*:\s*none/.test(inline), `.browserLayer 上出现了内联 display:none：${inline}`);
    assert.ok(!/(?<!min-)height\s*:\s*0/.test(inline), `.browserLayer 上出现了内联 height:0：${inline}`);
  }
});

log('');
log('=== 结论 ===');
log(`  ${passes} PASS / ${fails} FAIL`);
log(`  （启动期间打到后端的接口 ${requestedPaths.length} 个；桥调用 ${bridgeCalls.length} 次）`);
if (fails > 0) process.exitCode = 1;

await act(async () => root.unmount());
