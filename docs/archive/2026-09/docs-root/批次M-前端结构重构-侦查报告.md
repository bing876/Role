# 批次 M · 前端结构重构 —— 侦查报告与切片计划

> 状态：**只查不改**。本报告不含任何产品代码改动，只含实测数据、结论与切片计划。
> 基线：`9dc9894`（收尾 7 已推）。侦查日期 2026-09-24。
> 复跑命令见 §10。所有数字都是在本仓库真跑脚本/真读源码得到的，不是估计。

---

## 0. 结论速览（先看这四条）

| # | 问题 | 结论 |
|---|---|---|
| ① | **是否必须升级 React 19 才能用 shadcn？** | **不用。** shadcn 的 **React 18 线 registry 仍然在线可用**（`/r/styles/new-york/dialog.json`：用 `React.forwardRef` + `@radix-ui/react-*`），依赖 peer 范围全部覆盖 React 18（`radix-ui@1.6.7` = `^16.8 \|\| ^17 \|\| ^18 \|\| ^19`）。**保持 React 18.3.1 不动**（动它会牵动 Electron，风险远大于收益）。 |
| ② | **引 Tailwind 的 preflight 会不会打乱现有样式？** | **冲突面很小，且可穷举**（只有 **5 个**真会咬到我们的点，见 §5.2）。最大的一条是 `html{line-height:1.5}` 会透过 `body` 继承下去（我们的 `body` 没写 line-height）。**一行补偿就能钉住**。 |
| ③ | **最大的地雷：webview 会不会被浮层/条件渲染搬走？** | 已量出**确切父链**（5 层，见 §4）。风险不在 shadcn 本身，而在**新加的 wrapper 节点**和**条件渲染**。现有代码里已经有 **3 条会真正卸载 webview 的路径**（其中 2 条是有意设计），冒烟测试必须知道这三条，否则会写出假红/假绿。 |
| ④ | **能不能一次性搬？** | 不能，而且**这一批的工作量主体不是 JSX**：`App()` 的 3031 行里 **2188 行是逻辑**（拉数据、事件处理、桥订阅）、只有 843 行是 JSX。所以「搬 feature」= 先搬逻辑 + 状态，JSX 跟着走。 |

另外两件必须先说的事：

- **你给的现状数字已经过期**：`App.tsx` 现在是 **3714 行**（不是 3354；收尾 6/7、批次 J、longdigits 都往它身上加过东西），`styles.css` 现在是 **1178 行**（不是 1119）。
- **`browser/` 一行不动是可行的**，但它不是「没有耦合」——它的样式表**没有**被 `styles.css` 重复定义（实测无重叠，§3.4），所以它天然不受「把 `styles.css` 拆掉」的影响。

---

## 1. 现状实测

### 1.1 文件规模

| 文件 | 行数 | 说明 |
|---|---|---|
| `apps/desktop/src/App.tsx` | **3714** | 含 2 个内嵌组件（`AuthScreen` / `AgentGuide`）+ 1 个 `App()` |
| `apps/desktop/src/styles.css` | **1178** | 152 条规则、2 个 `@keyframes`、9 个 CSS 变量、**2 处 `!important`**、0 个 `@media` |
| `apps/desktop/src/browser/styles.css` | 588 | 由 `BrowserPanel.tsx` / `HelpCard.tsx` 自己 import（**不动**） |
| `apps/desktop/src/channels/styles.css` | 292 | 由 `ChannelsPanel.tsx` 自己 import |

`App.tsx` 的内部构成（实测）：

| 区段 | 行 | 内容 |
|---|---|---|
| import / 类型 / 工具 | 1–358 | `API_BASE()`、`TOKEN_KEY='workbench.token'`、`authFetchJson()`、`driveStateView()` |
| `AuthScreen` | 361–598 | 登录页，**13 个 useState + 3 个 useEffect** |
| `agentGlyph` / `AgentGuide` | 599–683 | 人设引导卡片，6 个 useState |
| `App()` | 684–3714 | **59 个 useState + 13 个 useRef + 8 个 useEffect + 1 个 useCallback**；其中**逻辑 2188 行**（684–2871）、**JSX 只有 843 行**（2872–3714） |

### 1.2 布局与元素事实（preflight 评估的输入）

顶层骨架（`App.tsx` 实测行号）：

```
div.app                    2873
├─ aside.sidebar           2879   ← 左列（项目 / 智能体 / 记忆 / 资料 / 账号）
└─ main.middle             3204
   ├─ header.workbenchNav  3206   ← 顶栏（模式切换）
   ├─ div#taskDetail       3265   ← 任务详情浮层（条件渲染）
   ├─ div.browserLayer…    3310   ← 中列舞台（条件渲染：browser.allTabs.length > 0）
   │  ├─ ComputerVisibility 3345  ← 与 BrowserPanel 是兄弟
   │  └─ BrowserPanel       3357  ← ★ webview 宿主组件
   ├─ button.browserFloating 3373 ← 后台运行小图标（条件渲染）
   ├─ div.chat             3383   ← 右列（聊天）
   └─ div.inputBar         3674   ← 输入条
```

