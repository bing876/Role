# 原型 结构 + 样式 权威规格（自动提取）

来源：`workbench.work.html`  
大小：2213940 字节  

> 本文件由 `extract-proto-spec.py` 从原型自动抽取，是 React 重写的**唯一权威依据**。

> 凡是要"照原型实现"，都以此处抄出的结构与 CSS 为准，不要凭记忆。


---

## 1. 设计令牌 :root

```css
:root{
  --font-ui: -apple-system, BlinkMacSystemFont,
             "SF Pro Text", "SF Pro Display", "SF Pro SC", "Helvetica Neue", "PingFang SC", "Hiragino Sans GB",
             "Inter",
             "Segoe UI Variable Display", "Segoe UI",
             "HarmonyOS Sans SC", "MiSans", "Source Han Sans SC", "Noto Sans CJK SC",
             "Microsoft YaHei UI", "Microsoft YaHei", Roboto, Arial, sans-serif;
  --fw-regular:  400;
  --fw-medium:   500;
  --fw-semibold: 600;
  --fw-bold:     700;
  --panel-shadow: 0 2px 1px rgba(255,255,255,0.25), inset 0 2px 2px rgba(0,0,0,0.1);
  --rail-w: 60px;
  --sb-w:   270px;
  --rail-avatar: 41px;
  --rail-gap: 10px;
  --rail-icon: 22px;
  --ib-gap: 10px;
  --ib-plug: 47px;
  --ib-left: 10px;
  --ib-bottom: 10px;
  --ib-right: calc(var(--ib-gap) * 3 + var(--ib-plug) * 2);
}
```


---

## 2. 关键结构


### 2.1 工作台外框 .frame（含窗口控件、分割线）

```html
<div class="frame" role="application" aria-label="工作台 Frame74" data-region="workbench-window" data-page-node-id="Nc7JU71NAoDFj6OqZPdOSK">
      <!-- Round 166++++：分割线（独立元素，永远可见，不被 layers-hidden 隐藏）
           圆角半径 R=10 → 竖直边须从 y=30+R=40 起、水平边须从 x=59+R=69 起，
           才能与圆角外弧的两个端点 (59,40)/(69,30) 严格对齐（此前 div1 top=47 / div3 left=77 各留了 7px 断口）
           · div1  x=59  y=40..870   ：col2/col3 区域左边界（起点 = 圆角左端点 y=40）
           · div2  x=339 y=30..870   ：第二列 | 第三列
           · div3  横向 y=30 x=69..1300：col2/col3 区域顶边界（起点 = 圆角顶端点 x=69）
           · corner 10×10 @59,30     ：左上角 10px 内圆角（border-top+left，外弧 (59,40)→(69,30)） -->
      <div class="col-divider" style="left:59px; top:40px; height:830px" data-page-node-id="div1"></div>
      <div class="col-divider" style="left:339px; top:30px; height:840px" data-page-node-id="div2"></div>
      <div class="col-divider h" style="left:69px; top:30px; width:1231px; height:2px" data-page-node-id="div3"></div>
      <div class="col-divider corner" style="left:59px; top:30px" data-page-node-id="div-corner"></div>
      <!-- Round 166：顶栏右上角 Windows 风格窗口控件（缩小 / 放大 / 关闭） -->
      <div class="win-controls" data-page-node-id="win-ctrl">
        <button class="win-btn min" type="button" aria-label="最小化" data-page-node-id="wmin">
          <svg viewBox="0 0 11 11" aria-hidden="true"><path d="M1 5.5h9" stroke="currentColor" stroke-width="1"/></svg>
        </button>
        <button class="win-btn max" type="button" aria-label="最大化" data-page-node-id="wmax">
          <svg viewBox="0 0 11 11" aria-hidden="true"><rect x="1.5" y="1.5" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1"/></svg>
        </button>
        <button class="win-btn close" type="button" aria-label="关闭" data-page-node-id="wclose">
          <svg viewBox="0 0 11 11" aria-hidden="true"><path d="M2 2l7 7M9 2l-7 7" stroke="currentColor" stroke-width="1"/></svg>
        </button>
      </div>
      <!-- 2. 侧栏面板 -->
      <aside class="sidebar" data-region="sidebar" data-page-node-id="IaPE12rmFADkvNrblHfUTP">
        <!-- 好友联系人：纯列表（Round 34 比例精修）；内容由 JS 渲染 -->
        <div class="contact-list" id="contactList" data-region="contact-list" data-page-node-id="YQPA9mwLQuBnr8rV7bDfSt"></div>
      </aside>
      <!-- 2↔3 列 可拖动分隔条（自动伸缩） -->
      <div class="splitter" data-region="splitter" role="separator" tabindex="0" aria-orientation="vertical" aria-label="拖动调整侧栏宽度（双击复位默认宽度，方向键微调）" aria-valuemin="265" aria-valuemax="300" aria-valuenow="270" data-page-node-id="O13knv44B5M5F8Am6s3E5D"></div>
      <!-- 3. 左侧玻璃栏 -->
      <nav class="rail" data-region=
```


### 2.2 列1 侧栏 .sidebar + .contact-list

```html
<aside class="sidebar" data-region="sidebar" data-page-node-id="IaPE12rmFADkvNrblHfUTP">
        <!-- 好友联系人：纯列表（Round 34 比例精修）；内容由 JS 渲染 -->
        <div class="contact-list" id="contactList" data-region="contact-list" data-page-node-id="YQPA9mwLQuBnr8rV7bDfSt"></div>
      </aside>
      <!-- 2↔3 列 可拖动分隔条（自动伸缩） -->
      <div class="splitter" data-region="splitter" role="separator" tabindex="0" a
```


### 2.3 列0 导航 .rail

注意：原型里这个 `<nav>` 是**空的**，图标由 JS 注入（见第 4 节）。

```html
<nav class="rail" data-region="nav-rail" aria-label="主导航" data-page-node-id="uCVCjmekreXTX580t3wx0S"></nav>

      <!-- 主区（第三列，随分隔条自动伸缩） -->
      <div class="main-area" data-region="main-area" data-p
```


### 2.4 主区 .main-area + .top-area

```html
<div class="main-area" data-region="main-area" data-page-node-id="Jqp6ZYx5jib0oWhb6w8KrR">
      <!-- 顶部预留插件区：56px 空白，未来放功能插件；当前不覆盖任何内容 -->
      <div class="top-area" aria-hidden="true" data-page-node-id="iDtqL9WqzSwITTBKZFwB8c"></div>
      <!-- Round 57：删除左上角关闭按钮（一团 ×），不再需要 -->


      <!-- 底部输入栏
```


### 2.5 输入栏 .inputbar（attach 按钮 + 弹层开头）

```html
<div class="inputbar" data-region="inputbar" data-state="empty" data-page-node-id="lVnKGxjcriEYOFEByYbnwk">
        <button class="inputbar-btn attach" data-act="attach" aria-label="附件 / 工具" data-page-node-id="D3Y1WFBH6x8NrbGe6jNSSe">
          <span class="plus" aria-hidden="true" data-page-node-id="1YaihrPByWUfQrqSvQo9CP"></span>
        </button>
        <!-- ＋ 弹层（Round 56）：从输入框上方展开，5 行 工具选项（无右侧 icon） -->
        <div class="attach-popup" id="attachPopup" aria-label="工具列表" data-page-node-id="yzKJ6iuqFMbbbw2jnTkWUh">
          <button class="item" data-tool="upload" data-page-node-id="0EcApYhI2xNyewU8aHkKdp">
            <span class="ico" data-page-node-id="NIwHP4BcGG0bOR7lTrqmuI"><svg vie
```


