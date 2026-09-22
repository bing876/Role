# 第 25 步 · 全屏浏览器 + 后台运行 —— 交付报告

> 目标：把浏览器从「贴边固定面板」改成「占满中栏会话区的全屏模式」，
> 并支持「退出全屏后浏览器继续在后台跑，用右下角小图标随时回来」。
> 本阶段只验证**功能逻辑**，不做视觉精修。

**本次（2026-09-20 06:2x）补做的两件收尾 + 两个产品决定落地，全部完成：**

| 项 | 结果 |
| --- | --- |
| 决定1（只有需要用户亲自处理才拉回全屏） | 已实现（改 1 处）并**在正式安装版里验证通过** |
| 决定2（不保留「收起变矮」中间态） | **无需改动** —— 当前就是「全屏 / 后台」两态 |
| 换装到正式安装版 | 已完成：asar 逐字节一致 8/8、功能指纹 0 缺失 |
| 安装版功能确认 | **29 PASS / 0 FAIL** |
| git 提交 | 已提交（见第六节，含 ref 丢失自查） |

---

## 〇、★ 本轮最值得你看的一条：顺手发现并修掉了一个**已交付功能的回归**

**症状**：内嵌页里点 `target=_blank` 链接（搜索结果、视频标题那种）**什么都不发生**。

**根因**：`BrowserPanel.tsx` 里 `<webview allowpopups />` 写成了**裸布尔**。
React 18 对**未知标签**上的布尔属性**不写进 DOM** —— 实测 `hasAttribute('allowpopups')` = **false**。

**为什么后果这么重**：Chromium 的弹窗拦截发生在**进主进程之前**。属性丢了 ⇒ 弹窗被直接挡掉 ⇒
主进程的 `setWindowOpenHandler` **一次都进不去**（electron.log 里连一行 `[webview] target=_blank` 都没有）⇒
第 23 步交付的「页里点开链接 → 真开一条 tab」**在真机里从来没生效过**。

**证据链**（不是推测）：
1. 验收日志里 `webview allowpopups = False`；
2. 同一轮的 electron.log 里 `target=_blank` **零命中**，tab 数 1 → 1（等满 25 秒）；
3. 改成字符串后：`allowpopups = True` → **67ms 内真开出第二条 tab**（1 → 2）；
4. 反证⑥（把字符串改回裸布尔）→ 该断言**立刻变红**。

**修法**：`allowpopups={'true' as unknown as boolean}`。
- 为什么必须显式收窄：JSX 上这个属性来自 `@types/react` 的
  `WebViewHTMLAttributes.allowpopups?: boolean`（本目录 `webview.d.ts` 里那份在 `jsx: react-jsx` 下**并不生效**），
  它声明成布尔，但**运行时布尔会被丢掉** —— 类型与运行时不一致，只能在这里收窄。
- `apps/desktop/src/browser/webview.d.ts` 里本来就写着 `allowpopups?: string` —— 字符串才是原意。

> ⚠️ 这条改变了**用户可见行为**：以前「点了没反应」，现在会**真的新开一条 tab**
> （但仍按决定1 不把你从后台拽回全屏）。
> 我判断这是「把已交付功能修回可用」而不是新的产品决定（step-3 验收报告里就写明过
> 「webview 不带 `allowpopups` 时，这个请求根本到不了主进程」），所以直接修了。
> **如果你认为不该恢复这个行为，告诉我，我改回去。**

---

## 一、决定1 的实现（只改了一行）

**唯一改动**：`useBrowserWorkspace.ts` 的 `openFromPage()`（内嵌页 `target=_blank` / `window.open` 的落点）
**不再** `setView('fullscreen')` —— 只开页、不动视图。

### 为什么其它 4 处 `setView('fullscreen')` 必须保留

| 位置 | 被谁走到 | 判定 |
| --- | --- | --- |
| `activate()` | ① 用户自己点 tab ② 主进程「把视线给这张页」（`workbench:browser:focus`，**敏感字段等待就走它**）③ 用户把验证码打进聊天被本地闸拦下后我们主动把页面给他看 | **需要用户亲自处理 → 保留** |
| `openUrl()` | 点「＋」、认不出的开页指令（开起始页 + 聚焦地址栏）、当前智能体还没页时的聚焦、主进程发来的 `open` | **用户明确要浏览器 → 保留** |
| `focusUrlBar()` | 地址栏聚焦（面板可见时才触发） | 保留 |
| `closeAllTabs()` | 一张页都不剩 → 层整体卸载 | 保留（无副作用） |