元素普查（`App.tsx` 全文，多行标签感知的精确计数）：

| 元素 | 数量 | 备注 |
|---|---|---|
| `<button>` | **48** | 47 个有 className 或有内联 style；**1 个裸的**（3690，发送键）→ 靠后代选择器 `.inputBar button` 活着 |
| `<input>` | **16** | 15 有类；**1 个裸的**（3675）→ 靠 `.inputBar input` 活着 |
| `<table>` / `<th>` / `<td>` | 2 / 5 / 5 | 5 个 `th`/`td` 自身没有 className，全部走 `.guide__table th/td` ✅ |
| `<h3>` | **2** | **两个都没有 className**（492 靠 `.authCard h3`、2838 完全裸）← preflight 会打中 |
| `<h4>` | 1 | 3474，有 `.welcomeCard__title`（但该规则**没写 font-weight**，会被 preflight 去粗） |
| `<b>` | 5 | 4 个裸的；preflight 的 `b{font-weight:bolder}` 与 UA 行为一致 → **无影响** |
| `<a>` | **1** | 3579 `sources__item`（带 `href`）；`.sources__item` 自带 `color:#2563eb; text-decoration:none` → **不受** preflight 的 `a{color:inherit;text-decoration:inherit}` 影响（**但搬迁时若把这个类弄丢，它就会变成裸链接**） |
| `<p>` / `<ul>` / `<ol>` / `<li>` / `<img>` / `<svg>` / `<hr>` / `<textarea>` / `<code>` / `<pre>` / `<small>` / `<select>` | **0** | ← 这条很关键：preflight 大半的体积（列表、图片、段落、表单）**根本碰不到我们** |

---

## 2. 侦查任务 ①：state 清单与归属

### 2.1 总账

| 类型 | `App()` | `AuthScreen` | `AgentGuide` |
|---|---|---|---|
| `useState` | **59** | 13 | 6 |
| `useRef` | **13** | 0 | 0 |
| `useEffect` | **8** | 3 | 0 |
| `useCallback` | 1 | 0 | 0 |
| `useMemo` | **0** | 0 | 0 |

`useMemo` 一个都没有、`useCallback` 只有 1 个 → **没有隐藏的缓存层**，搬迁时不用考虑记忆化依赖，这是好消息。

### 2.2 归属表（全局 = 要进 Providers；局部 = 跟着 feature 走）

**A. 全局（跨 feature 读写，必须进 Providers/store）**

| state / ref | 行 | 为什么是全局 | 归属 Provider |
|---|---|---|---|
| `session` / `sessionRef` / `checkingAuth` / `pwOld.pwNew.pwMsg` | 754 / 1542 / 761 / 762-764 | 每个 fetch 都要 token | `AuthProvider` |
| `API_BASE()` / `TOKEN_KEY` / `authFetchJson()` | 291 / 299 / 326 | 目前是模块级函数，被所有 feature 用 | `shared/api.ts`（不进 Provider） |
| `projects` / `curProjectId` / `curProjectRef` / `agentProjectRef` | 861 / 862 / 863 / 874 | 智能体、任务、记忆、资料全按项目过滤；切项目会清空聊天缓存（effect@1696） | `ProjectsProvider` |
| `agents` / `agentsRef` | 851 / 864 | 左列 + 右列 + 可见度 + 浏览器都要 | `AgentsProvider` |
| `agentStates` / `agentStatesRef` | 893 / 894 | 头像即状态、可见度档位都读它 | `AgentsProvider` |
| `chats` / `chatsRef` / `historyLoadedRef` / `lastUserWasOpenRef` | 714 / 716 / 724 / 800 | 每个智能体一份聊天；流式写入要在多处可见 | `ConversationProvider` |
| `curAgentId` / `curAgentRef` | 719 / 721 | 左右两列 + 浏览器 + 可见度的共同锚点 | `ConversationProvider` |
| `streaming` / `streamingAgentId` / `streamText` / `chatNote` / `searchHint` | 801-818 | 流式状态跨右列与顶栏 | `ConversationProvider`（或 chat feature 的 store） |
| `settings` / `settingsRef` | 705 / 706 | 发车参数 + 资源闸门（effect@1904）都读 | `SettingsProvider` |
| `task`(TaskState) / `curTask` / `taskDetailOpen` / `docNote` | 695 / 687 / 688 / 689 | 顶栏状态机 + 右列详情 + 脚本执行判据 | `TasksProvider` |
| `runningLoopId` / `runningLoopWcId`(+Ref) / `agentAwait*` / `awaitResume*` | 828-847 | 「谁在等谁」跨 chat / browser / 顶栏三处 | `TasksProvider` |
| `computerVisibility` | 732 | 右列渲染它、组件读写它、服务端存它 | `VisibilityProvider`（或并入 browser 胶水，见 §4.3） |
| `bridgeInfo` / `hasUnread` | 751 / 686 | 外壳级 | `AppShell` |

