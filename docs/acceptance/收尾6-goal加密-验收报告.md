# 收尾 6（重建 1）验收报告 · 加密 task_pauses.goal 与 tasks.payload.goal

- 日期：2026-09-23（会话时区 UTC）
- 分支：`arena/01a0d0a8-role`（基线 `ac75d63`，远端 main 唯一基线）
- 口径：涉及数据库一律走**真库**（真 PostgreSQL 17.10 + 真服务端 + 真登录 + 直连 SELECT）
- 结论：**PASS**（真库 61 项、pglite 自检 37 项，全绿；8 个变异反证全部变红）

---

## 1. 做了什么

| 位置 | 改动 |
| --- | --- |
| `apps/server/src/db.ts` | `tasks` / `task_pauses` 两张表 CREATE 加 `goal_enc TEXT`；各加一条 `ALTER TABLE … ADD COLUMN IF NOT EXISTS goal_enc TEXT`（老库幂等）；新增 `migrateTaskGoalEncryption(pool, cipher)` 逐行回填；更正「R2 已加 goal_enc」的错误注释 |
| `apps/server/src/routes/loop.ts` | `POST /agent/loop/pause` 写 `goal_enc`、明文列恒写 NULL；`GET /agent/loop/pauses` 解密优先、回退旧列（新增 `pauseGoalFromRow`） |
| `apps/server/src/routes/agent.ts` | `ownTask` 带 `goal_enc`；新增 `taskGoalFromRow` / `payloadWithoutGoal`；`task/start` 加密失败**直接 500**（fail-closed，任务不建）；`task/step`、`task/finish`、`task/doc`、`task/current` 全部解密优先 |
| `apps/server/src/index.ts` | 启动后跑 `migrateTaskEncryptionWithRetry(pool, cipher)`（**不 await**，3 秒 × 40 次重试） |
| `apps/server/src/orchestrator/checkpoint.ts` | 更正「R2 当年专门给 task_pauses 加 goal_enc」的错误注释 |
| `README.md` | 「数据与安全」段补 goal 加密口径与 fail-closed 行为；验收表补两个新脚本 |
| `package.json` | `verify:db` 加挂两个新脚本；新增 `verify:db:pglite`；`verify` 链尾加上 pglite 自检 |
| `scripts/verify/task-encryption-db.mjs` | 新增：真库全链路验收（61 项） |
| `scripts/verify/task-encryption-pglite.mts` | 新增：pglite 快速自检（37 项，跑的是生产代码本体） |

### 两个刻意的取舍（不是漏做）

1. **`tasks.title` 也一并停用（恒写 NULL、回填时清空）。**
   规格只点了 `payload.goal`，但 `title` 存的是 `goal.slice(0,80)` —— 同一个明文目标的**第二份副本**。
   留着它，对不到 80 字的目标（绝大多数）来说「加密了 goal」等于没加密。
   核查过：`title` 在服务端只被当作 goal 的兜底读（`task/finish`、`task/doc`、`task/current`），
   **没有任何界面直接展示它**（桌面端读的是接口返回的 `goal`），所以置 NULL 不影响用户能看到的东西。

2. **暂停时加密失败 → 台账照写、`goal_enc` 置空；建任务时加密失败 → 直接 500 不建。**
   两者共同的底线是「绝不写明文」，差别在于代价：
   少一条 checkpoint / 少一个目标文本可以接受（恢复时 AI 重新问一遍），
   但「挂起台账少一行」会让用户重启后看不到那一路暂停着 —— 那是功能损失，所以行照写。

---

## 2. ★ 真库验收抓出的真 bug（只读源码永远发现不了）

**第一版回填的条件是 `WHERE goal_enc IS NULL AND 明文还在`**，看着幂等又省事。
真库里跑独立取证 SELECT 时发现库里存在**第三种形状**：

```
=== 启动前 · 那两行残行长什么样 ===
[
 {
  "表": "tasks",
  "id": "5",
  "明文位置内容": "帮我查一下 银行卡6222021234567890 的余额，登录用 密码Zx9!secret，实名 身份证110101199003071234",
  "payload_goal": null
 },
 {
  "表": "task_pauses",
  "id": "7",
  "明文位置内容": "帮我查一下 银行卡6222021234567890 的余额，登录用 密码Zx9!secret，实名 身份证110101199003071234",
  "payload_goal": null
 }
]
```

这两行 **`goal_enc` 已经有值、明文列也还有值**，于是永远满足不了 `goal_enc IS NULL`
→ 明文**永远清不掉**，而当时只造「纯老行」的验收脚本**照样全绿**。

这个形状在真实运维里会出现：灰度/回滚期间新旧代码各写一半、人工改过库、
或者旧代码在 `task/step` 把 payload 原样展开写回。

**修法**：扫描条件从「goal_enc 有没有值」改成「**明文还在不在**」；
两边都有值时**保留已有密文、只清明文**（因为明文那份可能是 `title`，
是 `goal.slice(0,80)` 的**截断值**，拿它覆盖密文等于把完整目标砍成 80 字）；
只有密文缺失或解不开（DATA_KEY 换过）才用明文重加密；内容不一致时计入 `mismatched` 如实报数。

修复后同一份取证：`title有值: 1 → 0`、`goal有值: 1 → 0`，残行被清干净。
两个验收脚本都补了「残行」专段当回归闸（反证 M8 证明这段真的会红）。

---

## 3. 验收脚本完整输出

### 3.1 真库：`scripts/verify/task-encryption-db.mjs`（EXIT=0）

