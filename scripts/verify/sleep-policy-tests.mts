/**
 * 空闲休眠**判定核心**的回归测试（第 24 步）。
 *
 * 为什么这条测试必须存在：
 *   休眠最大的风险不是"该睡没睡"，而是**"不该睡的被睡了"** ——
 *   AI 正在一张页上跑任务，页被收起来 → 任务断掉，而且**从界面上看不出原因**。
 *   这类 bug 在手动点测里**极难复现**（要等 5 分钟、还要正好有任务在跑），
 *   所以只能靠纯函数 + 拨时钟把它穷举掉。
 *
 * 跑法：`npx tsx scripts/verify/sleep-policy-tests.mts`（不依赖 Electron）
 */
import { decideSleep, humanizeIdle, DEFAULT_SLEEP_OPTIONS } from '../../apps/desktop/src/browser/sleepPolicy';

let fails = 0;
const log = (...a: unknown[]) => console.log(a.map(String).join(' '));
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) fails += 1;
  log(`  ${ok ? 'PASS' : '★FAIL'} ${name}${detail ? '  —— ' + detail : ''}`);
};

/** 固定"现在"，所有用例都相对它算，避免测试自己随时间漂移 */
const NOW = 1_800_000_000_000;
const MIN = 60_000;

/** 造一张页：ageMin = 多少分钟前用过 */
const tab = (id: number, ageMin: number, createdAgeMin = ageMin + 10) => ({
  id,
  lastActiveAt: NOW - ageMin * MIN,
  createdAt: NOW - createdAgeMin * MIN,
});

const ids = (plan: Record<number, string>) => Object.keys(plan).map(Number).sort((a, b) => a - b);
const at = (plan: Record<number, string>, id: number) => plan[id] ?? 'awake';

log('');
log('=== ① 三级状态机：按时长正确分档 ===');
{
  const tabs = [tab(1, 1), tab(2, 6), tab(3, 40)];
  const plan = decideSleep({ tabs, drivingIds: [], activeTabId: null, now: NOW });
  check('刚用过 1 分钟 → 清醒', at(plan, 1) === 'awake');
  check('★ 6 分钟没用 → 浅休眠（省 CPU）', at(plan, 2) === 'shallow', at(plan, 2));
  check('★ 40 分钟没用 → 深休眠（省内存）', at(plan, 3) === 'deep', at(plan, 3));
  check('结果里只列该睡的（不该睡的页不出现在 plan 里）', !(1 in plan));
}

log('');
log('=== ② 阈值边界（差 1 毫秒都要判对）===');
{
  const just = decideSleep({
    tabs: [{ id: 1, lastActiveAt: NOW - DEFAULT_SLEEP_OPTIONS.shallowAfterMs + 1, createdAt: NOW - 99 * MIN }],
    drivingIds: [], activeTabId: null, now: NOW,
  });
  check('差 1ms 到浅休眠阈值 → 还不睡（宁可晚睡）', at(just, 1) === 'awake');

  const exact = decideSleep({
    tabs: [{ id: 1, lastActiveAt: NOW - DEFAULT_SLEEP_OPTIONS.shallowAfterMs, createdAt: NOW - 99 * MIN }],
    drivingIds: [], activeTabId: null, now: NOW,
  });
  check('正好到浅休眠阈值 → 浅休眠', at(exact, 1) === 'shallow');

  const deepExact = decideSleep({
    tabs: [{ id: 1, lastActiveAt: NOW - DEFAULT_SLEEP_OPTIONS.deepAfterMs, createdAt: NOW - 99 * MIN }, tab(2, 40)],
    drivingIds: [], activeTabId: null, now: NOW,
  });
  check('正好到深休眠阈值 → 深休眠', at(deepExact, 1) === 'deep', at(deepExact, 1));
}

log('');
log('=== ③ ★★ 红线：正在被驾驶的页永不休眠 ===');
{
  // 这张页"2 小时没用"了，但它正在被 AI 驾驶 —— 必须清醒
  const plan = decideSleep({
    tabs: [tab(1, 120), tab(2, 40)],
    drivingIds: [1],
    activeTabId: null,
    now: NOW,
  });
  check('★★ 被驾驶 2 小时的页**依然清醒**（红线不可破）', at(plan, 1) === 'awake', at(plan, 1));
  check('同一批里没被驾驶的那张照常深休眠', at(plan, 2) === 'deep');
}

log('');
log('=== ④ ★ 前台正在看的那张永不休眠 ===');
{
  // 用户看了一小时没动它 —— 也不能收起来（他就在看）
  const plan = decideSleep({
    tabs: [tab(1, 60), tab(2, 40)],
    drivingIds: [],
    activeTabId: 1,
    now: NOW,
  });
  check('★ 前台那张（已 60 分钟没操作）不收起来', at(plan, 1) === 'awake', at(plan, 1));
  check('后台那张照常深休眠', at(plan, 2) === 'deep');
}

