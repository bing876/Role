# R4 发车判定收紧 · 真服务端复验报告（2026-09-22）

> **为什么有这份报告**：`docs/验收报告-独立验收R1-R4-20260922.md` 写作时被测代码是 `e9ec00b`
> （只含 R1+R2+R3），因此它给第 5 项（R4）的结论是「❌ 不通过 —— **修复本身不在最新代码里**」。
> R4 随后由 `b1052da`（*R2全面加固+R4保守收紧*）实现，并经 PR #2 合入 `arena/01a0c703-role`
> （合并提交 `826a05a`）。本报告是对**已落地代码**的复验，并把复验手段**入库**（原报告的复现物
> 在会话沙箱 `/home/user/acceptance/`，随沙箱消失，无法复跑）。
>
> **验收方式**：不复用开发侧脚本。起**真服务端**（`tsx apps/server/src/index.ts`，PGlite 内存库，
> 真 HTTP，真 JWT 登录，真 `/chat/stream`），断言落在服务端**到底有没有真的建循环**。
>
> **离线边界（如实说明）**：LLM 用服务端自带的沙箱桩（`ENABLE_DEV_MOCK_LLM=1` → `llm.ts` 内置，
> 不是本次新写的桩）；CDP 执行器不触发（本验收只看「是否发车」，不驱动浏览器）。
> 发车判定发生在调模型**之前**，桩不参与任何被测逻辑。
> `shouldEnterTaskMode` / `startLoop` / SSE 广播全是仓库真代码，一行没桩。
>
> **复现物（已入库，可直接复跑）**：
> - `scripts/verify/r4-intent-source-parity.mjs` —— 纯函数层，零依赖，`node` 直接跑（31 条）
> - `scripts/verify/r4-dispatch-acceptance.mjs` —— 真服务端层，第 5/6 两项（10 条 + liveLoops 计数）
> - `docs/acceptance/r4-dispatch/` —— 本轮取证 JSON（`server-*.log` 可再生，已 gitignore）

---

## 结论一览

| # | 验收项 | R4 版（`826a05a`） | 旧宽松版（`origin/main` = `85e7b01`） |
|---|---|---|---|
| 5 | 稍长闲聊不被误判成任务（R4 本体） | ✅ **通过 5/5** | ❌ **不通过 1/5** |
| 6 | 正常浏览器任务仍正常触发（回归） | ✅ **通过 5/5** | ✅ 通过 5/5 |
| — | `/health.liveLoops` 与预期发车数一致 | ✅ 5 = 5 | ❌ 9 ≠ 5 |
| — | 源码一致性（真函数体 vs 审计用例） | ✅ 31/31 | — |
| — | `typecheck`（server + shared） | ✅ 干净 | — |
| — | `agent-loop-audit-test.mts`（既有审计） | ✅ 4/4 场景 | — |

**判定：R4 已正确落地，第 5、6 两项均通过，且第 6 项没有被收紧误伤。**

---

## ★ 反证：这套断言有没有鉴别力

按 `TOOLBOX.md` 的硬性规矩（「反证测试」+「收紧一类判定时必须同时写反向保护断言」），
**同一套用例必须在旧代码上失败**，否则「通过」是没有信息量的。

跑法（用 `git worktree`，不动当前工作区）：

```bash
git worktree add /tmp/wb-main origin/main
ln -s "$PWD/node_modules" /tmp/wb-main/node_modules
REPO_DIR=/tmp/wb-main LABEL=main-old EXPECT=fail5 \
  node scripts/verify/r4-dispatch-acceptance.mjs
git worktree remove /tmp/wb-main --force
```

实测（`docs/acceptance/r4-dispatch/r4-acceptance-main-old.json`）：