```
PASS  真登录拿到 JWT
PASS  本次验收收口到 user_id=17（所有断言只看这个用户的行）

--- ① POST /agent/task/start + step：tasks 表只落密文 ---
PASS  建出任务 #25

--- SELECT id, status, title, payload, goal_enc FROM tasks WHERE id = 25 ---
{"id":"25","status":"running","title":null,"payload":{"steps":["打开了网银首页"]},"goal_enc":"gcm$+Pg+6b34jAt3RQ4U$eQzOJ8TfdBD…"}

PASS  tasks.title 为 NULL（不再抄 goal 前 80 字当明文副本）；实际 null
PASS  tasks.payload 里没有 goal 键；实际键 = ["steps"]
PASS  payload.steps 正常记了一步（功能没被吃掉）
PASS  tasks.goal_enc 以 gcm$ 开头
PASS  tasks 整行 row_to_json 里读不到「银行卡6222021234567890」
PASS  tasks 整行 row_to_json 里读不到「密码Zx9!secret」
PASS  tasks 整行 row_to_json 里读不到「身份证110101199003071234」
PASS  goal_enc 密文列里一个中文字都没有
PASS  用 DATA_KEY 解 tasks.goal_enc 能还原原始 goal

--- ② POST /agent/loop/start + pause：task_pauses 表只落密文 ---
PASS  建循环 loop_muesq39s_1
PASS  挂起成功，暂停记录 #25

--- SELECT id, loop_id, goal, goal_enc, paused_by FROM task_pauses WHERE loop_id = 'loop_muesq39s_1' ---
{"id":"25","loop_id":"loop_muesq39s_1","goal":null,"goal_enc":"gcm$560i8KIrDa4tvntb$Jr3d8G7gfVL…","paused_by":"user"}

PASS  task_pauses.goal 明文列为 NULL；实际 null
PASS  task_pauses.goal_enc 以 gcm$ 开头
PASS  task_pauses 整行 row_to_json 里读不到「银行卡6222021234567890」
PASS  task_pauses 整行 row_to_json 里读不到「密码Zx9!secret」
PASS  task_pauses 整行 row_to_json 里读不到「身份证110101199003071234」
PASS  用 DATA_KEY 解 task_pauses.goal_enc 能还原原始 goal

--- ③ 用户能感知：接口层照样拿得到目标（加密不能把功能吃掉）---
PASS  /agent/loop/pauses 里有这条记录
PASS  GET /agent/loop/pauses 返回的 goal 是解密后的原文
PASS  任务收尾成功（unread 红点已置）
PASS  GET /agent/task/doc 的「## 目标」是解密后的原文
PASS  GET /agent/task/current 回到任务 #25
PASS  GET /agent/task/current 的 goal 是解密后的原文（桌面刷新后还原任务卡靠它）
PASS  收尾写回 payload 后依然没有 goal 键（payloadWithoutGoal 生效）
PASS  收尾后 title 仍然是 NULL
PASS  result_enc（任务文档）仍是密文
PASS  收尾后 tasks 整行里读不到「银行卡6222021234567890」
PASS  收尾后 tasks 整行里读不到「密码Zx9!secret」
PASS  收尾后 tasks 整行里读不到「身份证110101199003071234」

--- ④ 历史明文行 + 真重启：启动时的 migrateTaskGoalEncryption 有没有真跑 ---
      造历史明文行：task_pauses#26、tasks#26；造残行：task_pauses#27、tasks#27（密文与明文同时有值）
PASS  重启前它是明文形状（goal 有值、goal_enc 为 NULL）—— 否则这段验收是自欺

--- 重启后的服务端日志（回填那几行）---
[db] 收尾6 goal 密文回填：task_pauses 2 条、tasks 2 条（新加密 2 条、密文与明文不一致 0 条、失败 0 条留待下次）
[server] goal 密文回填完成：task_pauses 2 条、tasks 2 条

PASS  启动日志如实报了回填条数
--- SELECT goal, goal_enc FROM task_pauses WHERE id = 26 ---
{"goal":null,"goal_enc":"gcm$YKgx63llYQYCA0w0$sxQeZc7X1+7…"}

PASS  重启后 task_pauses.goal 明文被清成 NULL
PASS  重启后 task_pauses.goal_enc 是密文
PASS  重启后密文能解回那条老目标
PASS  重启后老暂停行整行里读不到「银行卡6222021234567890」
PASS  重启后老暂停行整行里读不到「密码Zx9!secret」
PASS  重启后老暂停行整行里读不到「身份证110101199003071234」
--- SELECT title, payload, goal_enc FROM tasks WHERE id = 26 ---
{"title":null,"payload":{"doc":{"summary":"老的结论"},"steps":["老步骤"]},"goal_enc":"gcm$1PI4EL4boLC/35Ob$M9DuXbNpbWq…"}

PASS  重启后 tasks.title 里的明文副本被清掉
PASS  重启后 tasks.payload 里的明文 goal 键被摘掉
PASS  payload 的其余内容（steps/doc）一个字节没动 —— 回填不是「清空重写」
PASS  重启后 tasks.goal_enc 能解回那条老目标
PASS  重启后老任务行整行里读不到「银行卡6222021234567890」
PASS  重启后老任务行整行里读不到「密码Zx9!secret」
PASS  重启后老任务行整行里读不到「身份证110101199003071234」
PASS  重启后 GET /agent/task/doc 仍能给出老任务的目标（回填没有把老数据变成读不出来）
--- SELECT goal, goal_enc FROM task_pauses WHERE id = 27（残行）---
{"goal":null,"goal_enc":"gcm$bFSQrZCrcWq0M2MX$9XXrbSBuSOP…"}

--- SELECT title, payload, goal_enc FROM tasks WHERE id = 27（残行）---
{"title":null,"payload":{"steps":["残行步骤"]},"goal_enc":"gcm$x559xMiEpC4cRvN6$lDtO2glkzaK…"}

PASS  残行（密文+明文同时有值）重启后明文列被清掉 —— 没有因为「已有密文」被跳过
PASS  残行 task_pauses.goal_enc **逐字节没变**（保留已有密文，不是重加密换 IV）
PASS  残行 tasks.title 的截断明文被清掉
PASS  残行 tasks.goal_enc **逐字节没变**（没被 title 的 80 字截断值覆盖）
PASS  残行密文解出来仍是**完整**目标（长过 80 字，证明没被截断值污染）
PASS  残行 payload 其余内容原样、且没有 goal 键

--- ⑤ 兜底扫：本次用户名下两张表不许有任何明文目标 ---
      row_to_json 含敏感词：tasks=0 task_pauses=0；明文位置有值：tasks(payload.goal/title)=0 task_pauses(goal)=0
PASS  tasks 里含敏感词的行数 = 0
PASS  task_pauses 里含敏感词的行数 = 0
PASS  tasks 里明文位置（payload.goal / title）有值的行数 = 0
PASS  task_pauses 里明文 goal 有值的行数 = 0

--- ⑥ 幂等：再重启一次，不该重复回填 ---
PASS  第三次启动没有再报回填（0 行可改 = 幂等，不是又加密了一遍）
PASS  多次重启后密文仍能解回原目标（没被二次加密）

=== 收尾6 goal 加密真库复验：全部 PASS ===
```

### 3.2 pglite 自检：`scripts/verify/task-encryption-pglite.mts`（EXIT=0）

