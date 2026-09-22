/**
 * 内部频道面板的渲染验收 —— **真正跑起来的那一半**。
 *
 * 由 `orc-channels-ui.mts` 用 esbuild 打包后执行（因为要加载 `.tsx` 与 CSS 导入）。
 * 别直接 `tsx` 跑这个文件：CSS 导入在 Node 下加载不了。
 *
 * 这里做的事：
 *   起真实服务端（pglite + Fastify，真监听 127.0.0.1 的随机端口）
 *   → 造一条有 task/progress/reply/system 四类消息 + 一条超时委派的频道
 *   → jsdom 里渲染**真实的** `ChannelsPanel`
 *   → 断言屏幕上真的出现了该出现的东西、且没有出现不该出现的东西（输入框）
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// 1. jsdom 全局（必须在 import react-dom 之前铺好）
// ---------------------------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
/**
 * ★ `navigator` 必须用 defineProperty：Node 22 自带一个**只读 getter** 的 navigator 全局，
 *   直接赋值会抛 `Cannot set property navigator of #<Object> which has only a getter`。
 */
Object.defineProperty(g, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.MouseEvent = dom.window.MouseEvent;
g.getComputedStyle = dom.window.getComputedStyle;
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;

// 动态 import：全局铺好之后再拿 React（顺序错了会拿到没有 document 的那份）
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { ChannelsPanel } = await import('../../apps/desktop/src/channels/ChannelsPanel');

// ---------------------------------------------------------------------------
// 2. 真实服务端
// ---------------------------------------------------------------------------
const Fastify = (await import('fastify')).default;
const { makePool, migrate } = await import('../../apps/server/src/db');
const { makeCipher, signToken } = await import('../../apps/server/src/crypto');
const { registerChannelRoutes } = await import('../../apps/server/src/routes/channels');
const { ensureChannel, addChannelMessage, insertDelegation, finishDelegation } = await import(
  '../../apps/server/src/orchestrator/channels'
);
const { ORCH_DEFAULTS } = await import('../../apps/server/src/env');
type ServerEnv = import('../../apps/server/src/env').ServerEnv;

let fails = 0;
let passes = 0;
const log = (...a: string[]) => console.log(a.map(String).join(' '));
const check = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve()
    .then(fn)
    .then(() => {
      passes += 1;
      log(`  PASS ${name}`);
    })
    .catch((err) => {
      fails += 1;
      log(`  ★FAIL ${name}  —— ${(err as Error)?.message ?? String(err)}`);
    });

/** 等 React 把异步 fetch 的结果画上去（轮询 DOM，别靠固定 sleep 猜） */
async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
    if (pred()) return;
  }
  throw new Error(`等了 ${timeoutMs}ms 条件仍不成立`);
}

const ENV: ServerEnv = {
  port: 0,
  databaseUrl: 'pglite://memory',
  jwtSecret: 'x'.repeat(24),
  dataKey: 'y'.repeat(64),
  phonePepper: 'z'.repeat(24),
  smsMock: true,
  smsHttpUrl: '',
  isProduction: false,
  deepseekApiKey: 'test-key',
  deepseekBaseUrl: 'https://llm.test/v1',
  deepseekModel: 'test-model',
  agentLoopMaxSteps: 10,
  tavilyApiKey: '',
  tavilyBaseUrl: 'https://tavily.test',
  orch: ORCH_DEFAULTS,
};

