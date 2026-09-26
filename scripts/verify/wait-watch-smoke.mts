/**
 * ADR-0003 · 浏览器深度 第一片 —— wait-for / watch 原语验收(真驱动 core)。
 *
 * 「真」在哪(对照 ADR 验收口径):
 *   - 驱动的是**生产那份 core**(`apps/desktop/electron/wait-watch.ts` 的 coreWaitFor / coreWatch),
 *     不是副本;注入页里跑的是**那两段注入 JS 常量原文**(waitForPredicateJs / WATCH_START_JS)。
 *   - 「本地测试页」= 进程内 DOM(真 querySelector / textContent + 一个**真 MutationObserver 契约**
 *     的 observer),用 Node `vm` **真执行**注入脚本。沙箱没有 Electron 二进制、且红线禁装 headless
 *     Chromium —— 真 CDP 的端到端复验在 `wait-watch-live.mjs`(有真二进制的机器上跑)。
 *
 * 断言逐行对应 ADR 失败模式表 F1–F8/F11/F12。反证(拆掉必红)见 `wait-watch-revert.py`。
 *
 * 用法:node_modules 就位后 `npx tsx scripts/verify/wait-watch-smoke.mts`(无需 Electron)。
 */
import vm from 'node:vm';
import {
  coreWaitFor,
  coreWatch,
  waitForPredicateJs,
  WATCH_BIND_NAME,
  type CdpSend,
  type CdpEvents,
  type WatchEvent,
} from '../../apps/desktop/electron/wait-watch.ts';

