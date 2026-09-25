# MEMORY.md — work123 / AI 工作台 硬约定

> **只留每天要用的硬规则**（超注入上限会被截断）。工具坑/命令/环境事实 → `TOOLBOX.md`；事故叙事 → `YYYY-MM-DD.md`。
> 已压缩 3 次（2026-09-22 / 09-24 / 09-25）。新增内容请先想清楚「这属于 MEMORY 还是 TOOLBOX」。

## 〇、仓库现状（2026-09-25 实测）
- 远端：**`bing876/Role`**（旧名 `bing876/work123` 已改名）。本地 `main` 跟踪 `origin/main`。
- **不是 partial clone**（无 `.promisor`），`.git` 健康；保险分支 `local-before-reset-20260924`（本地独有）。
- ★★ **HTTPS 仍被拦**（`schannel: server closed abruptly`），**必须走 SSH**：
  `export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20"`
  再 `git fetch --no-tags git@github.com:bing876/Role.git '+refs/heads/*:refs/remotes/origin/*'`。
  **必须用显式 URL**（`-c remote.origin.url=` / `GIT_CONFIG_*` 覆盖都无效）。`~/.ssh/config` 已把 github.com 映射到 `ssh.github.com:443`。
- ★ **用显式 URL push 不会更新 `refs/remotes/origin/*`** ⇒ 推完要再 `git fetch` 一次，否则 `git status` 误报 ahead；复核远端用 `git ls-remote <url> refs/heads/main`。
- 合并前预演冲突：`git merge-tree --write-tree <A> <B>`（不碰工作区，exit 0 = 无冲突）。
- ★ **有未提交改动时先提交再 merge**，否则改动会被 merge 冲掉/卡住。
- 历史事故（partial clone 毁库 / 含 `/` 分支名丢 ref / gc prune 对象）**已随仓库重做消失**，但**通用规程仍有效**：
  - 破坏性操作前 `cp -r .git/refs` 到**仓库外**；操作后 `ls -R .git/refs` 复查（ref-guard 钩子只修当前分支，不够）。
  - 离线冲突预演用 `git merge-tree --write-tree <A> <B>`（不碰工作区/ref，打印结果树 oid，exit 0 = 无冲突）。
  - 遇 `could not fetch <sha> from promisor remote` → `export GIT_NO_LAZY_FETCH=1`。

## 一、架构边界（改哪层 → 怎么生效）
三进程：Electron 桌面端 + Fastify(8787) + PG(5432)。桌面端**不打包服务端**。
- 服务端 `apps/server/src/**` 热重载；验收跑 `dist/index.js` ⇒ 先 `npm run build -w @ai-workbench/server`
- 渲染层 `apps/desktop/src/**` vite 热更；换装 `npm run build -w @ai-workbench/desktop`
- 主进程 `apps/desktop/electron/**` **必须** `npm run build:electron`
- 判 8787 是不是新代码：看 `/health` 有没有新字段
- 服务端**不在 asar 里**（桌面端从 `repoRoot/apps/server/dist/index.js` 拉起）⇒ 服务端改动与换装无关

## 二、★★ 环境与数据库
「登录不上」→ 先看 `/health` 的 `db`。唯一可靠启动：双击仓库根 `start-dev.cmd`（只起 PG+服务端，**Electron 要另起**）。
- PG 便携包 `~\workbuddy-ai\pg2`（`pg\bin` 无 psql）；探活 `pg2/ping-db.mjs`
- 服务端 cwd 必须 `apps/server`（`dotenv/config` 从 cwd 加载）；`dotenv` **不覆盖**已有环境变量
- 验证码 mock：只在「AI工作台-服务端」窗口 / 经 `relayServerLog` 转 UI
- ★ agent 不能替用户常驻进程：**起环境的验证必须一次调用跑完「起→断言→收尾」**。已试过**全走不通**（`sleep N` 后台挂住、`Start-Process`、`Win32_Process.Create`、**`schtasks`（安全策略明令禁止）**、**`explorer.exe <x.cmd>`**、`pg_ctl start`、`nohup &`）⇒ **别再想办法让它常驻**，只给用户 N 分钟窗口 + 明说「窗口没了自己双击图标」