### 关键链路（我实际核对过代码，不是照简报猜的）

- **敏感字段等待**：`main.ts sensitiveHold()` → `sendToMainWindow('workbench:browser:focus', wcId)`
  → 渲染层 `focusByWebContents(wcId)` → `activate()` → **拉回全屏** ✔（决定1 的"该拉回"那一半）
- **AI 自己开新页**：主进程 `setWindowOpenHandler` 命中 http → 推 `workbench:browser:opentab`
  → 渲染层 `openFromPage()` → **不再动 view** ✔（决定1 的"不打扰"那一半）
- **AI 的 `open_url` 动作**：driver 直接让内嵌页导航（不新建 tab、不经过渲染层）→ **本来就不打扰**

### 决定2：无需改动

当前只有「全屏 / 后台」两态，没有中间档位；`showFullscreen()` / `exitFullscreen()`
**只改 `view` 一个 state**（不调 `agentStart`/`agentStop`/`agentDrop`、不改 `sleep`、不动 webview）。
原「收起（180px 半高）」态在上一轮就已移除，本轮**没有加回来**。

---

## 二、改了哪些文件

| 文件 | 改动 | 行数 |
| --- | --- | --- |
| `apps/desktop/src/browser/useBrowserWorkspace.ts` | 状态模型 `expanded` → `view: 'fullscreen' \| 'background'`；新增 `showFullscreen()`/`exitFullscreen()`；**本轮：`openFromPage` 去掉 `setView('fullscreen')`**（含决策注释） | +76 / −14 |
| `apps/desktop/src/App.tsx` | `.browserLayer` 包裹层（driveBar + BrowserPanel）+ 右下角「后台运行中」小图标 | +40 / −18 |
| `apps/desktop/src/styles.css` | `.browserLayer` / `.browserLayer--bg` / `.browserFloating`；`.middle` 定位上下文；`.chat`/`.inputBar` 提到 z-index 10 | +67 / −0 |
| `apps/desktop/src/browser/BrowserPanel.tsx` | 面板铺满层、「收起/展开」→「退出全屏」；**本轮：`allowpopups` 修回字符串（见第〇节）** | +32 / −5 |
| `apps/desktop/src/browser/styles.css` | 舞台由固定 `180px / 56vh` 改为 `flex:1` 铺满 | +14 / −7 |
| `scripts/verify/run-pause-resume.py` | 修既存 bug：用了 `re` 却没 `import re` | +1 |

**没有碰任何驾驶核心**：`driver.ts` / `agent.ts` / 主进程驾驶循环 / `sleepPolicy` 判断规则一行未改。

### 核心思路（三层解耦）

1. **布局层**：`.middle` 变定位上下文，`.browserLayer` 用 `position:absolute; inset:0` 铺满中栏会话区（左栏完全不受影响）。
2. **视图层**：全屏 ↔ 后台 **只换一个 CSS 类**。后台态是
   `.browserLayer--bg { opacity: 0; pointer-events: none; z-index: 0 }` ——
   **面板照旧挂载、webview 照旧真实尺寸、渲染照旧在跑**，只是看不见、点不到。
3. **状态层**：`showFullscreen()` / `exitFullscreen()` **只改 `view` 一个 state** ——
   所以「退出全屏」在物理上不可能影响正在跑的任务。

### ★ 关键约束的落实

- **绝不用 0 尺寸 / `display:none`**：后台态用的是本目录里**已经验收过**的同一套机制
  （`.browserPanel__view--off` 对"别的智能体的页"就是这么做的）。实测退出前后 webview `944×595` **完全一致**。
  原因：驾驶的点击坐标来自页内 `getBoundingClientRect`，尺寸归零会让坐标全部失效。
- **既有安全网一条没削弱**：`sleepPolicy` 的 driving 红线、主进程对 driving 页拒绝节流、
  `BrowserPanel` 深休眠的 `!drivingIds.includes(id)` 硬拦 —— 全部原样保留。

---

## 三、验证结果（真机取证）

### ① 源码验收（dev + 源码）：**54 PASS / 0 FAIL**，编号断言 **①~㉚ 全绿**

`scripts/verify/fullscreen-browser-tests.py`（自己起假模型 + 假站点 + 验收后端 + vite + 真 Electron）

