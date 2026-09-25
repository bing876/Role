import type { WorkbenchSettings } from '@ai-workbench/shared';

/**
 * 批次 M-8' · 逻辑收尾：首帧兜底配置从 App.tsx **逐字搬入** shared（与 api.ts 同目录）。
 * App 现在只 import 这一个常量；兜底值与 packages/shared 的 DEFAULT_SETTINGS 的
 * 同步规矩不变（权威在主进程 settings.ts，改默认值要同步的那条注释跟着块一起搬）。
 */
/**
 * 第 22 步：可调配置的**兜底值** —— `packages/shared` 里 `DEFAULT_SETTINGS` 的第二份。
 *
 * 只用于「主进程还没把配置同步过来」的那一瞬间（首帧）。正常路径永远以主进程为准
 * （挂载时 getSettings 拉一次，之后跟随 'settings' 广播）。
 * 之所以不复用 shared 的运行时值：渲染层至今只从 shared 取类型，不引入打包期依赖更稳。
 */
export const SETTINGS_FALLBACK: WorkbenchSettings = {
  // ⚠️ 这几个数必须与 packages/shared 的 DEFAULT_SETTINGS 保持一致（权威值在主进程 settings.ts，
  // 这里只是首帧兜底）。之所以不复用 shared 的运行时值：渲染层至今只从 shared 取**类型**，
  // 不引入打包期依赖更稳 —— 代价就是**改默认值时要记得同步这一处**。
  // 当前：并发默认 20（子阶段 A 起）、开页上限默认 4；
  // Phase 4 新增的资源守护者字段（开关 / 频率 / 两档阈值 / 系统内存兜底）同样照抄一份。
  maxConcurrentAgentTasks: 20,
  maxBrowserInstances: 4,
  resourceGuardEnabled: 1,
  resourceSampleMs: 5000,
  resourceMemHealthMB: 3072,
  resourceMemWarnMB: 4096,
  resourceCpuHealthPct: 20,
  resourceCpuWarnPct: 35,
  resourceSysMemGuard: 0,
  resourceSysMemFloorMB: 1536,
};
