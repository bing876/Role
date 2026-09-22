# BUG_LIST.md — AI 工作台 · Bug 清单（分级）

> 生成日期：2026-09-21
> 来源：`ARCHITECTURE_REVIEW.md` 的静态代码全量梳理
> 分级口径：
> - **P0** = 阻塞核心功能（用户报的「AI 打开浏览器后不执行操作」的**直接成因**，或安全/数据风险）
> - **P1** = 影响体验（功能能用，但会静默失败、误判、或让用户以为坏了）
> - **P2** = 优化项（健壮性、可维护性、观感打磨）
>
> ⚠️ **重要前提**：本次为**静态审查**，未做真机复现。P0-1 / P1-1 / P1-2 **三条独立原因链对用户的观感完全一致**，实际命中哪一条需真机日志确认。**不要只修一条就宣布好了。**

---

## P0 · 阻塞核心功能

### P0-1 ★ 发车判定依赖纯本地正则白名单，覆盖不足时静默降级为「普通聊天」

| 项 | 内容 |
|---|---|
| **问题描述** | 用户下达浏览器任务时，`App.tsx` 用三个**纯本地正则**判定「这句话要不要发车」：`openUrl`（站点名/开页句式）、`goNow`（命中确认话术后回「继续/可以」）、`browseGoal`（`detectBrowseIntent` 动作动词白名单）。**三者全空 ⇒ 不携带 `taskMode:true`** ⇒ 服务端走普通聊天分支，而该分支的工具表**只有 `web_search`**，结构上不可能操作浏览器。用户看到 AI「嘴上答应」却「手上不动」。 |
| **涉及文件** | `apps/desktop/src/App.tsx:1928-1993`（判定）、`:2102-2122`（发车三判定）、`:2149`（请求体）、`apps/desktop/src/browser/intent.ts:28-29`（`BROWSE_ACT`）、`:74`（`EXTERNAL_OBJ`）、`:95-105`（`detectBrowseIntent`）、`apps/desktop/src/browser/sites.ts`（`detectOpenUrl`）、`apps/server/src/routes/chat.ts:336`（`taskMode` 分支）、`:490`（工具表隔离注释） |
| **复现路径（推断）** | 在已打开的任意页面上输入**不含白名单动词**的自然语言任务，例如：<br/>· `帮我下单`（无「点/填/搜/读/滚」等动词）<br/>· `诊断一下我的店铺`（会被 `EXTERNAL_OBJ` 的「我的」排除）<br/>· `把这个页面上的商品整理一下`（「整理」不在 `BROWSE_ACT`）<br/>· 任意 >120 字的任务描述（`detectBrowseIntent` 的 `t.length > 120` 直接 `null`）<br/>预期：AI 回一段「好的我来帮你」，会话里再无下文，页面纹丝不动。 |
| **初步修复建议** | **不要继续扩正则**（永远追不上措辞）。推荐改为**服务端能力协商**：<br/>① 桌面把「这句话 + 当前是否有活页」原样上报，由服务端（已有模型）裁决是否进入任务态；<br/>② 或保留本地正则作为**快速路径**，但增加「未命中且当前有活页 ⇒ 带 `taskMode:true` 交给服务端判断，服务端认为不是任务则回落普通聊天」的兜底（成本 = 一次模型调用，可用小模型/规则影子判断）；<br/>③ 最小改动版：把 `taskMode:true` 的**默认值从「否」改成「有活页时是」**，由服务端 `advanceInner` 首格自行判断「无需浏览器则直接 `stop reason=done` 并回落聊天」。<br/>④ 短期止血：在 `App.tsx:1993` 后加一条日志，落盘「三判定结果 + 是否带 taskMode」，先量化命中率。 |
| **证据等级** | **高**（代码路径完整、服务端注释 `chat.ts:490` 明确写下「浏览器那套工具不在这条路上」；且 `App.tsx:2015-2034` 的注释**自己承认这是「本轮要修的 bug 的根因」**，只是修复只覆盖了「步数上限后的继续」一种措辞） |