### ★★★ MSYS 的 `find.exe` 会毁掉 `start-dev.cmd`（2026-09-25 实撞，PG 被打死）
**从 agent 的 bash 里**跑 `cmd //c start-dev.cmd`，PATH 带 MSYS 目录 ⇒ 脚本里 `tasklist | find "…"` 调到 **Unix `find`** ⇒
start-dev.cmd 误删 `postmaster.pid`、`watchdog.cmd` 每 10s 反复删 pid + 乱起第二个 postgres.exe（两个 postmaster 同数据目录）。
旧 PG 被打死，但 **WAL 自动恢复成功、数据无损**（users 6 / projects 6 / agents 9 / tasks 1）。
- ★ **解法**：给 cmd 干净 PATH —— `PATH="/c/Windows/System32:/c/Windows:/c/Windows/System32/Wbem:/c/Program Files/nodejs" cmd //c start-dev.cmd`
- ★★ **用户双击天然干净 PATH，不受影响** ⇒ **起环境就该让用户双击，别从 bash 代跑**
- ★★ **`taskkill /F /T` 杀 Electron dev 进程树会连坐杀掉桌面端 `ensurePostgres` 拉起的 PG 子进程** ⇒ 杀前先确认 PG 是不是它的子进程
- ★ `MSYS_NO_PATHCONV=1` 与 `cmd //c` **不可同用**（cmd 收到字面 `//c` → 静默 exit 1）；`MSYS_NO_PATHCONV=1 cmd /c` 被安全策略拦；`tasklist /FI` 反而**必须**加 `MSYS_NO_PATHCONV=1`；**Write 写的 `.cmd` 是 UTF-8，cmd 按 GBK 读会乱码** ⇒ `.cmd` 只写纯 ASCII
- 完整细节（含 Windows/bash 互操作坑表）见 `TOOLBOX.md` 末节

**PG 三坑**：① 端口通 ≠ 可查（5432 1.6s 通但报 `starting up`，可查要 ~34s；`migrate()` 只跑一次 ⇒ 撞上静默降级，`/auth` 一律 503）。PASS 三条件：`db="up"` + 日志有「数据库表就绪」+ 无「暂未连通」。② **别按端口判在跑**（恢复期已监听）⇒ 先 `taskkill /F /IM postgres.exe` 全杀再起唯一一个。③ `postmaster.pid` 残留 → 静默拒启（判据是「那个 PID 现在是不是 postgres」，不是「还活不活」—— Windows 会回收 PID，见 `server-supervisor.ts` `pidImageName`）；停库 `pg_ctl stop -m fast`。
- ★★ **起 Electron 前必须连续 2 次** `/health` 报 `db=up`（间隔 3s），否则 pg-supervisor 会自己再拉一个 PG ⇒ 登录失败。
- ★★ **判断数据库好不好必须直读库**（`_dbq-tables.mjs`）或日志出现「数据库表就绪」；`db:"up"` 只是实时探测，**不代表 migrate 跑过**。但**不用手动重启服务端**——它会自己重试建表（实测第 12 次成功），先出现「数据库暂未连通」是正常恢复期。

**表 & 密钥**：`users`(`xyz_id`/`phone_hash`/`phone_enc`，无明文 phone)；`projects` 只有 `is_default`；`agents` **无 user_id**（靠 `project_id`）；`sms_codes` 作废列 **`used`**。改 `PHONE_PEPPER` → 老用户全登录不上。★ **密钥只放 `apps/server/.env`**（`.gitignore` 挡住），代码无兜底、缺了拒启；`.env.example` 只留空值+注释。

