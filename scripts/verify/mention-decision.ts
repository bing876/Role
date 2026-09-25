/**
 * 批次 J · J3 | 服务端「@点名 → 这一轮怎么走」的决定层验收（R-A / R-B / R-C）
 * ==========================================================================
 *
 * 验的是生产代码本体：`apps/server/src/orchestrator/mention.ts` 的
 * `resolveChatMention` / `decisionNotice` / `decisionSpeaker` / `pickNoticeSpeaker`
 * —— 也就是 `routes/chat.ts` 每轮真正调用的那几个函数（不是抄一份来测）。
 *
 *   npm run verify:mention:decision      （已挂进 npm run verify 主链）
 *
 * ★ 为什么解析器（J1）之外还要这一层：
 *   解析器只管「文本里点到了谁」，而 R-A（忙不忙）、R-B（是不是自己）、
 *   「这句告知由谁开口」都是**服务端才知道**的事 —— 名单归属、registry 的名额表。
 *   这层错了，界面上看起来「点名生效了」，实际却把活派给了一个正在跑循环的智能体。
 *
 * ★ 忙/等这两个状态**不在库里**（registry 是内存名额表，跨重启本来就不该保留 ——
 *   见 orchestrator/roster.ts 的头注释）。所以 R-A 在这一层用真实的 registry API
 *   （markAgentBusy / markAgentWaiting）驱动，而不是造一个假的忙碌标记：
 *   走 HTTP 的那份端到端证据（mention-e2e.mjs）用 `/agent/loop/start` 让它真的忙起来。
 *
 * 覆盖：正常换人 / R-B（@ 自己 = 没点名，含「自己在前又点了别人」）/
 *       R-A（busy 与 waiting 都拦住，且不静默改派；释放后立刻恢复换人）/
 *       R-C（整条只有 @名字 → 反问，不调模型）/ 拍板1（@ 与名字之间有空格不算）/
 *       邮箱里的 @ 不算 / 名单外不算 / 拍板2（只认第一个命中）/
 *       告知由谁开口（绝不让正忙的那个替自己开口）/ 确定性 / unknown 透传
 *
 * ★★★ 为什么本文件是 `.ts` 而**不是** `.mts`（2026-09-25 修，改之前先读这段）
 * ---------------------------------------------------------------------------
 * 这一层必须**直接改服务端的内存状态**（`markAgentBusy` 写 registry、`startLoop`
 * 建循环），再断言 `resolveChatMention` 看得见。这就要求「测试 import 到的 registry」
 * 与「mention.ts 内部 import 到的 registry」**是同一个模块实例**。
 *
 * 但 `apps/server` 是 **CommonJS**（tsconfig `module: CommonJS` + package.json 无 `type`），
 * 而 `.mts` 强制 **ESM**。tsx 下 ESM 入口去 import CJS 模块时会**另起一份实例** ⇒
 *   · 测试的 markAgentBusy 写进实例 A
 *   · mention.ts → agentStatus.ts → registry.ts 读的是实例 B
 * ⇒ 忙标记永远看不见，11 条 R-A/busy 断言全红（表现为「决定是 switch，不是 busy」）。
 *
 * 实测对照（同一段代码、只换扩展名）：
 *   .ts  入口 → agentStatus 内部 busy=1 → working → 判定 busy   ✅
 *   .mts 入口 → agentStatus 内部 busy=0 → idle    → 判定 switch ❌
 *
 * 所以**不要把它改回 `.mts`**；同理，任何要读写服务端内存状态的验收脚本都得用 `.ts`。
 * 只测纯函数（如 J1 解析器 mention-parse.mts）的脚本不受影响，`.mts` 照旧。
 */
import assert from 'node:assert/strict';
import {
  decisionNotice,
  decisionSpeaker,
  pickNoticeSpeaker,
  resolveChatMention,
  type ChatMentionDecision,
  type MentionRosterEntry,
} from '../../apps/server/src/orchestrator/mention';
import {
  clearAgentBusy,
  clearAgentWaiting,
  markAgentBusy,
  markAgentWaiting,
} from '../../apps/server/src/orchestrator/registry';
import { resolveAgentStatus } from '../../apps/server/src/orchestrator/agentStatus';
import { startLoop, stopLoop } from '../../apps/server/src/toolLoop';
import type { ServerEnv } from '../../apps/server/src/env';