### 2.6 富输入 .composer + 语音/发送按钮

```html
<div class="composer" id="composer" data-page-node-id="zWjhj1crgExRSgznz351Si">
          <div class="composer-tray" id="composerTray" aria-label="附件与上下文"></div>
          <div class="inputbar-field" id="composerField" contenteditable="true" role="textbox" aria-multiline="true" aria-label="输入消息" data-placeholder="需要我做些什么" spellcheck="false"></div>
        </div>
        <!-- Round 186：@Agent / 斜杠命令弹层（材质同 attach-popup） -->
        <div class="composer-pop" id="composerPop" aria-hidden="true"></div>
        <!-- Round 186：隐藏文件选择器（多选：文档 / 图片 / 压缩包 / 代码） -->
        <input type="file" id="composerFile" multiple hidden aria-hidden="true" tabindex="-1"
               accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.zip,.7z,.rar,.js,.ts,.py,.json,.html,.css,.csv,image/*"/>
        <button class="inputbar-btn voice" data-act="voice" aria-label="语音输入" data-page-node-id="zLh7DiGB6TY52m2Rv0XaJl">
          <!-- Round 111：小语音按钮（左），1:1 复刻参考图，麦克风 icon 18×24 -->
          <svg class="voice-ico" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-page-node-id="PAkV3xb0kDEl588qDJEAA0">
            <rect x="9" y="3" width="6" height="11" rx="3" data-page-node-id="V0DLCdo0xp1sqYFLUyUXuS"/>
            <path d="M12 17v4" data-page-node-id="VFRkxff3BvjwSAhLP7MMZH"/>
            <path d="M6 11a6 6 0 0 0 12 0" data-page-node-id="mp3Bb70zY4DBPfalSiN9bv"/>
          </svg>
        </button>
        <button class="inputbar-btn send" data-act="send" aria-label="发送" data-page-node-id="XG1UnSGUOGduXEMrhmKwGi">
          <!-- Round 103：1:1 复刻 Group 10.svg 的圆圈（42×42 r=21 white 0.3 + 内部 sparkle 原生坐标 640 15 24 24） -->
          <svg class="send-sparkle" viewBox="640 15 24 24" fill="none" stroke="#FFFFFF" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-page-node-id="Rg0cnbO2H171QxCe1dQ1Em">
            <path d="M652 17V37M647 23.25V30.75M66
```


---

## 3. 关键 CSS 规则


### 3.1 .frame（工作台窗口：尺寸/圆角/玻璃/描边）

```css
.frame {
  position:absolute;
  left:70px;
  top:15px;
  /* Frame 25：面 1300×870 居中于 1440×900：(1440-1300)/2=70, (900-870)/2=15（描边向外扩 4px 后视觉外框 66/11 起 1308×878） */
  width:var(--frame-w);
  height:var(--frame-h);
  box-sizing:border-box;
  /* Round 174：尺寸由 --frame-w/--frame-h 驱动（默认 1300×870） */
  display:flex;
  flex-direction:row;
  align-items:flex-start;
  padding:0;
  /* Frame 25：auto layout */
  border-radius:20px;
  /* Round 166+++++++++：工作台外圆角 25 → 20 */
  overflow:hidden;
  opacity:1;
  background:linear-gradient(107.76deg, rgba(167,167,167,0.1) -1.16%, rgba(133,133,133,0.05) 100%);
  /* Round 166++++++++++++++++++++++：外侧描边改用独立 .frame-ring 的真实 border（outline 在圆角处有缝隙）*/
  -webkit-backdrop-filter:blur(80px);
  backdrop-filter:blur(80px);
  cursor:default;
  /* Round 166+++++++++++++++++++++：工作台投影 —— 常规桌面客户端窗口阴影（玻璃面板自身投在桌面上，不加任何图层） */
  box-shadow: 0 14px 36px rgba(0,0,0,0.32), 0 3px 10px rgba(0,0,0,0.20);
}
```
```css
.frame::before {
  content:'';
  position:absolute;
  inset:0;
  border-radius:20px;
  background:var(--frame-wp) center/cover no-repeat;
  z-index:0;
  pointer-events:none;
}
```
```css
.frame::after {
  content:'';
  position:absolute;
  inset:0;
  border-radius:20px;
  /* 与工作台外圆角一致 */
  background:var(--glass-bg);
  /* Round 180：玻璃层随主题切换（令牌见 :root --glass-bg） */
  -webkit-backdrop-filter:blur(40px) saturate(var(--wp-sat));
  backdrop-filter:blur(40px) saturate(var(--wp-sat));
  z-index:1;
  pointer-events:none;
}
```
```css
.frame-ring {
  position:absolute;
  left:66px;
  top:11px;
  width:calc(var(--frame-w) + 8px);
  height:calc(var(--frame-h) + 8px);
  box-sizing:border-box;
  border:4px solid var(--ring-stroke);
  border-radius:24px;
  /* Round 180：白 55% → 主题令牌（黑 15% / 白 18%） */
  pointer-events:none;
  z-index:6;
}
```
```css
.frame.dragging {
  cursor:default;
}
```
```css
.frame.animating .main-area {
  transition: width .22s ease, left .22s ease, opacity .22s ease;
  /* Round 186：.35s → .22s */
  will-change: width, left;
  /* Round 191：agent↔icon 切换时把大模糊面（sidebar / main-area）提层，消除 backdrop-filter 重算卡顿（头上明显卡顿根因） */;
}
```
```css
.frame.animating .splitter {
  transition: left .35s ease, opacity .35s ease;
}
```
```css
.frame.animating .add-btn {
  transition: opacity .35s ease;
}
```
```css
.frame.collapsed .add-btn {
  opacity:0;
  pointer-events:none;
}
```
```css
.frame.collapsed .splitter {
  opacity:0;
  pointer-events:none;
}
```
```css
.frame.resizing .main-area {
  will-change:width,left;
}
```
```css
.frame.resizing .add-btn {
  transition:none !important;
}
```
```css
.frame:not(.agent) .tab.tab-msg {
  top:72px;
}
```
```css
.frame.collapsed .menu-btn .drawer-ico {
  display:block;
}
```
```css
.frame-drag-area {
  position:absolute;
  left:70px;
  top:0;
  width:var(--frame-w);
  height:15px;
  z-index:999;
  /* Round 161：底座外框上方 12px 拖动条（不与之重叠） */
  cursor:default;
  /* Round 125g：删除抓手（grab）→ 普通鼠标指针 */
  touch-action:none;
  user-select:none;
}
```
```css
.frame-drag-area.dragging {
  cursor:default;
}
```
```css
.frame {
  touch-action:none;
  /* Round 125i：恢复 user-select:none —— 拖动工作台 / 拖动滚动时不再误选文字。
     消息正文仍可复制：.ai-seg-text 与 .message.user .message-bubble 各自带 user-select:text
     （user-select 可被子元素显式覆盖），所以「能复制正文」与「拖动不误选」两者兼得。 */
  -webkit-user-select:none;
  user-select:none;
}
```
```css
.frame.collapsed .search-pill.search-component {
  opacity:0;
  pointer-events:none;
}
```
```css
.frame.agent .agent-list {
  display:flex;
}
```
```css
.frame.agent .tab {
  opacity:0;
  pointer-events:none;
}
```
```css
.frame.agent .hamburger {
  opacity:0;
  pointer-events:none;
}
```
```css
.frame.agent .add-popup {
  opacity:0;
  pointer-events:none;
}
```
```css
.frame.agent .splitter {
  opacity:0;
  pointer-events:none;
}
```
```css
.frame.agent .sidebar {
  width:0 !important;
  opacity:0;
}
```
```css
.frame.agent .main-area {
  left:var(--rail-w) !important;
  width:calc(var(--frame-w) - var(--rail-w)) !important;
}
```
```css
.frame.agent .inputbar {
  left:50%;
  right:auto;
  width:calc(var(--frame-w) - var(--rail-w) - var(--sb-w) - var(--ib-left) - var(--ib-right));
  /* Round 193：默认宽 = 第三列宽 − 左留白 − 右让位（agent 与默认同宽居中） */
  transform:translateX(-50%);
}
```
```css
.frame.agent .plug-outside {
  left:calc(50% + (var(--frame-w) - var(--rail-w) - var(--sb-w) - var(--ib-left) - var(--ib-right)) / 2 + var(--ib-gap));
  right:auto;
}
```
```css
.frame.entering .agent-chip:nth-of-type(1) {
  animation: chipSpring .26s .000s cubic-bezier(.22,.8,.24,1) both;
}
```
```css
.frame.entering .agent-chip:nth-of-type(2) {
  animation: chipSpring .26s .030s cubic-bezier(.22,.8,.24,1) both;
}
```
```css
.frame.entering .agent-chip:nth-of-type(3) {
  animation: chipSpring .26s .060s cubic-bezier(.22,.8,.24,1) both;
}
```
```css
.frame.entering .agent-chip:nth-of-type(4) {
  animation: chipSpring .26s .090s cubic-bezier(.22,.8,.24,1) both;
}
```
```css
.frame.entering .agent-chip:nth-of-type(5) {
  animation: chipSpring .26s .120s cubic-bezier(.22,.8,.24,1) both;
}
```
```css
.frame.entering .agent-chip:nth-of-type(n+6) {
  animation: chipSpring .26s .150s cubic-bezier(.22,.8,.24,1) both;
}
```
```css
.frame.entering .rail-quick-add {
  animation: chipSpring .26s .180s cubic-bezier(.22,.8,.24,1) both;
}
```
```css
.frame.entering .tab-msg {
  animation: tabRetract .20s .000s cubic-bezier(.4,0,.6,1) both;
}
```
```css
.frame.entering .rail-kb {
  animation: tabRetract .20s .000s cubic-bezier(.4,0,.6,1) both;
}
```
```css
.frame.leaving .agent-chip:nth-of-type(1) {
  animation: chipRetract .16s .000s cubic-bezier(.4,0,.6,1) both;
}
```
```css
.frame.leaving .agent-chip:nth-of-type(2) {
  animation: chipRetract .16s .030s cubic-bezier(.4,0,.6,1) both;
}
```
```css
.frame.leaving .agent-chip:nth-of-type(3) {
  animation: chipRetract .16s .060s cubic-bezier(.4,0,.6,1) both;
}
```
```css
.frame.leaving .agent-chip:nth-of-type(4) {
  animation: chipRetract .16s .090s cubic-bezier(.4,0,.6,1) both;
}
```


