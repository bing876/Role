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
    /**
     * ★ 主进程状态机镜像：**必须给真值**。
     *   缺了它 Proxy 兜底会返回 `undefined` → `bridge.getTaskState().then(setTask)` 把
     *   `task` 置成 undefined → `task.phase` 在渲染期炸（片 6 当场踩到，见 F3）。
     */
    getTaskState: async () => {
      if (bridgeMode.getTaskState === 'missing') return undefined;
      if (bridgeMode.getTaskState === 'null') return null;
      return { phase: 'idle', detail: '冒烟桩：等待主进程同步', step: 0, blocked: false };
    },
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
    /** 会话：登出/静默登录都要把凭证同步给主进程（不记就看不见这条清场动作） */
    syncSession: async (_apiBase: string, token: string) => {
      bridgeCalls.push(`syncSession('${token}')`);
    },
    /** 文档下载（主进程弹另存为 + 写盘）；这里固定"保存成功" */
    downloadDoc: async (taskId: number) => {
      bridgeCalls.push(`downloadDoc(${taskId})`);
      return { saved: true, path: '/home/user/任务-55.md' };
    },
    /** 分区白名单：登出必须清空，否则下一位登录者继承上一位的项目 */
    syncProjects: async (ids: number[]) => {
      bridgeCalls.push(`syncProjects([${ids.join(',')}])`);
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
/** F3 那节要用的开关：桥给的 task state 是空值 / 桥根本没这个方法 / 后端全挂 */
const bridgeMode = { getTaskState: 'ok' as 'ok' | 'missing' | 'null', backendDown: false };
/** 会话那一节要用的两个开关：让 /auth/me 失败、密码是否已经设过 */
let authMeFails = false;
let hasPassword = false;
/** 任务快照（默认"完成了但没读" → 红点亮着） */
let TASK: { id: number; status: string; goal: string; steps: string[]; unread: boolean; summary?: string; docTitle?: string; unreadHint?: string; outline?: string[] } | null = {
  id: 55, status: 'done', goal: '整理季度数据', steps: ['读表', '算数'], unread: true,
  summary: '一共 12 张表，结论在第 3 页', docTitle: '季度数据整理', unreadHint: '结果文档已生成', outline: ['目标', '过程', '结论'],
};
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  // ★ 模拟"后端重启那一瞬间"：所有 HTTP 直接失败（连接被拒）
  if (bridgeMode.backendDown) throw new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:8787');
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  const url = raw.replace(/^https?:\/\/[^/]+/, '');
  const path = url.split('?')[0];
  const method = (init?.method ?? 'GET').toUpperCase();
  requests.push({ method, path, body: init?.body });

  if (path === '/auth/me') {
    if (authMeFails) return new Response(JSON.stringify({ error: 'token 过期' }), { status: 401, headers: { 'content-type': 'application/json' } });
    return json({ user: { id: 1, phone: '13800000000', xyz: '', has_password: hasPassword }, project: PROJECT, agents: [{ id: 97, name: '小助' }] });
  }
  if (path === '/auth/password/set') {
    const b = JSON.parse(String(init?.body ?? '{}')) as { old_password?: string; new_password?: string };
    if (hasPassword && !b.old_password) {
      return new Response(JSON.stringify({ error: '已经设过密码了，要先验原密码' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    hasPassword = true;
    return json({ ok: true, message: '密码已设置，下次可以用 XYZ + 密码登录。' });
  }
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
  if (path === '/chat/history') {
    const qs2 = new URLSearchParams(url.split('?')[1] ?? '');
    const aid = Number(qs2.get('agentId') ?? '');
    if (aid === 98) return json({ conversationId: 502, messages: [{ id: 901, role: 'user', text: '八号的历史' }, { id: 902, role: 'assistant', text: '我是卡布' }] });
    return json({ conversationId: 501, messages: [{ id: 900, role: 'assistant', text: '九七号的历史' }] });
  }
  if (path === '/memory/user') return json({ items: USER_MEM });
  const pm = /^\/agents\/(\d+)\/memory$/.exec(path);
  if (pm) return json({ items: Number(pm[1]) === 97 ? PROJ_MEM : [] });
  if (path === '/memories') return json({ active: [], pending: [...PENDING_MEM] });
  if (path === '/memory/forget') return json({ ok: true });
  if (path === '/memories/confirm' || path === '/memories/reject') return json({ ok: true });
  if (path === '/agent/task/current') return json({ task: TASK });
  if (path === '/agent/task/read') {
    TASK = { ...TASK!, unread: false };
    return json({ ok: true });
  }
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
const { useChat } = await import('../../apps/desktop/src/features/chat');

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
/**
 * ★ 顶层前置条件检查：不成立时**不要让整张网崩掉**。
 *   崩掉的网只会给出 `等不到条件：xxx` 然后中断 —— 后面每一条断言都看不见，
 *   反证脚本也没法判断"到底咬住了哪条"。这里记一条 FAIL，然后继续跑，
 *   让后续断言各自把自己的失败原因说出来。
 */
async function ensure(name: string, pred: () => boolean): Promise<void> {
  try {
    await waitFor(name, pred);
  } catch (e) {
    fails += 1;
    log(`  ✗ 前置条件不成立：${name}`);
    log(`      ${(e as Error).message.split('\n')[0]}`);
  }
}
/**
 * ★ 「在登录页」不能用 `.authWrap` 判定 —— **"正在恢复登录状态…"那个占位页也是 `.authWrap`**，
 *   两者混在一起就会出现"身份卡在检查中也算回到登录页"的假绿（片 5 的反证 A2 当场抓到）。
 *   真登录页（`AuthScreen`）有 `.authTabs`，占位页没有。
 */
const onLoginScreen = (): boolean => !!q('.authWrap .authTabs');
const onCheckingScreen = (): boolean => (q('.authWrap')?.textContent ?? '').includes('正在恢复登录状态');
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
await ensure('第三个 App 起来（侧栏在）', () => !!q('aside.sidebar'));

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
// ⑥ features/auth（片 5）—— 静默登录 / 改密码 / 登出
// ---------------------------------------------------------------------------
log('');
log('--- ⑥ 会话：静默登录 / 改密码 / 登出 ---');

/** 挂一个干净的 App（每次都先把登录态放好，再挂） */
async function mountApp(withToken: boolean): Promise<ReturnType<typeof createRoot>> {
  if (withToken) dom.window.localStorage.setItem('workbench.token', 'smoke-token');
  else dom.window.localStorage.removeItem('workbench.token');
  /** ★ 每次都用**新的**容器：同一个容器重复 createRoot 会警告，且"卸载→再挂"行为不保证 */
  doc.querySelectorAll('#root').forEach((n) => n.remove());
  const host = doc.createElement('div');
  host.id = 'root';
  doc.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(App));
  });
  await flush(4);
  return root;
}

await check('有 token：静默登录成功 —— 不进登录页，token 留在本地', async () => {
  authMeFails = false;
  const root = await mountApp(true);
  await waitFor('离开登录页', () => !onLoginScreen() && !onCheckingScreen());
  assert.ok(dom.window.localStorage.getItem('workbench.token'), '静默登录成功后 token 不该被清掉');
  await act(async () => root.unmount());
});

await check('token 失效：踢回登录页、清掉本地 token、把主进程那份凭证也清掉', async () => {
  authMeFails = true;
  bridgeCalls.length = 0;
  const root = await mountApp(true);
  await waitFor('回到登录页（不是卡在"正在恢复登录状态"）', onLoginScreen);
  assert.ok(!dom.window.localStorage.getItem('workbench.token'), '过期 token 还留在本地（下次启动还会再撞一次）');
  assert.ok(bridgeCalls.some((c) => c.startsWith('syncSession(') && c.includes("''")), `没清主进程那份凭证：${JSON.stringify(bridgeCalls)}`);
  await act(async () => root.unmount());
  authMeFails = false;
});

await check('改密码：首次设置只送新密码，成功后页面上真的显示服务端那句话', async () => {
  hasPassword = false;
  const root = await mountApp(true);
  await waitFor('离开登录页', () => q('.authWrap') === null);
  /**
   * ★ 「我的号」那一块在 `{curAgent && (…)}` 里（与记忆/资料同一个面板），
   *   所以要等名单拉回来、有当前智能体之后，密码输入框才存在。
   */
  await waitFor('「我的号」面板出现', () => q('.account') !== null);
  const setVal = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
  const newInput = qa('input[placeholder="新密码（≥8 位）"]')[0];
  assert.ok(newInput, '找不到新密码输入框');
  await act(async () => {
    setVal.call(newInput, 'newpass123');
    newInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await flush(2);
  const btn = qa('button').find((b) => (b.textContent ?? '').includes('设置密码')) ?? null;
  click(btn, '设置密码');
  await waitFor('发出 /auth/password/set', () => requests.some((r) => r.path === '/auth/password/set'));
  await flush(3);
  const req = requests.filter((r) => r.path === '/auth/password/set').pop()!;
  const body = JSON.parse(String(req.body)) as Record<string, string>;
  assert.equal(body.new_password, 'newpass123', `新密码没送出去：${JSON.stringify(body)}`);
  assert.ok(!('old_password' in body), `首次设置不该要原密码：${JSON.stringify(body)}`);
  assert.match(doc.body.textContent ?? '', /密码已设置，下次可以用 XYZ \+ 密码登录。/, '服务端那句话没显示出来');
  assert.match(doc.body.textContent ?? '', /密码：已设置/, '本地的 has_password 没跟着更新（界面还说不认识密码）');
  await act(async () => root.unmount());
});

await check('改密码（已设过）：必须带原密码 —— 不带就会被服务端挡下并显示原因', async () => {
  const root = await mountApp(true);
  await waitFor('离开登录页', () => !onLoginScreen() && !onCheckingScreen());
  await waitFor('「我的号」面板出现', () => q('.account') !== null);
  const setVal = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
  const oldInput = qa('input[placeholder="原密码"]')[0];
  const newInput = qa('input[placeholder="新密码（≥8 位）"]')[0];
  assert.ok(oldInput && newInput, `密码输入框不全（原=${!!oldInput} 新=${!!newInput}）—— 已设过密码时必须有原密码那格`);
  await act(async () => {
    setVal.call(oldInput, 'oldpass123');
    oldInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    setVal.call(newInput, 'newpass456');
    newInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await flush(2);
  // 已设过密码时按钮文案变成「修改密码」—— 两种都认
  click(qa('button').find((b) => /设置密码|修改密码/.test(b.textContent ?? '')) ?? null, '设置/修改密码');
  await waitFor('发出第二次 /auth/password/set', () => requestsTo('/auth/password/set').length >= 2);
  await flush(3);
  /**
   * ★ 顺序有意如此：**先看用户能看见的东西**（页面上那句话），再看请求体。
   *   反过来的话，"body 少送原密码"这类注入会被请求体断言先拦住，
   *   于是"用户其实看到了失败"这个更重要的现象就永远不会被测到（片 5 的反证 A1 抓到的）。
   */
  assert.match(doc.body.textContent ?? '', /密码已设置/, '第二次改密码没成功（页面没显示成功文案）');
  const req = requests.filter((r) => r.path === '/auth/password/set').pop()!;
  const body = JSON.parse(String(req.body)) as Record<string, string>;
  assert.equal(body.old_password, 'oldpass123', `原密码没送出去：${JSON.stringify(body)}`);
  await act(async () => root.unmount());
});

await check('任务快照：红了红点、显示「未读」和结果摘要，点「查看结果」→ 标已读后红点熄灭', async () => {
  TASK = { ...TASK!, unread: true };
  // ★ 红点只画在「小助」那种 assistant 头像上；上一节把当前项目切到 9 号（名单里是 worker 小鸡），
  //   这里拨回 7 号，才是"有红点可看"的场景。
  currentProjectId = 7;
  const root = await mountApp(true);
  await waitFor('离开登录页', () => !onLoginScreen() && !onCheckingScreen());
  await waitFor('任务快照出现', () => q('.taskResult') !== null);
  assert.ok(q('.red-dot'), '服务端说未读，界面上却没有红点');
  assert.match(q('.taskResult')?.textContent ?? '', /未读|未读/, '没有未读标记');
  assert.match(q('.taskResult')?.textContent ?? '', /整理季度数据/, '目标没显示');

  click(qa('button').find((b) => (b.textContent ?? '').includes('查看结果')) ?? null, '查看结果');
  await waitFor('发出 /agent/task/read', () => requests.some((r) => r.path === '/agent/task/read'));
  await flush(3);
  // ★ 用户能看见的：红点熄灭 + 未读标记变成已读 + 摘要展开
  assert.ok(!q('.red-dot'), '标已读之后红点还亮着');
  assert.match(q('.taskResult')?.textContent ?? '', /已读/, '未读标记没变成已读');
  assert.match(q('.taskResult')?.textContent ?? '', /一共 12 张表/, '点开结果后摘要没显示');
  const readReq = requests.filter((r) => r.path === '/agent/task/read').pop()!;
  assert.equal(JSON.parse(String(readReq.body)).taskId, 55, `标已读没带对 taskId：${String(readReq.body)}`);
  await act(async () => root.unmount());
});

await check('下载文档：走主进程 downloadDoc，并把「已保存：路径」写在那一行', async () => {
  TASK = { ...TASK!, unread: false };
  bridgeCalls.length = 0;
  const root = await mountApp(true);
  await waitFor('离开登录页', () => !onLoginScreen() && !onCheckingScreen());
  await waitFor('任务快照出现', () => q('.taskResult') !== null);
  click(q('.docDownload'), '下载文档（.md）');
  await waitFor('downloadDoc 被调用', () => bridgeCalls.some((c) => c.startsWith('downloadDoc(')));
  await flush(3);
  assert.deepEqual(bridgeCalls.filter((c) => c.startsWith('downloadDoc(')), ['downloadDoc(55)'], `下载调的 taskId 不对：${JSON.stringify(bridgeCalls)}`);
  assert.match(doc.body.textContent ?? '', /已保存：\/home\/user\/任务-55\.md/, '下载成功后没有把保存路径写出来');
  await act(async () => root.unmount());
});

await check('F3-A：主进程状态机返回 undefined / null → 不白屏，且坏值不许覆盖好值', async () => {
  for (const mode of ['missing', 'null'] as const) {
    bridgeMode.getTaskState = mode;
    let root: ReturnType<typeof createRoot> | null = null;
    try {
      root = await mountApp(true);
      await flush(4);
      // ★ 用户可见的"不白屏" = 工作台三列还在
      assert.ok(q('aside.sidebar'), `桥返回 ${mode} 时整页白屏了`);
      assert.ok(q('main.middle'), `桥返回 ${mode} 时中栏没了`);
    } finally {
      if (root) await act(async () => root!.unmount());
      bridgeMode.getTaskState = 'ok';
    }
  }
});

await check('F3-A2：坏负载不许覆盖上一次的好状态（暂停横幅是用户可见的证据）', async () => {
  bridgeMode.getTaskState = 'ok';
  const root = await mountApp(true);
  await ensure('App 起来（侧栏在）', () => !!q('aside.sidebar'));
  assert.ok(!doc.body.textContent!.includes('你主动接管'), '前提不成立：一开始就有接管横幅');
  // 好负载 → 横幅出现
  emitBridge('state', JSON.stringify({ phase: 'paused', detail: '页面归你', step: 1, blocked: false, pausedBy: 'user' }));
  await flush(3);
  assert.match(doc.body.textContent ?? '', /你主动接管/, '正常广播没生效（防白屏把正常路径也挡了）');
  // 坏负载（合法 JSON 但是 null / 缺字段）→ 横幅必须还在（状态没被清掉、也没崩）
  emitBridge('state', 'null');
  emitBridge('state', JSON.stringify({ detail: '没有 phase' }));
  await flush(3);
  assert.match(doc.body.textContent ?? '', /你主动接管/, '坏负载把好状态覆盖掉了（应当忽略坏值，保持上一次的值）');
  assert.ok(q('aside.sidebar'), '坏负载把整页搞崩了');
  await act(async () => root.unmount());
});

await check('F3-C1（用户点名场景·冷启动撞上后端重启）：不白屏 —— 要么工作台、要么登录页', async () => {
  bridgeMode.backendDown = true;
  try {
    const root = await mountApp(true);
    await flush(8);
    const hasWorkbench = !!q('aside.sidebar');
    const hasLogin = onLoginScreen();
    assert.ok(hasWorkbench || hasLogin, `后端全挂时既没有工作台也没有登录页 —— 就是白屏`);
    assert.ok((doc.body.textContent ?? '').trim().length > 0, '页面上一个字都没有（白屏）');
    await act(async () => root.unmount());
  } finally {
    bridgeMode.backendDown = false;
  }
});

await check('F3-C2（用户点名场景·正用着后端重启）：工作台不白屏，主进程事件照旧落进聊天', async () => {
  bridgeMode.backendDown = false;
  const root = await mountApp(true);
  await ensure('App 起来（侧栏在）', () => !!q('aside.sidebar'));
  bridgeMode.backendDown = true; // ← 后端在这一刻重启
  // 主进程报「任务完成」：它不经过后端，聊天里那句话必须照旧出现
  emitAgent({ kind: 'done', wcId: 7001, summary: '整理完了' });
  await flush(4);
  assert.ok(q('aside.sidebar'), '后端重启时工作台白屏了 —— 批次 D 的续跑再好，用户也看不见界面');
  assert.match(doc.body.textContent ?? '', /任务完成：整理完了/, '主进程事件没能落进聊天（被后端拖累了）');
  /**
   * 红点：任务完成事件本来就该点亮它（与后端无关）。
   * ★ 这里验的是"主进程事件不被后端拖累"，而不是"不许亮" —— 写反了会假红（本网踩过）。
   */
  assert.ok(q('.red-dot'), '任务完成事件该点亮红点，却没亮（主进程事件被后端拖累了）');
  bridgeMode.backendDown = false;
  await act(async () => root.unmount());
});

await check('聊天（片 7a）：切智能体 → 按 agentId 拉历史，气泡真的画出来', async () => {
  currentProjectId = 7;
  const root = await mountApp(true);
  await ensure('App 起来（侧栏在）', () => !!q('aside.sidebar'));
  await ensure('当前智能体的历史拉回来了', () => (doc.body.textContent ?? '').includes('九七号的历史'));
  assert.match(doc.body.textContent ?? '', /九七号的历史/, '97 号的历史没渲染出来');
  // 切到 98 号（8 号项目里的「卡布」）→ 应当拉它的历史，且**不串**成 97 号的
  const other = qa('.contact[data-agent-id]').find((n) => n.getAttribute('data-agent-id') === '98');
  if (other) {
    click(other, '卡布');
    await flush(5);
    assert.ok(requestsTo('/chat/history').some((r) => r.path === '/chat/history'), '没发 /chat/history');
    assert.match(doc.body.textContent ?? '', /我是卡布/, '切过去没拉 98 号自己的历史');
  }
  await act(async () => root.unmount());
});

await check('useChat：resetChat 之后聊天桶必须空（登出/换号不残留上一个号的对话）', async () => {
  /**
   * ★ 这条原来写成"登出后页面里没有旧对话文字 || 请求过历史"—— **那是假绿**：
   *   后半个条件恒真（之前当然请求过历史），所以把 `resetChat` 里的清桶删掉也照样绿。
   *   现在改成把 hook 的桶计数**渲染出来**再断言（能看见的东西才配当证据）。
   */
  const sessionRef = { current: { token: 'tok-A' } } as { current: { token: string } | null };
  let api: { loadAgentHistory: (a: { id: number; conversationId: number | null }) => Promise<void>; resetChat: () => void } | null = null;
  function Host() {
    const chat = useChat({ sessionRef: sessionRef as never, curAgentId: 97, curAgentRef: { current: 97 } as never });
    api = chat as never;
    return React.createElement('span', { id: 'bucketView' }, `桶:${Object.keys(chat.chats).length}`);
  }
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const hostRoot = createRoot(host);
  await act(async () => {
    hostRoot.render(React.createElement(Host));
  });
  await flush(2);
  assert.equal(host.textContent, '桶:0', `一开始桶就该是空的：${host.textContent}`);

  await act(async () => {
    await api!.loadAgentHistory({ id: 97, conversationId: 501 });
  });
  await flush(2);
  assert.equal(host.textContent, '桶:1', `拉了历史之后桶里应当有 1 份：${host.textContent}`);

  await act(async () => {
    api!.resetChat();
  });
  await flush(2);
  assert.equal(host.textContent, '桶:0', `resetChat 之后桶没清空（登出会残留上一个号的对话）：${host.textContent}`);

  await act(async () => hostRoot.unmount());
  host.remove();
});

await check('登出：退出登录 → 回登录页 + 清 token + 清主进程凭证 + 清分区白名单', async () => {
  bridgeCalls.length = 0;
  const root = await mountApp(true);
  try {
    await waitFor('离开登录页', () => !onLoginScreen() && !onCheckingScreen());
  } catch (e) {
    /** 失败时把关键现场打出来（"等不到条件"本身没有诊断价值） */
    console.log('  （诊断）', JSON.stringify({
      authWrap: q('.authWrap')?.textContent?.slice(0, 80),
      sidebar: !!q('aside.sidebar'),
      token: dom.window.localStorage.getItem('workbench.token'),
      backendDown: bridgeMode.backendDown,
      authMeCalls: requestsTo('/auth/me').length,
    }));
    throw e;
  }
  await waitFor('「我的号」面板出现', () => q('.account') !== null);
  click(qa('button').find((b) => (b.textContent ?? '').includes('退出登录')) ?? null, '退出登录');
  await waitFor('回到登录页', onLoginScreen);
  assert.ok(!dom.window.localStorage.getItem('workbench.token'), '登出后 token 还在本地');
  assert.ok(bridgeCalls.some((c) => c.includes('syncSession(')), `没清主进程凭证：${JSON.stringify(bridgeCalls)}`);
  assert.ok(bridgeCalls.some((c) => c.includes('syncProjects(')), `没清分区白名单：${JSON.stringify(bridgeCalls)}`);
  await act(async () => root.unmount());
});

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
await check('useChat：切号之后，A 号晚到的历史不许写进聊天桶', async () => {
  const sessionRef = { current: { token: 'tok-A' } } as { current: { token: string } | null };
  const curAgentRef = { current: 97 as number | null };
  let api: { chats: Record<number, { messages: { text: string }[] }>; loadAgentHistory: (a: { id: number; conversationId: number | null }) => Promise<void> } | null = null;

  const realFetch = globalThis.fetch;
  let release: (() => void) | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const raw = typeof input === 'string' ? input : (input as Request).url;
    const path = raw.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (path !== '/chat/history') return realFetch(input as RequestInfo);
    await new Promise<void>((resolve) => { release = resolve; });
    return json({ conversationId: 501, messages: [{ id: 1, role: 'assistant', text: 'A 号的旧历史' }] });
  }) as typeof fetch;

  function Host() {
    api = useChat({
      sessionRef: sessionRef as never,
      curAgentId: 97,
      curAgentRef: curAgentRef as never,
    });
    return null;
  }
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const hostRoot = createRoot(host);
  await act(async () => {
    hostRoot.render(React.createElement(Host));
  });
  await flush(2);

  const pending = api!.loadAgentHistory({ id: 97, conversationId: 501 });
  await flush(2);
  sessionRef.current = { token: 'tok-B' }; // 期间切了号
  release?.();
  await pending;
  await flush(2);
  assert.deepEqual(Object.keys(api!.chats), [], '切号后 A 号晚到的历史写进了聊天桶（守卫被删/被改坏）');

  globalThis.fetch = realFetch;
  await act(async () => hostRoot.unmount());
  host.remove();
});

log('');
log('=== 结论 ===');
log(`  ${passes} PASS / ${fails} FAIL`);
log(`  （期间发出 ${requests.length} 条真实请求）`);
/**
 * ★ 收尾：jsdom + 多轮挂载/卸载会留下计时器句柄，进程可能**挂着不退出**
 *   （反证脚本的 subprocess 会一直等 —— 表现为"假死"，非常难查）。
 *   所以打印完结论后用一个小计时器显式退出：既给 stdout 留出冲刷时间，也不拖住调用方。
 */
setTimeout(() => process.exit(fails > 0 ? 1 : 0), 50);
