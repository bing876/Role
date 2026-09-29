# 第 26 步 · 收尾报告（问题 A/B 修复 + 搜索来源标注）

日期：2026-09-20　｜　范围：**只动"该走搜索还是该走浏览器"这一层 + 消息展示的"来源"扩展**

---

## 一、这次做了什么

| # | 内容 | 状态 |
|---|---|---|
| 1 | 修 **问题 A**：当前开着网页时，「帮我查一下今天的美元汇率」被误判成"操作当前页"→ 去驾驶浏览器 | ✅ 已修 + 验证 + 反证 |
| 2 | 修 **问题 B**：「帮我在必应上查一下…」这种"在 X 上"句式既不开页也不搜索，被当普通聊天 | ✅ 已修 + 验证 + 反证 |
| 3 | 新增 **搜索来源标注**：回答下方列出这次是从哪些网页查到的，可点击跳转 | ✅ 已实现 + 四层验证 |
| 4 | 维持已确认原则：不碰浏览器驾驶核心代码；回答语言跟随系统（现为中文） | ✅ 见第五节 |

---

## 二、问题 A / B 的修复方案

### 问题 A —— `apps/desktop/src/browser/intent.ts`（+44 行）

**根因**：`BROWSE_ACT` 里把「查一下 / 搜一下 / 帮我查」这类**要一条信息**的说法，和「滚动 / 点击 / 翻页」这类**只有在页面上才成立**的动作混在一个正则里。于是只要当前开着一张页，任何"查一下"都会被 `detectBrowseIntent` 命中 → 交给驾驶员。

**修法**：把一条正则拆成**三层判据**，按优先级判定：

1. **页面专属动作**（`PAGE_ONLY_ACT`：滚动/翻页/点击/输入框/读当前页/刷新/返回）→ 直接算页面操作；
2. **明确指了这张页**（`PAGE_REF`：这个页面 / 当前这张 / 这页 / 在这里 / 页面上 / 这个网站…）→ 算页面操作；
3. 两条都不满足、只剩「搜一下 / 查一下」这类**查资料**说法（`LOOKUP_ONLY`）→ **不是**页面操作，返回 `null`，交给联网搜索。

> **为什么页面指代词必须优先于"查资料"判定**：否则「**在这个页面**搜一下 AI」也会掉进搜索 —— 用户明明指着眼前这张页。这一条是测试逼出来的（见第四节"我自己引入的三个坑"）。

### 问题 B —— `apps/desktop/src/browser/sites.ts`（+186 行）

**根因**：`detectOpenUrl` 只认 `VERB`（打开/去/访问/浏览…）后面的目标。「帮我在**必应**上查一下」里的「在…上」不在 `VERB` 里 ⇒ 既不命中开页，也不命中"认不出"，直接落回聊天路径。

**修法**：
- 新增「在 X 上」句式识别：`在 <站点> 上 <动作>`，其中站点走**同一张登记表** `SITES` + 裸域名判定 ⇒ 「在必应上」「在京东上」都能开页；
- **同时加了两道防误报闸**（不然后果比原 bug 更糟 —— 把"漏判"换成"乱开页"）：
  - 「在**电脑/网上/线**上」这类**泛指**不算站点（`ON_SITE_GENERIC`）→ 不误开页；
  - 「我**在百度上看到**一条新闻」这种**陈述句**不算指令（`ON_SITE_NARRATIVE`）→ 不误开页。

---

## 三、验收结果（四层，全部是真实执行记录）

| 层 | 脚本 | 结果 |
|---|---|---|
| ① 桌面本地路由（真实判定函数，含 A/B 专项 + **E 组边界沉淀**） | `search-vs-browser-routing.mts` | **134 PASS / 0 FAIL**（修前 29/3，那 3 条 FAIL 正是 A、B） |
| ② 站点登记表回归 | `sites-registry-tests.mts` / `unknown-site-tests.mts` | **0 失败 / 0 失败** |
| ③ 模型决策（真 DeepSeek） | `search-tool-decision.mjs` | **45~46 PASS / 0 FAIL**（+3 INFO；偶发 1 条见 §九.4） |
| ④ HTTP 端到端（真后端 8793 + 真模型 + 真 Tavily，含 A1/B2 专项新用例） | `search-chat-e2e.mjs` | **80 PASS / 0 FAIL** |
| ⑤ 界面层（真 Electron 窗口 + 真问答） | `sources-ui-probe.py` | **38 PASS / 0 FAIL**（见 §十、§十一） |

> **收尾后一次性连跑全套**（第三轮边界修复之后）：`docs/acceptance/tavily/final-all-layers-20260920.log`
> —— ① **134/0**、①b 站点回归 **0 失败**×2、①c 接线 **10/0**、③ **45/1**→**复跑 46/0**（那 1 条是模型偶发，见 §九.4）、④ **80/0**。
> ⑤ 真 Electron 界面层 **38/0**（需真 GUI 窗口，单独一跑，证据在 `sources-ui.json` + 截图；
> 反证 `sources-ui-probe-revert.py` **四轮全 ✓**：A+B 3/3、C 2/2、还原后 0 FAIL、三文件 sha256 一致）。
> 分次跑绿不算数，这份是同一时刻的完整记录。
> §十一 之后又连跑过一次（`final-all-layers-round4.log`），数字不变，见 §八。

### 问题 A / B 的专项新用例（第 ① 层，节选真实输出）

