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
| `@点名` 中途拉人 | `packages/shared/src/mention.ts`（唯一解析实现）、`orchestrator/mention.ts`、`routes/chat.ts` | 会话打到一半 `@研究员 帮我看这组数据`，这一轮就由研究员开口（用它的人设 / 项目记忆 / 技能，前文照旧全给）；每句助手话都记着**是谁说的**（`messages.speaker_agent_id`），历史与 SSE `meta` 都带得回界面。`@` 必须紧跟名字（`@ 研究员` 不算）、邮箱里的 `@` 不算、别项目的人点不到、点了多个人只有第一个是发言人；被点名者**正忙**时不静默改派，而是回一句「它在做什么 + 要不要等 / 换人」；`@` 的就是当前发言人时按没写 `@` 处理；交给模型的正文剥掉 `@名字`（库里存原文）。`@` 只换**这一轮**谁开口，会话归属不动（下一轮不带 `@` 就回到原来那位）；点名轮照样能进浏览器工具循环，但**循环归会话主人**（`wcId` / 页面状态 / 循环名额都不换人，被点名者不接管别人的页），发车轮由跑循环那位开口，`meta.mention` 仍带着「你点的是谁」 |
| 多智能体编排 | `orchestrator/` | `spawn_workers`（临时工并行）、`delegate`（委派同事，默认 10 分钟熔断）、总协调路由（Chief-of-Staff）；协同过程以折叠摘要写进对话流 |
| 结构化交接 | `orchestrator/handoff.ts` | 每次委派一个 `handoffs/<id>.md`（目标 / 输入 / 产出要求 / 审批边界），频道消息只传 `handoff://` 路径；`board.md` 由**落库锁** `board_locks` 串行化 |
| 记忆 | `routes/memories.ts`、`memory*.ts` | 单一 `memories` 表，账号 / 智能体 / 会话三级作用域；确认后才注入；敏感内容整条丢弃。检索是**模糊字面匹配**（见「已知缺口」） |
| 项目白板 | `orchestrator/whiteboard.ts` | 项目级简报，所有成员自动注入；硬上限 2000 字，超出的归档进项目记忆 |
| 技能（Skills） | `orchestrator/skills.ts` | 「教一次」落成 `skills` 表（触发条件 / 步骤 / 决策规则 / 产出要求 / 审批边界），命中时注入，可自我修订 |
| 定时 / 事件触发 | `orchestrator/routines.ts` | Routines：`interval`（≥5 分钟）/ 每日定点 / 事件 |
| 重启恢复 | `orchestrator/checkpoint.ts` | 循环状态落 `loop_checkpoints`，服务重启后续跑；工具调用按 `tool_call_id` 去重 |
| 上下文压缩 | `orchestrator/contextCompress.ts` | 长任务的工具历史只增不减会爆，按预算压缩 |
| 模型路由 | `modelRouter.ts` | 用户不选模型，服务端按任务类型（chat / tool / extract / search / worker / delegate）选；可用 `DEEPSEEK_MODEL_<类型>` 分别配置。`chat` 这一类还按**任务复杂度**再分一路：简单闲聊走 `DEEPSEEK_MODEL_CHAT`，复杂闲聊（含「分析 / 诊断 / 对比 / 报告 / 调研…」且 ≥10 字）走 `DEEPSEEK_MODEL_CHAT_COMPLEX`；没配复杂模型就回落 CHAT 并**如实说明回落**；`MODEL_ROUTING_ENABLED=0` 一键全部退回 `DEEPSEEK_MODEL` |
| 知识库 | `routes/knowledge.ts` | 上传资料（PDF 等），加密分块存储，聊天时字面检索注入 |
| 桌面端浏览器 | `apps/desktop/src/browser/` | 多标签、按项目隔离登录态（`persist:` 分区按项目），单实例舞台 |

### 数据与安全