let passes = 0;
let fails = 0;
const log = (...a: unknown[]) => console.log(a.map(String).join(' '));

function check(label: string, fn: () => void): void {
  try {
    fn();
    passes += 1;
    log(`  PASS ${label}`);
  } catch (err) {
    fails += 1;
    log(`  ★FAIL ${label}  —— ${(err as Error).message}`);
  }
}

/** 当前项目名单（与 loadProjectRoster 同形：id + 名字） */
const ROSTER: MentionRosterEntry[] = [
  { id: 201, name: '小助' },
  { id: 202, name: '研究员' },
  { id: 203, name: '文案' },
  { id: 204, name: '项目管家' },
];
const XIAOZHU = 201;
const YANJIUYUAN = 202;
const WENAN = 203;
const HEN = 204;

const decide = (message: string, currentAgentId: number | null = XIAOZHU): ChatMentionDecision =>
  resolveChatMention({ roster: ROSTER, message, currentAgentId });

log('=== 批次 J · J3：服务端点名决定层（R-A / R-B / R-C）===');

// ------------------------------------------------------------------ ① 正常换人
log('');
log('--- ① 正常换人：被点名者空闲 → 这一轮由它发言，正文剥掉 @名字 ---');
{
  const d = decide('@研究员 帮我看看这组数据');
  log(`      ${JSON.stringify(d)}`);
  check('决定是 switch，发言人改成研究员（#202）', () => {
    assert.equal(d.kind, 'switch');
    assert.equal(decisionSpeaker(d), YANJIUYUAN);
  });
  check('R-C：交给模型的正文里没有 @名字', () => {
    assert.equal(d.kind === 'switch' ? d.text : null, '帮我看看这组数据');
  });
  check('这一轮不需要服务端替它说话（notice 为 null → chat.ts 会照常调模型）', () => {
    assert.equal(decisionNotice(d), null);
  });
  check('名单外的 @ 一个都没有（unknown 空）', () => {
    assert.deepEqual(d.unknown, []);
  });
}

// ------------------------------------------------------------------ ② R-B
log('');
log('--- ② R-B：@ 的就是当前发言人 → 视作没写 @（不改派、不报错、不重路由）---');
{
  const d = decide('@小助 你觉得呢', XIAOZHU);
  log(`      ${JSON.stringify(d)}`);
  check('决定是 self，不是 switch（没有「重新路由到自己」这种多余动作）', () => {
    assert.equal(d.kind, 'self');
    assert.equal(decisionSpeaker(d), null);
  });
  check('R-C 照样生效：正文剥掉 @小助', () => {
    assert.equal(d.kind === 'self' ? d.text : null, '你觉得呢');
  });
  check('不需要告知（照常调模型答话）', () => {
    assert.equal(decisionNotice(d), null);
  });

  const d2 = decide('@小助 @研究员 你们俩看看', XIAOZHU);
  check('反例：自己在前、又点了别人 → 仍按「没写 @」处理，**不**因为后面那个人就静默换人', () => {
    assert.equal(d2.kind, 'self');
    assert.equal(decisionSpeaker(d2), null);
    assert.equal(d2.kind === 'self' ? d2.mentions.length : 0, 2);
  });

  const d3 = decide('@小助 你觉得呢', YANJIUYUAN);
  check('反例：当前发言人是研究员时，@小助 就是**真换人**（self 只认「就是当前这位」）', () => {
    assert.equal(d3.kind, 'switch');
    assert.equal(decisionSpeaker(d3), XIAOZHU);
  });
}