```
A-1「帮我查一下今天的美元汇率」    → openUrl=null  browseIntent=null  ⇒ 走搜索 ✅
A-1「帮我搜一下今天的新闻」        → openUrl=null  browseIntent=null  ⇒ 走搜索 ✅
A-1「查一下碳化硅主要用在哪」      → openUrl=null  browseIntent=null  ⇒ 走搜索 ✅
A-2「在这个页面搜一下 AI」         → browseIntent≠null               ⇒ 仍是页面操作 ✅（没被"查资料"判据误伤）
A-2「往下滚一屏看看」              → browseIntent≠null               ⇒ 仍是页面操作 ✅
A-2「点一下那个按钮」              → browseIntent≠null               ⇒ 仍是页面操作 ✅
B-1「帮我在必应上查一下今天的美元汇率」→ openUrl=https://www.bing.com/   ⇒ 开页 ✅
B-1「在京东上比一下这两款耳机的价格」  → openUrl=https://www.jd.com/     ⇒ 开页 ✅
B-2「在电脑上查一下今天的新闻」    → openUrl=null  unknown=null       ⇒ 不误开页 ✅（泛指）
B-2「我在百度上看到一条新闻」      → openUrl=null  unknown=null       ⇒ 不误开页 ✅（陈述句）
```

### 端到端新增的 B2 用例（真实链路）

`--only=B2`：桌面在修好 B 之后会发的那个体（`taskMode:true` + `pageUrl=https://www.bing.com/`）

```
SSE：meta → loop → delta → done
loop 事件：[{"loopId":"loop_mu9blkj4_2","pageUrl":"https://www.bing.com/"}]
pageStates 1 → 2（服务端真的 bind 了一张页 ⇒ 证明这条才是"重型"那条）
llmCalls 6 → 6（这一轮不调模型，只写一句开场白）
search 事件：0 个（没被搜索敷衍）✅
```

### 端到端新增的 A1 用例（问题 A 的真实链路，**最关键的一条**）

问题 A 的修复分两半，必须**两半都证到**才算数：

| 半 | 谁决定 | 谁证明 |
|---|---|---|
| 桌面**不设** `taskMode`（即使眼前开着页） | 桌面本地判定 | 第 ① 层 `search-vs-browser-routing.mts`（A-1 三条） |
| 服务端拿到这个体后**不 bind 页、不建循环**，走轻量搜索 | 服务端 | 第 ④ 层 `A1` |

`A1` 发的是**桌面修好之后真会发的体** —— `pageUrl=https://www.bing.com/` + `wcId=987654323` 都带着，
**但不带 `taskMode`**：

```
--- A1（search）帮我查一下今天的美元汇率
    页面上下文：https://www.bing.com/ (wcId=987654323, taskMode=false)
SSE：meta → search×2 → …delta… → done
[PASS] A1 ★问题 A：当前正开着一张页（https://www.bing.com/）时这句仍走轻量搜索 — 搜索=2 次 / loop=0 / pageStates 0 → 0
[PASS] A1 ★问题 A：体里带着 pageUrl/wcId 也**没有**去 bind 页面 — pageStates 增量=0（期望 0）
[PASS] A1 ★ 搜索轮 → done 事件带回了来源列表 — sources=6 个
[PASS] A1 来源已去重（没有重复网址） — 6 条 / 去重后 6 条
```

> **修之前会怎样**：同一句话在开着页时被 `detectBrowseIntent` 判成"在当前页干活" ⇒ 桌面带 `taskMode:true`
> ⇒ 服务端 `bindPageLoop` + 建循环 ⇒ 去驾驶浏览器。`A1` 这两条断言（`loop=0` + `pageStates 增量=0`）
> 正是把那个旧行为钉死在这里。

### 反证（证明断言不是摆设）

| 脚本 | 注入的缺陷 | 结果 |
|---|---|---|
| `search-vs-browser-routing-revert.py` | 把 A、B 的判据改回旧逻辑 | **4/4 ✓**：A 相关 3 条 + B 相关全变红；还原后 97/0 且 sha256 一致 |
| `search-chat-e2e-revert.py` | ① `toolChoice` 恒 `'none'`（模型调不到工具）<br>② 给搜索轮注入 `bindPageLoop`<br>③ **把 `sources` 清空**（来源不下发也不落库） | **5/5 ✓**：<br>① 搜索断言 6 条红<br>② `pageStates` 断言 2 条红<br>③ **来源相关 5 条全红**（期望 5、实际 5）<br>还原后 30/0 且两文件 sha256 **逐字节一致** |

---

## 四、搜索来源标注

### 可行性评估结论：**复杂度不高，已直接实现**

理由：Tavily 返回的结果**本来就带 `title` + `url`**；缺的只是"把它从服务端带到界面并画出来"。整条链路共 **6 处小改**，没有触碰消息展示的核心逻辑（正文照旧是纯文本，来源是**新增**的一块，不是改造原有渲染）。

### 实现（6 处）

| 位置 | 改动 |
|---|---|
| `apps/server/src/db.ts` | `ALTER TABLE messages ADD COLUMN IF NOT EXISTS sources JSONB;`（幂等迁移） |
| `apps/server/src/search/chatLoop.ts` | `SearchTrace` 加 `sources`；新增 `collectSources()`（按网址去重、最多 8 条）与 `domainOf()` |
| `apps/server/src/routes/chat.ts` | 聚合去重 → **落库** → `done` 事件带 `sources` → `/chat/history` 读回 `sources` |
| `packages/shared/src/index.ts` | 新增 `ChatSource {title,url,domain}`；`ChatRow` 加 `sources?` |
| `apps/desktop/src/App.tsx` | 收 `done.sources` → 挂到那条消息上 → 气泡下方渲染 `<a href target="_blank" rel="noreferrer noopener">` |
| `apps/desktop/src/styles.css` | `.sources` / `.sources__item` / `.sources__title` / `.sources__domain`（+67 行） |