```
=== 收尾6 · goal 加密（pglite 快速自检，跑的是生产代码本体）===
[db] 项目层迁移完成：当前项目补 0 行、权限开关补 0 行、知识库归属回填 资料 0 条 / 片段 0 条

--- ① POST /agent/task/start：目标只以密文落库 ---
  PASS 200 建出任务
      SELECT → {"title":null,"payload":{"steps":[]},"goal_enc":"gcm$9zoJTdThT4tZYRNw$6kt23Ki…"}
  PASS payload 里**没有 goal 键**（明文那份不存在）
  PASS title 为 NULL（不再抄一份 goal 前 80 字当明文副本）
  PASS goal_enc 是 gcm$ 开头的密文
  PASS 整行 row_to_json 里搜不到任何一个敏感词
  PASS 密文列里一个中文字都没有（不是把原文塞进新列充数）
  PASS 用同一把 DATA_KEY 能解回**原目标**

--- ② 用户能感知：/agent/task/current 与 /agent/task/doc 仍拿得到目标 ---
[llm] #1 tag=agent/task/finish taskKind=default model=test-model reason=默认路由 stream=no
[agent] 收尾整理未用模型（走兜底，任务仍算完成）： fetch failed
[notify:noop] 未接真实推送 · user=1 · 任务结果已生成（任务 #1）
  PASS 200 收尾（模型连不上走兜底文档，任务仍算完成）
  PASS 收尾后 payload 依然没有 goal 键、result_enc 是密文
  PASS 任务文档的「## 目标」是**解密后的原目标**（用户看到的不是空白）
  PASS /agent/task/current 回的 goal 是原目标（桌面刷新后还原任务卡靠它）

--- ③ POST /agent/task/step：写回 payload 时不把明文 goal 抄回去 ---
[llm] #2 tag=memories/extract:task_end taskKind=extract model=test-model reason=记忆抽取，需要 JSON 输出 stream=no
  PASS 200 追加了一步
      写回后 payload = {"steps":["打开了网银页面"]}
  PASS ★ 写回后 payload 里的明文 goal 被摘掉了（不是原样展开写回）
  PASS steps 正常保留（摘 goal 没有把功能一起吃掉）
  PASS 这一行整行 row_to_json 里也搜不到敏感词了

--- ④ POST /agent/loop/pause：task_pauses 只落密文 ---
[loop] 新循环 loop_muesqbj8_1（智能体 101，页 901，上限 10 步）
  PASS 200 建循环
[loop] 循环 loop_muesqbj8_1 已挂起（by=user），消息历史保留 2 条、已走 0 步
[loop] 暂停 loop_muesqbj8_1（by=user，页 901，记录 1）—— 消息历史保留 2 条 / 已走 0 步
  PASS 200 挂起
      SELECT → {"goal":null,"goal_enc":"gcm$CEjAnIIb/8rY1ZPs$6/6kJyN…"}
  PASS task_pauses.goal 明文列为 NULL
  PASS goal_enc 是 gcm$ 密文
  PASS 整行 row_to_json 里搜不到敏感词
  PASS 解密回来等于原目标
  PASS /agent/loop/pauses 仍返回**明文目标**（用户/恢复流程看得见）

--- ⑤ migrateTaskGoalEncryption：历史明文行回填 + 幂等 ---
[db] 收尾6 goal 密文回填：task_pauses 1 条、tasks 3 条（新加密 4 条、密文与明文不一致 0 条、失败 0 条留待下次）
      第一次：{"skipped":false,"pauses":1,"tasks":3,"encrypted":4,"mismatched":0,"failed":0}
  PASS 回填计数如实（task_pauses 1 条、tasks 3 条 = 本段 2 条 + ③ 段那条老行）
  PASS 老暂停行：明文列清空、密文能解回原目标
  PASS 老任务行：payload 去掉 goal、title 清空、其余键（steps/doc）原样保留
  PASS 只剩 title 的更老行：title 里的明文也进了密文列（不留第二份副本）
      第二次（幂等）：{"skipped":false,"pauses":0,"tasks":0,"encrypted":0,"mismatched":0,"failed":0}
  PASS ★ 幂等：第二次跑 0 条改动、不抛、密文没被二次加密
      row_to_json 整行扫描 → 含敏感词的行数：tasks=0 task_pauses=0
      明文位置残留 → tasks.payload.goal/title 有值的行=0、task_pauses.goal 有值的行=0
  PASS 全库兜底扫：tasks / task_pauses 两张表里一行明文都不剩

--- ⑥ 残行：goal_enc 已有值 + 明文也还在（灰度/回滚形状）必须被清干净 ---
[db] 收尾6 goal 密文回填：task_pauses 3 条、tasks 1 条（新加密 1 条、密文与明文不一致 1 条、失败 0 条留待下次）
      残行回填：{"skipped":false,"pauses":3,"tasks":1,"encrypted":1,"mismatched":1,"failed":0}
  PASS 四条残行都被处理了（pauses 3 条 + tasks 1 条），没有一条因为「已有密文」被跳过
  PASS 残行 A：明文清空，且**密文一个字节没被改**（不是重新加密一遍）
  PASS 残行 B：title 截断值被清掉，密文保持**完整目标**（没被 80 字截断值覆盖）
  PASS 残行 C：密文解不开 → 用明文重加密（数据被救回来，不是留个解不开的壳）
  PASS 残行 D：密文与明文不一致 → 保留密文、清明文、mismatched 计数 +1
  PASS encrypted 只算了真需要新加密的那 1 条（残行 C）
      残行整行扫描 → task_pauses=0 tasks=0
  PASS 四条残行整行里都搜不到敏感词了

--- ⑦ fail-closed：拿不到 cipher 就不动，绝不写明文兜底 ---
[db] 收尾6 goal 密文回填**跳过**：没拿到 cipher（DATA_KEY）——明文行原样保留、绝不写兜底明文，下次启动自动再试
      无 cipher：{"skipped":true,"pauses":0,"tasks":0,"encrypted":0,"mismatched":0,"failed":0}
  PASS skipped=true、计数全 0（如实报告「我没干」，不是假装成功）
  PASS 明文行原样保留（等下次启动带钥匙再来），密文列没被塞进任何明文/占位值

=== 收尾6 pglite 自检：PASS 37 / FAIL 0 ===
```

---

## 4. 反证：把生产代码改坏，验收必须变红

每个变异都是**改生产代码本体**（不是改脚本里的副本），跑完立刻还原，
并用 `md5sum -c` 逐字节校验还原成功。

| # | 改坏了什么 | 真库脚本 | pglite 自检 |
| --- | --- | --- | --- |
| M1 | `task/start` 回到明文 `payload={goal,…}` + `title` | FAIL（11 项） | FAIL（4 项） |
| M2 | `pause` 把 `session.goal` 明文写回 `goal` 列 | FAIL（6 项） | FAIL（3 项） |
| M3 | `index.ts` 摘掉 `migrateTaskEncryptionWithRetry` 调用（函数还在，没人调） | FAIL（等不到回填日志，超时） | — |
| M4 | `task/current` 只读明文 `payload.goal`（不解密） | FAIL（1 项） | FAIL（1 项） |
| M5 | `task/step` 写回时不摘明文 goal（`payloadWithoutGoal` 拿掉） | — | FAIL（2 项） |
| M6 | `migrateTaskGoalEncryption` 的 fail-closed 闸拿掉（`if (!cipher)` → `if (false)`） | — | FAIL（1 项：谎报 `skipped:false`） |
| M7 | 回填只写密文列、**不清明文** | — | FAIL（5 项） |
| M8 | 回填扫描条件退回 `WHERE goal_enc IS NULL`（第 2 节那个 bug） | FAIL（4 项） | FAIL（7 项） |

### M1 实际输出（真库）

```
FAIL  tasks.title 为 NULL（不再抄 goal 前 80 字当明文副本）；实际 "帮我查一下 银行卡6222021234567890 的余额，登录用 密码Zx9!secret，实名 身份证110101199003071234"
PASS  tasks.payload 里没有 goal 键；实际键 = ["steps"]
FAIL  tasks 整行 row_to_json 里读不到「银行卡6222021234567890」
FAIL  tasks 整行 row_to_json 里读不到「密码Zx9!secret」
FAIL  tasks 整行 row_to_json 里读不到「身份证110101199003071234」
FAIL  收尾后 title 仍然是 NULL
FAIL  收尾后 tasks 整行里读不到「银行卡6222021234567890」
FAIL  tasks 里含敏感词的行数 = 1
FAIL  tasks 里明文位置（payload.goal / title）有值的行数 = 1
=== 收尾6 goal 加密真库复验：FAIL ===
```

> 注意 M1 里 `payload 里没有 goal 键` 仍然 PASS —— 因为 `task/step` 的 `payloadWithoutGoal`
> 是**独立的一道闸**，它把明文 goal 摘掉了，但 `title` 那份副本还在。
> 两道闸各管一处，缺一个就漏一个，这正是 M5 要单独验的原因。

### M2 实际输出（真库）

