# MEMORY.md — work123 / AI 工作台 硬约定

> 只留**每天要用的硬规则**（超注入上限会被截断，2026-09-22 已压过两次）。
> **工具坑 / 命令细节 / 本机环境事实 → `TOOLBOX.md`**；事故叙事 → `YYYY-MM-DD.md`。

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
- ★ agent 不能替用户常驻进程：**起环境的验证必须一次调用跑完「起→断言→收尾」**
- ★★ **已试过、全走不通**：`sleep N` 后台挂住（任务结束整棵进程树被回收）、PowerShell `Start-Process`（调用结束即死）、`Invoke-CimMethod Win32_Process.Create` 被安全策略拦。⇒ **别再想办法让它常驻**，只能给用户一个 N 分钟窗口并明说「窗口没了就自己双击图标」

**PG 三坑**：① 端口通 ≠ 可查（5432 1.6s 通但报 `starting up`，可查要 ~34s；`migrate()` 只跑一次 ⇒ 撞上静默降级，`/auth` 一律 503）。PASS 三条件：`db="up"` + 日志有「数据库表就绪」+ 无「暂未连通」。② **别按端口判在跑**（恢复期已监听）⇒ 先 `taskkill /F /IM postgres.exe` 全杀再起唯一一个。③ `postmaster.pid` 残留 → 静默拒启；停库 `pg_ctl stop -m fast`。
★★ **起 Electron 前必须连续 2 次** `/health` 报 `db=up`（间隔 3s），否则 pg-supervisor 会自己再拉一个 PG ⇒ 登录失败。
★★ **判断数据库好不好必须直读库**（`_dbq-tables.mjs` 查 information_schema + users 行数）或日志出现「数据库表就绪」；`/health` 的 `db:"up"` 只是实时探测，**不代表 migrate 跑过**。但**不用手动重启服务端**——它会自己重试建表（实测第 12 次成功），先出现「数据库暂未连通」是正常恢复期。

**表 & 密钥**：`users`(`xyz_id`/`phone_hash`/`phone_enc`，无明文 phone)；`projects` 只有 `is_default`；`agents` **无 user_id**（靠 `project_id`）；`sms_codes` 作废列 **`used`**。改 `PHONE_PEPPER` → 老用户全登录不上。★ **密钥只放 `apps/server/.env`**（`.gitignore:18` 挡住），代码无兜底、缺了拒启；`.env.example` 只留空值+注释。

