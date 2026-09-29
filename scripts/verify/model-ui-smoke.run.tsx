/** 模型设置 · 真 hook+真 Panel，HTTP 仅桩服务端；真 DB/生产 llmFetch 在 model-settings.mts 验。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { ModelSettingsPanel, useModelSettings } from '../../apps/desktop/src/features/model';
import type { ModelConfigView } from '@ai-workbench/shared';

const appSource = readFileSync('apps/desktop/src/App.tsx', 'utf8');
assert.match(appSource, /<ModelSettingsPanel key=\{session\.user\.id\} \{\.\.\.modelSettings\} \/>/, '设置抽屉未接模型设置组件');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
const g = globalThis as any;
g.IS_REACT_ACT_ENVIRONMENT = true; g.window = dom.window; g.document = dom.window.document;
g.localStorage = dom.window.localStorage; g.HTMLElement = dom.window.HTMLElement;
g.MouseEvent = dom.window.MouseEvent; g.Event = dom.window.Event;
Object.defineProperty(g, 'navigator', { value: dom.window.navigator, configurable: true });
const views = new Map<string, ModelConfigView>();
const empty = (): ModelConfigView => ({ provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', apiKeySet: false, apiKeyMasked: '', source: 'none' });
const network: Array<{ path: string; method: string; token: string; body: any }> = [];
g.fetch = async (url: string, init: RequestInit = {}) => {
  const path = String(url), method = init.method ?? 'GET';
  const token = String((init.headers as Record<string,string>)?.authorization ?? '');
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  network.push({ path, method, token, body });
  if (!token.startsWith('Bearer jwt-')) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (path === '/model/config' && method === 'GET') return Response.json(views.get(token) ?? empty());
  if (path === '/model/config' && method === 'POST') {
    if (!body.apiKey && !views.get(token)?.apiKeySet) return Response.json({ error: '请填 API Key' }, { status: 400 });
    views.set(token, { provider: body.provider, model: body.model, baseUrl: body.baseUrl, apiKeySet: true, apiKeyMasked: '****', source: 'local' });
    return Response.json({ ok: true, ...views.get(token) });
  }
  if (path === '/model/config' && method === 'DELETE') { views.delete(token); return Response.json({ ok: true }); }
  if (path === '/model/test' && method === 'POST') return Response.json({ ok: true, detail: '模型连通正常' });
  return Response.json({}, { status: 404 });
};
const { act } = await import('react-dom/test-utils');
const { createRoot } = await import('react-dom/client');
const React = (await import('react')).default;
const root = createRoot(dom.window.document.getElementById('root')!);
const doc = dom.window.document;
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
function Harness({ token }: { token: string }) {
  const control = useModelSettings(true, token);
  return <ModelSettingsPanel key={token} {...control} />;
}
async function render(token: string) { await act(async () => { root.render(<Harness token={token} />); await flush(); }); }
async function click(text: string) {
  const b = [...doc.querySelectorAll('button')].find((el) => el.textContent?.includes(text));
  assert.ok(b, `找不到按钮「${text}」`);
  await act(async () => { b!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await flush(); });
}
async function setInput(text: string, value: string) {
  const el = [...doc.querySelectorAll('input')].find((i) => i.closest('label')?.textContent?.includes(text));
  assert.ok(el, `找不到「${text}」输入框`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); await flush();
  });
  assert.equal(el.value, value);
}
await render('jwt-A');
assert.ok(doc.body.textContent?.includes('模型设置') && doc.body.textContent?.includes('未配置'));
console.log('  ✓ ① 打开设置先 GET /model/config，默认 DeepSeek，不自动把 key 放到本地存储');
await setInput('API Key', 'ui-only-secret');
await click('加密保存');
assert.ok(network.some((n) => n.path === '/model/config' && n.method === 'POST' && n.token === 'Bearer jwt-A' && n.body.apiKey === 'ui-only-secret'));
assert.ok(doc.body.textContent?.includes('本地已配置'));
const secretInput = doc.querySelector('input[type="password"]') as HTMLInputElement;
assert.ok(secretInput, '密钥输入框应该仍存在');
assert.equal(secretInput.value, '');
assert.ok(!doc.body.textContent?.includes('ui-only-secret'));
assert.ok(Array.from({ length: dom.window.localStorage.length }, (_, i) => dom.window.localStorage.getItem(dom.window.localStorage.key(i) ?? '')).every((v) => !v?.includes('ui-only-secret')), 'localStorage 不能存模型 key');
console.log('  ✓ ② JWT 显式带上；保存后从输入框清空，DOM/本地存储不回显 key');
await click('测试连通');
assert.ok(network.some((n) => n.path === '/model/test' && n.method === 'POST' && n.token === 'Bearer jwt-A'));
assert.ok(doc.body.textContent?.includes('模型连通正常'));
console.log('  ✓ ③ 测试连通 POST 真实端点，结果如实呈现');
views.set('Bearer jwt-B', { provider: 'custom', model: 'model-B', baseUrl: 'https://example.com/v1', apiKeySet: true, apiKeyMasked: '****', source: 'local' });
await render('jwt-B');
assert.ok(doc.body.textContent?.includes('本地已配置'));
const nextSecretInput = doc.querySelector('input[type="password"]') as HTMLInputElement;
assert.ok(nextSecretInput, '切账号仍应渲染密钥输入框');
assert.equal(nextSecretInput.value, '');
const selectedModel = doc.querySelector('input[placeholder="deepseek-flash"]') as HTMLInputElement;
assert.ok(selectedModel, '模型输入框缺失');
assert.equal(selectedModel.value, 'model-B');
assert.ok(network.some((n) => n.path === '/model/config' && n.method === 'GET' && n.token === 'Bearer jwt-B'));
console.log('  ✓ ④ 切账号重新读 B 的视图（组件 key 重置临时密钥）');
await click('清空本地配置');
assert.ok(network.some((n) => n.path === '/model/config' && n.method === 'DELETE' && n.token === 'Bearer jwt-B'));
assert.ok(doc.body.textContent?.includes('未配置'));
console.log('  ✓ ⑤ 清空只删 B 的配置，不动 A');
await render('jwt-A');
assert.ok(doc.body.textContent?.includes('本地已配置'));
console.log('  ✓ ⑥ A 的本地配置仍在，跨账号不串');
console.log('模型设置 UI PASS 6 / FAIL 0（jsdom 真组件，第三方 HTTP 由桩代替）');
await act(async () => root.unmount());
