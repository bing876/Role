/**
 * 阶段 1 · ① 逻辑抽离的**行为验收网** —— 真正跑起来的那一半。
 *
 * 与 `app-shell-smoke.run.tsx` 分工：
 *   · app-shell-smoke 管**结构**（三列 / webview 祖先链 / 节点身份）—— 抽逻辑不该动它；
 *   · 本文件管**行为**（抽出去的 feature 还干不干原来那些事）—— 每抽一片就在这里加一节。
 *
 * 它挂的是**整个 <App/>**、点的是**真实按钮**、断言的是**真实 DOM 与真实 fetch 路径**，
 * 不是抄一份组件、也不是只 import 一下 hook 看它返回啥。
 *
 * ⚠️ 反证（app-logic-smoke-revert.py）会往**抽出去的 feature 源码**里注入真实的抽错方式
 *   （丢守卫、放宽校验、reset 少清一项），每一节都必须能变红 —— 那些注入项就是本节的意义。
 *
 * 用法：npm run verify:logic   （由 app-logic-smoke.mts 打包后执行）
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const REPO = process.env.SMOKE_REPO ?? process.cwd();

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
    log(`      ${(err as Error).message.split('\n').slice(0, 3).join('\n      ')}`);
  }
}

// ---------------------------------------------------------------------------
// jsdom 全局（★ 必须在 import react-dom 之前铺好）
// ---------------------------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
g.IS_REACT_ACT_ENVIRONMENT = true;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(g, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
for (const k of ['HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage', 'File', 'FormData', 'Blob']) {
  const v = (dom.window as unknown as Record<string, unknown>)[k];
  if (v !== undefined) g[k] = typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(dom.window) : v;
}
if (!g.ResizeObserver) {
  g.ResizeObserver = class { observe(): void {} unobserve(): void {} disconnect(): void {} };
}
if (!(dom.window as unknown as { matchMedia?: unknown }).matchMedia) {
  (dom.window as unknown as Record<string, unknown>).matchMedia = () => ({
    matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  });
}

// ---------------------------------------------------------------------------
// 桥桩（与冒烟网同一套：被直接 await 的方法必须给真值）
// ---------------------------------------------------------------------------
const handlers = new Map<string, (payload?: unknown) => void>();
const bridge = new Proxy(
  {
    isElectron: false,
    apiBase: () => '',
    token: () => null,
    getSettings: async () => ({
      maxConcurrentAgentTasks: 20, maxBrowserInstances: 4, resourceGuardEnabled: 1, resourceSampleMs: 5000,
      resourceMemHealthMB: 3072, resourceMemWarnMB: 4096, resourceCpuHealthPct: 20, resourceCpuWarnPct: 35,
      resourceSysMemGuard: 0, resourceSysMemFloorMB: 1536,
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
    on: (channel: string, handler: (payload?: unknown) => void) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    },
  } as Record<string, unknown>,
  {
    get(target, prop) {
      const key = String(prop);
      if (key in target) return target[key];
      return () => Promise.resolve(undefined);
    },
  },
);
(dom.window as unknown as Record<string, unknown>).workbench = bridge;

// ---------------------------------------------------------------------------
// fetch 桩 —— 记录**每一条真实请求**（方法 + 路径），并按路径回数据
// ---------------------------------------------------------------------------
type Req = { method: string; path: string; body?: unknown };
const requests: Req[] = [];
/** 知识库的假数据（两行，用来验列表/删除） */
const DOCS = [
  { id: 11, filename: '需求.md', kind: 'md', byteSize: 2048, chunkCount: 3, createdAt: '2026-09-24T00:00:00.000Z', projectId: 7 },
  { id: 12, filename: '隐私政策.pdf', kind: 'pdf', byteSize: 8192, chunkCount: 7, createdAt: '2026-09-24T00:00:00.000Z', projectId: 7 },
];
const PROJECT = { id: 7, name: '默认项目', isCurrent: true, isDefault: true, henAgentId: null };
const AGENTS = [
  { id: 97, name: '小助', kind: 'assistant', deletable: false, projectId: 7, personaStatus: 'ready', persona: null, conversationId: 501, status: 'idle' },
];
const STATE = {
  conversationId: 501, current_task: '', latest_user_intent: '', browser_confirmed: false,
  login_required: false, sensitive_action: false, last_page_summary: '', already_told_user_login_themselves: false, keepalive: false,
};
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const url = raw.replace(/^https?:\/\/[^/]+/, '');
  const path = url.split('?')[0];
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push({ method, path, body: init?.body });

  if (path === '/auth/me') return json({ user: { id: 1, phone: '13800000000', xyz: '' }, project: PROJECT, agents: [{ id: 97, name: '小助' }] });
  if (path === '/projects') return json({ projects: [PROJECT], currentProjectId: 7 });
  if (path === '/agents') return json({ agents: AGENTS });
  if (path === '/chat/state') return json({ conversationId: 501, state: STATE });
  if (path === '/chat/history') return json({ conversationId: 501, messages: [] });
  if (path === '/memory/user' || (path.startsWith('/agents/') && path.endsWith('/memory'))) return json({ items: [] });
  if (path === '/memories') return json({ items: [], pending: [] });
  if (path === '/knowledge') return json({ documents: DOCS });
  if (path === '/agent/task/current') return json({ task: null });
  if (path === '/settings') return json({});
  if (path.includes('/visibility')) return json({ visibility: 'status' });
  if (path === '/health') return json({ ok: true, service: 'ai-workbench' });
  // 删除一条资料
  const del = /^\/knowledge\/(\d+)$/.exec(path);
  if (del && method === 'DELETE') {
    const id = Number(del[1]);
    return json({ id, deleted: true, removedChunks: id === 11 ? 3 : 7 });
  }
  return json({});
}) as typeof fetch;