async function main(): Promise<void> {
  log('=== 多智能体编排 · 内部频道面板渲染验收 ===');

  const pool = makePool('pglite://memory');
  await migrate(pool);
  const cipher = makeCipher(ENV.dataKey);

  await pool.query(`INSERT INTO users (id, xyz_id, phone_hash) VALUES (1,'x1','h1') ON CONFLICT (id) DO NOTHING`);
  await pool.query(`INSERT INTO projects (id, user_id, name, is_default) VALUES (10,1,'项目甲',true) ON CONFLICT (id) DO NOTHING`);
  await pool.query(
    `INSERT INTO agents (id, project_id, name, kind, persona) VALUES
       (101,10,'小助','assistant','{"name":"小助","who":"贴身助手","tone":"利落","duty":"日常事务"}'),
       (102,10,'母鸡','hen','{"name":"母鸡","who":"项目总管","tone":"稳重","duty":"统筹与研究"}')
     ON CONFLICT (id) DO NOTHING`,
  );

  const app = Fastify({ logger: false });
  registerChannelRoutes(app, { pool, env: ENV, cipher });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.addresses()[0];
  const apiBase = `http://127.0.0.1:${addr.port}`;
  const token = signToken({ sub: 1, xyz: 'u1' }, ENV.jwtSecret);

  // 一条完整的频道：派活 → 过程 → 交活；外加一条**超时**的委派（要能在界面上看出来）
  const chId = await ensureChannel(pool, { userId: 1, projectId: 10, agentA: 101, agentB: 102 });
  const d1 = await insertDelegation(pool, {
    userId: 1, projectId: 10, channelId: chId, fromAgentId: 101, toAgentId: 102,
    parentLoopId: 'loop_a', task: '把三家竞品的定价查一遍', status: 'running',
    deadlineAt: new Date(Date.now() + 600_000),
  });
  await addChannelMessage(pool, cipher, { channelId: chId, fromAgentId: 101, toAgentId: 102, kind: 'task', text: '把三家竞品的定价查一遍', delegationId: d1 });
  await addChannelMessage(pool, cipher, { channelId: chId, fromAgentId: 102, toAgentId: 101, kind: 'progress', text: '第 2 步：查了公开资料', delegationId: d1 });
  await addChannelMessage(pool, cipher, {
    channelId: chId, fromAgentId: 102, toAgentId: 101, kind: 'reply',
    text: '三家定价分别是 99 / 199 / 299，中位数 199', payload: { status: 'done', steps: 3 }, delegationId: d1,
  });
  await finishDelegation(pool, d1, { status: 'done', result: { summary: '三家定价 99 / 199 / 299', outline: ['甲 99', '乙 199', '丙 299'] } });

  const d2 = await insertDelegation(pool, {
    userId: 1, projectId: 10, channelId: chId, fromAgentId: 101, toAgentId: 102,
    parentLoopId: 'loop_b', task: '再查一遍渠道分销', status: 'running',
    deadlineAt: new Date(Date.now() - 1_000),
  });
  await finishDelegation(pool, d2, { status: 'timeout', error: '超过 10 分钟未完成' });
  await addChannelMessage(pool, cipher, {
    channelId: chId, fromAgentId: 102, toAgentId: 101, kind: 'system',
    text: '超过 10 分钟没有做完，这次委派按超时熔断处理', payload: { status: 'timeout', reason: 'timeout' }, delegationId: d2,
  });

  // ---------------------------------------------------------------------------
  // 3. 渲染真实组件
  // ---------------------------------------------------------------------------
  const host = dom.window.document.getElementById('root') as HTMLElement;
  const root = createRoot(host);
  // ★ 必须渲染成**元素**（`<ChannelsPanel …/>`），不能写成 `ChannelsPanel({...})` 直接调函数：
  //   后者是在 React 渲染阶段之外执行组件体，hook dispatcher 还是 null，
  //   `useState` 会直接抛 `Cannot read properties of null (reading 'useState')`。
  await act(async () => {
    root.render(<ChannelsPanel apiBase={apiBase} token={token} onClose={() => undefined} />);
  });

  const text = () => host.textContent ?? '';
  const html = () => host.innerHTML;

  log('');
  log('--- ① 频道列表 ---');
  await check('画出对方名字「母鸡」与条数', async () => {
    await waitFor(() => /母鸡/.test(text()));
    assert.ok(/母鸡/.test(text()), `界面里没有「母鸡」：${text().slice(0, 200)}`);
    assert.ok(/\d+ 条/.test(text()), `没画条数：${text().slice(0, 200)}`);
  });
  await check('画出最后一句预览（解密后的正文，不是密文）', () => {
    assert.ok(/超时熔断处理|99 \/ 199/.test(text()), `预览不对：${text().slice(0, 240)}`);
    assert.ok(!/gcm\$/.test(text()), '界面上出现了密文');
  });

  log('');
  log('--- ② 对话正文 ---');
  await check('★ 四类消息都画出来了（派活 / 过程 / 交活 / 系统）', async () => {
    await waitFor(() => /派活/.test(text()) && /交活/.test(text()));
    for (const kind of ['派活', '过程', '交活', '系统']) {
      assert.ok(text().includes(kind), `缺「${kind}」这一类`);
    }
  });
  await check('画出说话人与收话人（小助 → 母鸡）', () => {
    assert.ok(/小助/.test(text()) && /母鸡/.test(text()));
    assert.ok(/→/.test(text()), '没有「→ 收话人」的方向标记');
  });
  await check('★ 正文是**解密后的原文**，用户读得懂', () => {
    assert.ok(/三家定价分别是 99 \/ 199 \/ 299/.test(text()), `交活正文没画出来：${text().slice(0, 300)}`);
    assert.ok(/查了公开资料/.test(text()), '过程注记没画出来');
  });

  log('');
  log('--- ③ 委派记录 ---');
  await check('画出两条委派及其状态（已完成 / 超时未完成）', async () => {
    await waitFor(() => /超时未完成/.test(text()));
    assert.ok(/已完成/.test(text()), '没有「已完成」状态');
    assert.ok(/超时未完成/.test(text()), '没有「超时未完成」状态');
  });
  await check('★ 超时那条**如实写出原因**（不假装完成）', () => {
    assert.ok(/超过 10 分钟未完成/.test(text()), `超时原因没画出来：${text().slice(0, 400)}`);
    assert.ok(/del--bad/.test(html()), '超时那条没有染成显眼样式（扫一眼挑不出来）');
  });
  await check('画出结论与要点提纲', () => {
    assert.ok(/结论：/.test(text()), '没画结论');
    assert.ok(/甲 99/.test(text()) && /丙 299/.test(text()), `要点提纲没画出来：${text().slice(0, 400)}`);
  });

  log('');
  log('--- ④ 只读（这条是安全约束，不是风格偏好） ---');
  await check('★ 面板里**没有任何输入框**（没有「替智能体发消息」的口子）', () => {
    const inputs = host.querySelectorAll('input, textarea, select, [contenteditable="true"]');
    assert.equal(inputs.length, 0, `找到 ${inputs.length} 个可输入元素 —— 只读面板不该有`);
  });
  await check('按钮只有「刷新 / 关闭」+ 频道列表项（没有任何写操作按钮）', () => {
    /**
     * ★ 注意别把断言写歪：频道列表项**本身也是 `<button>`**（可点击选中，键盘可达），
     *   它的 textContent 自然是「母鸡 + 预览 + 条数」。所以不能笼统地要求
     *   「所有按钮的文字都在 {刷新, 关闭} 里」—— 那是我的断言错了，不是界面错了。
     *
     *   真正要守住的属性是：**除了「切换看哪条频道」和「刷新/关闭」，界面上没有别的动作**。
     *   按 class 分类来判：`channelsPanel__item` 是导航；`channelsPanel__acts` 里的只能是刷新/关闭。
     */
    const all = [...host.querySelectorAll('button')];
    const navItems = all.filter((b) => b.className.includes('channelsPanel__item'));
    const others = all.filter((b) => !b.className.includes('channelsPanel__item'));
    const labels = others.map((b) => (b.textContent ?? '').trim());

    assert.ok(navItems.length >= 1, `频道列表项没了（${all.length} 个按钮里没有 item）`);
    assert.deepEqual(labels.sort(), ['关闭', '刷新'], `出现了预期外的操作按钮：${labels.join(',')}`);
  });

  log('');
  log('--- ⑤ 后端不可用 ---');
  {
    const host2 = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host2);
    const root2 = createRoot(host2);
    await act(async () => {
      root2.render(<ChannelsPanel apiBase="http://127.0.0.1:1" token={token} onClose={() => undefined} />);
    });
    await check('后端连不上时**如实报错**，不白屏', async () => {
      await waitFor(() => (host2.textContent ?? '').length > 0 && /channelsPanel__err|HTTP|连不上|Failed|fetch/i.test(host2.innerHTML + host2.textContent));
      const t = host2.textContent ?? '';
      assert.ok(t.length > 0, '面板空白了');
      assert.ok(/channelsPanel__err/.test(host2.innerHTML), `没有错误条：${host2.innerHTML.slice(0, 200)}`);
    });
    await act(async () => root2.unmount());
  }

  await act(async () => root.unmount());
  await app.close();

  log('');
  log('=== 结论 ===');
  log(`  ${passes} PASS / ${fails} FAIL`);
  if (fails > 0) process.exitCode = 1;
}

void main();