// ---------------------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------------------
let total = 0;
const fails: string[] = [];
function chk(cond: boolean, label: string, detail?: string): void {
  total++;
  if (cond) console.log('  PASS  ' + label);
  else {
    fails.push(label);
    console.log('  FAIL  ' + label + (detail ? '   ' + detail : ''));
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 看门狗:core 调用若超时(比如反证把 deadline 拆掉 → 死循环)当场判负,不让整场验收挂死。 */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_r, rej) => {
    t = setTimeout(() => rej(new Error(`看门狗:${what} 超过 ${ms}ms 没返回(多半是死循环/没超时)`)), ms);
  });
  try {
    return await Promise.race([p, watchdog]);
  } finally {
    if (t) clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// 进程内「本地测试页」:最小但**契约真实**的 DOM + MutationObserver
// ---------------------------------------------------------------------------
class FakeNode {
  nodeType = 1;
  tagName: string;
  id = '';
  className = '';
  _text = '';
  parent: FakeNode | null = null;
  children: FakeNode[] = [];
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  appendChild(n: FakeNode): FakeNode {
    n.parent = this;
    this.children.push(n);
    // 子树插入 → 通知「观察我或我祖先」的 observer(childList + subtree)
    for (const rec of this._recordsForChildList([n])) {
      FakeMutationObserver.dispatch(rec, n);
    }
    return n;
  }
  /** 文本变化 → characterData 记录(真 DOM 里改 textContent 会触发) */
  setTextContent(v: string): void {
    this._text = v;
    const rec = { type: 'characterData' as const, target: this };
    for (const obs of FakeMutationObserver.all) {
      for (const o of obs.observations) {
        if (o.opts.characterData && (o.target === this || o.target.isAncestorOf(this))) {
          obs.queue.push({ ...rec });
        }
      }
    }
    FakeMutationObserver.flushAll();
  }
  get textContent(): string {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  get outerHTML(): string {
    const kids = this.children.map((c) => c.outerHTML).join('');
    const id = this.id ? ` id="${this.id}"` : '';
    const cls = this.className ? ` class="${this.className}"` : '';
    return `<${this.tagName.toLowerCase()}${id}${cls}>${this._text}${kids}</${this.tagName.toLowerCase()}>`;
  }
  isAncestorOf(n: FakeNode): boolean {
    let p = n.parent;
    while (p) {
      if (p === this) return true;
      p = p.parent;
    }
    return false;
  }
  querySelector(sel: string): FakeNode | null {
    if (sel.startsWith('#')) {
      const id = sel.slice(1);
      return this._find((n) => n.id === id);
    }
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      return this._find((n) => n.className === cls);
    }
    // 简单标签名
    return this._find((n) => n.tagName === sel.toUpperCase());
  }
  private _find(pred: (n: FakeNode) => boolean): FakeNode | null {
    for (const c of this.children) {
      if (pred(c)) return c;
      const deep = c._find(pred);
      if (deep) return deep;
    }
    return null;
  }
  private _recordsForChildList(added: FakeNode[]): { type: 'childList'; addedNodes: FakeNode[]; target: FakeNode }[] {
    return [{ type: 'childList', addedNodes: added, target: this }];
  }
}

class FakeMutationObserver {
  static all: FakeMutationObserver[] = [];
  cb: (muts: any[]) => void;
  observations: { target: FakeNode; opts: any }[] = [];
  queue: any[] = [];
  private flushing = false;
  constructor(cb: (muts: any[]) => void) {
    this.cb = cb;
    FakeMutationObserver.all.push(this);
  }
  observe(target: FakeNode, opts: any): void {
    this.observations.push({ target, opts });
  }
  disconnect(): void {
    this.observations = [];
    this.queue = [];
  }
  static dispatch(rec: any, _node: FakeNode): void {
    for (const obs of FakeMutationObserver.all) {
      for (const o of obs.observations) {
        if (o.opts.childList && (o.target === rec.target || o.target.isAncestorOf(rec.target))) {
          if (o.opts.subtree || o.target === rec.target) obs.queue.push({ ...rec });
        }
      }
    }
    FakeMutationObserver.flushAll();
  }
  static flushAll(): void {
    for (const obs of FakeMutationObserver.all) {
      if (obs.flushing || obs.queue.length === 0) continue;
      obs.flushing = true;
      const muts = obs.queue;
      obs.queue = [];
      try {
        obs.cb(muts);
      } finally {
        obs.flushing = false;
      }
    }
  }
}

interface LocalPage {
  document: any;
  watchInstalled: boolean;
}

interface FakeCdp {
  send: CdpSend;
  events: CdpEvents;
  /** 手动喂一个 bindingCalled(畸形 payload 反证用) */
  emitBinding(payload: string): void;
  addBindingCount: number;
  removeBindingCount: number;
}

function makeLocalPage(): { page: LocalPage; cdp: FakeCdp } {
  const body = new FakeNode('body');
  const documentEl = new FakeNode('html');
  documentEl.children.push(body);
  const document: any = {
    body,
    documentElement: documentEl,
    querySelector: (sel: string) => documentEl.querySelector(sel),
  };

  const context: any = {
    document,
    MutationObserver: FakeMutationObserver,
    console,
  };
  context.window = context; // 页里 window.x 与全局 x 同一份
  vm.createContext(context);

  // 用**数组**而不是 Set —— 对齐真 EventEmitter(on 同一监听两次会触发两次,不 dedupe);
  // 这样反证 R4(重复订阅)才测得到。
  const listeners: Array<(e: unknown, m: string, p: any) => void> = [];
  let addBindingCount = 0;
  let removeBindingCount = 0;

  const send: CdpSend = async (method: string, params?: unknown) => {
    const p = (params ?? {}) as any;
    switch (method) {
      case 'Runtime.enable':
        return {};
      case 'Runtime.addBinding':
        addBindingCount++;
        // 真 CDP:在页主世界生成 window.<name>
        context[WATCH_BIND_NAME] = (payload: string) => {
          for (const l of [...listeners]) l({}, 'Runtime.bindingCalled', { name: WATCH_BIND_NAME, payload });
        };
        return {};
      case 'Runtime.removeBinding':
        removeBindingCount++;
        delete context[WATCH_BIND_NAME];
        return {};
      case 'Runtime.evaluate': {
        try {
          const value = vm.runInContext(p.expression, context, { timeout: 1000 });
          return { result: { value } };
        } catch (e) {
          return { exceptionDetails: { text: String(e) } };
        }
      }
      default:
        return {};
    }
  };

  // 观测「observer 是否已 observe body」—— 验收据此确定 setup 完成再插节点(不靠猜延迟)
  const origObserve = FakeMutationObserver.prototype.observe;
  let watchInstalled = false;
  FakeMutationObserver.prototype.observe = function (target: FakeNode, opts: any) {
    origObserve.call(this, target, opts);
    if (target === body) watchInstalled = true;
  };

  const page: LocalPage = {
    document,
    get watchInstalled() {
      return watchInstalled;
    },
  };

  const cdp: FakeCdp = {
    send,
    events: {
      on: (_e: 'message', l: (e: unknown, m: string, p: any) => void) => {
        listeners.push(l);
      },
      off: (_e: 'message', l: (e: unknown, m: string, p: any) => void) => {
        // 对齐 EventEmitter.off:移除该监听的所有实例
        for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i] === l) listeners.splice(i, 1);
      },
    },
    emitBinding: (payload: string) => {
      for (const l of [...listeners]) l({}, 'Runtime.bindingCalled', { name: WATCH_BIND_NAME, payload });
    },
    get addBindingCount() {
      return addBindingCount;
    },
    get removeBindingCount() {
      return removeBindingCount;
    },
  };

  return { page, cdp };
}

