# 批次 M · 设计缺口清单：`workbench-ui` 里没有、但 `apps/desktop` 必须有的 UI

> 用途：**报给用户补设计**。清单里每一条都是 `apps/desktop` 现在真实存在、且在跑的功能界面，
> 而设计基准 `workbench-ui`（`sidebar / splitter / Rail / main-area(ChatArea + InputBar)`）
> **没有它的位置与形态**。
> 在用户给出这些界面的位置/形态之前：
> **`browser/BrowserPanel.tsx` 的挂载方式保持原样不动，只重构它周围**（已按此执行）。
>
> 侦查日期 2026-09-24，基线 `9b3cfb8` 之后（M0 之前）。行号均指 `apps/desktop/src/App.tsx`。

## 0. 一句话结论

设计基准是「**两列 + 一条 rail**」的聊天工作台（联系人会话），
而 desktop 是「**三列 + 一个浏览器工作区 + 一整套运行时状态可视化**」的执行工作台。
缺的不是几个按钮，而是**一整块主区域（浏览器区）**和**一整套"AI 正在干什么"的状态层**。

## 1. 缺口总表（按"缺得最狠"排序）

| # | 界面 | 现状（代码位置） | 设计里有吗 | 需要用户给什么 |
|---|---|---|---|---|
| 1 | **浏览器工作区**（整块） | `browser/BrowserPanel.tsx`（411 行）：顶栏活页 tab（+ 关闭 / 运行中圆点 / 休眠徽标）+ URL 栏 + 舞台（多智能体多页叠放）+ 自动休眠开关；由 `App.tsx:3357` 挂在 `div.browserLayer`（`:3310`）里 | ❌ 完全没有 | **位置 + 尺寸 + 形态**。它是中栏的主内容区（`main.middle` 内，覆盖 `.chat` 之上），设计的三列里没有它的位子 |
| 2 | **电脑三级可见度**（状态/预览/接管） | `browser/ComputerVisibility.tsx`（243 行），`App.tsx:3345` 渲染，与 BrowserPanel **兄弟** | ❌ | 三档的**视觉强度差**怎么表达（现在：一条状态 chip 条 → 加页面摘要 → 加"接管"横幅） |
| 3 | **"谁在等谁"状态条** | `.driveState`（`App.tsx` 4 处 + `styles.css:5` 条规则）；区分「用户主动暂停」与「AI 主动求助」（都落在 `phase='paused'`，靠 `pausedBy` 区分） | ❌ | 这条是核心可辨识度要求，需要固定位置与配色（不能跟其它卡片混） |
| 4 | **待确认黄条 / P0 确认卡** | `.loopGone`（9 处）：`重新开始`（带代价，加粗描边）/ `算了` 两颗按钮 | ❌ | 位置（现在在中列顶部）与形态（红棕底 + 实心边框的原由写在 `styles.css`） |
| 5 | **任务卡 + 任务详情浮层** | `taskDetail`（5 处）：状态机（idle/running/paused/…）+ 名称/进度/大纲/摘要表 + 文档备注；顶栏徽标 `workbenchNav__badge` / `__driving` | ❌ | 任务卡放哪、展开成什么形状（现在是 `#taskDetail` 浮层 + `guide__table` 式表格） |
| 6 | **头像即状态圈** | `.contact` 行（`:2951`）+ `.avatar` / `.avatar__face`（`:2954`）+ `agentStates`（头像旁状态点/文案） | ⚠️ 有头像，**没有状态圈语义** | 五种状态（idle/thinking/working/waiting/blocked）的颜色与动效 |
| 7 | **协同过程折叠摘要**（对话流内） | `channels/ChannelsPanel.tsx` + 对话流里的折叠摘要（`msg__speaker` 名字牌 `:3540`） | ❌ | 摘要折叠成一行时的样式；展开后的形态（现在另有一个内部频道面板） |
| 8 | **@点名发言人名字牌 + 同事提案卡** | `msg__speaker`（`:3540`）、`colleagueProposal`（`:3552`，**只有内联 style，没有类**） | ❌ | 气泡上的名字牌版式；提案卡（谁来干这活）的样子 |
| 9 | **记忆确认卡 / 待确认记忆** | `pendingMem`（12 处）+ `memList`（14 处）+ `userMemOpen` / `projMemOpen` 两个抽屉 | ❌ | 确认卡的交互（批准/拒绝/编辑）与记忆列表的层级 |
| 10 | **资料（知识）面板** | `knowledgePanel`（10 处）：上传（`knowledgeFileRef`）+ 列表 + 删除 + 上传中状态 | ❌ | 面板位置（现在在左栏底部一格）与文件行样式 |
| 11 | **登录 / 注册页（整屏）** | `AuthScreen`（`App.tsx:361-598`，13 个 state）：手机号验证码 / XYZ号+密码 / 微信（占位）三种 tab + 倒计时冷却 + 后端探测重试 + mock 验证码 | ❌ 设计里只有已登录态 | 整屏设计（这是用户见到产品的第一屏） |
| 12 | **项目切换盒** | `projectBox`（8 处）：项目列表 / 新建 / 当前项目高亮 + 账号小块 | ❌ | 位置与形态（现在挤在左栏顶部，刻意"不做视觉设计"） |
| 13 | **人设编辑 / 引导卡** | `AgentGuide`（`App.tsx:613-683`）+ `personaEdit*` + `guide__table`（名称/它是谁/怎么说话/干什么） | ❌ | 引导卡的版式（现在是 `guide__table` 表格） |
| 14 | **内部频道面板** | `channels/ChannelsPanel.tsx`（262 行）+ `channels/styles.css`（292 行） | ❌ | 面板位置；只读（DOM 里不许有输入框，已有验收钉住） |
| 15 | **聊天里的来源列表 / 引用** | `sources__*`（5 处）：域名 + 标题 + hover 下划线 | ❌ | 来源芯片的样式 |
| 16 | **深休眠占位卡** | `browser/SleepBadge.tsx` + `.browserPanel__slept*`：写明「这张页已休眠，内存已释放」+ 唤醒按钮 | ❌ | 占位卡样式（这是"省内存"这件事的唯一可见证据） |
| 17 | **求助卡（embed 模式）** | `browser/HelpCard.tsx` + `.browserLayer--embed`：把求助的那张页**看起来**嵌进聊天气泡里（用影子层，元素不动） | ❌ | 卡片外形（几何由 `HelpCard` 每帧量出来，写进 webview 内联样式） |
| 18 | **后台运行浮动小图标** | `.browserFloating`（`:3373`）：有页 + 已退出全屏时出现 | ❌ | 图标位置与点击后的动效 |
| 19 | **工作台顶栏（模式切换）** | `workbenchNav`（10 处）：💬 对话 / 🌐 浏览器（+活页数徽标 +驾驶中圆点）/ ✏️ 编辑人设 / 内部频道 入口 | ⚠️ 设计有 `top-area`（装饰性，`aria-hidden`） | 这条顶栏要不要收进设计？现在它悬在三列之上 |
| 20 | **账号小块 / 桥自检行** | `.account`（登出 / 改密码）+ `.demoOnly`（**被 CSS 藏起来**的 preload 桥自检行） | ❌ | 账号入口形态 |