**B. 局部（跟着 feature 走，不进全局）**

| state | 行 | 归属 feature |
|---|---|---|
| `projectsOpen` / `newProjectName` / `projectBusy` / `projectNote` | 875-878 | `features/projects` |
| `personaEditOpen` / `personaEditAgentId` / `personaEditDraft` | 903-905 | `features/agents` |
| `knowledgeDocs` / `knowledgeOpen` / `knowledgeUploading` / `knowledgeNote` / `knowledgeDeletingId` / `knowledgeFileRef` | 899-902, 906, 909 | `features/knowledge`（**见 §9 待拍板 Q1**） |
| `userMem*` / `projMem*` / `pendingMem*` | 880-887 | `features/memory` |
| `agentSteps` / `agentDoc` / `helpCards` | 907 / 908 / 911 | `features/chat` |
| `loopGone` | 910 | `features/tasks`（渲染位置却在中列舞台，见 §4.2 注） |
| `embedRect` / `onEmbedRect` | 913 / 2757 | **browser 胶水**：值由 `HelpCard` 量、写给 `BrowserPanel`。`browser/` 不动 → 这一格只能留在外壳 |
| `AuthScreen` 的 13 个 | 362-379 | `features/auth`（整屏，与主壳互斥） |
| `AgentGuide` 的 6 个 | 622-627 | `features/agents`（人设编辑卡片） |

### 2.3 13 个 ref 的性质（搬迁时的注意点）

其中 **7 个是「最新值镜像」**（`settingsRef` / `chatsRef` / `curAgentRef` / `agentsRef` / `agentStatesRef` / `curProjectRef` / `runningLoopIdRef`+`WcIdRef`）：它们存在的唯一理由是**给事件处理器/桥回调读最新值**（避免闭包拿到旧 state）。
**这 7 个在 Provider 化之后不能简单删掉** —— Provider 里的 `useState` 同样是闭包语义，直接删会重演「拿到上一轮的值」这类 bug。迁移规则：**镜像 ref 原样保留在 Provider 内部**，只在同一批里删那些确证没人读的。
其余：`historyLoadedRef`（去重）、`lastUserWasOpenRef`（发车判据）、`knowledgeFileRef`（DOM）、`sessionRef`（镜像）。

### 2.4 12 个 useEffect 的归属

| 行 | 干什么 | 归属 |
|---|---|---|
| 381 / 399 / 426 | 冷却倒计时 / 后端探测重试 / 主进程 mock 验证码 | `AuthScreen` 局部 |
| 767 | 带 token 静默登录 | `AuthProvider` |
| 1696 | **切项目：清空全部聊天缓存**，重拉智能体 / 记忆 / 任务 / 资料 | `ProjectsProvider` × 4 个 feature（**跨 feature 协调点，最容易搬出 bug**） |
| 1838 | 读回可见度档位（读不到**保持不动**，绝不回落 `status`） | `VisibilityProvider` |
| 1904 | 设置变了 → 刷新资源闸门视图 | `SettingsProvider` |
| 1908 / 1923 / 2001 | 主进程桥：UI 指令 / 驾驶员 `ask·done·note` / 桥自检 | `AppShell`（三个订阅必须收在同一处，否则重复订阅） |
| 2778 | 求助卡 ↔ 浏览器 embed 态的联动 | `features/chat` × browser 胶水 |

---

## 3. 侦查任务 ②：`className` ↔ `styles.css` 的对应关系

### 3.1 总账（实测）

- `App.tsx` 里 `className=` **195 处**（比你说的 172 多），去重后 **118 个类名 token**。
- 118 个里 **106 个** 有 CSS 定义；**12 个是「只有挂钩、没有样式」**（`colleagueProposal` / `contact__meta` / `knowledgePanel__toggle` / `knowledgePanel__upload` / `loopGone__giveup` / `msg__speaker` / `projectBox__create` / `projectBox__cur` / `projectBox__name` / `projectBox__toggle` / `embed` / `fullscreen`）。最后两个是**误报**（它们是 `browser.view` 的取值，不是类名）。
  → 结论：**这 12 个不需要迁移样式**，其中 `colleagueProposal` 目前只有内联 style（`3552`），是块「设计未定稿」的地方。
- `styles.css` 的 152 条规则里，**140 条是真在用的**，**12 条是死的**（`.card` / `.card h4` / `.driveBar` / `.driveBar__tag` / `.driveBar__go` / `.driveBar__go:hover` / `.driveBar__note` / `.driveState--agent` / `.driveState--user` / `.driveState--none` / `.memCard` / `.status-running` —— 全仓源码里搜不到对应类名）。
  → 结论：这 12 条**可以直接删**，不用迁移。

### 3.2 能直接映射到 Tailwind 的（绝大多数）

`styles.css` 里 152 条规则，基本全是「布局 + 颜色 + 圆角 + 字号」的单类选择器 —— 这正是 Tailwind 的主场。特点：

