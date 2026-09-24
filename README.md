# AI 工作台（ai-workbench）

桌面端的「多智能体工作台」：每个项目里有一组智能体（Bots），你在对话里把活交给它们；
它们能驾驶工作台里**内嵌的真实浏览器**、联网搜索、互相委派，并记住你定下的规矩。

- **桌面端** `apps/desktop` —— Electron + React + TypeScript + Vite。
- **服务端** `apps/server` —— Fastify 5 + PostgreSQL，接 DeepSeek（可换 OpenAI 兼容接口）。**模型调用、密钥和数据都在服务端**。
- **共享类型** `packages/shared` —— 两端共用的接口 / 工具定义。

> 本 README 按 2026-09-24 分支 `arena/01a0ce4f-role` 的实际代码改写。旧版里「第 3 步已完成 / 不接大模型 / 数据只活在内存」早已不成立。
> 界面和文案还没定稿：**前端要按设计稿 1:1 重做**，本仓库这一轮只负责数据、接口和「跑通」。

---

## 现在能做什么

| 能力 | 在哪 | 说明 |
| --- | --- | --- |
| 账号 | `routes/auth.ts` | 手机验证码登录（未注册自动建号 + 默认项目 + 智能体「小助」）、XYZ 号 + 密码登录。开发模式验证码只进服务器日志 |
| 项目 = 天然的群 | `routes/projects.ts`、`projectScope.ts` | 项目是智能体的容器，同项目智能体天生同属一个协作空间；**不单独建群聊表** |
| 智能体 | `routes/agents.ts`、`orchestrator/agentBuilder.ts` | 建 / 改人设 / 删；对话里说「建一个 X 助手」会先确认再建，问句（「建一个是什么意思？」）不会误建 |
| 流式聊天 | `routes/chat.ts`、`llm.ts` | SSE 流式；模型调用统一出口 `llm.ts`（计数进 `/health`，证明空闲时不调模型） |
| 浏览器工具循环 | `toolLoop.ts`、`routes/loop.ts`、`electron/driver.ts` | 脑在服务端，手在桌面：`open_url / read_page / click / type / scroll / stop`，由 Electron 主进程通过 CDP 驾驶内嵌 `<webview>`。敏感字段（密码 / 验证码 / 支付 / 证件）不代填 |
| 联网搜索 | `search/` | Tavily；`web_search` 定义只有一个来源（`search/toolDef.ts`），聊天与编排共用 |
| 多智能体编排 | `orchestrator/` | `spawn_workers`（临时工并行）、`delegate`（委派同事，默认 10 分钟熔断）、总协调路由（Chief-of-Staff）；协同过程以折叠摘要写进对话流 |
| 结构化交接 | `orchestrator/handoff.ts` | 每次委派一个 `handoffs/<id>.md`（目标 / 输入 / 产出要求 / 审批边界），频道消息只传 `handoff://` 路径；`board.md` 由**落库锁** `board_locks` 串行化 |
| 记忆 | `routes/memories.ts`、`memory*.ts` | 单一 `memories` 表，账号 / 智能体 / 会话三级作用域；确认后才注入；敏感内容整条丢弃。检索是**模糊字面匹配**（见「已知缺口」） |
| 项目白板 | `orchestrator/whiteboard.ts` | 项目级简报，所有成员自动注入；硬上限 2000 字，超出的归档进项目记忆 |
| 技能（Skills） | `orchestrator/skills.ts` | 「教一次」落成 `skills` 表（触发条件 / 步骤 / 决策规则 / 产出要求 / 审批边界），命中时注入，可自我修订 |
| 定时 / 事件触发 | `orchestrator/routines.ts` | Routines：`interval`（≥5 分钟）/ 每日定点 / 事件 |
| 重启恢复 | `orchestrator/checkpoint.ts` | 循环状态落 `loop_checkpoints`，服务重启后续跑；工具调用按 `tool_call_id` 去重 |
| 上下文压缩 | `orchestrator/contextCompress.ts` | 长任务的工具历史只增不减会爆，按预算压缩 |
| 模型路由 | `modelRouter.ts` | 用户不选模型，服务端按任务类型（chat / tool / extract / search / worker / delegate）选；可用 `DEEPSEEK_MODEL_<类型>` 分别配置 |
| 知识库 | `routes/knowledge.ts` | 上传资料（PDF 等），加密分块存储，聊天时字面检索注入 |
| 桌面端浏览器 | `apps/desktop/src/browser/` | 多标签、按项目隔离登录态（`persist:` 分区按项目），单实例舞台 |