## 三、★★ git（本机高危区，动之前先备份 refs）
**含 `/` 的分支名（`arena/xxx`）写 ref 必失败**：`git commit` 打印 sha、exit 0，但 ref 不落盘（复发 7+ 次）。
- ★★★ **`git fetch` / `update-ref` 同样静默失败**，失败后 git 会 **rmdir 掉 `refs/remotes/origin`**；**`git checkout -b arena/xxx` 会删掉整个 `refs/heads/arena/`**（连旧分支 ref 一起消失）。本机**无 reflog**（`.git/logs` 不存在）
- ⇒ **任何 checkout/branch/commit/fetch 前先 `cp -r .git/refs` 备份（放仓库外，否则被自己的提交带进去），操作后立刻 `ls -R .git/refs` 复查**；缺了就 `mkdir -p` + `printf` 写回
- ★★★ **ref-guard 钩子只修「当前分支」**：2026-09-22 提交时 `refs/heads/arena/01a09b16-work123` 被连带删除，钩子没补 ⇒ **提交后必须拿备份逐项比对全部 ref，不能只看当前分支**
- ★★★ ref 丢失 → 该历史 unreachable → 紧接着 `git pull` 的 **`gc --auto` 会 prune 掉对象**（2026-09-21 实证：丢 `427f919` 及更早全部）
- 恢复 ref：`.git/logs/HEAD` 末行取 sha → `mkdir -p` → `printf` 写回。清索引用 `git rm --cached -r`；**不裸 `git reset`**
- 提交后自查：`rev-parse HEAD` == `refs/heads/<branch>` == `show-ref`，且**隔几秒再查一次**
- 防呆已装 `scripts/git/ref-guard.sh` + hooks（`core.hooksPath`，换机器要重装）。**绝不自动改历史**
- ★★★ **历史被 gc 删后的恢复配方（2026-09-21 实测成功）**：远端不会补发"它认为你已有"的对象 ⇒ ① `cp -r .git/refs` 备份；② **临时移走让 git 以为"已有"的 ref**（heads/arena/01a0c1e3、heads/arena/01a09b16、remotes/origin/arena/01a0c1e3、remotes/origin/review/architecture-audit）；③ `git -c gc.auto=0 -c maintenance.auto=false -c fetch.writeCommitGraph=false fetch --filter=blob:none --no-tags origin arena/01a0c1e3-work123`；④ 还原 ref。结果 87 提交全可读、只花 12MB。副作用：变 **partial clone**（`promisor=true` + `partialclonefilter=blob:none`）⇒ **`git diff`/`git show` 要懒加载缺失 blob，网络不通就报 `could not fetch <sha> from promisor remote`**；补齐需 `git fetch --refetch`，**但要先腾 C 盘**
- 分支血缘：`ca2475a` 是 `3c68c22`(`arena/01a0c1e3-work123`) 的祖先；`main`(`dc335d6`) 与 `arena/01a09b16-work123`(`2b4f41f`) 是**不相交的旧历史**，不能 fast-forward
- ★★★ **partial clone 离线工作法（2026-09-22 实测）**：本仓库 `promisor=true`+`blob:none` 叠加 `core.autocrlf=true` ⇒ git 判断"文件变没变"要读**旧 blob**，本地没有就去联网，网络不通就 fatal。**症状极误导**：`git status` 正常，但 `git diff`/`git show`/`git add -A`/`git write-tree`/`git commit` 全废。
  - ★★ **解法：`export GIT_NO_LAZY_FETCH=1`**（就地失败不联网），之后 `git add -A` 即恢复。`git -c remote.origin.promisor=false` **无效**
  - ★★★ 缺 blob 若是「内容未变的文件」⇒ 可从工作区重建，**只在哈希一致时写入**：`h=$(git hash-object --path="$p" -- "$p"); [ "$h" = "$sha" ] && git hash-object -w --path="$p" -- "$p"`。**已被修改文件的旧 blob 无法重建**（diff 就是取不出来）
  - ★★ 批量要用 `git hash-object --stdin-paths`（单进程）；逐个调会超时被杀。脚本 `../\_recover-blobs2.sh`
- ★★★ **本机代理选择性拦截**（2026-09-22）：`github.com` / `raw.githubusercontent.com` **HTTP 000 恒定 10s 超时**；`api.github.com` ✅200。会话里的 `connector-status: github connected` 指 **MCP 连接器**，**与 git HTTPS 无关**，别被误导。
  - **解法：走 SSH**（`~/.ssh/config` 已把 github.com 映射到 `ssh.github.com:443`，端口可达）：`export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20"` 然后 `git fetch --no-tags git@github.com:bing876/work123.git <branch>`
  - ★★ `-c remote.origin.url=` 与 `GIT_CONFIG_*` 覆盖**都无效** ⇒ **必须用显式 URL**
  - ★★ SSH 命令必须**放行沙箱**（否则读不到 `~/.ssh`）；`run_in_background` 也会被拦
  - ★★★ **GitHub 允许按任意 SHA 定向 fetch**（绕过 `blob:none`）：`git fetch <ssh-url> <blob-sha>`。`--filter=blob:limit=` 在 GitHub **不生效**