**三个刻意的设计决定（都在代码注释里写明理由）**：

1. **必须落库**，不能只在内存里过一下。桌面流式结束后是**本地追加消息**、切会话才重拉 `/chat/history` —— 不落库的话来源标注一切走会话就没了。
2. **点击走系统默认浏览器**，用 `<a target="_blank">` 触发主进程第 17 步就装好的 `setWindowOpenHandler → shell.openExternal`。**零主进程改动**，也不碰工作台内置浏览器那条链路（这是遵守"不碰浏览器代码"约束的直接结果）。
3. **`sources` 存明文 JSONB，不加密**：内容是**公开网页地址**（不是用户隐私），且界面要直接渲染；**搜索词 `query` 刻意不入库**（可能含用户隐私）。

### 界面层验收（真 Electron 窗口 + 真问答，`sources-ui-probe.py`）

**38 PASS / 0 FAIL**（含 §十新补的 hit-test 与"刷新后仍在"，§十一新补的"真点击 → 系统浏览器真的取走 url"）。
真实 DOM 读数：

```
走搜索的一轮「今天有什么新闻」：
  消息数=2（助手 1）  来源块=1  条目=8 条
  · 【新聞第一線】重大突發！川普下令驅逐CNN 怒批假新聞  [ntdtv.com]  https://www.ntdtv.com/…
  · 賴總統：兒童氣候建言納政策 環境部3個月後追蹤       [rti.org.tw]  https://www.rti.org.tw/…
  · 今天起 装修、交物业费都能用这笔钱了                [yzwb.net]   https://www.yzwb.net/…

断言（全部 PASS）：
  ★ .sources 存在且非空
  ★ 8 条全是 <a href="https://…">（真外链）
  ★ 全部带 target="_blank"（点击才会走 setWindowOpenHandler → 系统浏览器）
  ★ 全部带 rel="noreferrer noopener"
  ★ 标题 + 域名都渲染出来了（不是空壳）
  ★ 有实际可见尺寸 316×20（不是 display:none / 0×0）
  ★ cursor: pointer（看得出来能点）
  ★ 标签就是「来源」

凭常识的一轮「1加1等于几」：
  来源块总数仍是 1（没跟着涨）⇒ 常识问答不会被挂上"参考资料" ✅
  助手消息数 1 → 2 ⇒ 证明这一轮真的答了（不是"没搜就没回复"）
```

**截图**：`docs/acceptance/tavily/sources-ui-20260920.png`（本轮已 present 给用户）

### ✅ 连"点下去之后系统浏览器有没有真的弹出来"也验了（见 §十一）

第一版我把它写成"机器验不了、请你自己点一下"。**回头看这是偷懒——它能验，而且能验到底**：
把某条来源的 href 临时改写到本机一个一次性 HTTP 服务，再按完整鼠标序列真的点它，
那个服务**真收到请求**（实测 300ms）⇒ 整条链路通。**§十一 有完整做法与反证。**

⚠️ 副作用：验收过程中系统默认浏览器会弹出一个小标签页（写着"可以关掉"）。

---

## 五、隔离确认（零交集）

**本次改动只在这些文件**：

```
新增  apps/server/src/search/{tavily,chatTool,chatLoop}.ts
新增  apps/server/src/language.ts
改   apps/server/src/{db,env}.ts · routes/chat.ts
改   packages/shared/src/index.ts
改   apps/desktop/src/App.tsx · styles.css
改   apps/desktop/src/browser/{intent,sites}.ts     ← 方案 C 明确授权的两个文件
改   apps/server/.env.example
新增  scripts/verify/{search-chat-e2e.mjs, search-chat-e2e-revert.py, search-vs-browser-routing.mts,
                     search-vs-browser-routing-revert.py, search-tool-decision.mjs,
                     search-hint-wiring-check.mjs, sources-ui-probe.py}
```

**一行未动的（`git diff` 全空）**：

- `apps/desktop/electron/driver.ts`、`apps/desktop/electron/agent.ts`（**驾驶核心**）
- `apps/desktop/src/browser/BrowserPanel.tsx`、`useBrowserWorkspace.ts`、`webview.d.ts`
- `apps/server/src/toolLoop.ts`、`routes/loop.ts`、`routes/agent.ts`、`pageState.ts`、`promptPolicy.ts`

即：**浏览器驾驶循环、浏览器面板 UI、页面任务那条路，一行都没碰**。改的只有"判定该走哪条路"这一层（`intent.ts` / `sites.ts`）。

**语言原则**：`apps/server/src/language.ts` 是**唯一真相来源**，现恒 `zh-CN`；规则明确"跟随系统语言，**不跟随提问语言、也不跟随搜回来的资料语言**"。以后加语言切换只改 `currentReplyLanguage()` 一处。**没有**写任何"搜索翻译"专用规则。

---

## 六、计划外需要你拍板的三件事

