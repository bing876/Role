# MEMORY.md — work123 / AI 工作台 硬约定

> **只留每天要用的硬规则**（超注入上限会被截断）。工具坑/命令/环境事实 → `TOOLBOX.md`；事故叙事 → `YYYY-MM-DD.md`。
> 已压缩 4 次（09-22 / 09-24 / 09-25 / 09-26）。

## 〇、仓库与远端
- 远端 **`bing876/Role`**（旧名 work123）。**不是 partial clone**。保险分支 `local-before-reset-20260924`（本地独有）。
- ★★ **HTTPS 被拦，必须走 SSH + 显式 URL**：
  `export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20"`
  再 `git fetch --no-tags git@github.com:bing876/Role.git '+refs/heads/*:refs/remotes/origin/*'`
  （`~/.ssh/config` 已把 github.com → ssh.github.com:443）。**显式 URL push 不更新 `refs/remotes/origin/*`** ⇒ 推完再 fetch 一次；复核用 `git ls-remote <url> refs/heads/<b>`。
- 合并前预演：`git merge-tree --write-tree <A> <B>`（exit 0 = 无冲突，不碰工作区）。**有未提交改动先提交再 merge**。
- 破坏性操作前 `cp -r .git/refs` 到仓库外；遇 `could not fetch <sha> from promisor remote` → `GIT_NO_LAZY_FETCH=1`。
- ★ 本会话工作分支 = **`arena/01a0d0a8-role`**（不开 PR、不合并，合并由用户收尾时做）。

## 一、架构边界（改哪层 → 怎么生效）
三进程：Electron 桌面端 + Fastify(8787) + PG(5432)。桌面端**不打包服务端**。
- 服务端 `apps/server/src/**`：**不是热重载** ⇒ 先 `npm run build -w @ai-workbench/server`。
  ★★ **可免重启热换**：重建 dist 后 `taskkill /F /PID <8787 上的旧服务端>`，桌面端 10 秒保活心跳会自动从新 dist 重拉（8787 上的服务端进程名 = `electron.exe`）。
- 渲染层 `apps/desktop/src/**` vite 热更；主进程 `apps/desktop/electron/**` **必须** `npm run build:electron`。
- ★ 启动口径：`dev` = **Vite + Electron 真窗口**（不是网页版）；另有 `dev:desktop` / `dev:web` / `dev:server`。
- ★ Electron = **44.4.5**；**`<webview>` 已退场**（ADR-0002 → 主进程托管 `WebContentsView`，`view-host.ts` 是唯一建页口）。
- ★★ **Electron 二进制必须走镜像**（github release HTTP 000）：
  `ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js`
  ★ **`npm install` 成功 ≠ 二进制就位** ⇒ 装完查 `node_modules/electron/dist/version`。
- 服务端**不在 asar 里**（从 `repoRoot/apps/server/dist/index.js` 拉起）⇒ 服务端改动与换装无关。

## 二、★★ 环境与数据库
「登录不上」→ 先看 `/health` 的 `db`。可靠启动：双击仓库根 `start-dev.cmd`（只起 PG+服务端，Electron 另起）。
- PG 便携包 `~\workbuddy-ai\pg2`（`pg\bin` 无 psql）；探活 `pg2/ping-db.mjs`。
- 服务端 cwd 必须 `apps/server`（`dotenv/config` 从 cwd 加载）；`dotenv` **不覆盖**已有环境变量。
- ★★ **桌面端/安装版会自己拉起 PG + 服务端**（`ensurePostgres`/`ensureServer`）⇒ 真机验收不必先跑 start-dev.cmd；`/health` 出 `db=up` 即可。
- ★★ **起 dev 桌面端前先 `taskkill /F /IM electron.exe`**：桌面端有**单实例锁**，已有实例在跑时新启动会
  「检测到已有实例在运行，本次启动退出」且**新实例不带 CDP 端口**。★ **vite 必须用后台任务方式起**（`run_in_background`），
  用 `(vite &)` 子 shell 起的会被回收 → 渲染层 `ERR_CONNECTION_REFUSED` → 页面变 opaque origin → `localStorage` 抛 SecurityError。