- ★★★ **离线冲突检测用 `git merge-tree --write-tree <A> <B>`** —— 纯虚拟合并，不碰工作区/ref，打印结果树 oid，exit 0=无冲突；缺 blob 时抠 SHA 循环定向 fetch 补齐
- 🚨🚨🚨 **partial clone 上跑 merge 会毁库（2026-09-22 实证）**：promisor 远端可达时缺失 blob 触发大量懒加载 → 写 pack/重建索引 → **被 SIGTERM 强杀在中间态** ⇒ **17 个 `pack-*.pack` 被删、松散对象归 0、`.git/refs` 整目录被删**（217M→962K）。`gc.auto=0`/`maintenance.auto=false` 挡不住（不是 gc 干的）
  - ★★★ **破坏性操作前备份整个 `.git`（至少 `objects/pack` + `refs`）**；**只备份 refs 不够**
  - ★★ partial clone 上 `git merge` 要给**极长超时或放后台**，300s 远远不够
  - ★★ **`.git/refs` 被删 ⇒ git 认为「这里不是仓库」⇒ 向上找到 `C:\Users\bing\.git`（家目录有野仓库）**；症状是 `git status` 列出家目录文件、`find .git/refs` 报不存在。误导极强
  - ★ 抢救顺序：① 备份恢复 `refs` ② `git cat-file -t <sha>` 逐个查对象存活 ③ **工作区文件通常完好** ⇒ `git add -A && git commit` 即可复原内容 ④ 远端经 SSH 重新 fetch ⑤ 修好立刻 push 留第二份副本
- ★★ 远端 `arena/01a0c1e3-work123` tip = **`15daa00`**，与本地 `d16e3133` **分叉于 `92f3f1c`**（各 5 条，不能 fast-forward）；**远端不含 `isElectron` 登录修复** ⇒ 只能 merge，**绝不可用远端覆盖本地**
- ★★ **C 盘**：2026-09-22 07:30 实测 **4.3G 可用**（曾低至 120MB）；`.git` = 217M ⇒ 大 pack / 克隆仍优先落 J: 或 E:
- ★★ 跨盘路径坑：**bash 的 `/j/...` 在 git 眼里是 `C:/j/...`** ⇒ 传 Windows 风格 `J:/...`。J 盘**根目录不许建目录**（用已有子目录如 `/j/11111/`）；长 git 进程会被 **SIGTERM**，克隆到 J 盘还报 `schannel: server closed abruptly` ⇒ **跨盘克隆走不通，只能原地 fetch**
- ★★ 判断"进程在不在"别用 `tasklist | grep 中文名`（输出 GBK，bash 永远匹配不到，会把"在跑"误判成"没起来"）⇒ 用 `ps -W | grep <安装目录关键字>` 或看 `/health`

## 四、★ 换装 & 安装版确认
- 已安装包 `...\Programs\@ai-workbenchdesktop\resources\app.asar`；用户数据 `%APPDATA%\@ai-workbench\desktop`
- ★★ **读产出 asar 的字节**；**sha256 一致 ≠ 包好** ⇒ 用 token 脚本查「包里有没有本轮代码」（构建产物是会动的靶子）
- ★★ 换装前**两个产物都查 token**：只跑 `build:electron` 会漏渲染层 `dist/assets` ⇒ 主进程新、UI 旧的**半同步包**（2026-09-21 实证）。脚本 `.workbuddy-ai/_s28-token-check.mjs`；冒烟 `.workbuddy-ai/_s28-smoke.py`
- ★★ 安装版必须 `--no-sandbox`（否则 1 秒 GPU FATAL，易误判成包坏）；**`electron-builder` 本机跑不通** ⇒ 换装只走 `.workbuddy-ai/swap-dist.mjs`
- ★★ 换装卡 EBUSY = 有 `AI 工作台.exe` 还活着 ⇒ `taskkill /F /T /IM "AI 工作台.exe"` 再 `mv`。**别杀 `WorkBuddyAI.exe`**（本会话宿主）
- ★★ **安装版会自己拉起 PG + 服务端**（`ensurePostgres`/`ensureServer`），60 秒内 `db=up` ⇒ 验收不必手动跑 `start-dev.cmd`
- ★★ **换装脚本的自检必须含「本轮改动」**：2026-09-22 那次 `STAMP` 写着 `isElectron-fix-r8-final` 但 `must` 里**没有 `isElectron` 断言** ⇒ 自检全绿也不能证明修复进包。补法见脚本尾部
- ★★ **渲染层 bundle 哈希没变 ≠ 没构建**：改动只在主进程（`preload.ts`）时，`dist/assets` 哈希本就该一样
- ★★★ **工作区根目录在会话存活期间无法重命名**：`WorkBuddyAI.exe` + 沙箱持有句柄 ⇒ `mv` 报 `Device or resource busy`，PowerShell `Rename-Item` 也失败（父目录却可正常改名）。要改名只能等会话结束
- ★★ 验收脚本：`.workbuddy-ai/_verify-login-fix.mjs`（探针）、`_cdp-login-e2e.mjs`（点快捷登录）、`_launch-cdp.cmd`（GBK 启动器，带 `--no-sandbox --remote-debugging-port=9222`）

