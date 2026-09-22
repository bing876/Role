# DIMSPACE 工作台 · UI-1 阶段交付报告

> 主题：三列改造（列0 项目栏 / 列1 智能体栏 / 列2 会话区）
> 验收结果：**真机 101 / 101 通过**
> 验收日志：`docs/acceptance/ui1-run.log`　截图：`docs/acceptance/ui1/*.png`

---

## 一、用户能看到的效果（逐条对照需求）

| 需求 | 实测结果 |
| --- | --- |
| 默认最左是图标栏（会话/知识库/插件） | ✅ 列0 `data-wt-rail-mode=global`，四个全局图标齐 |
| 点头像 → 切「项目列表」模式 | ✅ 显示项目图块；**不再显示全局图标与头像** |
| 当前项目带选中框 | ✅ `data-project-current` 只有当前项目为真 |
| 单击别的项目 → 只移框、不切换 | ✅ 框唯一地移到被点项目；**期间零请求**；服务端 `currentProjectId` 一点没变 |
| 双击 → 真的切换 | ✅ 列0 自动回全局图标；列1 刷新成新项目名单；发了 `POST /projects/:id/activate` |
| 双击「当前项目」→ 只收起面板 | ✅ 面板收起，且**没有重复发 activate** |
| 首次建项目 → 跳过双击直接展示 | ✅ 建完 `railMode=global`，服务端当前项目已切，列1 只有它自带的母鸡 |
| 列1 可展开/收起（72px 图标条） | ✅ 展开 270px / 收起 72px；收起只留图标（名称节点不渲染） |
| **收起后不与列0 合并** | ✅ 列0 恒 60px、仍是全局图标模式；列1 左边界 == 列0 右边界 |
| 母鸡有明显标记 | ✅ 暖色头像（`--wt-mark-grad`）+「母鸡」徽标；**收起态靠色块区分**（不依赖文字） |
| 母鸡删除按钮不可用 | ✅ **根本不渲染按钮**（不是 disabled）；后端也拦：`HTTP 400 这是项目的母鸡…不能删` |
| 列1 右上「+」能建智能体 | ✅ 建出新智能体并自动选中；请求体 `{"asAgentId":<母鸡id>}` |

### 关键截图
- `01-default.png` —— 默认态：列0 全局图标 / 列1 智能体 / 列2 空态
- `02a-single-click-moved-frame.png` —— 单击移框：选中框在「项目」上，**列1 名单没变**
- `02b-double-click-switched.png` —— 双击切换完成
- `03-collapsed.png` —— 列1 收起成 72px，列0 仍独立
- `04-regression-after-switch.png` —— 回归取证

---

## 二、技术实现

### 1. 视觉规范：89 个令牌独立成文件

`apps/desktop/src/styles/tokens.css`（**255 行**）—— 所有令牌 `--wt-*` 前缀，唯一真值来源。

- **品牌渐变已变量化**：`--wt-brand-1:#7c5cff` / `--wt-brand-2:#4f8bff` / `--wt-brand-grad`。
  原设计稿的 **24 处硬编码渐变已全部替换**，改主题只改这一个文件。
- 母鸡配色 `--wt-mark-1:#ff8a5c` / `--wt-mark-2:#ff5c8a` / `--wt-mark-grad` 同样变量化。
- 三列宽、圆角、模糊、间距、字号字重全部走令牌：
  `--wt-rail-w:60px`、`--wt-sb-w:270px`、`--wt-sb-w-collapsed:72px`、
  `--wt-blur-rail:26px`、`--wt-blur-sb:36px`、`--wt-r-sm/avatar/md/lg/frame`、`--wt-sp-1..7`。
- 深/浅主题用 `data-wt-theme='dark'|'white'` 切换；工作台作用域是 `.wtApp`，
  **登录页保持原浅色皮肤，零回归**。

### 2. 交互逻辑（本阶段核心）

