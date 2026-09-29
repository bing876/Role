# 阶段 0 · Tool Registry 实施说明（2026-09-22）

> 范围：把 5 个浏览器工具 + stop（共 6 个）注册化（定义与执行分离的两截式），为阶段 1（临时工）/
> 阶段 2（委派）铺好"新工具只增不改"的扩展口。`web_search` 留在 `search/chatTool.ts`，
> 本次不动。`driver.ts`、`main.ts` Lane 逻辑、循环路由、`LoopSession`、提示词均未动。

## 一、改了什么（文件清单）

| 文件 | 动作 | 说明 |
|---|---|---|
| `packages/shared/src/tools.ts` | 新增 | Registry 契约：`ToolDefinition` / `createToolRegistry()` / 7 个内建定义 / 校验与敏感判定（从 toolLoop 搬家，逻辑逐字） |
| `packages/shared/src/index.ts` | 修改 | `export * from './tools'` + 包头注释（本包第一份运行时代码，仅服务端用） |
| `apps/server/src/toolRegistry.ts` | 新增 | 服务端单例：注册内建定义、`LOOP_TOOL_NAMES`、`registerServerTool`（阶段 1+ 用）、`normalizeToolArgs` |
| `apps/server/src/toolLoop.ts` | 修改 7 处 | import / LOOP_TOOLS 冻结注释+回滚开关 / 删本地正则 / sanitize 拆分 / askModel 工具表来源 / advanceInner 内循环+server 分支 / toolToAction 查表 |
| `apps/desktop/electron/toolExecutors.ts` | 新增 | 桌面本地纯映射表（刻意重复，见下） |
| `apps/desktop/electron/agent.ts` | 修改 1 处 | toolToAction 委托给执行器表 |
| `scripts/verify/tool-registry-parity.mts` | 新增 | 新旧对照测试（181 断言） |
| `package.json` | 修改 | 新增 `verify:tools` 脚本 |

## 二、关键设计决策（评审必读）

1. **两截式是被架构逼出来的，不是偏好。** 脑（服务端）手（桌面）不在一个进程，
   注册表里挂不上桌面的 `execute` 实现。所以：定义侧放 shared，执行器按位置分两侧。
2. **桌面本地表是刻意重复。** electron-builder `files` 白名单里没有 node_modules，
   打包产物运行时没有 `@ai-workbench/shared`。桌面只允许 `import type`。
   编译验证：`dist-electron/toolExecutors.js` 零 `require`，`agent.js` 只 require 相对路径。
3. **回滚开关 `TOOL_REGISTRY_LEGACY=1`**：工具表 / 校验 / 映射三处同时回旧逻辑，
   与改前逐字节一致。验收一版后删除开关与全部 `*Legacy`。
4. **默认行为零变化的三个证据**：工具表 deep-equal 旧字面量；sanitize 新旧 135 用例一致；
   server 映射/桌面映射新旧一致。唯一行为差是防御性的（args 缺失时旧 switch 抛错，
   新逻辑按空对象处理；线上 sanitize 保证 args 恒为对象，走不到）。
5. **server 直执行分支阶段 0 走不到**：无任何 server 工具注册，`advanceInner` 内循环
   恒一次迭代。分支只被对照测试 §⑥ 覆盖（临时工具 + stub 上游，跑完即弃）。

## 三、验证结果（本机实测）

- `npm run verify:tools`：**181 PASS / 0 FAIL**（工具表 / 注册表契约 / 校验矩阵×3 快照 /
  映射 / 回滚开关 / server 直执行 e2e）
- `npm run typecheck`：shared + desktop（双 tsconfig）+ server **全绿**
- 旧测试 `agent-loop-audit-test.mts`：**全过**（无回归）
- `build`：server（tsc）+ desktop（vite + electron tsc）**全绿**
- 打包安全：见上二.2 的编译产物检查

## 四、线上验收（4 个真机场景，合后在测试机走）

1. 搜索任务全流程（open_url→type→scroll→stop(done)），与改前逐轮对比；
2. 闲聊触发 web_search（确认未受影响）；
3. 暂停→手动→继续（delta 链路不受内循环改动影响）；
4. 敏感词 type（密码/验证码）与支付确认 click 照旧被拦。
   任一异常：设 `TOOL_REGISTRY_LEGACY=1` 重启服务端即回滚，无需重新部署。

## 五、后续清理（验收一版后）

删除 `TOOL_REGISTRY_LEGACY` 开关、`LOOP_TOOLS` 字面量、`sanitizeToolCallLegacy`、
服务端/桌面 `toolToActionLegacy`。届时工具表唯一真相 = shared 内建定义 + 各调用方名单。