| # | 事项 | 我的取舍 | 请你确认 |
|---|---|---|---|
| 1 | **正文里的引用角标**（像 ChatGPT 那样在正文插 `[1][2]`，点角标跳到对应来源） | **没做**。它需要模型在正文里按约定输出编号 + 桌面把编号链接化，改动面比"下方列表"大一个量级；而且模型偶尔会编错编号，反而降低可信度 | 需要的话我另起一小步做 |
| 2 | **点击跳转用系统默认浏览器**（而非工作台内置浏览器） | 选了**系统默认浏览器**。理由是"不碰浏览器相关代码"这条硬约束；用内置浏览器就得调 `openBrowser` 通道 | 若你更希望在工作台内打开，请说明 |
| 3 | **来源存明文 JSONB**（正文仍是密文 `content_enc`） | 明文。内容是公开网址、界面要直接渲染 | 若你要求"一切入库内容都加密"，我可以改成密文列 |

---

## 七、主观体验项（需要你亲自打开应用看）

自动化只能证明"这行真的渲染出来了、真的是可点的外链"，**证明不了好不好看**。请重点看：

1. **来源块的视觉密度**：8 条来源挤成 3~4 行小字挂在回答下方，会不会显得"尾巴太长"？要不要限制成最多 5 条 + 「展开更多」？
2. **分隔与层次**：现在是一条虚线分隔 + 「来源」小标签 + 每条「标题（蓝） 域名（灰）」。层次够清楚吗？还是该再淡一点/再明显一点？
3. **标题截断**：单条标题最长 260px，超出用省略号。你看到的标题是否被截得太狠？
4. ~~**点击跳转**：系统浏览器有没有真的弹出那个网页？~~ → **已机器验过**（§十一：浏览器真的取走了 url）。
   仍然只有你能判的是**跳转的观感**：新标签页是抢到前台还是安静开在后台、焦点跟不跟过去、
   连点两条时会不会连开两片 —— 这些"顺不顺手"机器说不上来。
5. **和「正在搜索」那行提示的配合**：搜索期间显示「正在搜索：xxx」，回答写完后来源块出现。节奏顺不顺？

---

## 八、残留与收尾核查

- ✅ 源码 / `dist` 无残留注入（`grep REVERT-INJECT` 全空）
- ✅ 8793 / 8799 / 5273 / 9333 / 8911 端口已释放；测试账号已删（users 级联），活库 `users` 数量未增长（66）
- ✅ 临时文件已删（`scripts/verify/_tmp-smoke.mts`、两个一次性补丁脚本）
- ✅ 行尾统一：`*.ts/tsx/css` = CRLF（本轮发现 `intent.ts`/`sites.ts` 被写成 LF，已修并复查 12 个改动文件）
- ✅ **收尾后一次性连跑全套**：`docs/acceptance/tavily/final-all-layers-20260920.log`（134/0 · 46/0 · 80/0）
- ✅ **§十一 之后再连跑一次全套（本轮改动全部落地后的最终快照）**：
  `docs/acceptance/tavily/final-all-layers-round4.log` —— ① **134/0**、①b 站点回归 **失败项 0**×2、
  ①c 接线 **10/0**、② 真模型 **46/0**、③ HTTP 端到端 **80/0**；⑤ 界面层单独一跑 **38/0**。
  分次跑绿不算数，这份是同一时刻的完整记录。
- ✅ 两处反证在改动后**重跑仍成立**：`search-vs-browser-routing-revert.py` **5/5 ✓**（新增注入 C）、`search-chat-e2e-revert.py` 5/5 ✓
- ✅ **安装版已换装**（你确认后执行）：`%LOCALAPPDATA%\Programs\@ai-workbenchdesktop\resources\app.asar`
  旧 5,510,110 B → 新 5,515,537 B，sha256 `b1248eb6…b235f`；
  换装自检 **63/63 ✓**（含第 26 步新增 7 条）、回头读安装目录那份再验 **23/23 ✓**、
  HTTP Cache 已清（Cache 5.7MB + GPUCache 1.6MB 让位，登录态未动）、启动确认 **8/8 ✓**。详见 §十二。
  ⚠️ 换装时杀掉了正在运行的应用进程 —— **请重新双击桌面「AI 工作台」**。

---

## 九、收尾补做：三轮对抗扫描（**超出简报**，自己找自己修）

A/B 这类**纯字符串判定**代码，最怕的不是"没修好"，而是**改出新误判**。
所以我又自己做了三轮对抗扫描，每轮压一个轴。**临时脚本跑完已删**，
已判定的用例全部**沉淀进 `search-vs-browser-routing.mts` 的 E 组**（永久回归）。

### 9.1 三轮扫描与抓到的东西

| 轮次 | 压什么轴 | 抓到 | 处置 |
|---|---|---|---|
| 1 | 「在 X 上」+ 陈述 / 泛名词 | 未发现新缺陷（原有 B-2 已覆盖） | — |
| 2 | 「读 / 看 + 对象」的指代 | ★ `在厨房里看看有什么吃的` → 报「我认不出『厨房』是哪个网站」<br>★ `在这台电脑上打开设置` → 报「我认不出『打开设置』是哪个网站」<br>★ `读一下《三体》第一章讲了啥` → 判成**页面操作**（会去驾驶浏览器）<br>★ `在沙发上躺一会儿` → 报「我认不出『躺一会儿』是哪个网站」 | **全部修复** |
| 3 | 否定 / 疑问 / 极短 / 中英混合 / 标点 | ★ 光敲一个 `上`（或 `去`）→ **弹出一张浏览器主页** | **已修复**；另 3 类带设计取舍，**只报告不动手**（见 9.3） |

### 9.2 本轮修了什么（3 处，全在 `apps/desktop/src/browser/` 两个文件里）