## 五、★★ 验证方法论
- 自己起全套环境、自己收干净、**端口另起**；8901 被 `douyin_tray.exe` 占；8787 服务端、5173 vite
- 探针 `main()` 里 `return 2` 会跳过收尾 ⇒ 用 `__main__` 的 `try/finally: cleanup_all()`
- ★ 触发 `target=_blank` 必须**完整鼠标序列** `mouseMoved → mousePressed(1) → mouseReleased(0)`；点 React 合成事件同理（`.click()` 静默失效）
- ★★ **探针前提先造干净**：8787 留着旧服务端（含应用自己拉起的孤儿）会被直接用；连上 CDP 立刻读 `innerText` 是空串，要轮询；`readyState==='loading'` 读 scripts/links 会**假红**
- ★★ **统计按 pid 归因**（按 `(type,name)` 会把两个空名 Tab 合并）；**模型非确定性 ⇒ 单次通过不算通过**
- **反证**：存在性 ≠ 正确性；0 条变红 = 断言太弱。注入要「坏条件」且保持签名/返回类型；恢复后 grep 复查
- ★★ 反证打不红先分清：① 修复没用 ② **测试覆盖不到那个时序**。降到更小层面构造条件，并**如实标注证据等级**
- ★★ **"测试红了" ≠ "产品坏了"**：先证明这条路径真被走到（判据选"唯一真相"字段）。回读要证明**发生了变化**
- ★★ 性能四条：① 卡顿看**帧时间**不看 CPU%；② 量体感延迟要减掉自己方法里的等待；③ soak 必须带**对照组**；④ 别从快照推断系统级原因
- **判据优先级**：直读库 `tasks.payload.steps`（`dbq.mjs`，只放 SELECT）> 页面侧计数 > 界面文字
- ★★ **安装版也能 CDP 直插**：带 `--no-sandbox --remote-debugging-port=9222` 启动 → `GET /json/list` 取 page target → Node 22 全局 `WebSocket` 连 `webSocketDebuggerUrl` → `Runtime.evaluate` 读 `window.workbench.*` / localStorage / `document.body.innerText`；点击用完整鼠标序列。`_cdp-probe.mjs`（探活）+ `_cdp-login-e2e.mjs`（点快捷登录看 token）
- ★★ 渲染层"连不上后端"先查 `API_BASE()`：`App.tsx` 靠 `window.workbench?.isElectron` 决定后端地址，**preload 必须真的暴露 `isElectron: true`**（且 `WorkbenchBridge` 接口要声明该字段，否则 TS 报多余属性）。缺了 → 地址算成空串 → `file://` 下 fetch 必败

## 六、★ 产品设计原则
- ★★ **AI 自主度口径（用户 2026-09-21 定）**：「**我只派活，AI 独立用浏览器**」。**非高风险 → AI 全权自主**（填表/下一步/选类目/代填用户给的材料，不用报备）；**高风险 → 必须主动申报、停下来问**（付款/下单/密码/验证码/登录墙）。材料在**会话里一次性要齐**、用户一次性给全。判据是**动作本身是否高风险**，不是"执行没执行"
- ★★ **「会话 / 浏览器」双通道**：会话 = 派活 + 要材料 + 高风险时才把页面摆进来；浏览器 = AI 的地盘，**用户可随时点开看执行轨迹**（默认不该顶掉会话）
- 「还在自愈」不是「坏了」：自愈期不许报错，要"正在准备"+自动重探，绝不落成要用户再点一次的终态错误
- 应用自己拉起的子进程 stdout 用户看不见 → 要给人看的信息必须转 UI 或写文件；**通道名两端必须一致**（不一致只静默不生效）

## 七、★ 安全边界
改安全相关代码前先读 `TOOLBOX.md`「安全边界现状」（四条）。最容易踩的两条：① `apiBase` **只放行回环**；② 分区是「登录态隔离」**不是安全边界**。

