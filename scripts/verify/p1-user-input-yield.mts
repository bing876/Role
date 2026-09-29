/**
 * P1 分片验收：真实 driver.ts 编译后执行，只把 Electron/WebContentsView 边界换为假 guest。
 * 不是“真机收到物理键鼠”的证明；同页同类来源问题在后续独立测试中正面验。
 * 由 p1-5-pause-driving.mts 在分片期实际运行；接入独立主链后移除重复导入。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
import { runToolLoop } from '../../apps/desktop/electron/agent';
import { describeToolResult } from '../../apps/server/src/toolLoop';

const root = path.resolve(import.meta.dirname, '../..');
const source = readFileSync(path.join(root, 'apps/desktop/electron/driver.ts'), 'utf8');
let passed = 0;
async function check(label: string, verify: () => void | Promise<void>): Promise<void> {
  await verify();
  console.log(`  PASS ${label}`);
  passed += 1;
}

console.log('\n=== P1 · 用户操作后 3 秒内不派发后续键鼠动作 ===');
await check('唯一 WebContentsView guest 接线口真实监听键鼠事件并按 wcId 销毁清理', () => {
  const main = readFileSync(path.join(root, 'apps/desktop/electron/main.ts'), 'utf8');
  const wire = main.slice(main.indexOf('function wireBrowserGuest(contents: WebContents)'), main.indexOf('contents.setWindowOpenHandler('));
  const inputSource = readFileSync(path.join(root, 'apps/desktop/electron/user-input.ts'), 'utf8');
  assert.match(wire, /wireGuestInput\(contents\)/);
  assert.match(inputSource, /contents\.on\('before-mouse-event',[\s\S]*?mouseMove[\s\S]*?mouseDown[\s\S]*?mouseUp[\s\S]*?mouseWheel[\s\S]*?recordUserInput\(contents\.id\)/);
  assert.match(inputSource, /contents\.on\('before-input-event',[\s\S]*?rawKeyDown[\s\S]*?keyDown[\s\S]*?char[\s\S]*?keyUp[\s\S]*?recordUserInput\(contents\.id\)/);
  assert.match(inputSource, /contents\.once\('destroyed',[\s\S]*?forgetUserInput\(contents\.id\)/);
});
await check('旧手动暂停门紧邻新闸，锚定 if (，不能用 false && 虚晃过关', () => {
  const paused = source.indexOf('if (pausedOf(wcId) && PAUSED_BLOCKED.has(actionName))');
  const gate = source.search(/if\s*\(\s*userInputRemainingMs\(wcId\)\s*>\s*0\s*&&\s*PAUSED_BLOCKED\.has\(actionName\)\s*\)/);
  assert.ok(paused >= 0 && gate > paused && gate - paused < 900,
    'GATE_NOT_REACHABLE：新闸必须直接写在 if ( 里且紧邻旧门，不可 false && 禁掉');
  assert.match(source.slice(gate, gate + 230), /return blockedByUser\(actionName\)/);
  assert.match(source.slice(gate - 250, gate), /已.*CDP.*点击无法收回/);
});

let now = 1_000_000;
// 与生产 guestInput 的 setTimeout 共用假单调钟：状态恢复不是直接手工删时间戳。
const timers = new Map<number, { at: number; fn: () => void }>();
let timerSeq = 0;
const fakeSetTimeout = (fn: () => void, ms: number): number => {
  const id = ++timerSeq;
  timers.set(id, { at: now + ms, fn });
  return id;
};
const advance = (ms: number): void => {
  now += ms;
  for (;;) {
    const due = [...timers].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    timers.delete(due[0]);
    due[1].fn();
  }
};
const page = { url: 'https://example.test/', title: '当前页', buttons: [], fields: [], text: '当前页' };
const commands: Array<{ method: string; expression?: string }> = [];
const guests = new Map<number, object>();
const viewHostRegistry = new Set([101, 202]);
let mode: 'normal' | 'click-race' | 'type-race' | 'type-clear-race' | 'same-key-prepare' | 'same-key-held' = 'normal';
let releaseHeldKey: ((value: object) => void) | null = null;
let driver: typeof import('../../apps/desktop/electron/driver') & {
  recordUserInput(wcId: number): void;
  userInputRemainingMs(wcId: number): number;
  forgetUserInput(wcId: number): void;
  wireGuestInput(contents: unknown): void;
};

function fakeGuest(id: number) {
  const nativeEvents = new EventEmitter();
  return {
    id, isDestroyed: () => false, getURL: () => 'https://example.test/',
    on: nativeEvents.on.bind(nativeEvents), once: nativeEvents.once.bind(nativeEvents),
    emit: nativeEvents.emit.bind(nativeEvents),
    debugger: {
      isAttached: () => true, attach: () => undefined,
      sendCommand: async (method: string, params: { expression?: string; type?: string; key?: string } = {}) => {
        commands.push({ method, expression: params.expression });
        if (id === 101 && method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' && mode === 'same-key-prepare') {
          mode = 'same-key-held';
          // 模拟该 CDP keyDown 也进入 Electron 的前置事件：它与真人按下同一键没有来源位。
          nativeEvents.emit('before-input-event', {}, { type: 'keyDown', key: params.key });
          return new Promise<object>((resolve) => { releaseHeldKey = resolve; }); // CDP 尚未回包
        }
        if (method !== 'Runtime.evaluate') return {};
        const expression = params.expression ?? '';
        if (mode === 'click-race' && id === 101) {
          mode = 'normal';
          driver.recordUserInput(id); // 真人在异步读取点击目标时开始操作
        }
        if (mode === 'type-race' && id === 101 && expression.includes('window.__wbHelper.pick(')) {
          mode = 'normal';
          driver.recordUserInput(id); // 真人在寻找输入框时开始打字
        }
        if (mode === 'type-clear-race' && id === 101 && expression.includes("desc.set.call(el, '')")) {
          mode = 'normal';
          driver.recordUserInput(id); // 清空命令可能已发出，但后续文字未派发
          return { result: { value: true } };
        }
        if (expression.includes('window.__wbHelper.snapshot()')) return { result: { value: page } };
        if (mode.startsWith('same-key-') && expression.includes("desc.set.call(el, '')")) {
          return { result: { value: true } }; // 唯一的假输入框「搜索」已聚焦/清空
        }
        if (mode.startsWith('same-key-') && expression.includes("return String(('value' in el")) {
          return { result: { value: '' } }; // insertText 本机失败，走逐字符 CDP keyDown 兜底
        }
        if (expression.includes('window.__wbHelper.pick(')) {
          return { result: { value: { tag: 'INPUT', label: '搜索', x: 100, y: 100 } } };
        }
        return { result: { value: null } };
      },
    },
  };
}
guests.set(101, fakeGuest(101));
guests.set(202, fakeGuest(202));

// 测真实生产模块的 drive()，不复制门逻辑；假的是 Node 环境没有的 Electron 宿主。
const output = await build({
  stdin: {
    contents: `export * from ${JSON.stringify(path.join(root, 'apps/desktop/electron/driver.ts'))};\n` +
      `export { recordUserInput, userInputRemainingMs, forgetUserInput, wireGuestInput } from ${JSON.stringify(path.join(root, 'apps/desktop/electron/user-input.ts'))};`,
    resolveDir: root, sourcefile: 'p1-test-entry.ts', loader: 'ts',
  },
  write: false, bundle: true, format: 'cjs', platform: 'node', target: 'node22',
  plugins: [{
    name: 'p1-fake-native-boundary',
    setup(plugin) {
      plugin.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'p1-native' }));
      plugin.onResolve({ filter: /^\.\/view-host$/ }, () => ({ path: 'view-host', namespace: 'p1-native' }));
      plugin.onLoad({ filter: /^electron$/, namespace: 'p1-native' }, () => ({
        contents: 'module.exports = { webContents: globalThis.__p1WebContents };', loader: 'js',
      }));
      plugin.onLoad({ filter: /^view-host$/, namespace: 'p1-native' }, () => ({
        contents: 'module.exports = { viewHostRegistry: globalThis.__p1Registry };', loader: 'js',
      }));
    },
  }],
});
assert.equal(output.outputFiles?.length, 1);
const moduleRef = { exports: {} as Record<string, unknown> };
const sandbox: Record<string, unknown> = {
  module: moduleRef, exports: moduleRef.exports, require: createRequire(import.meta.url),
  process, console, Buffer, URL, AbortController, Date,
  performance: { now: () => now },
  setTimeout: fakeSetTimeout, clearTimeout: (id: number) => { timers.delete(id); },
  __p1WebContents: { fromId: (id: number) => guests.get(id) ?? null },
  __p1Registry: viewHostRegistry,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(output.outputFiles![0]!.text, sandbox, { filename: 'driver-p1-test.cjs' });
driver = moduleRef.exports as typeof driver;
for (const guest of guests.values()) driver.wireGuestInput(guest); // 实际生产接线函数，不在测试里复刻监听器

await check('真实 drive：本页 click/type/fill_form 返回 blocked，零 CDP 命令；read_page/别页照行', async () => {
  driver.recordUserInput(101);
  assert.equal(driver.userInputRemainingMs(101), 3_000);
  assert.equal(driver.userInputRemainingMs(202), 0);
  for (const action of [
    { action: 'click', target: '下一步' },
    { action: 'type', target: '搜索', text: '用户改的' },
    { action: 'fill_form', fields: [{ target: '名字', text: '用户改的' }] },
  ] as const) {
    const result = await driver.drive(action, 101);
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'blocked');
    assert.match(result.detail ?? '', /因你刚在这张页操作.*未派发/);
    assert.equal(result.error, undefined, '不能把主动让路当执行失败');
  }
  assert.equal(commands.length, 0, '挡下后连 Runtime.evaluate 都不应发');
  assert.equal((await driver.drive({ action: 'read_page' }, 101)).ok, true);
  assert.equal((await driver.drive({ action: 'read_page' }, 202)).ok, true);
  assert.equal(driver.userInputRemainingMs(202), 0, 'A 的输入不能拦 B');
});

await check('按最后输入算 3 秒：2999ms 仍挡、3000ms 进入真实动作路径', async () => {
  now += 2_999;
  assert.equal((await driver.drive({ action: 'click', target: '下一步' }, 101)).outcome, 'blocked');
  now += 1;
  assert.equal(driver.userInputRemainingMs(101), 0);
  const before = commands.length;
  const result = await driver.drive({ action: 'click', target: '下一步' }, 101);
  assert.notEqual(result.outcome, 'blocked');
  assert.ok(commands.length > before, '安静满 3 秒后必须进入真实执行路径');
});

await check('定位竞态：真人在异步 click/type/fill_form 中接管，未发出 CDP 输入', async () => {
  for (const [race, action] of [
    ['click-race', { action: 'click', target: '下一步' }],
    ['type-race', { action: 'type', target: '搜索', text: '值' }],
    ['type-race', { action: 'fill_form', fields: [{ target: '名字', text: '值' }] }],
  ] as const) {
    now += 3_001;
    mode = race;
    const beforeInput = commands.filter((x) => x.method.startsWith('Input.')).length;
    const result = await driver.drive(action, 101);
    assert.equal(result.outcome, 'blocked', race);
    assert.equal(commands.filter((x) => x.method.startsWith('Input.')).length, beforeInput, race);
  }
});

await check('已发清空但未写字：回执如实说可能部分执行，不能说整个 type 未派发', async () => {
  now += 3_001;
  mode = 'type-clear-race';
  const beforeInput = commands.filter((x) => x.method.startsWith('Input.')).length;
  const result = await driver.drive({ action: 'type', target: '搜索', text: '值' }, 101);
  assert.equal(result.outcome, 'blocked');
  assert.match(result.detail ?? '', /输入框可能已聚焦\/清空.*文字尚未派发/);
  assert.equal(commands.filter((x) => x.method.startsWith('Input.')).length, beforeInput);
  driver.forgetUserInput(101);
});

await check('同页同类（模拟 guest 原生回调）：AI type 的 CDP keyDown 未回包，同一「搜索」框真人同键事件仍刷新时间戳、挡三动作', async () => {
  driver.forgetUserInput(101);
  const guest = guests.get(101) as { emit: (name: string, event: object, input: object) => void };
  assert.ok(guest, '假 guest 必须是 AI 正在输入的同一张页');
  mode = 'same-key-prepare';
  releaseHeldKey = null;
  let finished = false;
  const inFlight = driver.drive({ action: 'type', target: '搜索', text: 'x' }, 101)
    .then((result) => { finished = true; return result; });
  // 推进假时钟到 Input.insertText 读回失败、进入逐字符 CDP keyDown 且尚未回包。
  for (let i = 0; i < 80 && !releaseHeldKey; i += 1) {
    await Promise.resolve();
    advance(50);
  }
  assert.ok(releaseHeldKey && !finished, '必须真的卡在生产 typeInto 的 CDP keyDown 上，不是假设“AI 正在输入”');
  assert.ok(driver.userInputRemainingMs(101) > 0, '若 CDP 自己的前置事件也上报，当前保守策略同样记它');
  advance(10);
  guest.emit('before-input-event', {}, { type: 'keyDown', key: 'x' }); // 同页、同类、同键、同一焦点框的真人事件
  assert.equal(driver.userInputRemainingMs(101), 3_000, '真人的第二次按键必须刷新时间戳，不能被在途 CDP 键吞掉');
  advance(10);
  guest.emit('before-input-event', {}, { type: 'rawKeyDown', key: 'x' }); // 物理键可能报 rawKeyDown
  assert.equal(driver.userInputRemainingMs(101), 3_000, 'CDP 同类命令在途时 rawKeyDown 也不能被漏掉');
  advance(10);
  guest.emit('before-input-event', {}, { type: 'char', key: 'x' }); // 输入法可能只送 char
  assert.equal(driver.userInputRemainingMs(101), 3_000, '输入法文字事件也必须算最近一次输入');
  const before = commands.filter((x) => x.method.startsWith('Input.')).length;
  for (const action of [
    { action: 'click', target: '下一步' },
    { action: 'type', target: '搜索', text: '另一个词' },
    { action: 'fill_form', fields: [{ target: '搜索', text: '另一个词' }] },
  ] as const) {
    const result = await driver.drive(action, 101);
    assert.equal(result.outcome, 'blocked', `${action.action} 必须主动让路`);
    assert.equal(result.ok, false);
  }
  assert.equal(commands.filter((x) => x.method.startsWith('Input.')).length, before,
    '后续三动作不能趁在途 CDP 命令未回包继续下手');
  releaseHeldKey!({}); // 已发出的那一个键不可撤销，须配对释放；后续写入则应收手
  for (let i = 0; i < 45 && !finished; i += 1) {
    await Promise.resolve();
    advance(50);
  }
  assert.ok(finished, '放掉在途 CDP 键后旧 type 不能继续挂死');
  const oldAction = await inFlight;
  assert.equal(oldAction.outcome, 'blocked', '已发出的前缀如实标部分执行、后续未派发');
  assert.match(oldAction.detail ?? '', /可能已写入部分文字.*后续操作未派发/);
  driver.forgetUserInput(101);
  mode = 'normal';
});

await check('真实状态广播：本页首次输入立刻显示原文，3 秒后还原；手动暂停优先/别页不串', () => {
  const states: Array<{ wcId?: number; detail: string; phase: string; blocked: boolean }> = [];
  driver.setTaskListener((state) => {
    states.push({ wcId: state.wcId, detail: state.detail, phase: state.phase, blocked: state.blocked });
  });
  driver.takeoverRun(101, 'AI 在这页继续运行');
  driver.recordUserInput(101);
  assert.deepEqual(states.at(-1), { wcId: 101, detail: '你在操作，我停下了', phase: 'running', blocked: false });
  assert.equal(driver.getTaskState(101).detail, '你在操作，我停下了');
  advance(3_000);
  assert.equal(driver.userInputRemainingMs(101), 0);
  advance(1); // 定时器在 3001ms 推送恢复，而动作闸在 3000ms 精确放行
  assert.deepEqual(states.at(-1), { wcId: 101, detail: 'AI 在这页继续运行', phase: 'running', blocked: false });
  driver.recordUserInput(202);
  assert.equal(driver.getTaskState(101).detail, 'AI 在这页继续运行', '别页状态不得污染当前页');
  driver.forgetUserInput(202);
  driver.setDrivingPaused(true, 101);
  driver.recordUserInput(101);
  assert.equal(driver.getTaskState(101).phase, 'paused');
  assert.equal(driver.getTaskState(101).blocked, true);
  assert.notEqual(driver.getTaskState(101).detail, '你在操作，我停下了', '临时让路不能假扮/解除手动暂停');
  driver.forgetUserInput(101);
});

await check('原生键鼠事件形态：rawKeyDown/keyDown/char/keyUp + 鼠标释放均更新本页，销毁立即清理', () => {
  const guest = guests.get(202) as { emit: (name: string, event: object, input: object) => void };
  assert.ok(guest);
  driver.forgetUserInput(202);
  for (const type of ['rawKeyDown', 'keyDown', 'char', 'keyUp']) {
    advance(1);
    guest.emit('before-input-event', {}, { type });
    assert.equal(driver.userInputRemainingMs(202), 3_000, `${type} 属于真人键盘/输入法，不得忽略`);
    assert.equal(driver.userInputRemainingMs(101), 0, '本页事件不能误挡别页');
  }
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp', 'mouseWheel']) {
    advance(1);
    guest.emit('before-mouse-event', {}, { type });
    assert.equal(driver.userInputRemainingMs(202), 3_000, `${type} 属于用户鼠标操作`);
  }
  guest.emit('destroyed', {}, {});
  assert.equal(driver.userInputRemainingMs(202), 0, '页销毁必须清掉所有事件时间戳');
});

await check('真实桌面循环：挡下不算失败/unknown、不记失败步；安静后先读页才送 blocked 回执', async () => {
  let left = 3_000;
  const receipts: Array<null | Record<string, unknown>> = [];
  const execActions: string[] = [];
  const stepResults: boolean[] = [];
  const notes: string[] = [];
  // 既有普通 exec Promise.race 超时 timer 不清，这里 unref 而非让测试白等 20 秒。
  const nativeTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
    const handle = nativeTimeout(fn, ms, ...args);
    handle.unref();
    return handle;
  }) as typeof setTimeout;
  try {
    const reason = await runToolLoop('p1-test-loop', '点下一步', {
      next: async (_loop, result) => {
        receipts.push(result);
        if (receipts.length === 1) return { kind: 'tool', call: { id: 'p1-click', name: 'click', args: { target: '下一步' } } };
        assert.equal(left, 0, '用户还没停满 3 秒就去问服务端下一步');
        return { kind: 'done', summary: '验证完成', document_title: '验证', document_outline: [] };
      },
      exec: async (action) => {
        execActions.push(action.action);
        return action.action === 'click'
          ? { ok: false, action: 'click', outcome: 'blocked', detail: '你在操作，我停下了：点击未派发。' }
          : { ok: true, action: 'read_page', pageSnapshot: page };
      },
      userInputIdleMs: () => left,
      sleep: async (ms) => { left = Math.max(0, left - ms); },
      isPaused: () => false, aborted: () => false,
      emit: (event) => { if (event.kind === 'note') notes.push(event.text); },
      phase: () => undefined,
      taskStart: async () => 17,
      taskStep: async (_id, _summary, ok) => { stepResults.push(ok); },
      taskStatus: async () => undefined,
    });
    assert.equal(reason, 'done');
  } finally {
    globalThis.setTimeout = nativeTimeout;
  }
  assert.deepEqual(execActions, ['click', 'read_page']);
  assert.equal(receipts.length, 2, '等用户时不能空转问模型');
  assert.equal(receipts[1]?.outcome, 'blocked');
  assert.equal(receipts[1]?.ok, false);
  assert.deepEqual(receipts[1]?.page, page, '先读当前页再交给服务端，不能拿旧快照盲重试');
  assert.ok(stepResults.every(Boolean), '挡下的动作不能作为失败步骤记账');
  assert.ok(notes.some((note) => note.includes('未派发')), '界面通知必须说清让路原因');
});

await check('服务端入站白名单保留 blocked，SSE info 不报失败；模型回执明说用户操作未派发', () => {
  const route = readFileSync(path.join(root, 'apps/server/src/routes/loop.ts'), 'utf8');
  assert.match(route, /outcome: raw\.ok === false && \(raw\.outcome === 'blocked'/,
    '入站不能默默丢掉第四种 outcome');
  assert.match(route, /if \(result\.outcome === 'blocked'\) \{\s*broadcastLoopEvent\(loopId, 'note', \{ level: 'info'/,
    'blocked 不能经 SSE 当作 warning/失败广播');
  const text = describeToolResult(
    { id: 'p1', name: 'click', args: { target: '下一步' } },
    { ok: false, outcome: 'blocked', detail: '你在操作，我停下了：点击未派发。', page },
  );
  assert.match(text, /回执：已让路（用户正在操作，后续动作未派发）/);
  assert.match(text, /先读当前页/);
  assert.match(text, /用户操作后重新读取的当前页/);
  assert.doesNotMatch(text, /回执：失败|失败原因|回执：成功|回执：unknown/);
});

console.log(`=== P1 分片验收：${passed} PASS / 0 FAIL（非真机）===\n`);