1. **`sites.ts` · 「不是站点名」的词表补物理场所/家具**
   （`厨房 卧室 客厅 房间 床上 桌上 沙发上 公园 超市 商场 医院 学校 图书馆 地铁 …`）。
   ⚠️ 只放**位置无关的场所/物品**，真站名靠登记表命中，不靠这里放行。
2. **`sites.ts` · 新增 `ON_SHAPE`（句式形状短路）** —— 这是**类级根因**：
   `VERB` 里有一个**裸「上」**（因为「上淘宝看看」是真用法）。于是**任何**「在 X 上…」句子，
   只要没被 `ON_SITE_VERB` 认定成指令，就会掉进动词路径、被那个「上」咬住，
   剥出「上」**后面**那截当目标 ⇒ 报出「我认不出『躺一会儿』是哪个网站」。
   **正解不是往词表里加词**，而是：形状成立就**不再走动词路径** —— 那个「上」是句式的一部分。
3. **`sites.ts` · `OPEN_VERB_ONLY`** —— `if (!site) return HOME_URL` 原本无条件执行，
   光敲一个「上」/「去」（剥出空目标）会弹浏览器主页。改成只在**明确开页动词**
   （`打开|开启|启动|访问|浏览`）下才落主页。反向保护：`打开` 仍落主页（`E-7` 有一条专门断言）。

### 9.3 只报告、不动手的 3 类（都**带设计取舍**，按规矩等你拍板）

| # | 现象 | 为什么不能简单改 |
|---|---|---|
| 1 | **否定句**：`不要打开百度` / `别打开抖音` → **仍会开页** | 加否定词表会让 `不要打开百度，打开必应` 这种**复合指令**的后半句也发不出车。要改就得先定义"否定作用域" |
| 2 | **疑问**：`打开百度是什么意思` → **仍会开页** | 看起来该按疑问放过，但「是什么意思」同时是**页面操作**的常见说法（`读一下这是什么意思` = 读当前页）。加进 `looksLikeQuestion` 会把后者一起掐掉 |
| 3 | **英文指令**：`open baidu` → 会开页 | ★ **这条不是缺陷**：`VERB` 里本来就有 `open\|go to\|load`，是第 24 步**有意支持**的 |

> 这三条已作为 **`E-6` 已知边界**（INFO，不断言）写进永久脚本，日后回归时一眼能看到现状。

### 9.4 第 ③ 层那条偶发 FAIL（**不是产品 bug**）

首次全量跑时 `#5 不夹整句外文` 红了一次，原因是模型在调用 `web_search` 前夹了一句
英文填充语 `I'll look that up for you.`。核查结论：
- 提示词**已经**明确写了"连开场白、过渡句、总结句也必须是简体中文"，还带了同款例子 ⇒ **不是缺条款**
- 工具描述本身是中文、且明确要求"用系统当前语言" ⇒ **不是诱因**
- 频率实测：连跑 **3 轮 × 6 题（28 断言/轮）全绿**；首次全量 11 题出现 1 次 ⇒ 约 **1/24 ≈ 4%**
- **处置**：按"模型非确定性 ⇒ 单次不算"的口径，**不改代码**，如实报告频率。
  如果你希望"零容忍"，可选加一道**确定性兜底**（回答里检出整句外文就重试/剔除）——那属于新功能，等你定。

### 9.5 反证也扩了一条

`search-vs-browser-routing-revert.py` 现在有**三项注入**，全部 ✓：

| 步骤 | 注入的缺陷 | 实际 |
|---|---|---|
| ① 基线 | 不动 | 134/0 ✓ |
| ② 注入 A | `intent.ts` 撤掉「查资料 vs 页面操作」分流 | A-1 三条指定用例变红 ✓ |
| ③ 注入 B | `sites.ts` 撤掉「在 X 上」识别（两处） | B-1 五条 + B-3 两条 + **E-1「在沙发上躺一会儿」** 变红 ✓ |
| ③.5 注入 C | `sites.ts` 撤掉「空目标只在开页动词下才落主页」 | **E-7「上」「去」** 变红 ✓ |
| ④ 还原 | 撤掉全部注入 | 134/0，两文件 **sha256 逐字节一致** ✓ |

★ 注入 B 能带出 `E-1`、注入 C 能带出 `E-7` —— 说明**新沉淀的边界断言不是摆设**。

### 9.6 隔离确认（本轮）

本轮改的只有 `apps/desktop/src/browser/{intent.ts,sites.ts}`（"该走搜索还是该走浏览器"这一层）
+ `scripts/verify/search-vs-browser-routing.mts`（沉淀用例）+ 反证脚本锚点同步。
`apps/desktop/electron/**`（含 driver、主进程驾驶循环）、`apps/server/src/**` 的 `git diff` **全空**。

---

## 十、收尾补做二：界面层补两条硬断言 + 界面层反证

上一版 `sources-ui-probe.py` 是 26 PASS / 0 FAIL，但主观体验项里「点击跳转是否正常」
被我判成"机器没验"。回头看这条**其实能验一半** —— 而且是最容易出问题的那一半。

### 10.1 新补的 5 条断言（界面层 26 → 32）

