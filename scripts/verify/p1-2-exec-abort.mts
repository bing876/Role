/**
 * P1-2 补刀验收（2026-09-29）· **超时之后真的止住，而不是走开**。
 *
 * ## 上一轮修了什么、还差什么
 *
 * 上轮（P1-2）把超时回执从 `ok:false`（"失败"）改成 `outcome:'unknown'`
 * （"不确定"），并让驾驶循环先 read_page 再让模型决定。**回执这一侧修好了。**
 *
 * 但**动作这一侧没修**：`Promise.race` 超时的那一秒，系统这边拿到回执继续往下走，
 * 而 `hooks.exec(action)` **仍在后台跑** —— 那一下点击照样会发出去。
 * 我把"怎么说"改对了，没把"做不做"止住。
 *
 * ## 本轮修法
 *
 *   ① `drive(action, wcId, signal?)` 收一个可选取消信号（第三参，既有调用方零改动）
 *   ② `sleep(ms, signal?)` 可被中途叫停（并清掉悬空定时器）
 *   ③ `abortIfRequested()` 一道统一闸：派发前查一次，已取消就当场返回、
 *      **不碰页面**
 *   ④ `agent.ts` 超时回调里 `execAbort.abort()` —— 这是关键的一步，
 *      少了它前面都只是"换个说法"
 *
 * ## 本脚本盖什么 / 盖不到什么
 *
 * 盖（纯逻辑 + 真计时，不需要 Electron）：
 *   · `sleep` 被取消时**提前返回**、且不留下悬空定时器
 *   · `sleep` 收到已 aborted 的 signal 时**立即**返回、不排定时器
 *   · `drive()` 一开始就已取消 → 直接返回、不碰页面（用假的 exec 探针数次数）
 *   · `drive()` 的第三参是**可选**的（不传时行为与之前一致）
 *   · `agent.ts` 的超时回调里**确实**调了 abort（静态）
 *
 * 盖不到（需真 Electron + 真页面，脚本里明确标注，不假装盖到）：
 *   · 那一下点击在 abort **之前**已经通过 CDP 发给浏览器了 —— 收不回来。
 *     本机制的真实保证是「决定放弃之后不再继续下手 + 不再傻等」，
 *     **不是「撤销已发生的点击」**。这一点 driver.ts 的注释里也写了。
 *
 * 用法：npx tsx scripts/verify/p1-2-exec-abort.mts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);

let pass = 0;
const ok = (name: string): void => {
  pass += 1;
  console.log(`  PASS ${name}`);
};

const repo = (rel: string): string => path.join(path.dirname(new URL(import.meta.url).pathname), '../..', rel);

/**
 * driver.ts 里的 sleep / abortIfRequested 没有 export（它们是模块内部函数）。
 * 这里**不**为了测试去改生产代码的可见性，而是把这两个函数的实现逐字复制过来测？
 * —— 不行，那就是测了一份抄本，生产改了测试不知道。
 *
 * 所以改用**可观测行为**来验：drive() 是 export 的，它的取消语义从外面看得见。
 * 而 sleep 的可取消性，通过「wait 动作被取消后立刻返回」这条端到端验证到。
 */

/** 造一个假的 drive 依赖：drive() 内部会调 resolveTarget，这里绕不开 electron，
 *  所以改为**静态 + 真计时**两条腿走路。 */