**★ 三个「假问题」别重复踩（2026-09-25 查清）**：
1. 启动日志 `goal 密文回填暂未完成：task_pauses: column "goal_enc" does not exist` → **是竞态不是 bug**：回填重试跑在 `migrate()` 建列之前，重试机制正是为此设计。稍后该列就在。
2. `user_memories` / `agent_memories` 表不存在 → **故意 DROP 的**（记忆合并第一批，已并入单一 `memories` 表，`agent_id IS NULL` = 账号级）。但 `index.ts` 的「数据库表就绪（…user_memories/agent_memories）」是**硬编码字符串**没跟着更新 ⇒ 日志误导。
3. `routines` 表 → **真名是 `agent_routines`**。
★ **桌面端 supervisor 起的是 `apps/server/dist/index.js`（构建产物），不是 tsx** ⇒ 改了服务端一定要 `npm run build -w @ai-workbench/server`，否则重启桌面端也还是旧代码。

## 三、★ 换装 & 安装版确认
- 已安装包 `...\Programs\@ai-workbenchdesktop\resources\app.asar`；用户数据 `%APPDATA%\@ai-workbench\desktop`
- ★★ **读产出 asar 的字节**；**sha256 一致 ≠ 包好** ⇒ 用 token 脚本查「包里有没有本轮代码」（构建产物是会动的靶子）
- ★★ 换装前**两个产物都查 token**：只跑 `build:electron` 会漏渲染层 `dist/assets` ⇒ 半同步包。脚本 `.workbuddy-ai/_s28-token-check.mjs`；冒烟 `.workbuddy-ai/_s28-smoke.py`
- ★★ 安装版必须 `--no-sandbox`；**`electron-builder` 本机跑不通** ⇒ 换装只走 `.workbuddy-ai/swap-dist.mjs`
- ★★ 换装卡 EBUSY = 有 `AI 工作台.exe` 还活着 ⇒ `taskkill /F /T /IM "AI 工作台.exe"` 再 `mv`。**别杀 `WorkBuddyAI.exe`**（会话宿主）
- ★★ **安装版会自己拉起 PG + 服务端**，60 秒内 `db=up` ⇒ 验收不必手动跑 `start-dev.cmd`
- ★★ **换装脚本自检必须含「本轮改动」**（曾 STAMP 写了修复名但 `must` 里没断言 ⇒ 自检全绿也不证明修复进包）
- ★★ **渲染层 bundle 哈希没变 ≠ 没构建**（改动只在主进程时哈希本就该一样）
- ★★★ **工作区根目录在会话存活期间无法重命名**（`WorkBuddyAI.exe` + 沙箱持有句柄）

## 四、★★ 验证方法论
- ★★★ **`npm run verify` 用 `&&` 串 31 个子套件 ⇒ 第一个失败把后面全挡住**，「只红在第 3 步」是假象。
  查真实清单要**逐个单跑**（`verify:*` 全列表 + 逐套件 rc 的脚本见 `wb-backups/verify-suites.txt`）。
  2026-09-25 实测：单跑 25 通过 / 6 失败；其中 `verify:db`、`verify:db:mutate-nocipher` **不在链里**
  （要 `VERIFY_DATABASE_URL` 指向**可写的测试库**，别指用户的真库）。
- ★★★ **`.mts`(ESM) 验收脚本 import `apps/server`(CJS) 模块 → 两份模块实例**（tsx 下各一份模块图）：
  `import` 拿到的 `registry`/`toolLoop` 与生产代码内部 `require` 到的**不是同一个**。
  症状指纹：**结构相等但引用不等** / **测试写的状态生产代码看不见**（`markAgentBusy` 后 `resolveAgentStatus` 仍 idle）。
  - 该文件无顶层 await → **改名 `.mts`→`.ts`**（`mention-decision` 就是这么修的，11 红 → 41/0）；
  - 有顶层 await 改不成 CJS → **`createRequire(import.meta.url)`** 载入服务端模块（`tool-registry-parity` / `orc-*` / `websearch`）。
  - ★ 只测纯函数、不碰跨模块内存状态的脚本不受影响，`.mts` 照旧可用。
- ★★★ **`ENABLE_DEV_MOCK_LLM=1` 会被真 `DEEPSEEK_API_KEY` 顶掉**（`env.ts:301` 是真 key 优先）
  ⇒ 「不联网、不烧 token」的验收脚本**实际在调真 API**：结果不确定 + 花用户的钱。
  修法：脚本里**显式**加 `DEEPSEEK_API_KEY: 'mock'`（`loop-kill9-db` / `r4-dispatch-acceptance` 已修）。