| # | 断言 | 为什么需要 |
|---|---|---|
| 1 | `★ 每条来源的中心点真的点得到（hit-test 命中自己）` | 「有 href + 是 `<a>`」只证明**长得像链接**。`document.elementFromPoint(中心点)` 命中自己（或其子节点）才证明**点得动** —— 没被别的元素盖住。这是"点了有没有反应"最接近的机器判据 |
| 2 | `★ 每条来源都在视口内` | 配 ① 用：排除"点不到只是因为它在屏幕外"这种**假红**（读 DOM 前先 `scrollIntoView`） |
| 3 | `★ 刷新后应用重新起来 + 自动恢复历史消息` | 刷新后走 `/chat/history` 还原 |
| 4 | `★ 刷新后来源块仍在（证明来源真的落了库）` | 桌面流式结束后是**本地追加消息**（不重拉 history），切会话/刷新才走 history。来源只下发不落库的话，"一切走会话就没了"。HTTP 层已断言过（`search-chat-e2e.mjs` 3.4/3.5），这里补**真实界面**那一半 |
| 5 | `★ 刷新后来源与刷新前逐条一致（同 url 同序）` | 同上，逐条比对 |

**真实执行记录**（真 Electron 窗口 + 真模型 + 真 Tavily）：
```
PASS  ★ 每条来源的中心点真的点得到（hit-test…）:: 命中样例：SPAN.sources__title / 未命中 0 条
PASS  ★ 每条来源都在视口内 :: 视口内 8/8 条
PASS  刷新后应用重新起来（输入框回来了）:: 耗时 1070ms
PASS  刷新后自动恢复了历史消息（走 /chat/history）:: 耗时 20ms
    刷新后：消息数=2 来源块=1 首条=https://military.china.com/news/13004177/20260920/49753462.html
PASS  ★ 刷新后来源块仍在（证明来源真的落了库，不是只在内存里过了一下）:: blockCount=1
PASS  ★ 刷新后来源与刷新前逐条一致（同 url 同序）:: 前 8 条 / 后 8 条，首条 一致
```

### 10.2 界面层反证（成立）

`scripts/verify/sources-ui-probe-revert.py`（同一支脚本内做 A/B/C；**当时的数字是 32/0**，
§十一 之后探针扩到 38 条，四轮反证重跑见 §十一.2）：

| 步骤 | 注入 | 实际 |
|---|---|---|
| ① 基线 | 不动代码 | **32/0** ✓（当时） |
| ② 注入 A | `styles.css` 给 `.sources__item` 加 `pointer-events: none`（元素还在、还有尺寸、还是 `<a>`，但 hit-test 不再命中） | `★ 每条来源的中心点真的点得到` 变红 —— `命中样例：DIV.sources__list / 未命中 8 条` ✓ |
| ② 注入 B | `chat.ts` 的 `/chat/history` 不再回传 `sources`（落库照旧，只掐"读回来"这一环） | `★ 刷新后来源块仍在`（blockCount=0）+ `★ 刷新后来源与刷新前逐条一致`（8 → 0）变红 ✓ |
| ③ 还原 | 撤掉全部注入 | **32/0**，两文件 **sha256 逐字节一致** ✓（当时） |

- ★ 注入 B 刻意选 `/chat/history` 而不是落库那一步：这样**只**打掉"刷新/切会话后还在"这一条，精准命中、不连累其它断言。
- 另有 1 条**级联红**：`★ 常识轮的回复没有来源块`（`搜索轮后=1 → 常识轮后=0`）—— 它是第 4 节拿"刷新后的 0"去和"搜索后的 1"比，属于注入 B 的连带效果，**不是独立缺陷**。这也说明"阈值要精确点名"是必要的：写成"整组全红"就会被这条级联干扰。

### 10.3 这一轮踩到的坑（**全是我脚本/环境自己的问题**，不是产品缺陷）

1. ★★ **失败行格式有两种，别照抄**：`*.py` 探针用 `FAIL  <名字> :: <细节>`，`*.mts/.mjs` 脚本用 `[FAIL] <id> — <细节>`。
   我第一版照抄了 `.mts` 那份 ⇒ 抓不到任何失败行 ⇒ 报出"明明 4 FAIL，却说 0 条变红"。**极易误判成"断言是摆设"。**
2. ★★ **Electron 必须显式 `--no-sandbox`**：`start-electron.mjs` 自带回退，但**只在"启动 15 秒内崩 + 退出码 0x80000003"** 才触发。实测遇到过"跑起来之后**中途** GPU FATAL"（`GPU process isn't usable. Goodbye.`），回退不会触发 ⇒ 登录后 CDP 握手 `Connection timed out`。**极易误判成"探针坏了"。**
3. ★★ **截图必须放在 `location.reload()` 之前**：reload 让 CDP 的 page target 换血，之后 `Page.captureScreenshot` 稳定 `WebSocketTimeoutException`。现象是"功能断言全绿、只有截图红" ⇒ **极易误判成"来源渲染有问题"**。已挪到 3.2 并加 3 次重试。
4. ★ **连跑多次探针之间要清残留 + 沉降 6 秒**（`taskkill /F /IM electron.exe`），否则上一轮的 GPU 子进程会带崩下一轮。

### 10.4 隔离确认（本轮）

改的只有 `scripts/verify/{sources-ui-probe.py, sources-ui-probe-revert.py}`（验收脚本）+ 反证期间临时改过又还原的
`apps/desktop/src/styles.css`、`apps/server/src/routes/chat.ts`（**sha256 复核逐字节一致**）。
`apps/desktop/electron/**`、`apps/server/src/toolLoop.ts` 等驾驶链路仍是一行未动。

---

## 十一、收尾补做三：把「点击之后系统浏览器有没有真的弹出来」也变成机器可验

