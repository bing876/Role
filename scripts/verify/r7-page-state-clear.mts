/**
 * R7 修复验收（2026-09-29）· **关页即清该页的分片状态**。
 *
 * ## 修的什么（接手报告 §10.2 的 R7，此前一直未修）
 *
 * `pageState.ts` 的 `clearPageState(wcId)` 从落地起**没有任何调用点**。
 * 后果不是内存泄漏（那个文件本就有 TTL 扫描 + 64 条上限兜底），而是**显示错**：
 *
 *   用户关掉一张浏览器页 → 服务端不知道 → `latestPageStateOfAgent()` 继续把那张
 *   **已关闭**页的状态当"最新"返回 → `chat.ts` 的 `mergeLatestPageState` 把它并进
 *   显示态 → `login_required` / `current_task` 最多滞留 **10 分钟**
 *   （PAGE_STATE_TTL_MS）。用户看到的是"页面都关了，界面还说需要登录/还在忙"。
 *
 * ## 修法（两处，缺一不可）
 *
 *   ① `toolLoop.ts` 的 `stopLoopsOfPage()`：停掉该页全部循环后，`clearPageState(wcId)`。
 *      ★ 清在这里而不是 `stopLoop(loopId)` 里：分片状态的键是 **wcId（页）**，
 *        不是 loopId（循环）。一张页可能同时有多路循环，在单路 stopLoop 里清
 *        会把同页其他路的状态一起抹掉。
 *   ② `electron/main.ts` 的 `workbench:browser:view-close`：关页时
 *      `agentPost('/agent/loop/stop', { wcId, reason: 'page_closed' })`。
 *      否则服务端根本收不到"页关了"这件事，① 永远不会被触发。
 *
 * ## 本脚本盖什么 / 盖不到什么
 *
 * 盖：① 的**服务端行为**（模块层 + HTTP 路由层都真打）。
 * 盖不到：② 的 Electron 侧 —— 那需要真起 Electron + 真 webview，沙箱里没有
 *         （`verify:electron` 头注释明写"不拉 electron 二进制"）。② 只有
 *         **静态接线核对**（见最后一节），不构成"真关过一次页"的证据。
 *
 * 用法：npx tsx scripts/verify/r7-page-state-clear.mts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const { buildApp } = req('../../apps/server/src/index') as typeof import('../../apps/server/src/index');
const { loadEnv } = req('../../apps/server/src/env') as typeof import('../../apps/server/src/env');
const { makeCipher } = req('../../apps/server/src/crypto') as typeof import('../../apps/server/src/crypto');
const { makePool, migrate } = req('../../apps/server/src/db') as typeof import('../../apps/server/src/db');
const { signToken } = req('../../apps/server/src/crypto') as typeof import('../../apps/server/src/crypto');
const {
  startLoop,
  stopLoopsOfPage,
  getLoop,
} = req('../../apps/server/src/toolLoop') as typeof import('../../apps/server/src/toolLoop');
const {
  pageStateOf,
  loadPageState,
  patchPageState,
} = req('../../apps/server/src/pageState') as typeof import('../../apps/server/src/pageState');
const { registerLoopRoutes } = req('../../apps/server/src/routes/loop') as typeof import('../../apps/server/src/routes/loop');

let pass = 0;
const ok = (name: string): void => {
  pass += 1;
  console.log(`  PASS ${name}`);
};

const WC = 424242; // 一个不可能被真 webContents 用到的 wcId，避免撞上真实页

async function main(): Promise<void> {
  process.env.DATABASE_URL ??= 'pglite://memory';
  process.env.JWT_SECRET ??= 'verify-r7-jwt-secret';
  process.env.DATA_KEY ??= 'verify-r7-data-key-64-chars';
  process.env.PHONE_PEPPER ??= 'verify-r7-pepper-64-chars';
  process.env.SMS_MOCK = '1';
  // 建循环要过「模型已配置」闸；这里只起停、不推进，所以给个假 key 就够，
  // 不会真去打网络（没有任何一步会 advance）。
  process.env.DEEPSEEK_API_KEY ??= 'verify-r7-fake-key';
  const env = loadEnv();

  // =====================================================================
  // ① 模块层：stopLoopsOfPage 必须把该页的分片状态一起清掉
  // =====================================================================
  {
    // 先造一张页的分片状态（seed 带 login_required，模拟"需要登录"那一态）
    pageStateOf(WC, { userId: 1, agentId: 7, seed: { login_required: true, current_task: '在查订单' } });
    patchPageState(WC, { login_required: true, current_task: '在查订单' }, { userId: 1 });
    assert.ok(loadPageState(WC), '前置条件：该页状态必须在册');
    assert.equal(loadPageState(WC)!.login_required, true, '前置条件：login_required 应为 true');

    // 再造一路挂在这张页上的循环
    const loop = startLoop(env, {
      userId: 1,
      agentId: 7,
      conversationId: null,
      wcId: WC,
      goal: 'R7 验收用的循环',
    });
    assert.equal(getLoop(loop.id)?.wcId, WC, '前置条件：循环应挂在这张页上');

    const stopped = stopLoopsOfPage(1, WC);
    assert.equal(stopped, 1, `应停掉 1 路循环，实际 ${stopped}`);
    ok('stopLoopsOfPage 停掉了挂在该页上的循环');

    // ★ 核心断言：页状态必须被清掉（旧代码这里是"还在册"）
    assert.equal(loadPageState(WC), null, '★ 放下这一路后，该页的分片状态必须被清掉');
    ok('★ stopLoopsOfPage 清掉了该页的分片状态（R7 核心）');

    // 循环本身也应进终态
    assert.equal(getLoop(loop.id)?.status, 'stopped', '循环应进入 stopped 终态');
    ok('循环进入 stopped 终态');

    // 反面：换一张页的循环不能被这次清理带走
    const other = startLoop(env, {
      userId: 1,
      agentId: 7,
      conversationId: null,
      wcId: 424243,
      goal: '另一张页的循环',
    });
    stopLoopsOfPage(1, WC); // 再调一次（幂等性也要成立）
    assert.ok(getLoop(other.id), '另一张页的循环不能被带走');
    ok('stopLoopsOfPage 不影响其他页的循环（且可重复调）');
  }

  // =====================================================================
  // ② HTTP 路由层：POST /agent/loop/stop {wcId} 也要走到同一条清理
  // =====================================================================
  {
    const pool = makePool('pglite://memory');
    await migrate(pool);
    const cipher = makeCipher(env.dataKey);
    const app = await buildApp(env, pool, cipher);
    await app.ready();

    const token = signToken({ sub: 1, xyz: 'XYZ70001' } as never, env.jwtSecret);
    const auth = { authorization: `Bearer ${token}`, host: '127.0.0.1:8787' };

    // 起一路挂在 WC2 上的循环（走路由，走真注册表）
    const WC2 = 424244;
    const started = await app.inject({
      method: 'POST',
      url: '/agent/loop/start',
      headers: auth,
      payload: { goal: 'R7 路由层验收', wcId: WC2 },
    });
    assert.equal(started.statusCode, 200, `建循环应 200，实际 ${started.statusCode} ${started.body}`);
    const loopId = (JSON.parse(started.body) as { loopId: string }).loopId;

    // 给它造页状态
    pageStateOf(WC2, { userId: 1, agentId: null, seed: { login_required: true } });
    patchPageState(WC2, { login_required: true }, { userId: 1 });
    assert.ok(loadPageState(WC2), '前置条件：路由层该页状态应在册');

    // 用 wcId 停（不带 loopId）—— 这正是 electron view-close 会打的那个形状
    const stopped = await app.inject({
      method: 'POST',
      url: '/agent/loop/stop',
      headers: auth,
      payload: { wcId: WC2, reason: 'page_closed' },
    });
    assert.equal(stopped.statusCode, 200, `停循环应 200，实际 ${stopped.statusCode} ${stopped.body}`);
    const body = JSON.parse(stopped.body) as { stopped: number };
    assert.equal(body.stopped, 1, `应停掉 1 路，实际 ${body.stopped}`);
    assert.equal(loadPageState(WC2), null, '★ 带 wcId 停循环后，该页分片状态必须被清掉');
    ok('★ HTTP POST /agent/loop/stop {wcId} 也清掉了该页分片状态（electron 走的就是这条）');

    // 反面：带 loopId 停**不该**清页状态（那张页可能还有别的路在跑）
    const WC3 = 424245;
    const s3 = await app.inject({
      method: 'POST',
      url: '/agent/loop/start',
      headers: auth,
      payload: { goal: 'R7 反面验收', wcId: WC3 },
    });
    const loop3 = (JSON.parse(s3.body) as { loopId: string }).loopId;
    pageStateOf(WC3, { userId: 1, agentId: null, seed: { current_task: '另一路还在跑' } });
    patchPageState(WC3, { current_task: '另一路还在跑' }, { userId: 1 });
    const byLoop = await app.inject({
      method: 'POST',
      url: '/agent/loop/stop',
      headers: auth,
      payload: { loopId: loop3, reason: 'user_stop' },
    });
    assert.equal(byLoop.statusCode, 200, `按 loopId 停应 200，实际 ${byLoop.statusCode}`);
    assert.ok(loadPageState(WC3), '★ 按 loopId 停**不能**清页状态（同页可能还有别的路）');
    ok('★ 按 loopId 停不清页状态（守住"一张页多路循环"这个前提）');

    await app.close();
    await pool.end();
  }

  // =====================================================================
  // ③ 静态接线核对（electron 侧，沙箱里跑不了真 webview）
  // =====================================================================
  {
    const mainTs = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '../../apps/desktop/electron/main.ts',
    );
    const src = fs.readFileSync(mainTs, 'utf8');
    // 关页处理器里必须带着 wcId 去通知服务端
    const handler = /ipcMain\.handle\('workbench:browser:view-close'[\s\S]{0,1200}?\n\}\);/.exec(src);
    assert.ok(handler, '找不到 workbench:browser:view-close 处理器');
    assert.ok(
      /agentPost\('\/agent\/loop\/stop'[\s\S]{0,200}wcId/.test(handler[0]),
      'view-close 处理器必须用 wcId 通知服务端停这一路',
    );
    ok('view-close 处理器带 wcId 通知了服务端（静态核对，非真机证据）');
    assert.ok(
      /viewHostWcIdOf\(tabKey\)/.test(handler[0]) && /viewHostClose\(tabKey\)/.test(handler[0]),
      '必须仍在 close 之前取 wcId（close 后宿主登记已清）',
    );
    ok('仍在 close 之前取 wcId（ADR-0003 的既有约束没被破坏）');
  }

  console.log(`\n=== R7 修复验收：${pass} PASS / 0 FAIL ===`);
  console.log('  ① 模块层：stopLoopsOfPage 清该页分片状态');
  console.log('  ② 路由层：POST /agent/loop/stop {wcId} 走同一条清理；按 loopId 停不清');
  console.log('  ③ 静态接线：electron view-close 带 wcId 通知服务端');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
