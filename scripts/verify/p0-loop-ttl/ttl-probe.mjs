/**
 * P0 止血 —— 改动点 1（循环 TTL 分档）的确定性探针
 *
 * ## 为什么要有这个脚本
 * 阶段 1 的核心修复是：`paused` / `waiting`（**在等用户**）的循环不该被 10 分钟
 * 闲置超时悄悄回收 —— 一被回收，`/agent/loop/resume` 就 404，桌面端兜底**静默新开一轮**，
 * 消息历史归零，前面做过的动作可能再做一遍。
 *
 * 真机上等 10 分钟再点一次「继续」当然能验，但那要拉起 PostgreSQL + 服务端 + Electron
 * 三件套，一次十几分钟，而且**结果受模型非确定性干扰**。这里先把**纯内存的那段逻辑**
 * 单独拎出来做确定性验证：`toolLoop.ts` 的 `startLoop / pauseLoop / resumeLoop / getLoop`
 * 都不发真实请求（循环只在 `advance()` 被调用时才走模型），所以可以用**假时钟**把
 * 「过了多久」直接造出来，不用真的等。
 *
 * ## 为什么用假时钟而不是 sleep
 * 真等 11 分钟 = 一次验收十分钟起步，且不可重复。假时钟把时间当成可注入的条件，
 * 于是「挂起 11 分钟」「挂起 7 小时」都能在同一进程里精确构造 —— 这也正是后面
 * `ttl-revert-proof.py` 能稳定复现反证的前提。
 *
 * ## 六条断言（每条都点名它守的是哪件事）
 *   ① 挂起后 11 分钟，循环**还在**            —— 核心 P0（旧代码：已被回收）
 *   ② 挂起后 7 小时，循环**被回收**            —— 不是"永久保留"，隔夜一定清掉
 *   ③ running 的循环 11 分钟后**照样被回收**   —— 10 分钟空转闸没被顺手改掉
 *   ④ waiting 的循环 11 分钟后**还在**         —— AI 把球踢回给用户，同样是在等人
 *   ⑤ 挂起 11 分钟后 resume，**历史还在**      —— 恢复不等于重开
 *   ⑥ 等待态**照旧参与** MAX_LIVE_LOOPS 淘汰   —— 内存上界仍然成立
 *
 * 用法（cwd 必须是 apps/server，`.env` 由 dotenv 从 cwd 读）：
 *     cd apps/server && ../../node_modules/.bin/tsx ../../scripts/verify/p0-loop-ttl/ttl-probe.mjs
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN = 60_000;
const HOUR = 60 * MIN;

// 从脚本自身位置反推仓库根（不依赖 cwd —— cwd 必须是 apps/server 才能读到 .env）
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');

// ── 假时钟：必须在 import 被测模块之前装好（模块内所有 Date.now() 都走这里） ──
let NOW = 1_760_000_000_000;
Date.now = () => NOW;

const mod = await import(pathToFileURL(path.join(REPO, 'apps', 'server', 'src', 'toolLoop.ts')).href);
const { startLoop, pauseLoop, resumeLoop, getLoop, hasLoop, runningLoopCount } = mod;

const FAKE_ENV = { agentLoopMaxSteps: 0 };

let n = 0;
const results = [];
function check(title, ok, detail) {
  n += 1;
  results.push({ n, title, ok: !!ok, detail: detail ?? '' });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${n}. ${title}${detail ? ` —— ${detail}` : ''}`);
}

function newLoop(wcId) {
  n += 0;
  return startLoop(FAKE_ENV, {
    userId: 1,
    agentId: 1,
    conversationId: null,
    wcId,
    goal: '把这张表单填完并提交',
  });
}

// ── ① 挂起后 11 分钟，循环还在 ────────────────────────────────────────────
const s1 = newLoop(101);
pauseLoop(s1.id, { by: 'user' });
NOW += 11 * MIN;
const a1 = getLoop(s1.id);
check(
  '① 挂起 11 分钟后循环还在（核心 P0：不该被闲置超时悄悄回收）',
  a1 !== null && a1.status === 'paused',
  a1 ? `status=${a1.status}，历史 ${a1.messages.length} 条` : 'getLoop 返回 null（循环已被回收）',
);

// ── ② 挂起后 7 小时，循环被回收（不是永久保留） ────────────────────────────
const s2 = newLoop(102);
pauseLoop(s2.id, { by: 'user' });
NOW += 7 * HOUR;
check(
  '② 挂起 7 小时后循环被回收（6 小时窗口，不是永久保留）',
  getLoop(s2.id) === null,
  getLoop(s2.id) === null ? '已回收' : '还在（说明窗口过长或没生效）',
);

// ── ③ running 的循环 11 分钟后照样被回收（10 分钟空转闸没被动） ──────────────
const s3 = newLoop(103);
NOW += 11 * MIN;
check(
  '③ 正在跑的循环 11 分钟后照样被回收（10 分钟空转闸没被顺手改掉）',
  getLoop(s3.id) === null && s3.status === 'running',
  getLoop(s3.id) === null ? '已回收（活跃态仍走 10 分钟）' : '还在（10 分钟闸被改坏了）',
);

// ── ④ waiting 的循环 11 分钟后还在 ────────────────────────────────────────
const s4 = newLoop(104);
getLoop(s4.id).status = 'waiting'; // AI 把球踢回给用户（停下来问 / 只是说话 / 动作被拒）
NOW += 11 * MIN;
const a4 = getLoop(s4.id);
check(
  '④ waiting（AI 在等用户回答）11 分钟后还在',
  a4 !== null && a4.status === 'waiting',
  a4 ? `status=${a4.status}` : 'getLoop 返回 null（已被回收）',
);

// ── ⑤ 挂起 11 分钟后 resume，历史还在（恢复 ≠ 重开） ───────────────────────
const s5 = newLoop(105);
const before5 = s5.messages.length;
pauseLoop(s5.id, { by: 'user' });
NOW += 11 * MIN;
const r5 = resumeLoop(s5.id, null);
const a5 = getLoop(s5.id);
check(
  '⑤ 挂起 11 分钟后 resume 成功，且消息历史保留（恢复 ≠ 新开一轮）',
  !!r5 && r5.resumed === true && !!a5 && a5.messages.length > before5 && a5.status === 'running',
  r5
    ? `resumed=${r5.resumed} delta=${r5.delta?.kind} 消息 ${before5} → ${a5?.messages.length} 条`
    : 'resumeLoop 返回 null（循环已被回收，桌面端就会静默重开）',
);

// ── ⑥ 等待态照旧参与 MAX_LIVE_LOOPS 淘汰 ──────────────────────────────────
// 造 40 条**全部处于挂起态**的循环（touchedAt 递增），触发 sweep，
// 验证「等待态用长 TTL」没有把内存上界一起放开。
const many = [];
for (let i = 0; i < 40; i += 1) {
  NOW += 1;
  const s = newLoop(200 + i);
  pauseLoop(s.id, { by: 'user' });
  many.push(s.id);
}
runningLoopCount(); // 内部会 sweep()
const alive = many.filter((id) => hasLoop(id)).length;
const oldestGone = !hasLoop(many[0]) && !hasLoop(many[1]);
check(
  '⑥ 挂起态照旧参与 MAX_LIVE_LOOPS 淘汰（40 条 → 只剩 32 条，最旧的先没）',
  alive === 32 && oldestGone,
  `存活 ${alive} 条${oldestGone ? '，最旧的已被淘汰' : '，但最旧的没被淘汰'}`,
);

const failed = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 条，通过 ${results.length - failed.length} 条，失败 ${failed.length} 条`);
if (failed.length) {
  console.log('失败：' + failed.map((r) => `${r.n}`).join(', '));
  process.exit(1);
}