### P0-2 ★ 任务轮的执行过程在会话里完全不可见（用户无法区分「在跑」与「卡住」）

| 项 | 内容 |
|---|---|
| **问题描述** | 任务轮（`taskMode`）的 `/chat/stream` 在 `sse(res,'loop',…)` + 一句开场白 + `sse(res,'done',…)` 之后**立即 `res.end()`**。此后主进程循环产出的所有事件（`kind:'note'`、步骤摘要、`kind:'ask'` 问话、失败提示）走的是**另一条通道** `workbench:browser:agent`（浏览器工作区面板），**不会进入会话气泡**。结果：用户看到的会话是「我在这张页上动手了，做完把结果给你」——而这句话是服务端**模板文案**（`chat.ts:364`），**不是真实执行记录** —— 然后长时间空白。 |
| **涉及文件** | `apps/server/src/routes/chat.ts:336-383`（taskMode 分支，`res.end()` 位置）、`apps/desktop/electron/main.ts:1120`（`emitAgent` → `workbench:browser:agent`）、`apps/desktop/src/App.tsx:2190-2240`（只读 SSE）、`apps/desktop/src/browser/useBrowserWorkspace.ts`（步骤流落点） |
| **复现路径** | 任意能成功发车的任务（例如「打开某站并点第一个结果」），把会话面板置于前台、切走浏览器面板，观察：会话里除开场白外**永远不会有新内容**，即便循环正在正常跑。 |
| **初步修复建议** | 三选一：<br/>① **推荐**：任务轮 SSE **不立刻 `res.end()`**，保持长连，把主进程的步骤/note/ask 通过服务端转推为 `event: note` 帧（需要一个「桌面 → 服务端 → SSE」的回推口，例如 `POST /agent/loop/note`）；<br/>② 桌面侧直接把 `workbench:browser:agent` 事件**同时**写入当前会话气泡（渲染层已有 chat patch 能力，成本最低，但绕过服务端历史落盘）；<br/>③ 至少在会话里加一个「执行详情 →」的折叠入口，把浏览器面板的步骤流**镜像**一份进度条/当前步数到会话。 |
| **证据等级** | **高**（`chat.ts` 的 `res.end()` 与 `emitAgent` 的目标通道在代码上是两条互不相交的路径；开场白文案为服务端硬编码模板，已核对） |

### P0-3 敏感/高风险闸的上游依赖：`type` 动作找不到输入框时会**自动改用搜索框兜底**

| 项 | 内容 |
|---|---|
| **问题描述** | `agent.ts` 的 `tool` 分支里，`type` 动作若找不到目标输入框，会走 `searchKeyword(goal)` + `searchUrl(kw)` **自动兜底成 `open_url`**。这是一个善意的自愈，但它的副作用是：**「本来要往敏感字段里填东西」的意图可能被重定向到站内搜索**，导致行为与用户/模型意图不符；同时因为动作类型从 `type` 变成了 `open_url`，**`typeSensitiveGuard` 不再有机会触发** ⇒ 敏感申报可能被绕过（此处不构成泄密，但会让「申报」这一确定性闸产生漏报）。 |
| **涉及文件** | `apps/desktop/electron/agent.ts`（`tool` 分支内 `type` 的兜底逻辑）、`apps/desktop/electron/driver.ts:1302`（`typeSensitiveGuard`）、`:1336`（`payClickGuard`） |
| **复现路径** | 模型发出 `type` 且目标选择器在页面上不存在（页面改版/加载未完成），同时该字段名命中 `SENSITIVEISH_RE`。预期观察：动作被改写成 `open_url` 并导航到站内搜索结果页，**没有**出现敏感申报卡。 |
| **初步修复建议** | 在兜底**之前**先跑一次敏感判定：若原 `target`/`text` 命中 `SENSITIVEISH_RE`，**禁止兜底**，直接返回 `risk:'sensitive'` 或 `ok:false` + 明确错误；兜底改写 `open_url` 时也在 `DriveResult` 里带一个 `rerouted: true` 标记，便于审计。 |
| **证据等级** | **中**（代码路径确认存在；是否为真实泄密风险需真机验证 —— 当前判据只能证明「申报可能漏报」，不能证明「敏感信息被误填」） |