/** 等 setup 完成(observer 已 observe body),最多 ~1s,避免反证/竞态误判。 */
async function waitForWatchSetup(page: LocalPage): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (page.watchInstalled) return true;
    await sleep(20);
  }
  return page.watchInstalled;
}

// ---------------------------------------------------------------------------
// 各场景
// ---------------------------------------------------------------------------
async function scenarioWaitSelector(): Promise<void> {
  console.log('\n[S1] wait-for:等到元素出现(T+200ms 才出现,验证不早退 + 真等到)');
  const { page, cdp } = makeLocalPage();
  const later = setTimeout(() => {
    const n = new FakeNode('div');
    n.id = 'result';
    page.document.body.appendChild(n);
  }, 200);

  const res = await withTimeout(
    coreWaitFor(cdp.send, { selector: '#result', timeoutMs: 3000, pollMs: 50 }),
    5000,
    'wait-for(selector)',
  );
  chk(res.ok === true, 'S1 调用成功(ok=true)');
  chk(res.found === true, 'S1 等到了 #result(found=true)', `got ${JSON.stringify(res)}`);
  chk(res.how === 'selector', 'S1 命中方式是 selector', `how=${res.how}`);
  chk(res.waitedMs >= 150, 'S1 不早退:waitedMs≥150ms(元素 T+200 才出现)', `waitedMs=${res.waitedMs}`);
  clearTimeout(later);
}

async function scenarioWaitText(): Promise<void> {
  console.log('\n[S2] wait-for:等到文本出现(正文子串)');
  const { page, cdp } = makeLocalPage();
  // 初始正文只有 loading
  page.document.body.setTextContent('loading');
  const later = setTimeout(() => {
    const n = new FakeNode('div');
    n._text = ' done rendering ';
    page.document.body.appendChild(n);
  }, 200);
  const res = await withTimeout(
    coreWaitFor(cdp.send, { text: 'done rendering', timeoutMs: 3000, pollMs: 50 }),
    5000,
    'wait-for(text)',
  );
  chk(res.found === true, 'S2 等到了目标文本(found=true)', `got ${JSON.stringify(res)}`);
  chk(res.how === 'text', 'S2 命中方式是 text', `how=${res.how}`);
  clearTimeout(later);
}

async function scenarioWaitTimeout(): Promise<void> {
  console.log('\n[S3] wait-for:永不出现的元素 → 到点如实 found=false,不挂死');
  const { page, cdp } = makeLocalPage();
  const started = Date.now();
  const res = await withTimeout(
    coreWaitFor(cdp.send, { selector: '#never-appears', timeoutMs: 400, pollMs: 50 }),
    3000,
    'wait-for(超时)',
  );
  const elapsed = Date.now() - started;
  chk(res.ok === true, 'S3 调用成功(ok=true,found=false 不是错误)');
  chk(res.found === false, 'S3 没等到(found=false)', `got ${JSON.stringify(res)}`);
  chk(elapsed < 1500, `S3 在超时附近返回、不挂死(elapsed=${elapsed}ms)`, '超时逻辑失效会一直轮询');
}

async function scenarioWaitInvalid(): Promise<void> {
  console.log('\n[S4] wait-for:selector/text 都不给 → 形状闸当场拒(F12 输入校验)');
  const { cdp } = makeLocalPage();
  const res = await coreWaitFor(cdp.send, { timeoutMs: 100 });
  chk(res.ok === false, 'S4 形状不合法 ok=false');
  chk(typeof res.error === 'string' && res.error.length > 0, 'S4 给了可读原因', `error=${res.error}`);
}