// ------------------------------------------------------------------ ③ R-A
log('');
log('--- ③ R-A：被点名者正忙/在等 → 不静默改派，回一段「它在做什么 + 要不要等/换人」---');
{
  markAgentBusy(WENAN);
  try {
    const d = decide('@文案 帮我看下这段文案');
    log(`      ${JSON.stringify({ kind: d.kind, notice: d.kind === 'busy' ? d.notice : null })}`);
    check('决定是 busy（不是 switch）—— 忙的时候绝不改派', () => {
      assert.equal(d.kind, 'busy');
      assert.equal(decisionSpeaker(d), null, 'decisionSpeaker 必须为 null：这一轮不换人');
    });
    check('有 notice → chat.ts 走「不调模型、直接回这句」的分支', () => {
      const n = decisionNotice(d);
      assert.equal(typeof n, 'string');
      assert.ok((n ?? '').length > 10);
    });
    check('notice 说清了「它在做什么」+「要不要等 / 要不要换人」（R-A 的两件事都要有）', () => {
      const n = decisionNotice(d) ?? '';
      assert.ok(n.includes('文案'), '要点名是谁忙');
      assert.ok(/正在|手上|忙|等/.test(n), '要说它在做什么');
      assert.ok(/等/.test(n) && /别的智能体|换/.test(n), '要给出「等它」与「换人」两条路');
      assert.ok(!/已经交给|已改派|由它来/.test(n), '不许谎称已经改派');
    });
    check('反例：同一条消息，忙碌释放之后立刻恢复成 switch（拦住它的确实是「忙」，不是永久拒绝）', () => {
      clearAgentBusy(WENAN);
      const d2 = decide('@文案 帮我看下这段文案');
      assert.equal(d2.kind, 'switch');
      assert.equal(decisionSpeaker(d2), WENAN);
      markAgentBusy(WENAN); // 恢复现场，后面的用例还要用
    });
  } finally {
    clearAgentBusy(WENAN);
  }

  markAgentWaiting(YANJIUYUAN, 90001);
  try {
    const d = decide('@研究员 再看一下');
    check('waiting（正在等自己委派出去的结果）同样算忙 → busy，不改派', () => {
      assert.equal(d.kind, 'busy');
      assert.equal(decisionSpeaker(d), null);
      assert.ok((decisionNotice(d) ?? '').includes('研究员'));
    });
  } finally {
    clearAgentWaiting(YANJIUYUAN, 90001);
  }

  const d3 = decide('@研究员 再看一下');
  check('反例：名额释放之后，同一条消息又能正常换人（不是把研究员永久拉黑）', () => {
    assert.equal(d3.kind, 'switch');
    assert.equal(decisionSpeaker(d3), YANJIUYUAN);
  });

  check('反例：@ 的就是「正在忙的那位当前发言人」→ 先按 R-B 走（它本来就在跟你说话，谈不上改派）', () => {
    markAgentBusy(WENAN);
    try {
      assert.equal(decide('@文案 在吗', WENAN).kind, 'self');
    } finally {
      clearAgentBusy(WENAN);
    }
  });
  check('反例：当前发言人是小助时，@文案（空闲）才是真换人', () => {
    assert.equal(decide('@文案 在吗', XIAOZHU).kind, 'switch');
  });
}

// ------------------------------------------------------------------ ④ R-C 边界
log('');
log('--- ④ R-C 边界：整条只写了 @名字 → 反问要做什么，**不调模型** ---');
{
  const d = decide('@研究员');
  log(`      ${JSON.stringify({ kind: d.kind, notice: d.kind === 'empty' ? d.notice : null })}`);
  check('决定是 empty，并给出反问（拿空正文去问模型只会得到废话）', () => {
    assert.equal(d.kind, 'empty');
    const n = decisionNotice(d);
    assert.ok((n ?? '').includes('研究员'));
    assert.ok(/做什么|要做的事/.test(n ?? ''));
  });
  check('@名字 后面全是空白 → 同样算「只写了 @名字」', () => {
    assert.equal(decide('@研究员   \n  ').kind, 'empty');
  });
  check('反例：@名字 后面有正文 → 不是 empty（该换人就换人）', () => {
    const d2 = decide('@研究员 看一下');
    assert.equal(d2.kind, 'switch');
    assert.equal(decisionNotice(d2), null);
  });
}

