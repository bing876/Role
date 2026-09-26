/**
 * 阶段 3 · Electron 升级 · 验收(每片改 TARGET_MAJOR,其余不动)
 *
 * 用户标准(ADR-0001 决定 2/3 + 加速口径 2026-09-26):逐 major 过官方 breaking 清单,
 * 连续零暴露面可 2–3 个 major 合一片;每片 `verify:shell` + 全量 verify 全绿才 push;
 * 交付报告含逐 major breaking 对照 + 装后版本核对。
 *
 * 当前片:TARGET_MAJOR = 42(第五片 41–42 合并,两个 major 官方清单均核实零代码暴露面;
 * 41:PDF 改 OOPIF 不再建独立 WebContents(我们不检测 PDF WebContents)/cookie changed 事件语义
 *   (未订阅)/Linux showHiddenFiles 弃用(未用)/macOS ASAR Integrity digest(opt-in,未启用+未配签名=零影响);
 * 42:macOS 通知迁 UNNotification 需签名(我们零 Notification 使用)/electron 改懒下载二进制(装后约定变更,非代码)/
 *   OSR 默认 dsf=1.0(未用 OSR)/clearStorageData quotas 移除(未用)/ELECTRON_SKIP_BINARY_DOWNLOAD 移除(仅沙箱装约定);
 * 逐 major 对照表见 docs/adr/0001-浏览器控制与Electron升级.md「分片记录」节)。
 *
 * 本脚本盖的(沙箱内,不拉 electron 二进制):
 *   ① 装后版本核对:node_modules/electron 实际 major = TARGET_MAJOR(不是只看声明)
 *   ② 声明核对:apps/desktop/package.json 声明 ^TARGET_MAJOR
 *   ③ verify:shell 真跑全绿(webview 祖先链 golden + display:none/归零红线网在新版上成立)
 *   ④ 桌面 + electron 双 tsconfig 类型绿(新版类型兼容)
 *   ⑤ 无原生模块(升级零 rebuild 暴露面)
 * 盖不到的(ADR-0001 失败模式表 #1/#4/#5,理由见 ADR):真机 webview 渲染差异 / 真打包 / Windows 行为。
 *
 * 用法:npx tsx scripts/verify/electron-upgrade.mts
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 当前片目标 major(第五片:41–42 合并,装后应为 42.x) */
const TARGET_MAJOR = 42;

/** 脚本在 scripts/verify/ 下,仓库根 = 上两级 */
const REPO = fileURLToPath(new URL('../..', import.meta.url));

let passes = 0;
let fails = 0;
const log = (...a: unknown[]) => console.log(a.map(String).join(' '));
const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try {
    await fn();
    passes += 1;
    log(`  ✓ ${name}`);
  } catch (err) {
    fails += 1;
    log(`  ✗ ${name}`);
    log(`      ${(err as Error)?.message?.split('\n').slice(0, 4).join('\n      ') ?? String(err)}`);
  }
};

async function main(): Promise<void> {
  log('=== 阶段 3 · Electron 33→34 第一片 · 验收 ===');

  await check(`装后版本核对:node_modules/electron 实际 major = ${TARGET_MAJOR}(防「声明改了没装上」)`, () => {
    const pj = JSON.parse(readFileSync(`${REPO}node_modules/electron/package.json`, 'utf8')) as { version: string };
    const major = Number(pj.version.split('.')[0]);
    assert.equal(major, TARGET_MAJOR, `node_modules/electron 实际版本 ${pj.version},major 应为 ${TARGET_MAJOR}`);
    log(`      装后版本 = ${pj.version}`);
  });

  await check(`声明核对:apps/desktop/package.json 的 electron 声明 = ^${TARGET_MAJOR}`, () => {
    const pj = JSON.parse(readFileSync(`${REPO}apps/desktop/package.json`, 'utf8')) as { devDependencies: Record<string, string> };
    const decl = pj.devDependencies.electron ?? '';
    assert.ok(decl.startsWith(`^${TARGET_MAJOR}`), `声明应为 ^${TARGET_MAJOR},实际 ${decl}`);
  });

  await check('verify:shell 全绿(webview 祖先链 golden + 红线网在新版 Electron 上成立)', () => {
    // verify:shell = tsx scripts/verify/app-shell-smoke.mts(jsdom 真挂 App,不依赖 electron 二进制)
    execFileSync('npx', ['tsx', 'scripts/verify/app-shell-smoke.mts'], { cwd: REPO, stdio: 'pipe' });
  });

  await check('桌面 + electron 双 tsconfig 类型绿(新版类型兼容)', () => {
    const tsc = `${REPO}node_modules/.bin/tsc`;
    execFileSync(tsc, ['-p', 'apps/desktop', '--noEmit'], { cwd: REPO, stdio: 'pipe' });
    execFileSync(tsc, ['-p', 'apps/desktop/tsconfig.electron.json', '--noEmit'], { cwd: REPO, stdio: 'pipe' });
  });

  await check('桌面端无原生模块(升级零 rebuild 暴露面)', () => {
    const pj = JSON.parse(readFileSync(`${REPO}apps/desktop/package.json`, 'utf8')) as { dependencies: Record<string, string> };
    const deps = Object.keys(pj.dependencies).sort();
    assert.deepEqual(deps, ['@ai-workbench/shared', 'react', 'react-dom'], `dependencies 应为纯 JS,实际 ${JSON.stringify(deps)}`);
  });

  log('');
  log(`=== 结论:${passes} PASS / ${fails} FAIL ===`);
  log('（真机 webview 渲染 / 真打包 / Windows 全屏行为:沙箱盖不到,见 ADR-0001 失败模式表 #1/#4/#5,交付报告需用户本地复跑）');
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.error('验收脚本自身出错:', err);
  process.exit(1);
});
