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
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '../..');
const source = readFileSync(path.join(root, 'apps/desktop/electron/driver.ts'), 'utf8');
let passed = 0;
async function check(label: string, verify: () => void | Promise<void>): Promise<void> {
  await verify();
  console.log(`  PASS ${label}`);
  passed += 1;
}

console.log('\n=== P1 · 用户操作后 3 秒内不派发后续键鼠动作 ===');
await check('旧手动暂停门紧邻新闸，锚定 if (，不能用 false && 虚晃过关', () => {
  const paused = source.indexOf('if (pausedOf(wcId) && PAUSED_BLOCKED.has(actionName))');
  const gate = source.search(/if\s*\(\s*userInputRemainingMs\(wcId\)\s*>\s*0\s*&&\s*PAUSED_BLOCKED\.has\(actionName\)\s*\)/);
  assert.ok(paused >= 0 && gate > paused && gate - paused < 900,
    'GATE_NOT_REACHABLE：新闸必须直接写在 if ( 里且紧邻旧门，不可 false && 禁掉');
  assert.match(source.slice(gate, gate + 230), /return blockedByUser\(actionName\)/);
  assert.match(source.slice(gate - 250, gate), /已.*CDP.*点击无法收回/);
});

let now = 1_000_000;
const page = { url: 'https://example.test/', title: '当前页', buttons: [], fields: [], text: '当前页' };
const commands: Array<{ method: string; expression?: string }> = [];
const guests = new Map<number, object>();
const viewHostRegistry = new Set([101, 202]);
let mode: 'normal' | 'click-race' | 'type-race' | 'type-clear-race' = 'normal';
let driver: typeof import('../../apps/desktop/electron/driver') & {
  recordUserInput(wcId: number): void;
  userInputRemainingMs(wcId: number): number;
  forgetUserInput(wcId: number): void;
};

function fakeGuest(id: number) {
  return {
    id, isDestroyed: () => false, getURL: () => 'https://example.test/',
    debugger: {
      isAttached: () => true, attach: () => undefined,
      sendCommand: async (method: string, params: { expression?: string } = {}) => {
        commands.push({ method, expression: params.expression });
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
      `export { recordUserInput, userInputRemainingMs, forgetUserInput } from ${JSON.stringify(path.join(root, 'apps/desktop/electron/user-input.ts'))};`,
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
  setTimeout: (fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms);
    timer.unref(); // driver 的 CDP 8s 超时兜底不让定向验收空等
    return timer;
  },
  clearTimeout,
  __p1WebContents: { fromId: (id: number) => guests.get(id) ?? null },
  __p1Registry: viewHostRegistry,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(output.outputFiles![0]!.text, sandbox, { filename: 'driver-p1-test.cjs' });
driver = moduleRef.exports as typeof driver;

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

console.log(`=== P1 分片验收：${passed} PASS / 0 FAIL（非真机）===\n`);
