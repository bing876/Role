/**
 * 第 24 步 · 空闲休眠的**判定核心**（纯函数，不碰 React、不碰 DOM）。
 *
 * 为什么要把判定单独拎出来做成纯函数：
 *   休眠这件事的风险全在**红线**上 —— 正在被驾驶的页绝不能被收起来
 *   （收起来等于把 AI 正在跑的任务弄断）。这类"绝不"必须能被**穷举验证**，
 *   而不是埋在一个每 30 秒跑一次的定时器里靠运气。
 *   纯函数没有副作用、没有时间依赖（`now` 是参数），所以可以：
 *     - 把时钟随便拨到"6 分钟前""2 小时前"，断言结果；
 *     - 构造任意 drivingIds 组合，断言红线不破；
 *     - 用反证（把某条规则删掉）证明测试真的能测出回归。
 *
 * 三级状态：
 *   清醒 ──5 分钟没用──▶ 浅休眠 ──累计 30 分钟──▶ 深休眠
 *
 * 两级休眠省的东西不同，所以**必须分开**：
 *   - 浅休眠省 **CPU**：页还活着，但后台节流拉满（视频不再后台解码）。
 *   - 深休眠省 **内存**：<webview> 真的卸载，只留快照。这才对应「不占内存」。
 */

/** 一张页参与判定时需要的全部信息（从 BrowserTabView 里挑出来的） */
export interface SleepCandidate {
  id: number;
  /** 这个实例最后一次被用是什么时候（毫秒时间戳）；缺省视为"很久没用" */
  lastActiveAt: number;
  /** 它是什么时候开出来的 —— 没有任何使用记录时拿它兜底 */
  createdAt: number;
}

/** 休眠判定的可调参数 */
export interface SleepOptions {
  /** 多久没用 → 浅休眠。默认 5 分钟 */
  shallowAfterMs: number;
  /** 浅休眠后再累计多久 → 深休眠。默认 30 分钟 */
  deepAfterMs: number;
  /**
   * 只有一张页时是否允许深休眠。默认**不允许**。
   *
   * 理由：整块浏览器区只有一张页，把它卸载了，用户回头看到的是一张占位卡 ——
   * 而他刚才明明只是去回了条消息。这种情况省下的那点内存不值得换来一次白屏。
   */
  allowDeepWhenSingle: boolean;
}

export const DEFAULT_SLEEP_OPTIONS: SleepOptions = {
  shallowAfterMs: 5 * 60 * 1000,
  deepAfterMs: 30 * 60 * 1000,
  allowDeepWhenSingle: false,
};

/** 判定输入 */
export interface SleepInput {
  /** 参与判定的所有页（**所有智能体**的都要给 —— 别的智能体的页同样占内存） */
  tabs: SleepCandidate[];
  /** 正在被驾驶员操作的那几张：**红线，永不休眠** */
  drivingIds: number[];
  /** 此刻前台正在显示的那张：永不休眠 */
  activeTabId: number | null;
  /** 当前时刻（毫秒）。显式传进来，测试才能"拨时钟" */
  now: number;
  options?: Partial<SleepOptions>;
}

/** 判定结果：只列出**该休眠**的页；清醒的页不出现在结果里 */
export type SleepPlan = Record<number, 'shallow' | 'deep'>;

/**
 * 算出此刻每张页该处于什么状态。
 *
 * 判定顺序（**这个顺序本身就是规则，别调换**）：
 *   1. **红线**：在 drivingIds 里 → 清醒。不管它多久没"被用过"。
 *   2. **前台**：就是用户正在看的那张 → 清醒。
 *   3. 没超过浅休眠阈值 → 清醒。
 *   4. 超过浅休眠阈值 → 浅休眠。
 *   5. 同时超过深休眠阈值、且允许深休眠 → 深休眠。
 *
 * ★ 为什么第 1 步必须最先：`lastActiveAt` 记的是「用户/驾驶员最后一次碰它」。
 *   AI 正在一张页上跑长任务时，中间可能有几十秒不产生 touch —— 如果按时间判，
 *   它会在任务跑着的时候被收起来。**必须靠 drivingIds 硬拦，不能靠时间。**
 */
export function decideSleep(input: SleepInput): SleepPlan {
  const opts: SleepOptions = { ...DEFAULT_SLEEP_OPTIONS, ...(input.options ?? {}) };
  const driving = new Set(input.drivingIds);
  const plan: SleepPlan = {};

  /**
   * 「只有一张页时不深休眠」的判定基数是**全部页**（跨智能体），
   * 不是"当前智能体有几张"。因为占内存的是所有挂着的 <webview>，
   * 别的智能体那些页一样吃内存 —— 省内存要看全局。
   */
  const canDeep = opts.allowDeepWhenSingle || input.tabs.length > 1;

  for (const t of input.tabs) {
    // ① 红线：正在被驾驶 —— 永不休眠
    if (driving.has(t.id)) continue;
    // ② 前台正在看的那张 —— 永不休眠
    if (input.activeTabId !== null && t.id === input.activeTabId) continue;

    // ③ 多久没用了。没有任何使用记录时，用"开出来的时刻"兜底
    //    （否则一张刚开、还没被 touch 过的页会被算成"从纪元起就没用过"）
    const last = Number.isFinite(t.lastActiveAt) && t.lastActiveAt > 0 ? t.lastActiveAt : t.createdAt;
    const idleMs = input.now - last;

    // 时钟回拨 / 非法值 → 一律当"刚用过"，**宁可少睡也不要误睡**
    if (!Number.isFinite(idleMs) || idleMs < opts.shallowAfterMs) continue;

    // ④⑤ 浅还是深
    plan[t.id] = idleMs >= opts.deepAfterMs && canDeep ? 'deep' : 'shallow';
  }

  return plan;
}

/**
 * 把时间戳格式化成「睡了多久」的人话，给 tooltip 用。
 * 例：`7 分钟` / `1 小时 12 分钟` / `刚刚`
 */
export function humanizeIdle(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return '刚刚';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${h} 小时` : `${h} 小时 ${rest} 分钟`;
}