### 3.2 .rail（列0 导航：60px）

```css
body.layers-hidden .frame > *:not(.col-divider):not(.win-controls):not(.rail):not(.menu-btn):not(.tab):not(.hamburger):not(.agent-list):not(.rail-agents):not(.sidebar):not(.splitter):not(.search-pill):not(.add-btn):not(.main-area):not(.rail-logo):not(.rail-kb):not(.kb-view):not(.rs):not(.agent-create) {
  visibility:hidden !important;
}
```
```css
.rail {
  position:absolute;
  left:0;
  top:0;
  width:var(--rail-w);
  height:var(--frame-h);
  z-index:4;
  border-radius:20px 0 0 20px;
  /* Round 166+++++++++：随工作台外圆角 20 */
  /* Round 182：第一列 = #1f1f1f 纯色面板（比第二列... 用户要求两列同色、无分隔线） */
  background:var(--col-rail);
  border-right:0;
  /* 第二列不要描边 → 第一/二列之间不再画线，两列同色无缝 */
  -webkit-backdrop-filter:blur(10px) saturate(120%);
  backdrop-filter:blur(10px) saturate(120%);
  /* Frame 42：backdrop-filter blur(30) */;
}
```
```css
.rail-quick-add {
  position:relative;
  flex:0 0 var(--rail-avatar);
  width:var(--rail-avatar);
  height:var(--rail-avatar);
  box-sizing:border-box;
  border-radius:10px;
  /* Round 192：8 → 10；Round 129：与 menu-btn / agent-chip 同 42 → 38 */
  background:rgba(255,255,255,0.10);
  border:2px solid rgba(255,255,255,0.55);
  cursor:pointer;
  padding:0;
  z-index:4;
  display:grid;
  place-items:center;
  transition:transform .12s ease, background .15s ease;
}
```
```css
.rail-quick-add .qadd-v {
  position:absolute;
  left:50%;
  top:50%;
  background:rgba(255,255,255,0.92);
  border-radius:2px;
  transform:translate(-50%,-50%);
}
```
```css
.rail-quick-add .qadd-h {
  width:13px;
  height:3px;
}
```
```css
.rail-quick-add .qadd-v {
  width:3px;
  height:13px;
}
```
```css
.rail-quick-add:hover {
  background:rgba(255,255,255,0.18);
}
```
```css
.rail-quick-add:active {
  transform:scale(0.98);
}
```
```css
.menu-btn,.agent-chip,.rail-quick-add,.search-pill,.tab {
  z-index:7;
}
```
```css
.frame.entering .rail-quick-add {
  animation: chipSpring .26s .180s cubic-bezier(.22,.8,.24,1) both;
}
```
```css
.frame.entering .rail-kb {
  animation: tabRetract .20s .000s cubic-bezier(.4,0,.6,1) both;
}
```
```css
.frame.leaving .rail-quick-add {
  animation: chipRetract .16s .180s cubic-bezier(.4,0,.6,1) both;
}
```
```css
.frame.leaving .rail-kb {
  animation: tabEmerge .24s .140s cubic-bezier(.22,.8,.24,1) both;
}
```
```css
.frame .tab, .frame .rail-kb {
  width:var(--rail-avatar) !important;
  height:var(--rail-avatar) !important;
}
```
```css
.frame .tab::before, .frame .rail-kb::before {
  width:var(--rail-avatar) !important;
  height:var(--rail-avatar) !important;
  border-radius:10px;
  background:var(--icon-hover) !important;
}
```
```css
.frame.entering .tab, .frame.entering .rail-kb {
  opacity:1 !important;
  pointer-events:auto !important;
  transition:none !important;
  animation:none !important;
}
```
```css
.rail-kb {
  position:absolute;
  top:116px;
  left:calc((var(--rail-w) - 34px) / 2);
  width:34px;
  height:34px;
  background-color:transparent;
  border:0;
  padding:0;
  cursor:pointer;
  z-index:7;
  background-image:url('data:image/png;
  base64,iVBORw0KGgoAAAANSUhEUgAAACsAAAAnCAYAAACWn7G7AAAACXBIWXMAABYlAAAWJQFJUiTwAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAOdEVYdFNvZnR3YXJlAEZpZ21hnrGWYwAAAPlJREFUeAHtmNENgkAMhnvGARyBDRxBnETcwA10BJ1A3cANdASdQDaQDWqb+EDgHjT0x7ukX9KENAG+48rlesTMC4kXD2dLaOQlT7YDK8z24IQZA0Q46JM7uY3Eg75nJVFF8jey4xRCOMe+bEk/IvccGc9iQgbIqNc6esJSmsgqYwhPyRAVlum6y+WMhlNJFO2Eqawiwgcy4PPvFO2cWRmMQVaysTKYR9bef9Cr+5jsnhLFaxZF9rLLkAAU2Qh5GaBwWRQui8JlUbgsCpdF4bIoXBZFrGG8ptHc9smuDBrKg0Zld5Q+tcRFGzM9BCuocwiWEDrztfSQzRuShOS/2nytrQAAAABJRU5ErkJggg==');
  background-size:22px 20px;
  background-repeat:no-repeat;
  background-position:center;
  transition: opacity .28s ease, transform .35s ease;
}
```
```css
.rail-kb::after {
  content:"";
  position:absolute;
  inset:0;
  pointer-events:none;
  background-image:url('data:image/png;
  base64,iVBORw0KGgoAAAANSUhEUgAAACsAAAAnCAYAAACWn7G7AAAACXBIWXMAABYlAAAWJQFJUiTwAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAOdEVYdFNvZnR3YXJlAEZpZ21hnrGWYwAAAJlJREFUeAHt2NEJwzAMhOFT6SDZpN2sGaXdoCNkk3iDeANFmiE6iOA+MMlT8oPB2Ia7v2Icft0HbPGT3etwg70eL9g5KMGWXwbHhjpfM/sxY6u9H+ijVSwUy6JYlidq10OmAZFmOu0NVq2zLIplUSyLYlkUy6JYFsWyKJZFsSwZO9HDzNgV9zdi/C3f4sy4xGPBPeXMj7j5nifTYV6c9c7f5QAAAABJRU5ErkJggg==');
  background-size:22px 20px;
  background-repeat:no-repeat;
  background-position:center;
  opacity:0;
  transition:opacity .3s ease;
}
```
```css
.rail-kb::before {
  content:"";
  position:absolute;
  z-index:-1;
  left:50%;
  top:50%;
  transform:translate(-50%,-50%);
  width:42px;
  height:42px;
  border-radius:14px;
  background:var(--icon-hover);
  opacity:0;
  transition:opacity .2s ease;
  pointer-events:none;
}
```
```css
.rail-kb:hover::before {
  opacity:1;
}
```
```css
.rail-kb.active {
  transform: scale(1.02);
}
```
```css
.rail-kb.active::after {
  opacity:1;
}
```
```css
:root[data-theme="white"] .rail-kb {
  filter: brightness(0);
}
```
```css
:root[data-theme="white"] .rail-kb:hover {
  filter: brightness(0.2);
}
```
```css
.frame.agent .rail-kb {
  opacity:0;
  pointer-events:none;
}
```
```css
.frame .tab, .frame .rail-kb {
  left: calc((var(--rail-w) - var(--rail-avatar)) / 2) !important;
}
```
```css
.frame.entering .tab, .frame.entering .rail-kb {
  opacity:0 !important;
  pointer-events:none !important;
}
```
```css
.frame.leaving .tab, .frame.leaving .rail-kb {
  opacity:1 !important;
  pointer-events:auto !important;
  transition:none !important;
  animation:none !important;
}
```
```css
.rail-agents {
  position:absolute;
  left:0;
  bottom:24px;
  width:var(--rail-w);
  top:calc(14px + var(--rail-avatar) + var(--rail-gap) - 8px);
  display:none;
  flex-direction:column;
  align-items:center;
  gap:var(--rail-gap);
  z-index:7;
  overflow-y:auto;
  overflow-x:hidden;
  padding:8px 0;
}
```
```css
.rail-agents::-webkit-scrollbar {
  width:0;
  height:0;
}
```
```css
.frame.agent.rail-agents-mode .agent-list {
  display:none !important;
}
```
```css
.frame.agent.rail-agents-mode .rail-agents {
  display:flex !important;
}
```
```css
.rail-agent-tile {
  position:relative;
  flex:0 0 auto;
  width:var(--rail-avatar);
  height:var(--rail-avatar);
  border-radius:10px;
  border:0;
  cursor:pointer;
  box-sizing:border-box;
  background-color: color-mix(in srgb, var(--c1,#7c5cff) 16%, #ffffff);
  background-image:var(--av);
  background-size:contain;
  background-position:center;
  background-repeat:no-repeat;
  color:#fff;
  font-weight:var(--fw-medium);
  font-size:17px;
  line-height:1;
  font-family:inherit;
  display:grid;
  place-items:center;
  transition:transform .25s cubic-bezier(.22,.8,.24,1), filter .25s ease, box-shadow .25s ease;
}
```
```css
.rail-agent-tile.has-photo {
  color:transparent;
}
```
```css
.rail-agent-tile:hover {
  transform:scale(1.02);
  filter:brightness(1.05);
}
```
```css
.rail-agent-tile.is-active {
  transform:scale(1.04);
  outline:2.5px solid var(--chip-ring,#fff);
  outline-offset:3px;
}
```
```css
.rail-agent-add {
  position:relative;
  flex:0 0 var(--rail-avatar);
  width:var(--rail-avatar);
  height:var(--rail-avatar);
  box-sizing:border-box;
  border-radius:10px;
  background:rgba(255,255,255,0.10);
  border:2px solid rgba(255,255,255,0.55);
  cursor:pointer;
  padding:0;
  z-index:4;
  display:grid;
  place-items:center;
  transition:transform .12s ease, background .15s ease;
}
```
```css
.rail-agent-add:hover {
  background:rgba(255,255,255,0.18);
}
```
```css
.rail-agent-add:active {
  transform:scale(0.98);
}
```
```css
.rail-agent-add i {
  position:absolute;
  left:50%;
  top:50%;
  background:rgba(255,255,255,0.92);
  border-radius:2px;
  transform:translate(-50%,-50%);
}
```