- 只用了 9 个 CSS 变量：`--bg --panel --sidebar --border --text --text-weak --accent --primary --pending` → 直接进 `@theme`，Tailwind 侧用 `bg-panel` / `text-weak` 这类名字引用，**不要在组件里写死颜色**（后面用户给设计稿时要一处换色）。
- 0 个 `@media`（**没有响应式断点**）、只有 2 个 `@keyframes`、2 处 `!important`。
- 命名是 BEM 风格（`.browserLayer--bg`、`.memList__row`），映射到 Tailwind 时可以整体删掉这些类名（组件改名 + 内联 utility），也可以保留类名做钩子（验收脚本和 CSS 断言现在依赖 `.browserLayer` 这类锚点，见 §4/§8）。

### 3.3 必须保留为 CSS 的（不能变成 utility）

| 规则 | 位置 | 为什么不能变成 utility |
|---|---|---|
| `.browserLayer` / `--bg` / `--embed` | `styles.css`（唯一处） | **webview 几何的命门**。「看不见但照样跑」= `opacity:0 + pointer-events:none`，**不是** `display:none`、**不是**尺寸归零。现有探针 `panel-visibility-coupling-probe.py` 就是钉这条的 |
| `.browserLayer--bg` 那整段注释 | 同上 | 注释本身是资产：它记着「为什么不能 display:none」（坐标来自 `getBoundingClientRect`） |
| `@keyframes` × 2 | `styles.css` | Tailwind v4 用 `--animate-*` + `@keyframes` 也行，但没必要在结构重构里动 |
| 2 处 `!important` | `styles.css` | 需要逐条看为什么，属于「不要顺手改」的范畴 |
| `.msg` 的双定义 | `styles.css` ∩ `channels/styles.css` | **两处都定义 `.msg`，胜负取决于打包顺序**（见 §3.4），迁移时必须一起处理 |

### 3.4 冲突面（两个**必须知道**的既有问题）

1. **`.msg` 在 `styles.css` 和 `channels/styles.css` 各定义一次**：

   | | `styles.css`（聊天气泡） | `channels/styles.css`（内部频道行） |
   |---|---|---|
   | 共有属性 | `padding: 8px 10px` / `border-radius: 10px` | `padding: 8px 10px` / `border-radius: 6px` + `border-left-width: 3px` |

   两者作用于**不同 DOM 子树**（`.chat` vs 频道面板），所以平时看不出问题；但 `border-radius` 这类共有属性**谁后加载谁赢**。搬 `chat` 时必须显式消歧（建议后面加一层作用域，如 `.channelsPanel .msg`），**否则重构会把这个潜在 bug 变成显性 bug**。

2. **4 个后代选择器会「抓」新组件**：`.inputBar input`、`.inputBar button`、`.authCard h3`、`.guide__table th/td`（外加 `.card h4` 但已死）。
   → 这些是**未分层、单类+元素**的选择器。往这些区域里塞 shadcn 组件时（例如把发送键换成 `<Button>`），**旧规则会盖住新组件的 utility**（原因见 §5.3 的层叠层规则）。规矩：**往哪块区域加组件，就同批把那块区域的后代选择器一起拆掉**。

3. `styles.css` ∩ `browser/styles.css` = **空**（无重叠，实测按选择器字符串比对）→ `browser/` 天然不会被 `styles.css` 的拆分波及。

---

## 4. 侦查任务 ③：webview 宿主的确切位置与父链

### 4.1 父链（实测，从根到元素）

```
div.app                                    App.tsx:2873
└─ main.middle                             App.tsx:3204
   └─ div.browserLayer[--bg|--embed]       App.tsx:3310   ← 条件渲染：{browser.allTabs.length > 0 && (…)}
      ├─ ComputerVisibility                App.tsx:3345   ← 兄弟节点，不是 children
      └─ BrowserPanel                      App.tsx:3357
         └─ div.browserPanel[--embed]      browser/BrowserPanel.tsx:139
            ├─ div.browserPanel__tabs       :141
            ├─ div.browserPanel__urlbar     :212
            └─ div.browserPanel__stage      :278   ← 舞台
               ├─ div.browserPanel__slept   :320   （深休眠时代替 webview）
               └─ <webview>                 :335   （key={t.id}，ref 经 bindRef 表管理）
```

→ **webview 的祖先链 = 5 个元素节点**：`div.app` → `main.middle` → `div.browserLayer*` → `div.browserPanel*` → `div.browserPanel__stage`。
→ 内联 style（量出来的 rect）由 `BrowserPanel` 写在 webview 自己身上，**元素本身从头到尾不移动**（注释 `:352` 明写）。

### 4.2 现有代码里**会真正卸载 webview** 的 3 条路径

冒烟测试必须知道这三条，否则会写出假红/假绿：

