# 验收报告 · 数据库接通 + 全链路 E2E + 启动脚本

日期：2026-09-19
分支：`arena/01a09b16-work123`
范围：`apps/server`（数据库接通）、`scripts/verify`（验收脚本）、仓库根 `start-dev.cmd`（本地开发启动）

---

## 一、本轮真正解决的问题

用户报的现象是：**打开本地应用、输入手机号、点获取验证码 → 红字「数据库连不上」。**

排查结论：**应用没坏，是它后面依赖的 PostgreSQL 没起来 / 起来了但还没准备好。**
两段原因，第一段是本轮新发现的：

| # | 机制 | 证据 |
| --- | --- | --- |
| 1 | **PostgreSQL 根本没在跑**，5432 无监听 → `/health` 报 `db:"down"` → `/auth/*` 一律 503 | `netstat` 无 5432；`/health` 的 `db` 字段为 `down` |
| 2 | **★ 端口通 ≠ 数据库可用（本轮核心发现）**。PG 上次被强杀后，下次启动先做**全库 fsync + WAL 回放**，期间**端口已经监听但任何查询都报 `the database system is starting up`** | 实测空窗 **32.4 秒**（见「三」） |

第 2 条的杀伤力在于：服务端的 `migrate()` **只在启动时跑一次**，撞上这个空窗就会失败，
然后**静默降级**——服务照常起、`/health` 也回 200，但 `/auth` 一律 503：

```
[server] 数据库暂未连通，服务照常起（/auth 会回 503 提示）： the database system is starting up
```

用户在这个窗口里点登录，看到的就是红字。

---

## 二、本机 PostgreSQL 的现实约束

| 约束 | 说明 |
| --- | --- |
| 没有原生 PG | 全机无 `psql` / `createdb`，`wsl.exe` 被本机安全策略拉黑，Docker Linux 引擎起不来 |
| 唯一可行路径 | 便携二进制包解到 `C:\Users\bing\workbuddy-ai\pg2`，`pg\bin` 里**只有** `initdb` / `pg_ctl` / `postgres`，**没有 psql/createdb** |
| **agent 无法代用户常驻进程** | 工具调用结束会回收全部派生进程（`cmd start` / `detached` / `Popen` 均无效）。PG 与 Node 服务端**只能由用户自己启动** |

→ 因此产出 `start-dev.cmd`，把「起库 + 等就绪 + 起服务端 + 校验」封成双击即用。

---

## 三、修复内容

### 3.1 `start-dev.cmd`（仓库根，新增）

四步：`[1/4] 清陈旧 pid` → `[2/4] 起 PG` → `[3/4] 起服务端` → `[4/4] 校验 db=up`。

关键修复点（都对应一个实测过的坑）：

| 修复 | 原来的做法（会坏） | 现在 |
| --- | --- | --- |
| **★ 等数据库真可用，而不是等端口** | `netstat` 看到 5432 就放行 | 新增 `:WAIT_DB` 子过程，用 `ping-db.mjs` 轮询 **`SELECT 1` 成功**才继续（上限 240s） |
| 清陈旧 `postmaster.pid` | 直接启动 → PG **静默拒绝启动** | 先读 pid 首位，用 `tasklist /FI "PID eq <n>"` 判活；死的删文件、活的 `pg_ctl stop -m fast` |
| 判断"是否已在运行" | `netstat` | `pg_ctl status`（能识别"在跑但没监听"的中间态） |
| 停库方式 | `-m immediate`（= 强杀，**制造**下一轮长恢复） | `-m fast`（正常停，下一轮秒起） |
| 括号块内 `goto` 标签 | 同 cmd 上不可靠 | 改 `call :WAIT_PORT` / `:WAIT_DB` / `:WAIT_HEALTH` 子过程写法 |
| 服务端启动 | 无校验 | 新增 `:WAIT_HEALTH`，轮询 `/health` 直到 `"db":"up"` 才打印「启动完成」 |

编码：**GBK + CRLF**（`chcp 936`），181 行 / 5614 字节。

### 3.2 `ping-db.mjs`（`pg2\ping-db.mjs`，新增）

`start-dev.cmd` 的 `:WAIT_DB` 依赖它。逻辑：先探端口（省掉 pg 客户端的长栈），
再用 `pg.Client` 跑 `SELECT 1`。退出码 `0` = 真可用，`1` = 还没好，`2` = 端口没开。
连接串与服务端 `.env` 一致：`postgresql://workbench:workbench@localhost:5432/workbench`。

### 3.3 `scripts/verify/boot-selfcheck.py`（新增）

把 `start-dev.cmd` 的全部逻辑在 Python 里复刻一遍，一次调用内跑完并断言。
用途：**自检脚本本身，不能用于常驻**（工具调用会回收进程）。

---

## 四、验证结果

### 4.1 完整启动链（新行为）

```
[2]  5432 端口监听        @   1.7s
[2b] 数据库可接受查询      @  34.5s   <-- WAIT_DB 在这里等，卡住空窗
[4]  /health db = up      @  38.2s
[log] 含「数据库表就绪」   = True      <-- migrate 成功
[log] 含「暂未连通」       = False     <-- 不再降级
```

服务端日志：

