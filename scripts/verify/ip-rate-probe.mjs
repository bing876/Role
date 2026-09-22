/**
 * #4 验证：IP 限流器（`makeIpRateLimiter`）。
 *
 * ## 为什么这么测
 * 这个限流器**不依赖数据库也不依赖 HTTP** —— 它是纯内存逻辑，
 * 所以直接 `require` **编译产物** `apps/server/dist/routes/auth.js` 里的工厂函数，
 * 注入假时钟和很小的阈值来跑。测的是线上那份代码本身。
 *
 * 注入时钟/阈值不是为了"方便"，而是**必须**：
 *   - 真等一分钟才能验"窗口翻篇"，太慢且不可靠；
 *   - 真造 5 万个 IP 才能验"表满时的淘汰"，更不现实。
 *   （这正是本机记忆里那条：环境依赖要参数化，且参数值每次调用重读。）
 *
 * ## 两个真实缺陷，各自对应一组断言
 *   缺陷①：容量检查写在"同 IP 第 2 次以后"的分支里 → **每个 IP 只来一次**时永不触发。
 *   缺陷②：`clear()` 整表清空 → **正在生效的限流被自己人放掉**（这是绕过，不只是内存问题）。
 *
 * 用法： node scripts/verify/ip-rate-probe.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import url from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const AUTH_JS = path.join(REPO, 'apps', 'server', 'dist', 'routes', 'auth.js');

let fails = [];
let total = 0;
function chk(cond, label, detail) {
  total++;
  if (cond) console.log('  PASS  ' + label);
  else {
    console.log('  FAIL  ' + label + (detail ? '   ' + detail : ''));
    fails.push(label);
  }
  return cond;
}

console.log('='.repeat(70));
console.log('#4 验证：IP 限流器');
console.log('='.repeat(70));

const mod = require(AUTH_JS);
const { makeIpRateLimiter } = mod;
if (!chk(typeof makeIpRateLimiter === 'function', '产物里有 makeIpRateLimiter')) {
  console.log('结果：' + total + ' 条断言，' + fails.length + ' 条失败');
  process.exitCode = 1;
  process.exit();
}

/** 可推进的假时钟 */
function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

// ---------------------------------------------------------------------------
console.log('\n[1] 基本口径：每 IP 每分钟 20 次');
{
  const c = clock();
  const rl = makeIpRateLimiter({ maxPerMinute: 3, softCap: 100, now: c.now });
  const results = [];
  for (let i = 0; i < 5; i++) results.push(rl.limited('1.1.1.1'));
  chk(results[0] === false && results[1] === false && results[2] === false,
      '前 3 次放行', JSON.stringify(results));
  chk(results[3] === true && results[4] === true, '第 4、5 次开始拦', JSON.stringify(results));
  chk(rl.limited('2.2.2.2') === false, '另一个 IP 不受影响（是按 IP 分的）');
}

console.log('\n[2] 窗口翻篇 → 计数重置');
{
  const c = clock();
  const rl = makeIpRateLimiter({ maxPerMinute: 2, softCap: 100, windowMs: 60_000, now: c.now });
  rl.limited('a');
  rl.limited('a');
  chk(rl.limited('a') === true, '本窗口内第 3 次被拦');
  c.advance(60_000);
  chk(rl.limited('a') === false, '★ 下一分钟重新放行（窗口确实翻篇了）');
}

console.log('\n[3] ★ 缺陷①：每个 IP 只来一次（扫描）也必须触发容量维护');
{
  const c = clock();
  const rl = makeIpRateLimiter({ maxPerMinute: 5, softCap: 10, now: c.now });
  // 每个 IP 都只来一次 —— 旧实现里这种流量**永远不会**走到容量检查那一行
  for (let i = 0; i < 50; i++) rl.limited(`scan-${i}`);
  chk(rl.size() <= 11, '★ 只来一次的扫描不会让表无限涨', `size=${rl.size()}`);
}