- ★★ **Windows 下验收脚本的四类固定崩法**（Linux 上都是对的，所以一直没暴露）：
  ① `spawn('npx')` / `subprocess.run(['npx',…])` → **ENOENT**（CreateProcess 不解析 `.cmd`）⇒ 改 `node + node_modules/tsx/dist/cli.mjs`；
  ② `path.relative` 给 `tasks\agent.ts` 而白名单是 `/` 拼的 ⇒ 永远红 ⇒ `.split(path.sep).join('/')`；
  ③ `new URL(...).pathname` 给 `/C:/...` ⇒ esbuild `Could not resolve` ⇒ 改 `join(repoRoot,…)`；
  ④ 行尾：`read()` 归一 CRLF→LF；**还原文件必须按字节**（`read_bytes`/`write_bytes`）。
  （逐脚本明细见 `2026-09-25.md` 下午那节）
- 自己起全套环境、自己收干净、**端口另起**；8901 被 `douyin_tray.exe` 占；8787 服务端、5173 vite
- 探针 `main()` 里 `return 2` 会跳过收尾 ⇒ 用 `__main__` 的 `try/finally: cleanup_all()`
- ★ 触发 `target=_blank` / React 合成事件必须**完整鼠标序列** `mouseMoved → mousePressed(1) → mouseReleased(0)`（`.click()` 静默失效）
- ★★ **探针前提先造干净**：8787 留着旧服务端会被直接用；连上 CDP 立刻读 `innerText` 是空串，要轮询；`readyState==='loading'` 读 scripts/links 会**假红**
- ★★ **统计按 pid 归因**；**模型非确定性 ⇒ 单次通过不算通过**
- **反证**：存在性 ≠ 正确性；0 条变红 = 断言太弱。注入要「坏条件」且保持签名/返回类型；恢复后 grep 复查
- ★★ 反证打不红先分清：① 修复没用 ② **测试覆盖不到那个时序**。降到更小层面构造条件，并**如实标注证据等级**
- ★★ **"测试红了" ≠ "产品坏了"**：先证明这条路径真被走到（判据选"唯一真相"字段）
- ★★ 性能四条：① 卡顿看**帧时间**不看 CPU%；② 量体感延迟要减掉自己方法里的等待；③ soak 必须带**对照组**；④ 别从快照推断系统级原因
- **判据优先级**：直读库 `tasks.payload.steps`（`dbq.mjs`，只放 SELECT）> 页面侧计数 > 界面文字
- ★★ **安装版也能 CDP 直插**：`--no-sandbox --remote-debugging-port=9222` → `GET /json/list` → Node 22 全局 `WebSocket` 连 `webSocketDebuggerUrl` → `Runtime.evaluate`。`_cdp-probe.mjs` + `_cdp-login-e2e.mjs`
- ★★ 渲染层"连不上后端"先查 `API_BASE()`：靠 `window.workbench?.isElectron` 决定后端地址，**preload 必须真的暴露 `isElectron: true`**（`WorkbenchBridge` 接口也要声明，否则 TS 报多余属性）

## 五、★ 产品设计原则
- ★★ **AI 自主度口径（用户 2026-09-21 定）**：「**我只派活，AI 独立用浏览器**」。**非高风险 → AI 全权自主**（填表/下一步/选类目/代填材料，不用报备）；**高风险 → 必须主动申报、停下来问**（付款/下单/密码/验证码/登录墙）。材料在**会话里一次性要齐**。判据是**动作本身是否高风险**，不是"执行没执行"
- ★★ **「会话 / 浏览器」双通道**：会话 = 派活 + 要材料 + 高风险时才把页面摆进来；浏览器 = AI 的地盘，**用户可随时点开看执行轨迹**（默认不该顶掉会话）
- 「还在自愈」不是「坏了」：自愈期不许报错，要"正在准备"+自动重探，绝不落成要用户再点一次的终态错误
- 应用自己拉起的子进程 stdout 用户看不见 → 要给人看的信息必须转 UI 或写文件；**通道名两端必须一致**