| 用例 | 旧宽松版 | R4 版 |
|---|---|---|
| 5-1 43 字纯闲聊「今天天气真舒服…你那边天气怎么样啊」 | **发车 ❌** | 不发车 ✅ |
| 5-2「帮我查一下今天北京的天气怎么样」 | **发车 ❌** | 不发车 ✅ |
| 5-3「今天北京天气怎么样」（有活页 wcId=7） | **发车 ❌** | 不发车 ✅ |
| 5-4「什么是量子力学」 | 不发车 ✅ | 不发车 ✅ |
| 5-5「我今天心情不太好想找人聊聊天随便说点什么」（>15 字） | **发车 ❌** | 不发车 ✅ |
| 6-1…6-5 五个真任务 | 发车 ✅ | 发车 ✅ |
| `liveLoops` | **9**（应为 5） | **5** ✅ |
| `llmCalls` | **1** | **5** |

**两条最有说服力的量化证据**：

1. `liveLoops 9 vs 5` —— 旧逻辑下 10 句话里建了 9 个浏览器工具循环，其中 4 个是本该走聊天的。
2. `llmCalls 1 vs 5` —— 旧逻辑下只有 1 句话进到了聊天模型，其余 9 句全被劫进任务循环；
   R4 后 5 句闲聊正常走聊天模型（任务轮不调模型，等桌面驱动 `/next`，所以是 5 而不是 10）。
   这正是复查报告 R4 写的「**普通聊天路径名存实亡**」，现在有了数字。

**第 6 项两版都通过 ⇒ 单看「任务还能不能发车」证明不了 R4 生效。有鉴别力的只有第 5 项 +
liveLoops/llmCalls 计数。** 这一点写进脚本，避免以后有人只跑回归项就宣布验收通过。

---

## 逐项证据

### 第 5 项：稍长闲聊不被误判成任务 ✅ 5/5

每条闲聊用例的 SSE 事件序列都是 `meta,done`（**没有 `loop`**），且拿到了正常聊天回复：

```
5-1 events=[meta,done]  回复：【沙箱直测】已接收指令：今天天气真舒服，早上出门遛弯的时候楼下花。正在为您执行分析与规划...
5-2 events=[meta,done]  回复：【沙箱直测】已接收指令：帮我查一下今天北京的天气怎么样。正在为您执行分析与规划...
5-3 events=[meta,done]  （有活页 wcId=7 也不再一票发车）
5-4 events=[meta,done]
5-5 events=[meta,done]  （>15 字，旧的 length>=15 一票发车已删）
```

对照复查报告 R4 给的修复口径，三条要求逐条核实：

| 复查报告要求 | 实现位置（`apps/server/src/routes/chat.ts`） | 核实 |
|---|---|---|
| 要求「动作词 + 有活页/开页意图」才发车 | `STRONG_ACTION` / `WEAK_ACTION` + `PAGE_REF` 组合判定 | ✅ |
| 纯提问（即使含 查/搜/看）默认走聊天搜 | 无活页时弱动作词一律 `return false` | ✅ 用例 5-2 |
| 删除 `length>=15` 一票发车 | 结构反证：可执行代码里 `length\s*>=\s*15` **0 命中** | ✅ 用例 5-5 |

> ★ 结构反证的一个坑（已写进脚本注释）：R4 的注释块本身在描述旧逻辑，
> 第 329/336 行就有「`length>=15` 一票发车」字样。拿**全文**去断言「已删除」会误判成还在 ——
> 「已删除」类断言必须只扫函数体切片，「存在」类断言才扫全文。

### 第 6 项：正常浏览器任务仍正常触发 ✅ 5/5

```
6-1「打开百度，搜索一下今天的新闻，把前三条标题读给我」 events=[meta,loop] → 好，我在当前这张页上动手了…
6-2「帮我下单」（短句）                                  events=[meta,loop]
6-3「打开 https://shop.example.com/item/9 …下单」        events=[meta,loop]
6-4「在这个页面搜一下同款」（有活页 wcId=8）              events=[meta,loop] → 好，我在「shop.example.com」这张页上动手了…
6-5「诊断一下我的店铺后台情况」                           events=[meta,loop]
```