| 段 | 内容 | 关键读数 |
| --- | --- | --- |
| A（①~⑧） | 全屏能显示、能操作 | 层矩形 `{x:220,y:0,w:944,h:721}` == `.middle` 矩形；真输入 `q='人工输入测试'`；真点击 `clicks=1` |
| B（⑨~⑲） | 退出全屏后任务继续跑 | 退出后 **8.2s** 页面出现「已加入购物车：无线鼠标 旗舰款 ×1」；模型提问 `3 → 6` 次且退出后的时间戳均晚于退出时刻；webview `wcId 3→3`、尺寸 `944×595` 不变 |
| C（⑳~㉔） | 小图标重新展开 | 同一实例、尺寸未变、读到后台跑出来的最新状态（非白屏/旧快照）；最终 `phase=done` |
| **D（㉕~㉚）** | **决定1 的两半** | ㉕㉖㉗ 后台态下 AI 真开出新 tab（`1→2`，67ms）且**仍留在后台**；㉘㉙㉚ 主进程「把视线给这张页」→ **拉回全屏** |

### ② 反证：**6/6 缺陷全部被抓到，源码 sha256 全部还原一致**

`scripts/verify/fullscreen-browser-revert.py`（在**真实源码**上注入缺陷 → 跑 → 期望变红 → 立刻按原始字节还原）

| 注入的缺陷 | 期望变红 | 实际变红 |
| --- | --- | --- |
| ① 后台态改用 `display:none` | ⑬⑭ | ⑬⑭⑮ + **㉗**（webview 变 `0×0`） |
| ② 退出全屏顺手 `agentStop()` | ⑯⑰⑱ | ⑯⑰㉓（页面停在「（还没有搜索）」，退出后提问 0 次） |
| ③ 小图标点了回不去 | ⑳ | 「已回到全屏」超时 |
| ④ **AI 开新页又拽回全屏** | ㉕ | **㉕㉖** |
| ⑤ **敏感等待也不拉回全屏** | 「敏感字段等待那条通道」 | 该步超时变红 |
| ⑥ **`allowpopups` 改回裸布尔** | 「真的新开了一条 tab」 | 该步超时变红（`1 → 1`） |

每个缺陷跑完都 `sha256` 一致还原 ✔，脚本结尾还有一道双保险（`[还原校验] 全部源文件 sha256 与开工前一致 ✔`）。

### ③ ★ 正式安装版确认：**29 PASS / 0 FAIL**

`scripts/verify/installed-app-probe.py`（跑的是 `%LOCALAPPDATA%\Programs\@ai-workbenchdesktop\AI 工作台.exe`
里那份**已安装的 app.asar**，不是 dev 源码；用独立临时 profile，**没动你的真实数据目录**）

| 断言 | 读数 |
| --- | --- |
| ① 默认全屏（层不带 `--bg`） | `browserLayer` |
| ② 层铺满中栏 | `middle` 与 `layer` 都是 `{x:220,y:0,w:944,h:721}` |
| ③ 按钮文案 | 「退出全屏」 |
| ④ webview 真实尺寸 | `944×595` |
| ⑥⑦⑧ 退出全屏 | 出现「🌐 浏览器后台运行中」；`opacity=0`、`display=flex`；尺寸一点没变 |
| **⑨⑩ AI 自己开新页** | **真开出第二条 tab（1→2，72ms）且仍带 `--bg`（不打扰）** |
| **⑪⑫ 需要用户亲自处理** | **拉回全屏、小图标消失** |

### ④ 换装校验

- `node .workbuddy-ai/swap-dist.mjs`：装进去的 `app.asar` = **5510110 B**，
  `sha256 = cd5c9d9d379ee4b2…`，旧包已归档为 `app.asar.old-no-pullback-r10`
- `node .workbuddy-ai/verify-asar.mjs`：**逐字节一致 8/8**、功能指纹缺失 0 项
- `node .workbuddy-ai/asar-token-check.mjs`（本轮新增）：`listPackage` 112 条、
  装进去的渲染层 bundle 里 **`allowpopups:"true"` 在位、旧写法 `allowpopups:!0` 已不存在**
  → 证明「装进去的那份含本轮新代码」（不只看哈希一致）
- `node .workbuddy-ai/clear-cache.mjs`：清了 3 个缓存目录，**Local Storage（登录态）未动**

### ⑤ 回归：暂停/继续完整验收 —— **70 PASS / 0 FAIL**

`scripts/verify/run-pause-resume.py`（原样调用既有验收脚本，8 个 section 全过）。本次改动**没有破坏任何已验收的核心功能**。

### ⑥ 类型检查 / 生产构建

`npm run typecheck -w @ai-workbench/desktop` 与 `npm run build -w @ai-workbench/desktop` 均通过。

---

## 四、计划外发现 / 需要你决策的问题（先汇报，不自己定）