### 数据与安全

- **数据库里的内容列是密文**（AES-256-GCM，格式 `gcm$iv$tag$ct`，密钥 `DATA_KEY`）：消息、记忆、交接频道、技能各字段、白板、知识库分块、`loop_checkpoints.goal_enc / messages_enc`、**`tasks.goal_enc`、`task_pauses.goal_enc`**（收尾 6）、手机号等；`agent_delegations.task` 存的是脱敏文本。
  `loop_checkpoints` **fail-closed**：拿不到 cipher 就不写，绝不回退明文（`npm run verify:db` 用真库 + 变异测试验证过）。
- **任务目标（goal）不留任何明文副本**（收尾 6）：`tasks` 只写 `goal_enc`，`payload` 里没有 `goal` 键、`title` 恒为 NULL（它当年存的是 `goal.slice(0,80)`，是同一份明文的第二个副本 —— 留着它，对不到 80 字的目标等于没加密）；`task_pauses` 同理，明文列 `goal` 恒写 NULL。
  建任务时加密失败 → **直接 500，任务不建**（不退回明文）；暂停时加密失败 → 挂起台账照写、`goal_enc` 置空（少一个目标文本可以，写明文不行）。读取一律**解密优先、回退旧列**，所以没回填到的历史行也不会读成空白。
  历史明文行由启动时的 `migrateTaskGoalEncryption` 幂等回填（`WHERE goal_enc IS NULL`，带重试）；拿不到 `DATA_KEY` 就跳过并打 warn，下次启动再试，绝不写明文兜底。
- **例外：交接文件是明文落盘**。`apps/server/data/handoffs/<项目>/<委派>.md` 与 `board.md` 直接写任务原文，既不加密也不脱敏（目录已 gitignore，但在服务器磁盘上可读）。见「已知缺口」。
- 手机号只存 `HMAC(PHONE_PEPPER, phone)` + 密文副本；`PHONE_PEPPER` 与 `DATA_KEY` 必须是两把不同的钥匙，缺任何一个服务拒绝启动。
- 模型 key 只在 `apps/server/.env`（不入库）；桌面安装包**不含**服务端、数据库或任何 key。

---

## 目录

```
.
├── package.json              # workspaces；dev / build / typecheck / verify:* 入口
├── start-dev.cmd             # Windows 一键：起便携 PostgreSQL + 服务端
├── apps/
│   ├── desktop/
│   │   ├── electron/         # 主进程：driver.ts(CDP 驾驶) agent.ts toolExecutors.ts
│   │   │                     #         server-supervisor.ts(后端没起就在后台拉起) resource-guard.ts
│   │   └── src/              # 渲染进程：App.tsx  browser/(浏览器模块，改浏览器只改这里)  channels/
│   └── server/
│       └── src/
│           ├── index.ts      # 启动、路由注册、迁移（带重试）、重启恢复
│           ├── db.ts         # 全部 DDL（幂等）、withTx
│           ├── llm.ts        # 模型调用唯一出口      modelRouter.ts  按任务选模型
│           ├── toolLoop.ts   # 浏览器工具循环        toolRegistry.ts 工具注册表
│           ├── routes/       # HTTP 接口
│           ├── orchestrator/ # 编排、委派、交接、白板、技能、Routines、checkpoint、路由
│           └── search/       # web_search
├── packages/shared/src/      # index.ts(接口类型)  tools.ts(工具定义)
├── scripts/verify/           # 全部验收脚本（见下）
└── docs/                     # 方案、交付 / 验收报告、待办
```