### 3.3 .sidebar（列1：280px）

```css
.sidebar {
  position:absolute;
  left:var(--rail-w);
  top:0;
  width:var(--sb-w);
  height:var(--frame-h);
  z-index:5;
  /* Round 180：第二列 = 传统黑/白主题面板（比第一列稍亮 → 层次感：顶缘高光 + 左缘细分隔） */
  background:var(--col-sidebar);
  -webkit-backdrop-filter:blur(14px) saturate(128%);
  backdrop-filter:blur(14px) saturate(128%);
  box-shadow:none;
  /* Round 182：第二列不要描边 → 去掉顶缘内高光，列间不再画线 */;
}
```
```css
.sidebar {
  box-shadow:-1px 0 0 0 var(--col-sidebar-solid) !important;
}
```


### 3.4 .contact-list / .contact-item（联系人卡）

```css
.contact-list {
  /* Round 63：回滚 Round 62 的「选中态 translateY(-2px)」——那不是要的设计。
     用户本意 = **整个联系人列表**向上移动一点点（不是选中项单独浮起）。
     top:64 → 56（上移 8px），首条到搜索框间距 18 → 10 */
  position:absolute;
  left:0;
  right:0;
  top:52px;
  bottom:0;
  /* Round 166++++++++++++++++++++++++：56 → 52（上移一点；搜索框底 48 + 4px 间隙，不越过搜索框） */
  display:flex;
  flex-direction:column;
  padding:2px 0;
  overflow-y:auto;
  overflow-x:hidden;
}
```
```css
.contact-list::-webkit-scrollbar {
  width:6px;
}
```
```css
.contact-list::-webkit-scrollbar-track {
  background:transparent;
}
```
```css
.contact-list::-webkit-scrollbar-thumb {
  background:transparent;
  border-radius:3px;
  transition:background .25s ease;
}
```
```css
.contact-list.scrolling::-webkit-scrollbar-thumb {
  background:rgba(0,0,0,0.34);
}
```
```css
.contact-list.scrolling::-webkit-scrollbar-thumb:hover {
  background:rgba(0,0,0,0.48);
}
```
```css
.contact-item {
  position:relative;
  /* 分隔线 ::before 的定位父级 */
  display:flex;
  align-items:center;
  gap:11px;
  height:56px;
  margin:2px 4px 2px 2px;
  padding:0 12px 0 8px;
  /* Round 166++++++++++++++++++++++++：行高 60 → 56 */
  border:0;
  box-sizing:border-box;
  font-family:inherit;
  text-align:left;
  /* <button> 复位 */
  border-radius:14px;
  cursor:pointer;
  background:transparent;
  flex:0 0 auto;
  /* Round 137：联系人交互升级 —— 背景/位移/头像外环统一过渡；点击有微缩反馈 */
  transition:background .18s ease, transform .12s ease;
}
```
```css
.contact-list .contact-item {
  animation: contactEnter .22s ease-out backwards;
  /* Round 186：.32s → .22s，去掉强调曲线 */;
}
```
```css
.contact-list .contact-item:nth-child(1) {
  animation-delay: 0ms;
}
```
```css
.contact-list .contact-item:nth-child(2) {
  animation-delay: 30ms;
}
```
```css
.contact-list .contact-item:nth-child(3) {
  animation-delay: 60ms;
}
```
```css
.contact-list .contact-item:nth-child(4) {
  animation-delay: 90ms;
}
```
```css
.contact-list .contact-item:nth-child(5) {
  animation-delay: 120ms;
}
```
```css
.contact-list .contact-item:nth-child(6) {
  animation-delay: 150ms;
}
```
```css
.contact-list .contact-item:nth-child(7) {
  animation-delay: 180ms;
}
```
```css
.contact-list .contact-item:nth-child(8) {
  animation-delay: 210ms;
}
```
```css
.contact-item:hover {
  background:var(--row-hover);
}
```
```css
.contact-item:hover .contact-name {
  color:var(--txt-primary);
}
```
```css
.contact-item:hover .contact-msg {
  color:var(--txt-secondary);
}
```
```css
.contact-item:hover .contact-avatar {
  filter:brightness(1.08);
}
```
```css
.contact-item:active {
  transform:scale(0.995);
}
```
```css
.contact-item.active {
  background:var(--row-active);
  /* Round 182：选中 = 深灰卡色，去描边 */;
}
```
```css
.contact-item.active .contact-name {
  color:var(--txt-primary);
}
```
```css
.contact-item.active .contact-msg {
  color:var(--txt-secondary);
}
```
```css
.contact-item + .contact-item::before {
  content:'';
  position:absolute;
  left:14px;
  right:14px;
  top:-2px;
  height:1px;
  background:linear-gradient(90deg,
    transparent 0%, var(--hairline) 14%, var(--hairline) 86%, transparent 100%);
  pointer-events:none;
}
```
```css
.contact-item.just-added + .contact-item::before {
  opacity:0;
}
```
```css
.contact-item.just-added {
  animation:justAddedPulse .45s ease-out;
}
```
```css
.contact-avatar {
  position:relative;
  flex:0 0 41px;
  /* Round 192b：flex-basis 42 → 41（与 width 同步，否则渲染宽被 basis 覆盖成 42） */
  width:41px;
  height:41px;
  border-radius:10px;
  overflow:visible;
  flex-shrink:0;
  /* Round 192b：42 → 41（与智能体头像统一 41） */  /* Round 166++++++++++++++++++++++++：44 → 42 */  /* Round 107：方形 r11 + 白底，星标头像成为独立方块（星星底色改白） */
  /* Round 108：淡底+彩星 —— 背景取品牌色 c1 的浅淡底（约 16%），彩色星形头像铺在上面，色差突出星星（背景不重设计） */
  background-color: color-mix(in srgb, var(--c1) 16%, #ffffff);
  background-image:var(--av, none);
  background-size:contain;
  background-position:center;
  background-repeat:no-repeat;
  color: color-mix(in srgb, var(--c1) 70%, #1a1a22);
  font-weight:var(--fw-medium);
  font-size:15px;
  line-height:1;
  font-family:inherit;
  display:grid;
  place-items:center;
  /* Round 138：头像仅保留 brightness 过渡（hover 提亮）；白外环已移除 */
  transition:filter .18s ease;
}
```
```css
.contact-avatar.has-photo {
  color:transparent;
}
```
```css
.contact-avatar::after {
  content:'';
  position:absolute;
  top:-1px;
  right:-1px;
  width:8px;
  height:8px;
  border-radius:50%;
  /* Round 190：7 → 8（微信来消息那种，再大一点点但不过分） */
  background:#FA5151;
  box-shadow:0 0 0 1.5px var(--col-sidebar);
  /* 列底色细环，让红点与头像边缘「脱开」不糊边 */
  pointer-events:none;
  z-index:2;
}
```
```css
.contact-item.read .contact-avatar::after {
  display:none;
}
```
```css
.contact-name {
  flex:1 1 auto;
  min-width:0;
  font-size:16px;
  font-weight:var(--fw-semibold);
  color:var(--txt-primary);
  /* Round 166++++++++++++++++++++++++：16 → 15 */  /* Round 189：15 → 16（头部文字略放大） */
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
  letter-spacing:0;
  /* 中文标题不加字间距，加了会散、发虚 → AI 感来源之一 */
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
}
```
```css
.contact-memory-wrap {
  position:absolute;
  right:12px;
  top:31px;
  width:20px;
  height:20px;
  display:grid;
  place-items:center;
  opacity:0;
  visibility:hidden;
  transition:opacity .18s ease, visibility .18s ease;
}
```
```css
.contact-memory {
  width:18px;
  height:18px;
  border-radius:50%;
  position:relative;
  display:grid;
  place-items:center;
}
```
```css
.contact-memory svg {
  width:18px;
  height:18px;
  display:block;
  transform:rotate(-90deg);
  /* 进度从正上方起算 */
  transition:opacity .28s ease, transform .28s ease;
}
```
```css
.contact-item.running .contact-memory-wrap {
  opacity:1;
  visibility:visible;
}
```
```css
.contact-item .contact-memory.done svg {
  opacity:0;
  transform:rotate(-90deg) scale(.72);
}
```
```css
.contact-item .contact-memory.done::after {
  content:'';
  position:absolute;
  left:50%;
  top:50%;
  width:6px;
  height:6px;
  border-radius:50%;
  background:rgba(255,255,255,1);
  animation:memDotIn .34s cubic-bezier(.22,.8,.24,1) both;
}
```
```css
.contact-item .contact-memory.done {
  cursor:pointer;
}
```
```css
list.querySelectorAll('.contact-item').forEach(function(o) {
  o.classList.remove('active','just-added');
}
```
```css
'.contact-item.is-hen .contact-name::after {
  ' +
    'content:"母";
  display:inline-block;
  margin-left:6px;
  padding:0 5px;
  ' +
    'font-size:10px;
  line-height:15px;
  border-radius:4px;
  vertical-align:1px;
  ' +
    'background:var(--icon-hover);
  color:var(--txt-primary);
  font-weight:var(--fw-medium);
}
```
```css
'.contact-item.is-hen {
}
```