- **单击 / 双击语义**用浏览器原生 `onClick` / `onDoubleClick` 实现，不自造计时器：
  单击 = `highlightProject()`（只改 `pendingProjectId`）；双击 = `switchProject()`（真的切）。
  那次附带的单击正好就是「只移框、无副作用」。
- **「没切换」的证明方式**：渲染层装了 fetch 记录器 `window.__wbReqLog`。
  单击后 `requests=[]` —— **一个请求都没发**，同时服务端 `currentProjectId` 未变。
  这比「看 UI 没变」强得多：UI 可能是假的，请求记录骗不了人。
- **母鸡保护是双层的**：前端 `isAgentLocked()` 是唯一判据（`kind==='hen' || deletable===false`），
  母鸡时**删除按钮整个不渲染**；后端独立再拦一次。两边口径同源，不会分叉。
- **列0 / 列1 永不混合**：结构上就是两个兄弟 flex 节点，各自独立宽度与背景 ——
  不存在「合并」的渲染分支。实测 x 坐标：列0 `0..60`、列1 `60..330`、列2 `330..1164`。

### 3. 状态数据结构（为后续阶段预留）

`apps/desktop/src/workbench/layoutState.ts` + `useWorkbenchLayout.ts`

```
WorkbenchLayoutState {
  mode: 'chat' | 'split' | 'browser'      ← 未来浏览器分屏/全屏就加在这里
  currentProjectId: number | null
  activeAgentByProject: Record<number, number>  ← 「每个项目记住上次的智能体」
  agentSidebar: 'expanded' | 'collapsed'
  projectSwitcherOpen: boolean
  pendingProjectId: number | null          ← 只被「单击」改，双击才清
}
```

**扩展性设计**（为什么加浏览器状态时不用重写）：

- `mode` 是三值枚举而非布尔。加浏览器分屏 = 加一个枚举值 + 在 `MODE_RULES` 表里加一行，
  **消费方读的是 `MODE_RULES[mode].xxx`，不是 `if (isSplit)`**，所以新增状态不改调用点。
  ```
  MODE_RULES = {
    chat:    { browser:false, forceAgentSidebarCollapsed:false },
    split:   { browser:true,  forceAgentSidebarCollapsed:false },
    browser: { browser:true,  forceAgentSidebarCollapsed:true  },  ← 「全屏时列1 强制收起」
  }
  ```
- **`columns` 与 `mode` 正交**：`isAgentSidebarCollapsed()` 是
  「用户手动收起 **或** 当前 mode 强制收起」——将来加「全屏时列1 缩成小圆圈」只需改规则表。
- `activeAgentByProject` 按项目分桶：本阶段只写不读（`rememberAgent` 有，`recallAgent` 未接线）。
  **结构已就位，UI-2 要做「单击只换会话、不弹列表」时直接读它，不用改数据形状。**
- 状态持久化到 `localStorage['workbench.layout.v1']`，带版本号便于将来迁移。

### 4. 代码组织（技术债处理）

**新增文件（全部独立、不再堆进 `App.tsx`）：**

| 文件 | 行数 | 职责 |
| --- | ---: | --- |
| `workbench/layoutState.ts` | 206 | 布局状态类型 + 规则表 + 持久化 |
| `workbench/useWorkbenchLayout.ts` | 157 | `useReducer` 状态机 + 动作接口 |
| `workbench/RailColumn.tsx` | 207 | **列0**：全局图标 ⇄ 项目切换 |
| `workbench/ProjectSwitcher.tsx` | 193 | 项目图块列表（单击/双击语义） |
| `workbench/AgentSidebar.tsx` | 227 | **列1**：展开收起 · 母鸡标记与删除保护 |
| `workbench/icons.tsx` | 120 | 自绘 SVG 图标 |
| `workbench/index.ts` | 52 | 模块出口（App.tsx 只从这里 import） |
| `workbench/rail.css` | 224 | 列0 样式 |
| `workbench/project-switcher.css` | 260 | 项目图块样式 |
| `workbench/agent-sidebar.css` | 329 | 列1 样式 |
| `workbench/shell.css` | 343 | 外壳骨骼 + 列2 暗色皮肤 + 设置抽屉 |
| `styles/tokens.css` | 255 | 89 个设计令牌 |
| **合计** | **2573** | |

