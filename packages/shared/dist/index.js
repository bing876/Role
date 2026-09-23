"use strict";
/**
 * @ai-workbench/shared
 *
 * 只放「类型」——渲染进程、Electron 主进程、以及未来的 apps/server 都从这里取契约。
 * 全部是 type-only 导出，编译后不产生任何运行时代码，任何环境引入都零成本。
 *
 * 阶段 0 补充：`tools.ts` 是本包第一份**运行时**代码（Tool Registry 定义侧，
 * 零依赖纯模块）。**只有服务端在运行时 import 它** —— 桌面打包产物里没有
 * node_modules，Electron 主进程只能 import 本包的**类型**，详见 tools.ts 文件头。
 * 不要在这里加任何带 Node/Electron 依赖的运行时代码。
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SETTINGS = exports.SETTINGS_RANGE = void 0;
/**
 * 配置的取值范围。主进程读写时一律夹到这个区间里 ——
 * 防止有人手改 JSON 改出负数或 0（那会让功能直接不可用）。
 */
exports.SETTINGS_RANGE = {
    /**
     * 子阶段 A：上限从 8 放宽到 20 —— 默认值 20 必须落在合法区间里，
     * 否则「夹到区间」这一步会把默认值本身改回 8。
     */
    maxConcurrentAgentTasks: { min: 1, max: 20 },
    maxBrowserInstances: { min: 1, max: 20 },
    // Phase 4：资源守护者（开关类的用 0/1 —— 本套配置全是数值字段，保持同一形态）
    resourceGuardEnabled: { min: 0, max: 1 },
    resourceSampleMs: { min: 1000, max: 60000 },
    resourceMemHealthMB: { min: 256, max: 65536 },
    resourceMemWarnMB: { min: 512, max: 131072 },
    resourceCpuHealthPct: { min: 1, max: 100 },
    resourceCpuWarnPct: { min: 2, max: 100 },
    resourceSysMemGuard: { min: 0, max: 1 },
    resourceSysMemFloorMB: { min: 128, max: 32768 },
};
/**
 * 默认值（子阶段 A：并发默认 **20**；D：多实例上限默认 **4**；Phase 4：资源阈值见下）。
 *
 * Phase 4 这几个数的依据（本机 15.82 GB / 12 逻辑核，子阶段 A 实测 8 页 ≈ 0.67~1.04 GB）：
 *   - 单页边际 ≈ 123 MB → 4 GB ≈ 30 页，是本机内存的 25%；
 *   - 空闲 CPU 基线只有 0.03~0.23%（全机口径），35% = 约 4.2 个核在满载；
 *   - 3072/4096 之间留一段「灰区」，避免阈值抖动导致反复提示。
 * 这三个数**都是可调的**（见上），改配置即可，不需要改代码。
 */
exports.DEFAULT_SETTINGS = {
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
/**
 * 阶段 0 · Tool Registry 定义侧（本包唯一的运行时模块，服务端专用）。
 * 桌面端只允许 import 上面的类型 —— 打包产物里没有这个包的运行时，详见 tools.ts 文件头。
 */
__exportStar(require("./tools"), exports);
//# sourceMappingURL=index.js.map