## 六、★ 安全边界
改安全相关代码前先读 `TOOLBOX.md`「安全边界现状」（四条）。最容易踩的两条：① `apiBase` **只放行回环**；② 分区是「登录态隔离」**不是安全边界**。

## 七、浏览器面板 + 求助卡（24~27 步，已交付）
- 挂载 `App.tsx`: `browser.allTabs.length > 0 && <BrowserPanel/>`（零页即卸载）
- ⚠️ **webview 尺寸为 0 会让 CDP 点不中元素** ⇒ "隐藏"必须保真实尺寸，禁 `display:none`/0×0
- ★★ `<webview allowpopups>` **必须写字符串** `allowpopups={'true' as unknown as boolean}`
- 复现"闲置 1 个浏览器"用 `window.workbench.openBrowser(url)`（只开页、不起任务）
- 结论：**不支持"闲置浏览器导致卡顿"**；后台 `opacity:0` 只降 rAF（60→1/s），JS 定时器不降
- **视图三态**：`fullscreen` / `background`（opacity:0 保尺寸）/ `embed`（求助卡影子层）。第 28 步起**默认 `background`**
- **求助卡影子层**：webview **一动不动**，只把聊天卡片占位区几何写成内联样式盖上去。★ 实测搬 DOM 会销毁 guest
- **触发是保守闸**：本地页面信号 **且** AI 确实卡住（连败 2 / 连点 3 次无变化 / 服务端回 ask）；`need_info`/`step_budget`/`llm_*` 不算卡住
- ★★ **求助卡里绝不能有输入控件、提交/验证类按钮** —— 用户必须在**真实页面**上操作。改 `HelpCard.tsx` 前先读文件头
- ★★ `activate()` 不许在 embed 态抢视图（`setView('fullscreen')` 会冲掉求助卡）。状态机 `electron/helpState.ts`

## 八、P0 止血 + 高风险申报（28 步，已交付+已换装）
- **TTL 分档**：`toolLoop.ts` `ttlOf()` —— 等待态 `WAITING_TTL_MS=6h`，其余 `LOOP_TTL_MS=10min`（别动）
- **`loop_gone` 语义码**：只有这个码才弹「要重新开始吗」，其余一律「暂时接不上」
- ★★ `staleClicks` 会被 `read_page` 清零 ⇒ 「连点 3 次无变化」只在**连续、中间不夹动作**时生效
- ★★ **工具超时 ≠ 动作没执行**：`CDP_TIMEOUT_MS=8s` 先到会记成失败，但点击**确实发生**（`TOOL_OUTCOME_UNKNOWN`）
- 假模型 `LASTSTEP` 按 goal 字符串记忆 ⇒ 多轮实验**每轮 goal 必须不同**
- `DriveResult.risk?: 'pay' | 'sensitive'`（shared）；`driver.ts` 点/填/填表三处带出；`agent.ts` 在 `if (res.ok)` **之前**拦：pay → `ask`+`paused`+求助卡；sensitive → `sensitiveNotice`+`paused`
- 分级：一级 AI 全权；二级申报+用户亲自输（密码/验证码/支付信息/身份证）；三级申报+用户亲自点（付款/下单/提交订单）；登录墙=申报
- 词表探针 `scripts/verify/risk-guard/_wordlist-probe.mjs` 26 条
- 待真机验收：① AI 真去点「提交订单」→ 没点 + 会话有申报 + paused

## 九、杂项（最常复发）
- ★★ **本机可能有另一个会话同时改这个仓库** ⇒ 提交/打包/换装前先 `git status` 分清归属
- ★★★ 测渲染/性能前**先确认窗口真可见**：被遮挡 ⇒ `hidden=true`、rAF 60→1/s，帧率一律不可用
- ★★ **Edit 会「报成功但文件没变」** ⇒ 改完关键常量必须 grep 复查
- **行尾**：`*.ts/tsx/css` = CRLF；`*.py`/`*.mjs` = LF
