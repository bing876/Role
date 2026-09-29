# 批次 K 验收报告 —— Routines 主动跟进掉线的活(超期未回交接 / 长期未恢复挂起)

**日期**:2026-09-25(北京时间)
**分支**:`arena/01a0d0a8-role`
**范围**:后端(服务端的 Routines 定时扫 + 两张表的幂等列)。**不建任何 UI**——提醒以 assistant 消息写进归属智能体的主会话(对话流),前端零改动,与 Routines/collabChat 的既有口径一致。
**验收结果**:`scripts/verify/followup-sweep.mts` **12 PASS / 0 FAIL**(真 PGlite 库 + 生产代码本身);反证 `followup-sweep-revert-proof.py` **K1/K2/K3 三个缺陷全部被咬住**,还原后复跑 exit=0。

---

## 0. 先说清这批是什么(和已有机制的边界)

用户原话:「Routines 扫 handoffs/ 超期未回的交接 + task_pauses 长期未恢复的挂起,主动写对话流提醒」。

两个容易混的东西,先划清:

| 机制 | 是什么 | 之前有没有 |
|---|---|---|
| 委派超时**熔断**(delegation.ts) | 到 `deadline_at` 把委派置 `timeout`、写超时消息 | **有**(10 分钟,内存 `setTimeout`) |
| 本批的**主动跟进** | 把"其实已经掉线、但没有任何声音"的活**主动**喊出来 | **没有** |

为什么熔断有了还需要跟进?——**服务端重启**:熔断靠内存里的定时器,进程一死定时器就没了。委派到点后既没有回音、也没有超时消息,状态永远停在 `running`,用户以为对方还在干,其实卡死了。`status='running' AND deadline_at < now()` 正是这批"孤儿"。挂起那边更直接:用户挂起一条任务后忘了,`resumed_at` 永远是 NULL,库里静躺着。

所以本批 = **Routines 每 60 秒的定时扫里,顺手把这两类"没人管了"的活扫出来,该提醒的往对话流写一条催办**。

## 1. 实现

### 1.1 `apps/server/src/orchestrator/followup.ts`(新增,核心)

`sweepDanglingFollowups(pool, cipher, opts?)` → `{ handoffs, pauses }`:

- **委派(超期未回)**:`agent_delegations WHERE status='running' AND deadline_at < now`,JOIN agents 取双方名字,往**派单方**(`from_agent_id`)的最新主会话写:
  `【协同·催办】#<id> <派单方>→<接单方> 的委派已超期(<到期时间> 到期)仍未回音:请催一下对方,或自己接手处理。任务:<task 前 60 字>`
- **挂起(长期未恢复)**:`task_pauses WHERE resumed_at IS NULL AND paused_at < now-30min`,往归属智能体(`agent_id`)的最新主会话写:
  `【协同·催办】你有一条任务已挂起 <N> 分钟还没恢复(loop <id>):要继续就恢复它,不要就停掉。目标:<解密后的 goal 前 60 字>`
  —— 目标取自 `goal_enc`,**运行时才解密**(收尾 6 的口径:库里只有密文);解不出就只发催办不带目标,不整条失败。
- **幂等(防刷屏)**:两张表各加一列 `last_followed_at`(`db.ts` 里 `ADD COLUMN IF NOT EXISTS`,老库启动自动补);同一条 **30 分钟内最多提醒一次**。提醒是**持续**的:过了 30 分钟仍然掉线,下一次扫再喊。
- **兜底**:单条失败只 `console.warn` 跳过,不影响其他条,更不影响 Routines 本身的 interval/cron 扫。没有主会话的智能体跳过(不记 `last_followed_at`,等会话出现后仍会提醒)。
- 两个阈值(`PAUSE_STALE_MS_DEFAULT` / `REMIND_EVERY_MS_DEFAULT`,各 30 分钟)是导出常量,验收和将来的调参都从同一处读。

### 1.2 `apps/server/src/orchestrator/routines.ts`(挂钩,3 行)

`startRoutineSweeper` 的 tick 在 `sweepDueRoutines` 之后加一行 `await sweepDanglingFollowups(pool, cipher)`——与 Routines 同频(默认 60 秒),不另起定时器。

### 1.3 口径(与既有机制一致)

- 提醒走 `messages` 表(assistant 角色、`content_enc` AES-256-GCM),和 `triggerRoutine`/`collabChat` 写的消息同一条路,前端零改动就能看到。
- 不新增路由、不新增事件、不碰 `browser/`、不碰前端任何一行。

## 2. 验收(跑生产代码,真 PGlite 库)

`npm run verify:followup`(`npx tsx scripts/verify/followup-sweep.mts`):

