/**
 * 阶段 3 · Electron 升级 · 验收(每片改 TARGET_MAJOR,其余不动)
 *
 * 用户标准(ADR-0001 决定 2/3 + 加速口径 2026-09-26):逐 major 过官方 breaking 清单,
 * 连续零暴露面可 2–3 个 major 合一片;每片 `verify:shell` + 全量 verify 全绿才 push;
 * 交付报告含逐 major breaking 对照 + 装后版本核对。
 *
 * 当前片:TARGET_MAJOR = 44(第六片 43–44 合并,爬到最新稳定;两个 major 官方清单均核实零代码暴露面;
 * 43:下载默认位置改 Downloads(我们 will-download 恒 setSavePath 到项目目录)/nativeImage SRGB 归一化
 *   (零使用)/Linux frameless 圆角(我们 frame:true)/showHiddenFiles Linux 移除(41 已核零);
 * 44:macOS 12 停止支持(平台项)/net.request 客户端证书+Sec-Fetch-Dest 校验(net 模块零使用)/
 *   ANGLE 静态链接(打包内部)/32-bit 构建移除(我们 x64)/clipboard 不再暴露 renderer(40 已核零)/
 *   loginItemSettings 字段移除(零使用)/Linux Unity 桌面环境移除(平台项);
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
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 当前片目标 major(第六片:43–44 合并到最新稳定,装后应为 44.x) */
const TARGET_MAJOR = 44;

/** 脚本在 scripts/verify/ 下,仓库根 = 上两级 */
const REPO = fileURLToPath(new URL('../..', import.meta.url));
/** 本地 tsx CLI —— 用它替代 npx（Windows 上 npx 只有 .cmd，CreateProcess 起不来） */
const TSX_CLI = `${REPO}node_modules/tsx/dist/cli.mjs`;

/**
 * ★ 起子进程统一走这里（2026-09-26 修）。三条约束：
 *  ① **不要用 `npx`**：Windows 的 CreateProcess 不解析 `.cmd`（PATH 上只有 npx.cmd）⇒ ENOENT。
 *  ② **不要用 `execFileSync` / `spawnSync`**：本机沙箱把**同步** spawn 拦成 `EBUSY`
 *     （实测：`spawnSync(node)` EBUSY、`execFileSync(node)` EBUSY，而**异步 `spawn` 正常**）。
 *  ③ 所以这里用异步 `spawn` + Promise，本机与真机都能跑。
 */
function run(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const c = spawn(process.execPath, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => {
      out += String(d);
    });
    c.stderr.on('data', (d) => {
      out += String(d);
    });
    c.on('error', (e) => reject(new Error(`${args.join(' ')} 起不来：${e.message}`)));
    c.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${args.join(' ')} 退出码 ${code}\n${out}`.slice(0, 600)));
    });
  });
}

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

  await check("verify:shell 全绿(webview 祖先链 golden + 红线网在新版 Electron 上成立)", async () => {
    // verify:shell = tsx scripts/verify/app-shell-smoke.mts(jsdom 真挂 App,不依赖 electron 二进制)
    await run([TSX_CLI, 'scripts/verify/app-shell-smoke.mts']);
  });

  await check('桌面 + electron 双 tsconfig 类型绿(新版类型兼容)', async () => {
    // ★ 不走 `${REPO}node_modules/.bin/tsc`（2026-09-26 修）：那在 Windows 上是 `.cmd` shim，
    //   CreateProcess 起不来。直接走 typescript 包里的真入口 tsc.js。
    const tsc = `${REPO}node_modules/typescript/bin/tsc`;
    await run([tsc, '-p', 'apps/desktop', '--noEmit']);
    await run([tsc, '-p', 'apps/desktop/tsconfig.electron.json', '--noEmit']);
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
