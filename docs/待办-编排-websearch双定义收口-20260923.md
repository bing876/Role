# 待办：web_search 有两份定义 —— 收口计划

- 记录时间：2026-09-23（多智能体编排 S4 引入第二份时同步记录）
- 状态：**有意的过渡状态，不是疏忽**。本批不收口（原因见下「为什么本批不做」）
- 相关：`docs/方案-多智能体编排-20260922.md`

## 一、现状：两份定义，共用一个名字

| | 聊天路径那份 | 编排路径那份 |
|---|---|---|
| 位置 | `apps/server/src/search/chatTool.ts:34` `WEB_SEARCH_TOOL` | `apps/server/src/orchestrator/search.ts:24` `WEB_SEARCH_SERVER_TOOL` |
| 类型 | 裸对象字面量（`as const`） | `ToolDefinition`（进 Tool Registry） |
| 喂给模型 | `chatLoop.ts:256` `tools: [WEB_SEARCH_TOOL]`（自己拼、自己解析、自己执行） | `serverToolRegistry.toOpenAITools(...)`（循环统一装配） |
| 执行 | `chatLoop.ts` 内联 | `executeWebSearchTool` → `runWebSearch`（唯一执行入口） |
| `side` / `kind` / `timeoutMs` | 无这些字段（不是注册表工具） | `'server'` / `'action'` / `20_000` |
| `validate` 闸 | **没有** | 有：空 query → `bad_args`；含敏感信息 → `blocked_sensitive`（R1 口径，**不外发**） |
| description | 长：【该用它】/【不要用它】/「用户点明具体网站时绝不要调用」/「绝不要说已打开」 | 短：同样的红线压缩成 5 行 + 敏感信息一行 |
| parameters | `query/topic/days/max_results`，带 `additionalProperties: false` | 同 4 个字段，**没有** `additionalProperties: false` |

**名字是单一来源的**：两边都引用 `chatTool.ts:21` 的 `WEB_SEARCH_TOOL_NAME = 'web_search'`，
不存在「同名不同字符串」的风险。分叉的只是 **description / parameters / 执行前的闸**。

## 二、风险（为什么该收口）

1. ~~**R1 的敏感 query 闸只护住了编排这一路**~~ —— **此条已核实为误记，2026-09-23 更正。**

   实测两条路**都有**敏感闸，且用的是**同一份规则**：

   | | 位置 | 判定 |
   |---|---|---|
   | 聊天路径 | `search/chatLoop.ts:339` | `SENSITIVE_TARGET_RE.test(query)` |
   | 编排路径 | `orchestrator/search.ts:57`（`validate` 闸）与 `:118`（执行前再查一次） | 同一个 `SENSITIVE_TARGET_RE` |

   两边都 `import { SENSITIVE_TARGET_RE } from '@ai-workbench/shared'`（聊天 `chatLoop.ts:24`、
   编排 `redact.ts:19` / `search.ts:17`）——**规则是单一来源的**，改一处两边同时生效，
   不存在「将来只改一边」的风险。

   **真正的差别是「闸放在哪一层」，不是「有没有闸」**：聊天那份写在循环代码里（内联 `if`），
   编排那份挂在 `ToolDefinition.validate` 上（编排还多查了一次，执行前再拦一道）。
   收口后两者会统一到 `validate`，届时聊天路径多一层前置拦截 —— 属于**加强**，不是补齐缺失。
2. **参数契约漂移**。聊天那份有 `additionalProperties: false`，编排那份没有 ——
   模型多传一个字段时两边行为不同。这类差异不会报错，只会让「同样的模型在两条路上表现不一样」，
   排查时极难想到是工具定义的差别。
3. **description 是实测调出来的资产**。聊天那份那段「用户点明了某个具体网站时绝对不要调用」
   是踩过坑才写上的（模型会拿搜索结果冒充「我去过那个网站」）。编排那份是压缩版，
   将来聊天那份再迭代，编排这份不会自动跟上。

## 三、收口方案（建议，待确认后再动）

**目标**：一份 `ToolDefinition` 定义，两条路都用它；聊天路径改成从注册表取。

1. 把编排那份 `WEB_SEARCH_SERVER_TOOL` 定为**唯一定义**，移到一个中立位置
   （建议 `apps/server/src/search/toolDef.ts`，两边都 import，谁也不依赖谁）。
2. description 合并：以聊天那份为底（它更长、实测调过），把编排那份多出来的
   「敏感信息不要调用」一行并进去。**合并后要重跑 R1 的敏感拦截验收**，
   因为 description 变了会影响模型的调用倾向。
3. parameters 补上 `additionalProperties: false`（向更严的那份看齐）。
4. `chatLoop.ts:256` 改成从注册表取定义（`serverToolRegistry.get('web_search')`），
   删掉 `chatTool.ts` 的 `WEB_SEARCH_TOOL` 常量。
   ⚠️ 这一步会让聊天请求体里的 `tools` 字段发生变化（description 变长、多了 `additionalProperties`），
   **必须**先跑一遍聊天路径的回归再合。
5. 聊天路径的「执行」是否也改走 `runWebSearch`（从而共用敏感闸与 `not_configured` 话术）：
   建议**分开做**，不要和定义收口挤在同一批 —— 定义收口只改「发给模型的那张表」，
   执行收口会改「搜到之后怎么回」，两者的验收面完全不同。

## 四、为什么本批不做

同一批里同时动**聊天搜索**和**新增编排**，等于把「新功能有没有问题」和「老功能有没有被改坏」
两个问题搅在一起 —— 出了事分不清是哪一半。本批的边界是「编排这套新东西自己全绿，
且既有验收（`verify:tools` 181 条、`verify:r4` 5/5+5/5）一条不退」，
收口留作独立一批，届时它的验收面就只是聊天路径本身。

## 五、当前不受影响的部分

- 工具**名字**单一来源，两条路不会认成两个工具。
- 浏览器循环 / 临时工 / 被委派方走的都是编排那份（有 validate 闸）。
- `ORCHESTRATION_TOOLS=0` 时编排那份不注册，聊天那份照旧工作 —— 关掉编排不会影响聊天搜索。
