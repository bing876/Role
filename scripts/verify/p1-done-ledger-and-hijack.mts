/**
 * P1 二连修 · 验收与反证（2026-09-29）
 *
 * 来源：`docs/待办清单-P2P3重排-20260920.md` §1 的两条 P1
 * （那份清单把它们排成「建议下一批就做」，本轮做掉）。
 *
 * ## #6 · `done` 集合整体清空 → 已处理过的会话被**再抽一遍**
 *
 *    原状：if (done.size > 800) done.clear();
 *
 * 这是 §4 点名批评的**同一个模式**，和 #4（`ipHits.size > 5000 → clear()`）是同胞：
 *
 *   **「容量压力下整体清空集合」是一个会自我失效的防线。**
 *
 * 后果：`done` 清空的下一秒，那些**还落在 15~60 分钟闲置窗口内**的会话又变成
 * "没处理过" → 下一轮扫描**再整理一次记忆**。同一切点重复喂模型，用户无感但**计费**。
 * 而且**越是会话多、压力越大的账号越容易撞上** —— 防线恰好在最需要它时失效。
 *
 * 修法（照 #4 的定案：**永远不整体清空**）：记 `{key → at}`，超上限时
 * ① 先淘汰**过期**的（早就过了 60 分钟窗口、永远扫不到）；
 * ② 仍超上限，按最旧逐条淘汰少量（兜底，正常走不到）。
 *
 * ## 怀疑 4 · `hijack()` 之后还去碰 `reply` → 真因被框架报错盖掉
 *
 * 原状：`/chat/stream` handler 有 6 处 `reply.hijack()`，而**外层 catch 无条件**
 * `return dbErr(reply, err)`。异常抛在 hijack 之后、内层 try/catch 之外时，
 * `dbErr` → `reply.code(503).send()` 打在**已被手写 SSE 接管**的响应上
 * → Fastify 抛 "Reply was already sent" → **真实错误被盖掉**，
 * 排查时看到的是框架噪音。
 *
 * 修法：6 处 hijack 统一收口到带标志的 `hijackOnce()`；外层 catch 分两段 ——
 * 没 hijack 才走 `dbErr`，hijack 了就写进 SSE + `res.end()`，真因先进日志。
 *
 * ## 反证（已逐条实测会红）
 *
 *   #6   把 `sweepDoneLedger` 换回整体 clear → 「绝不整体清空」红
 *   #6   把 TTL 淘汰去掉 → 「过期切点必须被淘汰」红
 *   怀疑4 把 `if (hijacked)` 改成 `if (false)` → 「hijack 后不许再碰 reply」红
 *   怀疑4 删掉一处 `hijackOnce()` 改回裸 `reply.hijack()` → 「6 处全部收口」红
 *
 * 用法：npx tsx scripts/verify/p1-done-ledger-and-hijack.mts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const {
  DONE_MAX,
  DONE_TTL_MS,
  makeDoneLedger,
  markDone,
  sweepDoneLedger,
} = req('../../apps/server/src/doneLedger') as typeof import('../../apps/server/src/doneLedger');

let pass = 0;
const ok = (name: string): void => {
  pass += 1;
  console.log(`  PASS ${name}`);
};

const repo = (rel: string): string => path.join(path.dirname(new URL(import.meta.url).pathname), '../..', rel);

function main(): void {
  // =====================================================================
  // ① #6 的核心：**绝不整体清空**
  // =====================================================================
  {
    const led = makeDoneLedger();
    const t0 = 1_000_000;
    // 灌 500 条：全部在 TTL 内（都是"热"切点），且**低于上限**，
    // 这样测的是"没有任何理由淘汰时，一条都不该消失"。
    // （首版这里灌了 900 条 > DONE_MAX，于是踩到容量兜底②，断言写错了 ——
    //   兜底是另一条路径，单独在下面测。）
    const N = 500;
    for (let i = 0; i < N; i += 1) markDone(led, `c${i}:100`, t0);

    const before = new Set(led.keys());
    assert.equal(before.size, N);
    const r1 = sweepDoneLedger(led, t0 + 1000); // 才过 1 秒，没有任何一条过期

    // 关键断言：**一条都不许消失**。原状在这里会 clear() 成 0 条。
    const after = new Set(led.keys());
    assert.equal(
      after.size,
      before.size,
      `压力下整体清空又回来了：sweep 后从 ${before.size} 条变成 ${after.size} 条（原状会变 0）`,
    );
    for (const k of before) assert.ok(after.has(k), `热切点 ${k} 被误淘汰了`);
    assert.equal(r1.expired, 0, '没有过期切点，expired 应为 0');
    assert.equal(r1.capped, 0, '没到上限，capped 应为 0（>0 说明兜底被误触发）');
    ok(`★ ${N} 条全在 TTL 内且低于上限时，sweep 后一条不少（原状会整体清空成 0）`);

    // 被淘汰的只能是"已经没用的"：过期的那批
    const led2 = makeDoneLedger();
    for (let i = 0; i < 100; i += 1) markDone(led2, `old${i}:1`, t0);
    for (let i = 0; i < 100; i += 1) markDone(led2, `new${i}:1`, t0 + DONE_TTL_MS + 60_000);
    const r2 = sweepDoneLedger(led2, t0 + DONE_TTL_MS + 60_000);
    let oldLeft = 0;
    let newLeft = 0;
    for (const k of led2.keys()) (k.startsWith('old') ? (oldLeft += 1) : (newLeft += 1));
    assert.equal(oldLeft, 0, `过期的旧切点必须被淘汰干净，还剩 ${oldLeft} 条`);
    assert.equal(newLeft, 100, `热切点不该被淘汰，却只剩 ${newLeft} 条`);
    assert.equal(r2.expired, 100, 'expired 应精确报 100 条（供调用方区分常态与异常）');
    assert.equal(r2.capped, 0, '没过上限，capped 应为 0');
    ok('优先淘汰已过期的（永远扫不到的）切点，热切点一条不动');

    // ② 兜底路径：连过期都淘汰不掉仍超上限 → 按最旧逐条淘汰，仍不清空
    const led3 = makeDoneLedger();
    for (let i = 0; i < DONE_MAX + 50; i += 1) markDone(led3, `k${i}`, t0); // 同一时刻，全"热"
    const r3 = sweepDoneLedger(led3, t0 + 1000);
    assert.ok(
      led3.size > 0 && led3.size <= DONE_MAX,
      `兜底应逐条淘汰到上限以内，实际 size=${led3.size}（清空成 0 就是整体清空回来了）`,
    );
    assert.equal(r3.expired, 0, '这些切点都是热的，expired 应为 0');
    assert.equal(r3.capped, 50, `capped 应精确报 50 条（= 850-800），实际 ${r3.capped}`);
    ok(`兜底按最旧逐条淘汰到上限以内（size=${led3.size} ≤ ${DONE_MAX}，capped=${r3.capped}），仍不清空`);

    // markDone 的幂等语义：同一 key 第二次返回 false（调用方据此跳过，不重复整理）
    const led4 = makeDoneLedger();
    assert.equal(markDone(led4, 'a:1', t0), true, '第一次应返回 true（要处理）');
    assert.equal(markDone(led4, 'a:1', t0 + 1), false, '同一 key 第二次必须返回 false（跳过，别重复整理）');
    assert.equal(led4.size, 1);
    ok('markDone 对同一切点只放行一次（这是"不重复整理"的真正闸门）');
  }

  // =====================================================================
  // ② #6 落盘：memories.ts 里那个整体 clear 必须消失
  // =====================================================================
  {
    const m = fs.readFileSync(repo('apps/server/src/routes/memories.ts'), 'utf8');
    assert.ok(!/done\.clear\(\)/.test(m), 'memories.ts 里不许再有 done.clear()（整体清空 = 防线自我失效）');
    assert.ok(!/new Set<string>\(\)\s*;?\s*\/\/.*done/.test(m), 'done 不该再是裸 Set');
    assert.ok(/makeDoneLedger\(\)/.test(m), '必须改用账本 makeDoneLedger()');
    assert.ok(/markDone\(done, key, now\)/.test(m), '必须走 markDone（它才是"不重复整理"的闸门）');
    assert.ok(/sweepDoneLedger\(done, now\)/.test(m), '必须走 sweepDoneLedger 逐条淘汰');
    assert.ok(!/done\.add\(/.test(m), '不许再走 Set.add（绕过 markDone 的幂等判断）');
    ok('memories.ts：整体 clear 已消除，改为账本 + markDone + 逐条淘汰');
  }

  // =====================================================================
  // ③ 怀疑 4：hijack 之后绝不碰 reply
  // =====================================================================
  {
    const c = fs.readFileSync(repo('apps/server/src/routes/chat.ts'), 'utf8');

    // 6 处 hijack 必须**全部**收口到 helper（漏一处，防线就漏一处）
    const rawHijack = (c.match(/^[ \t]*reply\.hijack\(\);[ \t]*$/gm) ?? []).length;
    assert.equal(rawHijack, 1, `裸 reply.hijack() 应只剩 helper 里那一处，实际 ${rawHijack}`);
    const helperCalls = (c.match(/hijackOnce\(\);/g) ?? []).length;
    assert.equal(helperCalls, 6, `6 处 hijack 都应改调 hijackOnce()，实际 ${helperCalls}`);

    // helper 必须真的置位（不置位 = 标志永远是 false = 防线不存在）
    assert.ok(
      /const hijackOnce = \(\): void => \{[\s\S]{0,200}?hijacked = true;[\s\S]{0,120}?reply\.hijack\(\);/.test(c),
      'hijackOnce 必须先置 hijacked=true 再 hijack',
    );

    // 外层 catch 必须分两段
    assert.ok(/if \(hijacked\) \{/.test(c), '外层 catch 必须按 hijacked 分两段');
    // hijack 之后那段不许再出现 reply.code(...).send(...)
    const tail = c.slice(c.indexOf('if (hijacked) {'));
    const seg = tail.slice(0, tail.indexOf('return dbErr(reply, err);'));
    assert.ok(
      !/reply\.code\(/.test(seg),
      'hijack 之后那段不许再调 reply.code(...)（那正是触发 "Reply was already sent" 的动作）',
    );
    assert.ok(/sse\(reply\.raw, 'error'/.test(seg), 'hijack 之后要把真因写进 SSE 流');
    assert.ok(/reply\.raw\.end\(\)/.test(seg), 'hijack 之后要结束那条流');
    // 真因必须落日志（否则盖掉之后连日志都没有）
    assert.ok(
      /console\.error\('\[chat\] \/chat\/stream 失败：', msg\)/.test(c),
      '真因必须先落日志，无论走哪一段',
    );
    ok('chat.ts：6 处 hijack 全部收口 + 外层 catch 分两段 + 真因落日志');

    // dbErr 本身不许被改坏（没 hijack 的路径仍要正常返 HTTP 错）
    assert.ok(/return dbErr\(reply, err\);/.test(c), '未 hijack 的路径仍必须走 dbErr（不能一刀切改成 SSE）');
    ok('未 hijack 的路径仍走 dbErr（不破坏既有错误响应）');
  }

  console.log(`\n=== P1 二连修验收：${pass} PASS / 0 FAIL ===`);
  console.log('  #6     done 账本：绝不整体清空 / 优先淘汰过期 / 兜底逐条 / markDone 幂等');
  console.log('  怀疑4  hijack 后绝不碰 reply：6 处全收口 / catch 分两段 / 真因落日志');
}

main();