- ★★ **改了 `apps/server/**` 必须 `npm run build -w @ai-workbench/server` 再重启桌面端**（它拉起的是构建产物）。
- ★ agent 不能替用户常驻进程：起环境的验证必须**一次调用跑完「起→断言→收尾」**。常驻手段**全走不通**（`sleep N` 后台挂住 / `Start-Process` / `Win32_Process.Create` / `schtasks` 禁用 / `explorer.exe x.cmd` / `pg_ctl start` / `nohup &`）⇒ **别再试**，给用户 N 分钟窗口。
- ★★★ **MSYS 的 `find.exe` 会毁掉 `start-dev.cmd`**（脚本里 `tasklist | find` 调到 Unix find ⇒ 误删 `postmaster.pid`、乱起第二个 postgres）⇒ **起环境让用户双击**，别从 bash 代跑；非要代跑就给干净 PATH。
- ★ `taskkill /F /T` 杀 Electron dev 进程树会**连坐杀掉 PG 子进程**。`MSYS_NO_PATHCONV=1` 与 `cmd //c` **不可同用**；`tasklist /FI` **必须**加它。`.cmd` 只写纯 ASCII（Write 出来是 UTF-8，cmd 按 GBK 读乱码）。
- **PG 三坑**：① 端口通 ≠ 可查（要 ~34s；`migrate()` 只跑一次 ⇒ 撞上静默降级，`/auth` 503）。PASS = `db="up"` + 日志「数据库表就绪」+ 无「暂未连通」。② **别按端口判在跑** ⇒ 先 `taskkill /F /IM postgres.exe` 再起唯一一个。③ `postmaster.pid` 残留 → 静默拒启（判据是「那个 PID 现在是不是 postgres」）；停库 `pg_ctl stop -m fast`。
- ★★ **起 Electron 前连续 2 次** `/health` 报 `db=up`（间隔 3s），否则 pg-supervisor 会再拉一个 PG。
- ★★ **判数据库好不好必须直读库**（`_dbq-tables.mjs`）或日志「数据库表就绪」；`db:"up"` 不代表 migrate 跑过。**不用手动重启服务端**（会自己重试建表，实测第 12 次成功）。
- **表 & 密钥**：`users`(`xyz_id`/`phone_hash`/`phone_enc`，无明文 phone)；`projects` 只有 `is_default`；`agents` **无 user_id**（靠 `project_id`）；`sms_codes` 作废列 `used`。改 `PHONE_PEPPER` → 老用户全登录不上。★ 密钥只放 `apps/server/.env`（代码无兜底、缺了拒启）。
- **三个「假问题」**：① `goal_enc does not exist` 是回填竞态不是 bug；② `user_memories`/`agent_memories` 表**故意 DROP**（并入单一 `memories` 表），但日志字符串没更新 ⇒ 误导；③ `routines` 真名 = **`agent_routines`**。

## 三、★ 换装 & 安装版确认
- 包 `...\Programs\@ai-workbenchdesktop\resources\app.asar`；用户数据 `%APPDATA%\@ai-workbench\desktop`。
- ★★ 换装前**两个产物都查 token**（只跑 `build:electron` 会漏渲染层 `dist/assets` ⇒ 半同步包）；**sha256 一致 ≠ 包好**。脚本 `.workbuddy-ai/_s28-token-check.mjs`。
- ★★ 安装版必须 `--no-sandbox`；**`electron-builder` 本机跑不通** ⇒ 只走 `.workbuddy-ai/swap-dist.mjs`。
- ★★ 卡 EBUSY = 有 `AI 工作台.exe` 活着 ⇒ `taskkill /F /T /IM "AI 工作台.exe"`。**别杀 `WorkBuddyAI.exe`**（会话宿主）。
- ★★ **安装版自己拉起 PG + 服务端**，60 秒内 `db=up`。
- ★★ 换装自检必须含「本轮改动」；**渲染层 bundle 哈希没变 ≠ 没构建**。
- ★★★ 工作区根目录在会话存活期间**无法重命名**（`WorkBuddyAI.exe` + 沙箱持有句柄）。

## 四、★★★ 验证方法论
- ★★★ **`*:revert` 反证脚本跑到一半绝不能杀**：`TaskStop` 会把源码留在「已注入」状态（曾把 `routineCreate.ts`、`14-browser-column.css` 整个清空）。跑完**必须** `git status --short apps/` 复核。
- ★★★ **本机沙箱把同步 spawn 一律拦成 EBUSY**（`spawnSync`/`execFileSync`）；**异步 `spawn` 正常** ⇒ 验收脚本一律异步 spawn + Promise。
- ★★★ **`npx`/`npm` 在 PATH 上只有 `.cmd`/`.ps1`** ⇒ `spawn('npx')` ENOENT、`execFileSync` EBUSY、Python FileNotFoundError。统一改「`process.execPath` / `shutil.which('node')` + `node_modules/tsx/dist/cli.mjs`」。
- ★★ **C 盘长期 ~100% 满** ⇒ 反证脚本报 `[Errno 28]`，**验收结论会被污染**。大头：`pagefile.sys` 15GB、`$Recycle.Bin`、`~/.workbuddy-ai/logs`、electron 缓存。跑 `npm install` 前先看 `df -h /c`。
- ★★★ **`npm run verify` 用 `&&` 串 31 个子套件 ⇒ 第一个失败把后面全挡住**。查真实清单必须**逐个单跑**。
  ★ 2026-09-26 实测：链在 **`verify:loop:kill9` 停下并卡住**（7 FAIL：`kill 后库里还有这个循环（status=行不存在）`）——
  已用 `git stash` 暂存本批改动后重跑基线，**同样 7 FAIL + 同样卡住** ⇒ **既有问题**（pglite 层，不加载渲染层代码）。
  `verify:db` / `verify:db:mutate-nocipher` **不在链里**（要 `VERIFY_DATABASE_URL` 指可写测试库）。
