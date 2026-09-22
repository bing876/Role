/**
 * 多智能体编排 · **桌面端**验收：循环挂在后台子任务上时，桌面到底做了什么。
 *
 * ★ 为什么单开一个脚本验桌面这一半：
 *   服务端那套 park 机制（`orc-park.mts`）验的是「结果回来了、循环翻回 running」。
 *   但**结果回来之后得有人去取**。桌面端的驱动循环原本对任何 `ask` 都是
 *   `return finish('ask_user')` —— 本地循环当场退出，**再没有人调 `/next`**。
 *   于是服务端把结果备好了、循环也活着，任务却永远停在半路：
 *   用户看到「卡住了」，而这恰恰是用户明确要求防住的「挂死」。
 *   这条断链只有把桌面那一半也跑一遍才看得见。
 *
 * 这里 import 的是**真实的** `runToolLoop`（不是抄一份逻辑），用假 hooks 注入：
 *   ① 遇到 `job_pending` **继续驱动**（`next` 被反复调用），而不是退出；
 *   ② **不**发 `ask` 事件、**不**弹人工介入卡片 —— 等同事交活不是「AI 卡住了」，
 *      报成求助就是狼来了；
 *   ③ **不**调 `stopLoop` —— 停掉服务端循环，结果回来也投不进去；
 *   ④ 服务端最终回 `done` 时，本地能正常收尾（证明这条链真的接上了）；
 *   ⑤ 等结果期间用户按暂停 → **立刻**停手（不能因为「在等」就不理会暂停）；
 *   ⑥ 服务端一直不给结果 → 到本地兜底时限**如实放弃**，不无限等。
 *
 * 用法：npx tsx scripts/verify/orc-desktop-park.mts
 */
import assert from 'node:assert/strict';
import { runToolLoop, type ToolLoopHooks } from '../../apps/desktop/electron/agent';
import type { AgentLoopDecision, AgentEventPayload, BrowserAction, DriveResult, LoopToolResult } from '@ai-workbench/shared';

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

/** 记录桌面端做过的每一件事，供断言用 */
interface Recorder {
  nextCalls: number;
  events: AgentEventPayload[];
  phases: Array<{ next: string; detail: string; by?: string }>;
  stopLoopReasons: string[];
  raiseHelpCalls: number;
  statuses: string[];
  sleepCalls: number[];
}

interface FakeOpts {
  /** 第 N 次 next 要回什么（超出则重复最后一个） */
  script: AgentLoopDecision[];
  /** sleep 真的睡多久（测试里给 1ms，别真等 2.5 秒） */
  sleepMs?: number;
  /** 第几次 next 之后把 isPaused 翻成 true */
  pauseAfter?: number;
}

function makeHooks(rec: Recorder, opts: FakeOpts): ToolLoopHooks {
  let paused = false;
  return {
    async next(_loopId: string, _result: LoopToolResult | null): Promise<AgentLoopDecision> {
      rec.nextCalls += 1;
      if (opts.pauseAfter !== undefined && rec.nextCalls >= opts.pauseAfter) paused = true;
      return opts.script[Math.min(rec.nextCalls - 1, opts.script.length - 1)];
    },
    async exec(_action: BrowserAction): Promise<DriveResult> {
      return { ok: true, changed: false, snapshot: null } as DriveResult;
    },
    isPaused: () => paused,
    aborted: () => false,
    emit: (payload: AgentEventPayload) => {
      rec.events.push(payload);
    },
    stopLoop: (reason: string) => {
      rec.stopLoopReasons.push(reason);
    },
    pauseLoop: async () => undefined,
    raiseHelp: () => {
      rec.raiseHelpCalls += 1;
    },
    phase: (next, detail, by) => {
      rec.phases.push({ next, detail, ...(by ? { by } : {}) });
    },
    taskStart: async () => 4242,
    taskStep: async () => undefined,
    taskStatus: async (_id, status) => {
      rec.statuses.push(status);
    },
    taskFinish: async () => undefined,
    sleep: async (ms: number) => {
      rec.sleepCalls.push(ms);
      await new Promise((r) => setTimeout(r, opts.sleepMs ?? 1));
    },
  };
}

const newRec = (): Recorder => ({
  nextCalls: 0,
  events: [],
  phases: [],
  stopLoopReasons: [],
  raiseHelpCalls: 0,
  statuses: [],
  sleepCalls: [],
});

/** 服务端「挂在后台子任务上」那一格（字段与 /agent/loop/next 真实回的一致） */
const JOB_PENDING = (etaMs: number): AgentLoopDecision => ({
  kind: 'ask',
  reason: 'job_pending',
  question: '我已经把这件事交给「母鸡」了，最多等 10 分钟。这一步我先停下来等它，结果一回来就自动接着做。',
  step: 1,
  jobId: 'job_test_1',
  jobKind: 'delegate',
  etaMs,
});

const DONE: AgentLoopDecision = {
  kind: 'done',
  summary: '三家定价分别是 99 / 199 / 299',
  document_title: '定价对比',
  document_outline: ['甲 99', '乙 199', '丙 299'],
  step: 2,
};