## 八、浏览器面板 + 求助卡（24~27 步，已交付）
- 挂载 `App.tsx`: `browser.allTabs.length > 0 && <BrowserPanel/>`（零页即卸载）
- ⚠️ **webview 尺寸为 0 会让 CDP 点不中元素** ⇒ "隐藏"必须保真实尺寸，禁 `display:none`/0×0
- ★★ `<webview allowpopups>` **必须写字符串** `allowpopups={'true' as unknown as boolean}`
- 复现"闲置 1 个浏览器"用 `window.workbench.openBrowser(url)`（只开页、不起任务）
- 结论：**不支持"闲置浏览器导致卡顿"**；后台 `opacity:0` 只降 rAF（60→1/s），JS 定时器不降
- **视图三态**：`fullscreen`（盖住会话）/ `background`（opacity:0 保尺寸）/ `embed`（求助卡影子层）。第 28 步起**默认 `background`**
- **求助卡影子层**：webview **一动不动**（不搬 DOM/不卸载/wcId 不变），只把聊天卡片占位区几何写成内联样式盖上去。★ 实测搬 DOM 会销毁 guest
- **触发是保守闸**：本地页面信号 **且** AI 确实卡住（连败 2 / 连点 3 次无变化 / 服务端回 ask）；`need_info`/`step_budget`/`llm_*` 不算卡住
- ★★ **求助卡里绝不能有输入控件、提交/验证类按钮** —— 用户必须在**真实页面**上操作。改 `HelpCard.tsx` 前先读文件头
- ★★ `activate()` 不许在 embed 态抢视图（`setView('fullscreen')` 会冲掉求助卡）。状态机 `electron/helpState.ts`

## 九、P0 止血 + 高风险申报（28 步，已交付+已换装）
- **TTL 分档**：`toolLoop.ts` `ttlOf()` —— 等待态用 `WAITING_TTL_MS=6h`，其余 `LOOP_TTL_MS=10min`（别动）
- **`loop_gone` 语义码**：只有这个码才弹「要重新开始吗」，其余一律「暂时接不上」（误报会把用户训练成不看内容就点）
- ★★ `staleClicks` 会被 `read_page` 清零 ⇒ 「连点 3 次无变化」只在**连续、中间不夹动作**时生效，真实节奏碰不到
- ★★ **工具超时 ≠ 动作没执行**：`CDP_TIMEOUT_MS=8s` 先到会记成失败，但点击**确实发生**（`TOOL_OUTCOME_UNKNOWN` 真机证据）
- 假模型 `LASTSTEP` 按 goal 字符串记忆 ⇒ 多轮实验**每轮 goal 必须不同**
- `DriveResult.risk?: 'pay' | 'sensitive'`（shared）；`driver.ts` 点/填/填表三处带出；`agent.ts` 在 `if (res.ok)` **之前**拦：pay → `ask`+`paused`+求助卡；sensitive → `sensitiveNotice`+`paused`
- 分级：一级 AI 全权；二级申报+用户亲自输（密码/验证码/支付信息/身份证）；三级申报+用户亲自点（付款/下单/提交订单）；登录墙=申报
- 词表探针 `scripts/verify/risk-guard/_wordlist-probe.mjs` 26 条（9 付款按钮挡、8 注册流程按钮放行、5 敏感输入挡、4 普通输入放行）
- 待真机验收：① AI 真去点「提交订单」→ 没点 + 会话有申报 + paused

## 十、杂项（最常复发；其余见 `TOOLBOX.md`）
- ★★ **本机可能有另一个会话同时改这个仓库** ⇒ 提交/打包/换装前先 `git status` 分清归属
- ★★★ 测渲染/性能前**先确认窗口真可见**：被遮挡 ⇒ `hidden=true`、rAF 60→1/s，帧率一律不可用
- ★★ **Edit 会「报成功但文件没变」** ⇒ 改完关键常量必须 grep 复查
- **行尾**：`*.ts/tsx/css` = CRLF；`*.py`/`*.mjs` = LF
- ⏳ 待办：清空回收站（≈880MB），观察期 ≥2 天
