# P1 共享契约 `outcome:'blocked'` 消费面审计（2026-09-30）

结论：逐字搜索 `apps/server/src`、`apps/desktop`、`packages/shared/src`，并查服务端回执入站、暂停认领、加密 checkpoint/DB 建表。与**驾驶回执**相关的消费/转发/持久化点共 **9 处**（其中直接读/传 `outcome` 的 6 处，通用回执下游 3 处）；原有**3 处漏处理**：服务端 `/next` 入站白名单丢掉新值、SSE 把 `ok:false` 当 warning、模型回执把 `ok:false` 写成失败。本片已补 3 处，剩余漏处理 **0 处**。源码里的 `sanitizeToolCall` 局部变量 `outcome` 是**模型参数校验结果**，与 `DriveResult.outcome` 不是一个字段；头像状态里的 `blocked` 也不是执行回执。

| 文件:行号 | 怎么用 outcome | 认不认 blocked |
|---|---|---|
| `packages/shared/src/index.ts:310` | 类型 `DriveResult.outcome` | 是；第四个可选值 |
| `packages/shared/src/index.ts:1157` | 类型 `LoopToolResult.outcome` | 是；旧调用者不填仍兼容 |
| `apps/desktop/electron/driver.ts:514` | 入口 3 秒闸及异步派发前复查产生 `ok:false, outcome:'blocked'`，部分执行详情如实说明 | 是；既非 failed 亦非 unknown |
| `apps/desktop/electron/agent.ts:346` | `toResult()` 把 outcome 原样带入服务端回执 | 是；不降级 |
| `apps/desktop/electron/agent.ts:729` | 桌面循环独立 blocked 分支，在普通步骤/失败/unknown 计数前等待本页安静、读当前页 | 是；不增桌面步数或失败/unknown 计数 |
| `apps/desktop/electron/agent.ts:871` | 原有 unknown 分支；只针对超时或中断 | 是；blocked 已在此前 `continue`，不会落进 unknown |
| `apps/server/src/routes/loop.ts:252` | `/agent/loop/next` 入站白名单校验并透传四种合法值 | 是；`ok:false` 的 blocked 不丢失 |
| `apps/server/src/routes/loop.ts:263` | SSE note 通知（以前 `ok:false` 一律 warning） | 是；blocked 单独用 info“已让路”，不是失败告警 |
| `apps/server/src/toolLoop.ts:1058` | `describeToolResult()` 给模型看的工具回执文本 | 是；明说用户操作、后续未派发；有新快照才称读过当前页 |
| `apps/server/src/routes/loop.ts:469-473` | `/pause` 认领未送出的 `LoopToolResult`（已有 pending 才接收） | 是；原样传给共用的 `ingestToolResult()`，不收窄成三值 |
| `apps/server/src/toolLoop.ts:1376-1393` | `/next`、`/pause` 共用认领工具回执，生成模型 tool 消息 | 是；调用上述 `describeToolResult`；`session.step += 1` 是**工具调用/幂等的推进序号**，不是失败/unknown 计数。blocked 不计桌面实际执行步，但服务端仍须清 pending、记录 tool 消息以免重发。 |
| `apps/server/src/orchestrator/checkpoint.ts:87` | 加密保存 `session.messages` 中的工具回执文本；`apps/server/src/db.ts` 建表 | 是；保存人话结果，无 outcome 三态 enum 或 CHECK，不存在入库时拒第四值 |

**switch/if 穷举检查**：`DriveResult.outcome` / `LoopToolResult.outcome` 无仅含 done/failed/unknown 三分支的 switch；桌面 `blocked` 在 `unknown`、普通失败分支之前；服务端白名单包含四值。`packages/shared/src/tools.ts` 中的 `reason:'blocked'` 是另一个工具的“页面做不了”原因，不是这一枚 outcome。保留 P1-2 对真实超时的 unknown 语义，不为了让 blocked 通过类型而改成 failed/unknown。

**边界**：本审计是源码 + 桩行为，不代表 Win/mac 原生键鼠输入与 CDP 来源已被真机鉴别。服务端 `session.step` 按模型工具调用计数，实际未派发的动作不计入桌面 `taskStep`；两种步数服务不同协议，不把协议推进序号冒充失败次数。