// ------------------------------------------------------------------ ⑤ 不该命中的都不命中
log('');
log('--- ⑤ 拍板1 / 邮箱 / 名单外：一律「没点名」，正文一个字不动 ---');
{
  const d = decide('@ 研究员 你好');
  check('拍板1：@ 与名字之间有空格 → 不算点名（kind=none，不換人）', () => {
    assert.equal(d.kind, 'none');
    assert.equal(decisionSpeaker(d), null);
  });
  check('拍板1 的反面：没点名时正文**原样**交给模型（连空白都不收拾）', () => {
    assert.equal(d.kind === 'none' ? d.text : null, '@ 研究员 你好');
  });
  check('邮箱里的 @ 不算点名（foo@研究员.com）', () => {
    const d2 = decide('把结论发到 foo@研究员.com 谢谢');
    assert.equal(d2.kind, 'none');
  });
  check('名单外的名字不算点名，但要记进 unknown（排查「@ 了没反应」用）', () => {
    const d3 = decide('@accountant 帮我看账');
    assert.equal(d3.kind, 'none');
    assert.equal(decisionSpeaker(d3), null);
    assert.deepEqual(d3.unknown, ['accountant']);
  });
  check('反例：名单外 + 名单内同时出现 → 认名单内那个，名单外的进 unknown', () => {
    const d3b = decide('@accountant @文案 帮我看账');
    assert.equal(d3b.kind, 'switch');
    assert.equal(decisionSpeaker(d3b), WENAN);
    assert.deepEqual(d3b.unknown, ['accountant']);
  });
  check('反例：名单里的人 + 邮箱同时出现 → 只认真点名那一个', () => {
    const d4 = decide('抄送 foo@bar.com，@文案 你来看');
    assert.equal(d4.kind, 'switch');
    assert.equal(decisionSpeaker(d4), WENAN);
  });
}

// ------------------------------------------------------------------ ⑥ 拍板2
log('');
log('--- ⑥ 拍板2：点了多个人 → 只有第一个是发言人，其余进 mention 列表 ---');
{
  const d = decide('@研究员 @文案 一起看看这份报表');
  log(`      ${JSON.stringify(d)}`);
  check('发言人 = 第一个命中（研究员）', () => {
    assert.equal(d.kind, 'switch');
    assert.equal(decisionSpeaker(d), YANJIUYUAN);
  });
  check('mentions 里两个都在、顺序与用户写的一致（界面/日志要能看出还点了谁）', () => {
    const hits = d.kind === 'switch' ? d.mentions.map((m) => m.agentId) : [];
    assert.deepEqual(hits, [YANJIUYUAN, WENAN]);
  });
  check('R-C：两个 @名字 都从正文里摘掉', () => {
    assert.equal(d.kind === 'switch' ? d.text : null, '一起看看这份报表');
  });
  check('反例：第二个点了「正忙」的人，也不影响第一个换人（R-A 只管发言人那一位）', () => {
    markAgentBusy(WENAN);
    try {
      const d2 = decide('@研究员 @文案 一起看看');
      assert.equal(d2.kind, 'switch');
      assert.equal(decisionSpeaker(d2), YANJIUYUAN);
    } finally {
      clearAgentBusy(WENAN);
    }
  });
  check('反例：**第一个**点了正忙的人 → 整轮按 R-A 处理（不会因为后面还有个空闲的就偷偷换成后面那个）', () => {
    markAgentBusy(YANJIUYUAN);
    try {
      const d2 = decide('@研究员 @文案 一起看看');
      assert.equal(d2.kind, 'busy');
      assert.equal(decisionSpeaker(d2), null);
    } finally {
      clearAgentBusy(YANJIUYUAN);
    }
  });
}