| # | 触发 | 后果 | 定性 |
|---|---|---|---|
| ① | `browser.allTabs.length === 0` | 整个 `.browserLayer`（含 `BrowserPanel`）被卸载 | 有意：一张页都没有时不留空壳 |
| ② | 某张页进入**深休眠**（`t.sleep === 'deep'`） | 该 tab 渲染 `.browserPanel__slept` 占位卡，`<webview>` 被卸载 | **有意**（第 24 步：这才是真的省内存），`:305-308` 有注释 |
| ③ | `key={t.id}` 变化 | React 按 key 重建元素 | 有意：一个 tab 一个元素 |

→ 所以硬规则要写准确：**「除了这三条有意的路径之外，webview 的祖先链与节点身份必须逐字节不变」**。「webview 永远不卸载」是错的表述，测试按错误表述写会假红。

### 4.3 与 `ComputerVisibility` 的关系（收尾 7 定下的，不能推翻）

- 两者是**兄弟**，`ComputerVisibility` 只改自己周围那圈 chrome，**children 恒在同一个宿主里**（组件内部实现）。
- `App.tsx:3339-3341` 有一段注释明写：**不许把 `BrowserPanel` 塞进 `ComputerVisibility` 的 children** —— children 一旦随档位换父节点，React 会卸载重建 webview。
- `embedRect`（`913`/`2757`）是 chat ↔ browser 的**唯一几何桥**：由 `HelpCard` 量、交给 `BrowserPanel` 写内联 style。`browser/` 不动 → 这个桥留在外壳。

---

## 5. 侦查任务 ④：Tailwind preflight 的冲突面

依据：**Tailwind v4.3.3 的 `preflight.css` 原文逐条比对**（不是凭记忆），本地版本 `tailwindcss@4.3.3`。

### 5.1 先排除不打我们的（占了 preflight 的大半）

`ol/ul/menu` 去列表样式、`img/svg/video` 变块级 + `max-width:100%`、`code/pre` 等宽、`sub/sup`、`hr`、`progress`、`summary`、`textarea` 竖向 resize、`::file-selector-button`、`::-webkit-*` 一堆日期控件规则 —— 这些元素 **`App.tsx` 里一个都没有**（实测为 0：`<p> <ul> <ol> <li> <img> <svg> <hr> <textarea> <code> <pre> <small> <select>`）。
仅有两条例外，都**无影响**，但要记着：① `<a>` 有 1 个（3579），preflight 的 `a{color:inherit;text-decoration:inherit}` 被 `.sources__item` 自己的 `color`/`text-decoration` 盖住 ✅；② `<b>` 有 5 个，preflight 的 `font-weight: bolder` 与 UA 一致 ✅。

### 5.2 真会咬到我们的 **5 条**（全部可补偿）

| # | preflight 做的 | 我们现在靠什么 | 影响 | 补偿 |
|---|---|---|---|---|
| ① | `html,:host { line-height: 1.5 }` | `body` 写了 `font-family/font-size/background/color`，**没写 line-height**（靠 UA 的 `normal`） | **最大的一条**：所有没显式写 line-height 的文字行高从 ~1.2 变 1.5。152 条规则里只有 15 条写了 line-height，24 条写了 font-size 却没写 | 在 legacy 层或补偿层加 `html,body { line-height: normal }`（或显式值）。**必须在真机上看一眼** |
| ② | `h1…h6 { font-size: inherit; font-weight: inherit }` | `.authCard h3`(17px,无 font-weight)、`.card h4`(只设 margin)、`.welcomeCard__title`(16px,无 font-weight) + 2 个**完全裸的 `<h3>`**(492/2838) | 标题**掉粗体**（3 处），裸 h3 还会掉字号与外边距 | 同批给这几个标题上 Tailwind 类；或在补偿层恢复 `font-weight: 700` |
| ③ | `*,::before,::after { margin: 0; padding: 0 }` | 裸 `<h3>`×2 的 UA 外边距；`<th>/<td>` 的 UA 内边距（但 `.guide__table th/td` 已设 ✅） | 2 个裸 h3 会贴边 | 同上（h3 上类） |
| ④ | `::placeholder { opacity: 1; color: color-mix(in oklab, currentcolor 50%, transparent) }` | 16 个 input 的占位符颜色（UA 灰） | 占位符颜色变浅/变色 | 补偿层写一条 `::placeholder { color: … }`（颜色值等设计稿；现在先钉住现值） |
| ⑤ | `button,input,… { font: inherit; border-radius: 0; background-color: transparent }` | `.btn`/`.authTab`/`.authInput`/`.inputBar input`/`.inputBar button` 都自带 background/border/radius/font ✅ | **只在有控件没走这些类时**才出问题（实测各 1 个裸控件，都被后代选择器盖住了）→ R8 见下 | 无需动作，但**新增控件时必须确认它有类** |

> ⚠️ R8 备注：`.btn` 自带 `cursor: pointer`，但 **v4 的 preflight 不再给按钮 `cursor: pointer`**（v3→v4 的行为变化）。我们的 12 处 `cursor: pointer` 都在自己的规则里 ✅，只有**将来新增的、没写 cursor 的按钮**会变回默认箭头 —— 这条**写进规范**（新增按钮用 shadcn `<Button>` 时它自带 `cursor-pointer`，别自己写裸 `<button>`）。