### 3.5 .main-area / .top-area

```css
body.layers-hidden .frame > *:not(.col-divider):not(.win-controls):not(.rail):not(.menu-btn):not(.tab):not(.hamburger):not(.agent-list):not(.rail-agents):not(.sidebar):not(.splitter):not(.search-pill):not(.add-btn):not(.main-area):not(.rail-logo):not(.rail-kb):not(.kb-view):not(.rs):not(.agent-create) {
  visibility:hidden !important;
}
```
```css
.main-area {
  position:absolute;
  left:calc(var(--rail-w) + var(--sb-w));
  top:0;
  width:calc(var(--frame-w) - var(--rail-w) - var(--sb-w));
  height:var(--frame-h);
  z-index:5;
  background:var(--col-main);
  /* Round 182：第三列背景 = #1a1a1a（黑）/ #f6f6f8（白） */;
}
```
```css
.top-area {
  position:absolute;
  left:0;
  top:0;
  right:0;
  height:30px;
  /* Round 166：参考图顶部 30 */
  pointer-events:none;
  z-index:1;
}
```
```css
.frame.animating .main-area {
  transition: width .22s ease, left .22s ease, opacity .22s ease;
  /* Round 186：.35s → .22s */
  will-change: width, left;
  /* Round 191：agent↔icon 切换时把大模糊面（sidebar / main-area）提层，消除 backdrop-filter 重算卡顿（头上明显卡顿根因） */;
}
```
```css
.frame.resizing .main-area {
  will-change:width,left;
}
```
```css
.frame.agent .main-area {
  left:var(--rail-w) !important;
  width:calc(var(--frame-w) - var(--rail-w)) !important;
}
```
```css
.main-area {
  box-shadow:-1px 0 0 0 var(--col-main)          !important;
}
```
```css
.frame.kb-open .main-area {
  left:var(--rail-w) !important;
  width:calc(var(--frame-w) - var(--rail-w)) !important;
}
```
```css
.frame.kb-open .main-area {
  opacity:0;
  pointer-events:none;
}
```
```css
.frame.dual .main-area {
  left:var(--rail-w) !important;
  width:calc(var(--frame-w) - var(--rail-w)) !important;
}
```