async function scenarioWatchInsert(): Promise<void> {
  console.log('\n[S5] watch:新内容插入 → 回调**恰好一次**且带对 tag/text(F5/F6)');
  const { page, cdp } = makeLocalPage();
  const events: WatchEvent[] = [];
  const handle = coreWatch(cdp.send, cdp.events, (e) => events.push(e));
  chk(await waitForWatchSetup(page), 'S5 监听已挂上(observer 已 observe body)');
  chk(cdp.addBindingCount >= 1, 'S5 binding 已建(addBinding 被调)');

  const later = setTimeout(() => {
    const n = new FakeNode('div');
    n.id = 'msg';
    n._text = 'hello new message';
    page.document.body.appendChild(n);
  }, 150);
  await sleep(400);
  clearTimeout(later);

  chk(events.length === 1, 'S5 一次插入 → 恰好 1 个事件(不重复、不丢)', `count=${events.length}`);
  if (events.length >= 1) {
    chk(events[0].label === 'insert', 'S5 事件类型 insert', `label=${events[0].label}`);
    chk(events[0].tag === 'div', 'S5 tag=div', `tag=${events[0].tag}`);
    chk(events[0].text === 'hello new message', 'S5 text 带对', `text=${events[0].text}`);
  }
  handle.stop();
}

async function scenarioWatchStop(): Promise<void> {
  console.log('\n[S6] watch:stop 后 → 再插入**无**事件(F7 不泄漏)');
  const { page, cdp } = makeLocalPage();
  const events: WatchEvent[] = [];
  const handle = coreWatch(cdp.send, cdp.events, (e) => events.push(e));
  chk(await waitForWatchSetup(page), 'S6 监听已挂上');
  // 先确认活着:插一条应该收到
  page.document.body.appendChild(Object.assign(new FakeNode('div'), { _text: 'first' }));
  await sleep(120);
  chk(events.length === 1, 'S6 stop 前确实收到 1 条(前提成立)', `count=${events.length}`);

  handle.stop();
  await sleep(60); // 让 stop 的 best-effort 命令落地
  // stop 后再插
  page.document.body.appendChild(Object.assign(new FakeNode('div'), { _text: 'second' }));
  await sleep(200);
  chk(events.length === 1, 'S6 stop 后再插入 → 仍只有 1 条(没泄漏)', `count=${events.length}`);
  chk(cdp.removeBindingCount >= 1, 'S6 stop 调了 removeBinding(成对)');
}

async function scenarioWatchRearm(): Promise<void> {
  console.log('\n[S7] watch:同页 re-arm(先停旧的再挂新的,main.ts 的 stopWatchForWc 契约)→ 插一次只 1 事件(F11)');
  const { page, cdp } = makeLocalPage();
  const events: WatchEvent[] = [];
  const h1 = coreWatch(cdp.send, cdp.events, (e) => events.push(e));
  chk(await waitForWatchSetup(page), 'S7 第一个监听已挂上');
  // 生产 re-arm 口径(main.ts watch-start:先 stopWatchForWc 再 browserWatch):先停旧的
  h1.stop();
  await sleep(80); // 让 stop 的 best-effort 命令(off + disconnect + removeBinding)落地
  const h2 = coreWatch(cdp.send, cdp.events, (e) => events.push(e));
  chk(await waitForWatchSetup(page), 'S7 第二个监听已挂上');
  await sleep(60);
  page.document.body.appendChild(Object.assign(new FakeNode('div'), { _text: 'only once' }));
  await sleep(250);
  chk(events.length === 1, 'S7 re-arm 后插一次 → 恰好 1 事件(旧监听已摘、无双发)', `count=${events.length}`);
  h2.stop();
}

async function scenarioWatchMalformed(): Promise<void> {
  console.log('\n[S8] watch:畸形 binding payload → 主进程**不崩**、不产生事件(F8 fail-safe)');
  const { page, cdp } = makeLocalPage();
  let crashed = false;
  const events: WatchEvent[] = [];
  const handle = coreWatch(cdp.send, cdp.events, (e) => events.push(e));
  await waitForWatchSetup(page);
  // 直接喂非法 JSON(绕过页内 reporter 的正常路径,专测主进程解析兜底)
  try {
    cdp.emitBinding('{not valid json');
    cdp.emitBinding('');
    cdp.emitBinding('42');
    await sleep(60);
  } catch {
    crashed = true;
  }
  chk(crashed === false, 'S8 畸形 payload 没把主进程带崩');
  chk(events.length === 0, 'S8 畸形 payload 不产生事件', `count=${events.length}`);
  // 正常路径仍可用(没被畸形污染)
  page.document.body.appendChild(Object.assign(new FakeNode('div'), { _text: 'still works' }));
  await sleep(150);
  chk(events.length === 1, 'S8 畸形之后正常插入仍收到 1 条(状态没被污染)', `count=${events.length}`);
  handle.stop();
}