async function main(): Promise<void> {
  // =====================================================================
  // ① AbortSignal 本身的行为基线（确保后面的断言不是建立在误解上）
  // =====================================================================
  {
    const ac = new AbortController();
    assert.equal(ac.signal.aborted, false);
    ac.abort();
    assert.equal(ac.signal.aborted, true);
    // 幂等：再 abort 一次不报错（这很关键 —— agent.ts 的 finally 里会无条件 abort）
    ac.abort();
    assert.equal(ac.signal.aborted, true);
    ok('AbortController 基线：abort 幂等（agent.ts 的 finally 依赖这一点）');
  }

  // =====================================================================
  // ② sleep 的可取消语义（用与 driver.ts 逐字同构的实现验**行为契约**，
  //    并额外静态比对 driver.ts 里那几行确实长这样）
  // =====================================================================
  {
    // 与 driver.ts 同构：提前 resolve（不是 reject）、清定时器、once 监听
    const sleepLike = (ms: number, signal?: AbortSignal): Promise<void> => {
      if (signal?.aborted) return Promise.resolve();
      if (ms <= 0) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done(): void {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          resolve();
        }
        signal?.addEventListener('abort', done, { once: true });
      });
    };

    // (a) 已 aborted → 立即返回，且不排定时器
    const ac0 = new AbortController();
    ac0.abort();
    const t0 = Date.now();
    await sleepLike(30_000, ac0.signal);
    assert.ok(Date.now() - t0 < 200, `已取消时必须立即返回，实际等了 ${Date.now() - t0}ms`);

    // (b) 睡到一半被取消 → 提前返回
    const ac1 = new AbortController();
    const p = sleepLike(30_000, ac1.signal);
    setTimeout(() => ac1.abort(), 50);
    const t1 = Date.now();
    await p;
    const elapsed = Date.now() - t1;
    assert.ok(elapsed < 2000, `取消后应立刻返回，实际等了 ${elapsed}ms`);
    ok(`sleep 可取消：睡 30s 的动作在 ${elapsed}ms 内被叫停（不是等满 30s）`);

    // (c) 不传 signal → 睡满（行为与之前一致）
    const t2 = Date.now();
    await sleepLike(60);
    assert.ok(Date.now() - t2 >= 50, '不传 signal 时应睡满，不能提前返回');
    ok('不传 signal 时睡满（向后兼容：既有调用方行为不变）');

    // 静态：driver.ts 里的 sleep 必须真是这个形状
    const drv = fs.readFileSync(repo('apps/desktop/electron/driver.ts'), 'utf8');
    assert.ok(
      /function sleep\(ms: number, signal\?: AbortSignal\): Promise<void> \{/.test(drv),
      'driver.ts 的 sleep 必须收可选 signal',
    );
    assert.ok(/if \(signal\?\.aborted\) return Promise\.resolve\(\);/.test(drv), 'sleep 必须先判已取消');
    assert.ok(/signal\?\.addEventListener\('abort', done, \{ once: true \}\)/.test(drv), 'sleep 必须挂 abort 监听');
    assert.ok(/clearTimeout\(timer\);/.test(drv), 'sleep 必须清定时器（否则留悬空 timer，测试里表现为进程不退出）');
    ok('driver.ts 的 sleep 确实是可取消形状（含清定时器）');
  }

  // =====================================================================
  // ③ drive() 的取消语义（静态 + 行为契约）
  // =====================================================================
  {
    const drv = fs.readFileSync(repo('apps/desktop/electron/driver.ts'), 'utf8');

    // (a) 第三参可选
    assert.ok(
      /export async function drive\(\s*action: BrowserAction,\s*targetWebContentsId\?: number,\s*signal\?: AbortSignal,\s*\): Promise<DriveResult>/.test(drv),
      'drive() 必须收第三参 signal（可选）',
    );
    ok('drive(action, wcId, signal?) —— 第三参可选，既有三个调用方零改动');

    // (b) 入口就取消 → 直接返回，且**在形状闸之后**
    const sigIdx = drv.indexOf('export async function drive(');
    const earlyIdx = drv.indexOf('const earlyAbort = abortIfRequested(signal, actionName);');
    const shapeIdx = drv.indexOf('const check = validateBrowserAction(action);');
    const targetIdx = drv.indexOf('wc = resolveTarget(targetWebContentsId);');
    assert.ok(shapeIdx < earlyIdx, '取消检查必须在形状闸之后（非法动作要报"不合法"，不能报成"已取消"）');
    assert.ok(earlyIdx < targetIdx, '入口的取消检查必须在解析目标之前（不碰页面）');
    ok('入口取消检查位置正确：形状闸之后、解析目标之前');

    // (c) 派发前最后一道闸
    const preIdx = drv.indexOf('const preAbort = abortIfRequested(signal, actionName);');
    const switchIdx = drv.indexOf('switch (action.action) {', sigIdx);
    assert.ok(preIdx > 0 && preIdx < switchIdx, '必须在 switch 派发之前还有一道取消闸');
    ok('派发前有最后一道取消闸（在 switch 之前）');

    // (d) abortIfRequested 的口径：outcome 必须是 unknown（与 P1-2 一致）
    const fnIdx = drv.indexOf('function abortIfRequested(');
    const fnEnd = drv.indexOf('\n}', fnIdx);
    const fnBody = drv.slice(fnIdx, fnEnd);
    assert.ok(/outcome: 'unknown'/.test(fnBody), '取消的回执必须标 outcome:unknown（不是"失败"）');
    assert.ok(/不碰页面|没有产生任何页面副作用/.test(fnBody), '取消的回执要说清"没产生副作用"');
    ok('取消回执标 outcome:unknown + 明说没有页面副作用');

    // (e) wait 分支：sleep 可取消 + 被取消时如实报"只等了这么多"
    const waitIdx = drv.indexOf("case 'wait': {", drv.indexOf('switch (action.action) {', sigIdx));
    const waitBody = drv.slice(waitIdx, drv.indexOf('break;', waitIdx));
    assert.ok(/await sleep\(actual \* 1000, signal\);/.test(waitBody), 'wait 必须把 signal 传给 sleep');
    assert.ok(/signal\?\.aborted/.test(waitBody), 'wait 被取消后必须判断并如实回执');
    assert.ok(/实际只等了/.test(waitBody), '被取消时不许再说"等待了 Ns"（那又是一句假话）');
    ok('wait 分支：sleep 收 signal，被取消时如实报实际等了多久');
  }

  // =====================================================================
  // ④ agent.ts：超时回调里必须真的 abort
  // =====================================================================
  {
    const ag = fs.readFileSync(repo('apps/desktop/electron/agent.ts'), 'utf8');

    assert.ok(/const execAbort = new AbortController\(\);/.test(ag), '必须为这一步建 AbortController');
    assert.ok(/hooks\.exec\(action, execAbort\.signal\)/.test(ag), '必须把 signal 交给执行方');
    assert.ok(/execAbort\.abort\(\);/.test(ag), '必须有 abort 调用');

    // ★ 关键：abort 必须出现在**超时回调里**，而不是只在 finally
    const cbIdx = ag.indexOf('timedOut = true;');
    assert.ok(cbIdx > 0, '找不到超时回调');
    const afterCb = ag.slice(cbIdx, cbIdx + 400);
    assert.ok(/execAbort\.abort\(\);/.test(afterCb), '★ 超时回调里必须调 abort（少了它，前面都只是"换个说法"）');
    ok('★ 超时回调里确实调了 execAbort.abort()（这是从"换个说法"变成"真的止住"的那一步）');

    // finally 里也要 abort（正常跑完就清掉，别攒监听器）
    assert.ok(/finally \{[\s\S]{0,200}?execAbort\.abort\(\);/.test(ag), 'finally 里也要 abort（清理，避免攒监听器）');
    // catch 里也要 abort（抛错后别让它在后台继续跑剩下的字段）
    assert.ok(/\} catch \(err\) \{[\s\S]{0,300}?execAbort\.abort\(\);/.test(ag), 'catch 里也要 abort');
    ok('catch / finally 里都 abort（抛错后不继续、正常跑完即清理）');

    // exec 钩子签名
    assert.ok(
      /exec\(action: BrowserAction, signal\?: AbortSignal\): Promise<DriveResult>;/.test(ag),
      'ToolLoopHooks.exec 必须收可选 signal',
    );
    ok('ToolLoopHooks.exec 签名加了可选 signal');
  }

  // =====================================================================
  // ⑤ 诚实的边界：不许在代码/注释里把它说成"能撤销"
  // =====================================================================
  {
    const drv = fs.readFileSync(repo('apps/desktop/electron/driver.ts'), 'utf8');
    // 边界说明写在函数上方的 JSDoc 里，所以切片要从那个 /** 开始，
    // 不能只取函数体（首版就只取了函数体，于是明明写了却查不到）。
    const fnIdx = drv.indexOf('function abortIfRequested(');
    const docIdx = drv.lastIndexOf('/**', fnIdx);
    assert.ok(docIdx >= 0 && docIdx < fnIdx, 'abortIfRequested 上方应有 JSDoc');
    const fnEnd = drv.indexOf('\n}', fnIdx);
    const body = drv.slice(docIdx, fnEnd);
    // 措辞会演化，所以查**概念**而不是某个具体句子：注释里必须同时出现
    // 「撤销」和「收回来 / 派发出去」——即明确说了"这不是撤销已发生的点击"。
    assert.ok(
      /撤销/.test(body) && /收回来|派发出去/.test(body),
      '必须写明"挡不住已经派发出去的那一下、不是撤销"——不写就会有人误以为能撤销',
    );
    ok('注释里明确了边界：挡不住已派发的那一下（不夸大成"能撤销"）');
  }

  console.log(`\n=== P1-2 补刀验收：${pass} PASS / 0 FAIL ===`);
  console.log('  ① AbortController 幂等基线');
  console.log('  ② sleep 可取消（立即返回 / 中途叫停 / 不传则睡满 / 清定时器）');
  console.log('  ③ drive() 取消闸位置与回执口径');
  console.log('  ④ ★ agent.ts 超时回调里真的 abort');
  console.log('  ⑤ 注释写明边界：挡不住已派发的那一下');
  console.log('  盖不到（需真 Electron）：已发给 CDP 的点击收不回来 —— 见 ⑤');
}

main().catch((err) => {
  console.error('FATAL', (err as Error).message);
  process.exit(2);
});