### 5.3 比 preflight 更重要的一条：**层叠层（cascade layers）**

Tailwind v4 把 utility 放进 `@layer utilities`。CSS 规则是：**分层样式永远输给未分层样式，与特异性无关**。
我们是**未分层**的 3 个 CSS 文件 + 即将新增的分层 utility。后果：

- 现有 CSS 会**永远盖住** Tailwind utility。对「零视觉改动的结构重构」这**正好是我们要的**（旧样式全胜 = 外观不变）。
- 但反过来：**同一元素如果既留着旧规则、又加了 utility，utility 永远不生效**。

→ **本批的策略（不采用「把 legacy 包进 @layer」的做法）**：
**搬哪条，删哪条。** 迁移一个 feature 时，把该块 CSS 规则**从 `styles.css` 里删掉**，改成组件上的 utility，而不是把整个文件包一层 `@layer legacy`。
理由（实测支撑）：把 `styles.css` 包层会**改变它与 `channels/styles.css` 的胜负关系**（§3.4 的 `.msg` 双定义）和 `.browserLayer` 的归属，等于在结构重构的同时改视觉，**违反「切片、可回退」的原则**。不包层则胜负关系保持现状，风险为零。

### 5.4 引入方式的硬结论

- 入口用 `@tailwindcss/vite`（我们 **Vite 6**，`@tailwindcss/vite@4.3.3` 的 peer 是 `^5.2 || ^6 || ^7 || ^8` ✅）。
- **`browser/styles.css` 与 `channels/styles.css` 保持未分层、保持由各自组件 import**（`browser/` 不动，也不要去动它的引入方式）。
- 新增一个入口 CSS（如 `src/index.css`）只做三件事：`@import "tailwindcss"` + `@theme`（9 个变量）+ **§5.2 的补偿块**。`main.tsx` 改成 import 它（`styles.css` 仍在其后被 import，未分层，继续全胜）。
- **Electron/Chromium 兼容性**：Tailwind v4 要求 Chrome 111+；我们是 **Electron 33.4.11 = Chromium 130** ✅。
- **不要开 `tailwind.config.js`**：v4 是 CSS-first（`@theme`），且 v4 不读 JS 配置里的 theme（除非用 `@config`）。仓库现在**没有** tailwind/postcss 配置（实测），是干净起点。

---

## 6. 侦查任务 ⑤：React 18 与 shadcn 的兼容性结论

### 6.1 实测证据（直接取 registry 源码与 npm peer 范围）

| 项 | 实测结果 |
|---|---|
| React-19 线 registry | `GET /r/styles/new-york-v4/dialog.json` → **无 `forwardRef`**（`function Dialog({...}: React.ComponentProps<…>)` + `data-slot`），依赖 `["cn","radix-ui"]`、`lucide-react` |
| **React-18 线 registry** | `GET /r/styles/new-york/dialog.json` → **仍在线上可用**，用 `React.forwardRef` + `React.ElementRef`，依赖 `["@radix-ui/react-dialog"]` + `lucide-react` + `@/lib/utils` 的 `cn` |
| `radix-ui`（统一包） | v1.6.7，peer `react: ^16.8 \|\| ^17.0 \|\| ^18.0 \|\| ^19.0` ✅ |
| `lucide-react` | v1.48.0，peer 含 `^18.0.0` ✅ |
| `cn` / `class-variance-authority` / `tailwind-merge` / `tw-animate-css` | 无 peer 限制 ✅ |
| `@tailwindcss/vite` | 4.3.3，peer `vite: ^5.2 \|\| ^6 \|\| ^7 \|\| ^8`（我们 6.0.7）✅ |
| CLI 选哪条线 | 由 `components.json` 的 `style` 决定（`new-york` = React18 线；`new-york-v4` = React19 线）。已知 CLI 有「`init --force` 不会自动把 `new-york` 改成 `new-york-v4`」的坑（issue #8990 / #6714）→ **对我们反而是好事：默认拿到的就是 React 18 线** |

### 6.2 真正的 React 18 风险（不是依赖，是**源码写法**）

新版（v4 线）组件**去掉了 `forwardRef`**，改成「`ref` 当普通 prop」。**React 18 不支持函数组件把 `ref` 当 prop 透传** —— 一旦有人给这些组件传 `ref`（最典型：Radix 的 `<Trigger asChild>` 会 clone 子元素并注入 ref），React 18 会丢 ref 并告警，`Popover`/`Tooltip`/`DropdownMenu` 的**定位与开合会静默失效**（这就是 issue #7926 的现象）。

**结论与推荐路线（三选一）：**

