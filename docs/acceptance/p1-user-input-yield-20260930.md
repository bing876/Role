# P1 · 浏览器真人输入临时让路：分步推送与最终验收（2026-09-30）

**结论在前：源码 P1 改动已逐步推至固定分支；在最终源码提交 `93db0c674414b41b54ca3a5022ac8f71596e920c` 上新跑的完整 `npm run verify` 为 EXIT 0，主链 58 步，686 秒。** P1 分片脚本 **11 PASS / 0 FAIL（模拟 guest/非真机）**，禁用新闸为 `if (false && …)` 时确实红，恢复后 `driver.ts` SHA-256 原字节相同。**不声称 Win/mac 真人同页同框物理输入/CDP 来源已验收**；上线前仍需下述决策与真机测试。

## 每一步单独推送

| 步 | 结果 | 已推送提交 |
|---|---|---|
| 1 | 唯一 WebContentsView guest 的原生键鼠事件按 `wcId` 记录、销毁清理 | `bc20c68` |
| 2 | `drive()` 在现有手动暂停门旁加 3000ms 闸，回 `outcome:'blocked'`；只挡尚未派发的 `click/type/fill_form` | `31570ed` |
| 3 | 桌面循环 blocked 不计失败/unknown/执行步数，等本页安静后**先读页**再送回执 | `6ab4e0d` |
| 4 | 使用既有 state 广播在现有输入框状态行显示「你在操作，我停下了」，不覆盖手动暂停/别页 | `81c97d1` |
| 5 | 逐个自查 outcome 消费面，修复服务端 3 处原漏项，不改弱 blocked；审计表见下文 | `05b92fa` |
| 6 | 真正执行 guest 接线、未派发闸、异步竞态及 `if (false && …)` 禁闸反证，原字节还原 | `353917c` |
| 7 | 同页同类：生产 `typeInto` 的 CDP 键盘命令保持在途，同 guest 同键回调仍刷新 3 秒、挡三动作；来源取舍见 ADR-0011 | `c9ab7ba` |
| 8 | 专用 `verify:p1-user-input-yield` 独立进主链/CI 快反馈；`package.json`、workflow、golden 均为 58 步 | `f2ef111` |
| 补测 | `rawKeyDown`、`char`、`keyUp`、`mouseUp` 也记最后输入；兼顾输入法与释放事件，并补执行断言 | `93db0c6` |
| 9 | 在**补测后的最终源码**上全跑 58 步；本文件记录证据，不把前一源码的绿当最终绿 | 见下节 |

## 验收证据及边界

- 本地固定分支 `arena/01a0d0a8-role`，完整运行对象 `93db0c6`；`npm run verify` **退出码 0**，耗时 **686 秒**；结束后 `git status --short` 为空。原始日志在工作区外的 `/home/user/role-p1-20260930-verify-final.log`（不入 Git，SHA-256 `57a81bcd8663100eb0eb2098874c88d23d72f396fdd922d460cf82847f29ad79`）。
- 主链 P1：**11 PASS / 0 FAIL**；模拟 guest 原生事件包括同页同键在途交错、原始键/输入法文字/释放类型、销毁清理；新闸禁用反证打印 `GATE_NOT_REACHABLE`，在 `finally` 还原源码并核 SHA。`verify:p2-idle-scan` 核对 CI 快反馈 **18 步**和主链 golden **58 步**；React/jsdom 片段 **83 PASS / 0 FAIL**。全链出现 **225 条非致命 React `act(...)` 测试警告**，不是 P1 物理输入证明；未掩盖、未用此警告冒充全绿之外的结果。
- GitHub 上同一源码提交 `93db0c6` 的 [Verify workflow](https://github.com/bing876/Role/actions/runs/36604366534) **completed/success**（`Verify chain (58 steps)`、`Typecheck`、`Release runtime` 三 job 均 success）；[Windows/macOS 打包 workflow](https://github.com/bing876/Role/actions/runs/36604366392) **completed/success**。打包/CI 通过仍不等于真人物理键盘和同框 CDP 交错实测。
- 消费方文件:行号、原漏项 3→0 的独立对照表：[`p1-outcome-consumers-20260930.md`](./p1-outcome-consumers-20260930.md)。关键路径：`apps/desktop/electron/main.ts:223` → `user-input.ts:61-78`；`driver.ts:2238`；`agent.ts:729-774`；`apps/desktop/src/App.tsx:1590,2946`；`apps/server/src/routes/loop.ts:252,263`；`apps/server/src/toolLoop.ts:1058`。屏幕提示沿既有 state 流，不额外改产品导航/组件栈。
- **已经通过 CDP 派发的点击/按键收不回来**，包括并发中已执行的字段；闸只挡下一条**尚未派发**的动作，回执说明可能的部分执行。未自动对外发送、未改明文密钥/加密故障降级策略；真实超时继续保持 `unknown`。
- **需用户拍板**：Electron 原生事件缺可靠“物理人 / CDP”来源位。为**不漏**同页同类真人输入，生产代码照记这两类可见事件；若 CDP 回声也进入回调，AI 可能多暂停 3 秒且状态行可能误显示“你在操作”。详细权衡：[`ADR-0011`](../adr/0011-user-input-yields-browser-driving.md)。本轮测试不接物理键盘、没有在 Win/mac 真 GUI 实测；模拟事件在实际 guest 收到真人输入时证明接线与计时正确，**不能证明 Electron 一定送达且仅送达人类事件**。

## 下一步（top-3 首动作）

1. **需用户拍板**：接受“宁可多让路，也不吞真人同类输入”及可能的 CDP 自回声，还是先投入可靠的设备来源方案再放量。
2. 在 **Win/mac 真机**用同一 WebContentsView/同一输入框，令 AI 的 `type` 键盘 CDP 命令在途，真人打同一键和 IME 文字；记录主进程事件类型、时间戳、状态行和后续 CDP 派发，另测已发点击不能撤销的边界。不要用模拟事件或无头浏览器替代这一步。
3. CI 与打包已在 `93db0c6` 成功；**不要以 CI 替代真人验收**。若真机发现 CDP 自回声持续自阻断，先按第 1 项决策调整来源方案，再复验 58 步主链及 CI。