---

## P1 · 影响体验

### P1-1 ★ 模型第一格不调工具 ⇒ 循环静默挂起在 `waiting`

| 项 | 内容 |
|---|---|
| **问题描述** | `advanceInner` 里 `calls.length === 0` 的处理是 `status='waiting'` + `kind:'say'`（等用户说话）。若模型在任务首格只回一句礼貌话（「好的，我来帮你看」）而不调任何工具，循环就停在等待态。叠加 P0-2（该 `say` 在任务轮无可见通道），表现与「卡住」**完全无法区分**。 |
| **涉及文件** | `apps/server/src/toolLoop.ts:967+`（`advanceInner`，`calls.length === 0` 分支）、`apps/server/src/toolLoop.ts`（`LOOP_TOOLS` + `LOOP_SYSTEM_PROMPT`）、`apps/server/src/llm.ts`（`toolChoice: 'auto'`） |
| **复现路径** | 任意任务，观察首格服务端日志：若返回无 `tool_calls`，则循环进入 `waiting` 且界面无任何提示。 |
| **初步修复建议** | ① 首格（`session.step === 0` 或消息里还没有任何 tool 消息）时对模型调用使用 `toolChoice: 'required'`（强制出工具）；<br/>② 或提示词加硬约束 + **一次自动重试**：`calls.length === 0` 且是首格 → 追加一条 system 消息「你现在必须调用一个工具或调用 stop(reason=done)」重试一次，仍为空才降级为 `say`；<br/>③ 无论哪条，`say` 必须**有可见通道**（依赖 P0-2 修复）。 |
| **证据等级** | **中**（分支逻辑确认；命中频率未实测） |

### P1-2 ★ 20 秒执行超时会把慢站误判为失败，且「超时 ≠ 动作未执行」

| 项 | 内容 |
|---|---|
| **问题描述** | `agent.ts` 用 `Promise.race` 给每次 `exec` 套 `EXEC_TIMEOUT_MS = 20_000`。慢站（导航 + 首屏 > 20s）被判 `res.ok=false`；`fails` 累计到 `FAILS_BEFORE_ASK = 2` 就 `ask` + `reason:'consecutive_failures'` 停住。更麻烦的是**超时不代表动作没发生**（MEMORY.md 已记录的 `TOOL_OUTCOME_UNKNOWN`：`CDP_TIMEOUT_MS=8s` 先到会记成失败，但点击**确实发生了**）⇒ 下一格可能**重复点击**。 |
| **涉及文件** | `apps/desktop/electron/agent.ts:134`（`EXEC_TIMEOUT_MS`）、`:121`（`FAILS_BEFORE_ASK`）、`:495-510`（`Promise.race` 与错误文案）、`:616`（`fails >= FAILS_BEFORE_ASK` 触发 `ask`）、`apps/desktop/electron/driver.ts`（`CDP_TIMEOUT_MS = 8s`） |
| **复现路径** | 在首屏资源多、加载慢的站点上执行 `open_url` / `click`，观察 20s 后出现「这一步 20 秒没有完成（页面可能卡住了或一直没加载完）」，随后连续两次即停。 |
| **初步修复建议** | ① **区分语义**：超时单独用 `res.timeout = true`（或 `error.code = 'TIMEOUT'`）标记，**不计入 `fails`**，也不直接 `ask`；<br/>② 超时后**先重新读一次页面**（`read_page`）判断动作是否实际生效，再决定是否重试；<br/>③ 按动作类型分档超时（`open_url` 给 45~60s，`click`/`type` 给 15~20s，`read_page` 给 10s）；<br/>④ 超时后的重试必须**幂等保护**（同一 `(action, target)` 在超时窗口内不重复执行）。 |
| **证据等级** | **高**（常量与 `Promise.race` 位置已核对；`TOOL_OUTCOME_UNKNOWN` 有历史真机证据） |

