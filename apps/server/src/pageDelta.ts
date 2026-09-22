/**
 * 阶段简报 · 方案 B · **页面变化判定**（纯函数，无 IO、无副作用、可单测）。
 *
 * 回答的是那个核心难点：「用户在我暂停期间到底动没动这个页面」。
 *
 * ★ 为什么**不**比截图、也**不**比整页 DOM（选型理由，改这里之前先读）：
 *   1. **截图**：产物是 base64 大块，要么落盘要么常驻内存；而且像素差只能证明「变了」，
 *      说不出「变成什么」。更要命的是**假阳性**——一个轮播图、一次懒加载、
 *      一个跳动的秒数，都会让「页面变了」永远为真，判定就废了。
 *   2. **整页 DOM 字符串**：体积大，且现代页面里塞满了随机 id、时间戳、埋点属性，
 *      字符串级别的 diff 会被这些噪声淹没，真正的变化反而看不出来。
 *   3. **采纳 `PageSnapshot` 差集**：它本来就在每一次工具回执里流动
 *      （driver → 桌面 → 服务端 lastSnapshot），**零额外采集成本**；
 *      而且 url / title / buttons / links / inputs / texts 全是**已经提炼过的人话**，
 *      差集能直接翻译成给模型看的一句话，不需要再解释一层。
 *
 * ★ 职责边界（很重要）：
 *   本文件**只回答「变没变、哪一类变了」**（确定性、可断言、可写进验收取证）；
 *   「变了之后下一步干什么」**不在这里**判断 —— 那是模型的事（`toolLoop` 的恢复轮）。
 *   把两者混在一起，就会出现「代码替 AI 做语义决策」这种既不可测又不可改的东西。
 */
import type { PageSnapshot } from '@ai-workbench/shared';

/**
 * 变化分级。
 *
 * - `unchanged` 地址标题都没动、可见元素集合也没动 → 按原计划往下走；
 * - `moved`    ★ 只看**地址**变了 → 用户把 AI 带到了**另一个页面**（最需要警惕的一类：
 *              此时若沿用旧计划，最典型的错误就是 `open_url` 跳回暂停前的地址，
 *              把用户手动操作的成果覆盖掉）；
 * - `edited`   地址没变，但标题或可见元素/正文变了 → 还是同一个页面、只是**状态变了**
 *              （登录完成、验证码弹窗消失、展开了一段内容，都是这一类）；
 * - `unknown`  没有「暂停前」的快照可比（例如暂停时循环还没读过页）→ 如实说不知道，
 *              绝不假装「没变」。
 */
export type PageDeltaKind = 'unchanged' | 'moved' | 'edited' | 'unknown';

export interface PageDelta {
  kind: PageDeltaKind;
  urlChanged: boolean;
  titleChanged: boolean;
  /** 暂停后**新出现**的可见元素（按钮/链接/输入框/正文 各取前若干，人话） */
  added: string[];
  /** 暂停后**消失**的可见元素 */
  removed: string[];
  /** 上面两个差集是从哪几类元素里算出来的（诊断用，也用来说明「比了什么」） */
  compared: string[];
  /** 给模型 / 给用户看的一句话（本文件唯一一处「组织语言」的地方） */
  brief: string;
}

/** 每类元素最多报几条（防止一整页正文把提示词撑爆） */
const MAX_DELTA_ITEMS = 8;
/** 差集里忽略的噪声：空串、纯空白、过长（多半是正文长段落，不是可操作元素） */
const MAX_ITEM_LEN = 40;

