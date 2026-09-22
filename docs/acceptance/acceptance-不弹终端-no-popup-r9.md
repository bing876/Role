# 验收报告：不再弹终端

- **轮次**：`no-popup-r9`
- **日期**：2026-09-20
- **对应你的诉求**：「执行修复不要一直弹终端」
- **一句话**：弹窗有**两个来源**，都修了 —— ① 脚本里的 `start ""`；② **我上一轮加的应用内拉起用了 `detached: true`**。

---

## 一、先实测：到底哪种启动方式会弹窗

判据一开始就踩了坑，先记下来：

> ❌ **「数 conhost.exe」是错的判据**。本机是 **Windows 11，默认终端是 Windows Terminal** ——
> 控制台窗口由 `WindowsTerminal.exe` 承载，不是 `conhost.exe`；而且 `conhost.exe … 0x4`
> 在**无窗口**的伪控制台场景也会出现、旧窗口还会残留。第一版据此得出"四种方式全弹窗"的**错误结论**。
>
> ✅ 正确判据：**看有没有一个可见窗口，标题里含 `postgres.exe`**
> （控制台窗口标题默认就是被启动程序的完整路径）。

用正确判据实测（`scripts/verify/pg-launch-window-test.cjs`）：

| 启动方式 | 窗口增量 | PG 可用 |
| --- | --- | --- |
| ① `cmd: start "" "postgres.exe" -D data` | ❌ 有窗口 | 是 |
| ② `cmd: start "" /B "postgres.exe" -D data` | **0** ✅ | 是 |
| ③ node `spawn(…, {detached:true, windowsHide:true})` ← **应用当时用的** | **+1** ❌ | 是 |
| ④ node `spawn(…, {windowsHide:true})` 不要 detached | **0** ✅ | 是 |
| ⑤ `pg_ctl start -D data -l pg.log` | **0** ✅ | 是 |

**结论**：`start ""` 要加 `/B`；Node 侧**不能带 `detached`**。

**为什么 `detached` 会弹窗**：`postgres.exe` 是控制台程序。`windowsHide` 传的是
`CREATE_NO_WINDOW`，而 `detached: true` 在 Windows 上会带 `DETACHED_PROCESS` —— 两者冲突，
Windows 索性**给 PG 新建一个控制台**（Win11 由 Windows Terminal 承载）→ 屏幕上多一个黑窗。

## 二、改了什么

| 位置 | 改动 |
| --- | --- |
| `apps/desktop/electron/server-supervisor.ts` | **去掉 `detached: true`**（保留 `windowsHide: true`）。注释写清为什么不能再加回来。「PG 活过应用退出」不靠 detached —— Windows 不会因父进程退出杀子进程，加 `unref()` 就够；而且我们**从不主动杀 PG** |
| **12 个脚本**里的 `start ""` → `start "" /B` | `pg2/{start-pg.cmd, watchdog.cmd, _launch_watchdog.cmd, _boot.cmd}` + 生成它们的 8 个 Python（`pg-boot/pg-ensure/pg-start/run-pause-resume/p1-fix-regression/p1-revert-proof/p12-pepper-migrate/p2-revert-proof/sms-code-race-probe`） |
| `.workbuddy-ai/swap-dist.mjs` | STAMP → `no-popup-r9`；新增 2 条自检（**断言前先剥注释** —— 注释里为了讲清原因写了 `detached: true` 这串字面量，不剥会假红） |

> ⚠️ 刻意**不动** `pg-launch-window-test.cjs` 里的 `start ""` —— 那是**被测对象①（现状）**，改了就没法复现"弹窗"那一档。

## 三、验收

### ① 真机端到端（`scripts/verify/no-popup-e2e.cjs`）**7 / 7**

```
[+6.0s]  起点：可见 PG 窗口 = 0 个
[+11.7s] ✓ ② PG 被应用拉起来了
[+11.7s] ✓ ★★ 拉起 PG 时**没有**弹出任何终端窗口  [0 个]
[+16.3s] ✓ ③a PG 确实被杀掉了
[+22.0s] ✓ ③b 心跳把 PG 拉回来了
[+22.0s] ✓ ★★ 心跳拉起 PG 时也**没有**弹窗  [0 个]
[+53.8s] ✓ ④ /health 的 db = up（后端真的可用）

窗口数轨迹：起点 0 → 应用拉起后 0 → 心跳拉起后 0
```

第 ④ 条很重要：**证明不是"靠不启动来不弹窗"** —— 后端是真的可用。

### ② 安装包读回字节核对 **20 / 20**，`app.asar` 5508910 B，sha256 `7694a0c2…`
### ③ 换装自检全绿（含本轮新增 2 条）
### ④ 残留清理
上一轮那个测试套件留下的 **4 个 `electron.exe` 测试实例已清掉**（实测现在 0 个）。

## 四、回滚

`_rollback-backup-20260918/app.asar.old-no-popup-r9`

## 五、★ 仍然存在、需要你决定的事

1. **`pg2/watchdog.cmd` 现在是多余的**：工作台已经自己管 PG（含 10 秒保活心跳），
   watchdog 是"第二个 actor"。两个都活着时理论上会抢（一个刚清 pid、另一个刚起）。
   **建议**：从 `start-dev.cmd` 里去掉启动 watchdog 那一步。**要不要做？**
2. **`run-pause-resume.py` 仍然会 `taskkill /F /IM postgres.exe`（无差别杀光所有 PG）**。
   这次只改了它的启动方式（不弹窗），**没动它的杀库逻辑** —— 因为它属于"测试怎么设计"，
   不是弹窗问题。但这是"工作台被搞坏"的根源。**要不要改成"只复用、不杀"？**
3. **验收测试不要在工作台使用期间跑** —— 它会抢 8787、反复起 Electron。

## 六、复跑

```bash
node scripts/verify/pg-launch-window-test.cjs   # 各启动方式的弹窗实测（约 2 分钟）
node scripts/verify/no-popup-e2e.cjs            # 真机：拉起 PG 不弹窗（约 1 分钟）
node scripts/verify/fix-pg-launchers.cjs --check # 复查有没有漏网的 start ""
```