### 3.6 .inputbar / .composer（输入区）

```css
.inputbar {
  position:absolute;
  left:var(--ib-left);
  right:var(--ib-right);
  bottom:var(--ib-bottom);
  height:47px;
  /* Round 193：左/右/底三处走令牌；右让位 = 3×gap + 2×圆 = 130（栏→圆① 与圆间距、圆→右缘 三者统一 12） */
  display:flex;
  align-items:center;
  padding:0 8px;
  /* 实测 pill 缘→左圆 8px，右圆→pill 缘 8px */
  background:var(--input-bg);
  /* Round 180：白 15%（黑）/ 黑 8%（白） */
  -webkit-backdrop-filter:blur(8px) saturate(120%);
  backdrop-filter:blur(8px) saturate(120%);
  box-shadow:none;
  /* Round 187：输入框描边（外发光 + 顶缘 inset 高光）整条删除 */
  border-radius:50px;
  z-index:2;
}
```
```css
.inputbar-btn.attach {
  flex:0 0 31px;
  width:31px;
  height:31px;
  background:transparent;
  border-radius:15.5px;
  /* Round 37：默认无背景，悬停时显示圆底 */
  border:0;
  cursor:pointer;
  padding:0;
  display:grid;
  place-items:center;
  transition:background .15s ease;
}
```
```css
.inputbar-btn.attach:hover {
  background:rgba(255,255,255,0.2);
}
```
```css
.inputbar-btn.attach .plus {
  position:relative;
  width:16px;
  height:16px;
}
```
```css
.inputbar-btn.attach .plus::after {
  content:'';
  position:absolute;
  left:50%;
  top:50%;
  width:16px;
  height:2.8px;
  margin-left:-8px;
  margin-top:-1.4px;
  background:rgba(255,255,255,0.88);
  border-radius:1.4px;
  transition:transform .2s cubic-bezier(.22,.8,.24,1);
}
```
```css
.inputbar-btn.attach .plus::after {
  transform:rotate(-90deg);
}
```
```css
.inputbar-btn.attach.active .plus::before {
  transform:rotate(45deg);
}
```
```css
.inputbar-btn.attach.active .plus::after {
  transform:rotate(-45deg);
}
```
```css
.inputbar-btn.attach.active {
  background:rgba(255,255,255,0.20);
}
```
```css
.inputbar-btn.send {
  flex:0 0 36px;
  width:36px;
  height:36px;
  margin-left:auto;
  background:rgba(255,255,255,0.3);
  border-radius:18px;
  border:0;
  cursor:pointer;
  padding:0;
  display:grid;
  place-items:center;
  position:relative;
  transition:background .15s ease, transform .15s ease;
}
```
```css
.inputbar-btn.send:hover {
  background:rgba(255,255,255,0.4);
}
```
```css
.inputbar-btn.send:active {
  transform:scale(0.97);
}
```
```css
.inputbar-btn.voice {
  flex:0 0 40px;
  width:40px;
  height:40px;
  margin-right:6px;
  background:transparent;
  border:0;
  cursor:pointer;
  padding:0;
  display:grid;
  place-items:center;
  border-radius:20px;
  transition:background .15s ease, transform .15s ease;
}
```
```css
.inputbar-btn.voice:hover {
  background:rgba(255,255,255,0.2);
}
```
```css
.inputbar-btn.voice:active {
  transform:scale(0.97);
}
```
```css
.inputbar-btn.voice.active {
  background:rgba(255,255,255,0.2);
}
```
```css
.inputbar.voice-active .inputbar-btn.send {
  visibility:hidden;
}
```
```css
.inputbar[data-state="typing"] .send-arrow {
  transform:rotate(-90deg);
}
```
```css
.inputbar[data-state="thinking"] .send-arrow {
  display:none;
}
```
```css
.inputbar[data-state="thinking"] .send-sparkle {
  display:none;
}
```
```css
.inputbar[data-state="thinking"] .send-stop {
  display:block;
}
```
```css
.inputbar[data-state="thinking"] .inputbar-btn.send {
  background:rgba(255,255,255,0.42);
}
```
```css
.inputbar-field {
  /* 高度/行高取 31 = 左「＋」圆直径，配合 .inputbar 的 align-items:center，
     使文字的垂直中心与 ＋ 的中心严格重合（上下居中以 ＋ 的高度和位置为基准） */
  flex:1 1 auto;
  align-self:center;
  min-width:0;
  height:31px;
  margin-left:7px;
  /* ＋ 到文字 7px */
  background:transparent;
  border:0;
  outline:none;
  padding:0;
  font-family:inherit;
  font-style:normal;
  font-weight:var(--fw-medium);
  font-size:17px;
  line-height:31px;
  text-align:left;
  color:rgba(255,255,255,0.92);
  /* Round 185：输入框转黑底 → 文字固定浅色（白主题 --txt-primary 是深色会看不见） */
  -webkit-user-select:text;
  user-select:text;
  /* Round 125i：输入框需显式放行，否则继承 frame 的 none 会选不中 */;
}
```
```css
.inputbar-field::placeholder {
  color:rgba(255,255,255,0.55);
  transition:color .15s ease;
}
```
```css
.inputbar-field:focus::placeholder {
  color:transparent;
}
```
```css
.inputbar {
  height:auto;
  min-height:47px;
  align-items:flex-end;
  padding:8px;
}
```
```css
.inputbar-btn.send {
  margin-top:-2.5px;
  margin-bottom:-2.5px;
}
```
```css
.inputbar-btn.voice {
  margin-top:-4.5px;
  margin-bottom:-4.5px;
}
```
```css
.composer {
  flex:1 1 auto;
  min-width:0;
  align-self:stretch;
  display:flex;
  flex-direction:column;
  justify-content:flex-end;
  gap:6px;
  margin-left:7px;
  max-height:137px;
  overflow-y:auto;
  overflow-x:hidden;
  -webkit-user-select:text;
  user-select:text;
}
```
```css
.inputbar-field {
  flex:none;
  align-self:stretch;
  margin-left:0;
  height:auto;
  min-height:31px;
  overflow-y:visible;
  overflow-x:hidden;
  word-break:break-word;
  white-space:pre-wrap;
  caret-color:rgba(255,255,255,0.92);
}
```
```css
.inputbar-field::before {
  content:'';
}
```
```css
.inputbar-field[data-empty="1"]::before {
  content:attr(data-placeholder);
  color:rgba(255,255,255,0.55);
}
```
```css
.inputbar-field[data-empty="1"]:focus::before {
  content:'';
}
```
```css
.composer-tray {
  display:none;
  flex-wrap:wrap;
  gap:6px;
}
```
```css
.composer-tray.has-items {
  display:flex;
}
```
```css
.inputbar.dropping {
  box-shadow:0px 2px 2px var(--input-glow), inset 0 1px 0 var(--input-edge), inset 0 0 0 1.5px rgba(111,182,255,0.6);
}
```
```css
.inputbar.voice-active .composer-pop {
  visibility:hidden;
}
```
```css
.composer-pop {
  position:absolute;
  left:0;
  bottom:calc(100% + 12px);
  width:min(320px, calc(100% - 12px));
  display:flex;
  flex-direction:column;
  gap:1px;
  padding:6px;
  max-height:230px;
  overflow-y:auto;
  background:rgba(0,0,0,0.2);
  -webkit-backdrop-filter:blur(16px);
  backdrop-filter:blur(16px);
  border-radius:14px;
  opacity:0;
  transform:scale(0.96) translateY(4px);
  pointer-events:none;
  transition:opacity .18s ease, transform .22s cubic-bezier(.22,.8,.24,1);
  z-index:6;
}
```
```css
.composer-pop.open {
  opacity:1;
  transform:none;
  pointer-events:auto;
}
```
```css
.composer-pop .cp-item {
  display:flex;
  align-items:center;
  gap:10px;
  padding:8px 12px;
  border:0;
  border-radius:10px;
  background:transparent;
  cursor:pointer;
  width:100%;
  box-sizing:border-box;
  font-family:inherit;
  text-align:left;
  color:inherit;
}
```
```css
.composer-pop .cp-item.sel {
  background:rgba(255,255,255,0.08);
}
```
```css
.composer-pop .cp-ico {
  width:26px;
  height:26px;
  border-radius:7px;
  flex:none;
  display:grid;
  place-items:center;
  background:rgba(255,255,255,0.10);
  font-size:12px;
  font-weight:var(--fw-semibold);
  color:rgba(255,255,255,0.88);
}
```
```css
.composer-pop .cp-t {
  font-size:13.5px;
  font-weight:var(--fw-medium);
  color:rgba(255,255,255,0.92);
  white-space:nowrap;
}
```
```css
.composer-pop .cp-d {
  font-size:12px;
  color:rgba(255,255,255,0.5);
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
  margin-left:auto;
  padding-left:10px;
}
```
```css
.composer-pop .cp-empty {
  padding:10px 12px;
  font-size:12.5px;
  color:rgba(255,255,255,0.4);
}
```
```css
.frame.agent .inputbar {
  left:50%;
  right:auto;
  width:calc(var(--frame-w) - var(--rail-w) - var(--sb-w) - var(--ib-left) - var(--ib-right));
  /* Round 193：默认宽 = 第三列宽 − 左留白 − 右让位（agent 与默认同宽居中） */
  transform:translateX(-50%);
}
```
```css
.frame.dual .inputbar, .frame.dual .plug-outside {
  opacity:0;
  pointer-events:none;
}
```


