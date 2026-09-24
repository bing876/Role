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
import { sameNode } from './lib/dom-assert.mts';

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
/** jsdom 没有实现 scrollIntoView；HelpCard 量完窗口会滚一下，缺了它会抛 TypeError */
if (!(dom.window.Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView) {
  (dom.window.Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
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
/** 主进程侧的调用轨迹（求助卡/确认卡点按钮后应该走既有通道） */
const bridgeCalls: string[] = [];
/** 送一个**桥事件**（非 agent 通道，例如主进程要求开页）：返回是否有人接住 */
const emitBridge = (channel: string, payload?: unknown): number => {
  const h = handlers.get(channel);
  if (!h) return 0;
  h(payload);
  return 1;
};
/** 把一个主进程事件真的送进 App 的订阅回调（payload 是 JSON 字符串，与真桥一致） */
const emitAgent = (p: Record<string, unknown>): void => {
  const h = handlers.get('agent');
  assert.ok(h, 'App 没有订阅 agent 事件');
  h!(JSON.stringify(p));
};
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
    /** 胶水那节要看「决定有没有送回主进程」——记录调用参数 */
    loopGoneChoice: async (wcId: number, choice: string) => {
      bridgeCalls.push(`loopGoneChoice(${wcId}, ${choice})`);
    },
    resumeTask: async (wcId: number) => {
      bridgeCalls.push(`resumeTask(${wcId})`);
    },
    agentDrop: async (wcId: number) => {
      bridgeCalls.push(`agentDrop(${wcId})`);
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
/** 第二个项目 + 它自己的名单/资料：用来验「切项目 = 名单与资料一起换」 */
const PROJECT_B = { id: 8, name: '实验项目', isCurrent: false, isDefault: false, henAgentId: 88 };
const AGENTS = [
  { id: 97, name: '小助', kind: 'assistant', deletable: false, projectId: 7, personaStatus: 'ready', persona: null, conversationId: 501, status: 'idle' },
];
const AGENTS_B = [
  { id: 98, name: '卡布', kind: 'worker', deletable: true, projectId: 8, personaStatus: 'ready', persona: null, conversationId: 502, status: 'idle' },
];
/** 当前项目：`/projects/:id/activate` 会改它（与真服务端一样） */
let currentProjectId = 7;
/** 新建出来的项目（`POST /projects`） */
let createdProject: { id: number; name: string } | null = null;
const STATE = {
  conversationId: 501, current_task: '', latest_user_intent: '', browser_confirmed: false,
  login_required: false, sensitive_action: false, last_page_summary: '', already_told_user_login_themselves: false, keepalive: false,
};
/** 记忆的假数据（用来验两层记忆 + 待确认） */
const USER_MEM = [
  { id: 301, content: '用户偏好：回答用中文', updatedAt: '2026-09-24T00:00:00.000Z' },
  { id: 302, content: '用户是产品经理', updatedAt: '2026-09-24T00:00:00.000Z' },
];
const PROJ_MEM = [{ id: 311, content: '本项目用 pnpm', updatedAt: '2026-09-24T00:00:00.000Z' }];
let PENDING_MEM = [
  { id: 321, type: 'decision' as const, content: '决定用 A 方案', updatedAt: '2026-09-24T00:00:00.000Z' },
  { id: 322, type: 'fact' as const, content: '项目代号是猎户座', updatedAt: '2026-09-24T00:00:00.000Z' },
];
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const url = raw.replace(/^https?:\/\/[^/]+/, '');
  const path = url.split('?')[0];
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push({ method, path, body: init?.body });

  if (path === '/auth/me') return json({ user: { id: 1, phone: '13800000000', xyz: '' }, project: PROJECT, agents: [{ id: 97, name: '小助' }] });
  if (path === '/projects' && method === 'GET') {
    return json({ projects: [PROJECT, PROJECT_B].map((p) => ({ ...p, isCurrent: p.id === currentProjectId })), currentProjectId });
  }
  if (path === '/projects' && method === 'POST') {
    const name = (JSON.parse(String(init?.body ?? '{}')) as { name?: string }).name ?? '';
    createdProject = { id: 9, name, isCurrent: true, isDefault: false, henAgentId: 99 };
    currentProjectId = 9;
    return json({ project: createdProject, henAgent: { id: 99, name: '小鸡' } });
  }
  if (/^\/projects\/\d+\/activate$/.test(path)) {
    currentProjectId = Number(path.split('/')[2]);
    return json({ ok: true, currentProjectId });
  }
  if (path === '/agents') {
    const pid = Number(new URLSearchParams(url.split('?')[1] ?? '').get('projectId') ?? currentProjectId);
    if (pid === 8) return json({ agents: AGENTS_B });
    if (pid === 9) return json({ agents: [{ ...AGENTS_B[0], id: 99, name: '小鸡', projectId: 9 }] });
    return json({ agents: AGENTS });
  }
  if (path === '/chat/state') return json({ conversationId: 501, state: STATE });
  if (path === '/chat/history') return json({ conversationId: 501, messages: [] });
  if (path === '/memory/user') return json({ items: USER_MEM });
  const pm = /^\/agents\/(\d+)\/memory$/.exec(path);
  if (pm) return json({ items: Number(pm[1]) === 97 ? PROJ_MEM : [] });
  if (path === '/memories') return json({ active: [], pending: [...PENDING_MEM] });
  if (path === '/memory/forget') return json({ ok: true });
  if (path === '/memories/confirm' || path === '/memories/reject') return json({ ok: true });
  if (path === '/knowledge') {
    const pid = Number(new URLSearchParams(url.split('?')[1] ?? '').get('projectId') ?? currentProjectId);
    return json({ documents: pid === 7 ? DOCS : [] });
  }
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
const { useMemory } = await import('../../apps/desktop/src/features/memory');
const { useBrowserGlue } = await import('../../apps/desktop/src/app/browserGlue');

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
// ③ features/memory（片 2）—— 两层记忆 + 待确认，走真实 UI 路径
// ---------------------------------------------------------------------------
log('');
log('--- ② 记忆：两层列表 / 忘掉 / 确认待办 ---');

/**
 * ★ 上一节的登出会 `localStorage.removeItem('workbench.token')`（那是它的断言之一），
 *   所以要挂第二遍 App 之前必须把登录态放回去 —— 否则会停在登录页，
 *   而记忆入口（以及设置块）整个在 `{curAgent && (…)}` 里，条件永远不成立。
 */
dom.window.localStorage.setItem('workbench.token', 'smoke-token');
const rootMem = createRoot(doc.getElementById('root') as HTMLElement);
await act(async () => {
  rootMem.render(React.createElement(App));
});
await flush();

await check('三个入口显示服务端返回的条数（用户 2 / 项目 1 / 待确认 2）', async () => {
  await waitFor('记忆入口出现', () => doc.body.textContent!.includes('用户记忆（2）'));
  const labels = qa('aside.sidebar .btn').map((b) => b.textContent ?? '').filter((t) => /用户记忆|项目记忆|待确认/.test(t));
  assert.ok(labels.some((t) => t.includes('用户记忆（2）')), `用户记忆条数不对：${labels.join(' | ')}`);
  assert.ok(labels.some((t) => t.includes('项目记忆（1）')), `项目记忆条数不对：${labels.join(' | ')}`);
  assert.ok(labels.some((t) => t.includes('待确认（2）')), `待确认条数不对：${labels.join(' | ')}`);
});

await check('展开用户记忆：列出两条，且「忘掉」走 POST /memory/forget（带 layer 与 id）', async () => {
  const btn = qa('aside.sidebar .btn').find((b) => (b.textContent ?? '').includes('用户记忆'));
  click(btn ?? null, '用户记忆入口');
  await flush(3);
  const rows = qa('.memList__row');
  assert.equal(rows.length, 2, `用户记忆行数不对：${rows.length}`);
  assert.match(q('.memList')?.textContent ?? '', /用户偏好：回答用中文/, '内容没渲染出来');

  click(qa('.memList__forget')[0], '忘掉第一条');
  await waitFor('发出 /memory/forget', () => requests.some((r) => r.path === '/memory/forget'));
  const req = requests.filter((r) => r.path === '/memory/forget').pop()!;
  assert.equal(req.method, 'POST', `方法不对：${req.method}`);
  const body = JSON.parse(String(req.body)) as { layer: string; id: number };
  assert.deepEqual(body, { layer: 'user', id: 301 }, `body 不对：${JSON.stringify(body)}`);
});

await check('待确认：点「确认」走 POST /memories/confirm（{ids:[id]}），该条立刻消失，并回一句人话', async () => {
  const btn = qa('aside.sidebar .btn').find((b) => (b.textContent ?? '').includes('待确认'));
  click(btn ?? null, '待确认入口');
  await flush(3);
  const before = qa('.memList__row--pending').length;
  assert.equal(before, 2, `待确认行数不对：${before}`);

  click(qa('.memList__confirm')[0], '确认第一条');
  await waitFor('发出 /memories/confirm', () => requests.some((r) => r.path === '/memories/confirm'));
  await flush(3);
  const after = qa('.memList__row--pending').length;
  assert.equal(after, before - 1, `确认后没有立刻少一条（${before} → ${after}）`);
  const req = requests.filter((r) => r.path === '/memories/confirm').pop()!;
  const body = JSON.parse(String(req.body)) as { ids?: number[] };
  assert.deepEqual(body, { ids: [321] }, `body 不对：${JSON.stringify(body)}`);
  assert.match(doc.body.textContent ?? '', /已确认一条记忆，今后会按它执行。/, '聊天流里没有人话提示');
});

const memRequestCount = requests.length;
await act(async () => rootMem.unmount());
log(`  （记忆这节发出 ${memRequestCount} 条请求）`);

// ---------------------------------------------------------------------------
// ③ app/browserGlue（片 3）—— 求助卡 / 确认卡 / 跨 chat×browser 的视图同步
// ---------------------------------------------------------------------------
log('');
log('--- ③ 胶水：求助卡与「上下文没了」确认卡 ---');

/**
 * ★ 这一节要「主进程真的送事件进来」，所以必须有一次**当前还在挂着**的 App：
 *   上一节最后 `rootMem.unmount()` 时 App 的订阅会退订（handlers 里就没有 'agent' 了）。
 *   于是这里挂第三遍（登录态同样要先放回 localStorage）。
 */
dom.window.localStorage.setItem('workbench.token', 'smoke-token');
const rootGlue = createRoot(doc.getElementById('root') as HTMLElement);
await act(async () => {
  rootGlue.render(React.createElement(App));
});
await flush(4);
await waitFor('第三个 App 起来（侧栏在）', () => !!q('aside.sidebar'));

await check('主进程说「AI 求助」→ 聊天区长出求助卡（文案与类型都对）', async () => {
  emitAgent({ kind: 'help', wcId: 4242, helpKind: 'captcha', question: '这个滑块我过不去', hint: '请帮她拖一下' });
  await flush(3);
  const card = q('.helpCard');
  assert.ok(card, '求助卡没渲染出来（helpCards 分桶或 showHelp 抽坏了）');
  assert.match(card!.textContent ?? '', /这个滑块我过不去/, '问题文案没渲染');
  assert.match(card!.textContent ?? '', /请帮她拖一下/, '提示文案没渲染');
  assert.match(card!.className, /helpCard--captcha/, `求助类型不对：${card!.className}`);
});

await check('点「我处理好了，继续」→ 走既有通道 resumeTask(wcId)，卡片立刻收起', async () => {
  bridgeCalls.length = 0;
  click(q('.helpCard__done'), '我处理好了，继续');
  await waitFor('resumeTask 被调用', () => bridgeCalls.some((c) => c.startsWith('resumeTask(')));
  await flush(3);
  assert.deepEqual(bridgeCalls, ['resumeTask(4242)'], `通道调用不对：${JSON.stringify(bridgeCalls)}`);
  // ★ DOM 元素**不许**进断言库（失败时 Node 会去 inspect jsdom 环形巨图 → OOM 137）
  assert.ok(q('.helpCard') === null, '点了按钮卡片还留着（点不动的卡）');
});

await check('「AI 求助已解除」事件 → 卡片收起（收卡片这条路也要真的通）', async () => {
  emitAgent({ kind: 'help', wcId: 4243, helpKind: 'login', question: '要你登录一下', hint: '你自己登录' });
  await flush(3);
  assert.ok(q('.helpCard'), '前提不成立：卡片没长出来');
  emitAgent({ kind: 'help-clear', wcId: 4243 });
  await flush(3);
  assert.ok(q('.helpCard') === null, 'clear 事件之后卡片还留着');
});

await check('主进程说「这一轮的上下文没了」→ 弹出确认卡，点「重新开始」回主进程并收卡', async () => {
  /**
   * ★ 这张卡画在**浏览器层里面**（`{browser.allTabs.length > 0 && (… {loopGone && …} …)}`），
   *   所以先走真实路径开一张页（主进程 open 事件 → browser.openFromMain → openUrl），
   *   否则 `.loopGone` 永远查不到 —— 那不是抽错，是前置条件不成立。
   */
  await act(async () => {
    assert.equal(emitBridge('open', 'https://example.com/'), 1, 'bridge.on("open") 没注册处理函数');
  });
  await waitFor('浏览器层出现', () => q('.browserLayer') !== null);

  bridgeCalls.length = 0;
  emitAgent({ kind: 'loop-gone', wcId: 4244, question: '这一轮的上下文没了，要重新开始吗？' });
  await flush(3);
  const card = q('.loopGone');
  assert.ok(card, '确认卡没渲染出来（loopGone 抽坏了）');
  assert.match(card!.textContent ?? '', /这一轮的上下文没了/, '问话没渲染');

  click(q('.loopGone__warn'), '重新开始');
  await waitFor('loopGoneChoice 被调用', () => bridgeCalls.length > 0);
  await flush(2);
  assert.deepEqual(bridgeCalls, ['loopGoneChoice(4244, restart)'], `通道调用不对：${JSON.stringify(bridgeCalls)}`);
  assert.ok(q('.loopGone') === null, '点完还留着卡 —— 会是一张点不动的卡');
});

/** ★ 切项目前后必须还是**同一个节点**（不是"又渲染出一个一样的"）——`browser/` 那套位置计算全指着它 */
const heldLayer = q('.browserLayer');
const heldWebview = q('webview');

await check('useBrowserGlue：切智能体时视图跟着切（有卡进 embed / 没卡也恒调 exitEmbed）', async () => {
  const calls: string[] = [];
  const fakeBrowser = {
    enterEmbed: (wcId: number) => calls.push(`enterEmbed(${wcId})`),
    exitEmbed: () => calls.push('exitEmbed()'),
    refreshDriving: () => calls.push('refreshDriving()'),
  };
  let api: { showHelp: (c: unknown) => void } | null = null;
  /**
   * ★ Host 把 `curHelp` **渲染出来**：只断言 browser 调用的话，
   *   「curHelp 拿别人对话的卡」这种抽错看不见（effect 读的是 helpCards 本身，不是 curHelp）——
   *   那就是假绿。这里把「聊天区该画哪张卡」这个可观察结果也摆上台面。
   */
  function Host({ agentId }: { agentId: number }) {
    api = useBrowserGlue({ browser: fakeBrowser, curAgentId: agentId, onNote: () => {} });
    const help = (api as unknown as { curHelp: { wcId: number } | null }).curHelp;
    return React.createElement('span', { id: 'curHelpView' }, help ? `卡:${help.wcId}` : '没卡');
  }
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const hostRoot = createRoot(host);
  await act(async () => {
    hostRoot.render(React.createElement(Host, { agentId: 97 }));
  });
  await flush(2);
  calls.length = 0;

  // 97 号还没有卡 → 仍然必须恒调 exitEmbed（就是那条「时序破口」的正解）
  await act(async () => {
    hostRoot.render(React.createElement(Host, { agentId: 98 }));
  });
  await flush(2);
  assert.deepEqual(calls, ['exitEmbed()'], `没卡时应当只调一次 exitEmbed：${JSON.stringify(calls)}`);

  // 给 97 号挂一张卡，再切回它 → enterEmbed 那张页
  calls.length = 0;
  await act(async () => {
    api!.showHelp({ wcId: 4242, agentId: 97, helpKind: 'captcha', question: 'q', hint: 'h' });
  });
  await flush(2);
  // 卡片桶变了 → 这个 effect 会重跑；当前对话（98）没卡 ⇒ 按语义仍然恒调 exitEmbed（安全 no-op）
  assert.deepEqual(calls, ['exitEmbed()'], `挂别的对话的卡时不该进 embed：${JSON.stringify(calls)}`);
  // ★ 「不做跨对话提醒」：97 号的卡绝不许画在 98 号的对话里
  assert.equal(host.textContent, '没卡', `97 号的求助卡漏到 98 号对话里了：${host.textContent}`);
  calls.length = 0;
  await act(async () => {
    hostRoot.render(React.createElement(Host, { agentId: 97 }));
  });
  await flush(2);
  assert.deepEqual(calls, ['enterEmbed(4242)'], `切回有卡的对话应进 embed：${JSON.stringify(calls)}`);
  assert.equal(host.textContent, '卡:4242', `切回自己的对话反而看不到卡：${host.textContent}`);

  await act(async () => hostRoot.unmount());
  host.remove();
});


// ---------------------------------------------------------------------------
// ⑤ features/projects（片 4）—— 列表 / 切换 / 新建，以及「切项目绝不碰浏览器」
// ---------------------------------------------------------------------------
log('');
log('--- ⑤ 项目：列表 / 切换（名单与资料一起换）/ 新建 ---');

/** 项目面板的展开按钮（文案里带「项目」二字） */
const projectToggle = (): Element | null => qa('aside.sidebar .btn').find((b) => (b.textContent ?? '').includes('项目')) ?? null;

await check('项目面板列出两个项目，当前那个标着「使用中」', async () => {
  click(projectToggle(), '项目面板入口');
  await flush(3);
  const rows = qa('.projectBox__row');
  assert.equal(rows.length, 2, `项目行数不对：${rows.length}`);
  const on = qa('.projectBox__row').filter((r) => r.className.includes('contact--on'));
  assert.equal(on.length, 1, `「使用中」的项目应当只有一个：${on.length}`);
  assert.match(on[0].textContent ?? '', /默认项目/, `使用中的不是 7 号：${on[0].textContent}`);
});

await check('点 8 号项目 → POST /projects/8/activate（body {}），随后按新项目重拉名单与资料', async () => {
  const before = requests.length;
  const row = qa('.projectBox__row').find((r) => r.getAttribute('data-project-id') === '8');
  click(row ?? null, '8 号项目');
  await waitFor('发出 activate', () => requests.some((r) => r.path === '/projects/8/activate'));
  await flush(4);
  const act = requests.filter((r) => r.path === '/projects/8/activate').pop()!;
  assert.equal(act.method, 'POST', `方法不对：${act.method}`);
  assert.equal(String(act.body), '{}', `activate 的 body 必须是空对象：${String(act.body)}`);
  // 名单与资料都按 8 号项目重拉
  assert.ok(requests.slice(before).some((r) => r.path === '/agents' && r.path === '/agents'), '没重拉名单');
  assert.ok(requests.some((r) => r.path === '/agents'), '没拉过 /agents');
  assert.match(q('aside.sidebar .agentList')?.textContent ?? '', /卡布/, '侧栏名单没换成 8 号项目的人');
  const memBtns = qa('aside.sidebar .btn').map((b) => b.textContent ?? '');
  assert.ok(memBtns.some((t) => t.includes('项目记忆（0）')), `切项目后项目记忆应当清空：${memBtns.filter((t) => t.includes('项目记忆')).join('|')}`);
});

await check('★ 切项目绝不碰浏览器：那一层与那一个 <webview> 还在，且是同一个节点', async () => {
  const layer = q('.browserLayer');
  const wv = q('webview');
  assert.ok(layer, '切项目把浏览器层弄没了（第 20 步的规矩：所有页一直挂着）');
  assert.ok(wv, '切项目把 <webview> 卸载了（这条是硬规则）');
  // 节点身份：还是**切换前那个元素对象**（不是"又渲染出一个一样的"）
  sameNode(layer, heldLayer, '浏览器层不是原来那个节点（被重建了）');
  sameNode(wv, heldWebview, '<webview> 不是原来那个节点（被重建了）');
});

await check('新建项目 → POST /projects（body 带名字）→ 进入新项目（顺带钉住 F1：提示会被刷新清掉）', async () => {
  const input = q('.projectBox__name');
  assert.ok(input, '新项目名字输入框不见了');
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, '我的新项目');
    input!.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await flush(2);
  click(q('.projectBox__create'), '新建项目');
  await waitFor('发出 POST /projects', () => requests.some((r) => r.path === '/projects' && r.method === 'POST'));
  await flush(4);
  const req = requests.filter((r) => r.path === '/projects' && r.method === 'POST').pop()!;
  const body = JSON.parse(String(req.body)) as { name?: string };
  assert.equal(body.name, '我的新项目', `建项目的 body 不对：${JSON.stringify(body)}`);
  assert.match(q('aside.sidebar .agentList')?.textContent ?? '', /小鸡/, '没有进到新项目（名单还是旧的）');
  /**
   * ★ 发现 F1（**既有**行为，不是本片抽坏的）：`createProject` 里那句
   *   「项目「X」建好了…」紧接着被 `loadProjects()` 末尾的 `setProjectNote('')` 清掉 ——
   *   界面上等于没有确认。抽 hook 时**逐字保留**了这个顺序（重构片不许顺手改产品行为），
   *   这条断言就是把这个事实钉住：note 现在是空的。要不要改由用户拍。
   */
  assert.ok(!q('.projectBox__note'), `新建项目的提示被随后的刷新清掉了（既有行为，见 F1）：${q('.projectBox__note')?.textContent}`);
});

await act(async () => rootGlue.unmount());

// ---------------------------------------------------------------------------
// ④ 直接挂真实 hook：会话切换期间「晚到的旧响应不许覆盖新列表」（真 hook，不是副本）
//    （这条守卫写在 useKnowledge.load 里，App 级别很难稳定触发，所以在真实 hook 上验）
// ---------------------------------------------------------------------------
log('');
log('--- ④ 挂在真实 hook 上的守卫（不是副本）---');

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


await check('useMemory：切走智能体后，A 号的慢响应不许覆盖项目记忆', async () => {
  const sessionRef = { current: { token: 'tok-A' } } as unknown as { current: { token: string } | null };
  const curAgentRef = { current: 97 as number | null };
  const notes: string[] = [];
  let api: { project: { id: number }[]; loadProject: (id: number) => Promise<void> } | null = null;

  const realFetch = globalThis.fetch;
  let release: (() => void) | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const raw = typeof input === 'string' ? input : (input as Request).url;
    const path = raw.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const m = /^\/agents\/(\d+)\/memory$/.exec(path);
    if (!m) return realFetch(input as RequestInfo);
    await new Promise<void>((resolve) => { release = resolve; });
    return json({ items: [{ id: 999, content: '97 号的旧项目记忆', updatedAt: '' }] });
  }) as typeof fetch;

  function Host() {
    api = useMemory({ sessionRef: sessionRef as never, curAgentRef: curAgentRef as never, onNote: (t) => notes.push(t) });
    return null;
  }
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const hostRoot = createRoot(host);
  await act(async () => {
    hostRoot.render(React.createElement(Host));
  });
  await flush(2);

  const pending = api!.loadProject(97);   // 97 号发起，响应被挂住
  await flush(2);
  curAgentRef.current = 98;               // 期间切到了 98 号
  release?.();
  await pending;
  await flush(2);

  assert.deepEqual(
    (api as unknown as { project: { content: string }[] }).project.map((x) => x.content),
    [],
    '切走后 97 号的慢响应把项目记忆写进去了（守卫被删/被改坏）',
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
