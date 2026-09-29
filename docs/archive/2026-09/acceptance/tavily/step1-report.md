# 第 26 步 · 第一小步验收报告：Tavily 联网搜索服务连通性

- 日期：2026-09-20
- 范围：**只验证搜索服务本身**（不通模型、不碰浏览器、不动界面）
- 结论：**45 PASS / 0 FAIL**，服务本身通了；反证成立（测试不是摆设）

---

## 一、核心原则的落地方式（这次最重要的部分）

「联网搜索」与「浏览器操作」被做成了**两套完全独立、互不干扰的系统**：

| | 联网搜索（本次新增） | 浏览器操作（既有，本次零改动） |
|---|---|---|
| 形态 | 一次 HTTPS 请求就结束 | 用户主动点开、AI 真操作网页 |
| 界面 | **什么都看不见**（纯文字结果） | 全屏面板 / 后台常驻小图标 |
| 资源 | 不启动浏览器实例、不占浏览器资源 | 独立渲染进程、内存/CPU 大户 |
| 代码 | `apps/server/src/search/tavily.ts` | `apps/desktop/src/browser/**`、`apps/desktop/electron/**` |
| 与模型关系 | **解耦**：零 import，不认识任何模型名 | 既有链路，本次未触碰 |

**与模型解耦的硬证明**：客户端源码**零 `import`**，编译产物里**一次 `require` 都没有**
（运行时依赖图为空）⇒ 它不可能引用 DeepSeek 或任何模型逻辑，换任何模型都照常可用。

---

## 二、交付物清单

| 文件 | 性质 | 说明 |
|---|---|---|
| `apps/server/src/search/tavily.ts` | **新增** | 搜索客户端。零 import、零依赖，与浏览器/模型完全解耦 |
| `apps/server/src/env.ts` | 修改（+13 行） | 只**新增** `tavilyApiKey` / `tavilyBaseUrl` 两个字段；原有字段与逻辑一行未动 |
| `apps/server/.env` | 修改（**已被 .gitignore 挡住**） | 真实密钥的唯一存放处 |
| `apps/server/.env.example` | 修改（+12 行） | 只留**空值**与说明，供他人复制 |
| `scripts/verify/tavily-search-check.mjs` | **新增** | 独立自检脚本（45 条断言：真实联网 + 错误分支 + 隔离自检） |
| `scripts/verify/tavily-search-revert.py` | **新增** | 反证脚本（注入坏条件 → 看断言是否变红 → 还原并校验 sha256） |
| `docs/acceptance/tavily/tavily-search-check-20260920.log` | 新增 | 验收日志（含真实返回原文） |

---

## 三、真机验证结果（真实问题 → 真实返回）

密钥有效性：**有效**（`describeApiKey` → `tvly-…(长度 58)`）。

### 查询 1：`今天有什么新闻`（general，5 条，2219ms）
返回 5 条，来源域名：
`m.cn.nytimes.com` / `www.worldjournal.com` / `www.voachinese.com` / `www.bbc.com/zhongwen/simp` / `www.epochtimes.com`

> ⚠️ 合规说明：该查询命中境外中文媒体，其正文摘要含**政治敏感内容**，本报告**不作转述**；
> 完整原始返回见落盘文件（`.workbuddy-ai/tavily-search-test/*.json` 与验收日志）。

### 查询 2：`今日要闻`（topic=news, days=2，5 条，1555ms）
```
1. 【今日要闻】中东会议推迟，原油价格上涨，黄金价格失守4300美元
   https://www.mitrade.com/cn/insights/more-analysis/top5/20260914A03C
2. 【今日要闻】FED会议登场，美元指数5连涨，比特币一度跌破7.5万
   https://www.mitrade.com/cn/insights/more-analysis/top5/20260916A03C
3. 反诈课变"抢答赛"
   http://hsb.hspress.net/system/2026/0918/243941.shtml
```

### 查询 3：`今天北京天气怎么样`（includeAnswer=true，上游直接给了一段回答）
```
Today in Beijing, it's cloudy with a temperature of 25°C. The air quality is
excellent, and there's no need for a mask. No rain is expected.
```

### 查询 4：`OpenAI latest news`（英文，3 条）—— 能力与语言无关

---

## 四、反证（证明测试不是摆设）

`scripts/verify/tavily-search-revert.py` 往客户端**代码**里注入坏条件
（`webview` / `BrowserPanel` / `deepseek` / `require('node:os')`，保持签名与返回类型不变）：

| | 结果 |
|---|---|
| 注入后 | **33 PASS / 4 FAIL** —— D.1 / D.2 / D.4 / D.5 全部变红 ✅ |
| 还原后 | **37 PASS / 0 FAIL**，且 `sha256` 与备份**完全一致** ✅ |
| 残留检查 | 源码里已无 `__revert_probe__` ✅ |