### P1-3 `prepareDrive` 拿不到 `wcId` 时静默不发车

| 项 | 内容 |
|---|---|
| **问题描述** | `prepareDrive()` 在 `awaitWebContentsId(tabId)` 返回非数字时，只 `setChatNote('这张页还没准备好（拿不到内嵌页句柄），没有发车。')` 然后 `return`，`drive` 保持 `null`。用户只看到一句灰色提示，**任务被静默丢弃**，没有重试入口，也不影响后续对话状态（用户会以为任务还在跑）。 |
| **涉及文件** | `apps/desktop/src/App.tsx:2066-2086` |
| **复现路径** | 在深休眠页（`sleepOf(tabId) === 'deep'`）被唤醒后极短时间内发车，或 `<webview>` 尚未 attach 时发车。 |
| **初步修复建议** | ① 改为**显式失败**：红色错误条 + 「重试」按钮，而不是 `chatNote`；<br/>② 自动重试：`awaitWebContentsId` 加轮询退避（例如 5 次 × 300ms）再判失败；<br/>③ 记结构化管理状态（这条任务 `failed`），而不是仅一条文案。 |
| **证据等级** | **高**（代码路径明确） |

### P1-4 `loop` 事件丢失时的兜底不覆盖「流被掐断」场景

| 项 | 内容 |
|---|---|
| **问题描述** | 服务端建了循环但 `event:loop` 未送达（老后端 / SSE 被网络层掐断 / 代理截断）时，渲染层唯一的兜底是**流正常结束后**的 `if (pendingDrive() && !sawLoop) launch();`（`App.tsx:2236`）。若 `reader.read()` 抛异常，会走 `catch`（`:2251`），**兜底不执行** ⇒ 服务端留下一个**孤儿循环**（要等 10 分钟 TTL 回收），用户侧任务彻底丢失。 |
| **涉及文件** | `apps/desktop/src/App.tsx:2190-2260`（读取循环 + `catch`）、`apps/server/src/toolLoop.ts`（`LOOP_TTL_MS = 10min`）、`apps/server/src/routes/loop.ts`（`/agent/loop/start`） |
| **复现路径** | 在 `taskMode` 请求发出后、SSE 读取过程中断开网络（或让代理提前关闭连接）。预期：会话提示「连不上后端」，但服务端已存在一个 `running` 的循环。 |
| **初步修复建议** | ① 把 `launch()` 兜底挪进 `finally`（并加「本次确实发过 taskMode」的条件）；<br/>② 或改为**由桌面先建循环**（`POST /agent/loop/start` 在发 `/chat/stream` 之前或同时），SSE 只负责话术与 `loopId` 的对齐，彻底消除「服务端建了但桌面不知道」的窗口；<br/>③ 服务端增加**孤儿循环主动回收**（无 `next` 心跳超过 N 秒且从未被推进过 ⇒ 立即回收，而非等 10 分钟）。 |
| **证据等级** | **中**（路径确认；真实网络条件下触发概率未实测） |

### P1-5 `pauseDriving()` / `resumeDriving()` 已由 preload 暴露，但渲染层无任何调用点