| 路线 | 做法 | 评价 |
|---|---|---|
| **A（推荐）** | 用 **React 18 线 registry**（`components.json` 写 `"style": "new-york"`）：`forwardRef` 原生在、`@radix-ui/react-*` 分包、零源码改写 | 与 React 18.3.1 完全对齐；缺点是这条线的组件**不再有新特性更新**（但我们后面要按用户设计稿重写，这反而无所谓） |
| B | 用 v4 线，**手工给需要 ref 的组件加回 `forwardRef`**（每个约 4 行） | 可行但每个组件都要动刀，且以后 `add` 新组件都要重复一次 |
| C | 升 React 19 | **不做**：会牵动 `react-dom`、Electron 主/渲染进程、`@types/react`；风险与收益不成比例 |

**附带的适配项**（两条线都要考虑）：
- 动画：React18 线用 `tailwindcss-animate`（v3 时代的 JS 插件），v4 侧推荐换成 **`tw-animate-css`**（纯 CSS，提供同样的 `animate-in / fade-in-0 / zoom-in-95` 类）。**安装后必须实测一遍**（这条我没法在沙箱里替你验，见 §9 Q3）。
- `lib/utils` 的 `cn`：React18 线用 `@/lib/utils`，需要给 `vite.config.ts` 与 `tsconfig.json` 加 `@/*` → `src/*` 别名（现在**没有**别名，`tsconfig.json` 里没有 `paths`）。

---

## 7. 目标结构的落地映射

```
src/
├─ app/                       ← 外壳 + Providers（新增）
│  ├─ App.tsx                 ← 从现在的 App() 里剥出「骨架 + 路由式布局」
│  ├─ providers/              ← Auth / Projects / Agents / Conversation / Tasks / Settings / Visibility
│  └─ index.css               ← Tailwind 入口（@import "tailwindcss" + @theme + 补偿块）
├─ features/{projects,agents,tasks,routines,memory,chat,knowledge,auth}/
│  ├─ index.ts                ← 唯一的公开 API（feature 之间只许从这里 import）
│  └─ …
├─ components/ui/             ← shadcn（逐行归我们；React18 线）
├─ browser/                   ← **一行不动**
└─ shared/                    ← api.ts（API_BASE/authFetchJson/TOKEN_KEY）、types、hooks
```

**边界强制机制**（不能只靠约定，要能红）：
新增 `scripts/verify/structure-boundaries.mts`，扫 `src/**` 的 import：
① feature 之间只许 `import … from '../x'`（或 `../x/index`），出现 `../x/内部文件` → **红**；
② `features/**` 不许 import `app/**` 的内部路径（只许反向注入的回调/context）；
③ `browser/**` 的 import 面必须与重构前**逐行一致**（把现在的 import 列表存成 golden）。
配套反证：故意写一条深层 import → 必须红。

---

## 8. 切片计划（每片都可独立回退、每片结束立刻 push）

| 片 | 内容 | 验收 | 反证（必须红） |
|---|---|---|---|
| **M0** | **先织网**：`scripts/verify/app-shell-smoke.mts` + `.run.tsx`，用 **jsdom 挂整个 `<App/>`**（复用仓库既有模式，见 §10），断言：三列都在、`BrowserPanel` 在、webview 宿主祖先链与 golden 一致、切换可见度档位/智能体/顶部模式后**宿主节点身份与祖先链不变** | 全绿 + golden 落盘 | ① 把 `BrowserPanel` 包进条件渲染 → 红；② 在链上插一个 wrapper `div` → 红；③ 改成 `display:none` → 红 |
| **M1** | **Tailwind 接入（零视觉改动）**：装 `tailwindcss`/`@tailwindcss/vite`，新增 `app/index.css`（`@import` + `@theme` 9 变量 + §5.2 补偿块），`main.tsx` 引它；**不删任何旧 CSS、不加任何 utility** | M0 绿 + `npm run verify` 绿 + `vite build` 绿；补一条「补偿块生效」的 CSS 断言 | 删掉补偿块 → h3/line-height 断言红 |
| **M2** | **shadcn 骨架**：`components.json`（`style: new-york`）+ `lib/utils` + `@/*` 别名 + 装 3 个基础件（Button/Input/Tooltip）；**只加不换**，先证明「装进来的东西在 React 18 下能用」 | 新增 `verify:ui` 快层：真渲染 Button/Input/Tooltip（jsdom），`asChild + ref` 用例必须通过（专治 §6.2 那个坑） | 把 `forwardRef` 删掉 → ref 用例红 |
| **M3** | **projects**（最小，先趟路）：状态+JSX+CSS 规则一起搬进 `features/projects`，删掉 `styles.css` 对应规则 | M0/M1/M2 绿 + 新片自己的「项目区渲染 + 建项目流程」断言 | 不渲染该 feature → 红 |
| **M4** | **agents**（含 `AgentGuide`、人设编辑、`.contact`/`.avatar` 系列） | 同上 + 左列锚点断言 | 同上 |
| **M5** | **tasks**（顶栏状态机、任务详情浮层、`runningLoop*`/`awaitResume*`/`loopGone`） | 同上 + 状态机断言 | 同上 |
| **M6** | **routines** | 同上 | 同上 |
| **M7** | **memory** | 同上 | 同上 |
| **M8** | **chat**（最复杂，最后：流式、@点名闸门、helpCards、embedRect 桥） | 同上 + 流式与 @点名端到端（复用现有 `verify:mention:e2e`） | 同上 |
| **M9** | **收口**：删死 CSS（§3.1 的 12 条）、消歧 `.msg`（§3.4）、`App.tsx` 最终只剩外壳 | 全量 `npm run verify` + `typecheck` + 真库 `verify:db` | — |

