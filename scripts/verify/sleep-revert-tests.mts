/**
 * 「空闲休眠」反证脚本（第 25 步）。
 *
 * 为什么必须做这一步：
 *   一条**永远绿**的测试等于没有测试。上一轮我就吃过这个亏 ——
 *   断言只查"选择器存不存在"，结果把深浅休眠的 opacity 都改成 0.55 照样 PASS。
 *   所以这里反过来做：**故意把代码改坏**，看测试**是不是真的会红**。
 *   每一条缺陷都要让至少一条断言变红；有缺陷却不红 = 那条断言是摆设。
 *
 * 做法：
 *   1. 读原文件 → 备份到内存；
 *   2. 逐个注入缺陷（字符串替换，替换失败即报错，避免"没改到还自欺"）；
 *   3. 每注入一个就跑一遍 `sleep-wiring-tests.mts` + `sleep-policy-tests.mts`；
 *   4. 断言「至少有一条红」，并记下红了几条；
 *   5. 无论如何最后还原文件，并复查还原后的 sha256 与原始一致。
 *
 * 跑法：`npx tsx scripts/verify/sleep-revert-tests.mts`
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const abs = (p: string): string => path.join(ROOT, p);
const sha = (p: string): string => createHash('sha256').update(readFileSync(abs(p))).digest('hex').slice(0, 12);

let bad = 0;
const log = (...a: unknown[]): void => console.log(a.map(String).join(' '));

interface Defect {
  /** 人类可读：这块坏掉之后，用户会看到什么 */
  desc: string;
  /** 改哪个文件 */
  file: string;
  /** 精确替换（找不到会直接报错，防止"其实没改到"） */
  from: string;
  to: string;
  /** 期望替换几处（默认 1）。多于 1 处时用 replaceAll，确保**每一条路径**都被破坏 */
  count?: number;
  /** 期望哪个测试脚本变红 */
  suite: 'wiring' | 'policy';
}

const DEFECTS: Defect[] = [
  {
    desc: '定时器没起：判定写了但没人调用 → 页永远不睡，功能等于没做',
    file: 'apps/desktop/src/browser/useBrowserWorkspace.ts',
    from: 'window.setInterval(sweepSleep, 30_000)',
    to: 'window.setInterval(() => {}, 30_000)',
    suite: 'wiring',
  },
  {
    desc: '深休眠不卸载页宿主：图标变了但内存一点没省（最容易骗过肉眼）',
    file: 'apps/desktop/src/browser/BrowserPanel.tsx',
    from: "const deepSleeping = t.sleep === 'deep' && !ws.drivingIds.includes(t.id);",
    to: 'const deepSleeping = false;',
    // ADR-0002：这个判定有三处**必须一致**的落点 —— 宿主生命周期 effect（决定建/销毁）、
    // rect effect（决定发不发视图状态）、JSX 分支（决定渲染占位卡还是宿主 div）。
    // 一起改成 false 才是「深休眠整体失效」那条死法。
    count: 3,
    suite: 'wiring',
  },
  {
    desc: '红线失守：被驾驶的页也会被节流 → CDP 点击失灵，前几轮的 bug 原样复发',
    file: 'apps/desktop/electron/main.ts',
    from: 'if (throttle && isDriving) return { ok: false, error: \'driving\' };',
    to: '',
    suite: 'wiring',
  },
  {
    desc: '浅休眠不去节流：CPU 没省，纯白做',
    file: 'apps/desktop/src/browser/useBrowserWorkspace.ts',
    from: 'void window.workbench?.browserThrottle?.(wcId, want);',
    to: 'void wcId; void want;',
    suite: 'wiring',
  },
  {
    desc: '派任务前不唤醒：AI 面对一张空页，用户以为"AI 不动了"（两条路径一起破坏）',
    // ★ 片 7b：这两条路径搬进了 features/chat（`count: 2` 仍然是两条）
    file: 'apps/desktop/src/features/chat/useChat.ts',
    from: 'const slept = browser.sleepOf(tabId);',
    to: 'const slept: undefined = undefined;',
    count: 2,
    suite: 'wiring',
  },
  {
    desc: '判定门槛当摆设：闲置 1 秒就睡 → 用户刚切走就被冻结',
    file: 'apps/desktop/src/browser/sleepPolicy.ts',
    from: 'shallowAfterMs: 5 * 60 * 1000',
    to: 'shallowAfterMs: 1000',
    suite: 'policy',
  },
  {
    desc: '红线失守（判定层）：drivingIds 的页不再被跳过',
    file: 'apps/desktop/src/browser/sleepPolicy.ts',
    from: 'if (driving.has(t.id)) continue;',
    to: '',
    suite: 'policy',
  },
  {
    desc: '前台页也会被睡：当前正在看的那张直接黑掉',
    file: 'apps/desktop/src/browser/sleepPolicy.ts',
    from: 'if (input.activeTabId !== null && t.id === input.activeTabId) continue;',
    to: '',
    suite: 'policy',
  },
  {
    desc: '深浅不分：所有该睡的都判成浅休眠 → 内存永远不会释放',
    file: 'apps/desktop/src/browser/sleepPolicy.ts',
    from: "plan[t.id] = idleMs >= opts.deepAfterMs && canDeep ? 'deep' : 'shallow';",
    to: "plan[t.id] = 'shallow';",
    suite: 'policy',
  },
];