| 项 | 内容 |
|---|---|
| **问题描述** | `preload.ts` 的 `WorkbenchBridge` 白名单里暴露了 `pauseDriving()` / `resumeDriving()`，但在 `apps/desktop/src/` 全目录 grep **零命中**。也就是说：用户**没有**「暂停正在跑的驾驶」的 UI 入口。同时 `App.tsx` 的「暂停/继续」走的是 `task:pause` / `task:resume` 这条**另一套** IPC。两套接口并存且一套是死代码。 |
| **涉及文件** | `apps/desktop/electron/preload.ts`（白名单）、`apps/desktop/src/App.tsx:2340-2500`（走 `pauseTask`/`resumeTask`）、`apps/desktop/electron/main.ts`（两套实现） |
| **复现路径** | 全目录 grep `pauseDriving` → 0 命中（本次审查已执行）。 |
| **初步修复建议** | ① 要么补上 UI 入口并把 `pauseTask`/`resumeTask` 收敛掉，要么删除 `pauseDriving`/`resumeDriving` 白名单项；<br/>② **不要两套并存** —— 现在两套的语义差异（`pauseDriving` 只置本地门 vs `pauseTask` 还会向服务端 `/agent/loop/pause` 并取基线快照）是隐性 bug 温床。 |
| **证据等级** | **高**（grep 结果为空，可直接复核） |

### P1-6 `task:pause` 与 `runToolLoop` 之间存在「每格才检查」的暂停竞态窗口

| 项 | 内容 |
|---|---|
| **问题描述** | `runToolLoop` 只在**每一格的开头/结尾**检查 `isPaused()`；而 `task:pause` 是「置本地暂停门 + 调服务端挂起」的异步过程。两者之间存在一个窗口：本格的动作已经发出、暂停请求尚未生效 ⇒ **暂停后仍可能执行 1 个动作**。对于点击类动作，这可能意味着「我已经按暂停了它还是点了」。 |
| **涉及文件** | `apps/desktop/electron/main.ts`（`workbench:task:pause` 处理，约 :465）、`apps/desktop/electron/agent.ts`（`for(;;)` 内两次 `isPaused()` 检查点） |
| **复现路径** | 在长任务运行中精确时机按下暂停，观察此后是否仍有 1 次 `drive()` 调用（需日志）。 |
| **初步修复建议** | ① 暂停请求改为**可抢占**：`drive()` 执行前再查一次 `pausedOf(wcId)`（`driver.ts` 已有 `PAUSED_BLOCKED` 闸，确认它对所有动作名都覆盖，而不只是危险动作）；<br/>② 或对「点击/输入」类动作加一个**取消信号**（`AbortSignal`），暂停时立即中断在途的 CDP 调用。 |
| **证据等级** | **中**（结构上存在窗口；实际后果需真机验证） |

---

## P2 · 优化项

### P2-1 `LOOP_TOOLS` 的 `toolChoice:'auto'` 不强制工具调用
- **涉及**：`apps/server/src/llm.ts`、`toolLoop.ts`
- **建议**：见 P1-1 的 ①。非首格可保持 `auto`，首格建议 `required`。
- **证据等级**：中

### P2-2 `staleClicks` 会被 `read_page` 清零 ⇒ 「连点 3 次无变化」安全闸在真实节奏里几乎碰不到
- **涉及**：`apps/desktop/electron/agent.ts`（`staleClicks` 累加与清零）、`driver.ts`（`readSnapshot` 返回 `noChange`）
- **说明**：这是 MEMORY.md 已记录的已知结论。真实循环里「点击 → 读页面 → 点击」很常见，`read_page` 一来就把计数清零。
- **建议**：把「无变化」判定从**计数器**改为**按 `(action, target)` 的短期去重**（同一目标 N 秒内重复点击且页面签名未变 ⇒ 触发），不依赖连续计数。
- **证据等级**：高（历史已实证）

### P2-3 `advanceInner` 的 `kind:'say'` 与 `kind:'ask'` 语义边界不清
- **涉及**：`apps/server/src/toolLoop.ts:967+`
- **说明**：`say` = 模型主动说话（等用户），`ask` = 需要用户决定。两者在 UI 上应展示得不一样（`say` 是对话、`ask` 是需要行动），但当前任务轮都没有展示通道（P0-2）。修复 P0-2 时建议**同时区分这两种样式**。
- **证据等级**：中