```
FAIL  task_pauses.goal 明文列为 NULL；实际 "帮我查一下 银行卡6222021234567890 的余额，登录用 密码Zx9!secret，实名 身份证110101199003071234"
FAIL  task_pauses 整行 row_to_json 里读不到「银行卡6222021234567890」
FAIL  task_pauses 里含敏感词的行数 = 1
FAIL  task_pauses 里明文 goal 有值的行数 = 1
=== 收尾6 goal 加密真库复验：FAIL ===
```

### M3 实际输出（真库，验的是 index.ts 接线而不是函数）

```
PASS  重启前它是明文形状（goal 有值、goal_enc 为 NULL）—— 否则这段验收是自欺
FAIL  脚本异常： 等待超时：启动日志出现 goal 密文回填完成
=== 收尾6 goal 加密真库复验：FAIL ===
```

### M4 实际输出（真库，验「用户能感知」那条断言不是摆设）

```
FAIL  GET /agent/task/current 的 goal 是解密后的原文（桌面刷新后还原任务卡靠它）
=== 收尾6 goal 加密真库复验：FAIL ===
```

### M5 实际输出（pglite）

```
  ★FAIL ★ 写回后 payload 里的明文 goal 被摘掉了（不是原样展开写回）  —— payload 又出现了 goal：{"goal":"转账到 银行卡6222021234567890，密码 密码Zx9!secret","steps":["打开了网银页面"]}
  ★FAIL 这一行整行 row_to_json 里也搜不到敏感词了  —— payload 里读到「密码Zx9!secret」
=== 收尾6 pglite 自检：PASS 28 / FAIL 2 ===
```

### M6 实际输出（pglite，fail-closed 被拿掉后会**谎报成功**）

```
      无 cipher：{"skipped":false,"pauses":0,"tasks":0,"failed":1}
  ★FAIL skipped=true、计数全 0（如实报告「我没干」，不是假装成功）
=== 收尾6 pglite 自检：PASS 29 / FAIL 1 ===
```

### M7 实际输出（pglite，半拉子迁移：只加密文不清明文）

```
  ★FAIL 回填计数如实（task_pauses 1 条、tasks 3 条 = 本段 2 条 + ③ 段那条老行）  —— tasks=0
  ★FAIL 老暂停行：明文列清空、密文能解回原目标  —— goal="老任务：把 身份证110101199003071234 的资料下载下来"
  ★FAIL 老任务行：payload 去掉 goal、title 清空、其余键（steps/doc）原样保留  —— {"doc":{"summary":"做完了"},"goal":"老任务目标 密码Zx9!secret","steps":["第一步"]}
  ★FAIL 只剩 title 的更老行：title 里的明文也进了密文列（不留第二份副本）  —— title="只剩标题的老任务 身份证110101199003071234"
  ★FAIL 全库兜底扫：tasks / task_pauses 两张表里一行明文都不剩  —— tasks 还有 3 行整行里搜得到敏感词
=== 收尾6 pglite 自检：PASS 25 / FAIL 5 ===
```

### M8 实际输出（真库，第 2 节那个 bug 的回归闸）

```
--- SELECT title, payload, goal_enc FROM tasks WHERE id = 24（残行）---
{"title":"完整目标：先把 银行卡6222021234567890 最近三年的流水全部导出来存成本地表格，登录时用 密码Zx9!secret，经办人实名信息是 身份证110","payload":{"steps":["残行步骤"]},"goal_enc":"gcm$WxUkEHs0SH6iZDp3$SHUVem4dmW2…"}
FAIL  残行（密文+明文同时有值）重启后明文列被清掉 —— 没有因为「已有密文」被跳过
FAIL  残行 tasks.title 的截断明文被清掉
FAIL  tasks 里含敏感词的行数 = 1
FAIL  task_pauses 里含敏感词的行数 = 1
=== 收尾6 goal 加密真库复验：FAIL ===
```

pglite 侧同一个变异红 7 项：

```
  ★FAIL 四条残行都被处理了（pauses 3 条 + tasks 1 条），没有一条因为「已有密文」被跳过  —— pauses=0
  ★FAIL 残行 A：明文清空，且**密文一个字节没被改**（不是重新加密一遍）  —— goal="完整目标：把 银行卡6222021234567890 …"
  ★FAIL 残行 B：title 截断值被清掉，密文保持**完整目标**（没被 80 字截断值覆盖）
  ★FAIL 残行 C：密文解不开 → 用明文重加密（数据被救回来，不是留个解不开的壳）
  ★FAIL 残行 D：密文与明文不一致 → 保留密文、清明文、mismatched 计数 +1  —— mismatched=0
  ★FAIL encrypted 只算了真需要新加密的那 1 条（残行 C）  —— encrypted=0
  ★FAIL 四条残行整行里都搜不到敏感词了
=== 收尾6 pglite 自检：PASS 30 / FAIL 7 ===
```

---

## 5. 直接 SELECT 的原始结果（独立取证，不属于验收脚本）

真 PostgreSQL 17.10（`postgres://…@127.0.0.1:55432/verifydb`），
下面这份是**修复版跑完一次启动之后**的库状态 —— 明文位置全 0、敏感词全 0：

```

=== 启动前 · tasks 明文位置残留 ===
[
 {
  "总行数": 24,
  "payload含goal": 0,
  "title有值": 0,
  "有密文": 24
 }
]

=== 启动前 · task_pauses 明文位置残留 ===
[
 {
  "总行数": 24,
  "goal有值": 0,
  "有密文": 24
 }
]

=== 启动前 · 含敏感词的行（整行 row_to_json 扫描） ===
[
 {
  "tasks含敏感词": 0,
  "pauses含敏感词": 0
 }
]

=== 启动前 · 那两行残行长什么样 ===
[]

=== 启动日志（回填相关）===
[db] 项目层迁移完成：当前项目补 0 行、权限开关补 0 行、知识库归属回填 资料 0 条 / 片段 0 条

=== 启动后 · tasks 明文位置残留 ===
[
 {
  "总行数": 24,
  "payload含goal": 0,
  "title有值": 0,
  "有密文": 24
 }
]

=== 启动后 · task_pauses 明文位置残留 ===
[
 {
  "总行数": 24,
  "goal有值": 0,
  "有密文": 24
 }
]

=== 启动后 · 含敏感词的行（整行 row_to_json 扫描） ===
[
 {
  "tasks含敏感词": 0,
  "pauses含敏感词": 0
 }
]

=== 启动后 · 最近 3 行 tasks 原始内容 ===
[
 {
  "id": "24",
  "status": "done",
  "title": null,
  "payload": {
   "steps": [
    "残行步骤"
   ]
  },
  "goal_enc前34": "gcm$sdjlSdQO0h1/tLJ4$z+lYcMJhMTcig"
 },
 {
  "id": "23",
  "status": "done",
  "title": null,
  "payload": {
   "doc": {
    "summary": "老的结论"
   },
   "steps": [
    "老步骤"
   ]
  },
  "goal_enc前34": "gcm$lWpTPcJxgj7L4z7f$EZ7Ju4+KwaSjo"
 },
 {
  "id": "22",
  "status": "done",
  "title": null,
  "payload": {
   "doc": {
    "hint": "任务结果已生成",
    "title": "任务记录",
    "outline": [],
    "summary": "余额已查到"
   },
   "steps": [
    "打开了网银首页"
   ]
  },
  "goal_enc前34": "gcm$G38RmUu1qbcf61Z9$uOoBKOjZCBEu6"
 }
]

=== 启动后 · 最近 3 行 task_pauses 原始内容 ===
[
 {
  "id": "24",
  "loop_id": "residue-loop-verify6",
  "goal": null,
  "goal_enc前34": "gcm$XfqlnMIPFAj3v7yR$psp1ZIDVcSwYF",
  "paused_by": "user"
 },
 {
  "id": "23",
  "loop_id": "legacy-loop-verify6",
  "goal": null,
  "goal_enc前34": "gcm$l0gAxF2P432r7Vi2$DZnLad/tCvuTR",
  "paused_by": "user"
 },
 {
  "id": "22",
  "loop_id": "loop_muesl2m3_1",
  "goal": null,
  "goal_enc前34": "gcm$aHFI34TNRT6e4MY0$sa0YbXWHJVcpy",
  "paused_by": "user"
 }
]
```

