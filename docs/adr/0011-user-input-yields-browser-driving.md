# ADR-0011：WebContentsView 键鼠事件后的浏览器临时让路

## 背景与决定

用户已定：同一张内嵌页最近一次键鼠操作后 **3000ms** 内不派发尚未发出的 `click/type/fill_form`；输入框上方现有状态行显示 **「你在操作，我停下了」**。不用新状态机或 IPC：唯一 `wireBrowserGuest` 建页口把原生 `WebContents.webContents` 的 `before-mouse-event`（移动/按下/滚轮）与 `before-input-event`（按下）接到主进程按 `wcId` 的单调钟；销毁清理。`drive()` 的新闸紧邻既有手动暂停门，使用同一组三动作；继续前等本页安静 3 秒、读当前页，`outcome:'blocked'` 与失败/unknown 独立，部分派发如实标出，手动暂停优先。

### 同页同类的冲突：优先不漏真人，代价是可能多让路

Electron 文档中 [WebContents 原生事件](https://www.electronjs.org/docs/latest/api/web-contents#event-before-input-event)、[键盘输入结构](https://www.electronjs.org/docs/latest/api/structures/keyboard-input-event)、[鼠标输入结构](https://www.electronjs.org/docs/latest/api/structures/mouse-input-event)没有可靠的“真人设备 / CDP”来源标记。若 AI 的 `Input.dispatchKeyEvent(keyDown, key:'x')` 尚未回包，用户在同一控件也敲 `x`，两次 `before-input-event` 在可见字段上可以完全一样；用“同页同类 CDP 在途”去吞其中一次，会吞掉真实接管。主进程因此**不按同类在途来排除原生事件**：一旦 guest 发来真人键盘事件就刷新时间戳，后续动作收手。已有测试让生产 `typeInto` 真卡在 CDP keyDown Promise，同时通过生产 guest 回调送同页同键的第二个事件，断言窗口刷新和三动作挡下；不靠删闸/改弱 blocked 才绿。

**需用户拍板：是否接受保守过度让路。** 如果 CDP 输入也触发 Electron 前置事件，它同样会被暂记为用户输入，AI 可能给自己加上 3 秒延迟，状态行可能误显示用户正在操作。这是为了“不漏用户”采取的安全优先取舍，绝不宣称它既能完全识别真人、又能完全排除 CDP；若必须同时做到两者，需要另有可靠设备来源信号/平台级方案，不能靠 `isTrusted` 或输入文字猜来源。上述同类测试是 Electron 边界以外的模拟，不是 Win/mac 的物理键盘实测；正式放量前需在 Win/mac 真机观察 CDP 事件路径与状态行效果。

## 边界

- CDP **已经派发出去的点击/按键无法收回**；入口闸和异步定位后的复查只防止尚未派发的下一操作。若 `type` 清空了输入框或 `fill_form` 已尝试部分字段，`blocked` 回执会明确说明可能的部分执行，不谎称整步毫无副作用。
- 仅本页时间戳，别页不互相挡；连续真人事件刷新 3 秒窗口，窗外恢复原 detail，`phase`/手动 `paused` 位不变；`read_page` 不受三动作闸阻断。
- 仅记录 `wcId` 和主进程单调时间，不上传按键、坐标或表单值。测试使用 Node 假 guest 编译生产代码，不以 headless Chromium 冒充真机验收。
