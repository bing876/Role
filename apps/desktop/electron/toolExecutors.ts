/**
 * 阶段 0 · 桌面侧浏览器执行器表（纯映射：工具调用 → BrowserAction）。
 *
 * ★ 为什么这里是一份**本地**表，而不是运行时 import shared 的 tools.ts
 *   （改这里前先读，否则一定改错）：
 *   打包配置 `apps/desktop/package.json` 的 electron-builder `files` 是白名单，
 *   里面**没有** node_modules —— 打包后的应用在运行时根本没有
 *   `@ai-workbench/shared` 这个包。本文件只允许 `import type`，任何运行时
 *   import（哪怕只是 tools.ts）都会让打包产物在用户机器上启动即崩。
 *   所以这份表是 deliberately duplicate（刻意重复）：它与 shared 内建定义的
 *   `toBrowserAction` 逐项等价，由 `scripts/verify/tool-registry-parity.mjs`
 *   强制断言一致 —— 改了任何一侧的映射而不改另一侧，对照测试会红。
 *
 * 职责边界：
 *   - 本文件只做「名 → 映射函数」的纯查表，不调 drive、不碰 webview；
 *   - 真正的执行仍是现有路径：agent.ts `runToolLoop` 拿到 BrowserAction 后调
 *     `drive()`（driver.ts 一行不改）；
 *   - 未知工具名 / control 类（stop）返回 null = 不执行（与旧 toolToAction 的
 *     default 分支语义一致，别改成抛错 —— 服务端版本新、桌面版本旧时，
 *     新工具名会先到这里，抛错会把整个循环炸掉，返回 null 只是跳过这一步）。
 */
import type { BrowserAction, LoopToolCall } from '@ai-workbench/shared';

type BrowserMapper = (args: Record<string, unknown>) => BrowserAction | null;

const BROWSER_EXECUTORS = new Map<string, BrowserMapper>([
  ['open_url', (a) => ({ action: 'open_url', url: String(a.url ?? '') })],
  ['read_page', () => ({ action: 'read_page' })],
  ['click', (a) => ({ action: 'click', target: String(a.target ?? '') })],
  [
    'type',
    (a) => ({
      action: 'type',
      target: String(a.target ?? ''),
      text: String(a.text ?? ''),
      submit: Boolean(a.submit),
    }),
  ],
  ['scroll', (a) => ({ action: 'scroll', direction: a.direction === 'up' ? 'up' : 'down' })],
]);

/** 桌面认识的浏览器工具名（诊断用；与 shared 的 BROWSER_TOOL_NAMES 去掉 stop 后一致） */
export function desktopBrowserToolNames(): string[] {
  return [...BROWSER_EXECUTORS.keys()];
}

/**
 * 工具调用 → 本地 driver 动作。唯一与旧 switch 的行为差是防御性的：
 * 旧 switch 在 `call.args` 缺失时会抛错，这里按空对象处理
 * （线上服务端 sanitize 保证 args 恒为对象，走不到）。
 */
export function resolveBrowserAction(call: LoopToolCall): BrowserAction | null {
  const fn = BROWSER_EXECUTORS.get(call?.name ?? '');
  if (!fn) return null;
  const raw = (call as { args?: unknown } | null | undefined)?.args;
  const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return fn(args);
}