// ------------------------------------------------------------------ ⑦ 告知由谁开口
log('');
log('--- ⑦ 那句「告知」由谁开口：绝不让正忙的那个替自己开口 ---');
{
  markAgentBusy(WENAN);
  try {
    const busy = decide('@文案 帮我看下');
    check('busy 时优先由**当前发言人**来说这句（会话里正在跟你说话的那位）', () => {
      assert.equal(busy.kind, 'busy');
      assert.equal(
        pickNoticeSpeaker({ decision: busy, currentSpeakerId: XIAOZHU, fallbackAgentId: null, roster: ROSTER }),
        XIAOZHU,
      );
    });
    check('当前发言人就是那个忙的（新会话没主人）→ 退到路由带来的那个，但**仍不能是它**', () => {
      assert.equal(
        pickNoticeSpeaker({ decision: busy, currentSpeakerId: null, fallbackAgentId: WENAN, roster: ROSTER }),
        HEN,
        '应该挑到项目管家（#204），而不是正忙的文案（#203）',
      );
    });
    check('谁都不可用、名单里只剩那个忙的 → 宁可 null（前端按「未知发言人」渲染），也不让忙的自己开口', () => {
      assert.equal(
        pickNoticeSpeaker({
          decision: busy,
          currentSpeakerId: null,
          fallbackAgentId: null,
          roster: [{ id: WENAN, name: '文案' }],
        }),
        null,
      );
    });
    const empty = decide('@研究员');
    check('empty（只写了 @名字）→ 优先让**被点名者自己**问「你要我做什么」（它此刻不忙）', () => {
      assert.equal(empty.kind, 'empty');
      assert.equal(
        pickNoticeSpeaker({ decision: empty, currentSpeakerId: XIAOZHU, fallbackAgentId: null, roster: ROSTER }),
        YANJIUYUAN,
      );
    });
  } finally {
    clearAgentBusy(WENAN);
  }
}

// ------------------------------------------------------------------ ⑨ 循环在跑 vs 循环已停
log('');
log('--- ⑨ 真循环驱动的忙/闲：跑着算忙，**停了不算忙**（blocked 不是「腾不出手」）---');
{
  /**
   * 这一段用**真的** startLoop / stopLoop 驱动状态，不是手搓一个假的忙碌标记：
   * `resolveAgentStatus` 看的就是这张循环表（生产里让一个智能体变忙的正是它）。
   * env 只用到 agentLoopMaxSteps 一个字段，所以给个最小对象（**只**替环境变量，不替任何产品逻辑）。
   */
  const fakeEnv = { agentLoopMaxSteps: 0 } as unknown as ServerEnv;
  const loop = startLoop(fakeEnv, {
    userId: 1,
    agentId: WENAN,
    conversationId: null,
    wcId: null,
    goal: '把这份资料整理成结论',
    pageUrl: '',
    state: null,
  });
  check('前置：循环建起来了，状态是 running', () => {
    assert.equal(typeof loop.id, 'string');
    assert.equal(resolveAgentStatus(WENAN).status, 'thinking');
  });
  check('循环正在跑 → @它 判为 busy（不改派，回告知）', () => {
    const d = decide('@文案 帮我看下这段');
    assert.equal(d.kind, 'busy');
    assert.equal(decisionSpeaker(d), null);
  });
  stopLoop(loop.id, 'verify_done');
  const after = resolveAgentStatus(WENAN);
  log(`      停掉之后 resolveAgentStatus = ${JSON.stringify(after)}`);
  check('前置：循环停掉之后，头像状态确实变成 blocked（这就是曾经的坑）', () => {
    assert.equal(after.status, 'blocked');
  });
  check('★反例（端到端 T3.10 打出来的那条）：blocked **不算忙** → 同一条消息立刻能换人', () => {
    const d = decide('@文案 帮我看下这段');
    assert.equal(d.kind, 'switch', 'blocked 被当成忙的话，智能体停过一次循环就五分钟内点不动了');
    assert.equal(decisionSpeaker(d), WENAN);
  });
}

// ------------------------------------------------------------------ ⑩ 确定性
log('');
log('--- ⑩ 确定性：同样的输入 + 同样的忙碌状态 → 同样的决定 ---');
{
  const a = decide('@研究员 @文案 一起看看这份报表');
  const b = decide('@研究员 @文案 一起看看这份报表');
  check('两次结果逐字段相同', () => {
    assert.deepEqual(a, b);
  });
  check('反例：名单顺序换一下，结果也不变（不依赖数组的偶然顺序）', () => {
    const c = resolveChatMention({
      roster: [...ROSTER].reverse(),
      message: '@研究员 @文案 一起看看这份报表',
      currentAgentId: XIAOZHU,
    });
    assert.deepEqual(c, a);
  });
}

log('');
log(`=== 批次 J · J3 决定层：PASS ${passes} / FAIL ${fails} ===`);
process.exit(fails > 0 ? 1 : 0);