```
[db] 项目层迁移完成：当前项目补 0 行、权限开关补 0 行、知识库归属回填 资料 0 条 / 片段 0 条
[server] 数据库表就绪（users/projects/agents/sms_codes/conversations/messages/tasks/memories/
        knowledge_documents/knowledge_chunks/user_memories/agent_memories）
[server] http://127.0.0.1:8787 —— GET /health；短信模式：mock（验证码只进本日志）；
        模型：已配置（deepseek-chat @ https://api.deepseek.com）
```

**13 张表全部建好。**

### 4.2 ★ 反证：证明 `WAIT_DB` 不是摆设

脚本 `scripts/verify/revert-boot-tests.py` —— **同一台机器、同一天、同一份 PG 数据目录**，
只把「等数据库真可查询」这一步换成旧行为（只看端口就放行），其余完全不动：

| | 场景 A · 旧行为（只看端口） | 场景 B · 新行为（等真可查询） |
| --- | --- | --- |
| 5432 监听 | 1.7s | 1.7s |
| 数据库真可用 | — **直接放行** | 34.7s ← 卡住空窗 |
| `migrate()` | **失败** | 成功 |
| 服务端日志 | **「暂未连通」= 降级** | 「数据库表就绪」 |
| `/health` | 一开始 `down` | `up` |
| **用户点登录** | **红字「数据库连不上」** | 正常 |

```
★ PASS：同一台机器、同一天，旧行为必然降级（登录失败），新行为正常。
   => WAIT_DB 这一步是有效的，不是摆设。
```

独立复跑两次结论一致。存档：`docs/acceptance/root-cause/revert-boot.log`。
**这是用户截图现象的确定性复现。**

---

## 五、E2E 验收脚本的假 PASS 修复

`scripts/verify/run-task-e2e.py`（"任务真的跑到 AI 干完"的端到端脚本）本轮修掉 5 处**假 PASS**：

| # | 原来的假 PASS | 修复 |
| --- | --- | --- |
| 1 | 端口通就开始跑，撞上 PG 恢复窗口 → 全程带病 | 新增第 1.5 步：用 node pg 客户端轮询 `SELECT 1`，**返回 READY 才继续** |
| 2 | 从不检查 migrate 有没有成功 | 断言服务端日志里必须出现**「数据库表就绪」** |
| 3 | 只看 `/health`，不看表是否真建好 | 直连核表数 `TABLES=13`，少于 5 判失败 |
| 4 | 有 token 就跳过登录（**残留登录态**导致无智能体绑定） | 新增 `main_ui_ready()`；每轮**清空 `_e2e-profile`**，保证从登录页开始 |
| 5 | **只看界面文案就判"已发送"** | 改用**服务端计数**：`llmCalls` 零增长 = 失败，不允许记成已发送 |

### 输入注入的 A/B 实测（`scripts/verify/send-ab-probe.py`）

| 方式 | 能否进 React state | 结果 |
| --- | --- | --- |
| **A. native value setter + `dispatchEvent(new Event('input'))`** | ✅ `props.value` 正确 | **送达**（`llmCalls` 0→4） |
| B. CDP `Input.insertText` | ❌ `react=""` | 没送到 |
| C. CDP 逐字符 `keyEvent` | ❌ `react=""` | 没送到 |

→ **只有 A 有效。** 这是本机驱动 Electron 输入时唯一可用的方式。

---

## 六、自动化测试测不出的主观项

以下几件事**必须你亲自打开应用看，凭直觉判断**，自动化测不了：

1. **`start-dev.cmd` 那个黑窗口的阅读体验。** 我保证的是"逻辑正确、会等到真就绪"，
   但**它的提示是不是人话、等 30 多秒时你会不会以为它卡死了** —— 这个我看不出来。
   具体请感受：`正在等待数据库真正接受查询（首次恢复可能要 1~2 分钟）...` 这一行出现后，
   干等半分钟，你会不会想去点它 / 关掉它。
2. **首次恢复那 30 多秒你等不等得下去。** 这是本机磁盘的真实代价（全库 fsync）。
   如果觉得太久，我可以改成"每次正常关库"（`-m fast`），但**只要你强杀过一次，这个代价就逃不掉**。
   要不要给它加个进度提示 / 或者接受它？这个取舍得你定。
3. **登录成功之后，界面本身好不好用。** 我这轮只证明了"数据库通了、登录接口能工作"，
   登录进去之后的观感（布局、文字、节奏）不在这轮范围内，也不该由我替你下结论。

---

## 七、遗留风险 / 未完成

| 项 | 状态 |
| --- | --- |
| `run-task-e2e.py` 修完后的**完整成功一次**运行 | 未做。修了 5 处假 PASS + 加了清空 profile，但还没在"干净 profile + 真库"下跑通完整一轮 |
| `start-dev.cmd` 的**真机双击验证** | 逻辑已逐段复刻验证 + 反证通过，但**双击执行本身**只能由你跑（agent 无法常驻 GUI 窗口） |
| `_e2e-profile/` 加 `.gitignore` | 未做 |
| 本轮新脚本 git 提交 | 未做（commit 后必须 `git log -1` 复查 ref） |

---

## 八、怎么用

双击 `C:\Users\bing\workbuddy-ai\work123\start-dev.cmd`，等它打印「启动完成」，
再打开应用登录。**验证码是 mock 的、不发真短信** —— 看「AI工作台-服务端」那个窗口里的
`[sms:mock] -> 186****xxxx 验证码 123456`。

两个新窗口（PostgreSQL / 服务端）**不要关**；关掉就是停服务。
