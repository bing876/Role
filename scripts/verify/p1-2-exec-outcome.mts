/**
 * P1-2 修复验收（2026-09-29）· **超时不再是"失败"，而是"不确定"**。
 *
 * ## 修的什么（接手报告 §10.2 的 P1-2，此前一直未修）
 *
 * 原状两句话：
 *   ① 所有动作统一 `EXEC_TIMEOUT_MS = 20_000`（`agent.ts`）；
 *   ② `LoopToolResult` 没有 outcome/timeout 字段。
 * ⇒ 「执行了但慢」与「确定失败」不可区分，**超时后会盲目重做**。
 *
 * ## 两个必现 bug（不是理论）
 *
 *   **bug A · 超时被当成失败 ⇒ 盲目重做**
 *     `Promise.race([hooks.exec(action), timeout])` 超时后，**不会取消**
 *     `hooks.exec(action)` —— 那一下点击照样发出去。可系统这边已经拿到
 *     `{ok:false}` 并告诉模型"失败"。模型于是重试。
 *     用户让 AI 买东西/填表/发消息时，这就是**下两单、发两条、提交两次**。
 *
 *   **bug B · `wait` 在 20~30 秒之间必然假失败**
 *     driver 允许 `wait` 0~300 秒（MAX_WAIT_SECONDS），实际睡眠上限 30 秒；
 *     而 race 的超时是 20 秒。于是任何 20~30 秒的 wait **都被判失败**，
 *     尽管它成功了。附带：`detail` 写的是"等待了 ${action.seconds}s"
 *     （模型要求的值），实际只睡了 min(seconds,30) —— **对模型谎报时长**，
 *     它会据此判断"已经等够了"，在页面还没加载完时就去点下一步。
 *
 * ## 修法
 *
 *   ① `DriveResult` / `LoopToolResult` 加 `outcome: 'done'|'failed'|'unknown'`（可选字段，不破坏旧码）
 *   ② `execTimeoutFor(action)` 按动作定超时：wait = 自己要等的 + 余量；
 *      open_url/read_page/screenshot 放长；fill_form 按字段数放大；其余仍 20s
 *   ③ 超时标 `outcome:'unknown'`，驾驶循环单独走一条路：**先 read_page 确认**，
 *      再让模型基于当前页面决定，而不是直接重试；连 3 次不确定就停下来问人
 *   ④ driver 的 wait 报**真实等了的**秒数，超上限时如实说明被截断
 *
 * ## 本脚本盖什么 / 盖不到什么
 *
 * 盖：`execTimeoutFor` 的纯函数口径 + `toResult` 的透传 + driver 的 wait 口径。
 * 盖不到：`Promise.race` 那一段的真实时序（要真起一个挂住的 exec 等 20 秒），
 *         以及"模型收到 unknown 后确实没有重试"（那要真模型）。这两条只能靠
 *         人工/端到端，脚本里明确标注，不假装盖到了。
 *
 * 用法：npx tsx scripts/verify/p1-2-exec-outcome.mts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const { execTimeoutFor } = req('../../apps/desktop/electron/agent') as typeof import('../../apps/desktop/electron/agent');

let pass = 0;
const ok = (name: string): void => {
  pass += 1;
  console.log(`  PASS ${name}`);
};

function main(): void {
  // =====================================================================
  // ① execTimeoutFor：wait 必须比自己要等的时间长（bug B 的核心）
  // =====================================================================
  {
    // 这几个秒数在原状下**全部**会假失败（race 超时 20s < wait 自己要等的时间）
    for (const s of [20, 21, 25, 30]) {
      const t = execTimeoutFor({ action: 'wait', seconds: s });
      const actualSleepMs = Math.min(Math.max(s, 0), 30) * 1000; // driver 的口径
      assert.ok(
        t > actualSleepMs,
        `wait ${s}s 的超时必须大于它实际睡眠 ${actualSleepMs}ms，实际 ${t}ms（<= 就是必现假失败）`,
      );
    }
    ok('★ wait 20/21/25/30 秒的超时都大于其实际睡眠（不再必现假失败）');

    // 上限截断：要 300 秒也不会真等 300（driver 截到 30），但超时要覆盖那个 30
    const big = execTimeoutFor({ action: 'wait', seconds: 300 });
    assert.ok(big > 30_000, `wait 300s 的超时要覆盖被截到的 30s 睡眠，实际 ${big}`);
    ok('wait 要 300 秒时：超时覆盖被截到的 30 秒睡眠（不按 300 等，也不按 20 秒判失败）');

    // 边界：0 秒 / 负数都不该给出荒谬的超时
    for (const s of [0, -5]) {
      const t = execTimeoutFor({ action: 'wait', seconds: s });
      assert.ok(t >= 1_000 && Number.isFinite(t), `wait seconds=${s} 的超时应合理，实际 ${t}`);
    }
    ok('wait seconds=0 / 负数：超时仍合理（不会变成 0 或负数）');
  }

  // =====================================================================
  // ② open_url / read_page 要比交互类动作长（加载页面不是 20 秒能搞定的）
  // =====================================================================
  {
    const click = execTimeoutFor({ action: 'click', target: 'x' });
    const openUrl = execTimeoutFor({ action: 'open_url', url: 'https://example.com' });
    const readPage = execTimeoutFor({ action: 'read_page' });
    const scroll = execTimeoutFor({ action: 'scroll', direction: 'down' });
    assert.ok(openUrl > click, `open_url(${openUrl}) 应比 click(${click}) 长`);
    assert.ok(readPage > scroll, `read_page(${readPage}) 应比 scroll(${scroll}) 长`);
    ok('open_url / read_page 的超时比交互类动作长（等页面加载不该按 20 秒算）');

    // 交互类动作保持 20 秒不放长（那些是本地 CDP 调用，挂住就是真卡）
    assert.equal(click, 20_000, `click 应保持 20s，实际 ${click}`);
    assert.equal(scroll, 20_000, `scroll 应保持 20s，实际 ${scroll}`);
    ok('click / scroll 仍保持 20s（本地 CDP 调用，长等没意义）');

    // fill_form 按字段数放大：3 个字段必须比 1 个字段给得多
    const f1 = execTimeoutFor({ action: 'fill_form', fields: [{ target: 'a', text: '1' }] });
    const f3 = execTimeoutFor({
      action: 'fill_form',
      fields: [
        { target: 'a', text: '1' },
        { target: 'b', text: '2' },
        { target: 'c', text: '3' },
      ],
    });
    assert.ok(f3 > f1, `fill_form 3 字段(${f3}) 应比 1 字段(${f1}) 长`);
    assert.ok(f3 >= 20_000, `fill_form 至少给够基础 20s，实际 ${f3}`);
    ok('fill_form 按字段数放大超时');
  }

  // =====================================================================
  // ③ 类型与透传：outcome 字段真的在，且 toResult 会带出去
  // =====================================================================
  {
    const sharedSrc = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '../../packages/shared/src/index.ts',
    );
    const src = fs.readFileSync(sharedSrc, 'utf8');
    assert.ok(
      /outcome\?:\s*'done'\s*\|\s*'failed'\s*\|\s*'unknown'/.test(src),
      'DriveResult/LoopToolResult 上必须有 outcome 三态字段',
    );
    ok('shared 类型上有 outcome: done|failed|unknown');

    const agentSrc = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '../../apps/desktop/electron/agent.ts',
    );
    const a = fs.readFileSync(agentSrc, 'utf8');
    assert.ok(
      /\.\.\.\(res\.outcome \? \{ outcome: res\.outcome \} : \{\}\)/.test(a),
      'toResult 必须把 outcome 透传出去（否则服务端/模型看不到）',
    );
    ok('toResult 透传 outcome（服务端与模型都看得到）');

    // 超时那条必须标 unknown，且文案里必须含"不要直接重试"
    assert.ok(/outcome: 'unknown'/.test(a), '超时路径必须标 outcome:\'unknown\'');
    assert.ok(
      /不要直接重试同一个动作/.test(a),
      '超时文案必须明确告诉模型"不要直接重试"（文案决定它下一步怎么做）',
    );
    ok('超时路径标 unknown + 文案明确禁止直接重试');

    // 驾驶循环必须有独立的 unknown 分支（不被并进 fails）
    assert.ok(
      /if \(res\.outcome === 'unknown' \|\| timedOut\)/.test(a),
      '必须有独立的 unknown 分支，不能并进 fails（并进去就退回"盲目重做"）',
    );
    assert.ok(/uncertain \+= 1/.test(a), 'unknown 要单独计数');
    assert.ok(/UNCERTAIN_BEFORE_ASK/.test(a), '连 N 次不确定要停下来问人');
    ok('驾驶循环有独立 unknown 分支：单独计数 + 到阈值停下来问人');

    // unknown 分支必须先 read_page 确认
    assert.ok(
      /hooks\.exec\(\{ action: 'read_page' \}\)/.test(a),
      'unknown 分支必须先 read_page 确认再让模型决定',
    );
    ok('unknown 分支先 read_page 确认（不是直接重试）');
  }

  // =====================================================================
  // ④ driver 的 wait 不再谎报时长
  // =====================================================================
  {
    const driverSrc = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '../../apps/desktop/electron/driver.ts',
    );
    const d = fs.readFileSync(driverSrc, 'utf8');
    // 旧代码：detail 用 action.seconds（模型要求的值）—— 那就是谎报
    // ★ 只匹配**真赋值行**（行首是空白），不匹配注释 —— 注释里引用旧代码会让
    //   grep 永远误报。2026-09-29 首版就踩了这个坑：断言红，但代码其实是对的。
    assert.ok(
      !/^\s+detail = `等待了 \$\{action\.seconds\}s`/m.test(d),
      'wait 的 detail 不许再用 action.seconds（那是模型要求的值，不是真实等了的）',
    );
    assert.ok(/const actual = Math\.min\(Math\.max\(asked, 0\), MAX_WAIT_SECONDS_CLAMPED\)/.test(d), '必须按截断后的真实值睡眠');
    assert.ok(
      /已按上限执行/.test(d),
      '超过上限时必须如实说明被截断了（不能让模型以为等够了）',
    );
    ok('driver 的 wait 报真实等了的秒数，超上限时如实说明被截断');
  }

  console.log(`\n=== P1-2 修复验收：${pass} PASS / 0 FAIL ===`);
  console.log('  ① execTimeoutFor：wait 比自己长 / open_url·read_page 更长 / 交互类仍 20s / fill_form 按字段');
  console.log('  ② outcome 三态字段 + toResult 透传');
  console.log('  ③ 超时标 unknown + 独立分支（先 read_page、单独计数、到阈值问人）');
  console.log('  ④ driver 的 wait 不谎报时长');
  console.log('  盖不到（需人工/端到端）：真实时序的 race 行为；模型收到 unknown 后确实没重试');
}

main();