## 2. 需要用户重点先拍的（其余可以跟着排）

这三条决定 M2'–M8' 能不能落地，因为它们是**布局级**的（不是配色级）：

1. **浏览器工作区放在哪**（缺口 #1）
   现在：`main.middle` 里绝对定位铺满、盖在 `.chat` 之上，`opacity` 切换（全屏/后台/嵌入三态），
   **元素永不卸载**（驾驶坐标依赖它）。设计的三列结构里没有它的位置。
   可选形态（供参考，不是我替你定）：① 中栏顶部加一排 tab、下面在有页时切走聊天区；② 右栏改成"浏览器/聊天"可切换；③ 独立第四列。
   ⚠️ 无论选哪种，**`<webview>` 的祖先链必须保持**（M0 冒烟网已钉住，见 M0 报告）。

2. **状态层挂在哪**（缺口 #3/#4/#5/#6）
   「谁在等谁」「待确认黄条」「任务卡」「头像状态圈」是同一类东西：**AI 运行时的状态可视化**。
   设计基准完全没有这一层。建议**一起拍**，否则会散落到各处、每处都要重做一遍。

3. **登录页**（缺口 #11）
   用户见到的第一屏，设计里没有。整屏设计（三种登录方式 + 冷却/重试状态）。

## 3. 我这边不受阻、可以继续做的部分

按你的切片顺序，下面这些**不需要等设计**（它们就是设计基准里已有的组件与外壳）：

- **M1'** 设计令牌（`01-tokens` + `02-base` + `99-theme`）
- **M2'** Sidebar（设计基准 125 行组件 + `06-sidebar.css` 270 行）
- **M3'** Rail（72 行 + `07-rail.css` 163 行 + `12-rail-agent.css` 147 行）
- **M4'** InputBar（148 行 + `04-inputbar.css` 350 行）
- **M5'** ChatArea（90 行 + `05-chat.css` 451 行 + `11-chat-bubbles.css` 229 行，顺带修 `.msg` 双定义）
- **M6'** Modals（137 行 + `09-modal.css` 187 行）
- **M7'** 其余 CSS（`03-frame` / `08-search` / `10-surface` / `13-settings-theme`）
- **M8'** 逻辑与状态迁移（2188 行，最重，单独一片）
- **M9'** 收口（删 `styles.css`、确认无残留引用）

—— 这些搬完之后，**缺口 #1–#20 正好就是"外壳里剩下的那堆东西"**，
那时它们的位置也会更容易谈（因为周围已经变成了设计的样子）。

## 4. 附：设计基准内部也有两处需要你确认的（不影响开工）

1. **`workbench-ui/src/data/contacts.ts` 曾经没能进版本库**（根 `.gitignore` 的 `data/` 是全局通配，
   把 `workbench-ui/src/data/` 整个吞了）→ 仓库里的 workbench-ui **编译不起来**（5 处 import 全断）。
   已修：`.gitignore` 改成 `/data/`，并**从已入库的构建产物 `dist-single/index.html` 里逐字段恢复**了
   这份数据（6 个联系人 + 9 个模型 + 中文名表），校验脚本 `scripts/verify/workbench-ui-recover-contacts.py`
   逐字段比对通过；`npm run typecheck` / `npm run build` 在 workbench-ui 里现在都是绿的。
   **若你本机的版本比那份产物新，以你本机为准，直接覆盖即可。**
2. `workbench-ui/src/lib/storage.ts` 的 `sessionStore` 目前是 `load() → []` / `save() → noop` 的占位；
   `App.tsx` 用 `localStorage`（`workbench:sessions`）自己持久化。合并时这一层会被 desktop 的真实后端取代。
