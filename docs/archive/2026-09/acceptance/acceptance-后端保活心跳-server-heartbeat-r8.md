# 验收报告：后端保活心跳

- **轮次**：`server-heartbeat-r8`
- **日期**：2026-09-20
- **对应你截图**：黄条「网页已经打开在中栏浏览器工作区里；**连不上后端：Failed to fetch**」
- **一句话**：你**已经成功进工作台了**（XYZ69376 / 186\*\*\*\*4441）——修复生效了。
  那条黄条是真的：**后端服务进程死了，而应用只在启动时拉它一次，之后不管**。

---

## 一、现场实测（你截图后立刻量）

| 项 | 实测 |
| --- | --- |
| 5432 数据库 | **在跑**（PID 34528） |
| **8787 后端** | **没在监听**（只剩一个 `TIME_WAIT` 残socket） |
| 应用 | 在跑（4 个进程） |

所以「Failed to fetch」不是误报 —— 后端确实没了。**PG 有看门狗保活，服务端没有**，这是我漏掉的一环。

## 二、根因

`ensureServer` 只在 `app.whenReady()` 里跑**一次**。更要命的是第二种情况：

1. 应用启动那一刻，8787 上碰巧有**别人**的服务端（上一次进程留下的）；
2. 按设计约定，应用「已有服务端在跑，直接用（**不接管**）」→ **不持有它的句柄**；
3. 那个进程随后随它的宿主一起死掉；
4. 应用**毫不知情**，也**永远不会重拉**。

→ 结果就是你看到的：人已经在工作台里，一发消息就失败，而且**自己好不了**。

## 三、改法

| 文件 | 改了什么 |
| --- | --- |
| `apps/desktop/electron/main.ts` | 加 **10 秒一次**的保活心跳：`ensurePostgres(quiet)` + `ensureServer`，掉了就重新拉起（这次是自己 spawn 的、一直管着）；`before-quit` 清掉定时器 |
| `apps/desktop/electron/server-supervisor.ts` | `ensurePostgres(log, opts?: { quiet?: boolean })` —— 保活时不打「已有 PostgreSQL 在跑」那句（否则每 10 秒刷一行，把有用日志淹掉）。签名向后兼容 |

**为什么短路是安全的**：`ensureServer` 只在「**自己 spawn 的** child 还活着且刚就绪过」时才跳过探测；
child 一退出就把句柄置空 → 下一轮心跳必然重新探测并拉起。外部服务端则**每次都真探**。

## 四、验收（`scripts/verify/server-heartbeat-e2e.cjs`，**5 / 5**）

真机：启动已安装应用（临时 `--user-data-dir`，**不碰你的登录态**）→ 杀掉监听 8787 的进程 → **不重启应用**等它自愈。

```
+3.1s   [server-supervisor] 8787 不通，自动拉起：…跑 dist/index.js
+5.7s   ✓ ① 应用启动后 /health 通（service + db 都正常）
+6.5s   杀掉监听 8787 的 PID 29188
+10.1s  ✓ ② 服务端确实被杀掉了（8787 不再监听）
+12.8s  [server-supervisor] 8787 不通，自动拉起
+14.3s  [server-supervisor] ✅ 服务端已就绪
+14.4s  ✓ ③ ★ 不重启应用，后端自己恢复了  [用了 4.3s]
+14.4s  ✓ ④ 日志里有重新拉起的痕迹
+16.2s  ✓ ⑤ 恢复后登录 200 + token  [200 user.id=67]
```

另外：
- 换装自检 **44 条全绿**（含本轮新增 4 条）
- 读回安装包字节核对 **18 / 18**，`app.asar` 5508085 B，sha256 `83995b8c…`
- 回归：`pg-supervisor-tests.cjs` **40 / 40** 仍全绿

## 五、回滚

本轮换装前的包：`_rollback-backup-20260918/app.asar.old-server-heartbeat-r8`

## 六、★ 本轮踩到的两个坑

1. **自检正则写成 `ensureServer(` 恒不匹配** —— tsc 产物里调用点是
   `(0, server_supervisor_1.ensureServer)(undefined, ...)`（**多个右括号**）。
   断言编译产物里的调用，**只锚函数名，别带 `(`**。（换装因此安全中止一次，旧包未动 —— 这是预期行为。）
2. **本机有外部进程会改工作区文件** —— 不只构建产物：`apps/server/src/env.ts`、`dist/env.js`，
   **连 `.workbuddy-ai/memory/MEMORY.md` 都被改回过旧版**（我写的那版 13 章节，被换成 10 章节的旧版）。
   已把本轮教训重新补进尾部。→ 改完关键文件**必须 `grep` 复查**，别信工具返回。

## 七、★ 仍然存在的边界（如实列出）

- **保活是"应用活着时"的**：应用自己关掉，服务端会跟着收尾（这是设计），
  下次开应用会重新拉起。
- **PG 现在也在心跳里**（10 秒探一次，掉了会重拉），但它仍然是 `detached`、
  退出不杀 —— 这是刻意的（本机共享服务）。
- **验证码显示仍只在"服务端是应用自己拉起"时生效**：如果是你手动起的服务端，
  它有一个可见的控制台窗口，码在窗口里。两种情形都拿得到码。

## 八、复跑

```bash
node scripts/verify/server-heartbeat-e2e.cjs    # 保活心跳（约 20 秒）
node scripts/verify/verify-installed-asar.cjs   # 读回安装包字节
node scripts/verify/pg-supervisor-tests.cjs     # 数据库守护单测 40 条
```