log('');
log('=== ⑤ 「只有一张页时不深休眠」 ===');
{
  const single = decideSleep({
    tabs: [tab(1, 60)],
    drivingIds: [], activeTabId: null, now: NOW,
  });
  check(
    '★ 只剩一张页时，最多少睡到浅休眠（卸载了用户回头只看到占位卡）',
    at(single, 1) === 'shallow',
    at(single, 1),
  );

  const two = decideSleep({
    tabs: [tab(1, 60), tab(2, 60)],
    drivingIds: [], activeTabId: null, now: NOW,
  });
  check('两张页时就可以深休眠了', at(two, 1) === 'deep' && at(two, 2) === 'deep');

  const forced = decideSleep({
    tabs: [tab(1, 60)],
    drivingIds: [], activeTabId: null, now: NOW,
    options: { allowDeepWhenSingle: true },
  });
  check('显式允许时，单页也能深休眠（可配置）', at(forced, 1) === 'deep');
}

log('');
log('=== ⑥ 兜底：刚开出来、还没被 touch 过的页 ===');
{
  // lastActiveAt = 0（从没 touch 过）→ 应该用 createdAt 兜底，而不是算成"从纪元起没用过"
  const fresh = decideSleep({
    tabs: [{ id: 1, lastActiveAt: 0, createdAt: NOW - 10_000 }, tab(2, 40)],
    drivingIds: [], activeTabId: null, now: NOW,
  });
  check('★ 刚开 10 秒、还没 touch 过的页 → 清醒（不能被算成"从未使用"）', at(fresh, 1) === 'awake', at(fresh, 1));
}

log('');
log('=== ⑦ 防御：时钟回拨 / 非法时间戳不能误睡 ===');
{
  const future = decideSleep({
    tabs: [{ id: 1, lastActiveAt: NOW + 5 * MIN, createdAt: NOW - 99 * MIN }, tab(2, 40)],
    drivingIds: [], activeTabId: null, now: NOW,
  });
  check('★ 时间戳在未来（时钟回拨）→ 当"刚用过"，保持清醒', at(future, 1) === 'awake', at(future, 1));

  const nan = decideSleep({
    tabs: [{ id: 1, lastActiveAt: Number.NaN, createdAt: Number.NaN }, tab(2, 40)],
    drivingIds: [], activeTabId: null, now: NOW,
  });
  check('★ 时间戳是 NaN → 不睡（宁可少睡不要误睡）', at(nan, 1) === 'awake', at(nan, 1));
}

log('');
log('=== ⑧ 跨智能体：别的智能体的页一样要睡（省的是全局内存）===');
{
  // 4 张页分属两个智能体；只看其中 2 张不能得出"只有两张"的结论
  const plan = decideSleep({
    tabs: [tab(1, 60), tab(2, 60), tab(3, 60), tab(4, 60)],
    drivingIds: [], activeTabId: 1, now: NOW,
  });
  check('4 张闲置页里，被驾驶/前台之外的都睡了', ids(plan).length === 3, `睡了 ${ids(plan).join(',')}`);
  check('★ 页数基数按**全部页**算（≥2 就允许深休眠）', at(plan, 2) === 'deep' && at(plan, 3) === 'deep');
}

log('');
log('=== ⑨ 阈值可配置 ===');
{
  const plan = decideSleep({
    tabs: [tab(1, 2)],
    drivingIds: [], activeTabId: null, now: NOW,
    options: { shallowAfterMs: 1 * MIN, deepAfterMs: 2 * MIN },
  });
  check('★ 把浅休眠调成 1 分钟 → 2 分钟没用的页就睡了（不是硬编码）', at(plan, 1) === 'shallow', at(plan, 1));
}

log('');
log('=== ⑩ 人话时长（tooltip 用）===');
{
  check('40 秒 → 刚刚', humanizeIdle(40_000) === '刚刚', humanizeIdle(40_000));
  check('7 分钟 → 7 分钟', humanizeIdle(7 * MIN) === '7 分钟', humanizeIdle(7 * MIN));
  check('72 分钟 → 1 小时 12 分钟', humanizeIdle(72 * MIN) === '1 小时 12 分钟', humanizeIdle(72 * MIN));
  check('120 分钟 → 2 小时（整点不带 0 分钟）', humanizeIdle(120 * MIN) === '2 小时', humanizeIdle(120 * MIN));
}

log('');
log('=== 结论 ===');
log(`  失败项：${fails}`);
log('  判定是纯函数 —— 时钟可以随便拨，红线可以穷举，这是这条测试存在的全部意义。');
process.exit(fails > 0 ? 1 : 0);