- **数据库里的内容列是密文**（AES-256-GCM，格式 `gcm$iv$tag$ct`，密钥 `DATA_KEY`）：消息、记忆、交接频道、技能各字段、白板、知识库分块、`loop_checkpoints.goal_enc / messages_enc`、**`tasks.goal_enc`、`task_pauses.goal_enc`**（收尾 6）、手机号等；`agent_delegations.task` 存的是脱敏文本。
  `loop_checkpoints` **fail-closed**：拿不到 cipher 就不写，绝不回退明文（`npm run verify:db` 用真库 + 变异测试验证过）。
- **任务目标（goal）不留任何明文副本**（收尾 6）：`tasks` 只写 `goal_enc`，`payload` 里没有 `goal` 键、`title` 恒为 NULL（它当年存的是 `goal.slice(0,80)`，是同一份明文的第二个副本 —— 留着它，对不到 80 字的目标等于没加密）；`task_pauses` 同理，明文列 `goal` 恒写 NULL。读取一律**解密优先、回退旧列**，所以没回填到的历史行也不会读成空白。
  **两条热路径都是 fail-closed：加密失败 → 500，库里一行都不落**（对齐 `loop_checkpoints` 的口径）。
  · `POST /agent/task/start` 加密失败 → 500 `goal_encrypt_failed`，任务不建；
  · `POST /agent/loop/pause` 加密失败 → 500 `goal_encrypt_failed`，**先加密再动任何状态**：不认领回执、不把循环标成 paused、不写 `task_pauses`。
  暂停这条路以前是「台账照写、`goal_enc` 置空」，收尾 6 条件2（2026-09-24）改成了现在这样：留一个「内存里挂着、库里没台账」的半成品比这次暂停失败更糟（用户重启后看不见这一路，服务端却以为它挂着）。代价是这种时候点「暂停」没反应、循环继续跑 —— 而 `DATA_KEY` 缺失时 `env.ts` 本来就拒绝启动服务，所以这是纵深防御的最后一道，不是日常分支。
  反证：`npm run verify:db:mutate-nocipher`（真服务端 + 真 Postgres，把路由层的 cipher 注入临时改成 null，断言 500 + 两张表零新增 + 明文全库搜不到；跑完逐字节还原 index.ts）。pglite 那份常驻回归闸在 `verify:db:pglite` 第 ⑧ 段。
  历史明文行由启动时的 `migrateTaskGoalEncryption` 幂等回填（带重试）；拿不到 `DATA_KEY` 就跳过并打 warn，下次启动再试，绝不写明文兜底。
  **扫描条件是「明文还在不在」，不是「`goal_enc` 有没有值」** —— 库里真实存在「密文已有值、明文列也还有值」的残行（灰度/回滚期间新旧代码各写一半、人工改过库），只按 `goal_enc IS NULL` 扫的话这种行永远轮不到、明文永远清不掉。
  **密文与明文不一致的行不自动清理**（条件3）：那种行两份都留着、一行不动，只在启动日志 warn 出行 id 交人判断。自动清明文会丢掉「唯一一份还能读的内容」，自动覆盖密文会丢掉「另一份可能更完整的内容」，机器没资格替人做不可逆的取舍。只有「明文有值、且密文缺失或解不开」才自动加密。
  `tasks.title` 停用后界面显示什么：服务端没有任务列表接口，桌面读的是 `GET /agent/task/current` 的 `goal`（解密后的原文）；该接口另回一个 `displayTitle` —— 同一句话过 `scrubTaskText` 脱敏、截 80 字，给「要落日志/截图/列表」的场景用，验收断言它非空且不含敏感词。