function clean(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    const s = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
    if (!s || s.length > MAX_ITEM_LEN) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** 归一化后的地址：忽略协议、末尾斜杠、#hash —— 「同一个页面刷新了一下」不该判成 moved */
function normUrl(u: string): string {
  return String(u ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/#.*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function diff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((x) => !b.has(x)).slice(0, MAX_DELTA_ITEMS),
    removed: before.filter((x) => !a.has(x)).slice(0, MAX_DELTA_ITEMS),
  };
}

const join = (a: string[]): string => (a.length ? a.map((x) => `「${x}」`).join('、') : '（无）');

/**
 * 比对「暂停前」与「恢复后」两张快照。
 *
 * @param before 暂停那一刻的快照（没有就传 null → 返回 kind='unknown'）
 * @param after  恢复后**重新读**到的当前页快照
 */
export function pageDelta(before: PageSnapshot | null | undefined, after: PageSnapshot | null | undefined): PageDelta {
  if (!before || !after) {
    return {
      kind: 'unknown',
      urlChanged: false,
      titleChanged: false,
      added: [],
      removed: [],
      compared: [],
      brief: '没有我上次看到时的页面快照可以比对（这一路在此之前还没读过页）。请直接根据**当前**页面判断下一步，不要假设它和之前一样。',
    };
  }

  const urlChanged = normUrl(before.url) !== normUrl(after.url);
  const titleChanged = String(before.title ?? '').trim() !== String(after.title ?? '').trim();

  // 只比「人话级」的四类可见元素；texts（正文片段）也纳入，因为登录后正文变化常常是唯一线索
  const groups: Array<[string, string[], string[]]> = [
    ['按钮', clean(before.buttons), clean(after.buttons)],
    ['链接', clean(before.links), clean(after.links)],
    ['输入框', clean(before.inputs), clean(after.inputs)],
    ['正文', clean(before.texts), clean(after.texts)],
  ];

  const added: string[] = [];
  const removed: string[] = [];
  for (const [, b, a] of groups) {
    const d = diff(b, a);
    for (const x of d.added) if (!added.includes(x)) added.push(x);
    for (const x of d.removed) if (!removed.includes(x)) removed.push(x);
  }
  const compared = groups.map(([name]) => name).filter((name, i) => {
    const [, b, a] = groups[i];
    return b.length > 0 || a.length > 0;
  });

  const elementChanged = added.length > 0 || removed.length > 0;
  // ★ 只认「地址变了」才算换了页面。
  //   曾经这里写的是 `urlChanged || titleChanged`，结果踩了这个坑（验证码场景实测）：
  //   用户停在同一张登录页上手动填完验证码 → 页面只是**标题**从「登录验证」变成「验证通过」，
  //   地址一个字没动，却被判成 moved，于是给模型的话变成「页面已经换了一张 / 你已经不在原来那个页面了」，
  //   模型真的照着问「要在这张新页面上继续吗」—— 明明用户哪儿也没去，纯属凭空制造困惑。
  //   标题变化是「同一页的状态推进」，语义上属于 edited，不是换页。
  const kind: PageDeltaKind = urlChanged
    ? 'moved'
    : titleChanged || elementChanged
      ? 'edited'
      : 'unchanged';

  /**
   * ★ 话术里**不能**再写死「暂停前 / 暂停期间」。
   *   重新感知现在有两条来源：① 用户按了暂停；② AI 自己停下来问用户（waiting）。
   *   第 ② 种情况下用户根本没按过暂停，说「跟你暂停时不一样」会让人愣一下：
   *   「我什么时候暂停了？」（场景 s13 实测）。统一说成「我上次看到时 / 这段时间里」。
   */
  let brief: string;
  if (kind === 'unchanged') {
    brief =
      '我重新读了当前页面：地址、标题和可见元素都和**我上次看到时一致**，这段时间里这个页面没有变化。' +
      '按原计划继续即可。';
  } else if (kind === 'moved') {
    brief =
      `我重新读了当前页面：**页面已经换了一张**（${urlChanged ? `地址从 ${before.url || '（空）'} 变成了 ${after.url || '（空）'}` : ''}` +
      `${urlChanged && titleChanged ? '；' : ''}${titleChanged ? `标题从「${before.title}」变成了「${after.title}」` : ''}）。` +
      '这说明这段时间里这张页面被操作过（多半是你自己）。**严禁**用 open_url 跳回我上次看到时的地址——' +
      '那会覆盖你刚做的操作。' +
      '请先基于**现在这张页**判断它离任务目标还有多远，再决定下一步；如果现在已经偏离目标，就停下来问我。';
  } else {
    // edited：地址没变。标题变了要单独说清楚 —— 它往往是「这一步已经做完了」的信号
    //（登录完成、验证通过、提交成功），比元素差集更能说明发生了什么。
    brief =
      '我重新读了当前页面：**地址没变**' +
      (titleChanged ? `，但标题从「${before.title}」变成了「${after.title}」` : '') +
      '，页面内容和**我上次看到时**不一样了。这可能是你自己操作的（例如登录、填完验证码、关掉弹窗、'
      + '展开内容），也可能是**页面自己更新的** —— 轮播广告、实时行情、倒计时、自动刷新这类东西'
      + '都会自己变，**我分不清是哪一种，不要想当然地认定是用户干的**。' +
      `新出现的元素：${join(added.slice(0, 5))}；消失的元素：${join(removed.slice(0, 5))}。` +
      '请基于**现在看到的内容**重新判断离目标还有多远，不要重做你已经手动完成的部分；' +
      '也不要用 open_url 重新打开当前地址——刷新会把你刚做的操作冲掉。';
  }

  return { kind, urlChanged, titleChanged, added, removed, compared, brief };
}
