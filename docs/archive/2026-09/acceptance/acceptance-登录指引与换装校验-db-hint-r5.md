# 验收：登录失败指引修正 + 换装脚本字节级校验（db-hint-r5）

- **日期**：2026-09-19 23:50 ~ 2026-09-20 00:40
- **触发**：用户截图报「登录不进去工作台」，红字 `数据库连不上：先跑 docker compose …`
- **结论**：根因是 **PostgreSQL 没起**（不是应用 bug、不是上一轮的自愈修复失效）；
  同时修掉了两处**会误导用户 / 会静默装坏包**的实质缺陷。

---

## 一、根因诊断（先给证据，再给结论）

| 检查项 | 实测值 | 判读 |
| --- | --- | --- |
| `8787` 监听 | 有，PID 12760 = `AI 工作台.exe` | 服务端**在跑** |
| `/health` 的 `service` | `"ai-workbench-server"` | ★ **是"我们自己的"服务端** —— 上一轮的自愈修复生效了 |
| `/health` 的 `db` | **`"down"`** | ★ 服务端连不上库 |
| `5432` 监听 | **无** | ★ **PostgreSQL 根本没起** |
| `pg2/data/postmaster.pid` | 有，PID **20308**（进程已不存在） | ★ 陈旧 pid 残留 —— 会阻止 PG 下次启动 |
| 全表扫 `postgres.exe` | 0 个 | 确认 PG 完全没跑 |

**因果链**：

```
PG 没起 → 5432 无监听
   ↓
应用（修复版 supervisor）正确地把服务端拉起来 → 8787 活着、service 标识正确 ✓
   ↓
但服务端连不上库 → /health 报 db:"down"
   ↓
用户点「获取验证码」→ /auth 回 503 → 界面红字「数据库连不上」
```

→ **这次 supervisor 的工作是正常的**，问题纯粹是**数据库没启动**。
   用户看到的红字是**准确的**，但**给出的下一步动作是错的**（见第二节）。

---

## 二、缺陷 1：错误提示指向了本机跑不通的动作

服务端 **8 个 route** 都回同一句 503 文案：

```
数据库连不上：先 npm run db:up（或 docker compose -f apps/server/docker-compose.yml up -d）
```

但本机**没有可用的 Docker**（PG 是便携包，`~/workbuddy-ai/pg2`），
`npm run db:up` 也跑不通 —— **照做只会更困惑**。而真正能用的动作是双击
仓库根的 `start-dev.cmd`（它会清陈旧 pid → 起 PG → **等库真能查** → 起服务端）。

**修法**（`apps/desktop/src/App.tsx`）：在**渲染层**做一次统一替换，而不是改 8 个 route。

- 新增 `dbHint()`：把含「数据库连不上」的 503 文案换成本机指引。
  改一处即可覆盖所有 route，且不会漏掉某个 route。
- `authFetchJson` 的「连不上后端」文案同步改掉（原来写 `npm run db:up` / `npm run dev:server`）。
- **验证码提示**：原来让用户"到跑 dev:server 的终端里抄 `[sms:mock]`"——
  但服务端现在是**应用自己拉起的**，用户根本看不到那个终端。改为指向
  「AI工作台-服务端」窗口（`start-dev.cmd` 会弹出它）。
- **429 限流**：实测撞到 `发送太频繁，请 22 秒后重试`，单独解释成防刷限制，
  避免用户以为是手机号有问题。

---

## 三、缺陷 2（更严重）：换装脚本会把「全零的空壳包」装上去

本轮换装时产出的包 **5470291 字节里只有 3 个非零字节**：

```
前 8 字节：04 00 00 00 | 38 62 00 00     ← 两个长度头（pickle=4, header=25144）
之后全部：00 00 00 ...                    ← header JSON 与内容区全是 0x00
```

**但脚本一路"自检通过"把它装了上去。** 根因：

> 脚本第 6/7 步的功能自检读的是**解包出来的临时目录**
> （`tmp/dist-electron/main.js`），**不是真正要装的那个 asar**。
> 所以产出的包就算是空壳，自检也全绿。

**发现过程**：装完做「读回字节」核对时 `hasWorkbench = false`，
全文件扫描才确认是零字节。**如果只信 sha256 就查不出来**——
哈希算的是那份零字节文件，两边当然"一致"。

### 修法（`.workbuddy-ai/swap-dist.mjs`）三道保险

1. **直接写到安装目录的 `.new`**（少一次 `copyFileSync`，少一个出错点）；
2. **把字节读回来验**：
   - 非零比例 > 50%（零字节空壳立刻被抓）
   - canary 串必须存在（本轮用 `start-dev.cmd`，压缩后必然还在）
   - `listPackage` 条目数 > 100