§十 之前，我在第四节末尾写了一句话：**"这一条请你自己点一下确认（这本来就是主观体验项）"**。
**这是偷懒 —— 它能验，而且能验到底。** 这一节把它补上，界面层断言 32 → **38**。

### 11.1 做法：让"系统浏览器真的来取这个 url"这件事留下一个可查的痕迹

难点在于：主进程 `shell.openExternal(url)` 之后，浏览器在**应用外面**打开，
界面层读不到任何 DOM 证据。解法是**把目标换成本机一个一次性 HTTP 服务**：

1. 探针起一个 `http.server`（端口从 8911 起找空位），只做一件事：把收到的 path 记下来；
2. 取第一条来源，**只改它的 `href`** 指向 `http://127.0.0.1:<port>/srcclick<ts>`
   —— `target` / `rel` **一律不动**，走的仍是真实那条路；
3. 用**完整鼠标序列**真的点它：`mouseMoved → mousePressed(buttons=1) → mouseReleased(buttons=0)`
   （★ 只发 press/release **打不开** `target=_blank`，这是踩过的坑）；
4. 那个一次性服务**真收到请求** ⇒ 证明整条链路是通的：
   `点击 → 主进程 setWindowOpenHandler → shell.openExternal → 系统默认浏览器真的取了这个 url`。

这比"DOM 里长得像链接"强一个量级：它证明的是**浏览器进程真的发起了这次取数**。

**真实执行记录**（真 Electron 窗口 + 真点击 + 真系统浏览器）：

```
PASS  本机一次性探针服务已起（用来接住"系统浏览器真的来取 url"那一刻） :: port=8911
PASS  点击之前探针服务没收到过请求（下面那条是这次点击带来的，不是残留） :: 点击前命中数=0
    待点元素：{'x': 306, 'y': 403, 'w': 252, 'h': 20, 'target': '_blank',
               'rel': 'noreferrer noopener',
               'href': 'http://127.0.0.1:8911/srcclick1789885466',
               'orig': 'https://military.china.com/news/13004177/20260920/49753462.html'}
PASS  ★ 点击前 href 已改写到本机探针服务，但 target/rel 原样没动
PASS  真点了一下（完整鼠标序列 mouseMoved→Pressed→Released） :: clicked at (306,403)
PASS  ★ 点击来源后，系统默认浏览器**真的取走了这个 url** :: 收到 /srcclick1789885466（300ms）
PASS  ★ 点完之后应用没被顶掉（仍在应用里，说明 will-navigate / deny 生效）
      :: href=http://localhost:5273/ input=True msgs=4
```

点击后 **300ms** 收到请求。最后一条是**对照项**：证明外链是"弹出去了"，
而不是把工作台这个页面顶掉（`will-navigate` 那道闸也顺带被验到）。

⚠️ **副作用**：这一步会真的弹出一个系统浏览器标签页（页面写着"这是验收探针的临时页面，可以关掉"）。

### 11.2 反证（四轮，全 ✓）

`scripts/verify/sources-ui-probe-revert.py` 扩成**四轮**，新增的注入 C **单独占一轮**：

| 轮次 | 注入 | 结果 |
|---|---|---|
| ① 基线 | 不动代码 | **38/0** ✓ |
| ② A + B | `pointer-events:none` + `/chat/history` 不回传 sources | **31/7**，期望的 3 条**全变红** ✓ |
| ②b **C 单独一轮** | `App.tsx` 把来源的 `target="_blank"` 改成 `"_self"` | **35/3**，期望的 2 条**全变红** ✓ |
| ③ 还原 | 撤掉全部注入 | **38/0**，三个文件 **sha256 逐字节一致** ✓ |

```
[2b] FAIL  ★ 每一条都带 target="_blank" :: target=['_self']
     FAIL  ★ 点击前 href 已改写到本机探针服务，但 target/rel 原样没动 :: target=_self
     FAIL  ★ 点击来源后，系统默认浏览器**真的取走了这个 url** :: 25s 内没等到请求 ⇒ 那一跳没走通
     受影响的断言：期望 2 条变红，实际 2 条 → ✓ 全变红
```

- ★★ **为什么 C 必须单独一轮**：A（`pointer-events:none`）会让点击根本到不了 `<a>`。
  如果把 C 和 A 塞进同一轮，"点击那条变红"就说不清是 A 造成的还是 C 造成的 ——
  **反证要一次只动一个变量**，否则证明力打折。
- 第 ② 轮里另外 2 条是 **B 的级联**（history 不回传 sources ⇒ 第 5 节压根没有 `.sources__item`，
  于是"没有可点的元素"），不是独立缺陷。
- 注入 C 之后「点完之后应用没被顶掉」**仍是绿的** —— 它是对照项：
  同标签页导航被 `will-navigate` 拦掉了，所以应用当然没被顶掉。这正是"阈值要精确点名"的用处。

### 11.3 这一轮踩到的坑

1. ★★ **heredoc 里写多段 Python 字符串极易漏 `+` / 漏转义**，而且 `py_compile` 只报第一行 ⇒
   一次修一个错、跑一遍，能拖五六轮。**正解：补丁写成独立 `.py` 文件**，
   长文本用**三引号真换行**（不做 `"…" + LF` 拼接），一次性过。（本轮实测：拼接写法 3 处错，
   改三引号后 6 个锚点一次全中。）
2. ★ **`Edit` 工具的显示会吃掉反斜杠** —— 屏幕上看着是 `,\" + LF`，实际字节是
   `,\\" + LF`，照着改必然改不动。判据只能靠 `repr(bytes)`。