- **★ goal 加密防的是什么、不防什么（威胁模型，别高估它）**：这一层只防**数据库文件/备份被偷走**（`pgdata` 目录、`pg_dump` 出来的 SQL、云盘上的备份、被顺手拷走的容器卷）—— 那种情况下拿到文件的人没有 `DATA_KEY`，读不出目标原文。
  它**不**防、也从来不是为了防下面这些，因为它们都在信任边界**之内**：
  · **任务目标仍以明文发给模型**。服务端要拼提示词让模型知道该干什么，goal 原文必然出现在发往 `DEEPSEEK_BASE_URL` 的请求体里（传输靠 HTTPS，但对模型服务商是明文）。想要「模型也看不到」是另一个量级的工程（本地模型 / 端到端加密），不在收尾 6 范围。
  · **任务目标仍以明文返回给桌面显示**。`/agent/task/current`、`/agent/task/doc`、`/agent/loop/pauses` 都由服务端解密后回明文 —— 用户得看得见自己在干什么，这是功能要求不是漏洞。桌面端内存里因此也持有明文 goal。
  · **持有 `DATA_KEY` 的人（本机进程、运维、能读 `apps/server/.env` 的任何程序）**可以解开全部密文。钥匙与库同机时，「偷库」和「偷机器」是同一件事。
  一句话：**goal 加密 = 静态数据（at-rest）保护，不是端到端加密。**
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
| `npm run verify:redact` | 脱敏占位符（字数与值形状）+ `longdigits`（≥21 位连续纯数字串：判定与掩码**共用同一个边界常量**，⑤-1 用 12~30 位逐长度对照表钉住两边同口径），断言一律整串精确相等 | — |
| `npm run verify:mention` | `@点名` 三层：解析器（两端同一份实现，含全仓「只许有一处定义」防漂移闸）、服务端决定层（R-A/R-B/R-C）、渲染层闸门 + 接线 | — |
| `npm run verify:mention:e2e` | `@点名` **真机端到端**：真后端 + 真 PostgreSQL + 桩模型（桩把每次上游请求原样截下来，用来证明「模型收到的正文里没有 `@名字`」与「该不调模型的轮真的没调」），跑完把测试账号整体删掉 | 真 PostgreSQL + `apps/server/dist`（脚本会先 build） |
| `npm run verify:visibility` | **电脑三级可见度**（收尾 7 重写）：**真调**桌面本体导出的 `visibilityUrl` / `loadVisibility` / `saveVisibility`（假 fetch 截住，验地址、方法、鉴权头、请求体、返回口径），外加接线断言（组件真的被 `App.tsx` 渲染、是 `BrowserPanel` 的**兄弟**节点、切档只碰视图不碰任务）与 CSS 安全不变量（webview 宿主不许 `display:none` / 尺寸归零） | — |
| `npm run verify:visibility:e2e` | 可见度**真机端到端**：自己起真后端 + 真 PostgreSQL，**用桌面自己的函数去打真路由**，再回真库查 `agents.computer_visibility` 那一列；含三档往返、非法值 400、未登录 401、**别的账号改/读一律 404**，跑完把测试账号整体删掉 | 真 PostgreSQL + `apps/server/dist`（脚本会先 build） |
| `npm run verify:routing` | **模型真路由**（收尾 7）：证明简单闲聊与复杂闲聊选出的 `model` 字段**真的不同**；未配 `DEEPSEEK_MODEL_CHAT_COMPLEX` 时回落 CHAT 且 reason **如实说回落**；`MODEL_ROUTING_ENABLED=0` 全部退回默认模型；`tag → taskKind` 映射逐条对 | — |
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
- **`@点名` 没有补全菜单**：打 `@` 不会弹名单供选，得自己把名字打对（打错 / 打到别项目的人 → 按普通文本处理，不报错）。
  气泡上的「发言人名字牌」只给了最小可读样式（`msg__speaker`），像素级版式等设计稿。
  批次 J 之前入库的老消息 `speaker_agent_id` 是 NULL，历史里就回 `undefined`、界面不挂名字牌 —— **不回填、不猜**
  （唯一能拿来回填的 `conversations.agent_id` 只代表会话归属，不代表每一句是谁说的，拿它填等于造证据）。
  「@某人 + 页面任务」这种轮**会发车**，但按用户拍板（决策2 = allow_with_owner）循环归**会话主人**，
  所以这一轮开口的是跑循环那位、被点名者一句话不说；`meta.mention` 里点名事实还在（界面**能**提示「这活由谁在跑」），
  但那句提示是文案 —— 要不要加、加哪句，等用户拍（详见验收报告 §9.7）。
