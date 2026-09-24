# 收尾 9 · 修 3 真 `kill -9` 验收报告

> 用户 2026-09-25 拍板的收尾顺序第 ② 项：**真 `kill -9`（工具执行后、结果落库前杀进程，确认不二次执行）**。
> 总计划里的原话：「修 3 的真 `kill -9` 测试：工具执行后、结果落库前 kill -9，重启确认工具没被执行第二次。
> 照收尾 2 的双进程做法（`board-lock-db.mjs` + `board-lock-worker.mts`），**不要用逻辑模拟代替**」。

---

## 1. 先说结果里的意外：**验收当场抓到了修 3 的一个真缺陷**（已修，2 行）

跑验收的第一版（还没加列纯净度断言时）输出里有一行：

```
PASS  kill 落在"工具已执行、结果未落库"的窗口里（executed_tool_ids=["open_url"]）
```

`executed_tool_ids` 列里存的是 **`"open_url"`（工具名）**，不是 call id。追到根因：

- `saveCheckpoint` 里 `const executedIds = session.executedToolIds ?? session.usedTools ?? []` ——
  **`?? usedTools` 这个兜底是错的**：`usedTools` 里是工具**名**，这一列要存的是 tool_call **id**；
- 而 `startLoop` 建会话时**没有初始化** `executedToolIds`（undefined）→ 第一次「下发前落库」
  就走了兜底，把 `['open_url']` 写进了 call id 列；
- 后果：重启后 `checkpointToSession` 把这一列读回内存，去重比对
  `executedToolIds.includes(callId)` 变成 **id 对名字** —— **永远比不中**，
  跨重启去重形同虚设（同一进程内存里是对的，一 kill -9 重启就废）。

**修法（2 行，双保险）**：
1. `toolLoop.ts` `startLoop`：初始化 `executedToolIds: []`（未执行过 = 空数组，语义干净）；
2. `checkpoint.ts` `saveCheckpoint`：删掉 `?? usedTools` 兜底，改成
   `Array.isArray(...) ? ... : []`（未初始化当"还没执行过"，**绝不**拿工具名充数）。

验收随之加了两条**列纯净度**断言（窗口期 + 恢复后）：列里存的全必须是 `call_…` 开头的 id、
不许出现工具名。反证 M3 把这 2 行一起打回去 → 当场红（见 §4）。

## 2. 测试怎么搭的（照收尾 2 的双进程做法，真进程、真 kill -9）

```
驱动 loop-kill9-db.mjs
 ├── 进程 A  loop-kill9-worker.mts <run>     （node --import tsx 单进程起，板锁同一条坑的教训）
 │     跑生产代码：startLoop / advance / ingestToolResult / saveCheckpoint
 │     + 真 PGlite 文件库（跨进程重启持久化）+ llm.ts 的 mock 模型（ENABLE_DEV_MOCK_LLM=1，
 │       生产里真有的那条路径；工具序列确定：open_url → read_page → stop）
 │     ① advance 拿到第一个工具调用 open_url
 │     ② **模拟桌面执行**（executed.log 记 `callId\t工具\turl` —— 可计数的"执行"副作用）
 │     ③ 等"下发前落库"真的写完（那次 save 是 fire-and-forget，等 pending_call_id 对上才放行）
 │     ④ 写 marker.json（= "工具已执行、结果还没喂回服务端"）
 │     ⑤ 睡 5 秒（**kill 窗口**）
 ├── 驱动等到 marker → **对 A 发真 SIGKILL（kill -9）**
 │     · 验 signal === 'SIGKILL'
 │     · 验"真死了"：杀后 400ms executed.log 不许再长（防"杀的是 tsx 包装壳"—— board-lock 的同一条硬校验）
 ├── 驱动**直接打开那个库**（此刻没有进程持有它）确认 kill 落在
 │     「工具已执行、结果未落库」的窗口：行 status=running、pending_call_id = 那个 callId、
 │     executed_tool_ids 里没有它、且**列里全是 call id**
 └── 进程 A'  loop-kill9-worker.mts <resume>（同一库，重启）
       restoreLoops 恢复循环 → 把桌面手里那份结果喂回 advance
       → 验历史一致性（回执 tool_call_id 必须 = 原来的 callId，不许 `call_<step>` 孤儿）
       → 继续走完 read_page → stop(done)
```

**端到端判据（"没被执行第二次"）**：`executed.log` 里 **open_url 恰好一行**、
总共恰好两行（open_url + read_page）、**没有任何 callId 出现两次**。

为什么必须是真 kill -9：修 3 保护的是**进程被硬杀、内存全丢、只剩库里那一行**之后的状态。
`restart-recovery.mjs` 那种 in-process 逻辑模拟测不到这件事（总计划第 144 行记的缺口就是它）。

## 3. 验收输出（逐字，17 PASS / 0 FAIL）