---

## 6. npm 脚本与 EXIT 码

| 命令 | 内容 | EXIT |
| --- | --- | --- |
| `npm run verify:db` | checkpoint 加密 + board 落库锁 + **收尾6 真库** + **收尾6 pglite** | **0** |
| `npm run verify:db:pglite` | 只有收尾6 pglite 自检（不需要外部库） | **0** |
| `npm run verify` | 全量（链尾新加 pglite 自检） | **0** |
| `npm run typecheck` | shared + desktop + server 三端 | **0** |

新增/修改的脚本名：`verify:db`（加挂两个）、`verify:db:pglite`（新增）、`verify`（链尾加挂 pglite 自检）。

> 为什么把 pglite 自检也塞进 `verify`：它不需要外部数据库，跑的是生产代码本体，
> 4 秒出结果 —— 没配真库的人也该被这道闸拦住。真库那份仍然只在 `verify:db` 里。

---

## 7. 本批查到但没修的问题（一条不藏）

1. **`tasks.payload.steps` 与 `payload.doc.*` 仍是明文。**
   goal 加密后，同一行 JSONB 里的步骤摘要（「打开了网银首页」）还是明文中文。
   这是 R2 起的既有设计（步骤摘要走 `scrubStepSummary` **脱敏但不加密**），
   不在收尾6 的 goal 口径内。要不要整列加密 `payload` 需要用户拍板 ——
   代价是「任务列表/步骤账本」的每次读都要解密，且 SQL 里再也不能直接查步骤。
2. **`tasks.result_enc` 解出来的任务文档正文里含 goal 明文。**
   文档是给人看的（`## 目标` 那一段），落库是密文列，解密后可见属设计如此。
   但如果哪天要「文档导出不带目标」，得在 `buildFallbackDoc` / 模型提示词层另做。
3. **`GET /agent/task/current`、`/agent/task/doc`、`/agent/loop/pauses` 会把 goal 明文回给客户端。**
   必须如此（否则任务卡、文档、恢复提示全空白），传输只靠本机回环 + JWT，没有额外字段级加密。
4. **旧明文列没有 DROP**：`tasks.title`、`tasks.payload.goal`（键）、`task_pauses.goal` 都还留着
   （恒为 NULL / 不存在）。DROP 会让「回滚到收尾6 之前的代码」直接报错，
   留着的代价只是表结构上多一列死列。要不要 DROP、什么时候 DROP，需要用户拍板。
5. **启动回填是全表扫描**：`WHERE (payload->>'goal') IS NOT NULL OR title IS NOT NULL` 用不上索引，
   每次启动都要扫 `tasks` / `task_pauses` 一遍。当前规模（几十~几千行）无感，
   几十万行会有启动开销。可选修法：回填完成后在 `schema_meta` 里记一个水位，之后只扫水位以后的行。
6. **`handoffs/*.md` / `board.md` 仍是明文落盘**，而且里面直接插了 `${data.goal}`
   （`orchestrator/handoff.ts:112`）—— 库里 goal 已经全密文，磁盘上那份还是原文，
   口径不一致。**这是收尾8 的活**，本批没动。
7. **记忆提取的 transcript 里含 goal 明文**（`triggerTaskExtract` 拼给模型的文本）。
   落库那头是密文列（`memories.value_enc / content_encrypted`），但**发给模型**的那一次是明文 ——
   这是所有「让模型理解任务」的功能共同的前提，本批只保证不再因为 payload 里没有 goal 而丢这一行。
8. **桌面端内存里仍持有 goal 明文**（`electron/main.ts` 调 `/agent/task/start` 的请求体）。
   核查过：没有打进日志、没有落盘。客户端侧的内存明文不在本批范围。

---

## 8. 怎么复现

```bash
# 1) 起一个真 PostgreSQL（本沙箱用的是 embedded-postgres 17.10 真二进制，UTF8）
#    任何真 PG 都行，例如：npm run db:up
export VERIFY_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55432/verifydb'

# 2) 真库全链路（真服务端 + 真登录 + 直连 SELECT + 真重启验回填 + 幂等）
VERIFY_PORT=18788 node scripts/verify/task-encryption-db.mjs

# 3) pglite 快速自检（不需要外部库）
npx tsx scripts/verify/task-encryption-pglite.mts

# 4) 一起跑
npm run verify:db
```

> ⚠️ 库里必须是**可以随便写**的测试库：脚本会建表、插用户、插任务与暂停记录。
> 所有断言按本次登录出来的 `user_id` 收口，不会误判库里既有数据，但也不会替你清理。
> ⚠️ 三次启动共用一把 `JWT_SECRET`（脚本内固定），否则重启后旧 token 直接 401，
> 验的就成了鉴权而不是加密 —— 第一版就栽在这里。

---

## 9. 条件验收（2026-09-24）：用户「有条件通过」后的三条必做 + 拍板 + 两件小事

上一版（第 1–8 节）交付后，用户给的是**有条件通过**：条件 1/2/3 必做，另有三项拍板与两件小事。
本节是这些条件的落地与实际输出。对应提交：`d5abe05`（代码 + 脚本 + README），本节文档随后提交。

### 9.0 一句话结论

三条必做全部落地并被验收盯住；两项反证（M9b / M9c）证明新的闸真的会红；
真库 `87 PASS / 0 FAIL`、pglite `54 PASS / 0 FAIL`、M9 真服务端 `21 PASS / 0 FAIL`，
`npm run verify`、`npm run verify:db`、`npm run typecheck` 三个 EXIT 全 0。

### 9.1 条件 1 —— `tasks.title` 停用之后，界面到底显示什么

**要求**：查清任务列表类接口用哪个字段显示、给出真实返回样本与桌面渲染那一行读的字段；
如果列表标题会空白，就把 title 改存脱敏摘要（走 `scrubStepSummary`）而不是 NULL；并补验收断言
「列表显示字段非空 且 不含敏感词」。

**查清的事实**（取证命令与实际输出）：

```
$ grep -rn "'/agent/tasks\|/agent/task/list\|task/list" apps/server/src apps/desktop/src
（无输出）                      ← 服务端**没有**任何任务列表接口

$ grep -rn "task/current" apps/server/src/routes/agent.ts
 *   GET  /agent/task/current → 我最近一条任务（桌面刷新后还原任务卡用）

$ grep -n "目标：" apps/desktop/src/App.tsx
3284:                {curTask.goal ? ` · 目标：${curTask.goal}` : ''}
```