- **电脑三级可见度（Status / Preview / Takeover）已接通，但界面像素未定稿**（2026-09-24 收尾 7 修完空转）：`agents.computer_visibility` 字段、`GET/POST /agents/:id/visibility` 接口、`ComputerVisibility.tsx` 组件与 `App.tsx` 的接线**四者现在是一条通路**（组件渲染在 `BrowserPanel` 的**兄弟**位置，切档时 webview 不换父节点、不被卸载；请求走 `API_BASE`，token 由调用方传入）。剩下的是**观感**：横幅位置、收起态的高度节奏要等用户给 HTML/CSS 再做 1:1，现在只保证「机制通、宿主尺寸不归零、不影响任务执行」。
- **记忆 / 路由是模糊字面匹配，不是语义检索**：分词 + 加权 + Jaccard，零字面重叠的同义句（「爱喝拿铁」vs「喜欢喝咖啡」）照样检索不到。真语义要另接 embedding 模型（DeepSeek 没有 embedding API），调用点只有 `memories.ts` 的 `wordHits` 与 `chiefOfStaff.ts` 的 `routeByFuzzy`。
- **模型路由的「简单 / 复杂」是启发式，不是语义判断**（2026-09-24 收尾 7 已改成**真换模型**）：闲聊里两条路现在确实选出**不同的 `model`**（`DEEPSEEK_MODEL_CHAT` vs `DEEPSEEK_MODEL_CHAT_COMPLEX`），未配复杂模型时回落 CHAT 且日志**如实写「回落（没有换模型）」**，不再假装路由过。但判定本身仍是「关键词 + 长度」：`isSimple` 先看 `长度 < 10`，所以 8 个字的「帮我分析这份数据」判**简单**（关键词压根没轮到）—— 这条优先级被 `verify:routing` ⑦-4 钉住，改它会先红。不配任何 `DEEPSEEK_MODEL_*` 时所有任务都走 `DEEPSEEK_MODEL`。
- **交接文件明文落盘**：`handoffs/*.md` 和 `board.md` 写的是任务原文，与数据库「内容全密文」的口径不一致（库里同一份任务 `agent_delegations.task` 是脱敏存的）。修法二选一：写盘前走 `redactForStorage`，或整体改为存库密文、文件只做导出视图。
- **脱敏认的形状**：`密码/口令/pwd: X`、`验证码/otp: X`、13~20 位数字串（`card`，允许空格/横线分组）、
  正好 18 位身份证（`idcard`）、CVV，以及 2026-09-24 补上的 **`longdigits`：≥21 位连续纯数字串整段脱敏**
  （以前 21 位流水号、两个卡号紧贴无分隔的 34 位串会**整段明文**落进 `tasks.payload.steps` 这个明文列）。
  边界只有一个来源 `LONG_DIGITS_MIN`，`detectSensitive`（判定 → 拒绝委派/派工）与 `VALUE_PATTERNS`（掩码 → 落库）
  都由它拼正则；`npm run verify:redact` 的 ⑤ 段用 12~30 位**逐长度对照表**钉住两边同口径，
  另有 `scripts/verify/redact-longdigits-revert-proof.py`（7 处注入：挪边界、摘掩码、摘判定、把 longdigits 挪到 otp 之后、
  判定正则带 `g`、硬编码第二份边界、摘标签 case，全部必须红）。
  **仍未修的两条小残留**（不是漏网，是标签与尾巴）：① 18 位纯数字身份证被标成 `card` 而不是 `idcard`
  （`card` 那条排前面先命中；标签不含内容，改顺序会连带改判定侧的类别）；② **分组写法**超过 20 位时
  （`6222 0212 3456 7890 1234 5678`）`card` 抹掉前 20 位、尾巴 4 位留着 —— `longdigits` 只管**连续**纯数字串，
  不跨分隔符，而 4 位数字本身不构成卡号/流水号（两条都写进了断言，谁改谁会先看到红）。
  夹在字母/下划线里的数字串（base64、token 形状）**不涂**：那不是「独立的纯数字串」，涂了只会打花正常文本。
  占位符里的「N 字」是**被替换掉那一段的实际长度**（含分组用的空格/横线），不是整句长度 —— 这条曾经错过，
  修完的反证与断言见 `docs/acceptance/收尾6-goal加密-验收报告.md` 第 10 节。
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