```
=== 收尾 9 · 修 3 真 kill -9：工具执行后、结果落库前杀进程，重启不许执行第二次 ===
PASS  进程 A 发出第一个工具调用并执行了（marker 出现）
PASS  工具（open_url https://example.com）确实被执行过（executed.log 有记账）
PASS  进程 A 被真 SIGKILL 杀死（signal=SIGKILL，退出码=-）
PASS  杀后 400ms 没有任何新写入（进程真的死了，不是杀了个壳）
PASS  kill 后库里还有这个循环（status=running）—— 不是"循环丢了"
PASS  kill 时 pending_call_id 已落库 = call_…（"下发前先落库"生效）
PASS  kill 落在"工具已执行、**结果未落库**"的窗口里（executed_tool_ids=[]）
PASS  executed_tool_ids 列里存的全是 **call id**（实际=[]；混进工具名 = 修 3 的列被污染，重启后去重比不中）
--- 重启新进程，把桌面手里那份结果喂回去 ---
[checkpoint] 重启恢复：从库中恢复 1 个循环（已解密）
RESUME-EXECUTED ["call_…"]
RESUME-OK restored=1 first=open_url next=read_page final=done
PASS  重启后的进程 A' 正常走完剩余步（退出码=0）
PASS  A' 没有报恢复失败（无异常）
PASS  重启进程报告恢复成功并走到 done（RESUME-OK）
PASS  重启后喂回结果，executedToolIds 里记上了原来的 call id
PASS  executedToolIds 里没有工具名混进来
executed.log（共 2 行）：
  call_…_1  open_url  https://example.com
  call_…_2  read_page
PASS  整个崩溃前后，工具一共只被执行了 2 次（open_url + read_page），实际 2 次
PASS  open_url 恰好执行了 1 次（没有"重启后又打开一遍网页"），实际 1 次
PASS  没有任何 callId 被执行过两次
PASS  第一次执行的就是 kill 前那次 open_url
=== 结论：通过 ===
```

## 4. 反证（`verify:loop:kill9:revert`，3 个机制各拆一个，逐字输出）

```
--- M1 下发前不再落库 pending_call_id（kill 后"还欠一个回执"这件事丢了）
  注入后：退出码=1
    FAIL  kill 时 pending_call_id 已落库 = call_…（"下发前先落库"生效；实际=（空））
    FAIL  重启后的进程 A' 正常走完剩余步（退出码=4）
    FAIL  A' 没有报恢复失败（RESUME-FAIL receipt-mismatch 期望=call_… 实际=call_0）
  ✓ 变红，且命中「pending_call_id 已落库」

--- M2 恢复时不读回 pendingCallId（喂回结果落成孤儿回执，tool_call_id 对不上）
  注入后：退出码=1
    FAIL  A' 没有报恢复失败（RESUME-FAIL receipt-mismatch 期望=call_… 实际=call_0）
    FAIL  重启后喂回结果，executedToolIds 里记上了原来的 call id（实际=[]）
  ✓ 变红，且命中「receipt-mismatch」

--- M3 executed_tool_ids 列重新被工具名污染（两处一起打回去 → 重启后去重比不中）
  注入后：退出码=1
    FAIL  executed_tool_ids 列里存的全是 **call id**（实际=["open_url"]；…）
    FAIL  executedToolIds 里没有工具名混进来（实际=["open_url","call_…"]）
  ✓ 变红，且命中「call id」

=== 结论 ===
  注入 3 个缺陷，被验收抓到 3 个
  反证失败项：0
  还原后：退出码=0（应 0）
```

**M3 为什么两处一起拆**：§1 的修复本身是双保险（startLoop 初始化 + saveCheckpoint 不再兜底，
任一处单独都在，列都是干净的）—— 只拆一处测不出缺陷。这不是验收写得松，是修复的防御深度
本来就是两层；反证必须把这一层整体打回去才打得红（脚本注释里写明了）。

## 5. 挂链

```
verify:loop:kill9        = node scripts/verify/loop-kill9-db.mjs                ← 进全量 verify 链
verify:loop:kill9:revert = python3 scripts/verify/loop-kill9-revert-proof.py    ← 单独跑（起真进程+杀，慢）
verify                   = … && verify:handoff && verify:loop:kill9 && verify:batches && …
```

（反证不进自动链，与 `verify:logic` / 反证单独跑的口径一致；`verify:handoff` 的反证快（~12s）才进了链。）

## 6. 如实说明的两点

- **worker 模拟了"桌面执行"这一步**：生产里工具在 Electron 主进程执行，服务端拿不到执行结果；
  本测试验的是"**服务端这一侧**崩溃重启后不得让同一工具再被执行一次"，所以由 worker 按 callId
  记账。这是边界，不是缩水 —— 判据（open_url 恰好一行）是端到端的。
- **kill 窗口的稳定化等待**：worker 在写 marker 前会等 `pending_call_id` 真落到库里
  （生产那次 save 是 fire-and-forget）。正常流程等得到；M1 反证打回去时等不到就放行，
  让验收在「pending 没落库」上红 —— **不放行 = 假绿**，这里宁可慢 10 秒。