---

## 本地运行

需要 **Node ≥ 18**（在 Node 22 上验证）和 **PostgreSQL**（Docker：`npm run db:up`；Windows 也可用 `start-dev.cmd` 起便携版）。

```bash
npm install                               # 首次会下载 Electron（约 100MB）
cp apps/server/.env.example apps/server/.env
#   必填：DATABASE_URL  JWT_SECRET(≥16)  DATA_KEY(64 位 hex)  PHONE_PEPPER(≥16，且 ≠ DATA_KEY)
#   模型：DEEPSEEK_API_KEY（不填也能起，聊天接口会明确拒答）；搜索：TAVILY_API_KEY（可选）
npm run dev:server                        # 服务端 :8787，启动后自动建表
npm run dev                               # 桌面端（Vite + Electron）
```

- 服务端监听 `0.0.0.0:8787`；桌面端默认连 `http://127.0.0.1:8787`。
- 表是启动时自动建的（`db.ts` 的 DDL 全部幂等）；库还在恢复中时会每 3 秒重试，最多约 2 分钟。
- 桌面端发现后端没起，会在后台自己拉起一份（只管自己拉起的那份，不碰你手动起的）。

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` / `npm run dev:server` | 桌面端 / 服务端开发模式 |
| `npm run typecheck` | shared + desktop + server 全量类型检查 |
| `npm run build` | 构建三个 workspace |
| `npm run package` / `package:dir` | 用 electron-builder 打当前系统的安装包 / 只出目录（产物在 `apps/desktop/release/`，不入库） |
| `npm run live` | 起整套桌面工作台并自动登录（Windows 验收用） |
| `npm run clean` | 清理构建产物 |

---

## 验收

所有验收脚本都在 `scripts/verify/`，按主题挂在根 `package.json`：

| 命令 | 覆盖 | 依赖 |
| --- | --- | --- |
| `npm run verify` | 下面除 `verify:db` 外的全部，**外加 `verify:db:pglite`**（goal 加密自检，不需要外部库） | 无（内存库 PGlite / 读源码） |
| `npm run verify:tools` | 工具表、注册表契约、回滚开关 | — |
| `npm run verify:r4` | 发车意图判定口径一致 | — |
| `npm run verify:orch` | 编排：schema / 临时工 / park / 委派 / 端到端 / 路由 / 频道 / 一键关停 | PGlite |
| `npm run verify:websearch` | `web_search` 单一定义来源 | — |
| `npm run verify:memory` | 记忆合并四批、记忆卫生、记忆检索 | PGlite |
| `npm run verify:persona` | 总协调人设、身份块注入 | — |
| `npm run verify:collab` | 协同进对话流、头像即状态、总协调路由、Routines、上下文压缩 | — |
| `npm run verify:batches` | 交接、白板、路由升级、重启恢复、前端引导、五项自查、Skills、电脑可见度、模型路由 | — |
| `npm run verify:db` | **连真库**：checkpoint 加密（直接 SELECT + 漏传 cipher 变异）、board 落库锁（多进程 + kill -9 重启）、**收尾6 goal 加密**（真服务端 + 真登录 + 直连 SELECT `tasks`/`task_pauses` + 真重启验启动回填 + 幂等）、pglite 自检 | 真 PostgreSQL，`VERIFY_DATABASE_URL=postgres://…`（可写的测试库） |
| `npm run verify:db:pglite` | 收尾6 goal 加密的快速自检：跑的是**生产代码本体**（`db.ts` / `routes/agent.ts` / `routes/loop.ts` + Fastify `inject()`），不是脚本里的副本 | PGlite（无需外部库） |