- 唯一会被界面读到的显示路径是 `GET /agent/task/current` → 桌面 `App.tsx:3284` 渲染 `curTask.goal`
  （`CurrentTask` 类型在 `App.tsx:237-247`）。
- `tasks.title` 这一列**从来没有被返回给任何客户端**：接口里出现的 `title` 全是
  「任务文档标题」（`/agent/task/doc` 的 `{ title, markdown }`、收尾时的 `docTitle`），
  由收尾提示词生成，与 `tasks.title` 列无关。

**因此**：停用 `tasks.title` **不会**让任何列表标题空白 → 用户给的条件（「如果列表标题会空白才改存脱敏摘要」）
**不触发**，title 保持 NULL。这一条按用户的原话执行，没有自作主张改存摘要。

**但仍然补了两件事**，因为「显示字段非空 + 不含敏感词」这个要求本身是对的：

1. `/agent/task/current` 多回一个 `displayTitle`：同一句 goal 过 `scrubTaskText` 脱敏、截 80 字。
   给「要落日志 / 截图 / 将来做列表」的场景用 —— 那种场景不该出现原文，而 `goal` 字段必须是原文。
2. 验收断言（真库 9 项 + pglite 5 项）：非空、≤80 字、不含三个敏感词、留了脱敏占位、
   是那句目标的脱敏版（不是随便填的占位文字）、`title` 没有偷偷存一份摘要、`goal` 仍是原文。

**真实返回样本**（真库，`GET /agent/task/current`）：

```json
{"id":35,
 "displayTitle":"帮我查一下 银行卡[已脱敏·card·79字] 的余额，登录用 密码[已脱敏·password·10字]，实名 身份证[已脱敏·card·79字]",
 "goal":"帮我查一下 银行卡6222021234567890 的余额，登录用 密码Zx9!secret，实名 身份证110101199003071234"}
```

（`title` 键不在返回里 —— 那一列是 NULL，接口也不回它。）

**验收输出（真库那段）**：

```
PASS  ★ 条件1：显示字段 displayTitle 非空（实际 "帮我查一下 银行卡[已脱敏·card·79字] …"）
PASS  ★ 条件1：显示字段不超 80 字（实际 73 字，跟当年 title 一个量级，不撑破界面）
PASS  ★ 条件1：显示字段里读不到「银行卡6222021234567890」
PASS  ★ 条件1：显示字段里读不到「密码Zx9!secret」
PASS  ★ 条件1：显示字段里读不到「身份证110101199003071234」
PASS  ★ 条件1：显示字段留了脱敏占位（看得出被改过，不是悄悄截断）
PASS  ★ 条件1：显示字段确实是那句目标的脱敏版（不是随便填的占位文字）
PASS  ★ 条件1：title 没有偷偷存一份脱敏摘要（实际 undefined）
PASS  ★ 条件1：功能字段 goal 仍是还原后的原文（脱敏只作用于显示副本，没把功能吃掉）
```

### 9.2 条件 2 —— 热路径 fail-closed，加变异 M9

**要求**：让 `POST /agent/task/start` 与 `POST /agent/loop/pause` 在**路由层拿不到 cipher**，
断言 ① 回 500 ② 两张表**零新增行**，对齐收尾 1「库里一行都不落」。

**代码改动**：`task/start` 上一版已经是 fail-closed；本轮改的是 **`loop/pause`** ——
把加密挪到 `ingestToolResult` / `pauseLoop` **之前**，拿不到 cipher 或加密抛错就
500 `goal_encrypt_failed`，不认领回执、不把循环标成 paused、不写 `task_pauses`。
上一版的行为是「台账照写、`goal_enc` 置空」，那会留下**内存里挂着、库里没台账**的半成品
（用户重启后看不见这一路暂停，服务端却以为它挂着）—— 用户拍板改成现在这样。

**M9 真服务端反证**（`npm run verify:db:mutate-nocipher`，真 Postgres + 真装配）：
脚本临时把 `apps/server/src/index.ts` 里两处路由注册的 `cipher` 注入改成 `null`，跑完按 md5 逐字节还原。

```
[起飞前] index.ts 干净，md5=81ab24d72d6598f84e9e15d1a62a7109
[变异] git diff --stat： apps/server/src/index.ts | 4 ++--  (2 insertions, 2 deletions)
PASS  变异后的服务端照样能起来（故障是「路由层没拿到 cipher」，不是「服务起不来」）

--- ① POST /agent/task/start（路由层 cipher=null）---
      → 500 {"error":"任务目标加密失败：这条任务没有建，请重试（服务端绝不把目标明文落库）","code":"goal_encrypt_failed"}
PASS  ★ M9-①：task/start 回 **500**（实际 500）
PASS  ★ M9-①：错误码是 goal_encrypt_failed
PASS  ★ M9-①：错误话术说清了「这条任务没有建」（用户不会以为建成功了）

--- ② POST /agent/loop/start + pause（路由层 cipher=null）---
      loop/start → 200 {"loopId":"loop_mueum86d_1",…}
      loop/pause → 500 {"error":"暂停失败：任务目标加密不了，这一路没有被挂起（服务端绝不把目标明文落库）","code":"goal_encrypt_failed"}
PASS  ★ M9-②：loop/pause 回 **500**（实际 500）
PASS  ★ M9-②：错误码是 goal_encrypt_failed
PASS  ★ M9-②：话术说清了「这一路没有被挂起」

--- 打之前：tasks=43 task_pauses=44 ---
--- 打之后：tasks=43 task_pauses=44 ---
PASS  ★ M9-③：tasks 一行都没多
PASS  ★ M9-③：task_pauses 一行都没多
      本次用户名下扫目标串/敏感词 → tasks=0 task_pauses=0
PASS  ★ M9-④：tasks 里搜不到这次的目标明文（0 行）
PASS  ★ M9-④：task_pauses 里搜不到这次的目标明文（0 行）
      loop/info：打之前 status=running → 打之后 status=running
PASS  ★ M9-⑤：循环内存状态没被改 —— 不留「内存挂着、库里没台账」的半成品
PASS  ★ M9-⑤：没落库却把循环标成 paused 的话就是账实不一致，这里必须不是 paused
      服务端 warn 原文：[loop] 暂停 loop_mueum86d_1 被拒绝：目标加密失败，内存与库都不动（不回退明文、不留半成品状态）—— 未注入 cipher（DATA_KEY 缺失）
PASS  ★ M9-⑤：服务端把这次拒绝 warn 出来了（不是静默失败）
PASS  ★ M9-⑤：那条 warn 里不含目标明文（日志不是第二个明文出口）

[还原] apps/server/src/index.ts md5 81ab24d72d6598f84e9e15d1a62a7109 == 变异前，逐字节还原
--- ⑥ 对照组：还原后重启，同一个 pause → 200 {"ok":true,"paused":true,"recordId":43}
PASS  对照组：有钥匙时 loop/pause 回 200（证明上面的 500 是「没钥匙」造成的，不是路由本来就坏）
[收尾] git status --porcelain apps/server/src/index.ts → ""（必须是空串）
=== 条件2 反证 M9（真服务端）：全部 PASS ===        （21 PASS / 0 FAIL，EXIT 0）
```