其中 **6-4 是专门防「收紧过头」的反向保护**：弱动作词「搜」单独出现不发车（5-2），
但配上页面指代「这个页面」就**必须**发车。只写 5-2 不写 6-4，很容易把这条一起掐掉。
6-2 同理防「短句被漏掉」。

### 源码一致性（防审计用例漂移）✅ 31/31

`agent-loop-audit-test.mts` 里的 `shouldEnterTaskModeTest` 是 `chat.ts` 那个函数的**手抄副本**，
不是 import ⇒ 副本通过 ≠ 线上代码正确，两边会静默漂移。

`r4-intent-source-parity.mjs` 因此不抄：按花括号配平**从 chat.ts 抠出真实函数体**（跳过正则字面量
与字符串里的 `{}`），去掉箭头函数头部的 TS 标注后 eval，再跑 31 条断言：

| 段 | 内容 | 条数 |
|---|---|---|
| A | 与审计用例场景 a 完全对齐（含 4 条 "R4 新增"） | 12 |
| B | 反向保护成对断言（该发的发 / 不该发的不发） | 10 |
| C | 结构反证（旧宽松规则真的从可执行代码消失 + R4 标记/词表存在） | 7 |
| D | R4 已知保守取舍（按现状固化，见下方残留） | 2 |

### 既有审计用例 + 类型检查 ✅

```
agent-loop-audit-test.mts：场景 a 12/12、场景 b（SSE 步骤实时回流）、
                           场景 c（运行中注入补充指令）、场景 d（首格感知规矩）—— 4/4 全通过
typecheck：@ai-workbench/server ✅ 干净；@ai-workbench/shared ✅ 干净
```

---

## 残留（不在本次范围，已单独立待办）

**有活页 + 明确页面指代，但动词不在词表里 → 不发车。**
实测：「当前页面上的价格帮我记下来」（hasPage=true）走普通聊天，因为「记」既不在
`STRONG_ACTION` 也不在 `WEAK_ACTION` 里。这是 R4「宁可漏发不误发」的**有意取舍**，
不是实现走样（R4 口径就是「只有强动作词，或弱动作词+页面指代才发车」）。

但它与 `ARCHITECTURE_REVIEW.md` 的 P0-1 是同一类症状（AI 嘴上答应、手上不动），
所以记进 `docs/待办-R4残留-页面指代无动作词-20260922.md`，附三种候选方案与各自代价，
留待拍板 —— **本次不动业务逻辑**（R4 已被其提交确认为健康基线，单方面放宽会回退第 5 项精度）。

---

## 复跑方法

```bash
# 沙箱里 npm install 需要跳过 Electron 二进制下载（复查报告 §8 已记过这条约束）
npm install --ignore-scripts        # 或 ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
npm run build -w @ai-workbench/shared

node scripts/verify/r4-intent-source-parity.mjs     # 纯函数层，31 条，约 0.2s
node scripts/verify/r4-dispatch-acceptance.mjs      # 真服务端层，10 条 + 计数，约 27s
npx tsx scripts/verify/agent-loop-audit-test.mts    # 既有审计，4 场景
npm run verify:r4                                   # 一次跑完上面前两条
```

两个脚本都自包含：自己起服务端、自己建测试账号、自己收尾杀进程，不需要 Docker / 本机 PG /
真实 API key。默认端口随机取 8900–8989，避开 8787（用户 dev）、8798–8799（2a）、8899（fake-llm）。

## 取证索引

| 文件 | 内容 |
|---|---|
| `docs/acceptance/r4-dispatch/r4-acceptance-HEAD.json` | R4 版 10 条逐条结果 + SSE 事件序列 + `/health` |
| `docs/acceptance/r4-dispatch/r4-acceptance-main-old.json` | 旧宽松版同一套用例（反证：第 5 项 1/5、liveLoops=9） |
| `docs/acceptance/r4-dispatch/server-*.log` | 服务端启动日志（可再生，已 gitignore） |
