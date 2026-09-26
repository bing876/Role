/**
 * 批次 M · M0 冒烟网 —— **真正跑起来的那一半**。
 *
 * 由 `scripts/verify/app-shell-smoke.mts` 用 esbuild 打包后执行
 * （要加载 `.tsx` 与 CSS 导入；CSS 由 driver 置空）。
 *
 * 这一层要挡住的是**结构性事故**，不是像素：M1'–M8' 会把 3714 行的 App.tsx 拆成
 * 外壳 + 7 个 feature，任何一次「顺手加个 wrapper」「把面板挪进条件渲染」都可能把
 * **页宿主**从它原来的父节点上摘下来 —— 而 `browser/` 里的驾驶坐标全部来自
 * 页内 `getBoundingClientRect`，**宿主一被卸载重建，正在跑的那张页当场没了、点击坐标全废**
 * （收尾 7 的 `.browserLayer--bg` 注释与 `panel-visibility-coupling-probe.py` 都在守这条）。
 *
 * 所以本脚本用 **jsdom 挂载整个 `<App/>`**（不是抄一份组件、不是只渲染 BrowserPanel），
 * 走**真实路径**把一张页开出来（主进程 `open` 事件 → `browser.openFromMain` → `openUrl`），
 * 然后钉两件事：
 *   ① **祖先链 golden**：页宿主（`.browserPanel__view`）到 `html` 的每一层 `tag.className` 逐字节一致；
 *   ② **节点身份**：切换可见度档位 / 切换浏览器视图 / 切换智能体之后，
 *      **还是同一个 DOM 元素对象**（不是「长得一样的新元素」）。
 *
 * ADR-0002（页宿主 `<webview>` → 主进程托管的 WebContentsView）之后，本网额外钉：
 *   ③ **宿主生命周期**：开页 → create 被调（projectId/url 对）；切后台/隐藏 →
 *      只发 `visible:false`，**绝不调 close**（隐藏≠卸载）；关光所有页 → close 被调、宿主消失；
 *   ④ **几何通道**：`view-rect` 有发送（含 embed 的 clip 收缩口径）；`pageinfo` 事件
 *      能把标题/地址带回标签（宿主换原生视图后没有 DOM 元素事件了）。
 *
 * ⚠️ 硬规则的准确表述（见 批次M 侦查报告 §4.2）：**除了三条有意路径**——
 *   ① `allTabs` 归零（关光所有页）、② 该页进入**深休眠**、③ `key={t.id}` 变化——
 *    之外，祖先链与节点身份必须逐字节不变。**写成「宿主永远不卸载」是错的**，
 *    按那种写法测会在这三条上假红。本脚本对路径 ① 是**正向断言**（关光页就必须卸载）。
 *
 * 用法（一般由 npm script 调）：
 *   npm run verify:shell
 *   npm run verify:shell -- --update-golden     # 只在你确认链变更是有意的时候用
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

/**
 * ★ 仓库根**不能**从 `import.meta.url` 推：本文件会被 esbuild 打进
 *   `node_modules/.cache/app-shell-smoke/ui-test.mjs` 再执行，那时
 *   `import.meta.url` 指向缓存目录（第一次跑就把 golden 写进了 node_modules/docs/…）。
 *   由 driver 通过环境变量传进来，兜底才用 cwd。
 */
const REPO = process.env.SMOKE_REPO ?? process.cwd();
const LEGACY_STYLES = join(REPO, 'apps', 'desktop', 'src', 'styles.css');
// M9'：styles.css 已整体删除 —— 「旧规则消失」升级为「文件本身消失」（null = 已删,在场 = 回归）
const legacyStyles = (): string | null => (existsSync(LEGACY_STYLES) ? readFileSync(LEGACY_STYLES, 'utf8') : null);
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
/**
 * ADR-0002：页宿主族（`<webview>` → 主进程托管的 WebContentsView）的桩 ——
 * create 回**真 wcId**（计数），其余记调用。断言就查这几份流水。
 */
const viewCreateLog: { tabKey: number; projectId: number | null; url: string; wcId: number }[] = [];
const viewRectLog: { tabKey: number; rect: { x: number; y: number; width: number; height: number }; visible: boolean }[] = [];
const viewOrderLog: number[] = [];
const viewCloseLog: number[] = [];
const viewNavigateLog: { tabKey: number; url: string }[] = [];
const viewFocusLog: number[] = [];
let wcIdSeq = 0;
/**
 * ★ 只给「create 回执晚于关页」那条竞态断言用：默认 0 = 立刻回执（不影响其它 56 条断言）。
 *   设成 >0 才能构造出「关页先到、create 后到」的时序。
 */
