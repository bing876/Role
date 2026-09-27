/** 首跑 UI · 真 feature，通过主进程桥传密码（绝不把 bootstrap secret 暴露给网页）。 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { AuthScreen } from '../../apps/desktop/src/features/auth';
import type { AuthSession } from '@ai-workbench/shared';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
const g = globalThis as any;
g.IS_REACT_ACT_ENVIRONMENT = true; g.window = dom.window; g.document = dom.window.document;
g.localStorage = dom.window.localStorage; g.HTMLElement = dom.window.HTMLElement;
g.MouseEvent = dom.window.MouseEvent; g.Event = dom.window.Event;
Object.defineProperty(g, 'navigator', { value: dom.window.navigator, configurable: true });
const doc = dom.window.document;
const session = { token: 'jwt-local-example', user: { id: 4, xyz_id: 'XYZ12345', has_password: true, phone_masked: null },
  project: { id: 2, name: '默认项目' }, agents: [{ id: 3, name: '小助' }] } as AuthSession;
let available = true;
let createdWith = '';
let synced = '';
let syncedBase = '';
let owned = true;
let entered: AuthSession | null = null;
const network: Array<{ url: string; method: string }> = [];
dom.window.workbench = {
  isElectron: true,
  isPackaged: true,
  createLocalAccount: async (password: string) => { createdWith = password; available = false; return session; },
  syncSession: async (base: string, token: string) => { syncedBase = base; synced = token; return { ok: true, hasToken: true }; },
  serverStatus: async () => ({ reachable: owned, ownedByUs: owned, lastError: owned ? null : '端口被占用' }),
  onSmsMockCode: () => () => {},
} as any;
g.fetch = async (url: string, init?: RequestInit) => {
  const route = String(url), method = init?.method || 'GET';
  network.push({ url: route, method });
  if (route.endsWith('/health')) return Response.json({ service: 'ai-workbench-server', db: 'up' });
  if (route.endsWith('/auth/onboarding')) return Response.json({ available, local: true });
  if (route.endsWith('/auth/login/xyz') && method === 'POST') return Response.json(session);
  throw Error('UI 不应访问未经声明的服务端入口：' + route);
};
const { act } = await import('react-dom/test-utils');
const { createRoot } = await import('react-dom/client');
const React = (await import('react')).default;
const root = createRoot(doc.getElementById('root')!);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
async function show(key: string) {
  await act(async () => { root.render(<AuthScreen key={key} onSession={(s) => { entered = s; }} />); await flush(); await flush(); });
}
async function setInput(placeholder: string, value: string) {
  const input = doc.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement | null;
  assert.ok(input, `找不到输入框：${placeholder}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new dom.window.Event('input', { bubbles: true })); await flush();
  });
}
async function click(label: string) {
  const b = [...doc.querySelectorAll('button')].find((x) => x.textContent?.includes(label));
  assert.ok(b, `找不到按钮：${label}`);
  await act(async () => { b!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await flush(); });
}
// 端口被另一份服务占用时，即使它回同一个 /health 标记，也不能展示登录或发送 token。
dom.window.localStorage.setItem('workbench.apiBase', 'https://example.invalid/token-sink');
owned = false;
await show('occupied');
assert.equal(network.length, 0, '安装包端口被占用时不应请求别人的 /health / 登录端点');
assert.ok(!doc.body.textContent?.includes('第一次打开 · 建好本机工作台'));
assert.ok(!doc.body.textContent?.includes('快捷登录：一键演示账号'));
console.log('  ✓ ① 端口被占时真 AuthScreen 不访问外部服务，开发快捷登录也被安装包禁用');
owned = true;
await show('first');
assert.ok(network.every((r) => r.url.startsWith('http://127.0.0.1:8787/')),
  '安装包必须忽略旧 localStorage 自定义地址，不能把密码/JWT 发往外部');
assert.ok(doc.body.textContent?.includes('第一次打开 · 建好本机工作台'), '空库必须露出一次性引导而不是旧演示登录');
assert.ok(doc.body.textContent?.includes('不需要安装 PostgreSQL'));
const hasExistingLoginShell = doc.querySelector('.authWrap--login') !== null;
assert.equal(hasExistingLoginShell, true, '旧登录外观语义保留');
assert.ok(!doc.body.textContent?.includes('快捷登录：一键演示账号'));
console.log('  ✓ ② 真 AuthScreen 请求 GET 状态后显示首跑卡，原 authWrap--login 结构不卸载浏览器');
await setInput('本机密码（8–128 位）', 'ui-password-123');
await setInput('再输入一次密码', 'ui-password-123');
await click('建好并显示登录号');
assert.equal(createdWith, 'ui-password-123');
assert.ok(network.every((r) => r.method === 'GET'), 'renderer 不能直接 POST /auth/onboarding / 夹带 secret');
assert.equal(dom.window.localStorage.getItem('workbench.token'), null, '记下账号前不能自动进工作台');
assert.ok(doc.querySelector('[data-testid="local-xyz"]')?.textContent === 'XYZ12345');
assert.ok(doc.body.textContent?.includes('DeepSeek API Key'));
assert.ok(!doc.body.textContent?.includes('ui-password-123'));
console.log('  ✓ ③ 用户主动设密码，经 IPC 不经 HTTP；显示 XYZ 与下一步模型配置，不回显/持久化密码');
await click('我已记下，进入工作台');
assert.equal(dom.window.localStorage.getItem('workbench.token'), session.token);
assert.equal(synced, session.token);
assert.equal(syncedBase, 'http://127.0.0.1:8787', '主进程凭证同步也只允许本地后端');
assert.equal(entered?.user.xyz_id, session.user.xyz_id);
console.log('  ✓ ④ 看见并记住 XYZ 后才同步登录 token，未配置模型不自动发送消息');

// 新窗口/登出后是原 XYZ+密码登录（不是再次自动建号或强迫演示账号）。
entered = null;
await show('existing');
assert.ok(!doc.body.textContent?.includes('第一次打开 · 建好本机工作台'));
assert.ok(doc.body.textContent?.includes('XYZ号+密码'));
assert.ok(!doc.body.textContent?.includes('快捷登录：一键演示账号'));
await setInput('XYZ 号（如 XYZ10001，也可只输数字）', session.user.xyz_id);
await setInput('密码（≥8 位）', 'ui-password-123');
await click('登录');
assert.equal(entered?.user.xyz_id, session.user.xyz_id);
assert.ok(network.some((n) => n.url.endsWith('/auth/login/xyz') && n.method === 'POST'));
console.log('  ✓ ⑤ 已有账号回旧 XYZ 登录，安装包不显示开发演示按钮，老账号入口未删除');
console.log('上线 UI PASS 5 / FAIL 0（jsdom 真登录 feature，网络与 IPC 是隔离桩）');
await act(async () => root.unmount());