| # | 断言 | 结果 |
|---|---|---|
| ① | 只为"超期未回"的委派写了 1 条催办(没超期 / 刚提醒过 / 已解决 timeout 的一条都不写) | ✓ |
| ② | 只为"长期未恢复"的挂起写了 1 条(刚挂 5 分钟 / 已恢复的不写) | ✓ |
| ③ | 催办文本正确:`【协同·催办】#1001 派单方→接单方 … 超期 … 整理店铺周报`;挂起那条含 `挂起 60 分钟` + `loop-p1` + 解密后的目标 | ✓ |
| ④ | **落库是密文**:`messages.content_enc` 里搜不到目标明文(收尾 6 口径不破) | ✓ |
| ⑤ | 被提醒的行 `last_followed_at` 已置 now(幂等的前提) | ✓ |
| ⑥ | **幂等**:同一时刻重复扫 → 0 条新提醒,两个会话条数都不变 | ✓ |
| ⑦ | **主动(持续)**:31 分钟后仍掉线的会**再**提醒;且"世界随时间变化"——原来没超期的 d2 此刻已超期 26 分钟、原来"刚提醒过"的 d3 距上次已 32 分钟,都该被催(handoffs=3、pauses=2,逐条对上) | ✓ |
| ⑧ | 默认阈值 = 30min / 30min(单一来源,常量断言) | ✓ |

**合计 12 PASS / 0 FAIL。**

## 3. 反证(拆一个机制,验收必须红)

`npm run verify:followup:revert`(`python3 scripts/verify/followup-sweep-revert-proof.py`,~12s):

| 变异 | 拆法 | 咬住的位置 |
|---|---|---|
| K1 委派那一半不扫 | `status='running'` → `status='never-such-status'` | 红在"只为超期未回的委派写了 1 条催办(实际 0)" |
| K2 挂起那一半不扫 | `resumed_at IS NULL` → `IS NOT NULL` | 红在"挂起方的主会话恰好 1 条"(实际 0) |
| K3 幂等条件变成恒真 | 幂等条件 → `$2 IS NOT NULL OR last_followed_at IS NOT NULL` | 红在"重复扫不产生任何新提醒(handoffs=2)"——同一时刻扫两遍喊了两遍 |

★ K3 一开始我写的是**删掉**幂等那一行——验收也红了,但红的原因是 `$2` 占位符没了导致**参数个数不匹配、整条 SQL 报错**,不是幂等失效。反证要咬的是机制本身,于是改成恒真条件(占位符还在、语义被拆)才重跑。**这个坑记在这里:反证注入"删 SQL 行"之前,先数 `$n` 占位符。**

三个变异**全部被咬住**,每次注入后源码逐字节还原(md5 比对),还原后复跑 exit=0,最终反证失败项 0。

## 4. 已知边界(如实说)

1. **`need_user` 状态的委派不催**:`status='running' AND deadline_at < now()` 是"掉线孤儿"的准确口径;`need_user` 有它自己的 UI 出口(待确认卡),不混进来。
2. **熔断(10 分钟定时器)和本批是两回事,都留着**:定时器活着时熔断先到、状态变 `timeout`,本批自然扫不到(条件 `status='running'` 不命中);定时器丢了(重启),本批接住。两条路不重复喊。
3. **没有会话的智能体**:跳过且**不**记 `last_followed_at`,等会话出现后第一次扫就会提醒(不丢,也不提前消耗提醒额度)。
4. 提醒文案是后端定的(与 Routines 的 `【协同·例行】` 同一风格);将来前端要不要单独的"催办卡片"样式,归阶段 2。
5. 阈值 30 分钟是拍脑袋的合理值(导出常量,改一处全局生效);要调不用改代码,验收里 `opts` 也支持注入。

## 5. 文件清单

| 文件 | 说明 |
|---|---|
| `apps/server/src/orchestrator/followup.ts` | 新增:跟进扫(委派 + 挂起),幂等,阈值常量 |
| `apps/server/src/orchestrator/routines.ts` | tick 挂钩(3 行) |
| `apps/server/src/db.ts` | `agent_delegations` / `task_pauses` 各加 `last_followed_at`(幂等 ALTER) |
| `scripts/verify/followup-sweep.mts` | 验收(12 断言,真 PGlite + 生产代码) |
| `scripts/verify/followup-sweep-revert-proof.py` | 反证 K1/K2/K3 |
| `package.json` | `verify:followup` 挂进主 verify 链(kill9 与 batches 之间);`verify:followup:revert` 单独(同 verify:logic 口径) |
| `docs/智能体协同-总计划.md` | 序表 批次 K(与 收尾 8)标完成 |

**结论**:批次 K 达成"Routines 扫超期未回交接 + 长期未恢复挂起,主动写对话流提醒(读 `task_pauses.goal_enc`)"的规格;验收+反证齐,已挂进主 verify 链。下一批:**批次 L(只做后端)**。