**顺序按你的建议：projects → agents → tasks → routines → memory → chat**；`knowledge` 与 `auth` 建议插在 M4 之后（见 Q1）。

---

## 9. 需要你拍板的 4 件事（我不会替你决定）

**Q1 · `knowledge`（资料上传/列表）算不算独立 feature？**
你给的目标结构里没有它，但它现在是 **6 个 state + 1 个 DOM ref + 1 个上传流程**，塞进 `agents` 或 `memory` 都会让那个 feature 变胖。
→ 建议：**单列 `features/knowledge`**（第 7 个 feature），或你指定归到谁家。

**Q2 · `browser/` 不动，但 `embedRect` / `loopGone` / `computerVisibility` 这三个「跨 chat 与 browser 的胶水」放哪？**
它们既不在 `browser/` 里（那目录不动），又是 chat 与浏览器层的耦合点。
→ 建议：留在 `app/` 的 `BrowserGlue`（一个 Provider），**不塞进任何一个 feature**，避免 chat ↔ browser 互相 import。

**Q3 · 像素级「零视觉改动」谁来确认？**
本沙箱**没有显示环境、也没有 Playwright/Chromium**（`apt-get` 被禁，Electron 起不来），所以**我无法提供截图对比**。我能给的是：preflight 逐条比对（§5.2）+ CSS 层面的断言 + jsdom 的行为断言。
→ 需要你在自己机器上跑 `npm run dev` 目视一次 M1（Tailwind 接入）前后。或者你同意我花 ~150MB 装一次 headless Chromium 做「登录页像素比对」（沙箱每回合会清 `node_modules`，每次都要重装）。

**Q4 · Tailwind 是现在接入（M1），还是等你的设计稿一起？**
「结构重构」和「视觉重构」是两件事。我建议**分开**：M1 只接入、零视觉改动；设计稿来了再做视觉批次（那时 shadcn 组件已经在位、`@theme` 变量已就位，换色/换圆角是一处改动）。

---

## 10. 复跑命令（本报告每个数字的来源）

```bash
# 结构普查（行数 / hook / 元素 / className 映射 / 死规则）—— 本报告 §1/§3 每个数字的来源
python3 scripts/verify/frontend-inventory.py
python3 scripts/verify/frontend-inventory.py --json

# 现有前端相关验收（这些必须在每一片之后继续全绿）
npm run verify:visibility          # 40/0
npm run verify:visibility:e2e      # 26/0（真后端 + 真库）
npm run verify:mention:desktop     # 桌面闸门
npm run verify:routing             # 31/0
npm run verify                     # 全量主链

# jsdom 渲染真实组件的既有模式（M0 冒烟测试照它写）
npx tsx scripts/verify/orc-channels-ui.mts
```

写 M0 冒烟测试时的三条硬要求（来自本报告）：
1. **CSS 导入必须置空**（esbuild `loader: {'.css':'empty'}`）——`BrowserPanel.tsx`/`ChannelsPanel.tsx` 自己 import 了 CSS，Node 下加载不了；既有脚本已经这么做。
2. **`window.workbench` 必须是桩**：`App` 挂载时会读桥（effect@1908/1923/2001）、`preload` 在 jsdom 里不存在。
3. **祖先链断言用 golden 文件**：M0 从**当前代码**生成一次，之后每一片都必须逐字节一致（这是「重构把 webview 搬走了」的唯一硬防线）。

---

## 11. 沙箱环境备忘（本回合实测，影响下一回合的开机动作）

- **沙箱重置了本地 `.git`**（HEAD 回到基线 `ac75d63`，我的提交对象全没了；工作树文件完好）。恢复：`git fetch origin` → `git reset --mixed 9dc9894…`（**绝不 `--hard`**）→ 树干净。
- **`packages/shared/dist/` 被快照排除**（`.gitignore` 里有 `dist/`，但该目录是**强制入库**的），因此**每个回合边界都会把已提交的 dist 文件抹成「已删除」**。本回合的处理：`git restore --source=HEAD --worktree packages/shared/dist`（**只还原被沙箱抹掉的那份已提交内容，没有丢弃任何未提交的工作**；事后 `git status` 为空 = 与 `9dc9894` 逐字节一致）。
  → **这是唯一一次例外使用 checkout 系命令，特此声明**。更稳妥的替代（下回合起优先用）：`npm run build -w @ai-workbench/shared` 重新构建。
- `node_modules` / `pgverify` 被清 → 要跑真库验收前需重装（`ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install`）并重启 embedded-postgres。
