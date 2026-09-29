# P1 放行前必查 · CDP 自回声与 150ms 边界（2026-09-30）

**结论：旧版存在条件性自阻断；假宿主不能回答真 Electron 是否回送。**显式让假 guest 在生产 `debugger.sendCommand(Input.*)` 中同步回送 `before-*`（完全不送真人事件）后，旧版 Q1/Q2 **4 项红**。当前修法在同一假宿主下，Q1 `type` 三条路径及 Q2 `click/fill_form` 均**动作完整完成、真人时间戳不刷新**；P1 测试 **17 PASS / 0 FAIL**。在这版源码上**新跑的完整 `npm run verify`：58 步 EXIT 0、耗时 722 秒**；不能把模拟回声冒充 Win/mac 真机来源证明。

## 只读盘点 → 修前反证 → 修后结果

- 接线：`apps/desktop/electron/main.ts:223` 调 `wireGuestInput()`；旧版 `user-input.ts:65-75` 一收到键鼠事件便 `recordUserInput`，无来源检查。`driver.ts:870-887` 的 `ensureAttached().sendCommand` 是 CDP 统一出口；`typeInto` 会先派发鼠标按下/抬起激活输入框，再 `Input.insertText`，必要时逐字 `Input.dispatchKeyEvent`；`clickTarget` 发移动/按下/抬起；`fill_form` 逐字段调用 `typeInto`。
- 默认 fake `scripts/verify/p1-user-input-yield.mts:83-91` **不会自动回送 CDP**，只有原同类测试专门发一个键盘回声。默认假宿主“未刷新”没有诊断意义。补充模式只在生产 CDP Input 真的调用后同步回送到已接线的本页 `EventEmitter`，并明确断言该回调确实有监听器。

| 问题（仅 AI 命令，无真人事件） | `e6b3e91` 修前红的证据 | 修后假宿主 |
|---|---|---|
| Q1：`type`，只用 CDP `Input.insertText` | guest 收到 `char`；动作虽返回但 3 秒闸还剩 **2250ms** | 真实发出 `insertText`，guest 收到 `char`，动作完成，真人闸 **0ms** |
| Q1：`type`，含 CDP 点击激活 | guest 收到鼠标回声后 `type` 收手，`insertText` 未派发 | guest 收到 `mouseDown/mouseUp/char`，完成 `insertText`，闸 **0ms** |
| Q1：`type` 的逐字符兜底 | 旧版会在前述聚焦回声处先收手 | 回送 `keyDown/char/keyUp` 后完成，闸 **0ms** |
| Q2：`click` | 被自身 `mouseMove` 回声挡成 `blocked` | guest 收到两次移动及按下/抬起，完整结束，闸 **0ms** |
| Q2：双字段 `fill_form` | 首字段聚焦回声使后续 `insertText` 未派发 | 两字段均实际派发 `insertText` 并结束，闸 **0ms** |

修法：`apps/desktop/electron/driver.ts` 在统一 CDP `sendCommand` **调用原始命令之前**按本页记录事件类型；`user-input.ts` 对符合条件、派发后 **<150ms** 的原生回声只消耗一次标记，不更新用户时间戳，也不展示“你在操作”。没有来源位，不存键名、坐标或文字。页销毁清标记。既有同页同键在途案例验证 CDP 回声被消费后 **10ms** 的第二次事件仍算真人；另有无回声案例验证派发满 **150ms** 的真人同类事件计数、别页不受抑制。

**反证常驻**：把新 3 秒闸改成 `if (false && …)` 测试报 `GATE_NOT_REACHABLE`；把 CDP 回声标记调用改成 `if (false) …`，Q1/Q2 报 `SELF_BLOCKED`；均在 `finally` 按 SHA-256 原字节还原。定向已跑：`verify:typecheck`、`verify:p1-user-input-yield`、`verify:p1-5-pause`、`verify:p1-2-outcome`、`verify:no-orphans`、`verify:gates`、`verify:p2-idle-scan` 均通过。完整 `npm run verify` **EXIT 0 / 58 步 / 722 秒**；P1 输出 `17 PASS / 0 FAIL`、主链 CI/golden 对齐 **18 步快反馈 / 58 步主链**，最终 React/jsdom 段 `83 PASS / 0 FAIL`。完整日志不入 Git：`/home/user/role-self-input-20260930-verify-full.log`，SHA-256 `75e40eeb0dab01e239525578a7d3bd46978ec89b1bb730531974081e44cb5653`；仍有 225 条非致命 React `act(...)` 测试警告，不是物理输入来源的证据。

**需用户拍板：150ms 是启发式盲区，不是来源证明。** 若真人同类型事件在 CDP 回声之前抢先到达（哪怕是同一个键），第一条可能被误吞；若 CDP 单命令多次回送或事件延迟到 >150ms，余下回声仍可触发 3 秒闸。“真人不可能在 150ms 内输入同一键”不是可靠前提；无法靠假宿主证明真机不存在这些时序。两条严格保证——绝不漏真人、绝不自阻断——在缺少来源位时不可同时宣称成立。风险和验收条件见 [`ADR-0011`](../adr/0011-user-input-yields-browser-driving.md)。

## 首动作

1. **需用户拍板**：接受一次性 150ms 启发式作为放量条件，还是先取得可信设备来源再放量。
2. Win/mac 真 GUI 上同页同框交错测试，记录 CDP 派发与原生事件类型/到达时间、抑制情况；别用假宿主代替物理输入验收。
3. 全链已在修后源码上跑通；推送后核对**最新固定分支提交**的 CI 58 步结果。CI 通过也不替代第 2 项真机来源验收。