### P2-4 `LOOP_SYSTEM_PROMPT` 的 13 条规矩里没有「首格必须先读页面」的约束
- **涉及**：`apps/server/src/toolLoop.ts`
- **说明**：当前提示词已删掉「一轮最多走几步」的表述，但也没有要求「动手前先 `read_page`」。对于「打开后立即盲点」的场景，先读一次页面能显著降低误操作。
- **建议**：首格若为 `click`/`type` 且本会话尚无任何 `read_page` 记录 ⇒ 提示词或服务端**强制先插一次 `read_page`**。
- **证据等级**：中

### P2-5 `EXTERNAL_OBJ` 会误伤含「我的/你的」的正常页面任务
- **涉及**：`apps/desktop/src/browser/intent.ts:74`
- **说明**：`EXTERNAL_OBJ = /[《》]|(我的|你的)|资料|论文|笔记|日记|邮件|代码|简历|课本|教材|文献/`。`诊断一下我的店铺` 会因「我的」被判为「外部对象」⇒ 不是页面操作 ⇒ 不发车。这个正则的**本意是排除「读一下《三体》第一章」这类**，但「我的」粒度太粗。
- **建议**：把「我的/你的」从 `EXTERNAL_OBJ` 拆出来，只在**同时命中 `LOOKUP_ONLY`** 时才排除（即「我的」+「查/搜」才算查资料，单纯的所属代词不算）。
- **证据等级**：高（正则可直接推演）

### P2-6 `detectBrowseIntent` 的 120 字硬上限会挡掉正常的长任务描述
- **涉及**：`apps/desktop/src/browser/intent.ts:97`（`if (!t || t.length > 120) return null;`）
- **说明**：「诊断店铺：检查商品标题、价格、库存、评价，把问题列出来」这类描述很容易超 120 字。超长句一律不发车是**太粗的闸**。
- **建议**：改为「超长句 ⇒ **一定**交给模型裁决」（正好与 P0-1 的服务端协商方案一致），而不是直接 `null`。
- **证据等级**：高

### P2-7 服务端唯一执行入口 `drive()` 的能力清单缺少显式契约导出
- **涉及**：`apps/desktop/electron/driver.ts:1874`、`packages/shared/src/index.ts`（`BrowserActionType`）
- **说明**：`LOOP_TOOLS`（服务端）与 `BrowserActionType`（shared）是两份手工维护的工具/动作清单，新增工具时容易漏改一侧。
- **建议**：从 `BrowserActionType` 派生服务端工具表的**可用子集**，或加一条断言测试确保二者一致。
- **证据等级**：中

### P2-8 `pageState.ts` / `pageDelta.ts` 的关键词字面匹配在多语言页面下可能失效
- **涉及**：`apps/server/src/pageState.ts`、`pageDelta.ts`
- **说明**：本次未逐行审查（已确认职责）。若其依赖中文字面匹配做「页面元素重要性排序」，英文/其他语言站点的效果会退化。
- **建议**：留待云端审查者确认。
- **证据等级**：低（未审读，仅标记）

---

## 附：三条原因链的症状对照表（关键）

| 症状 | 原因链 | 对应 Bug | 日志判据 |
|---|---|---|---|
| 会话只有一句开场白，页面纹丝不动，**服务端无任何循环日志** | ① 未发车 | **P0-1** | `App.tsx:1993` 后打印三判定，全 `null` 且请求体无 `taskMode` |
| 会话只有开场白，**服务端有循环但只有 1 格、无 tool 消息** | ② 首格未调工具 | **P1-1**（+ P0-2 不可见） | 服务端 `advanceInner` 返回 `{kind:'say'}`，`session.step === 0` |
| 会话只有开场白，**服务端循环跑了 1~2 格且都是失败** | ③ 执行超时误判 | **P1-2** | `drive` 返回 `error` 含「20 秒没有完成」 |

**排查第一步建议**：在 `App.tsx:1993` 之后加一行日志，落盘 `{openUrl, goNow, browseGoal, hasTaskMode}`。这一步就能把三条原因链**直接分流**，避免在错误的层里改代码。
