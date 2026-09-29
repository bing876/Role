# 验收报告：web_search 双定义收口（2026-09-23）

- 对应待办：`docs/待办-编排-websearch双定义收口-20260923.md`
- 分支：`arena/01a0ce4f-role`
- 目标：一份 `ToolDefinition` 定义，两条路都用它，参数契约统一

## 一、改动清单

| 文件 | 改动 |
|---|---|
| `apps/server/src/search/toolDef.ts` **新增** | 唯一定义：`WEB_SEARCH_TOOL_NAME` / `WEB_SEARCH_MAX_ROUNDS` / `WEB_SEARCH_TOOL_DEFINITION`（`WEB_SEARCH_SERVER_TOOL` 别名）。description 以聊天路径长描述为底（含网站红线、已打开谎言、敏感拦截），parameters 补 `additionalProperties:false`，validate 与编排原有逻辑一致（空 query / 敏感拦截 / topic/days/max_results 归一） |
| `apps/server/src/orchestrator/search.ts` | 删除旧双定义，改为 `import { WEB_SEARCH_TOOL_DEFINITION } from '../search/toolDef'` 并 re-export `WEB_SEARCH_SERVER_TOOL = WEB_SEARCH_TOOL_DEFINITION`，执行逻辑（`runWebSearch` / `formatSearchForModel` / `executeWebSearchTool`）保留，单一来源 |
| `apps/server/src/search/chatTool.ts` | 删除旧裸对象字面量 `WEB_SEARCH_TOOL` 的独立定义，改为从 `toolDef.ts` 派生：`WEB_SEARCH_TOOL_NAME` / `MAX_ROUNDS` 重导出，`WEB_SEARCH_TOOL` 作为 OpenAI 兼容对象从统一定义派生（兼容旧 import），保留 `chatSearchPolicyBlock` / `searchPolicyForTurn` / `isWebSearchToolName` |
| `apps/server/src/search/chatLoop.ts` | 不再直接 `tools:[WEB_SEARCH_TOOL]`，改为优先 `serverToolRegistry.get('web_search')` → `toOpenAITools`，fallback 到 `toolDef` 单一来源转 OpenAI 工具。保证 `ORCHESTRATION_TOOLS=0` 时仍可用（registry 未注册则走 fallback），且与编排共用同一 description |
| `apps/server/src/orchestrator/workers.ts` | 修复旧 bug：之前直接把 `ToolDefinition` 当 OpenAI tool 传给 `llmFetch`（靠桩测试没暴露），现在显式转成 `{type:'function', function:{name,description,parameters}}`，定义来源为 `toolDef.ts` |
| `scripts/verify/websearch-single-source.mts` **新增** | 专项验收：单一来源、description 包含三条红线、additionalProperties、validate 敏感闸、chatTool 与 orchestrator 同源 |

## 二、设计决策

1. **中立位置 `search/toolDef.ts`**：两边都 import，谁也不依赖谁。聊天路径不依赖 `ORCHESTRATION_TOOLS` 开关，`ORCHESTRATION_TOOLS=0` 时聊天搜索照旧工作（registry 未注册则 fallback 到定义本身）。
2. **description 合并**：以聊天那份长描述为底（实测调过，含「点明网站不要搜」「绝不要说已打开」），已包含敏感行，无需额外合并。
3. **parameters 向更严看齐**：补 `additionalProperties:false`，与聊天原有保持一致，编排侧之前缺失的现在补齐。
4. **validate 统一**：`SENSITIVE_TARGET_RE` 仍为单一来源（`@ai-workbench/shared`），`toolDef.validate` 与原编排逻辑逐字一致，聊天路径在 `chatLoop.ts` 内联敏感检查保留（纵深防御），同时新增 registry 前置闸时多一层拦截（加强非缺失）。
5. **执行收口分开**：本批只收口「发给模型的那张表」，聊天路径的执行仍走 `chatLoop.ts` 内联 `webSearch`，未改成 `runWebSearch`（按待办建议分两批，避免同时动定义与执行）。

## 三、验收

- `npm run verify:tools`：181 条 + 新增契约全绿（工具表 deep-equal、校验、映射、回滚开关、服务端直执行）
- `npm run verify:r4`：31 条源码一致性 + 5/5+5/5 真服务端发车验收全绿
- `orc-registry / orc-workers / orc-park / orc-delegate / orc-e2e / orc-routes / orc-desktop-park / orc-channels-ui / orc-killswitch / orc-park-sse`：逐项跑，全部 PASS（全量 `verify:orch` 因总时长>120s 超时，但单项均绿）
- 新增 `websearch-single-source.mts`：9 PASS / 0 FAIL（单一来源、additionalProperties、敏感闸、红线文案、fallback 路径）

## 四、兼容性

- `ORCHESTRATION_TOOLS=0`：编排工具（spawn_workers/delegate/web_search）不注册，浏览器循环工具表仍为 6 个（5+stop），与改前逐字节一致；聊天搜索走 `toolDef` fallback，不受开关影响。
- 旧 import 路径：
  - `import { WEB_SEARCH_TOOL } from './chatTool'` 仍可用（派生自统一定义）
  - `import { WEB_SEARCH_SERVER_TOOL } from './search'`（orchestrator）仍可用（=统一定义）
  - `import { WEB_SEARCH_TOOL_NAME }` 两边均重导出，单一来源

## 五、后续

- 待办文档状态更新为**已完成**（原「有意过渡状态」已收口）
- 聊天执行路径是否也改走 `runWebSearch`（共用 `not_configured` / 敏感闸话术）可作为下一批独立任务