3. ★ **反证脚本的"还原后指纹"字典漏加新文件** ⇒ 跑完四轮才在最后一行 `KeyError` 崩掉，
   结论行和日志都没写出来。★ 教训：**加注入点就要同步加"开工前/还原后"两处指纹**。

### 11.4 隔离确认（本轮）

只改了验收脚本 `scripts/verify/{sources-ui-probe.py, sources-ui-probe-revert.py}`；
反证期间临时改过的 `apps/desktop/src/{styles.css, App.tsx}`、`apps/server/src/routes/chat.ts`
**全部还原，三个文件 sha256 与开工前逐字节一致**。
`apps/desktop/electron/**`（驾驶链路）仍是一行未动。
端口 8799 / 5273 / 9333 / 8911 已释放，无 electron 残留，无临时脚本。

---

## 十二、安装版换装（你确认后执行）

### 12.1 换了什么

| 项 | 值 |
|---|---|
| 目标文件 | `%LOCALAPPDATA%\Programs\@ai-workbenchdesktop\resources\app.asar`（桌面「AI 工作台」快捷方式实测指向这份） |
| 旧 → 新 | 5,510,110 B → **5,515,537 B** |
| sha256 | `b1248eb6dacc51afa5d7a8e9ec9ed72ea9a630435eeaf3622738951b819b235f` |
| 旧包归档 | `_rollback-backup-20260918\app.asar.old-search-sources-s26` |
| 备份 | `resources\app.asar.bak-search-sources-s26-pre` |

**回滚方法**：把 `app.asar.bak-search-sources-s26-pre` 覆盖回 `resources\app.asar` 即可（然后重启应用）。

### 12.2 三道验证（缺一不可）

| 层 | 做法 | 结果 |
|---|---|---|
| ① 换装自检 | `.workbuddy-ai/swap-dist.mjs`：官方 `@electron/asar` 整包 `extractAll → 改 → createPackage`；非零比例 / canary(`sources__item`) / 条目数 >100 三道保险，外加**装进去的产物与刚构建的逐字节一致** | **63/63 ✓**（含第 26 步新增 7 条） |
| ② 回头读安装目录那份 | `scripts/verify/verify-installed-asar.mjs`（读的是用户双击时真正加载的那个文件，不是解包临时目录） | **23/23 ✓** |
| ③ 真启动 | `scripts/verify/installed-s26-check.py`：`--no-sandbox` 起安装版 → CDP 读页面实际加载的 CSS | **8/8 ✓** —— 页面 `index-DCIV0FFJ.css` 里真的有 `.sources__item` / `.sources__label` |

④ **安装版回归**（证明换包没带坏旧功能）：`scripts/verify/installed-app-probe.py`
  —— 自己起假模型 + 真后端 + **已安装的应用**，走真实短信登录，再验第 25 步核心行为：
  ① 默认全屏 ② 层铺满中栏 ③「退出全屏」文案 ④ webview 真实尺寸 ⑤ 全屏时无后台小图标
  ⑥ 退出后出现小图标 ⑦ 不可见但仍在渲染（opacity=0、display 不是 none）⑧ 退出后尺寸不变
  ⑨ ★AI 自己开新页**不把用户拽回全屏** ⑩ 后台态小图标仍在
  ⑪ ★需要用户亲自处理时**会**拉回全屏 ⑫ 拉回后小图标消失 —— **全通过**，脚本打印「全部通过」。

**另外清了 HTTP Cache**（这一步漏了前面全白做：Electron 会复用旧 CSS，文件对了界面也可能不变）：
`Cache` 5.7 MB、`GPUCache` 1.6 MB 让位并重建空目录；**`Local Storage` 等登录态一律没动**。

### 12.3 这一轮踩到的坑

1. ★★ **`electron-builder` 在本机跑不通**，两条路都堵死：
   - `--win nsis` 下载 NSIS 组件时 `502 Bad Gateway`；
   - `--dir`（不下载 NSIS）又卡在 `EPERM: rename win-unpacked.tmp -> win-unpacked`（沙箱挡 rename）。
   两条都试过、换全新输出目录也没用 ⇒ 改走 §1.5 的「官方 asar 库整包重打包」路线。
2. ★★ **读 asar 内文件时偏移要 +3**：按 `16 + headerSize` 算出来会读到 `map"use strict";`
   这种错位内容（前 3 字节是头部填充）。第一版因此误判成"`dist-electron/main.js` 和本地不一样"，
   差点连主进程一起换（主进程其实**逐字节相同**）。**判定"哪块变了"之前先确认读法是对的。**
3. ★ `git diff` 显示 `packages/shared` 改了 19 行，但**全是类型**（`interface ChatSource`），
   运行时产物没变 ⇒ `node_modules/@ai-workbench/shared` 不用动。**看 diff 要分类型和运行时。**
4. ★ 换装前 `taskkill` 才发现**应用其实一直在跑**（第一次用 `tasklist /FI` + `grep 工作台` 没查到，
   是 GBK 编码导致的假阴性）。

### 12.4 ⚠️ 需要你做的两件事

1. **重新双击桌面「AI 工作台」** —— 换装时把正在运行的进程杀掉了（旧进程内存里还是旧代码，
   不重启就永远看不到新界面）。
2. 登录后随便问一句「今天有什么新闻」，看**回答下方有没有出现「来源」那一行、点一条会不会跳浏览器**。
   这是唯一需要你亲眼确认的部分（机器验的是"链路通"，不是"好不好看"）。