async function main(): Promise<void> {
  log('=== 多智能体编排 · 桌面端 park 处理验收 ===');

  // ---------------------------------------------------------------- ①②③④
  log('');
  log('--- ①②③④ 挂在子任务上：继续驱动、不报求助、不停循环、结果回来能收尾 ---');
  {
    const rec = newRec();
    // 前 3 格都是 job_pending，第 4 格结果回来了
    const hooks = makeHooks(rec, { script: [JOB_PENDING(600_000), JOB_PENDING(600_000), JOB_PENDING(600_000), DONE] });
    const outcome = await runToolLoop('loop_test_1', '把三家竞品的定价查一遍', hooks);

    await check('★ 遇到 job_pending **继续驱动**（next 被调了 4 次，不是 1 次就退出）', () => {
      assert.ok(rec.nextCalls >= 4, `next 只被调了 ${rec.nextCalls} 次 —— 桌面在第一格就退出了，结果回来没人取`);
      assert.equal(outcome, 'done', `收尾原因是 ${outcome}，该是 done`);
    });
    await check('每次等待之间真的睡了（不是忙轮询打爆本地服务）', () => {
      assert.ok(rec.sleepCalls.length >= 3, `只睡了 ${rec.sleepCalls.length} 次`);
      assert.equal(rec.sleepCalls[0], 2_500, `轮询间隔是 ${rec.sleepCalls[0]}ms，该是 2500ms`);
    });
    await check('★ **不**发 ask 事件（等同事交活不是「AI 卡住了要人帮忙」）', () => {
      const asks = rec.events.filter((e) => e.kind === 'ask');
      assert.equal(asks.length, 0, `发了 ${asks.length} 个 ask 事件 —— 用户会看到假的「需要协助」`);
    });
    await check('★ **不**弹人工介入卡片（raiseHelp 一次都没调）', () => {
      assert.equal(rec.raiseHelpCalls, 0, `弹了 ${rec.raiseHelpCalls} 次求助卡片`);
    });
    await check('★ **不**调 stopLoop（停掉服务端循环，结果就投不进来了）', () => {
      assert.deepEqual(rec.stopLoopReasons, [], `调了 stopLoop：${rec.stopLoopReasons.join(',')}`);
    });
    await check('等待期间状态是 running（不是 paused —— 它没停，只是在等）', () => {
      const waiting = rec.phases.filter((p) => /交给「母鸡」/.test(p.detail));
      assert.ok(waiting.length >= 3, `等待态的 phase 只有 ${waiting.length} 条`);
      assert.ok(
        waiting.every((p) => p.next === 'running'),
        `等待期间状态不是 running：${JSON.stringify(waiting.map((p) => p.next))}`,
      );
    });
    await check('结果回来后正常收尾（done），任务状态记成 done', () => {
      assert.ok(rec.statuses.includes('done'), `任务状态里没有 done：${rec.statuses.join(',')}`);
    });
  }

  // ---------------------------------------------------------------- ⑤ 暂停优先
  log('');
  log('--- ⑤ 等结果期间用户按暂停 → 立刻停手 ---');
  {
    const rec = newRec();
    // 永远 job_pending；第 2 次 next 之后把 isPaused 翻成 true
    const hooks = makeHooks(rec, {
      script: [JOB_PENDING(600_000)],
      pauseAfter: 2,
    });
    const t0 = Date.now();
    const outcome = await runToolLoop('loop_test_2', '再来一遍', hooks);
    const took = Date.now() - t0;

    await check('按了暂停就退出（返回 paused），不再继续轮询', () => {
      assert.equal(outcome, 'paused', `收尾原因是 ${outcome}，该是 paused`);
      assert.ok(rec.nextCalls <= 3, `暂停后还在问下一步（next=${rec.nextCalls} 次）`);
      assert.ok(took < 3_000, `退出用了 ${took}ms —— 暂停不是「立刻停手」`);
    });
    await check('退出走的是 pauseLoop（保留历史，「继续」能接回来），不是 stopLoop', () => {
      assert.deepEqual(rec.stopLoopReasons, [], `调了 stopLoop：${rec.stopLoopReasons.join(',')} —— 「继续」就接不回来了`);
      assert.ok(rec.statuses.includes('paused'), `任务状态没记 paused：${rec.statuses.join(',')}`);
    });
  }

  // ---------------------------------------------------------------- ⑥ 本地兜底时限
  log('');
  log('--- ⑥ 服务端一直不给结果 → 到本地兜底时限如实放弃（不无限等） ---');
  {
    const rec = newRec();
    // etaMs=1 → 本地兜底时限 = 现在 + 1ms + 15s 余量，约 15 秒后放弃
    const hooks = makeHooks(rec, { script: [JOB_PENDING(1)] });
    const t0 = Date.now();
    const outcome = await runToolLoop('loop_test_3', '第三遍', hooks);
    const took = Date.now() - t0;

    await check('到点放弃（返回 ask_user 把浏览器交还用户），不是无限轮询', () => {
      assert.equal(outcome, 'ask_user', `收尾原因是 ${outcome}`);
      assert.ok(took >= 14_000, `只等了 ${took}ms 就放弃 —— 比兜底时限短太多`);
      assert.ok(took < 30_000, `等了 ${took}ms —— 兜底时限没生效`);
    });
    await check('放弃时**如实说明**（error 级 → 界面画 ⚠️，告诉用户可以先接管）', () => {
      const note = rec.events.find((e) => e.kind === 'note' && /超过/.test(e.text));
      assert.ok(note, `没有如实说明：${JSON.stringify(rec.events.map((e) => e.kind))}`);
      if (note?.kind === 'note') {
        // 级别必须是 error：渲染端只对 error 画 ⚠️ 并刷新驾驶状态（info 只是一行小字，用户会漏看）
        assert.equal(note.level, 'error', `级别是 ${note.level}，界面不会画 ⚠️`);
      }
    });
    await check('放弃时状态转 paused（不是 failed —— 不是出错，只是没等到）', () => {
      const last = rec.phases[rec.phases.length - 1];
      assert.equal(last?.next, 'paused', `最后状态是 ${last?.next}`);
      assert.ok(rec.statuses.includes('paused'));
    });
  }

  log('');
  log('=== 结论 ===');
  log(`  ${passes} PASS / ${fails} FAIL`);
  if (fails > 0) process.exitCode = 1;
}

void main();