**pglite 常驻闸**（`task-encryption-pglite.mts` 第 ⑧ 段，每次 `npm run verify` 都跑）：
再起一个 `cipher: null` 的 app，打的是同一份生产路由代码。M9-1…M9-5 与对照组同样全绿：

```
      打之前：tasks=6 task_pauses=4
      task/start → 500 {"error":"任务目标加密失败：这条任务没有建…","code":"goal_encrypt_failed"}
  PASS ★ M9-1 task/start：拿不到 cipher → **500**（不是 200 悄悄写明文）
      loop/pause → 500 {"error":"暂停失败：任务目标加密不了，这一路没有被挂起…","code":"goal_encrypt_failed"}
  PASS ★ M9-2 loop/pause：拿不到 cipher → **500**（不许「行照写、goal_enc 置空」）
      打之后：tasks=6 task_pauses=4
  PASS ★ M9-3 两张表**一行都没多**（对齐收尾1「库里一行都不落」）
  PASS ★ M9-4 内存会话状态也没被改
      全库扫 → tasks=0 task_pauses=0
  PASS ★ M9-5 那个目标串在整个库里搜不到
  PASS 对照组：有钥匙的 app 打同一个 pause → 200 并落密文
```

**反证的反证（M9 这个闸自己是不是摆设）**：把生产代码的 fail-closed 闸拆掉，M9 必须变红。

| 变异 | 改法 | M9 真服务端结果 | 还原 |
| --- | --- | --- | --- |
| **M9b** | `loop.ts`：拆掉 pause 的闸，退回旧 fail-open（`catch { goalEnc = null }`，台账照写） | **EXIT 1，7 项 FAIL**：M9-② 3 项（实际回 200）、M9-③ `task_pauses 39 → 40`、M9-⑤ 3 项（`running → paused`、没有拒绝 warn） | md5 `e32b1526…` → `e32b1526…` 一致 |
| **M9c** | `agent.ts`：拆掉 task/start 的闸，没钥匙就把**明文当密文**写进 `goal_enc`（R2 记录的事故形状） | **EXIT 1，5 项 FAIL**：M9-① 3 项（实际回 200、`taskId:39`）、M9-③ `tasks 38 → 39`、M9-④ `tasks 里搜到 1 行明文` | md5 `4ab7d150…` → `4ab7d150…` 一致 |

M9c 那一行特别值得记：它正是「加密不行就退回明文先把任务建起来」的事故形状，
而 M9-④ 的扫描**真的把明文从库里搜出来了**（`tasks=1`），说明这条断言不是摆设。

> 变异跑会在复用的验证库里留下真含明文的残行（M9c 留下的 `tasks#39` 已删）。
> 因此 M9-④ 的扫描**收口到本次登录用户**（与 `task-encryption-db.mjs` 同口径），
> 否则上一次的变异账会让下一次跑无故变红 —— 那是在验旧账，不是在验这次的闸。

### 9.3 条件 3 —— 密文与明文不一致时，两份都留、交人判断

**要求**：不一致时**不要**清明文；两份都留 + 启动日志 warn 列出受影响行 id；
只有「明文在、密文缺失或解不开」才自动加密。反证：造一条不一致行，重启后断言明文仍在且 warn 有记录。

**`migrateTaskGoalEncryption` 现在是逐行三分支**（两张表同一口径）：

| 行的形状 | 处置 | 计数 |
| --- | --- | --- |
| 明文有值 + 密文缺失或解不开 | **自动加密**（唯一允许自动写密文的情况）；`tasks` 取明文时 `payload.goal` 优先于 `title`（title 是 80 字截断值） | `encrypted` |
| 密文可解 + 与明文一致 | 明文是冗余副本 → 清掉；`tasks.title` 的「一致」按**前缀**判（`have.startsWith(title)`），title 不是前缀（人工设过的标题）就不动 | `pauses` / `tasks` |
| 密文可解 + 与明文**不一致** | **整行不动，两份都留** → warn 出行 id 交人判断；每次启动都会重报，不被「已处理」吃掉 | `mismatched` + `mismatchedIds` |

为什么不自动清：明文那份可能是唯一还能读的内容（密文可能是旧 `DATA_KEY` 封的、内容已过时），
密文那份可能是更完整的原文（明文可能是截断/脱敏过的）。**选错任何一边都是不可逆的数据丢失**，
机器没有资格替人做这个取舍 —— 宁可留着 + 吵一句。

**真库取证**（造两条不一致行 → 真重启 → 直接 SELECT）：

```
--- SELECT goal, goal_enc FROM task_pauses WHERE id = 38（不一致行）---
{"goal":"不一致的明文暂停目标，里面还有 密码Zx9!secret","goal_enc":"gcm$2tA0vhp5W0wGfSk4$5TnlrpYFydu…"}

--- SELECT title, payload, goal_enc FROM tasks WHERE id = 38（不一致行）---
{"title":null,"payload":{"goal":"不一致的明文任务目标，里面还有 银行卡6222021234567890","steps":["不一致行的步骤"]},"goal_enc":"gcm$rjhUyQoOTnzVZKu4$udLOTggOq8w…"}

--- 重启后的服务端日志（不一致行 warn 原文）---
[db] 收尾6 ★ 密文与明文**不一致** 2 行：两份都留着、一行没动，请人工判断 —— task_pauses#38、tasks#38
[server] goal 回填有 2 行「密文与明文不一致」，已保留两份、未自动清理；请按上面 [db] 那条 warn 里的行 id 人工核对（收尾6 条件3：机器不替人做不可逆的取舍）

PASS  ★ 条件3：不一致的 task_pauses 行**明文还在**（没被自动清掉）
PASS  ★ 条件3：不一致的 task_pauses 行**密文逐字节没变**（没被明文覆盖）
PASS  ★ 条件3：那份密文仍能解出它自己的内容（两份都可读，人才有的判）
PASS  ★ 条件3：不一致的 tasks 行 payload.goal **还在**
PASS  ★ 条件3：不一致行的 payload 其余内容也没被动过（整行原样，不是只留一半）
PASS  ★ 条件3：启动日志**打了 warn**（不是只在返回值里记个数）
PASS  ★ 条件3：warn 里列出了受影响行 id task_pauses#38 / tasks#38
PASS  ★ 条件3：warn 里**不含目标内容**（只报 id，日志不该变成第二个明文出口）
PASS  ★ 条件3：第三次启动**仍然**报这两行不一致（人不来看它就一直吵）
PASS  ★ 条件3：第三次启动后明文依旧原样（多次重启也不会被清）
```

pglite 那份还额外断言了返回值里的 `mismatchedIds`（调用方不用去抠日志），
以及「能被自动清理的残行 A/B/C 密文逐字节没变、解回来仍是完整目标」。

**代价如实说**：不一致行的明文（可能含敏感词）会一直躺在库里，直到人工处理。
这是条件 3 明确选择的取舍，补偿控制是那条 warn。验收里**不假装它干净**：
pglite 专门造了一条明文含敏感词的不一致行（D2），断言它照留不误并打印说明；
真库的兜底扫（第 ⑤ 段）按 id 排除这两行，**同时断言排除数正好是 2** —— 免得「排除名单」将来悄悄变长。

### 9.4 三项拍板

