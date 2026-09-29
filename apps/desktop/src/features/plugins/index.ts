/**
 * `features/plugins` 的唯一公开 API —— **feature 之间只许从这里 import**
 * （批次 M 的分层规矩：不许伸手进别人的内部路径）。
 *
 * 能力与连接（2026-09-27）：设置抽屉里的「能力与连接」卡片列表 + 其数据 hook。
 */
export { usePlugins } from './usePlugins';
export type { FieldView, TestResult } from './usePlugins';
export { PluginsPanel } from './PluginsPanel';