async function scenarioInjectedJsIsReal(): Promise<void> {
  console.log('\n[S9] 真码校验:注入脚本常量**真的**被 core 使用(防「测试测的是影子」)');
  // 用 waitForPredicateJs 生成的表达式在真 DOM 基底上直接求值,验证契约
  const { page, cdp } = makeLocalPage();
  const node = new FakeNode('span');
  node.id = 'probe';
  node._text = 'hi';
  page.document.body.appendChild(node);
  const expr = waitForPredicateJs('#probe', null);
  const val = (await (cdp.send as CdpSend)('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
  })) as { result?: { value?: { found?: boolean } } };
  chk(val.result?.value?.found === true, 'S9 waitForPredicateJs 在真 DOM 基底上对存在节点回 found=true');
  // 不存在的 → false
  const val2 = (await (cdp.send as CdpSend)('Runtime.evaluate', {
    expression: waitForPredicateJs('#ghost', null),
    returnByValue: true,
  })) as { result?: { value?: { found?: boolean } } };
  chk(val2.result?.value?.found === false, 'S9 谓词对不存在节点回 found=false(F1 假阳性防线)');
  // 非法选择器 → 当没找到,不当 found、不抛
  const val3 = (await (cdp.send as CdpSend)('Runtime.evaluate', {
    expression: waitForPredicateJs('[::bad selector', null),
    returnByValue: true,
  })) as { result?: { value?: { found?: boolean } } };
  chk(val3.result?.value?.found === false, 'S9 非法选择器当没找到(不假阳性、不炸)');
}

/** 场景抛错(比如反证把 deadline 拆掉 → 看门狗 reject)也要落成一条干净 FAIL,而不是崩掉整场。 */
async function runScenario(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    total++;
    const msg = (e as Error).message;
    fails.push(`${name} 抛错:${msg}`);
    console.log(`  FAIL  ${name} 抛错:${msg}`);
  }
}

async function main(): Promise<void> {
  console.log('='.repeat(68));
  console.log('ADR-0003 · 浏览器深度 第一片:wait-for / watch 原语验收(真驱动 core)');
  console.log('='.repeat(68));

  // 复位 MutationObserver 全局表(跨场景隔离)
  FakeMutationObserver.all = [];
  await runScenario('S1', scenarioWaitSelector);
  FakeMutationObserver.all = [];
  await runScenario('S2', scenarioWaitText);
  FakeMutationObserver.all = [];
  await runScenario('S3', scenarioWaitTimeout);
  FakeMutationObserver.all = [];
  await runScenario('S4', scenarioWaitInvalid);
  FakeMutationObserver.all = [];
  await runScenario('S5', scenarioWatchInsert);
  FakeMutationObserver.all = [];
  await runScenario('S6', scenarioWatchStop);
  FakeMutationObserver.all = [];
  await runScenario('S7', scenarioWatchRearm);
  FakeMutationObserver.all = [];
  await runScenario('S8', scenarioWatchMalformed);
  FakeMutationObserver.all = [];
  await runScenario('S9', scenarioInjectedJsIsReal);

  console.log('\n=== 结论 ===');
  console.log(`  ${total - fails.length} PASS / ${fails.length} FAIL`);
  if (fails.length) {
    console.log('  失败项:');
    for (const f of fails) console.log('    - ' + f);
  } else {
    console.log('  wait-for / watch 原语地基验收全绿(真驱动 core,注入 JS 真跑)');
  }
  // 强制退出:反证(如 R2 拆 deadline)会泄漏一个轮询循环把进程拖住,不能靠自然退出;
  // 等 100ms 让 stdout 落盘,再按结论码退出。
  setTimeout(() => process.exit(fails.length ? 1 : 0), 100);
}

void main();
