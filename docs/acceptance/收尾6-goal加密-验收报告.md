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