**`App.tsx` 行数变化（你要的报告）：**

| 项 | 数值 |
| --- | --- |
| 改造前（HEAD） | **2360** 行 |
| 改造后 | **2502** 行 |
| 净变化 | **+142 行** |
| 旧 `<aside className="sidebar">` 渲染块 | **294 行 → 46 行**（净减 248 行） |
| diff 规模 | +460 / −334（改动 776 行） |

**关于「旧代码能否同步挪出去」—— 能，且已经挪了：**

1. ✅ **删掉两个 state**：`projectsOpen`、`newProjectName`（职责已归 `layoutState`）。
2. ✅ **删掉 `.projectBox` 整块 JSX**（项目列表 + 新建入口）→ 进 `ProjectSwitcher.tsx`。
3. ✅ **删掉 `.agentList` 整块 JSX**（智能体列表 + 母鸡标记 + 删除按钮）→ 进 `AgentSidebar.tsx`。
4. ✅ **删掉 `.sidebar` / `.middle` 外壳**（`styles.css` 里对应规则也移除了）。
5. ✅ **`.account` 整块（账号/密码/浏览器配置/记忆/知识库）搬进列2 的设置抽屉**
   —— 这些是「非智能体内容」，按你的规矩不该出现在列1。**这部分是 App.tsx 唯一还偏大的原因**：
   抽屉是列2 的浮层，仍由 App.tsx 渲染。它占了约 240 行，**建议 UI-3 或 UI-5 阶段
   抽成 `SettingsDrawer.tsx`**，那样 App.tsx 能回落到 2200 行左右。

**净增 142 行的构成**：设置抽屉保留在 App.tsx（~240 行）+ 三列接线与注释开销（~150 行）
− 旧左栏渲染块减少（248 行）。**不是「没拆」，是抽屉还没拆。**

---

## 三、回归验证：切项目/切智能体时，后台浏览器任务不受影响

**复用你之前要求过的「时间戳 / 日志」取证方式，规矩在新 UI 下依然成立：**

| 证据 | 实测值 | 说明 |
| --- | --- | --- |
| 内嵌页 JS 计数器在涨 | `0 → 68` | 页面**一直在跑**，没被冻结 |
| `performance.timeOrigin` 未变 | `1789684199790.4` → `1789684199790.4` | 那张页**从没被重载** |
| webview 还在 | `count=1` | 没被卸载 |
| 假模型调用持续发生 | **13 次** | 后台那一路没停 |
| 切换期间调用最大间隔 | **2514ms** | 恰是假模型 2.5s 的固有节奏，**没有一整段空白** |
| 主进程 IPC 通道 | 有响应、非报错 | 驾驶状态仍可读 |

切换动作序列：`A → B`（换项目）→ 在 B 里换智能体 → `B → A` → 在 A 里换智能体再切回。
**全部切换动作做完，上面六项证据依然成立。**

---

## 四、过程中发现并修掉的 3 个真 bug

值得单独说，因为**其中两个会「看起来完全正常」**：

### bug 1：`shell.css` 没有任何人 import（最隐蔽）

`rail.css` / `project-switcher.css` / `agent-sidebar.css` 都由各自组件 import，
**唯独 `shell.css`（`.wtApp` 三列骨骼 + 列2 暗色皮肤）漏了**。
于是 `.wtApp` 落回 `display: block`：

- 三列**上下堆叠**成白底条（列0 只 276px 高、列1 挤在它下面）
- 列2 铺满全宽、被压在下面
- 但所有「元素存在性」断言**照样全绿** —— 类名都在 DOM 里

**修法**：在 `workbench/index.ts` 里 `import './shell.css'`；并给验收脚本加守门断言
「`.wtApp` 的 computed `display` 必须是 flex」。**判据要用 computed style，不能只看类名。**

### bug 2：浮层定位祖先找错 → 「建」按钮点不到