### 3.7 .attach-popup（＋弹层）

```css
.attach-popup {
  position:absolute;
  left:0;
  right:0;
  bottom:calc(100% + 12px);
  display:flex;
  flex-direction:column;
  gap:1px;
  padding:6px;
  background:rgba(0,0,0,0.2);
  /* Round 83：与 inputbar 同底 rgba(0,0,0,0.2) */
  -webkit-backdrop-filter:blur(16px);
  backdrop-filter:blur(16px);
  /* Round 57：去掉描边（你说的「直接背景就够了」）；改用 B 站主题切换的径向展开
     从左「＋」按钮中心 (23.5px, 100%+35.5px) 起，scale 0.05 + border-radius 50% 一同
     缓动到 scale 1 + border-radius 14px，配合 1.56 overshoot spring */
  border-radius:50%;
  opacity:0;
  transform:scale(0.85);
  pointer-events:none;
  transform-origin:23.5px calc(100% + 35.5px);
  transition:
    transform .36s cubic-bezier(.22,.8,.24,1),
    border-radius .36s cubic-bezier(.22,.8,.24,1),
    opacity .22s ease;
  z-index:5;
}
```
```css
.attach-popup.open {
  opacity:1;
  transform:scale(1);
  border-radius:14px;
  pointer-events:auto;
}
```
```css
.attach-popup .item {
  display:flex;
  align-items:center;
  gap:12px;
  padding:8px 14px;
  border:0;
  border-radius:10px;
  background:transparent;
  cursor:pointer;
  width:100%;
  box-sizing:border-box;
  font-family:inherit;
  text-align:left;
  color:inherit;
}
```
```css
.attach-popup .item:hover {
  background:rgba(255,255,255,0.08);
}
```
```css
.attach-popup .ico {
  display:none;
}
```
```css
.attach-popup .txt {
  display:flex;
  align-items:baseline;
  gap:14px;
  flex:1;
  min-width:0;
  overflow:hidden;
  padding-left:14px;
  /* 补偿删除图标后标题相对左边的距离，保持视觉留白与之前一致 */;
}
```
```css
.attach-popup .t {
  font-size:14px;
  font-weight:var(--fw-semibold);
  color:rgba(255,255,255,0.92);
  white-space:nowrap;
}
```
```css
.attach-popup .d {
  font-size:13px;
  color:rgba(255,255,255,0.55);
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}
```


### 3.8 .splitter