1. **不加密 `payload` 整列，改为加强摘要脱敏。**
   `redact.ts` 新增 `scrubTaskText(text)`：原来 `scrubStepSummary` 只认两种「」形状
   （R2 评审当时就指出「挡不住其它形状的敏感数据」），现在叠加 `redactForStorage` 的
   `VALUE_PATTERNS`（密码 / 验证码 / 卡号 / 身份证 / CVV）按**值形状**脱敏；
   `scrubStepSummary` 委托给它，`taskDisplayTitle` 也用它。pglite ⑤-B 六条反例：

   ```
   存进去的 steps（6 条）：["写入完成 密码是 [已脱敏·password·13字]",
     "发送验证码 [已脱敏·otp·6字] 给用户","绑定银行卡 [已脱敏·card·25字]",
     "身份证 [已脱敏·card·26字] 已登记","CVV [已脱敏·card·3字] 校验通过",
     "老形状也要挡住：「银行卡[已脱敏·card·29字]」"]
   PASS 六条含敏感值的摘要，落进 payload.steps 后**一个敏感值都不剩**
   PASS 脱敏后仍然**可读**（留了占位，不是整条摘要被抹成空串）
   ```

   取舍：payload 里还有 `steps` / `doc` 等结构，整列加密会让每次读都要解密；
   而摘要本来就该是给人看的短文本，脱敏到位就够 —— 这是用户拍的板，不是回避。
   **`payload.steps` 仍是明文列**这一点没有变，只是现在挡得住敏感值了（见 9.8 第 1 条）。
2. **老明文列暂不 DROP**（`tasks.title`、`task_pauses.goal` 恒 NULL）：留着回滚能力，
   等批次 K 落地跑稳后再议。已记进 `docs/待办-R2残留-goal明文-20260922.md`。
3. **启动全表扫描的优化推迟**：水位线（`schema_meta` 记「已回填到的最大 id / 时间」）方案
   已写进同一份待办文档，不在本批做。

### 9.5 两件小事

1. **`r4-acceptance-HEAD.json` 是测试产物**：已加进 `.gitignore`（连同 `server-HEAD.log`）
   并 `git rm --cached` 移出版本控制（文件留在磁盘上；`r4-acceptance-main-old.json` 作为一次性基线仍跟踪）。
   证据：本轮跑完整 `npm run verify`（其中 `verify:r4` 会重新写出这个文件）之后，
   `git status --porcelain` 里**没有**它 —— 以前是每次跑完树都脏。
2. **README 写清威胁模型**：`README.md`「数据与安全」新增一条
   「★ goal 加密防的是什么、不防什么」—— 只防**数据库文件/备份被偷走**（`pgdata`、`pg_dump`、云盘备份、容器卷）；
   **不**防「目标明文发给模型」（拼提示词必然带原文，对模型服务商是明文）、
   **不**防「目标明文回桌面显示」（`task/current`、`task/doc`、`loop/pauses` 都解密后回原文，这是功能要求）、
   **不**防「持有 `DATA_KEY` 的人」（钥匙与库同机时，偷库和偷机器是同一件事）。
   一句话写在 README 里：**goal 加密 = 静态数据（at-rest）保护，不是端到端加密。**
   同时把 README 里暂停那段的**旧口径**（「台账照写、`goal_enc` 置空」）改成了条件 2 的 fail-closed，
   并补上「扫描条件是明文还在不在」「不一致行不自动清理」「title 停用后界面显示什么」三条。

### 9.6 脚本与 EXIT 码（本轮实际跑的）

| 命令 | 结果 | EXIT |
| --- | --- | --- |
| `npm run typecheck`（shared + desktop + server） | 三个包全过 | **0** |
| `npm run verify` | 工具表 / R4 / 编排 / websearch / 记忆 / 人设 / 协作 / 批次 + pglite 全绿；pglite `54 PASS / 0 FAIL` | **0** |
| `npm run verify:db` | 收尾1 全部 PASS、收尾2 全部 PASS、收尾6 真库 **87 PASS / 0 FAIL**、pglite **54 / 0** | **0** |
| `npm run verify:db:mutate-nocipher`（**本轮新增**） | 条件2 反证 M9：**21 PASS / 0 FAIL** | **0** |
| M9b（手工变异 `loop.ts`） | **7 FAIL** → 闸是真的 | 1（预期） |
| M9c（手工变异 `agent.ts`） | **5 FAIL** → 闸是真的 | 1（预期） |

新增 / 改动的验收脚本：

- **新增** `scripts/verify/task-encryption-nocipher.mjs` → `npm run verify:db:mutate-nocipher`
  （真服务端 + 真库的 M9；脏树拒跑、md5 逐字节还原、带对照组）。
  **没有**挂进 `verify:db` 主链：它会临时改生产文件，主链里跑一旦被 SIGKILL 就会留下变异体；
  常驻闸由 pglite 第 ⑧ 段承担（那条不碰生产文件）。
- `scripts/verify/task-encryption-pglite.mts`：37 → **54** 项（新增 ②-B 条件1、⑤-B 拍板脱敏、⑧ M9、⑥ 条件3 重写）。
- `scripts/verify/task-encryption-db.mjs`：61 → **87** 项（新增条件1 显示字段 9 项、条件3 跨三次重启 16 项、兜底扫排除口径）。

### 9.7 本轮改动的文件

| 文件 | 改了什么 |
| --- | --- |
| `apps/server/src/orchestrator/redact.ts` | 新增 `scrubTaskText` / `taskDisplayTitle` |
| `apps/server/src/routes/agent.ts` | `scrubStepSummary` 委托 `scrubTaskText`；`task/current` 回 `displayTitle` |
| `apps/server/src/routes/loop.ts` | `pause` 改成**先加密再动状态**，fail-closed 500 `goal_encrypt_failed` |
| `apps/server/src/db.ts` | `migrateTaskGoalEncryption` 逐行三分支；新增 `mismatchedIds` / `MISMATCH_IDS_MAX` |
| `apps/server/src/index.ts` | 启动日志如实报不一致行数（只报数与 id，不报内容） |
| `README.md` | 威胁模型 + 条件1/2/3 口径（含改掉暂停那段的旧描述） |
| `.gitignore` | r4-dispatch 的 HEAD 产物 |
| `package.json` | `verify:db:mutate-nocipher` |
| 两个验收脚本 + 新增一个 | 见 9.6 |

### 9.8 本轮查到但没修（增量，接第 7 节）

1. `tasks.payload.steps` / `payload.doc.*` 仍是**明文列**：本轮把脱敏做到了值形状级（9.4-1），
   但「明文存储」这件事没变 —— 不在 goal 口径内，属 R2 起的既有设计。
2. **不一致行的明文会一直留到人工处理**（条件 3 的取舍）：warn 是唯一补偿控制，
   没有做「不一致行自动开一张人工介入卡片」之类的后续动作 —— 那属于批次 K 的活。
3. `displayTitle` 目前只有 `/agent/task/current` 一个出口在用，桌面还没改成读它
   （桌面那行渲染读的是 `goal`，功能上没问题）；等前端定稿时一起接。
4. `MISMATCH_IDS_MAX = 50`：不一致行超过 50 条时日志只列前 50 + 总数。
   真出现那种规模说明有系统性问题（例如换过 `DATA_KEY`），届时要做的不是调大这个数，而是查根因。