`.wtPs__newBox` 写的是 `left: calc(var(--wt-rail-w) + 4px)`，看着是「轨道宽 + 4px」。
但它的定位祖先是 **`.wtRail` 自己（60px）**，所以 60+4 是从**轨道左边缘**算起的
→ 浮层落进列1，被列1 的头部盖住。

**症状极具误导性**：点「建」按钮**毫无反应、无任何报错**，
第一反应一定是「后端建项目失败了」，实际是**按钮根本收不到点击**。
是靠 `document.elementFromPoint` 做命中测试才定位到（返回的是 `HEADER.wtSb__head`）。

**修法**：`left: 100%` + `margin-left: 4px`（贴轨道右边缘），并给 `.wtRail` 加
`position: relative` 把参照物固定下来。

### bug 3：`backdrop-filter` 创建层叠上下文 → `z-index` 白写

给浮层写了 `z-index: 60`，**没用**。因为 `.wtRail` 有 `backdrop-filter`，
它会创建层叠上下文，于是浮层的 60 被关在列0 这一层内；
跟列1 比较时用的是「**列0 自己**」的层级（auto），而列1 DOM 在后、也有 `backdrop-filter`，
所以照样盖住。

**修法**：把 `z-index` 加在 **`.wtRail` 本身**（`z-index: 20`）。
**教训：z-index 要给「创建了层叠上下文的那一层」，给它内部的后代是无效的。**

### 顺带修的验收工具坑

- `Input.insertText` **不派发 DOM `input` 事件** → React 受控组件 `useState` 还是空串
  → 按钮一直 `disabled`，点了没反应。必须补 `dispatchEvent(new Event('input',{bubbles:true}))`。
- `Page.reload` 后缓存的目标 id 失效 → `Handshake 500 No such target id`。
  修法：失败信息带 `No such target id` 就丢掉缓存重找，重试次数 3 → 4。
- 测试手机号改为**每次运行现生成**：固定号会撞服务端 60 秒防连发（HTTP 429）。

---

## 五、明确没做的（本阶段边界）

- ❌ 浏览器面板 → UI-4。列2 目前是空态占位「暂无浏览器任务」。
- ❌ 消息流式渲染 / 输入胶囊 → UI-2。
- ❌ 建智能体的正式弹窗视觉 → UI-3（本阶段只用最简单的表单跑通链路）。
- ❌ 知识库面板 → UI-5。
- ❌ 浏览器全屏时「智能体缩成小圆圈」→ 依赖浏览器面板，排在 UI-4 之后。
  **但 `MODE_RULES` 的 `forceAgentSidebarCollapsed` 已为此留好钩子。**
- ✅ **没有改动任何已验证的后端接口** —— 只调用既有的 `/projects`、`/agents`、`/agents/:id/persona`。

---

## 六、遗留建议（不阻塞本阶段）

1. **设置抽屉（~240 行）建议抽成 `SettingsDrawer.tsx`** —— 抽完 App.tsx 能回到 ~2200 行。
2. `recallAgent`（读「上次用的智能体」）目前**只写不读**，是 UI-2 的接口。
3. 本项目**没有删项目的后端接口**，所以测试库里项目只增不减；
   验收一律用带时间戳的项目名，避免撞名。
4. 窗口窄于 `--wt-shell-min-w: 960px` 时会被 `body{overflow:hidden}` 横向裁切，
   窄屏体验待定（是否要在 <960 时自动收起列1，规则表已支持）。

---

## 七、验证方式（复现命令）

```bash
# 自带端口 8799(API) / 8899(假模型) / 5273(vite) / 9333(CDP)，不动用户的 8787/5173
C:/Users/bing/.workbuddy/binaries/python/envs/default/Scripts/python.exe \
  scripts/verify/ui1-desktop-tests.py
# 结果：101 / 101 通过
```

类型检查与构建亦通过：

```bash
cd apps/desktop && npx tsc --noEmit     # 0 错误
npm run build                            # ✓ 47 modules, css 34.54 kB, js 207.99 kB
```