另有 12 条**确定性**错误分支断言（用本地 mock server 打，不靠上游脸色）：
`bad_query` / `not_configured` / `unauthorized`(401) / `rate_limited`(429、432) /
`upstream_error`(500) / `bad_response`(非 JSON、缺 results) / `network_error`(不可达)，
以及**真上游**的无效密钥 → `unauthorized`。

---

## 五、密钥安全确认

### ✅ 已确认干净
| 检查项 | 结果 |
|---|---|
| `git check-ignore apps/server/.env` | ✅ 被 `.gitignore:18` 挡住 |
| `git ls-files --error-unmatch apps/server/.env` | ✅ 不在 git 索引里 |
| `git grep` 扫 **133 个提交的全部历史** | ✅ 无命中 |
| `git grep --cached`（暂存区） | ✅ 无命中 |
| 工作区全盘扫描（排除 `.git`/`node_modules`） | ✅ 命中**仅** `apps/server/.env`（唯一指定存放处） |
| `.env.example` / 源码 / 脚本 / 验收日志 | ✅ 只有 `tvly-` 前缀或**假钥**，无真实密钥 |
| 应用数据目录（`%APPDATA%\@ai-workbench`） | ✅ 干净 |

密钥在代码侧的处理也是安全的：
- **只走 `Authorization: Bearer` 请求头**，不进请求 body（断言 C.15 已证明 body 里没有密钥）；
- 错误消息统一过 `redactSecrets()` 脱敏（断言 C.18 / C.20 已证明错误对象里不含密钥）；
- 日志只打 `tvly-…(长度 58)` 这种**前缀+长度**，不打密钥本体（断言 C.19）。

### ⚠️ 发现一个真实问题（需要你决定）
**密钥泄漏进了 agent 自己的运行日志**，原因是我把密钥写在命令行里传给了脚本，
而 agent 的工具调用会被原样记录：

| 文件 | 命中 |
|---|---|
| `~/.workbuddy-ai/logs/2026-09-20/sdk/conversations/9411216c-….log` | 11 处 |
| `~/.workbuddy-ai/logs/sandbox/20260920/sandbox_37180_000.log` | 1 处 |

- 我尝试**原地脱敏**，但这两个文件**正被当前会话持有**，写入被系统拒绝 ⇒ 现在改不了。
- 这两个文件都在仓库之外、且不在 git 里，**不会被提交**。

**建议（二选一，等你确认）**：
1. **轮换密钥**（最彻底）。这个 key 已在对话里明文出现过一次、又落进了 agent 日志，
   从安全实践看应当视为"已暴露"。轮换后我把新 key 只写进 `.env`，不再经命令行传递。
2. **等本次会话结束后**我再回来把这两个日志里的密钥脱敏（届时文件不再被占用）。
   —— 但这只解决日志，不解决"对话里出现过"。

---

## 六、代码隔离确认

`git status` 显示本次改动**只有**：

```
 M .workbuddy-ai/memory/MEMORY.md      ← 记忆文件整理（与功能无关）
 M .workbuddy-ai/memory/TOOLBOX.md     ← 同上
 M apps/server/.env.example            ← 新增空值占位
 M apps/server/src/env.ts              ← 只加 2 个字段
?? apps/server/src/search/              ← 新增目录（搜索客户端）
?? scripts/verify/tavily-search-check.mjs
?? scripts/verify/tavily-search-revert.py
```

- **`apps/desktop/` 零改动**（浏览器面板 `BrowserPanel.tsx` / `useBrowserWorkspace.ts` / `webview.d.ts`、
  主进程 `apps/desktop/electron/**` 一行都没动）。
- 服务端**浏览器触发与驾驶逻辑零改动**：`routes/loop.ts`、`routes/chat.ts`、`toolLoop.ts`、
  `promptPolicy.ts`、`sessionState.ts`、`pageState.ts`、`index.ts`、`db.ts`、`routes/agent(s).ts`
  —— `git diff` 全部为空。
- 搜索客户端**零 import / 编译产物零 require** ⇒ 结构上不可能与浏览器链路产生交集。
- 未做任何界面改动；未改任何"AI 该不该搜索"的判断逻辑（那是下一小步）。

---

## 七、下一步（等你确认后再动）

按你的要求**到此为止**。确认无误后，下一小步才做：
把「该不该联网搜索」的判断接进模型逻辑（模型无关的工具定义 + 触发判定），
并验收"查资料走轻量搜索路径、而不是误触发打开浏览器"。
