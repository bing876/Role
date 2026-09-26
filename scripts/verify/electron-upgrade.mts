/**
 * 阶段 3 · Electron 升级(33→34 第一片)· 验收
 *
 * 用户标准(ADR-0001 决定 2/3):逐 major 升,一次一片;每片 `verify:shell` + 全量 verify 全绿才 push;
 * 交付报告含装后版本核对与 breaking 清单对照。
 *
 * 本脚本盖的(沙箱内,不拉 electron 二进制):
 *   ① 装后版本核对:node_modules/electron 实际 major = 34(不是只看声明)
 *   ② 声明核对:apps/desktop/package.json 声明 ^34
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

  await check('装后版本核对:node_modules/electron 实际 major = 34(防「声明改了没装上」)', () => {
    const pj = JSON.parse(readFileSync(`${REPO}node_modules/electron/package.json`, 'utf8')) as { version: string };
    const major = Number(pj.version.split('.')[0]);
    assert.equal(major, 34, `node_modules/electron 实际版本 ${pj.version},major 应为 34`);
    log(`      装后版本 = ${pj.version}`);
  });

  await check('声明核对:apps/desktop/package.json 的 electron 声明 = ^34', () => {
    const pj = JSON.parse(readFileSync(`${REPO}apps/desktop/package.json`, 'utf8')) as { devDependencies: Record<string, string> };
    const decl = pj.devDependencies.electron ?? '';
    assert.ok(decl.startsWith('^34'), `声明应为 ^34,实际 ${decl}`);
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