console.log('\n[4] ★★ 缺陷②：表被撑满时，正在生效的限流**不能被清掉**');
{
  const c = clock();
  const rl = makeIpRateLimiter({ maxPerMinute: 3, softCap: 5, now: c.now });
  // 攻击者先来，打到被限流（它是表里"最旧"的那条 —— 无差别淘汰会优先踢掉它）
  const attacker = '10.0.0.9';
  for (let i = 0; i < 8; i++) rl.limited(attacker);
  chk(rl.limited(attacker) === true, '攻击者已被限流（前提成立）');
  const before = rl.countOf(attacker);
  chk(before !== null && before > 3, `攻击者的计数已超限（${before}）`);

  // 再来一堆不同的 IP 把表撑爆（每个都只来一次 = 没超限的"无辜"条目）
  for (let i = 0; i < 30; i++) rl.limited(`noise-${i}`);

  const after = rl.countOf(attacker);
  chk(after !== null, '★ 表被撑满后，攻击者的记录**还在**（没被当成最旧的踢掉）',
      `countOf=${after}`);
  chk(rl.limited(attacker) === true,
      '★★ 关键：撑满表**不能**让攻击者重新拿到额度（旧实现 clear() 后会变 false）',
      `limited=${rl.limited(attacker)}`);
  chk(rl.size() <= 6, '表大小仍被兜住（没无限涨）', `size=${rl.size()}`);

  /**
   * ★★ 真正触发旧实现那个 `clear()` 的一步。
   *
   * 旧代码把 `if (size > 5000) clear()` 写在**"同 IP 同窗口第 2 次及以后"**的分支里，
   * 所以"每个 IP 只来一次"的噪声流量**根本走不到那一行** ——
   * 必须让某个 IP **再来一次**，clear() 才会真的被执行。
   * （第一版测试漏了这一步，反证时才发现它区分不出新旧代码 —— 见交付报告。）
   */
  rl.limited('noise-0');
  chk(rl.countOf(attacker) !== null,
      '★ 有人重复请求（触发旧代码的 clear 那一步）后，攻击者的记录仍在',
      `countOf=${rl.countOf(attacker)}`);
  chk(rl.limited(attacker) === true,
      '★★ 攻击者**仍然**被限流（旧实现会在这里被 clear 放掉，重新拿到 20 次额度）',
      `limited=${rl.limited(attacker)}`);
}

console.log('\n[5] 过期条目会被优先淘汰（而不是去动有用的那些）');
{
  const c = clock();
  const rl = makeIpRateLimiter({ maxPerMinute: 2, softCap: 5, now: c.now });
  for (let i = 0; i < 5; i++) rl.limited(`old-${i}`);
  chk(rl.size() === 5, '先填到软上限（前提成立）', `size=${rl.size()}`);

  c.advance(60_000); // 这 5 条全部过期
  rl.limited('fresh'); // size 变成 6 > 5 → 下一次调用才会触发维护
  chk(rl.size() === 6, '刚超上限那一下还没维护（维护发生在下一次调用）', `size=${rl.size()}`);

  rl.limited('fresh2'); // 这一次触发维护：过期的 5 条被清掉
  chk(rl.size() <= 3, '★ 维护时优先清掉**过期的**（而不是去动有用的）', `size=${rl.size()}`);
  chk(rl.countOf('fresh') === 1 && rl.countOf('fresh2') === 1, '新来的两个 IP 记录都在');

  // 正确性：过期 IP 在新窗口里应当从 1 开始（旧计数不能残留）
  const c2 = clock();
  const rl2 = makeIpRateLimiter({ maxPerMinute: 2, softCap: 100, now: c2.now });
  rl2.limited('z');
  rl2.limited('z');
  chk(rl2.limited('z') === true, '本窗口内已超限（前提成立）');
  c2.advance(60_000);
  rl2.limited('z');
  chk(rl2.countOf('z') === 1, '★ 翻窗口后旧计数被丢弃（从 1 重新开始）', `count=${rl2.countOf('z')}`);
}

console.log('\n[6] 默认实例与阈值（防"顺手把默认值改小"）');
{
  const rl = makeIpRateLimiter();
  const c = clock();
  const rl2 = makeIpRateLimiter({ now: c.now });
  let firstLimited = -1;
  for (let i = 1; i <= 30; i++) {
    if (rl2.limited('x')) {
      firstLimited = i;
      break;
    }
  }
  chk(firstLimited === 21, '默认是每 IP 每分钟 20 次（第 21 次才拦）', `实际第 ${firstLimited} 次`);
  chk(rl.size() === 0, '新实例是干净的（没有共享模块级状态）');
}

console.log('\n' + '='.repeat(70));
console.log('结果：' + total + ' 条断言，' + fails.length + ' 条失败');
for (const f of fails) console.log('   ✗ ' + f);
console.log('='.repeat(70));
process.exitCode = fails.length ? 1 : 0;