> 很多脚本是「读源码做结构检查」，只能证明代码长什么样，证明不了行为；涉及安全和并发的结论以 `verify:db` 这类真库 / 真进程的测试为准。
> `scripts/verify/` 里还有大量 `.py` 与探针脚本是历史上在 Windows 真机上跑的 E2E / 性能取证，依赖本机环境，不在 `npm run verify` 里。

---

## 已知缺口（如实写，别当已完成）

- **前端未定稿**：界面、文案、版式等设计稿到了再 1:1 重做。现有桌面 UI 是能跑通用的，不是成品。
- **电脑三级可见度（Status / Preview / Takeover）只做了后端和组件**：`agents.computer_visibility` 字段和 `GET/POST /agents/:id/visibility` 接口已可用；`ComputerVisibility.tsx` 组件**还没挂进界面**，而且它请求的是相对路径 `/api/...`，与桌面端其余请求使用的 `API_BASE` 不一致 —— 前端重做时一起接。
- **记忆 / 路由是模糊字面匹配，不是语义检索**：分词 + 加权 + Jaccard，零字面重叠的同义句（「爱喝拿铁」vs「喜欢喝咖啡」）照样检索不到。真语义要另接 embedding 模型（DeepSeek 没有 embedding API），调用点只有 `memories.ts` 的 `wordHits` 与 `chiefOfStaff.ts` 的 `routeByFuzzy`。
- **模型路由目前只按任务类型选**：闲聊里「简单 / 复杂」的判断只写进日志，两者选的是同一个模型配置；不配 `DEEPSEEK_MODEL_*` 时所有任务都走 `DEEPSEEK_MODEL`。
- **交接文件明文落盘**：`handoffs/*.md` 和 `board.md` 写的是任务原文，与数据库「内容全密文」的口径不一致（库里同一份任务 `agent_delegations.task` 是脱敏存的）。修法二选一：写盘前走 `redactForStorage`，或整体改为存库密文、文件只做导出视图。
- **重启恢复的工具去重**只有逻辑模拟测试（`self-check-fixes.mjs`），还没有「执行后、结果落库前 kill 进程」的真进程测试。
- 生产环境的 CSP 未加（避免打断 Vite HMR）。

---

## 桌面端备忘（踩过的坑，改之前先看）

- **浏览器是单实例组件**：`embedWcId` 单值、所有 tab 同一舞台按 z-index 分层、登录态按项目分区 —— 换前端时这些是功能，不能动。
- `<webview>` 的 `display` 必须是 `flex`（`block` 会让 guest 卡在 150px 高）；`pointer-events` 恒为 `auto`，「谁能操作网页」由主进程执行器的 `paused` 开关决定，不靠 CSS 挡鼠标。
- CDP 文本注入在部分虚拟机上会**静默失败**：`type` 走三层兜底（`Input.insertText` → `execCommand` → 原生 setter）并读回校验；点击先做命中测试，命不中退化为 `el.click()`。
- 内嵌页的 `target=_blank` / `window.open` 在当前页打开，不弹新窗口（`allowpopups` + `setWindowOpenHandler` + `setImmediate` 后 `loadURL`，缺一不可）。
- 部分虚拟机缺 Chromium 沙箱能力会崩在 `GPU process isn't usable`：`apps/desktop/scripts/start-electron.mjs` 只在确认命中时才加 `--no-sandbox` 重试，并打印提示；`contextIsolation` / `nodeIntegration:false` 不受影响。
- 自动化反复启停容易留孤儿进程（`Port 5173 is already in use` + Electron 单实例锁静默退出）：先杀 `electron.exe` 和占 5173 的进程再起。

更细的接口表见 [`apps/server/README.md`](apps/server/README.md)（部分内容停留在早期步骤，以代码为准），各阶段方案与验收报告见 `docs/`。