let viewCreateDelayMs = 0;
const bridge = new Proxy(
  {
    isElectron: false,
    apiBase: () => '',
    token: () => null,
    /**
     * ★ 被**直接 await / .then** 的桥方法必须给真值，不能交给 Proxy 的兜底空实现：
     *   `bridge.getSettings().then(setSettings)` 返回 undefined 会把 settings 置空，
     *   下一次渲染读 settings.maxConcurrentAgentTasks 当场崩（第一次跑就是这么崩的）。
     *   值抄自 shared/settings.ts 的 SETTINGS_FALLBACK（M8' 从 App.tsx 搬走；主进程是权威，这里是首帧兜底）。
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
    // ---- ADR-0002：页宿主族 —— 必须给**真值**（hostMounted 会 await create 的回执拿 wcId）----
    browserViewCreate: (req: { tabKey: number; projectId: number | null; url: string }) => {
      wcIdSeq += 1;
      viewCreateLog.push({ ...req, wcId: wcIdSeq });
      const reply = { wcId: wcIdSeq };
      // 默认立刻回执；只有竞态断言把 viewCreateDelayMs 调大（见那里的注释）
      return viewCreateDelayMs > 0
        ? new Promise<{ wcId: number }>((resolve) => setTimeout(() => resolve(reply), viewCreateDelayMs))
        : Promise.resolve(reply);
    },
    browserViewRect: (req: { tabKey: number; rect: { x: number; y: number; width: number; height: number }; visible: boolean }) => {
      viewRectLog.push(req);
    },
    browserViewOrder: (tabKey: number) => {
      viewOrderLog.push(tabKey);
    },
    browserViewNavigate: (req: { tabKey: number; url: string }) => {
      viewNavigateLog.push(req);
      return Promise.resolve({ ok: true });
    },
    browserViewFocus: (tabKey: number) => {
      viewFocusLog.push(tabKey);
    },
    browserViewClose: (tabKey: number) => {
      viewCloseLog.push(tabKey);
    },
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
let agentCreateCount = 0;   // 真创建桩:⑨-4 / ⑩-4 各建一个,id 不撞
const PROJECT = { id: 7, name: '默认项目', isCurrent: true, isDefault: true, henAgentId: null };
const AGENTS = [
  { id: 97, name: '小助', kind: 'assistant', deletable: false, canCreateAgents: true, projectId: 7, personaStatus: 'ready', persona: null, conversationId: 501, status: 'idle' },
  { id: 98, name: '卡布', kind: 'worker', deletable: true, projectId: 7, personaStatus: 'ready', persona: null, conversationId: 502, status: 'idle' },
];
const STATE = {
  conversationId: 501, current_task: '', latest_user_intent: '', browser_confirmed: false,
  login_required: false, sensitive_action: false, last_page_summary: '', already_told_user_login_themselves: false, keepalive: false,
};
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const path = raw.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  requestedPaths.push(path);
  if (path === '/auth/me') return json({ user: { id: 1, phone: '13800000000', xyz: '' }, project: PROJECT, agents: [{ id: 97, name: '小助' }] });
  if (path === '/projects') return json({ projects: [PROJECT], currentProjectId: 7 });
  if (path === '/agents' && init?.method === 'POST') {
    agentCreateCount += 1;
    const nid = 98 + agentCreateCount;   // 第 1 次 → 99,第 2 次 → 100
    return json({ agent: { id: nid, name: agentCreateCount === 1 ? '新员' : '新员乙', kind: 'worker', deletable: true, canCreateAgents: false, projectId: 7, personaStatus: 'pending', persona: null, conversationId: 500 + nid, status: 'idle' } });
  }
  if (path === '/agents') return json({ agents: AGENTS });
  // 批次 M-4' ⑪-2 / M-5' ⑫-2:真发送走 useChat 的 /chat/stream（SSE；帧格式与服务端一字不差）。
  // 先推一帧 search:start,250ms 后才推 delta + search:done + done ——
  // 让「正在搜索：…」那行提示在流式中真实可见（⑫-2 的判据）。
  if (path === '/chat/stream') {
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('event: search\ndata: {"phase":"start","query":"天气"}\n\n'));
          setTimeout(() => {
            c.enqueue(enc.encode('data: {"delta":"收到你的招呼，我待命中。"}\n\n'));
            c.enqueue(enc.encode('event: search\ndata: {"phase":"done","query":"天气","results":2}\n\n'));
            c.enqueue(enc.encode('event: done\ndata: {"sources": []}\n\n'));
            c.close();
          }, 250);
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }
  // 批次 M-4' ⑪-3:「结束」钮的真处理（把这段聊天总结进两层记忆）
  if (/^\/agents\/\d+\/tidy$/.test(path) && init?.method === 'POST') {
    return json({ userAdded: 0, projectAdded: 0 });
  }
  if (path === '/chat/state') return json({ conversationId: 501, state: STATE });
  // 批次 M-2:第四列触发①需要会话内链接 → 给当前智能体的历史一条带 sources 的助手消息
  if (path === '/chat/history') return json({ conversationId: 501, messages: [
    { id: 5011, role: 'assistant', text: '这是从网页查到的回答。', sources: [{ title: '示例文章', url: 'https://example.com/article', domain: 'example.com' }] },
  ] });
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
 * 页宿主（`.browserPanel__view`，ADR-0002 前是 `<webview>`）→ 根：每一层的 `tag.块与元素名`。
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
log('=== M0 · 冒烟网：三列 + 页宿主（.browserPanel__view）+ 祖先链/节点身份/宿主生命周期 ===');
log('');

log('--- ① 外壳三列 ---');
await check('左侧栏（aside.sidebar）在', () => {
  assert.ok(q('aside.sidebar'), 'aside.sidebar 不见了');
});
await check('中列（main.middle）在，且它不是整页唯一内容', () => {
  assert.ok(q('main.middle'), 'main.middle 不见了');
});
await check('右列聊天区（.chat）+ 输入条（.inputbar）都在，且都属于 main.middle', () => {
  const chat = q('.chat');
  const bar = q('.inputbar');
  assert.ok(chat, '.chat 不见了');
  assert.ok(bar, '.inputbar 不见了');
  const middle = q('main.middle') as Element;
  assert.ok(middle.contains(chat as Node), '.chat 不在 main.middle 里');
  assert.ok(middle.contains(bar as Node), '.inputbar 不在 main.middle 里');
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
await check('ADR-0002：桥上已经注册了 pageinfo 订阅（宿主换原生视图后，标题/地址改由主进程推）', () => {
  assert.ok(handlers.has('pageinfo'), '没有注册 pageinfo 处理函数（页标题/地址回不来）');
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
await check('.browserLayer 出现，且它是 div.app 的孩子（第四列，与 main 并列）', async () => {
  await waitFor('.browserLayer 出现', () => q('.browserLayer') !== null);
  const layer = q('.browserLayer') as Element;
  const parent = layer.parentElement;
  assert.ok(parent, '.browserLayer 没有父节点');
  assert.ok(
    parent!.getAttribute('class')?.includes('app') ?? false,
    `.browserLayer 的父节点不是 div.app（是 ${parent!.tagName}.${parent!.getAttribute('class')}）—— 第四列必须挂在外壳根上`,
  );
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
await check('页宿主（.browserPanel__stage 里）真的有一个 .browserPanel__view（ADR-0002 占位 div）', async () => {
  await waitFor('.browserPanel__view 出现', () => q('.browserPanel__view') !== null);
  const wv = q('.browserPanel__view') as Element;
  const stage = q('.browserPanel__stage') as Element;
  assert.ok(stage.contains(wv), '.browserPanel__view 不在舞台里');
  assert.equal(wv.tagName, 'DIV', `宿主应该是占位 div，现在是 <${wv.tagName.toLowerCase()}>`);
});
await check('ADR-0002 ③：开页走了真 create（projectId + 当前 url 对得上，回真 wcId）', async () => {
  await waitFor('view-create 被调', () => viewCreateLog.length >= 1);
  const c = viewCreateLog[0];
  assert.ok(Number.isInteger(c.tabKey) && c.tabKey >= 0, `create 的 tabKey 非法：${JSON.stringify(c)}`);
  assert.equal(c.projectId, PROJECT.id, `create 的 projectId 不对（应是开页那一刻的项目 ${PROJECT.id}）：${JSON.stringify(c)}`);
  assert.ok(c.url.startsWith('https://'), `create 的 url 不是 http(s)：${c.url}`);
  assert.ok(Number.isInteger(c.wcId) && c.wcId >= 0, `create 没回真 wcId：${JSON.stringify(c)}`);
});
await check('ADR-0002 ④ / ADR-0005：几何通道通了（view-rect 有发送；主进程 open = 要给人看 ⇒ 列必须可见）', async () => {
  const c = viewCreateLog[0];
  await waitFor('当前页的 rect', () => viewRectLog.some((r) => r.tabKey === c.tabKey));
  /*
   * ★ 口径修正（2026-09-26，ADR-0005 决定 4）：
   *   旧断言写的是「'open' 事件 = 后台开页（层必须 --hidden、视图必须 visible=false）」，
   *   但那与生产码矛盾 —— `openFromMain` → `openUrl` 里**显式** `setView('fullscreen')`
   *   （`openUrl` 自己的注释：「调用方都是『用户明确要看浏览器』」）。
   *   按「改标准 = 改断言」纪律，这里改成与代码实际语义一致的新口径：
   *   **主进程 open 也是「要给人看」⇒ 列打开、视图露脸**；同时保留「不许销毁」的老红线。
   */
  const forTab = viewRectLog.filter((r) => r.tabKey === c.tabKey);
  assert.ok(forTab.length >= 1, '当前页一张 rect 都没发');
  assert.ok(!viewCloseLog.includes(c.tabKey), '主进程 open 却调了 view-close（视图被销毁了）');
  const layerCls = (q('.browserLayer') as Element | null)?.getAttribute('class') ?? '';
  assert.ok(!layerCls.includes('browserLayer--hidden'), `主进程 open 后列必须可见（ADR-0005）：${layerCls}`);
  await waitFor('当前页 visible=true 的 rect', () => viewRectLog.some((r) => r.tabKey === c.tabKey && r.visible === true), 8);
  const last = [...forTab].reverse().find((r) => r.visible === true) ?? forTab[forTab.length - 1];
  assert.equal(last.visible, true, `主进程 open 后视图必须露脸（visible=${last.visible}）`);
});
await check('ADR-0002 ④：pageinfo 事件能把标题带回标签（宿主换原生视图后没有 DOM 元素事件了）', async () => {
  const c = viewCreateLog[0];
  // create 回执落地后 hostMounted 会立刻报 owner —— 用它当「wcId 已登记」的证据，
  // 否则 pageinfo 按 wcId 换 tabId 会落空（假红）
  await waitFor('create 回执 + owner 登记', () => bridgeCalls.some((k) => k.startsWith('browserOwner(')));
  const before = q('.browserTab__label')?.textContent ?? '';
  let delivered = 0;
  await act(async () => {
    delivered = emitBridge('pageinfo', JSON.stringify({ wcId: c.wcId, title: '冒烟页标题' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await flush(2);
  assert.equal(delivered, 1, 'pageinfo 事件没有处理函数接住');
  const after = q('.browserTab__label')?.textContent ?? '';
  assert.ok(after.includes('冒烟页标题'), `标签没跟着 pageinfo 更新（before=${before} after=${after}）`);
});

log('');
log('--- ④ 祖先链 golden（逐字节）---');
/** ADR-0002：宿主换占位 div 后，golden 首节点由 `webview.browserPanel__view` 变 `div.browserPanel__view`（有意变更，--update-golden 重画） */
const wvEl = q('.browserPanel__view') as Element;
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
    writeFileSync(GOLDEN, JSON.stringify({ note: 'M0 冒烟网：页宿主（.browserPanel__view；ADR-0002 前是 <webview>，同 class 占位 div）的祖先链 golden。除三条有意卸载路径外必须逐字节不变。BEM 修饰符（--bg/--embed/--off）不算结构，已归一化。', chain: chainNow }, null, 2) + '\n', 'utf8');
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
   * ★ 用**元素对象本身**判断，不用 querySelector('.browserPanel__view')：
   *   后者只会拿到文档里第一个宿主 div —— 期间若又开了一张新页（例如顶栏「🌐 浏览器」
   *   在没有标签页时会顺手开一张），第一个可能就是别人了，那是**假红**。
   *   这里要的是：「我标记的那个元素，还在不在 DOM 里」。
   */
  assert.ok(doc.contains(wvEl), `${what} 之后原来那个页宿主已经不在文档里（被卸载重建）`);
  const el = wvEl;
  assert.equal(identityOf(el), identity, `${what} 之后页宿主换成了新元素（老元素被卸载重建）`);
  const now = ancestorChain(el as Element);
  assert.ok(
    JSON.stringify(now) === JSON.stringify(baselineChain),
    `${what} 之后祖先链变了：\n        golden=${baselineChain.join(' ← ')}\n        现在 =${now.join(' ← ')}`,
  );
};

await check('切可见度档位（status → preview → takeover ×3）不换宿主元素', async () => {
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
await check('切浏览器视图（全屏 ↔ 后台）不换宿主元素', async () => {
  /**
   * 先切回「有页的那个智能体」：顶栏「🌐 浏览器」在**当前智能体没有标签页**时会顺手
   * `openNewTab()`，那会往舞台上再挂一张页，让后面「关光所有页」那一段变得不干净。
   */
  await act(async () => {
    click(qa('aside.sidebar .contact-item')[0], '切回第一个智能体');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await flush(2);
  // M3':视图开关迁到第一列 rail 的两颗 tab（与旧顶栏按钮同源）
  const btns = [q('.tab--chat'), q('.tab--browser')].filter((b): b is Element => b !== null);
  assert.equal(btns.length, 2, `rail 视图 tab 不是 2 颗（${btns.length} 颗）`);
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
await check('视图切换前后，.browserLayer 的 class 始终在文档化的形态里', () => {
  // 批次 M-2:三形态 隐藏/第四列/覆盖 + 正交的 embed + 拖动态 —— 全部是有文档的修饰符
  const ALLOWED_TOKENS = new Set(['browserLayer', 'browserLayer--hidden', 'browserLayer--overlay', 'browserLayer--dragging', 'browserLayer--embed']);
  const cls = (q('.browserLayer')?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  assert.ok(cls.length >= 1 && cls[0] === 'browserLayer', `层 class 必须以 browserLayer 开头：${JSON.stringify(cls)}`);
  for (const t of cls) {
    assert.ok(ALLOWED_TOKENS.has(t), `出现了计划外的层 class token：${JSON.stringify(t)}（要么改了可见度机制，要么在层上加样式捷径）`);
  }
});

await check('切智能体（换一个人）不换宿主元素', async () => {
  const contacts = qa('aside.sidebar .contact-item');
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
log('--- ⑧ 第四列（批次 M-2）：过阈值变覆盖 / 收回 / 隐藏≠卸载 / 会话内链接触发 / 记忆宽度 ---');

const firePointer = (el: Element | null, type: string, x: number): void => {
  assert.ok(el, `拖动手柄不见了（${type}）`);
  el!.dispatchEvent(new dom.window.PointerEvent(type, { bubbles: true, cancelable: true, clientX: x }));
};

await check('⑧-1 第四列可见时,左缘有拖动手柄', () => {
  assert.ok(q('.browserCol__resizer'), '第四列可见但 .browserCol__resizer 不在');
});

await check('⑧-2 向左连续拖宽、过阈值 → 覆盖形态（盖聊天、聊天列不让位、宿主同一元素）', async () => {
  const before = q('.browserPanel__view') as Element;
  await act(async () => {
    firePointer(q('.browserCol__resizer'), 'pointerdown', 500);
    firePointer(q('.browserCol__resizer'), 'pointermove', 100); // 420 + 400 = 820 → 夹到 640 ≥ 阈值 480
    firePointer(q('.browserCol__resizer'), 'pointerup', 100);
  });
  await flush(2);
  const l = q('.browserLayer') as Element;
  const cls = l.getAttribute('class') ?? '';
  assert.ok(cls.includes('browserLayer--overlay'), `拖过阈值应进覆盖形态：${cls}`);
  const appCls = (q('div.app') as Element).getAttribute('class') ?? '';
  assert.ok(!appCls.includes('app--col'), `覆盖形态下聊天列不该让位（应全宽被盖）：${appCls}`);
  assert.ok(before === q('.browserPanel__view'), '拖宽把页宿主换成了新元素');
});

await check('⑧-3 向右收回（回阈值以下）→ 第四列形态,聊天列让位回来', async () => {
  const before = q('.browserPanel__view') as Element;
  await act(async () => {
    firePointer(q('.browserCol__resizer'), 'pointerdown', 100);
    firePointer(q('.browserCol__resizer'), 'pointermove', 400); // 640 - 300 = 340 ≥ MIN 320、< 阈值 480
    firePointer(q('.browserCol__resizer'), 'pointerup', 400);
  });
  await flush(2);
  const cls = (q('.browserLayer') as Element).getAttribute('class') ?? '';
  assert.ok(!cls.includes('browserLayer--overlay'), `收回后不该还是覆盖：${cls}`);
  assert.ok(!cls.includes('browserLayer--hidden'), `收回后应在第四列形态：${cls}`);
  const appCls = (q('div.app') as Element).getAttribute('class') ?? '';
  assert.ok(appCls.includes('app--col'), `第四列形态下聊天列应让位（app--col 缺失）：${appCls}`);
  assert.ok(before === q('.browserPanel__view'), '收回把页宿主换成了新元素');
});

await check('⑧-4 「💬 对话」→ 隐藏形态:页宿主仍挂着（隐藏≠卸载,且没调 view-close）;「🌐 启用」→ 列回来', async () => {
  // ⑤ 的「切智能体」循环停在最后一位（卡布,没页）—— 先切回有页的小助，
  // 否则「当前页该露脸」无从谈起（别家的页露脸才是串了）
  await act(async () => {
    click(qa('aside.sidebar .contact-item')[0], '切回有页的智能体');
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush(2);
  const navBtns = [q('.tab--chat'), q('.tab--browser')].filter((b): b is Element => b !== null);
  await act(async () => {
    click(navBtns[0], '💬 对话');
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush(2);
  const clsHidden = (q('.browserLayer') as Element).getAttribute('class') ?? '';
  assert.ok(clsHidden.includes('browserLayer--hidden'), `「💬 对话」后应进隐藏形态：${clsHidden}`);
  const wv = q('.browserPanel__view') as Element;
  assert.ok(doc.contains(wv), '隐藏形态下页宿主被卸载了（违反 隐藏≠卸载）');
  // ADR-0002 F3：隐藏≠卸载的宿主侧证据 —— 没发 close，且最后一次 rect 是 visible=false（藏起来，不是销毁）
  const c = viewCreateLog[0];
  assert.ok(!viewCloseLog.includes(c.tabKey), `隐藏形态却调了 view-close（tabKey=${c.tabKey}）—— 隐藏不该销毁宿主`);
  const lastRect = [...viewRectLog].reverse().find((r) => r.tabKey === c.tabKey);
  assert.ok(lastRect && lastRect.visible === false, '隐藏形态下当前页的最后一次 rect 不是 visible=false（视图该藏起来）');
  await act(async () => {
    click(navBtns[1], '🌐 启用');
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush(2);
  const clsOpen = (q('.browserLayer') as Element).getAttribute('class') ?? '';
  assert.ok(!clsOpen.includes('browserLayer--hidden'), `「🌐 启用」后列应打开：${clsOpen}`);
  // ADR-0002 F1：列回来 → 当前页露脸（visible=true 的 rect 必须跟上，视图不能一直藏着）
  await waitFor('启用后 visible=true 的 rect', () => viewRectLog.some((r) => r.tabKey === c.tabKey && r.visible === true), 8);
  const lastOpen = [...viewRectLog].reverse().find((r) => r.tabKey === c.tabKey);
  assert.ok(lastOpen && lastOpen.visible === true, '「🌐 启用」后当前页没有 visible=true 的 rect（视图没落位露脸）');
});

/**
 * ★ ADR-0005 回归（2026-09-26 用户报的「浏览器空白」）：**收起列之后，一次「开页」必须把列自动弹回来。**
 *
 * 这正是真机上的病灶路径：用户看过浏览器 → 点「💬 对话」收起 → 在聊天里说「打开抖音」
 * （`useChat` → `browser.openUrl` → `setView('fullscreen')`）→ 旧代码只改 view、没人开列
 * ⇒ 层落进 `--hidden`（transform 移出视野）⇒ **页已创建、已加载，却看不见**。
 * 修法 = App 里那条 `view === 'fullscreen' ⇒ col.openColumn()` 的同步 effect。
 */
await check('⑧-4b（ADR-0005）：收起列后，「开页」必须把列自动弹回来（浏览器空白的回归位）', async () => {
  const navBtns = [q('.tab--chat'), q('.tab--browser')].filter((b): b is Element => b !== null);
  // 前置：先把列收起（用户看完浏览器后的常态）
  await act(async () => {
    click(navBtns[0], '💬 对话');
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush(2);
  assert.ok(
    ((q('.browserLayer') as Element).getAttribute('class') ?? '').includes('browserLayer--hidden'),
    '前置：应先处于隐藏形态',
  );
  // 走真实路径开一张新页（主进程 open → openFromMain → openUrl，与聊天里说「打开XX」同一条）
  await act(async () => {
    emitBridge('open', 'https://www.baidu.com/');
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush(3);
  const cls = (q('.browserLayer') as Element).getAttribute('class') ?? '';
  assert.ok(
    !cls.includes('browserLayer--hidden'),
    `开页之后列必须自动弹回（view=fullscreen ⇒ 列可见，ADR-0005）—— 现在是「${cls}」` +
      `：页会建好、会加载，却因为整层被 transform 移出视野而看不见`,
  );
  // 视图侧跟上：新那张页要有 visible=true 的 rect（否则「列亮了但页还是空」）
  const tabKeys = viewCreateLog.map((x) => x.tabKey);
  const newest = tabKeys[tabKeys.length - 1];
  await waitFor('新页 visible=true 的 rect', () => viewRectLog.some((r) => r.tabKey === newest && r.visible === true), 8);
});

await check('⑧-5 触发①:点会话内链接（来源）→ 列从隐藏弹出（内嵌浏览器打开）', async () => {
  const navBtns = [q('.tab--chat'), q('.tab--browser')].filter((b): b is Element => b !== null);
  await act(async () => {
    click(navBtns[0], '💬 对话');
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush(2);
  assert.ok(((q('.browserLayer') as Element).getAttribute('class') ?? '').includes('browserLayer--hidden'), '前置:应先隐藏');
  const link = q('.sources__item') as Element;
  assert.ok(link, '会话内来源链接不在（/chat/history 夹具没生效?）');
  await act(async () => {
    click(link, '会话内链接');
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush(3);
  const cls = (q('.browserLayer') as Element).getAttribute('class') ?? '';
  assert.ok(!cls.includes('browserLayer--hidden'), `点链接后列应弹出：${cls}`);
});

await check('⑧-6 宽度记忆上次值（localStorage workbench.browserCol 有合法宽度）', () => {
  const raw = dom.window.localStorage.getItem('workbench.browserCol');
  assert.ok(raw !== null, 'localStorage 里没有 workbench.browserCol（记忆宽度没落地）');
  const v = Number(raw);
  assert.ok(Number.isFinite(v) && v >= 320, `记忆值不像合法宽度:${raw}`);
});

await check('⑧-7 样式红线:--hidden 规则用 transform 移出视野（不是 display:none）', () => {
  // M9'：第四列规则已搬进 design/14-browser-column.css（旧 styles.css 已删）
  const css = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', '14-browser-column.css'), 'utf8');
  const m = css.match(/\.browserLayer--hidden\s*\{([^}]*)\}/);
  assert.ok(m, '14-browser-column.css 里找不到 .browserLayer--hidden 规则');
  assert.ok(/transform\s*:\s*translateX/.test(m![1]), '隐藏态必须用 transform 移出视野');
  assert.ok(!/display\s*:\s*none/.test(m![1]), '隐藏态绝不允许 display:none');
});

log('');
log('--- ⑨ 侧栏（批次 M-2）：真数据名单 / 真搜索 / 真创建 / 真拖宽 ---');

const readVar = (name: string): string => {
  const st = q('div.app')?.getAttribute('style') ?? '';
  const m = st.match(new RegExp(`${name}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : '';
};
const setTextInput = async (el: Element | null, value: string, label: string): Promise<void> => {
  assert.ok(el, `找不到输入框：${label}`);
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush(2);
};

await check('⑨-1 屏幕上的是真名单（名字与 id 全部来自桥的真数据，行数一致）', () => {
  const REAL: Record<string, string> = { 97: '小助', 98: '卡布' };
  const rows = qa('.contact-item');
  assert.equal(rows.length, 2, `智能体行应 2 行（实际 ${rows.length}）`);
  for (const r of rows) {
    const id = r.getAttribute('data-agent-id');
    const name = r.querySelector('.contact-name')?.textContent ?? '';
    assert.ok(id !== null && id in REAL, `出现名单外的智能体 id ${id}（写死假数据的信号）`);
    assert.equal(name, REAL[id as string], `行 id=${id} 的名字是「${name}」，与真名单对不上`);
  }
});

await check('⑨-2 真实选择：点哪行 active 落哪行', async () => {
  const row98 = qa('.contact-item').find((r) => r.getAttribute('data-agent-id') === '98') as Element;
  assert.ok(row98, '没有 98 号智能体的行');
  await act(async () => {
    click(row98, '智能体行 98');
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush(2);
  const activeId = q('.contact-item.active')?.getAttribute('data-agent-id') ?? null;
  assert.equal(activeId, '98', 'active 没落到 98 行');
});

await check('⑨-3 搜索是对真名单的实时过滤（打字 → 滤掉；清空 → 回来）', async () => {
  const field = q('.search-field') as Element;
  await setTextInput(field, '卡布', '搜索框');
  const names1 = qa('.contact-item .contact-name').map((n) => n.textContent ?? '');
  assert.deepEqual(names1, ['卡布'], `打「卡布」应只剩卡布：${JSON.stringify(names1)}`);
  await setTextInput(field, 'zzz没有', '搜索框');
  assert.equal(qa('.contact-item').length, 0, '匹配不到的词应是空列表');
  assert.ok((q('.contact-list__empty')?.textContent ?? '').includes('zzz没有'), '空列表没有人话提示');
  await act(async () => {
    click(q('.search-clear'), '清空搜索');
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush(2);
  assert.equal(qa('.contact-item').length, 2, '清空后应恢复全名单');
});

await check('⑨-4 「＋」弹层只有真操作：新建智能体 → 真 POST /agents，行出现且被选中', async () => {
  // G1（2026-09-25,规格 C1 收紧）：「＋ 添加」只在小助（管家）上下文生效 ——
  // 先切到小助（97），＋ 才放行（⑨-2 刚把 active 落在 98 卡布,直接点 ＋ 会被门控拦下）。
  const rowXz = qa('.contact-item').find((r) => r.getAttribute('data-agent-id') === '97') as Element;
  assert.ok(rowXz, '没有小助（97）的行');
  await act(async () => {
    click(rowXz, '切到小助');
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush(2);
  await act(async () => {
    click(q('.add-btn'), '＋ 按钮');
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush(2);
  const popup = q('.add-popup') as Element;
  assert.ok(popup, '＋ 弹层没出现');
  assert.ok(popup.className.includes('open'), `弹层不是 open 态：${popup.className}`);
  const opts = Array.from(popup.querySelectorAll('.opt')).map((o) => o.textContent ?? '');
  assert.ok(opts.some((t) => t.includes('新建智能体')), `弹层里没有「新建智能体」：${JSON.stringify(opts)}`);
  assert.ok(!opts.some((t) => t.includes('占位')), '设计基准的假「占位」动作被搬进来了');
  await act(async () => {
    click(popup.querySelector('.opt')!, '新建智能体');
    await new Promise((r) => setTimeout(r, 0));
  });
  await waitFor('新智能体行 99 出现', () => !!qa('.contact-item').find((r) => r.getAttribute('data-agent-id') === '99'), 60);
  const row99 = qa('.contact-item').find((r) => r.getAttribute('data-agent-id') === '99') as Element;
  assert.ok(row99, '新智能体 99 没出现（POST 没真发 / 桩没接）');
  assert.ok(row99.className.includes('active'), '新智能体应被自动选中（addAgent 既有行为）');
});

await check('⑨-5 分隔条拖宽是真好物：宽度夹在 [220,360] 且写进 localStorage', async () => {
  const sp = q('.splitter') as Element;
  assert.ok(sp, '分隔条 .splitter 不在');
  assert.equal(readVar('--sb-w'), '250px', `初始宽度不是默认 250px：${readVar('--sb-w')}`);
  await act(async () => {
    sp.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100 }));
    sp.dispatchEvent(new dom.window.PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: 160 })); // +60 → 310
    sp.dispatchEvent(new dom.window.PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: 4000 })); // 超界 → 夹到 360
    sp.dispatchEvent(new dom.window.PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: 4000 }));
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush(2);
  assert.equal(readVar('--sb-w'), '360px', `拖超界应夹到 360px：${readVar('--sb-w')}`);
  assert.equal(dom.window.localStorage.getItem('workbench:sb-w'), '360', '宽度没写进 localStorage');
});

await check('⑨-6 分隔条双击复位 250（也写回 localStorage）', async () => {
  const sp = q('.splitter') as Element;
  await act(async () => {
    sp.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush(2);
  assert.equal(readVar('--sb-w'), '250px', `双击后应复位 250px：${readVar('--sb-w')}`);
  assert.equal(dom.window.localStorage.getItem('workbench:sb-w'), '250', '复位值没写回 localStorage');
});

await check('⑨-7 样式红线：第二列常驻（不许 display:none / 宽 0），选中态真 class 在位', () => {
  const design = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', '06-sidebar.css'), 'utf8');
  const m = design.match(/\.sidebar\s*\{([^}]*)\}/);
  assert.ok(m, 'design/06-sidebar.css 里找不到 .sidebar 规则');
  assert.ok(!/display\s*:\s*none/.test(m![1]), '第二列常驻，不许 display:none');
  assert.ok(!/width\s*:\s*0/.test(m![1]), '第二列宽度不许归零');
  assert.ok(/\.contact-item\.active\s*\{/.test(design), '选中态 .contact-item.active 规则缺失');
  const idx = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', 'index.css'), 'utf8');
  assert.ok(idx.includes('./06-sidebar.css') && idx.includes('./08-search.css'), '侧栏/搜索 CSS 没挂进设计入口');
});

log('');
log('--- ⑩ Rail（批次 M-3\'）：第一列玻璃栏 —— 真头像 / 真视图开关 / 真名单 chip / 真新建 ---');

await check('⑩-1 rail 在场,chip 是真名单（个数/名字与第二列一致,选中同步）', () => {
  assert.ok(q('.rail'), '第一列 .rail 不在');
  const chips = qa('.rail .agent-chip');
  const rows = qa('.contact-item');
  assert.equal(chips.length, rows.length, `chip 数(${chips.length}) ≠ 第二列行数(${rows.length})`);
  const rowNames = rows.map((r) => r.querySelector('.contact-name')?.textContent ?? '');
  for (const c of chips) {
    assert.ok(rowNames.includes(c.getAttribute('title') ?? ''), `chip 的 title「${c.getAttribute('title')}」不在真名单里`);
  }
  const selChip = q('.rail .agent-chip.selected');
  assert.ok(selChip, 'rail 没有选中 chip');
  const activeRow = q('.contact-item.active');
  assert.ok(activeRow, '第二列没有 active 行');
  const activeName = activeRow!.querySelector('.contact-name')?.textContent ?? '';
  assert.equal(selChip!.getAttribute('title'), activeName, '选中 chip 与第二列 active 行不是同一个智能体');
});

await check('⑩-2 点 chip 真切换智能体（与第二列 active 行同步）', async () => {
  const chipXiaozhu = qa('.rail .agent-chip').find((c) => c.getAttribute('title') === '小助') as Element;
  assert.ok(chipXiaozhu, '没有「小助」chip');
  await act(async () => {
    click(chipXiaozhu, 'chip 小助');
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush(2);
  const activeId2 = q('.contact-item.active')?.getAttribute('data-agent-id') ?? null;
  assert.equal(activeId2, '97', '点 chip 没把当前智能体切过去');
  const selTitle = q('.rail .agent-chip.selected')?.getAttribute('title') ?? null;
  assert.equal(selTitle, '小助', 'rail 选中态没跟着动');
});

await check('⑩-3 视图开关与旧顶栏同源:「启用」→ 第四列弹出;「对话」→ 隐藏(宿主不卸载)', async () => {
  const layerBefore = q('.browserLayer') as Element;
  assert.ok(layerBefore, '浏览器层不在(前置状态不对?)');
  await act(async () => {
    click(q('.tab--browser'), '🌐 启用 tab');
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush(2);
  const openCls = q('.browserLayer')?.getAttribute('class') ?? '';
  assert.ok(!openCls.includes('browserLayer--hidden'), `点「启用」后第四列应可见: ${openCls}`);
  await act(async () => {
    click(q('.tab--chat'), '💬 对话 tab');
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush(2);
  const hiddenCls = q('.browserLayer')?.getAttribute('class') ?? '';
  assert.ok(hiddenCls.includes('browserLayer--hidden'), `点「对话」后应隐藏: ${hiddenCls}`);
  assert.ok(layerBefore === q('.browserLayer'), '切视图把浏览器层元素换掉了');
});

await check('⑩-4 顶部头像块是真会话数据;快捷 ＋ 是真新建', async () => {
  const ico = q('.rail .menu-btn .user-avatar-ico');
  assert.ok(ico, '头像块的字缺失');
  // 桩账号没有对外号也没有打码手机号 → 按规则回落 'U'(真逻辑,不是假数据)
  assert.equal((ico!.textContent ?? '').trim(), 'U', `头像字不是从真会话数据推出来的: ${ico?.textContent}`);
  const before = qa('.rail .agent-chip').length;
  await act(async () => {
    click(q('.rail .rail-quick-add'), '＋ 快捷创建');
    await new Promise((r) => setTimeout(r, 0));
  });
  await waitFor('新 chip 出现', () => qa('.rail .agent-chip').length === before + 1, 60);
  const newChip = qa('.rail .agent-chip')[before];
  assert.equal(newChip.getAttribute('title'), '新员乙', '快捷创建的 chip 不是真新建的智能体');
});

await check('⑩-5 样式红线:第一列常驻(无 display:none),选中态真 class 在位', () => {
  const rail = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', '07-rail.css'), 'utf8');
  const m = rail.match(/\.rail\s*\{([^}]*)\}/);
  assert.ok(m, 'design/07-rail.css 里找不到 .rail 规则');
  assert.ok(!/display\s*:\s*none/.test(m![1]), '第一列常驻,不许 display:none');
  const railAgent = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', '12-rail-agent.css'), 'utf8');
  assert.ok(/\.agent-chip\.selected\s*\{/.test(railAgent), '选中态 .agent-chip.selected 规则缺失');
  const idx = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', 'index.css'), 'utf8');
  assert.ok(idx.includes('./07-rail.css') && idx.includes('./12-rail-agent.css'), 'rail CSS 没挂进设计入口');
});

log('');
log(`--- ⑪ 输入栏（批次 M-4'）：pill 式输入栏接真会话数据 ---`);
await check('⑪-1 输入栏:placeholder 由真会话推导,data-state 随真输入迁移', async () => {
  const bar = q('.inputbar');
  assert.ok(bar, '缺 .inputbar 输入栏（还是旧 .inputBar?）');
  assert.ok(!q('.inputBar'), '旧 .inputBar 元素还留在 DOM');
  assert.equal(bar.getAttribute('data-state'), 'empty', '空输入时 data-state 应为 empty');
  const field = bar.querySelector('input.inputbar-field');
  assert.ok(field, '缺 .inputbar-field 输入框');
  // ⑩-4 快捷新建后当前智能体 = 刚建出来的「新员乙」→ placeholder 必须含
  // **此刻真当前智能体**的名字（写死「小助」会挂 —— 这正是真数据不是假数据）
  const ph = field.getAttribute('placeholder') ?? '';
  assert.ok(ph.includes('新员乙'), `placeholder 没反映当前智能体真名: ${ph}`);
  await act(async () => {
    await setTextInput(field, '打个招呼', '输入栏');
    await new Promise((r) => setTimeout(r, 0));
  });
  const barTyping = q('.inputbar');
  assert.ok(barTyping, '输入后输入栏不见了');
  assert.equal(barTyping.getAttribute('data-state'), 'typing', '输入了字 data-state 没到 typing（状态是假的）');
  assert.equal(field.value, '打个招呼', '输入框没留住打进去的字');
  await act(async () => {
    await setTextInput(field, '', '输入栏');
    await new Promise((r) => setTimeout(r, 0));
  });
  const barEmpty = q('.inputbar');
  assert.equal(barEmpty?.getAttribute('data-state'), 'empty', '清空后没回到 empty');
});
await check('⑪-2 Enter 真发送:走 /chat/stream,助手气泡是流帧回出来的', async () => {
  const field = q('.inputbar-field');
  assert.ok(field, '缺输入框');
  await act(async () => {
    await setTextInput(field, '打个招呼', '输入栏');
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  await waitFor('输入被消费', () => (q('.inputbar-field')?.value ?? '') === '', 60);
  assert.ok(requestedPaths.includes('/chat/stream'), '没请求 /chat/stream（发送是假的?）');
  await waitFor('用户气泡', () =>
    [...document.body.querySelectorAll('.msg')].some((m) => (m.textContent ?? '').includes('打个招呼')),
    60,
  );
  // 助手回复 = SSE 桩推的流帧（真打字机路径,不是渲染时写死）
  await waitFor('助手流式回复', () =>
    [...document.body.querySelectorAll('.msg.assistant')].some((m) => (m.textContent ?? '').includes('待命中')),
    60,
  );
});
await check('⑪-3 结束钮真 tidy:POST /agents/:id/tidy,回执进 chatNote', async () => {
  const endBtn = q('.inputbar-btn.end');
  assert.ok(endBtn, '缺「结束」钮');
  assert.ok((endBtn.getAttribute('title') ?? '').includes('两层记忆'), '结束钮 title 丢失（真功能说明）');
  // 当前智能体 = 第二列 active 行的 data-agent-id（⑩-4 之后是新建的「新员乙」）
  const curId = q('.contact-item.active')?.getAttribute('data-agent-id') ?? null;
  assert.ok(curId, '找不到当前智能体（第二列 active 行缺失）');
  await act(async () => {
    click(endBtn, '结束');
    await new Promise((r) => setTimeout(r, 0));
  });
  await waitFor('tidy 请求', () => requestedPaths.includes(`/agents/${curId}/tidy`), 60);
  await waitFor('回执', () => (document.body.textContent ?? '').includes('整理完了'), 60);
});
await check('⑪-4 样式红线:规则在 design/ 且已挂入口;旧 .inputBar 规则随组件消失', () => {
  const css = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', '04-inputbar.css'), 'utf8');
  assert.ok(/\.inputbar\s*\{/.test(css) && /\.inputbar-btn\.send\s*\{/.test(css), '04-inputbar.css 缺 .inputbar / .send 规则');
  // 常驻件:壳规则不许 display:none（同 ⑩-5 对 .rail 的红线）
  const barRule = css.match(/\.inputbar\s*\{([^}]*)\}/);
  assert.ok(barRule, '04-inputbar.css 里找不到 .inputbar 壳规则');
  assert.ok(!/display\s*:\s*none/.test(barRule[1]), '.inputbar 壳规则里有 display:none（输入栏被藏掉了）');
  const idx = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', 'index.css'), 'utf8');
  assert.ok(idx.includes('./04-inputbar.css'), '输入栏 CSS 没挂进设计入口');
  // M9'：文件级红线 —— styles.css 已删,任何旧规则想回来先得让文件复活
  const styles = legacyStyles();
  assert.ok(styles === null, 'styles.css 又出现了（M9\' 已删;.inputBar* 旧规则不许回来）');
});

log('');
log(`--- ⑫ 聊天区（批次 M-5'）：气泡体系接真会话数据,顺手修 .msg 双定义 ---`);
await check('⑫-1 聊天区:chatNote 真 × 能关;历史气泡 + 来源标注是 /chat/history 真数据', async () => {
  // ⑪-3 的 tidy 回执还在（期间没发过话、没切过人）→ 真 × 关掉它
  const note = q('.chatNote');
  assert.ok(note && (note.textContent ?? '').includes('整理完了'), 'chatNote 不该是 ⑪-3 的 tidy 回执');
  await act(async () => {
    click(q('.chatNote__x'), '关闭提示');
    await new Promise((r) => setTimeout(r, 0));
  });
  await flush(2);
  assert.ok(q('.chatNote') === null, '点 × 没关掉提示（真 handler 被摘?）');
  // ⑩-4 刚新建的「新员乙」本来就没有历史（新智能体 = 空会话,这也是真数据）——
  // 切回 97 小助（启动时载过历史）看真历史气泡
  const row97 = q('.contact-item[data-agent-id="97"]');
  assert.ok(row97, '缺 97 小助 的名单行');
  await act(async () => {
    click(row97, '切回 97 小助');
    await new Promise((r) => setTimeout(r, 0));
  });
  await waitFor('历史气泡出现', () => {
    const c = q('.chat');
    return c !== null && [...c.querySelectorAll('.msg.assistant')].some(
      (m) => (m.textContent ?? '').includes('这是从网页查到的回答。'),
    );
  }, 60);
  const chat = q('.chat');
  assert.ok(chat, '.chat 会话容器缺失');
  const title = chat.querySelector('.sources__title');
  const domain = chat.querySelector('.sources__domain');
  assert.ok(title && (title!.textContent ?? '').includes('示例文章'), '来源标题不是 history 真数据');
  assert.ok(domain && (domain!.textContent ?? '').includes('example.com'), '来源域名不是 history 真数据');
  const fakeBubbles = [...chat.querySelectorAll('.msg')].filter(
    (m) => (m.textContent ?? '').includes('假气泡'),
  );
  assert.equal(fakeBubbles.length, 0, '出现写死的假气泡');
});
await check('⑫-2 搜索提示跟真 SSE 帧走（start → done 两次真迁移）', async () => {
  const field = q('.inputbar-field');
  assert.ok(field, '缺输入框');
  await act(async () => {
    await setTextInput(field, '今天天气怎么样', '输入栏');
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  // SSE 桩先推 search:start → 「正在搜索：天气」必须真实出现（不是渲染时写死）
  await waitFor('搜索提示（start 帧）', () => {
    const h = q('.searchHint');
    return h !== null && (h.textContent ?? '').includes('正在搜索：天气');
  }, 60);
  // 250ms 后 search:done 帧 → 文案换成结果数;流结束提示行消失
  await waitFor('搜索完成（done 帧 / 流结束）', () => {
    const h = q('.searchHint');
    return h === null || (h.textContent ?? '').includes('2 条结果');
  }, 60);
});
await check('⑫-3 流式气泡:真 streamText + .caret,不是假动画圆点', async () => {
  const field = q('.inputbar-field');
  assert.ok(field, '缺输入框');
  await act(async () => {
    await setTextInput(field, '再问一句', '输入栏');
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  // 250ms 窗口内:流式气泡在(光标 ▍ 只存在于流式气泡)、还没有假 .tdot
  await waitFor('流式气泡出现', () => q('.chat .msg.assistant .caret') !== null, 60);
  assert.ok(!q('.chat .tdot'), '出现基准的假 thinking 圆点（不该搬）');
  // 流结束后:caret 消失,又多一条真回复气泡（SSE 桩的固定回复文案）
  await waitFor('流结束,caret 消失', () => q('.chat .msg.assistant .caret') === null, 120);
  const replyCount = [...(q('.chat')?.querySelectorAll('.msg.assistant') ?? [])].filter(
    (m) => (m.textContent ?? '').includes('待命中'),
  ).length;
  assert.ok(replyCount >= 2, `两次真发送后应至少 2 条回复气泡（实际 ${replyCount}）`);
});
await check('⑫-4 样式红线:11-chat-bubbles.css 在场且 .msg 单一 .msg 定义;旧规则随组件消失', () => {
  const css = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', '11-chat-bubbles.css'), 'utf8');
  assert.ok(/\.chat\s*\{/.test(css), '11-chat-bubbles.css 缺 .chat 容器规则');
  // ★ 双定义修复的守门:.msg 基础规则全文件只许出现一次
  const msgDefs = (css.match(/^\.msg\s*\{/gm) ?? []).length;
  assert.equal(msgDefs, 1, `.msg 基础规则定义了 ${msgDefs} 次（双定义又回来了,该修基准 59/139 行那种重定义）`);
  assert.ok(/\.msg\.user\s*\{/.test(css) && /\.msg\.assistant::before/.test(css), '缺 .msg.user / .msg.assistant 尾巴规则');
  const idx = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', 'index.css'), 'utf8');
  assert.ok(idx.includes('./11-chat-bubbles.css'), '聊天区 CSS 没挂进设计入口');
  // M9'：文件级红线（.msg 双定义修复 + 聊天区全家已搬进 11-chat-bubbles.css）
  const styles = legacyStyles();
  assert.ok(styles === null, 'styles.css 又出现了（M9\' 已删;.msg/.searchHint/.welcomeCard 旧规则不许回来）');
});

log('');
log(`--- ⑭ 其余 CSS（批次 M-7'）：编号 CSS 跟组件走,死代码清零,F2-③ 两槽在场 ---`);
await check('⑭-1 框架/原语跟组件走:03-frame + 02-base 在场,旧规则消失', () => {
  const frame = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', '03-frame.css'), 'utf8');
  assert.ok(/\.app\s*\{/.test(frame) && /\.middle\s*\{/.test(frame), '03-frame.css 缺 .app / .middle');
  const base = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', '02-base.css'), 'utf8');
  assert.ok(/\.btn\s*\{/.test(base) && /\.buttons-row\s*\{/.test(base), '02-base.css 缺 .btn / .buttons-row 原语');
  const idx = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', 'index.css'), 'utf8');
  assert.ok(idx.includes('./03-frame.css') && idx.includes('./10-surface.css'), '新编号文件没挂进设计入口');
  // M9'：文件级红线（.app 在 03-frame、.btn 原语在 02-base）
  const styles = legacyStyles();
  assert.ok(styles === null, 'styles.css 又出现了（M9\' 已删;.app/.btn 旧规则不许回来）');
});
await check('⑭-2 任务表面 + 侧栏家族在场;死代码（DOM 零引用）已清零', () => {
  const surf = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', '10-surface.css'), 'utf8');
  assert.ok(/\.taskState\s*\{/.test(surf) && /\.driveState\s*\{/.test(surf) && /\.loopGone\s*\{/.test(surf), '10-surface.css 缺任务表面规则');
  assert.ok(/\.taskResult \.buttons-row\s*\{/.test(surf), '必查后代选择器 .taskResult .buttons-row 没随组件搬走');
  const side = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', '06-sidebar.css'), 'utf8');
  assert.ok(/\.projectBox\s*\{/.test(side) && /\.memList\s*\{/.test(side) && /\.knowledgePanel\s*\{/.test(side) && /\.contact--on\s*\{/.test(side), '06-sidebar.css 缺左栏家族规则');
  // M9'：文件级红线（死代码 M7' 已删,承载它们的 styles.css M9' 已删）
  const styles = legacyStyles();
  assert.ok(styles === null, 'styles.css 又出现了（M9\' 已删;.driveBar/.memCard 等死代码不许回来）');
});
await check('⑭-3 F2-③ 两槽在场:成功槽朴素 + 失败槽红;演示行只藏不删（DOM 还在）', () => {
  const side = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', '06-sidebar.css'), 'utf8');
  assert.ok(/\.projectBox__note\s*\{/.test(side) && /\.projectBox__note--err\s*\{/.test(side), 'F2-③ 的两套样式没进 06-sidebar.css');
  const surf = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', '10-surface.css'), 'utf8');
  assert.ok(/\.demoOnly\s*\{[^}]*display\s*:\s*none/.test(surf), '.demoOnly（演示行隐藏）规则丢了');
  // 演示行 DOM 保留（只藏不删,桥自检照跑）
  const demo = q('.demoOnly');
  assert.ok(demo, '演示行 DOM 没了（第 18 步的"只藏不删"被破坏）');
});

log('');
log('--- ⑥ 路径 ①（有意卸载）：关光所有页 → 必须卸载 ---');
await check('关掉最后一张页后，.browserLayer 与页宿主一起消失（ADR-0002：并调了 view-close）', async () => {
  // 批次 M-2:tab 可能分布在多个智能体名下（⑧ 在会话里点链接开的页属于当时的智能体），
  // 顶栏只列**当前**智能体的 tab → 轮转每个智能体把可见 tab 关光,直到层消失。
  const contacts = qa('aside.sidebar .contact-item');
  assert.ok(contacts.length >= 1, '没有可切的智能体行');
  for (let round = 0; round < contacts.length + 1 && q('.browserLayer') !== null; round++) {
    await act(async () => {
      click(contacts[round % contacts.length], '切智能体');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush(2);
    const closeBtns = qa('.browserTab__x');
    assert.ok(closeBtns.length >= 1, '没有关页按钮（browserTab__x）');
    for (const b of closeBtns) {
      await act(async () => {
        click(b, '关页');
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await flush(2);
    }
  }
  await waitFor('浏览器层消失', () => q('.browserLayer') === null && q('.browserPanel__view') === null);
  assert.ok(q('.browserPanel__view') === null, `页宿主应该随最后一张页一起卸载（还有 ${qa('.browserPanel__view').length} 个）`);
  // 三条有意卸载路径里的路径①：关光所有页 = 每条页都走过 view-close（销毁原生宿主）
  for (const c of viewCreateLog) {
    assert.ok(viewCloseLog.includes(c.tabKey), `tabKey=${c.tabKey} 关掉了却没调 view-close（原生宿主泄漏）`);
  }
});

/**
 * ★ 2026-09-26 修（自查发现，真机症状 =「指定的内嵌页已经不在了（webContents NNNN 已关闭）」）：
 *
 * `BrowserPanel` 的「真卸载标志」`panelUnmountedRef` 是一次性 ref，cleanup 只把它设 true、
 * **从不设回 false** ⇒ 面板**卸载过一次**（= 用户关光所有页，App 把整层卸掉）之后它永远是 true；
 * 重新挂载后，宿主效果**每一次依赖变化**（开页 / 关页 / drivingIds 变）都会走
 * `if (panelUnmountedRef.current)` 分支 ⇒ 把当前**所有**原生视图 `hostGone` 掉
 * ⇒ 页被销毁重建、正在跑的那路驾驶目标当场作废（AI 只能重开一遍，用户看到"页莫名其妙重载"）。
 *
 * 本断言就是那个回归位：**关光页 → 重开 → 再变 allTabs，已存在的视图绝不能被销毁。**
 */
await check('⑥-2（2026-09-26 修）关光页之后重开：allTabs 再变不得销毁已有视图（卸载标志必须复位）', async () => {
  await act(async () => {
    emitBridge('open', 'https://www.baidu.com/');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await flush(3);
  const first = viewCreateLog[viewCreateLog.length - 1];
  assert.ok(first, '重开后没有新的 view-create');
  await waitFor('重开后第一张页的 rect', () => viewRectLog.some((r) => r.tabKey === first.tabKey), 8);
  // 再开一张：allTabs 变化 = 宿主效果依赖变化（有 bug 的话，就是这里把所有宿主销毁）
  await act(async () => {
    emitBridge('open', 'https://www.taobao.com/');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await flush(3);
  assert.ok(
    !viewCloseLog.includes(first.tabKey),
    `重开之后 allTabs 一变就把已存在的视图销毁了（tabKey=${first.tabKey}）—— ` +
      `页会被重建、正在跑的驾驶目标当场作废（真机症状：指定的内嵌页已不存在）`,
  );
  // 第二张也必须真的建出来（别为了"不销毁"把新页也漏了）
  assert.ok(
    viewCreateLog.some((x) => x.tabKey !== first.tabKey),
    '第二张页没有被 create（修复不能以漏建为代价）',
  );
});

log('');
log('--- ⑦ 样式红线：宿主与舞台不许被 display:none / 尺寸归零 ---');
await check('14-browser-column + browser/styles.css 里 .browserLayer / .browserPanel__stage 没有 display:none / 0 尺寸', () => {
  // M9'：第四列三态规则在 design/14-browser-column.css（旧 styles.css 已删）
  const css = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', '14-browser-column.css'), 'utf8');
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

function stripFor16(t: string): string {
  return t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const esc16 = (c: string): string => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

log('');
log(`--- ⑯ M9' 收口：styles.css 整体删除,零残留 ---`);

const DESKTOP_SRC = join(REPO, 'apps', 'desktop', 'src');
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(full));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

await check('⑯-1 零残留：styles.css 文件不在场,main.tsx 唯一入口,第四列规则在 14-browser-column.css', () => {
  assert.ok(!existsSync(LEGACY_STYLES), 'styles.css 文件还在（M9\' 要删）');
  const main = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'main.tsx'), 'utf8');
  assert.ok(!main.includes("import './styles.css'"), 'main.tsx 还在 import styles.css');
  assert.ok(main.includes("import './design/index.css'"), 'main.tsx 没引 design 入口');
  const idx = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', 'index.css'), 'utf8');
  assert.ok(idx.includes('./14-browser-column.css'), '14-browser-column.css 没挂进设计入口');
  const col = readFileSync(join(REPO, 'apps', 'desktop', 'src', 'design', '14-browser-column.css'), 'utf8');
  // 7 条规则全在（三态 + 拖拽手柄 + embed）
  for (const sel of ['.browserLayer {', '.browserLayer--hidden {', '.browserLayer--overlay {',
                     '.browserLayer--dragging {', '.browserCol__resizer {', '.browserCol__resizer:hover {', '.browserLayer--embed {']) {
    assert.ok(col.includes(sel), `14-browser-column.css 缺 ${sel}`);
  }
  // 铁律：隐藏 = transform,绝不 display:none（规则搬家不许顺手改）
  const hidden = col.match(/\.browserLayer--hidden\s*\{([^}]*)\}/);
  assert.ok(hidden && /transform\s*:\s*translateX/.test(hidden[1]) && !/display\s*:\s*none/.test(hidden[1]),
    '--hidden 规则被改坏了（必须是 transform 移出视野）');
  // 14 只装第四列家族：不许混进别的组件的规则
  const stripped14 = col.replace(/\/\*[\s\S]*?\*\//g, '');
  const sels14 = [...stripped14.matchAll(/([{};,\s])(\.[A-Za-z][\w-]*(?:[:.-][\w-]+)?)/g)].map((m) => m[2]);
  assert.ok(sels14.every((x) => x.startsWith('.browserLayer') || x.startsWith('.browserCol__resizer')),
    `14-browser-column.css 混进了第四列之外的选择器：${sels14.filter((x) => !x.startsWith('.browserLayer') && !x.startsWith('.browserCol__resizer')).join(', ')}`);
});

/**
 * ⑯-2 零残留审计 —— 基线 = 批次 M 之前（ac75d63）styles.css 的**全部 120 个类选择器**。
 * 口径：原表里每个类，只要还在桌面源码的 className 语境里出现，就**必须**在
 * （design/ ∪ browser/ ∪ channels/）里有规则 —— 旧表没有任何一块规则被悄悄弄丢。
 * 唯一例外 agentList：M2' 有意让位（列表布局职责改由 .contact-list + .sidebar__body 承担，
 * 见 06-sidebar.css;wrapper div 保留为纯容器,JSX 里 M2' 注释写明）。
 */
const ORIG_CLASSES = [
    'account',
    'agentList',
    'agentList__add',
    'agentList__del',
    'agentList__note',
    'agentSteps',
    'app',
    'assistant',
    'authCard',
    'authErr',
    'authInput',
    'authRow',
    'authTab',
    'authTab--on',
    'authTabs',
    'authWrap',
    'avatar',
    'avatar__face',
    'browserFloating',
    'browserLayer',
    'browserLayer--bg',
    'browserLayer--embed',
    'btn',
    'btn--go',
    'btn--pending',
    'buttons-row',
    'card',
    'caret',
    'chat',
    'chatNote',
    'chatNote__x',
    'contact',
    'contact--on',
    'contact__name',
    'demoOnly',
    'docDownload',
    'driveBar',
    'driveBar__go',
    'driveBar__note',
    'driveBar__tag',
    'driveState',
    'driveState--agent',
    'driveState--none',
    'driveState--user',
    'driveState__icon',
    'guide',
    'guide__del',
    'guide__head',
    'guide__input',
    'guide__ok',
    'guide__table',
    'inputBar',
    'inputBar__end',
    'keepalive',
    'keepalive__btn',
    'knowledgePanel',
    'knowledgePanel__del',
    'knowledgePanel__file',
    'knowledgePanel__line',
    'knowledgePanel__list',
    'knowledgePanel__name',
    'knowledgePanel__note',
    'knowledgePanel__row',
    'loopGone',
    'loopGone__q',
    'loopGone__warn',
    'memCard',
    'memList',
    'memList--pending',
    'memList__actions',
    'memList__confirm',
    'memList__forget',
    'memList__reject',
    'memList__row',
    'memList__row--pending',
    'memList__title',
    'middle',
    'msg',
    'personaEditCard',
    'personaEditOverlay',
    'projectBox',
    'projectBox__list',
    'projectBox__note',
    'projectBox__row',
    'readTag',
    'red-dot',
    'right',
    'searchHint',
    'settingsRow',
    'settingsRow__num',
    'sidebar',
    'sidebar__footer',
    'small',
    'sources',
    'sources__domain',
    'sources__item',
    'sources__label',
    'sources__list',
    'sources__title',
    'status-running',
    'taskResult',
    'taskState',
    'taskSummary',
    'unreadTag',
    'user',
    'welcomeCard',
    'welcomeCard__actions',
    'welcomeCard__btn',
    'welcomeCard__btn--primary',
    'welcomeCard__desc',
    'welcomeCard__title',
    'workbenchNav',
    'workbenchNav__badge',
    'workbenchNav__btn',
    'workbenchNav__btn--active',
    'workbenchNav__driving',
    'workbenchNav__meta',
    'workbenchNav__name',
    'workbenchNav__status',
    'workbenchNav__views',
];
await check('⑯-2 零残留审计：原表 120 类仍在用者,规则一个都不许丢（design/browser/channels 合并口径）', () => {
  const designDir = join(DESKTOP_SRC, 'design');
  const cssAll = readdirSync(designDir).filter((f) => f.endsWith('.css'))
      .map((f) => readFileSync(join(designDir, f), 'utf8')).join('\n')
    + '\n' + readFileSync(join(DESKTOP_SRC, 'browser', 'styles.css'), 'utf8')
    + '\n' + readFileSync(join(DESKTOP_SRC, 'channels', 'styles.css'), 'utf8');
  const definedRe = (c: string): RegExp => new RegExp('\\.' + esc16(c) + '(?![\\w-])');
  assert.ok(definedRe('authWrap').test(cssAll), '自检失败：.authWrap 应该定义在 09-modal.css（审计器坏了）');
  const srcText = walkTs(DESKTOP_SRC).map((f) => stripFor16(readFileSync(f, 'utf8'))).join('\n');
  const classCtx = [...srcText.matchAll(/className="([^"]+)"/g)].map((m) => m[1]).join(' ')
    + ' ' + [...srcText.matchAll(/className=\{([^}]*)\}/g)].map((m) => m[1]).join(' ');
  assert.ok(classCtx.includes('app'), '自检失败：className 语境里应该有 .app（审计器坏了）');
  const exceptions: Record<string, string> = {
    agentList: 'M2\' 有意让位（布局职责 → .contact-list + .sidebar__body,见 06-sidebar.css）',
  };
  const lost: string[] = [];
  for (const c of ORIG_CLASSES) {
    const re = new RegExp('(?<![\\w.-])' + esc16(c) + '(?![\\w-])');
    if (!re.test(classCtx)) continue;          // 源码里没人再用 → 规则随 UI 删除,合理
    if (definedRe(c).test(cssAll)) continue;   // 规则在场（新家）→ OK
    if (c in exceptions) continue;             // 文档化例外
    lost.push(c);
  }
  assert.equal(lost.length, 0, `原表规则丢了:${lost.join(', ')}`);
});

await check('⑯-3 .agentList 家族去向钉死：__note 有规则,布局新东家在场,__add/__del 与 UI 一起消失', () => {
  const side = readFileSync(join(DESKTOP_SRC, 'design', '06-sidebar.css'), 'utf8');
  assert.ok(/\.agentList__note\s*\{/.test(side), '06-sidebar.css 缺 .agentList__note 规则（在用的类丢了样式）');
  // 容器布局的新东家（M2' 接替旧 .agentList 的 flex 列 + 滚动职责）
  const contactList = side.match(/\.contact-list\s*\{([^}]*)\}/);
  assert.ok(contactList && /flex-direction:\s*column/.test(contactList[1]), '.contact-list 不再是 flex 列（列表布局没人管了）');
  const body = side.match(/\.sidebar__body\s*\{([^}]*)\}/);
  assert.ok(body && /overflow-y:\s*auto/.test(body[1]), '.sidebar__body 不再滚动（左栏超高时入口够不着,旧 .agentList 的坑回来了）');
  // 旧「＋ 添加 / 删除」两钮 M2' 起已收进顶栏弹层 —— 若按钮回来,规则必须跟回来
  const srcText = walkTs(DESKTOP_SRC).map((f) => stripFor16(readFileSync(f, 'utf8'))).join('\n');
  for (const c of ['agentList__add', 'agentList__del']) {
    const re = new RegExp('(?<![\\w.-])' + esc16(c) + '(?![\\w-])');
    assert.ok(!re.test(srcText), `${c} 又出现在源码里（按钮回来了,规则必须跟着回来）`);
  }
});

log('');
log('--- ⑰ 页宿主生命周期（StrictMode 下：假卸载不得销毁视图，真卸载必须销毁）---');
/**
 * ★ 2026-09-26 修的第二条（自查发现，真机症状 =「指定的内嵌页已经不在了（webContents NNNN）」）：
 *
 *   `main.tsx` 里 `<StrictMode>` 是开着的 ⇒ 开发模式下 React 会在**同一个实例**上跑一遍
 *   「setup → cleanup → setup」。旧实现用一个布尔标志记「真卸载」，cleanup 只把它设 true、
 *   **从不设回 false**（`useRef(false)` 的初值只在**新实例**上生效）⇒ 标志从挂载起就永远是 true
 *   ⇒ 宿主效果**每一次依赖变化**（开页/关页/drivingIds 变）都把所有原生视图销毁重建
 *   ⇒ 正在跑的那路驾驶目标当场作废（AI 只能重开一遍页）。
 *   修法 = 「代次 + 微任务」：cleanup 把销毁推迟一个微任务，只在"没有更晚的挂载"时才真销毁 ——
 *   StrictMode 的**假卸载**被紧随其后的重挂取消，**真卸载**（关光所有页 → 整层卸掉）才执行。
 *
 * 这里**单独再挂一个 StrictMode 的 BrowserPanel**（而不是把整个 App 包进 StrictMode ——
 * 那会让前面 56 条断言的时序全变），只钉三件事：
 *   ① 挂载（含 StrictMode 的假卸载）之后，一张视图都不许被销毁；
 *   ② 依赖变化（allTabs 多一张）之后，已存在的视图照样不许被销毁；
 *   ③ 真卸载（组件没了）必须把登记在册的宿主全销毁（路径① 的原生侧那一半）。
 */
await check('⑰ 页宿主生命周期：StrictMode 假卸载不销毁 / 依赖变化不销毁 / 真卸载必须销毁', async () => {
  const { BrowserPanel } = await import('../../apps/desktop/src/browser/BrowserPanel');
  const goneLog: number[] = [];
  const mountedLog: number[] = [];
  const mkTab = (id: number): Record<string, unknown> => ({
    id,
    agentId: 1,
    projectId: 1,
    bootUrl: 'https://a.example/',
    url: 'https://a.example/',
    title: 'A',
  });
  let tabs: Record<string, unknown>[] = [mkTab(90001)];
  // 只喂 BrowserPanel 真正会碰到的字段；用 getter 保证每次渲染都读到最新（不重建 ws 对象）
  const ws = {
    currentAgentId: 1,
    get tabs() { return tabs; },
    get allTabs() { return tabs; },
    activeId: 90001,
    get active() { return tabs[0] ?? null; },
    view: 'fullscreen',
    drivingIds: [] as number[],
    tabCount: 1,
    softHint: false,
    urlBarFocusTick: 0,
    focusUrlBar: () => undefined,
    showFullscreen: () => undefined,
    exitFullscreen: () => undefined,
    enterEmbed: () => undefined,
    exitEmbed: () => undefined,
    embedWcId: null,
    registerWebview: () => undefined,
    notePageInfo: () => undefined,
    hostMounted: async (t: { id: number }) => { mountedLog.push(t.id); },
    hostGone: (id: number) => { goneLog.push(id); },
    noteOwner: () => undefined,
    touchTab: () => undefined,
    sleepOf: () => undefined,
    idleMsOf: () => 0,
    wakeTab: () => undefined,
    wakeAndActivate: () => undefined,
    sleepEnabled: true,
    setSleepEnabled: () => undefined,
    instanceList: () => [],
    openUrl: async () => null,
    openHome: async () => null,
    openNewTab: () => undefined,
    closeTab: () => undefined,
    closeTabsOfAgent: () => undefined,
    closeAllTabs: () => undefined,
    activate: () => undefined,
    navigate: () => undefined,
    focusActive: () => undefined,
    webContentsIdOf: () => undefined,
    awaitWebContentsId: async () => undefined,
    tabIdOfWebContents: () => null,
    ownerOf: () => undefined,
    focusByWebContents: () => undefined,
    openFromMain: () => undefined,
    openFromPage: () => undefined,
    refreshDriving: async () => undefined,
    stopDriving: () => undefined,
  };
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const panelRoot = createRoot(host);
  const renderPanel = async (next: Record<string, unknown>[]): Promise<void> => {
    tabs = next;
    await act(async () => {
      panelRoot.render(
        React.createElement(React.StrictMode, null, React.createElement(BrowserPanel, { ws: ws as never })),
      );
    });
    await flush(2);
  };

  await renderPanel([mkTab(90001)]);
  assert.ok(mountedLog.includes(90001), 'StrictMode 下宿主没被建出来（hostMounted 没被调）');
  // ① 挂载（含 StrictMode 的假卸载）之后：一张都不许销毁
  assert.deepEqual(
    goneLog,
    [],
    `StrictMode 的假卸载把刚建的视图销毁了（hostGone=${JSON.stringify(goneLog)}）—— 真机上就是"页被重建、驾驶目标作废"`,
  );
  // ② 依赖变化（多一张页）：已存在的视图不许被销毁
  await renderPanel([mkTab(90001), mkTab(90002)]);
  assert.deepEqual(goneLog, [], `allTabs 一变就销毁了已存在的视图（hostGone=${JSON.stringify(goneLog)}）`);
  assert.ok(mountedLog.includes(90002), '第二张页没被建出来（修复不能以漏建为代价）');
  // ③ 真卸载：登记在册的宿主全销毁（路径① 的原生侧那一半）
  await act(async () => {
    panelRoot.unmount();
  });
  await flush(2);
  assert.deepEqual(
    goneLog.slice().sort((a, b) => a - b),
    [90001, 90002],
    `真卸载没有把宿主全销毁（hostGone=${JSON.stringify(goneLog)}）—— 关光所有页时原生视图会泄漏`,
  );
  host.remove();
});

log('');
log('--- ⑱ 资源：create 回执晚于关页时，绝不留孤儿原生视图 ---');
/**
 * ★ 2026-09-26 修的第三条（自查发现，属「资源不释放」）：
 *   `browserViewCreate` 是异步 IPC，而「关页」可能赶在它回执之前发生（开页后立刻点 ✕ /
 *   登出时 closeAllTabs 紧跟开页 / 深休眠唤醒后又被判休眠）。那种时序下 `hostGone` 先到 ——
 *   `viewHostClose` 在 entries 里找不到这条 tabKey（视图还没建）是**空操作**；
 *   随后 create 回执才落地 ⇒ 原生视图照样建出来并挂在窗口上 ⇒ **孤儿视图**
 *   （页在后台继续跑、渲染进程与内存收不回来，直到窗口关闭）。
 *   修法 = 回执落地时先确认这张页还在（`findTab`），不在就当场销毁。
 */
await check('⑱ 资源：create 未回执就关页 → 回执落地必须当场销毁，不留孤儿原生视图', async () => {
  viewCreateDelayMs = 90; // 构造「关页先到、create 后到」
  try {
    await act(async () => {
      emitBridge('open', 'https://www.bing.com/');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const created = viewCreateLog[viewCreateLog.length - 1];
    assert.ok(created, '竞态断言：没拿到 create 记录');
    const tabKey = created.tabKey;
    assert.ok(!viewCloseLog.includes(tabKey), '前置：这张页还没被关（create 还在飞）');
    // 立刻关掉它（真实路径：点这张 tab 的 ✕）
    const tabEls = qa('.browserTab');
    const target = tabEls.find((el) => (el.querySelector('.browserTab__label')?.textContent ?? '').includes('bing.com')) ?? tabEls[tabEls.length - 1];
    assert.ok(target, '找不到刚开的那张 tab');
    await act(async () => {
      click(target.querySelector('.browserTab__x'), '关页');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(viewCloseLog.includes(tabKey), '前置：关页没有走到 view-close');
    // 等 create 回执落地（>90ms）后：必须**再**关一次（把晚到的原生视图销毁掉）
    await flush(6);
    const closes = viewCloseLog.filter((k) => k === tabKey).length;
    assert.ok(
      closes >= 2,
      `create 回执落地后没有把晚到的视图销毁（tabKey=${tabKey} 只关了 ${closes} 次）—— ` +
        `这就是孤儿原生视图：页在后台继续跑、渲染进程与内存收不回来`,
    );
  } finally {
    viewCreateDelayMs = 0;
  }
});

log('');
log('=== 结论 ===');
log(`  ${passes} PASS / ${fails} FAIL`);
log(`  （启动期间打到后端的接口 ${requestedPaths.length} 个；桥调用 ${bridgeCalls.length} 次）`);
if (fails > 0) process.exitCode = 1;

await act(async () => root.unmount());