1. **★ `allowpopups` 回归**（第〇节）—— 已修。**若你认为不该恢复"AI 点链接真开 tab"，告诉我改回去。**
2. **既存 bug（已修）**：`scripts/verify/run-pause-resume.py` 缺 `import re`，导致它在**内层测试跑完之后**
   打印统计时崩溃（回归结果其实已产出，只是包装层挂了）。**注意：这个脚本必须用 venv 的 python 跑**
   （`.../python/envs/default/Scripts/python.exe`），否则内层会因缺 `websocket` 而失败。
3. **我的反证/验收工具本轮踩过的坑（都已修，过程留证）**：
   - 第一次反证写回源码把 `styles.css` 的 CRLF 变成 LF → `sha256` 校验当场报"还原失败"并中止；
     已按字节修回，反证脚本改成**按原始字节读写**（本轮新加的缺陷也走同一套）。
   - 我用 `window.open` 触发新开 tab 时被 Chromium 弹窗拦截挡掉（假红），
     改成**真鼠标序列**（`mouseMoved → mousePressed(buttons=1) → mouseReleased(buttons=0)`）才通。
   - 补跑基线日志时，上一轮的基线进程还活着（占着 8894），我又对**同一个日志文件**重定向 →
     日志被交叉写坏（84 个 NUL 字节、同时含 FAIL 与 PASS 结论）。已确认旧进程结束后重跑，如实记录。
   - 安装版探针第一次起不来：本机 Chromium 的 GPU 沙箱起不来（`FATAL:gpu_data_manager_impl_private.cc`），
     加 `--no-sandbox` 解决（与 `apps/desktop/scripts/start-electron.mjs` 的回退同一原因）。

---

## 五、自动化测不出、需要你亲自体验判断的主观项

请打开**正式安装版**（桌面快捷方式那个「AI 工作台」），重点看：

1. **全屏 ↔ 后台切换的那一帧**：有没有明显卡顿/闪烁？尤其面板从 `opacity:1` 切到 `0` 的瞬间。
2. **退出全屏后聊天区"突然露出来"**：没有过渡动画，观感是否自然、会不会显得突兀。
3. **全屏后 webview 从 180px 变成铺满中栏（实测 944×595）**：页面观感是否合适？会不会显得空/拉伸。
4. **右下角小图标**：样式/位置/存在感是否合适（我按"不挡操作"做的，**完全没做视觉设计**）。
5. **后台运行时小图标的信息量够不够**：现在只写「🌐 浏览器后台运行中」，没有进度/步数。
6. **AI 开新页时的"安静"程度**：你在后台态时，AI 自己开新页**完全不打扰**；
   而遇到验证码/敏感字段时**会把你拉回全屏**。这两种打断的边界符不符合你的直觉？
7. **左侧图标栏 + 智能体列表在全屏时**是否仍然好用（切智能体时浏览器会跟着换桶）。

---

## 六、git 提交

- 分支：`arena/01a09b16-work123`（**分支名含 `/`** —— 本仓有"提交后 ref 丢失"的老问题）
- 已加自动防呆：`core.hooksPath = scripts/git/hooks`（`post-commit` 会调 `ref-guard.sh` 自查并自动修复）
- 提交后自查：`git log -1` + `git show-ref` 复查 ref 是否真的落盘（见提交后的终端输出）

---

## 七、证据文件

| 文件 | 内容 |
| --- | --- |
| `docs/acceptance/fullscreen-browser/run-baseline.log` | 源码验收（54 PASS / 0 FAIL，①~㉚） |
| `docs/acceptance/fullscreen-browser/revert-1..6.log` | 六次反证的完整日志（含变红明细） |
| `docs/acceptance/fullscreen-browser/run-revert.log` | 反证总控输出（6/6 抓到 + 还原校验） |
| `docs/acceptance/fullscreen-browser/run-regression.log` | 暂停/继续回归（70 PASS / 0 FAIL） |
| `docs/acceptance/installed-app/run.log` | **正式安装版**功能确认（29 PASS / 0 FAIL） |
| `docs/acceptance/installed-app/installed-app.log` | 安装版主进程日志 |
| `scripts/verify/fullscreen-browser-tests.py` | 源码验收脚本（30 条编号断言） |
| `scripts/verify/fullscreen-browser-revert.py` | 反证脚本（6 个缺陷） |
| `scripts/verify/installed-app-probe.py` | **安装版确认探针**（本轮新增） |
| `.workbuddy-ai/asar-token-check.mjs` | 安装包内「本轮新代码 token」核对（本轮新增） |