```css
body.layers-hidden .frame > *:not(.col-divider):not(.win-controls):not(.rail):not(.menu-btn):not(.tab):not(.hamburger):not(.agent-list):not(.rail-agents):not(.sidebar):not(.splitter):not(.search-pill):not(.add-btn):not(.main-area):not(.rail-logo):not(.rail-kb):not(.kb-view):not(.rs):not(.agent-create) {
  visibility:hidden !important;
}
```
```css
.splitter {
  position:absolute;
  top:0;
  left:calc(var(--rail-w) + var(--sb-w) - 4px);
  width:8px;
  height:var(--frame-h);
  /* Round 157：回退 */
  cursor:col-resize;
  background:transparent;
  z-index:6;
  touch-action:none;
}
```
```css
.splitter::after {
  content:"";
  position:absolute;
  left:50%;
  top:0;
  bottom:0;
  width:2px;
  transform:translateX(-50%);
  background:transparent;
  transition:background .15s ease;
}
```
```css
.splitter.dragging::after {
  background:rgba(255,255,255,0.35);
}
```
```css
.splitter:focus-visible::after {
  background:rgba(255,255,255,0.18);
}
```
```css
.frame.animating .splitter {
  transition: left .35s ease, opacity .35s ease;
}
```
```css
.frame.collapsed .splitter {
  opacity:0;
  pointer-events:none;
}
```
```css
.splitter {
  touch-action:none;
  user-select:none;
}
```
```css
.frame.agent .splitter {
  opacity:0;
  pointer-events:none;
}
```
```css
.frame.kb-open .splitter {
  opacity:0;
  pointer-events:none;
}
```
```css
.frame.dual .sidebar, .frame.dual .search-pill, .frame.dual .add-btn, .frame.dual .splitter {
  opacity:0;
  pointer-events:none;
}
```


### 3.9 .col-divider

```css
body.layers-hidden .frame > *:not(.col-divider):not(.win-controls):not(.rail):not(.menu-btn):not(.tab):not(.hamburger):not(.agent-list):not(.rail-agents):not(.sidebar):not(.splitter):not(.search-pill):not(.add-btn):not(.main-area):not(.rail-logo):not(.rail-kb):not(.kb-view):not(.rs):not(.agent-create) {
  visibility:hidden !important;
}
```
```css
.col-divider {
  position:absolute;
  top:0;
  width:2px;
  height:var(--frame-h);
  background:rgba(255,255,255,1);
  z-index:7;
  pointer-events:none;
}
```
```css
.col-divider.h {
  /* 横向：col2/col3 顶边界（x=77..1300, y=30），绕过左边圆角 */
  top:30px;
  left:77px;
  width:1223px;
  height:2px;
}
```
```css
.col-divider.corner {
  /* col2/col3 区域左上角 10px 内圆角（x=59,y=30；外弧 (59,40)→(69,30)） */
  width:10px;
  height:10px;
  top:auto;
  left:auto;
  background:transparent;
  border-top:2px solid rgba(255,255,255,1);
  border-left:2px solid rgba(255,255,255,1);
  border-top-left-radius:10px;
}
```
```css
.col-divider, .win-controls {
  display:none !important;
}
```


### 3.10 .win-controls / .win-btn

```css
body.layers-hidden .frame > *:not(.col-divider):not(.win-controls):not(.rail):not(.menu-btn):not(.tab):not(.hamburger):not(.agent-list):not(.rail-agents):not(.sidebar):not(.splitter):not(.search-pill):not(.add-btn):not(.main-area):not(.rail-logo):not(.rail-kb):not(.kb-view):not(.rs):not(.agent-create) {
  visibility:hidden !important;
}
```
```css
.col-divider, .win-controls {
  display:none !important;
}
```
```css
.win-controls {
  position:absolute;
  top:0;
  right:0;
  height:30px;
  display:flex;
  align-items:center;
  z-index:8;
}
```
```css
.win-btn {
  width:40px;
  height:28px;
  border:0;
  padding:0;
  background:transparent;
  color:rgba(255,255,255,0.85);
  display:grid;
  place-items:center;
  cursor:pointer;
  transition:background .12s ease;
}
```
```css
.win-btn:hover {
  background:rgba(255,255,255,0.12);
}
```
```css
.win-btn.close:hover {
  background:#e81123;
  color:#fff;
}
```
```css
.win-btn svg {
  width:12px;
  height:12px;
  display:block;
}
```


---

## 4. JS 注入的 DOM 模板（图标与联系人行）


### 4.1 rail 图标注入（含每个图标的 SVG 与 data-tip）

```javascript
l="拖动调整侧栏宽度（双击复位默认宽度，方向键微调）" aria-valuemin="265" aria-valuemax="300" aria-valuenow="270" data-page-node-id="O13knv44B5M5F8Am6s3E5D"></div>
      <!-- 3. 左侧玻璃栏 -->
      <nav class="rail" data-region="nav-rail" aria-label="主导航" data-page-node-id="uCVCjmekreXTX580t3wx0S"></nav>

      <!-- 主区（第三列，随分隔条自动伸缩） -->
      <div class="main-area" data-region="main-area" data-page-node-id="Jqp6ZYx5jib0oWhb6w8KrR">
      <!-- 顶部预留插件区：56px 空白，未来放功能插件；当前不覆盖任何内容 -->
      <div class="top-area" aria-hidden="true" data-page-node-id="iDtqL9WqzSwITTBKZFwB8c"></div>
      <!-- Round 57：删除左上角关闭按钮（一团 ×），不再需要 -->


      <!-- 底部输入栏：1:1 复刻 Group 7 设计参数（+ 31圆 / 文字 / → 36圆），宽度自适应第三列 -->
      <div class="inputbar" data-region="inputbar" data-state="empty" data-page-node-id="lVnKGxjcriEYOFEByYbnwk">
        <button class="inputbar-btn attach" data-act="attach" aria-label="附件 / 工具" data-page-node-id="D3Y1WFBH6x8NrbGe6jNSSe">
          <span class="plus" aria-hidden="true" data-page-node-id="1YaihrPByWUfQrqSvQo9CP"></span>
        </button>
        <!-- ＋ 弹层（Round 56）：从输入框上方展开，5 行 工具选项（无右侧 icon） -->
        <div class="attach-popup" id="attachPopup" aria-label="工具列表" data-page-node-id="yzKJ6iuqFMbbbw2jnTkWUh">
          <button class="item" data-tool="upload" data-page-node-id="0EcApYhI2xNyewU8aHkKdp">
            <span class="ico" data-page-node-id="NIwHP4BcGG0bOR7lTrqmuI"><svg viewBox="0 0 24 24" data-page-node-id="PCyOlJHaGCUwFQiZdwymXG"><path d="M21.4 11.05l-9.2 9.2a5.5 5.5 0 1 1-7.78-7.78l8.49-8.49a3.5 3.5 0 1 1 4.95 4.95l-8.49 8.49a1.5 1.5 0 0 1-2.12-2.12l7.78-7.78" data-page-node-id="WmWGnDiXnPyT4PhQmH8AK7"/></svg></span>
            <span class="txt" data-page-node-id="jaqO1HcBbvtrcYWcrXOAAr"><span class="t" data-page-node-id="kEPdoeW2lp4HWVnSZPvqzn">添加照片和文件</span><span class="d" data-page-node-id="R0lsHrTfhCuUDJhI8vkLuE">从电脑上传</span></span>
          </button>
          <button class="item" data-tool="library" data-page-node-id="HqBG8DvEGrnJzdiZ1YuxEQ">
            <span class="ico" data-page-node-id="mJN2ZqJ49DeN4g9znRyFMS"><svg viewBox="0 0 24 24" data-page-node-id="eRDVxpDCpCbPa6kT3FMSlP"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" data-page-node-id="hpzw72L6Jykme8mojlmHyg"/><line x1="3" y1="13" x2="21" y2="13" data-page-node-id="WyaqJ6XoGdcDQy8kFvwjNL"/></svg></span>
            <span class="txt" data-page-node-id="nvkcgcE0HjKdMjkqY
```


### 4.2 联系人行 contact-item 模板

_(未匹配到)_