/** 跑一个套件，返回失败条数（从 "失败项：N" 里解析） */
function runSuite(suite: 'wiring' | 'policy'): { fails: number; raw: string } {
  const script =
    suite === 'wiring' ? 'scripts/verify/sleep-wiring-tests.mts' : 'scripts/verify/sleep-policy-tests.mts';
  /*
   * 这里**不能**写 `execFileSync('npx', ...)`：
   *   Windows 上 npx 是 `npx.cmd`，execFileSync 不带 shell 时根本找不到（ENOENT），
   *   于是每次都被 catch 吞成空输出 → 解析出 fails = -1 →
   *   反证脚本会误报"基线不是绿的"，把人引到错误方向。
   * 改成直接用**当前 node** 跑 `node_modules/tsx/dist/cli.mjs`：
   *   不依赖 PATH、不依赖 shell、不受 .cmd 后缀影响。
   */
  const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  let out = '';
  try {
    out = execFileSync(process.execPath, [tsxCli, script], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    out = (e.stdout ?? '') + (e.stderr ?? '');
  }
  const m = /失败项[：:]\s*(\d+)/.exec(out);
  return { fails: m ? Number(m[1]) : -1, raw: out };
}

log('');
log('=== 反证：把代码改坏，看测试红不红 ===');
log('  （每条缺陷都必须让至少一条断言变红；不红说明那条断言是摆设）');
log('');

// 先跑一遍"健康态"作为基线：必须是 0
const baseWiring = runSuite('wiring');
const basePolicy = runSuite('policy');
log(`  基线：wiring 失败 ${baseWiring.fails} 条 / policy 失败 ${basePolicy.fails} 条`);
if (baseWiring.fails !== 0 || basePolicy.fails !== 0) {
  log('  ★★ 基线就不是绿的 —— 别往下做反证了，先把代码修绿。');
  process.exit(2);
}
log('');

const backups = new Map<string, string>();
for (const d of DEFECTS) {
  if (!backups.has(d.file)) backups.set(d.file, readFileSync(abs(d.file), 'utf8'));
}

interface Row {
  desc: string;
  red: number;
  ok: boolean;
}
const rows: Row[] = [];

try {
  for (let i = 0; i < DEFECTS.length; i += 1) {
    const d = DEFECTS[i]!;
    const src = readFileSync(abs(d.file), 'utf8');
    const hits = src.split(d.from).length - 1;
    const want = d.count ?? 1;
    if (hits !== want) {
      log(`  ★ 第 ${i + 1} 条注入失败：在 ${d.file} 里期望 ${want} 处，实际 ${hits} 处`);
      log(`     片段：${JSON.stringify(d.from.slice(0, 90))}`);
      bad += 1;
      rows.push({ desc: d.desc, red: -2, ok: false });
      continue;
    }
    writeFileSync(abs(d.file), src.split(d.from).join(d.to), 'utf8');
    const r = runSuite(d.suite);
    // 立刻还原，别让缺陷污染下一条
    writeFileSync(abs(d.file), src, 'utf8');

    const ok = r.fails > 0;
    if (!ok) bad += 1;
    rows.push({ desc: d.desc, red: r.fails, ok });
    log(`  ${ok ? 'PASS' : '★FAIL'} [${d.suite}] 红 ${r.fails} 条  ${d.desc}`);
  }
} finally {
  // 无条件还原（哪怕上面抛异常）
  for (const [file, content] of backups) {
    writeFileSync(abs(file), content, 'utf8');
  }
}

log('');
log('=== 还原复查 ===');
let restoreBad = 0;
for (const [file] of backups) {
  const now = sha(file);
  log(`  ${file} → sha256:${now}`);
}
// 复查"还原后测试仍然全绿"
const afterWiring = runSuite('wiring');
const afterPolicy = runSuite('policy');
log(`  还原后：wiring 失败 ${afterWiring.fails} 条 / policy 失败 ${afterPolicy.fails} 条`);
if (afterWiring.fails !== 0 || afterPolicy.fails !== 0) {
  restoreBad += 1;
  bad += 1;
  log('  ★★ 还原不干净 —— 文件被改坏了！请检查 git diff。');
}

log('');
log('=== 结论 ===');
const detected = rows.filter((r) => r.ok).length;
log(`  注入 ${rows.length} 个缺陷，被测试抓到 ${detected} 个，漏掉 ${rows.length - detected} 个`);
log(`  反证失败项：${bad}${restoreBad ? '（含还原复查失败）' : ''}`);
log('');
log('  说明：这份反证证明的是「测试对**这些**缺陷有效」，不等于测试已完美 ——');
log('  新的 bug 类型仍可能绕过。测试是网，不是墙。');
process.exit(bad > 0 ? 1 : 0);