dom.window.localStorage.setItem('workbench.token', 'smoke-token');

// ---------------------------------------------------------------------------
// 真正 import（必须在全局铺好之后）
// ---------------------------------------------------------------------------
const { act } = await import('react-dom/test-utils');
const { createRoot } = await import('react-dom/client');
const React = (await import('react')).default;
const App = (await import('../../apps/desktop/src/App')).default;
const { useKnowledge } = await import('../../apps/desktop/src/features/knowledge');

async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
async function waitFor(name: string, pred: () => boolean, rounds = 50): Promise<void> {
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
function click(el: Element | null, label: string): void {
  assert.ok(el, `找不到可点的元素：${label}`);
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}
const requestsTo = (path: string): Req[] => requests.filter((r) => r.path === path);

log('');
log('=== 阶段 1① · 逻辑抽离：行为验收 ===');

// ---------------------------------------------------------------------------
// ① features/knowledge（本片抽出的第一个 feature）—— 走真实 UI 路径
// ---------------------------------------------------------------------------
log('');
log('--- ① 资料（知识库）：列表 / 校验 / 删除 / 登出清理 ---');

const root = createRoot(doc.getElementById('root') as HTMLElement);
await act(async () => {
  root.render(React.createElement(App));
});
await flush();

await check('启动后按当前项目拉过一次资料列表（真实路径 /knowledge?projectId=7）', async () => {
  await waitFor('发出 /knowledge 请求', () => requestsTo('/knowledge').length > 0);
  const first = requestsTo('/knowledge')[0];
  assert.equal(first.method, 'GET', `请求方法不对：${first.method}`);
  assert.ok(
    requests.some((r) => r.path === '/knowledge'),
    '没有请求 /knowledge',
  );
});

await check('知识库入口显示服务端返回的条数（知识库（2））', async () => {
  await waitFor('入口出现', () => q('.knowledgePanel__toggle') !== null);
  const label = q('.knowledgePanel__toggle')?.textContent ?? '';
  assert.match(label, /知识库（2）/, `入口文案不对：「${label}」（说明列表没被 setDocuments 接住）`);
});

await check('点开后列出两条资料，文件名与删除按钮都在', async () => {
  click(q('.knowledgePanel__toggle'), '知识库入口');
  await flush(3);
  const names = qa('.knowledgePanel__name').map((n) => n.textContent);
  assert.deepEqual(names, ['需求.md', '隐私政策.pdf'], `列表内容不对：${names.join(', ')}`);
  assert.equal(qa('.knowledgePanel__del').length, 2, '删除按钮数量不对');
});

await check('不支持的扩展名被挡下（.exe）并给出人话提示', async () => {
  const input = q('.knowledgePanel__file') as HTMLInputElement;
  assert.ok(input, '找不到文件输入框');
  const bad = new dom.window.File(['x'], 'evil.exe', { type: 'application/octet-stream' });
  Object.defineProperty(input, 'files', { value: [bad], configurable: true });
  await act(async () => {
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await flush(2);
  const note = q('.knowledgePanel__note')?.textContent ?? '';
  assert.match(note, /只支持 \.txt、\.md、\.pdf/, `提示文案不对：「${note}」（校验分支没跑到）`);
  // 且**不许**真的发上传请求
  assert.equal(requests.filter((r) => r.path === '/knowledge/upload').length, 0, '被拒的文件却发了上传请求');
});

await check('超过 12 MB 的文件被挡下', async () => {
  const input = q('.knowledgePanel__file') as HTMLInputElement;
  const big = new dom.window.File([new Uint8Array(13 * 1024 * 1024)], 'big.md', { type: 'text/markdown' });
  Object.defineProperty(input, 'files', { value: [big], configurable: true });
  await act(async () => {
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await flush(2);
  const note = q('.knowledgePanel__note')?.textContent ?? '';
  assert.match(note, /超过 12 MB/, `提示文案不对：「${note}」`);
});

await check('删掉一条：走 DELETE /knowledge/11，列表立刻少一条，并回一句人话', async () => {
  const before = qa('.knowledgePanel__del').length;
  click(qa('.knowledgePanel__del')[0], '第一行删除');
  await waitFor('删除请求发出', () => requestsTo('/knowledge/11').length > 0);
  await flush(4);
  const after = qa('.knowledgePanel__del').length;
  assert.equal(after, before - 1, `行数没变（${before} → ${after}）`);
  const note = q('.knowledgePanel__note')?.textContent ?? '';
  assert.match(note, /《需求\.md》已删除/, `删除提示不对：「${note}」`);
  const del = requestsTo('/knowledge/11')[0];
  assert.equal(del.method, 'DELETE', '方法不是 DELETE');
  // 空 body 会被 fastify 判 400 —— 这条守卫必须还在
  assert.equal(del.body, '{}', `DELETE 的 body 必须是 '{}'，实际是 ${JSON.stringify(del.body)}`);
});

await check('登出把这套状态清干净（列表清空 + 面板收起）', async () => {
  // 先确保面板是开着的（上一条删完还开着）
  assert.ok(q('.knowledgePanel'), '面板应该还开着');
  // 找到登出按钮（左栏账号小块里的「退出登录」）
  const logout = qa('aside.sidebar button').find((b) => /退出登录|登出/.test(b.textContent ?? ''));
  assert.ok(logout, '找不到登出按钮');
  await act(async () => {
    click(logout, '登出');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await flush(4);
  // 登出后回到登录页：知识库面板与入口都不该还在（状态被 reset 清掉，不会带着上一号的列表回来）
  assert.ok(!q('.knowledgePanel'), '登出后知识库面板还开着（reset 没清 open）');
  assert.ok(!q('.knowledgePanel__toggle'), '登出后还停在主界面（会话没清）');
});

await act(async () => root.unmount());

// ---------------------------------------------------------------------------
// ② 直接挂真实 hook：会话切换期间「晚到的旧响应不许覆盖新列表」
//    （这条守卫写在 useKnowledge.load 里，App 级别很难稳定触发，所以在真实 hook 上验）
// ---------------------------------------------------------------------------
log('');
log('--- ② useKnowledge 的切换账号守卫（挂真实 hook，不是副本）---');

await check('A 号请求晚到时不许覆盖 B 号列表', async () => {
  const sessionRef = { current: { token: 'tok-A' } } as unknown as { current: { token: string } | null };
  const curProjectRef = { current: 7 };
  let api: { documents: { id: number; filename: string }[]; load: (p?: number | null) => Promise<void> } | null = null;

  /** 先把 fetch 换成「可控延迟」，模拟慢响应 */
  const realFetch = globalThis.fetch;
  let release: (() => void) | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const raw = typeof input === 'string' ? input : (input as Request).url;
    const path = raw.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (path !== '/knowledge') return realFetch(input as RequestInfo);
    await new Promise<void>((resolve) => { release = resolve; });
    return json({ documents: [{ id: 1, filename: 'A号的旧资料.md', kind: 'md', byteSize: 1, chunkCount: 1, createdAt: '' }] });
  }) as typeof fetch;

  function Host() {
    api = useKnowledge({ sessionRef: sessionRef as never, curProjectRef });
    return null;
  }
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const hostRoot = createRoot(host);
  await act(async () => {
    hostRoot.render(React.createElement(Host));
  });
  await flush(2);

  assert.ok(api, 'hook 没返回 API');
  const pending = api!.load(7);          // 用 A 号发起，响应被挂住
  await flush(2);
  sessionRef.current = { token: 'tok-B' }; // 期间切了账号
  release?.();                             // 放行 A 号的慢响应
  await pending;
  await flush(2);

  assert.deepEqual(
    (api as unknown as { documents: unknown[] }).documents.map((d) => (d as { filename: string }).filename),
    [],
    '切号后 A 号的慢响应把 B 号的列表覆盖了（守卫被删/被改坏）',
  );

  globalThis.fetch = realFetch;
  await act(async () => hostRoot.unmount());
  host.remove();
});

log('');
log('=== 结论 ===');
log(`  ${passes} PASS / ${fails} FAIL`);
log(`  （期间发出 ${requests.length} 条真实请求）`);
if (fails > 0) process.exitCode = 1;
