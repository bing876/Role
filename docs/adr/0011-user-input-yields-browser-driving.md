# ADR-0011：WebContentsView 键鼠事件后的浏览器临时让路

## 背景与决定

用户已定：同一张内嵌页最近一次真人键鼠操作后 **3000ms** 内不派发尚未发出的 `click/type/fill_form`；输入框上方现有状态行显示 **「你在操作，我停下了」**。不用新状态机或 IPC：唯一 `wireBrowserGuest` 建页口把原生 `WebContents` 的 `before-mouse-event`（移动/按下/抬起/滚轮）与 `before-input-event`（`rawKeyDown`/`keyDown`/`char`/`keyUp`）接到主进程按 `wcId` 的单调钟；销毁清理。`drive()` 的新闸紧邻手动暂停门，使用同一组三动作；继续前等本页安静 3 秒、先读当前页，`outcome:'blocked'` 与 failed/unknown 独立，手动暂停优先。

## P1 放行前补查：CDP 自回声会造成自阻断（2026-09-30）

[WebContents 原生事件](https://www.electronjs.org/docs/latest/api/web-contents#event-before-input-event)、[键盘输入结构](https://www.electronjs.org/docs/latest/api/structures/keyboard-input-event)、[鼠标输入结构](https://www.electronjs.org/docs/latest/api/structures/mouse-input-event)没有可信的“物理设备 / CDP”来源标记。旧实现见 `e6b3e91`：guest 回调一收到键鼠事件就当真人刷新 3 秒时间戳。**假宿主默认根本不自动回送 CDP 事件，所以“默认没刷新”不是无自阻断的证据。**补充的条件性反证让生产 `drive()` 真正发 `Input.*`，假 guest 在 `sendCommand()` 内立即回送原生事件，不注入任何真人输入：纯 `type` 的 `insertText` 回声令 3 秒闸仍剩 2250ms；带鼠标聚焦的 `type` 甚至在 `insertText` 前收手；`click` 和 `fill_form` 被自身鼠标回声拦下。Q1/Q2 四项在修前均红。**这证明一旦 Electron 回送，旧代码就会自阻断，不等于已证实真实 Electron 一定这样回送。**

### 修法：按页一次性 CDP 回声标记，150ms 上限

`driver.ts` 的 `ensureAttached()` 是 CDP 命令统一出口：在调用原始 `debugger.sendCommand()` **之前**给该 guest 的 `Input.dispatchMouseEvent`、`Input.insertText`、`Input.dispatchKeyEvent` 登记短期标记。`user-input.ts` 将 CDP 鼠标 `mouseMoved/mousePressed/mouseReleased/mouseWheel` 映为原生 `mouseMove/mouseDown/mouseUp/mouseWheel`，键盘 `keyDown/rawKeyDown/char/keyUp` 同类映射；**每条命令最多认领一条**本页同类 guest 事件，认领后立即移除，未认领标记在派发后满 **150ms** 过期。只保存 `wcId`、事件类型和单调时间，**不保存键值、坐标或表单文字**。guest 回声被认领时不调用 `recordUserInput()`；真实事件仍按原 3 秒窗计时、广播与让路；页销毁清理时间戳和标记。

常驻验收在现有假 guest 中执行**生产 `drive()` 和生产原生回调**：Q1 的 `type`（仅 `insertText`、聚焦点击+`insertText`、逐字符兜底）和 Q2 的 `click`、双字段 `fill_form` 都真的派发 CDP 命令、guest 真的收到其回声，断言动作完整结束且真人时间戳 **仍为零**；同页同键 CDP 回声被消费后 10ms 内另一次同类回调仍刷新 3 秒；没有 CDP 回声时，派发满 **150ms** 后真人同类输入仍刷新时间戳，别页事件不受影响。原有 `if (false && …)` 禁闸反证及 SHA 还原保留。主链步数不变，仍是 58。

**需用户拍板：此处是启发式而非可靠来源认证。** “真人不可能在 AI 派发后 150ms 内按同一键”**不是事实保证**：若 CDP 回声没有出现或真人抢在回声前送达，同页同类型的第一条真人事件可被误认并丢失；由于没有可信来源位，连同一个键也区分不了。如果单条 CDP 命令回送多条同类事件，或回声迟于 150ms，余下回声仍可能触发 3 秒闸。保守的一次性认领减少了盲区，但不能同时严格保证“真人永不漏”和“CDP 永不自阻断”；若两者都是放行硬条件，需要平台提供独立设备来源信号或重新设计，不可把假宿主绿当真机证明。请在 Win/mac 真 GUI 同页同框交错和 CDP 回声路径上验收后决定是否接受该风险。

## 其他边界

- CDP **已经派发出去的点击/按键无法收回**；入口闸和异步定位后的复查只防止尚未派发的下一操作。若 `type` 清空了输入框或 `fill_form` 已尝试部分字段，`blocked` 回执如实说明可能的部分执行。
- 仅本页时间戳/标记，别页不互挡；连续真人事件刷新 3 秒窗口，窗外恢复原 detail，`phase`/手动 `paused` 位不变；`read_page` 不受三动作闸阻断。只记录按页单调时间，不上传用户键名、坐标或表单值。
- 测试以 Node 假 guest 编译生产代码，不以 headless Chromium 冒充真机验收。Electron 的真实 CDP→`before-*` 路由及 150ms 内事件顺序，仍**需真机测**。