- ★★★ **`.mts`(ESM) 验收脚本 import `apps/server`(CJS) → 两份模块实例**（症状：结构相等但引用不等 / 测试写的状态生产代码看不见）。无顶层 await → 改 `.ts`；有 → `createRequire(import.meta.url)`。只测纯函数的不受影响。
- ★★★ **`ENABLE_DEV_MOCK_LLM=1` 会被真 `DEEPSEEK_API_KEY` 顶掉**（`env.ts:301`）⇒ 脚本必须**显式**加 `DEEPSEEK_API_KEY: 'mock'`。
- ★★ **Windows 下验收脚本四类固定崩法**：① `spawn('npx')` ENOENT；② `path.relative` 给 `\` 而白名单是 `/` ⇒ `.split(path.sep).join('/')`；③ `new URL(...).pathname` 给 `/C:/...` ⇒ 用 `join(repoRoot,…)`；④ 行尾（读归一 CRLF→LF，**还原按字节**）。
- ★ 触发 `target=_blank` / React 合成事件必须**完整鼠标序列** `mouseMoved → mousePressed(1) → mouseReleased(0)`（`.click()` 静默失效）。
- ★★ **探针前提先造干净**：别留旧服务端；连上 CDP 立刻读 `innerText` 是空串要轮询。
- **反证**：存在性 ≠ 正确性；0 条变红 = 断言太弱。★ 打不红先分清 ① 修复没用 ② **测试覆盖不到那个时序**（今天 C7 就撞到：bug 只在 StrictMode 下现形，非 StrictMode 的 jsdom 网测不出 ⇒ 单独挂一个 StrictMode 的断言）。
- ★★ **"测试红了" ≠ "产品坏了"**：先证明这条路径真被走到。★ **统计按 pid 归因**；模型非确定性 ⇒ 单次通过不算通过。
- **判据优先级**：直读库 `tasks.payload.steps`（`dbq.mjs`，只放 SELECT）> 页面侧计数 > 界面文字。
- ★★ **CDP 直插**（dev 与安装版都行）：`--no-sandbox --remote-debugging-port=9222` → `GET /json/list` → Node 22 全局 `WebSocket` → `Runtime.evaluate`。
  ★★ 起 dev 桌面端必须 **`env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS`**（否则 electron.exe 被当 node 跑）；登录页有「⚡ 一键演示账号」按钮可点。
  ★ 窗口**最小化**时 `screenX=-32000`、`desktopCapturer` 抓不到该窗口；**guest 的 `Runtime.evaluate` 本机会超时**（别从 guest 侧读几何）。
  ★ 机制层与状态层**分开验**：先用真实 `dist-electron/view-host.js` 起最小 Electron 探针证明「手」没问题，再查状态机。
- ★★ 渲染层"连不上后端"先查 `API_BASE()`（靠 `window.workbench?.isElectron`），**preload 必须真暴露 `isElectron: true`**。
- 自己起全套环境、自己收干净、端口另起；8901 被 `douyin_tray.exe` 占；8787 服务端、5173 vite。
- ★★ 性能四条：卡顿看**帧时间**不看 CPU%；量体感延迟要减掉自己方法里的等待；soak 必须带对照组；别从快照推断系统级原因。
- ★★★ 测渲染/性能前**先确认窗口真可见**（被遮挡 ⇒ `hidden=true`、rAF 60→1/s，帧率不可用）。

## 五、★ 产品设计原则
- ★★ **AI 自主度口径（用户 2026-09-21 定）**：「我只派活，AI 独立用浏览器」。**非高风险 → AI 全权自主**；**高风险 → 必须主动申报、停下来问**（付款/下单/密码/验证码/登录墙）。材料在会话里一次性要齐。判据 = **动作本身是否高风险**。
- ★★ **「会话 / 浏览器」双通道**：会话 = 派活 + 要材料 + 高风险时才把页面摆进来；浏览器 = AI 的地盘，用户可随时点开看（默认不该顶掉会话）。
- 「还在自愈」不是「坏了」：自愈期不报错，要「正在准备」+ 自动重探。
- 应用自己拉起的子进程 stdout 用户看不见 → 要给人看的必须转 UI 或写文件；**通道名两端必须一致**。
- ★★★ **列/面板可见性只许有「一个真相」**（ADR-0005）：任何「两个 state 必须同进同退」的设计，迟早有一个入口漏掉 ⇒ 症状就是「页已创建已加载却看不见」。新加开页入口时**别再逐个补**，让上层从唯一真相派生。
- ★★★ **「等继续」只有一个状态**（`awaitResume` 三件套）：挂起（发「停」）与「步数上限」都复用它 ⇒ 状态行/输入框都从它派生。
  ★★ **`resume`（「继续」）的判定块必须在 `sendChat` 最前面** —— 放在「有循环」分支之后时，挂起态（loopId 已清）走不到，
  会掉进「补充指令」分支。★★ **挂起时 `streaming` 仍是 true**（SSE 没关）⇒ 发送键必须单列暂停态分支（否则落进「打字中…」并被禁用）。
- ★★★ **过程轨迹与最终回答分开**（规格 C9）：`apps/server/src/chatDelta.ts` 的 `chatDeltaFor()` 是**唯一**往聊天流写 `delta` 的地方 —— **只有 `say` 返回文本**，步骤/完成/等待/求助/停止一律 null（只走结构化事件 → 桌面 `runTrace` → 默认收起的抽屉）。★ **「同一段出现两次」= 同一事件被两路渲染**（服务端 delta + 桌面 `say()`）⇒ 修法是收成一条路径，不是删某一路的字。验收 `verify:chat-trace` + `verify:logic` ⑲ + 反证 `chat-interaction-revert.py`（9 条）。

## 六、★ 安全边界
改安全相关代码前先读 `TOOLBOX.md`「安全边界现状」。最容易踩：① `apiBase` **只放行回环**；② 分区是「登录态隔离」**不是安全边界**。

## 七、浏览器面板 + 求助卡
- 挂载 `App.tsx`: `browser.allTabs.length > 0 && <div className="browserLayer">…`（零页即卸载 = 唯一有意卸载路径之一）。
- ⚠️ **页宿主尺寸为 0 会让 CDP 点不中元素** ⇒ "隐藏"必须保真实尺寸，禁 `display:none`/0×0（隐藏 = `transform` 移出视野 / `setVisible(false)`）。
- **视图三态**：`fullscreen` / `background`（默认，opacity:0 保尺寸）/ `embed`（求助卡影子层）。
- **求助卡影子层**：页**一动不动**，只把卡片占位区几何写成内联样式盖上去。★ 实测搬 DOM 会销毁 guest。
- **触发是保守闸**：本地页面信号 **且** AI 确实卡住；`need_info`/`step_budget`/`llm_*` 不算卡住。
- ★★ **求助卡里绝不能有输入控件、提交/验证类按钮**（用户必须在真实页面上操作）。
- ★★ `activate()` 不许在 embed 态抢视图（会冲掉求助卡）。状态机 `electron/helpState.ts`。
- ★ 复现「闲置 1 个浏览器」用 `window.workbench.openBrowser(url)`（只开页、不起任务）。

## 八、P0 止血 + 高风险申报（已交付+已换装）
- **TTL 分档**：`toolLoop.ts` `ttlOf()` —— 等待态 `WAITING_TTL_MS=6h`，其余 `LOOP_TTL_MS=10min`（别动）。
- **`loop_gone` 语义码**：只有这个码才弹「要重新开始吗」。
- ★★ `staleClicks` 会被 `read_page` 清零 ⇒「连点 3 次无变化」只在连续不夹动作时生效。
- ★★ **工具超时 ≠ 动作没执行**（`CDP_TIMEOUT_MS=8s` 先到会记失败，但点击确实发生 → `TOOL_OUTCOME_UNKNOWN`）。
- 假模型 `LASTSTEP` 按 goal 记忆 ⇒ 多轮实验**每轮 goal 必须不同**。
- `DriveResult.risk?: 'pay' | 'sensitive'`；`driver.ts` 三处带出；`agent.ts` 在 `if (res.ok)` **之前**拦。
- 分级：一级 AI 全权；二级申报+用户亲自输（密码/验证码/支付信息/身份证）；三级申报+用户亲自点（付款/下单/提交订单）；登录墙 = 申报。

## 九、杂项（最常复发）
- ★★ **本机可能有另一个会话同时改这个仓库** ⇒ 提交/打包/换装前先 `git status` 分清归属。
- ★★ **Edit 会「报成功但文件没变」** ⇒ 改完关键常量必须 grep 复查。
- **行尾**：`*.ts/tsx/css` = CRLF；`*.py`/`*.mjs` = LF。
- ★★ **`useRef(初值)` 只在「新实例」上生效** —— 用「cleanup 里设 true」的粘性标志在 `<StrictMode>`（`main.tsx:72` 开着）下从挂载起就永远是 true（React 在同一实例上跑 setup→cleanup→setup）。要么挂载时复位，要么改用「代次 + 微任务」（`BrowserPanel` 已这么修）。
