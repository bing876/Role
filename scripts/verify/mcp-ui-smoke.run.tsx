/** 片2 · 挂真实 PluginsPanel/McpServersPanel，用 jsdom 点按钮、验真实 fetch 形状与密钥不回显。 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { PluginsPanel } from '../../apps/desktop/src/features/plugins/PluginsPanel';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
const g = globalThis as any;
g.IS_REACT_ACT_ENVIRONMENT = true;
g.window = dom.window; g.document = dom.window.document; g.localStorage = dom.window.localStorage;
Object.defineProperty(g, 'navigator', { value: dom.window.navigator, configurable: true }); g.HTMLElement = dom.window.HTMLElement;
g.MouseEvent = dom.window.MouseEvent; g.Event = dom.window.Event;
dom.window.localStorage.setItem('workbench.token', 'verify-jwt');

const apiCalls: Array<{ path: string; method: string; body?: any; auth: string }> = [];
let servers: any[] = [];
g.fetch = async (url: string, opts: RequestInit = {}) => {
  const path = String(url);
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(String(opts.body)) : undefined;
  apiCalls.push({ path, method, body, auth: (opts.headers as Record<string, string>)?.authorization });
  if (path === '/mcp/servers' && method === 'GET') return Response.json({ servers });
  if (path === '/mcp/servers' && method === 'POST') {
    servers = [{ id: 3, name: body.name, url: body.url, hasAuth: !!body.auth?.bearerToken,
      tools: [{ name: 'echo', description: '回声' }] }];
    return Response.json({ ok: true, id: 3, name: body.name, url: body.url, toolCount: 1 });
  }
  if (path === '/mcp/servers/3/test' && method === 'POST') return Response.json({ ok: true, detail: '连通正常（1 个工具）', count: 1 });
  if (path === '/mcp/servers/3' && method === 'DELETE') { servers = []; return Response.json({ ok: true, id: 3 }); }
  return Response.json({}, { status: 404 });
};
const { act } = await import('react-dom/test-utils');
const { createRoot } = await import('react-dom/client');
const React = (await import('react')).default;
const root = createRoot(dom.window.document.getElementById('root')!);
const doc = dom.window.document;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const click = async (text: string) => {
  const button = [...doc.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  assert.ok(button, `按钮「${text}」不存在：${doc.body.textContent?.slice(0, 400)}`);
  await act(async () => { button!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await flush(); });
};
const input = async (label: string, value: string) => {
  const el = [...doc.querySelectorAll('input')].find((i) => i.parentElement?.textContent?.includes(label));
  assert.ok(el, `输入框「${label}」不存在`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el!.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await flush();
  });
};
await act(async () => { root.render(<PluginsPanel plugins={[]} loaded err="" getConfig={async () => null}
  saveConfig={async () => ({ ok: true })} clearConfig={async () => true}
  testConfig={async () => ({ ok: true, detail: '' })} />); await flush(); });
assert.ok(doc.body.textContent?.includes('MCP 连接'));
await click('＋ 添加 MCP server');
await input('名称', '公用工具');
await input('Streamable HTTP 地址', 'https://example.com/mcp');
await input('Bearer token', 'test-secret-xyz');
await click('连接并拉取工具');
const posted = apiCalls.find((x) => x.method === 'POST' && x.path === '/mcp/servers');
assert.ok(posted, '按钮应真调用 POST /mcp/servers');
assert.equal(posted?.auth, 'Bearer verify-jwt');
assert.equal(posted?.body.name, '公用工具');
assert.equal(posted?.body.url, 'https://example.com/mcp');
assert.equal(posted?.body.auth.bearerToken, 'test-secret-xyz');
assert.ok(doc.body.textContent?.includes('echo'), '真从 GET 列表渲染服务端工具，不写死假数据');
assert.ok(!doc.body.textContent?.includes('test-secret-xyz'), 'token 不许回显');
await click('测试连通');
assert.ok(doc.body.textContent?.includes('连通正常（1 个工具）'));
await click('移除');
assert.ok(!doc.body.textContent?.includes('echo'), '移除后卡片消失');
assert.ok(apiCalls.some((x) => x.method === 'DELETE' && x.path === '/mcp/servers/3'));
console.log('MCP UI PASS 6/0：设置加 server → 真 fetch 请求 → 工具卡片 → 密钥不回显 → 测试 → 移除');
await act(async () => root.unmount());
