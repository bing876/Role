/** 抗改版片 · 真共享模型工具 → 服务端 sanitize → 桌面 mapper → 生产 core CDP 表达式
 * → 两版真实 HTML/jsdom click+type。无需安装 headless Chromium；真 Electron CDP 留真机验收。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { SEMANTIC_BROWSER_TOOL_DEFINITIONS } from '../../packages/shared/src/semanticTools';
import { serverToolRegistry, browserToolNamesFor, LOOP_TOOL_NAMES } from '../../apps/server/src/toolRegistry';
import { sanitizeToolCall } from '../../apps/server/src/toolLoop';
import { resolveBrowserAction } from '../../apps/desktop/electron/toolExecutors';
import { coreSemanticLocate, semanticResolveExpr } from '../../apps/desktop/electron/semantic-locate';
import { loadEnv } from '../../apps/server/src/env';
import { makeCipher } from '../../apps/server/src/crypto';
import { makePool, migrate } from '../../apps/server/src/db';
import { initOrchestrator } from '../../apps/server/src/orchestrator/tools';
import type { BrowserAction, SemanticTarget } from '../../packages/shared/src/index';

let passes = 0; let fails = 0;
async function check(label: string, test: () => void | Promise<void>) {
  try { await test(); passes++; console.log(`  ✓ ${label}`); }
  catch (err) { fails++; console.log(`  ✗ ${label}: ${(err as Error).message.slice(0, 400)}`); }
}
const CLICK = { target: '查看详情', semantic: { testId: 'view-detail', text: '查看详情', tag: 'button', within: 'form[data-app="catalog"]' } };
const TYPE = { target: '搜索商品', semantic: { ariaLabel: '搜索商品', text: '搜索商品', tag: 'input', within: 'form[data-app="catalog"]' }, text: '蓝色衬衫', submit: false };
const raw = (name: string, args: Record<string, unknown>) => ({ id: 'semantic-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }) as any;
function mapped(name: string, args: Record<string, unknown>): BrowserAction {
  const sanitized = sanitizeToolCall(raw(name, args), null);
  assert.equal(sanitized.ok, true, `服务端校验拒绝：${JSON.stringify(sanitized)}`);
  if (!sanitized.ok) throw Error('服务端校验失败');
  const action = resolveBrowserAction(sanitized.call);
  assert.ok(action, `桌面不认识语义工具 ${name}（必须拒绝，而不是回落猜）`);
  const def = serverToolRegistry.get(name);
  assert.ok(def?.toBrowserAction);
  assert.deepEqual(action, def!.toBrowserAction!(sanitized.call.args), 'shared/desktop 工具映射应完全相同');
  return action!;
}
function page(version: 'v1' | 'v2') {
  const src = readFileSync(new URL(`./fixtures/semantic/${version}.html`, import.meta.url), 'utf8');
  const dom = new JSDOM(src, { url: `https://example.test/${version}`, runScripts: 'outside-only', pretendToBeVisual: true });
  // jsdom 不做几何布局；只补尺寸（真实浏览器 getBoundingClientRect 自己有），逻辑仍跑生产 JS。
  dom.window.Element.prototype.getBoundingClientRect = function () {
    const hidden = dom.window.getComputedStyle(this).display === 'none';
    return { left: 10, top: 20, width: hidden ? 0 : 90, height: hidden ? 0 : 32, right: 100, bottom: 52, x: 10, y: 20, toJSON: () => ({}) };
  };
  return dom;
}
async function core(dom: JSDOM, sem: SemanticTarget) {
  return coreSemanticLocate(async (method, params: any) => {
    assert.equal(method, 'Runtime.evaluate');
    try { return { result: { value: dom.window.eval(params.expression) } }; }
    catch (e) { return { exceptionDetails: { text: String(e) } }; }
  }, sem);
}
function semanticElement(dom: JSDOM, action: BrowserAction): Element | null {
  if (action.action !== 'click' && action.action !== 'type') return null;
  assert.ok(action.semantic, '没有把 semantic 传给生产 driver');
  const result = dom.window.eval(semanticResolveExpr(JSON.stringify(action.semantic))) as { el: Element | null };
  return result.el;
}

console.log('=== 抗改版片 · 真 HTML 两版 + 模型工具→桌面动作→生产解析 ===');
// 真启动路径：initOrchestrator 才安装语义 v2 工具；无初始化/开关关闭仍冻结旧工具表。
process.env.DATABASE_URL = 'pglite://memory';
process.env.JWT_SECRET ??= 'semantic-wiring-jwt-secret';
process.env.DATA_KEY ??= 'k'.repeat(64);
process.env.PHONE_PEPPER ??= 'semantic-wiring-pepper';
const env = loadEnv();
const pool = await makePool(env.databaseUrl);
await migrate(pool);
initOrchestrator({ env, pool, cipher: makeCipher(env.dataKey) });
await check('① 新语义工具已在模型可调表；冻结旧 6 名与顺序不变', () => {
  assert.deepEqual(LOOP_TOOL_NAMES, ['open_url', 'read_page', 'click', 'type', 'scroll', 'stop']);
  const names = browserToolNamesFor({ orch: { enabled: true, agentLoopWebSearch: true } });
  assert.ok(names.includes('click_semantic') && names.includes('type_semantic'));
  assert.deepEqual(SEMANTIC_BROWSER_TOOL_DEFINITIONS.map((x) => x.name), ['click_semantic', 'type_semantic']);
});
await check('② click_semantic：模型→sanitize→桌面 mapper 真传 semantic', () => {
  const a = mapped('click_semantic', CLICK);
  assert.deepEqual(a, { action: 'click', ...CLICK });
});
await check('③ type_semantic：模型→sanitize→桌面 mapper 真传 semantic 和正文', () => {
  const a = mapped('type_semantic', TYPE);
  assert.deepEqual(a, { action: 'type', ...TYPE });
});
for (const version of ['v1', 'v2'] as const) {
  const dom = page(version);
  const form = dom.window.document.querySelector('form[data-app="catalog"]')!;
  const nav = dom.window.document.querySelector('nav button')!;
  let clicked: Element | null = null;
  (form.querySelector('button:nth-of-type(1)') as Element).addEventListener('click', () => { /* 取消或旧详情由真实元素事件辨别 */ });
  form.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { clicked = b; }));
  await check(`④ ${version} 真 HTML：click 找到表单内「查看详情」而非导航/取消，真实 DOM click`, async () => {
    const a = mapped('click_semantic', CLICK);
    assert.equal(a.action, 'click');
    if (a.action !== 'click') return;
    const found = await core(dom, a.semantic!);
    assert.equal(found.found, true, JSON.stringify(found));
    assert.equal(found.label, '查看详情');
    const el = semanticElement(dom, a);
    assert.ok(el && form.contains(el) && el !== nav && el.textContent?.trim() === '查看详情');
    (el as HTMLElement).click();
    assert.equal(clicked, el, '应向语义命中的真实元素发 click');
  });
  await check(`⑤ ${version} 真 HTML：type 找到搜索框，并触发真 input 事件`, async () => {
    const a = mapped('type_semantic', TYPE);
    assert.equal(a.action, 'type');
    if (a.action !== 'type') return;
    const found = await core(dom, a.semantic!);
    assert.equal(found.found, true, JSON.stringify(found));
    const el = semanticElement(dom, a) as HTMLInputElement;
    assert.ok(el && el.tagName === 'INPUT' && form.contains(el));
    let eventSeen = false;
    el.addEventListener('input', () => { eventSeen = true; });
    el.value = a.text;
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(el.value, '蓝色衬衫'); assert.ok(eventSeen);
  });
  if (version === 'v2') {
    await check('⑥ 旧 CSS 在改版页失效，新语义仍命中（真 DOM 反证）', () => {
      assert.ok(!dom.window.document.querySelector('.legacy-details'));
      assert.ok(!dom.window.document.querySelector('.legacy-input'));
      assert.ok(semanticElement(dom, mapped('click_semantic', CLICK)));
      assert.ok(semanticElement(dom, mapped('type_semantic', TYPE)));
    });
    await check('⑦ within 祖先找不到/无效时 fail-closed（不退全页误点导航）', async () => {
      const r = await core(dom, { text: '查看详情', tag: 'button', within: 'form[data-app="gone"]' });
      assert.equal(r.found, false);
      const invalid = await core(dom, { text: '查看详情', tag: 'button', within: 'form[broken' });
      assert.equal(invalid.found, false);
    });
  }
  dom.window.close();
}
await check('⑧ 点击支付语义 / 敏感输入语义：服务端硬闸拒绝', () => {
  const pay = sanitizeToolCall(raw('click_semantic', { target: '按钮', semantic: { text: '提交订单', tag: 'button' } }), null);
  assert.equal(pay.ok, false); if (!pay.ok) assert.equal(pay.reason, 'payment_confirm');
  const pwd = sanitizeToolCall(raw('type_semantic', { target: '框', semantic: { ariaLabel: '登录密码', tag: 'input' }, text: 'bad' }), null);
  assert.equal(pwd.ok, false); if (!pwd.ok) assert.equal(pwd.reason, 'sensitive_field');
});
await check('⑨ 没有定位字段/非法类型：拒绝，不下发', () => {
  for (const sem of [{ tag: 'button' }, { within: 'form' }, { ariaLabel: 123 }, null]) {
    const r = sanitizeToolCall(raw('click_semantic', { target: '目标', semantic: sem }), null);
    assert.equal(r.ok, false);
  }
});
await check('⑩ 老 click/type 无 semantic 映射照旧，额外语义新名无破坏性改动', () => {
  assert.deepEqual(resolveBrowserAction({ id: 'x', name: 'click', args: { target: '查看详情' } }), { action: 'click', target: '查看详情' });
  assert.deepEqual(resolveBrowserAction({ id: 'x', name: 'type', args: { target: '搜索商品', text: 'abc' } }),
    { action: 'type', target: '搜索商品', text: 'abc', submit: false });
});
console.log(`=== 抗改版片：PASS ${passes} / FAIL ${fails} ===`);
await pool.end();
process.exitCode = fails ? 1 : 0;