3. **失败自动重试一次**，仍失败就中止 —— **旧包一根汗毛都不动**。

另外：`fs.renameSync` 在本机沙箱会报 `EBUSY`（栈里是 `node-brokered-fs-shim`），
而**同等的 shell `mv` 是好的**。原来失败时直接抛栈，会**留下一个空的 `app.asar`**
（应用直接起不来）。现在改为打印两条 `mv` 命令，照着敲即可收尾。

---

## 四、验证与反证

| 脚本 | 条数 | 结果 |
| --- | --- | --- |
| `scripts/verify/verify-db-hint.mjs` | 9 | **9/9 通过** |
| `scripts/verify/sim-start-dev.cjs` | 四步全流程 | 通过（清 pid → 起 PG → 等库可查 15s → 起服务端 → `db=up`） |
| `scripts/verify/launch-check.cjs` | 真机启动 | 通过（14s 存活、无 asar 解析失败） |
| `scripts/verify/e2e-final-login.cjs` | 端到端登录 | **HTTP 200 + token** |
| `scripts/verify/_ping-db.cjs` | 库探活 | `QUERY_OK`，13 张表 |

### 反证（证明测试不是摆设）

把文案**注入回旧的**（`先起库（npm run db:up）`）后重跑：
→ **8 通过 / 1 失败、退出码 1**，测试确实变红；还原后回到 9/9。

### ★ 写断言时踩的一个坑（假警报）

第一次跑 `verify-db-hint.mjs` 报「源码仍含 `先跑 docker compose`」——
但那是**我自己写的注释**在描述旧文案，用户根本看不到。
→ 断言必须**先剥注释**再比对（这条已记进 MEMORY.md 第八节）。
现在脚本里额外留了一条"自查断言"，证明上面那条确实是靠剥注释才通过的，不是碰巧。

---

## 五、真机实证（最关键的一段日志）

启动已安装的应用后，服务端输出：

```
[server-supervisor] 8787 不通，自动拉起：electron.exe + ELECTRON_RUN_AS_NODE=1 跑 dist/index.js（构建产物）
[server] [db] 项目层迁移完成：当前项目补 0 行、权限开关补 0 行、知识库归属回填 资料 0 条 / 片段 0 条
[server] [server] 数据库表就绪（users/projects/agents/sms_codes/conversations/messages/tasks/
                              memories/knowledge_documents/knowledge_chunks/user_memories/agent_memories）
[server] [server] http://127.0.0.1:8787 —— GET /health；短信模式：mock（验证码只进本日志）
[server-supervisor] ✅ 服务端已就绪。
```

**这四条同时成立**，说明整条链路是通的：
1. 自愈生效（8787 不通 → 自己拉起服务端）—— 上一轮的修复真的在工作；
2. `migrate` 成功（**「数据库表就绪」**，不是「暂未连通」降级）；
3. 服务端起来了；
4. 应用 14 秒仍存活、**无 asar 解析失败** → 新包是好的。

---

## 六、换装结果

| | 值 |
| --- | --- |
| `sha256(app.asar)` | `1491c2daef1b729bbc4ef71a0b0cb170d41743e02f85225a9c357dea509e2191` |
| 大小 | 5470291 B |
| 功能自检 | **29/29 ✓**（含本轮 5 条新断言） |
| **读回字节核对** | **非零比例 100.0%**；6 个 must-have 全在、老文案已消失 |
| 旧包归档 | `_rollback-backup-20260918/app.asar.old-db-hint-r5` |
| 备份 | `resources/app.asar.bak-db-hint-r5-pre` |
| 缓存 | `Cache` / `Code Cache` / `GPUCache` 已让位（**Local Storage 登录态未动**） |

---

## 七、遗留 / 需要用户判断的主观项

### 自动化测不出的
1. **双击 `start-dev.cmd` 那个黑窗口**：等 30 多秒（等库真能查）读起来像不像卡死。
2. **登录进去之后的观感**：本轮只证明"库通了、接口 200、指引文案对了"，
   界面顺不顺手要用户自己看。
3. **新的错误文案读起来是否清楚** —— 现在写的是
   「双击仓库根目录的 start-dev.cmd（它会起库 + 服务端并等到真正可用），再点一次」。

### 尚未处理（属计划外改动，按规矩先问再做）
- **应用能自愈服务端，但不能自愈数据库**。DB 必须先由用户启动。
  若希望「打开应用就把库也带起来」，需要给 supervisor 加一段拉起 PG 的逻辑 ——
  这是**超出本轮简报的改动**，等用户确认后再做。
- 服务端 8 个 route 里那句 `docker compose` 文案**没改**（渲染层统一替换掉了）。
  若有别的客户端（非本渲染层）直连服务端，仍会看到那句。要不要一并改，待定。
