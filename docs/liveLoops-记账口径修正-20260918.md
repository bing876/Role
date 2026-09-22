# `liveLoops` 记账口径修正（2026-09-18）

> 出处：《浏览器多实例融合报告》§5.8「留给后续阶段」第 4 条。
> 前端 UI 工作暂停后做的第一个底层功能。

---

## 一、问题

`/health` 里的 `liveLoops` 原义是「现在有几路循环在跑」，实现却是：

```ts
for (const s of loops.values()) if (s.status === 'running') n += 1;
```

只数**状态**是 `running` 的循环。

但循环**只在 `advance()` 被调用时才离开 `running`**。于是「建了循环但没人驱动」的那几路 ——
桌面起了循环之后崩了、用户切走了、兜底路径没接上 —— 会以 `running` **一直挂到 10 分钟 TTL 到期**。

它们的实际代价很小（不烧模型、不吃 CPU），但**指标是歪的**：
拿它当「现在有几路在跑」去做限流或排错，会得出错误结论。

## 二、改法

`LoopSession` 上本来就有 `touchedAt`，而且**只在 `advanceInner()`（真走了一步）与 stop / 创建时更新** ——
正好就是「最近一次有推进」的时间，不用加新字段。

```ts
export function liveLoopCount(): number {
  sweep();
  const now = Date.now();
  let n = 0;
  for (const s of loops.values()) {
    if (s.status === 'running' && now - s.touchedAt <= ACTIVE_WINDOW_MS) n += 1;
  }
  return n;
}
```

配套加了三样：

| 项 | 说明 |
| --- | --- |
| `runningLoopCount()` | **旧口径**留着：状态还是 `running` 的循环数（不管有没有推进） |
| `/health.runningLoops` | 同上，暴露出来 |
| `/health.liveLoopsWindowMs` | 把判据窗口一起报出来 —— 指标自带口径，免得看的人猜 |
| `/agent/loop/live` | 现在回 `{ live, running }` 两个值 |

**为什么旧口径要留着而不是直接替掉**：`running=3 但 live=0` 这个**差值本身就是排错信号**
—— 一眼就能看出有 3 路循环虚挂着。两个值一起看才有意义。

**窗口默认 60 秒（配置项 `AGENT_LOOP_ACTIVE_WINDOW_MS`，夹在 5s~600s）**。
给这么宽是因为一步的正常耗时 = 一次模型调用 + 一次工具执行，而工具可能是「导航并等页面加载」，
慢的时候几十秒很正常；给窄了会把**正在干活**的循环误判成不活跃。
所以它只是把「10 分钟的虚挂」压回分钟级，**不是精确心跳**，别拿它做硬限流判据。

改到的文件：`apps/server/src/toolLoop.ts`、`apps/server/src/index.ts`、`apps/server/src/routes/loop.ts`。

## 三、验证（真机 13/13 通过）

脚本：`scripts/verify/liveLoops-window-test.py`（自带端口 8811/8911，不碰开发用的 8787/5173）

把窗口配成 5 秒（允许的最小值）好让验证不用等 60 秒，然后**建一个循环但不驱动它**：

```
PASS  刚建好时：两种口径都算它活着 :: liveLoops=1 runningLoops=1
       —— 现在**不驱动**它，等判据窗口（5000 ms）过去 ——
PASS  ★ 挂着不驱动的循环不再算「活着」（liveLoops 归零） :: liveLoops=0（5115 ms 后归零）
PASS  ★ 但旧口径仍记着它是 running（runningLoops=1，两个值的差就是排错信号） :: runningLoops=1
PASS  ★ 归零发生在窗口附近而不是 10 分钟 TTL 后 :: 实测 5115 ms（窗口 5000 ms）
       推进一步：HTTP 200 {"decision": {"kind": "tool", ... "name": "read_page"}}
PASS  ★ 真推进一步后重新算「活着」（没把真在跑的误杀） :: liveLoops=1 runningLoops=1
PASS  ★ 停掉之后两种口径都归零 :: liveLoops=0 runningLoops=0

结果：13 / 13 通过
```

第二条断言就是修复生效的证明：**旧代码在那一刻会回 `liveLoops=1`**。

## 四、踩到的坑

**端口别写死**：脚本原本用 8901，结果本机 8901 被第三方托盘进程 `douyin_tray.exe` 占着，
一撞就是 `EADDRINUSE`，而假模型的日志只说"地址已在使用"，看起来像"假模型起不来"。
已改成 8811/8911，并在脚本开头加了端口自检 —— 被占就直接报端口、不再往下猜。

## 五、对既有验收脚本的影响

`2b-desktop-tests.py` 与 `4-resource-guard-tests.py` 里有 `liveLoops >= 1`（任务在跑）与
`liveLoops == 0`（收尾了）两种断言，在新口径下**都仍然成立**：

- 在跑的循环每隔几秒就会 `advance()` 一次，`touchedAt` 远新于 60 秒窗口 → 仍算活着；
- 收尾后循环进 `done` / `stopped`，本来就不在 `running` 里 → 归零。

本次没有重跑那两个脚本（它们要拉起完整桌面端，而桌面端 UI 已按指令回滚，
跑挂了分不清是脚本问题还是回滚导致），改的是服务端纯逻辑，风险面只在这一个函数。
