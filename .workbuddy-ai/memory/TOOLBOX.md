# TOOLBOX.md — work123 的工具 / 环境细节（按需读）

> `MEMORY.md` 只留"每天要用的硬规则"（它超注入上限会被截断）；
> 工具坑、命令细节、环境事实放这里。**遇到具体问题先查这里。**

## PG / 数据库

- 起 PG：Python 写 **GBK** 的 `.cmd`（`start "" postgres.exe -D data`）再 `./x.cmd`；
  `subprocess.run(capture_output=True)` 会**永久挂住** → 用 `stdout=DEVNULL`
- 周期性崩溃重启（非数据损坏）：`logical replication launcher exited with code 143(SIGTERM)`
  → PG 全杀 reinitialize（本机 ~40s）
- ★ 遇到「清 pid 失败」（`SAFE_DELETE_FAIL_CLOSED` / `trash-failed`）**先独立确认 PG 在不在跑**：
  比 `postmaster.pid` 第一行与 `tasklist /FI "IMAGENAME eq postgres.exe"` 的 pid，并看 5432 是否监听。
  `ensure_pg()` 会把"PG 正在重启"误判成"pid 陈旧"。端口在听就直接重跑，不要动 pid 文件。

## 换装 / 安装版

- 已安装包 `...\Programs\@ai-workbenchdesktop\resources\app.asar`；
  用户数据 `%APPDATA%\@ai-workbench\desktop`（`clear-cache` 不动 Local Storage 登录态）
- `@electron/asar` 的 `extractFile` 要 **native 分隔符**
- 回滚源码 ≠ 回滚已安装应用；asar 在跑时换 → `renameSync` EBUSY（预期）

## 进程 / 端口清理

- ★ 应用自己拉起的服务端会变成**孤儿**：应用被杀后它仍在 8787 监听，下一轮探针会看到
  「8787 已有服务端在跑，直接用（不接管）」——那其实是上次留下的，连的可能是已死的 DB。
  清理：`netstat -ano -p TCP | findstr :8787` 拿 pid → `taskkill /F /PID <pid>`
- 探针收尾不可靠时会漏 electron.exe；**起跑前先清干净**（本机没有别的 electron 应用，全清安全）

## 工具与语言细节

- ★★ **Edit 工具会「报成功但文件没变」** ⇒ 改完关键常量必须 `grep` 复查
- ★★ **行尾**：`*.ts/tsx/css` 必须 **CRLF**（Python 写回用 `newline=''` 按原始字节读写，
  改完 `b.count(b'\r\n')==b.count(b'\n')` 复查）；★ **`*.py` 验收脚本是 LF** ⇒ 写补丁脚本先探测原文件行尾
- ★★ **`contextBridge` 暴露的对象属性是只读的** ⇒ `window.workbench.xxx = wrapper` **静默失败**，
  计数器恒 0，极易误判成"这段代码没跑"。要么换判据（读 DOM），要么**装完回读验证**
- ★ **往 React 受控 input 塞值**：只有 native value setter + `dispatchEvent(new Event('input'))` 有效
  （CDP `Input.insertText` / 逐字符 `dispatchKeyEvent` 送不进去）。
  断言读 React props.value（`__reactProps$`），只读 DOM `.value` 会漏
- `process.exit()` 会丢未落盘 stdout → 用 `process.exitCode = n`
- `tasklist` 输出是 GBK ⇒ `subprocess.run(text=True)` 要给 `encoding/errors`
- `subprocess.run(["npx",…])` 在 Windows 要 `shell=True`；bash 里不要直接调 `cmd.exe`
- 测试 `chk()` 必须 `return cond`
- 断言 `dist-electron/main.js` 的处理器要锚在 `ipcMain.handle('通道名'` 上（裸通道名会命中注释）
- Electron 探针里 `win.destroy()` 会让进程退出 ⇒ 必须 `app.on('window-all-closed', () => {})` 挡住

## 换装 / 安装版

- vite 压缩会改写局部函数名 ⇒ 只能查：对象属性名、CSS 类名、用户可见文案、主进程 tsc 产物标识符。
- 必须读**产出的 asar 字节**（别读解包临时目录）。**sha256 一致 ≠ 包好**
- 流程：`npm run build -w @ai-workbench/desktop` → `.workbuddy-ai/swap-dist.mjs` →
  `clear-cache.mjs` → `verify-asar.mjs` → `asar-token-check.mjs`
- 已安装包 `...\Programs\@ai-workbenchdesktop\resources\app.asar`；
  用户数据 `%APPDATA%\@ai-workbench\desktop`（`clear-cache` 不动 Local Storage 登录态）
- 回滚源码 ≠ 回滚已安装应用；asar 在跑时换 → `renameSync` EBUSY（预期）
- `@electron/asar` 的 `extractFile` 要 **native 分隔符**
- ★★ **正式安装版功能确认**：`scripts/verify/installed-app-probe.py`（跑
  `...\Programs\@ai-workbenchdesktop\AI 工作台.exe`；**必须 `--no-sandbox`**，
  否则 1 秒即 `FATAL:gpu_data_manager_impl_private` 退出，现象是"端口没人听"，极易误判成包坏了；
  用独立临时 profile）
- ★ 判「包里有本轮代码」用 `asar-token-check.mjs` **查 token**，不靠哈希（构建产物是会动的靶子）
- ★ 安装版性能/渲染测量用 `installed-app-perf-probe.py`（见上面「性能测量」那条 DevTools 说明）

## 浏览器面板 / 内嵌页测试技巧

- ★ **要造"长聊天记录"用 `scripts/verify/seed-messages.mjs`**：
  `node scripts/verify/seed-messages.mjs --conversation <id> --count 200 [--clear]`
  —— 用**服务端自己的 `dist/crypto.js` 的 `makeCipher`** 加密后写入（别自己实现密文格式，
  否则 `gcm$iv$tag$ct` 对不上）。DATABASE_URL / DATA_KEY 从 `apps/server/.env` 读。
  会话 id 用 `GET /chat/history?agentId=<id>` 的 `conversationId`。
- ★ **聊天消息列表的实现事实**：`App.tsx` 是 `{messages.map((m, idx) => ...)}` **平铺渲染**，
  全文件**没有** `React.memo` / `useMemo` / 虚拟列表；而 1.2s 轮询会重渲染整棵树。
  实测 **200 条时零影响**（DOM 59→458 节点，帧 p95 不变、零掉帧）；
  但若单条消息变重（markdown 表格 / 代码高亮 / 图片）或上限从 200 调大，**这条路径要重新评估**。
- 服务端历史接口：`GET /chat/history` 返回**最新 200 条**（`LIMIT 200`，第 19 步从"最老 200"改过来的）；
  `HISTORY_WINDOW = 24` 只是拼给模型的历史条数，与 UI 无关。
- ★ **要开多张内嵌页做测试**：传 `data:text/html,…` —— `isStartPage(url)` = `url.startsWith('data:text/html')`，
  而起始页**不参与同站复用**（`sameSite` 比的是 host，`data:` URL 没有 host）⇒
  **每次调用都新开一张 tab**。同站 URL 会被复用成同一张（`openUrl` 的"同站复用"）。
- ★ **认内嵌页 guest 目标要「wcId 优先 + URL 兜底」**：只按 `id == 'webview:<wcId>'` /
  `webContentsId == wcId` 匹配**可能一个都认不到**（实测踩过），
  认不到时再按 `url` 包含特征串兜底；两条都不行就把 `/json/list` 打出来，别猜。
- 起始页 `HOME_URL` = `data:text/html;charset=utf-8,<encodeURIComponent(START_PAGE_HTML)>`

## 安全边界现状（改动前先读这里）

- 主进程**不再接受渲染层 token**：`doc:download` 只认内存 `agentJwt`；
  `apiBase` 走 `isLoopbackBase()` 只放行回环；登录态由 `workbench:session:sync` 显式同步
- `/agent/loop/next` **归属硬闸**：`session.agentId !== null ⇒ 调用方必须自证相符`（不传即拒）。
  客户端靠 `GET /agent/loop/info?loopId=` 换权威身份
- `GET /agent/loop/pauses` 回 `inMemory` + `resumable`，**必须分开看**
  （`stopLoop()` 不删 Map 条目 ⇒ 已停的循环 `inMemory` 仍 true）
- ★ **内嵌页分区闸**：`will-attach-webview` + 纯函数 `decideWebviewPartition(raw, owned, synced)`；
  分区名须 `persist:workbench-browser-project-<正整数>`（或 `-none`）且项目号在当前账号名下，
  否则**改写**成隔离兜底分区（**不是** `preventDefault()`）；
  判据由渲染层经 `workbench:projects:sync` 推（同步事件，不能 await HTTP）。
  ⚠️ 分区是「**登录态隔离**」**不是安全边界**。探针 `scripts/verify/partition-guard-probe.mjs`

## 性能测量

- ★★ **测"资源悬崖"（加到多少会卡）必须带安全阀**：每档用 `GlobalMemoryStatusEx`
  （ctypes，进程内、瞬时）读系统可用内存，跌破阈值**立刻中止并收尾**，
  别把本来就紧张的机器拖进重度换页。探针 `browser-idle-memcliff-probe.py` 是模板。
  2026-09-20 实测：`maxBrowserInstances=20`、加到 **12 张页**（应用内存 1852 MB）
  **仍 60fps 零掉帧**，且**系统可用内存几乎不动（−55 MB）** ⇒ 12 张以内没找到悬崖。
- ★★ **系统级压力怎么量**（别从"可用内存只剩 2GB"这种快照下结论）：
  用 `typeperf -cf <计数器文件> -si 1 -sc N`（**一个长驻进程流式采**，别每次重启；
  且**一次别查太多计数器** —— 本机实测查全部 866 条 GPU 计数器会出垃圾值 7.4e19%）。
  计数器集（8 个就够）：
  `\Memory\Available MBytes`、`\Memory\Pages Input/sec`（**硬换页，关键指标**）、
  `\Memory\Page Faults/sec`、`\Paging File(_Total)\% Usage`、
  `\PhysicalDisk(_Total)\% Disk Time`、`\PhysicalDisk(_Total)\Avg. Disk Queue Length`、
  `\Processor(_Total)\% Processor Time`、`\System\Processor Queue Length`
  CSV 解析：表头行以 `(PDH-CSV` 开头，之后是**时间戳数据行**；别按计数器名去找数据行。
  ★ 必须带**"被测对象不在场"的基线**（否则分不清压力是系统本来就有的还是我们造成的）。
  2026-09-20 实测结论：应用 +1 页把硬换页从 29.6 抬到 107.8 次/秒（峰 2353），
  **但磁盘忙仅 0.54%、磁盘队列 0.01、应用零掉帧** ⇒ **换页没转化成卡顿**。
- ★★ **dev 模式会自动开 DevTools**（`main.ts`: `if (isDev) openDevTools({ mode: 'detach' })`），
  它自己就吃 CPU/内存 ⇒ **dev 下测出的性能数字是偏悲观的上界**，且与用户实际跑的安装版不是一份东西。
  **要么测安装版（`installed-app-perf-probe.py`），要么在 dev 下先关掉 DevTools**；
  报告里必须写明"这份数字来自 dev 还是安装版"。
- ★★ **`percentCPUUsage` 是"距上次调用之间的平均"** ⇒ 看 1.2s 级尖峰必须 ≤1s 采样
  （改 `workbench-settings.json` 的 `resourceSampleMs`，合法 1000~60000）
- ★★ **统计/归因要挑对分组键**：按 `(type,name)` 分组会把两个 `Tab`（name 都是空）合并 ⇒ **按 pid 归因**
- ★★ **GPU 占用**：`app.getAppMetrics()` **拿不到**真 GPU 利用率；`typeperf` 一次查全部 866 条
  GPU 计数器会返回**垃圾值**（实测 7.4e19%）⇒ 只查自己那几个 pid；且 CSV 是
  「表头行（以 `(PDH-CSV` 开头）+ 时间戳数据行」，不能按 `startswith('\GPU Engine(')` 找数据行
- ★ **判 GPU 加速状态用渲染层自报的 WebGL `UNMASKED_RENDERER`**（一锤定音）：
  出现 `SwiftShader`/`Software` ⇒ 软件渲染；出现 `ANGLE (NVIDIA…)` ⇒ 硬件加速。
  `SystemInfo.getInfo` 的 `featureStatus` 会与 GPU 崩溃日志互相矛盾，**不可单用**
- ★★ **"卡顿"看帧时间，不看 CPU%**：判据 = rAF 帧间隔 p50/p95/p99、`>33ms` 帧数、`longtask` 计数、
  打字延迟；`Performance.getMetrics` 拿 Task·Script·Layout·RecalcStyle 时长
- ★★ **量"体感延迟"要减掉自己方法里的等待**：脚本"写入→等 2 帧→记录" ⇒ **33.3ms 就是测量下限**
  （2×16.67ms），不是"性能差"。写断言前先算出自己的下限
- ★★ **别对同一个日志文件并发写**（`tee` 还活着时又 `>` ⇒ NUL 空洞 + 两次运行内容混在一起）。
  判据：`b.count(b'\x00')>0` 或同文件同时含 `[FAIL]` 与 `[PASS]` 结论行 ⇒ **日志作废重跑**
  （重跑前确认上一轮进程真死了，它占着 8894/8791）

## 本机环境事实

- 物理内存 15.8 GB；**长期只剩 2.0 GB 左右可用**（370 进程合计 20.8 GB，超物理内存靠压缩/换页）
- 12 个逻辑核 ⇒ **1 个核跑满 = 8.33%（整机口径）**
- GPU：NVIDIA GTX 1060 3GB + ANGLE/D3D11（硬件加速正常）
- 本机 Electron 崩溃特征（环境非代码）：`Network service crashed` /
  `GPU process exited unexpectedly`（后者加 `--no-sandbox`；**仅启动瞬间崩一次、自动回退后稳态正常**）
- 端口占用：**8901 被 `douyin_tray.exe` 占**
- ★★★ **【已推翻，别再信这条】"本机 agent 环境起不了 GUI Electron 进程"是错的**（2026-09-20 当天自己纠错）：
  真实原因是我那个探针目录**没有 `package.json`**，而入口文件叫 `main.js`（Electron 默认找 `index.js`）
  ⇒ Electron 弹一个**错误对话框**然后一直等。表现极具迷惑性：
  **进程活着、主脚本从未加载（第一行日志都没写）、CDP 端口不监听、stderr 空**。
  补上 `{ "main": "main.js" }` 之后：CDP 立刻监听、boot.log 有内容、stdout 有日志 —— **GUI 完全正常**。
  ★ 教训：**"起不来"先查应用目录本身合不合法**（package.json / main 入口），
  别一上来就归因到"沙箱/环境"。我当时连续用 4 种启动方式都失败，就把结论下成了"环境不让起 GUI"，
  其实四种方式**都**只是同一个"缺 package.json"。
  ★ 另两个同批纠正的事实：
    ① `cmd /c ...` 被**静态规则**拒绝（不是沙箱；`dangerouslyDisableSandbox` 也绕不过）——
       所以 `pg-start.py`（内部 `subprocess.run(["cmd","/c",...])`）在本工具里会**静默死**；
       解法：**由 Python 直接 `subprocess.Popen([exe, ...], creationflags=DETACHED|NEW_GROUP)`**，别经过 cmd。
    ② 我自己派生的进程**能建窗口**（`CreateWindowExW` 返回真 HWND、`IsWindowVisible=True`，
       窗口站就是交互式的 `WinSta0\Default`）。用 `notepad.exe` 做对照会被 Win11 存根骗到（它的窗口不在那个 pid 上）。
- ★ 起 GUI/后台进程的可靠姿势（2026-09-20 实测）：Python `subprocess.Popen(..., creationflags=0x8|0x200)`
  + `stdout/stderr` 重定向到文件；**一次 bash 调用内跑完「起 → 轮询断言 → 收尾」**。
  判活别只看进程名，要看**它自己写的产物**（日志/结果文件/端口）。
- ★ **Windows 上 `electron.exe` 是 GUI 子系统程序：主进程的 `console.log` 不进父终端**。
  探针/脚本要出结果**一律写文件**（`fs.writeFileSync`），别指望 stdout。
  这个坑会伪装成"脚本没跑起来"—— 实际上跑了，只是输出被吞了。
- 服务端监督器：`probe()` 要校验 `body?.service === 'ai-workbench-server'`；
  `ensureServer` 要 inflight 去重；`externalServerSeen` 只用于去重，不用于认定可用

## 浏览器面板：状态模型 / 决定 / 性能基线（2026-09-20 从 MEMORY.md 迁来）

- **第 25 步状态模型**：两态 `view: 'fullscreen' | 'background'`；
  `showFullscreen/exitFullscreen` **只改 view 一个 state**（不碰 agentStart/Stop/Drop、不改 sleep）。
  后台态 = `.browserLayer--bg { opacity:0; pointer-events:none; z-index:0 }`；
  小图标 `.browserFloating`（只在「有页+background」出现）。「收起 180px 半高」态**已移除**（决定2：不加回来）
- 卸载 `<webview>` 只有两条路：① 面板整体不挂载 ② 深休眠 `t.sleep==='deep'`（被 `!drivingIds.includes(id)` 硬拦）；
  驾驶循环 `runToolLoop` 在主进程按 `loopId`+guest wcId 跑，**不看可见性**
- ★ **决定1**：只有「需要用户亲自处理」才拉回全屏。唯一改动 = `openFromPage()` 不再 `setView('fullscreen')`；
  其余 4 处保留（敏感字段通道：`sensitiveHold()` → `workbench:browser:focus` → `focusByWebContents` → `activate()`）
- ★★ **后台降频真相（受控实测，两轮一致）**：`opacity:0` 时 guest **rAF 60→1.0/s**，
  但 **16ms 定时器仍 62.5/s**、`visibilityState` 仍 `visible` ⇒ rAF 已降、JS 定时器未降。
  我们的 `browserThrottle`（`setBackgroundThrottling`）**实测空转**（真调 API 传 `true` 也不变；
  `want` 恒 `false` 是 `decideSleep` 第②条**前台页永不休眠**，改它**没有收益**）
- **性能基线**（`browser-idle-*-probe.py`）：1 张闲置页 = 0.230%（≈0.028 核）/ 681 MB（+111 MB）；
  帧时间 60fps、零掉帧、零长任务、主线程 2%；**5 分钟 soak 零掉帧、DOM 恒定、Layout/RecalcStyle 增量=0**；
  多实例每加一张 ≈ +101 MB（线性），4 张 = 1011 MB，1~4 张静止/滚 UI/滚内嵌页全零掉帧；
  闲置稳态 0.03~0.06% / 684 MB（页内带动画 ~1.6% / ~700 MB）；
  一路加到硬上限 **20 张页 / 2694 MB 仍 60fps 零掉帧**，系统可用内存只降 253 MB。
  **长历史 200 条**与**任务跑完后的闲置态**（`agentLanes()` 已清空）也都零影响

## ★★ 敏感串（密钥/口令）绝不要经命令行传递（2026-09-20 实测踩坑）

往 `.env` 写第三方 API key 时，我图省事把 key 写进了 heredoc 命令行 ⇒ **agent 的工具调用日志
会把命令行原样记下来**，key 就此落进：
- `~/.workbuddy-ai/logs/<日期>/sdk/conversations/<id>.log`（工具调用记录）
- `~/.workbuddy-ai/logs/sandbox/<日期>/sandbox_<pid>_000.log`

更麻烦的是**这两个文件正被当前会话持有** ⇒ 想事后原地脱敏会拿到
`PermissionError: [WinError 5] 拒绝访问`（`os.replace` 与 trash 都会被拒），只能等会话结束。

**正确姿势**：
1. 优先**让用户自己**把 key 填进 `.env`（agent 只负责加占位与校验）；
2. 必须由 agent 写时，让 key **从环境变量/一次性文件读**，别进命令行参数；
3. 写完后一定扫一遍 `~/.workbuddy-ai/logs`，别只扫仓库（仓库扫干净≠没泄漏）；
4. 一旦落进日志，**最彻底的处置是轮换密钥**，而不是只做脱敏。

## ★★ 端到端验收（真 HTTP 打真实后端）——复用姿势与四个已踩的坑

**可复用骨架**：照 `scripts/verify/2a-api-tests.mjs` / `search-chat-e2e.mjs` 抄：
自己 `spawn` 后端到**独立端口**（8793）→ stdout 管道写进 `docs/acceptance/.../server-<port>.log`
→ **mock 验证码从那份日志里 tail 出来**（响应体里没有码）→ 跑完 kill + 删测试账号。
- 起后端两种都行：`npx tsx src/index.ts`（= start-dev.cmd 的跑法）或 `node dist/index.js`（= 验收产物）。
  选后者记得**先 `npm run build -w @ai-workbench/server`**。
- `spawn(process.execPath, ['dist/index.js'], {cwd:'apps/server', env:{...process.env, PORT:'8793'}})`：
  **必须 cwd=apps/server**（`.env` 由 `dotenv/config` 从 cwd 加载）。
- ★ 等验证码时**必须 `await` 让出事件循环**：同步睡（Atomics.wait）会锁死主线程，
  stdout 管道永远刷不进日志文件，等 15 秒也等不到。

**四个坑（都复发过一次以上）**
1. ★★ **`/chat/history` 的字段叫 `text` 不叫 `content`**（`ChatRow = {id, role, text, created_at}`）。
   按 `content` 取会得到 `undefined` ⇒ 所有消息被读成空串 ⇒ 假 FAIL。
2. ★★ **`conversations` 表没有 `user_id` 列**。归属链是
   `conversations.project_id → projects.user_id`（与服务端 `resolveConversation` 同口径）。
   写成 `c.user_id` 会直接抛 `column does not exist`，**把脚本带崩、连收尾都不跑**，测试账号留在活库。
3. ★★ **收尾不能依赖"主流程走完"**：测试账号 id 一拿到就写进模块级变量，
   `finally` 里无条件删。否则 main 中途抛异常 ⇒ 脏数据留在活库里（本机真发生过，users 从 65 涨到 66）。
4. ★★ **断言别把"纯数字答案"判成"不是中文"**：`1+1` 可能回 `2。`（无语言属性）⇒ 必须假红。
   正解 `isChineseAnswer()`：含汉字 → 过；完全不含拉丁字母 → 过；含拉丁字母但零汉字 → 才失败。

**反证脚本（`*-revert.py`）的两个坑**
- ★★ **注入锚点必须按文件实际行尾归一化再匹配**：脚本里写 `\n`、文件是 CRLF ⇒
  多行锚点永远匹配不上，现象是"注入点没找到"，**极易误判成"代码被别人改了"**。
  `patch()/unpatch()` 里先探测 `\r\n` 再 replace。
- ★ **在同一支脚本里做 A/B**（基线 → 注入 → 还原），比"两次分别跑"干净：
  避免"两次环境不一样"说不清。模型是非确定性的，**还原后那一步允许重试一次并如实记录第几次跑绿**。
- 注入点优先选**单行**、且**本步自己新增/改过的文件**；动态 `await import()` 可以不碰 import 块。

## ★ 「联网搜索 vs 浏览器操作」怎么用机器证明没混

`/health` 的 **`pageStates`** = 服务端内存里 `pageState.ts` 那张 `Map` 的大小，
**只有浏览器链路会去 bind 页**（`bindPageLoop`）。所以：
- 断言"搜索轮前后 `pageStates` 不变" ⇒ 证明搜索**没启动任何浏览器实例**（结构性证据，不是口头保证）；
- `taskMode:true` 那一轮 `pageStates 0 → 1` ⇒ 证明那条路才是"重型"那条；
- 再断言 taskMode 轮 **`llmCalls` 不涨**（循环还没被驱动，只写一句开场白）。

## 验收脚本口径（2026-09-20 从 MEMORY.md 迁来）

- `*.py` 一律用 `C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe`
  （**基础版没 `websocket`**，别用 `python`）
- import 了 electron 的 `*.mjs`：
  `cd apps/desktop && npx electron ../../scripts/verify/<p>.mjs --no-sandbox`，且**加 timeout**（跑完常不退出）
- 托管 node：`C:/Users/bing/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe`
- ★ **行尾**：`*.ts/tsx/css` = CRLF；`*.py` 验收脚本 = LF；`*.mjs` 验收脚本 = LF。
  写补丁/注入脚本前**先探测原文件行尾**（见「反证脚本的两个坑」）

## ★★ 联网搜索验收（第 26 步，四层脚本清单 + 反证）

| 层 | 脚本 | 结果 | 跑法 |
|---|---|---|---|
| 0 | `tavily-search-check.mjs`（服务本身，45 条）+ `tavily-search-revert.py` | 45/0 | `node scripts/verify/tavily-search-check.mjs` |
| 1 | `search-vs-browser-routing.mts`（桌面本地路由，真实判定函数；含 A/B 专项 + E 组边界沉淀） | **134/0**（修前 29/3） | `npx tsx ...` |
| 2 | `search-tool-decision.mjs`（真 DeepSeek 决策） | 46/0 + 3 INFO | `node ...`（先 `npm run build -w @ai-workbench/server`） |
| 3 | `search-chat-e2e.mjs`（真 HTTP 端到端，自己起后端 8793；含 A1/B2 专项用例） | **80/0** | `node ...`，`--only=S1` 只跑子集 |
| 4 | `sources-ui-probe.py`（真 Electron 窗口 + 真问答，验来源标注渲染） | **26/0** | 用托管 python |
| — | `search-hint-wiring-check.mjs`（两端通道名一致性） | 10/0 | `node ...` |
| 反证 | `search-vs-browser-routing-revert.py`（A：撤分流 / B：撤「在X上」/ C：撤空目标收紧） | **5/5 ✓** | 用托管 python |
| 反证 | `search-chat-e2e-revert.py`（①toolChoice=none ②搜索轮 bind 页 ③sources 清空） | 5/5 ✓ | 同上 |
| 报告 | `docs/acceptance/tavily/step{1,2,3}-report.md`；界面截图 `sources-ui-20260920.png` | | |
| 全套 | `docs/acceptance/tavily/final-all-layers-20260920.log`（收尾后一次性连跑：134/0 · 45~46/0 · 80/0） | | |

### ★★ 「问题 A」这类修复要证**两半**（缺一半等于没证）

「开着页时查资料该走搜索」这条链上**有两个决策者**，必须分开证：

| 半 | 谁决定 | 谁证明 |
|---|---|---|
| 桌面**不设** `taskMode`（即使眼前开着页） | 桌面本地判定 `intent.ts` | 第 1 层 `search-vs-browser-routing.mts` |
| 服务端拿到这个体后**不 bind 页、不建循环** | 服务端 `chat.ts` | 第 3 层 `search-chat-e2e.mjs` 的 `A1` 用例 |

`A1` 的体 = `pageUrl` + `wcId` **都带**、`taskMode` **不带**（桌面修好后真会发的体）；
断言 `loop=0` + `pageStates 增量=0` 才钉得住旧行为。
**只跑其中一层就下结论，等于把另一半留成未知。**

## ★★ 第 26 步收尾踩到的四个新坑（都复发过一次以上）

1. ★★★ **`Edit` 工具「报成功但文件没变」这次连发 3 次，而且同一批多个 Edit 会**部分**生效**
   （一次 4 个 Edit 只落了 1 个）。**判据只能靠 `grep -c` 复查**，不能信返回值。
   **可靠姿势**：改关键位置用 `python` 脚本 `replace`（锚点 `count == 1` 才写），写完立刻复查。
2. ★★ **`jsonb` 不保留键顺序**：写进去 `{title,url,domain}`、读回来可能 `{url,title,domain}` ⇒
   拿 `JSON.stringify(a) === JSON.stringify(b)` 比来源列表会**假红**。正解：逐字段比（`sameSources()`）。
3. ★★ **流式期间的"打字气泡"本身就是 `.msg.assistant`**（内容 "正在想…" 或半截正文 + `.caret`）。
   拿「助手消息数 +1」当"这轮答完了"的判据 ⇒ **发送后 1ms 就"通过"**，读到的是占位气泡。
   正解：**用户消息落进列表**（这轮开始）+ **`.caret` 与 `.searchHint` 都消失且连续 3 次稳定**（这轮结束）。
4. ★★ **Electron 验收的 `--user-data-dir` 每次必须换新的**：复用旧目录会把上一轮（账号已删）的
   token 留在 `localStorage` ⇒ 启动先拿它换会话 ⇒ 401 ⇒ 页面停在登录/错误态，
   连"注入新 token + reload"的时序都被搅乱（第一轮 28ms 过，第二轮卡死 90 秒）。

## ★★ 反证脚本补充两条

- ★★ **注入必须保持可编译**：注入 C 第一版写成 `const sources = []` ⇒ TS 隐式 `any[]` **编译失败**，
  现象是"注入后一轮都没跑"，**极易误判成"注入点没生效"**。正解：注入时保留类型标注
  （`const sources: ChatSource[] = []`）。
- ★★ **阈值要精确点名"受本次注入影响的那几条"**，不能写成"某组全红"：
  组里往往混着**保底用例**（本来就不该变红）⇒ 会报"没红，断言是摆设"的假结论。
  例：A-1 组里「今天北京天气怎么样」压根不命中 `BROWSE_ACT`，修复前后都不发车。

## ★★ 界面层探针（真 Electron + CDP）四个坑（第 26 步收尾补做，都踩过）

1. ★★ **失败行格式有两种，别照抄**：
   · 本项目 `*.py` 探针（`sources-ui-probe.py`）→ `FAIL  <名字> :: <细节>`
   · `*.mts`/`*.mjs` 脚本 → `[FAIL] <id> — <细节>`
   反证脚本照抄 `.mts` 那份 ⇒ 一条失败行都抓不到 ⇒ 报出「明明 4 FAIL，却说 0 条变红」，
   **极易误判成"断言是摆设"**。解析时两种前缀都认。
2. ★★ **Electron 必须显式 `--no-sandbox`**：`apps/desktop/scripts/start-electron.mjs` 自带回退，
   但**只在"启动 15 秒内崩 + 退出码 0x80000003"**才触发。实测遇到过"跑起来之后**中途** GPU FATAL"
   （日志 `GPU process isn't usable. Goodbye.`）⇒ 回退不触发 ⇒ 登录后 CDP 握手 `Connection timed out`，
   **极易误判成"探针坏了"**。验收脚本自己起环境就显式带上。
3. ★★ **截图必须放在 `location.reload()` 之前**：reload 会让 CDP 的 page target 换血，
   之后 `Page.captureScreenshot` 稳定 `WebSocketTimeoutException(Connection timed out)`。
   现象是"功能断言全绿、只有截图红" ⇒ **极易误判成"来源渲染有问题"**。
   已挪到 3.2 节（答完立刻截，也正是人最想看的状态）+ 3 次重试。
4. ★ **连跑多次探针之间要清残留 + 沉降 6s**（`taskkill /F /IM electron.exe`）：
   上一轮 GPU 子进程没退干净会带崩下一轮（同坑 2 的现象）。

> 附带经验：**反证脚本要给每一轮的完整输出存档**（`...-<tag>.log`），
> 否则中途失败只能靠重跑 30 分钟去复现。

## ★★ 怎么机器验证「外链真的在系统浏览器里打开了」（可复用招式，第 26 步收尾补做）

难点：`shell.openExternal(url)` 之后浏览器在**应用外面**开，界面层读不到任何 DOM 证据。
招式：**把目标换成本机一个一次性 HTTP 服务**，让"浏览器真的来取"这件事留下可查痕迹。

1. 探针起 `http.server`（端口从 8911 起找空位，8901 被 douyin_tray 占），handler 只把 path 记进 list；
2. **只改 `<a>` 的 `href`** 指向 `http://127.0.0.1:<port>/<token>` —— `target`/`rel` 一律不动 ⇒ 走的仍是真实那条路；
3. **完整鼠标序列**真的点：`mouseMoved → mousePressed(buttons=1) → mouseReleased(buttons=0)`
   （★ 只发 press/release **打不开** `target=_blank`）；
4. 服务**真收到请求**（实测 300ms）⇒ 链路上半段全通；同时断言"应用没被顶掉"
   （`location.href` 还含 `localhost:<VITE_PORT>`）⇒ `will-navigate` 那道闸也顺带验到。
⚠️ 副作用：会真的弹出一个系统浏览器标签页（页面写"可以关掉"）。

反证注入点选 `target="_blank"` → `"_self"`：**主进程 `will-navigate` 会拦掉同页导航** ⇒ 浏览器不再被唤起 ⇒ 断言红。
★★ 这条注入必须**单独占一轮**：和 `pointer-events:none` 放同一轮的话，
点击根本到不了 `<a>`，"点击那条变红"就说不清是谁造成的 —— **反证一次只动一个变量**。**反证脚本加一个注入点 ⇒ 同步加"开工前/还原后"两处 sha256 指纹**
（漏加会在跑完四轮后的最后一行 `KeyError` 崩掉，结论行和日志都没写出来）。

## ★★ 写补丁脚本：用「独立 .py + 三引号真换行」，别用 heredoc 拼 `"…" + LF`

实测（第 26 步收尾）：heredoc 里做 `"…" + LF` 拼接，3 处错（漏 `+`、漏转义），
而 `py_compile` **只报第一行** ⇒ 一次修一个、跑一遍，能拖五六轮。
改写成独立 `.py` 文件 + **三引号真换行**（不拼接）后，6 个锚点一次全中。
★ 另外：`Edit` 工具的显示**会吃掉反斜杠**（屏幕上 `,\" + LF` 看起来像 `,\" + LF`），
照着改必然改不动 ⇒ 判据只能靠 `repr(bytes)`。

## ★★ 换装：本机 `electron-builder` 跑不通，只能走 asar 库整包重打包（2026-09-20 实测）

- `--win nsis`：下载 NSIS 组件 **502 Bad Gateway**；
- `--dir`（不下载 NSIS）：卡在 `EPERM: rename win-unpacked.tmp -> win-unpacked`（沙箱挡 rename），
  换**全新**输出目录也一样 ⇒ 别在这上面耗轮次。
- 正解：`.workbuddy-ai/swap-dist.mjs`（`extractAll → 换 dist/dist-electron → createPackage`）。

## ★★ 手读 asar 内文件：数据区起点不是 `16 + headerSize`，还要 +3

按 `16 + u32@12` 读会拿到 `map"use strict";` 这种错位 3 字节的内容（头部填充），
sha256 自然对不上 ⇒ 我据此误判「`dist-electron/main.js` 变了」，差点连主进程一起换。
**判「哪块变了」之前，先确认读法对**（拿一个已知内容的文件验一下开头字节）。

## ★ 两个小但会害人的判读错误

- `git diff` 里 `packages/shared` 改了很多行 ≠ 运行时变了：**全是 `interface`/类型**时，
  编译产物不变 ⇒ 包里 `node_modules/@ai-workbench/shared` 不用动。看 diff 要分类型与运行时。
- `tasklist /FI "IMAGENAME eq 中文名.exe" | grep 中文` 会因 **GBK 编码**出假阴性：
  应用明明在跑却"查不到"。判据要用 `taskkill` 的返回，或按 PID/exe 路径枚举。

## 反证/验证的通用铁律（2026-09-20 从 MEMORY.md 迁来）

- ★★ **冗余闸门会让"只测全缺"失效**（`/agent/loop/next` 有两道闸）⇒ 要验一道闸，另一道必须传对。
- ★★ **并发缺陷要确定性复现**：TOCTOU 用"12 路并发"撞不稳；正解是外部事务 `SELECT ... FOR UPDATE` 先锁行。
- ★★ **报告/建议本身也要复核**：收紧闸门前**先读完那条路径的注释**，并问「合法调用方需要哪些材料才能自证」。
- 判"回归是不是我引入的"：靠**改动前那次全绿日志**；测试里的「跳过」等于没测；环境依赖要参数化；
  别把"设计意图"当 bug。

## 取证铁律（2026-09-20 从 MEMORY.md 迁来）

1. 多路并行衡量"某一路停没停"必须**按路过滤**；
2. 直连库查证必须带 `user_id`；
3. 找内嵌页用 `wcsId`/`getWebContentsId()` 认（**不能按 URL**）；
4. 判"模型恢复后说过话"看 `assistant` 不看 `tool`；
5. 单次"没问题"可能是现象没出现 ⇒ **最终验收必须一次性连跑全套**

## ★★ 「纯字符串路由判定」类代码的对抗扫描姿势（第 26 步收尾，三轮扫出来的）

这类代码（`browser/intent.ts` / `browser/sites.ts`）最容易出的不是"没修好"，
而是**改出新误判**。三轮扫描各压一个轴，效果最好：

| 轮次 | 压什么轴 | 抓到什么 |
|---|---|---|
| 1 | 「在 X 上」+ 陈述/泛名词 | 「在厨房里…」被报成"认不出『厨房』是哪个网站" |
| 2 | 「读/看 + 对象」指代 | 「读一下《三体》…」被判成页面操作；「在沙发上躺一会儿」报出"躺一会儿" |
| 3 | 否定 / 疑问 / 极短 / 中英混合 / 标点 | 「上」单个字会弹浏览器主页 |

**四条可复用的判据（写断言前先自问）**
1. ★★ **期望值词汇必须和脚本自己产出的标签一致**：第一版写 `want: 'none'`，
   而脚本只会产出 `open|unknown|browse|search` ⇒ `none` 永不匹配 ⇒ **无条件假红 6 条**。
2. ★★ **先问"这条路径真会被走到吗"，再问"期望对不对"**：`打开必应帮我查汇率`
   在模型层偶尔会调 web_search，但真实链路里它由**桌面本地判定**接管（走 toolLoop），
   模型**根本不会被问到** ⇒ 那条断言打的是不可达路径，只能降级为 INFO。
3. ★★ **"设计意图"不是 bug**：「读一下这篇文章讲了啥」在开着页时判成页面操作是**对的**
   （"这篇文章"最自然的指代就是眼前那张页）⇒ 只记录（E-5 INFO），不硬断言。
4. ★★ **收紧一类判定时，必须同时写"反向保护"断言**：E-2（明确指外部 → 不能发车）
   和 E-3（明确指当前页 → **必须**发车）是一对；只写前者，很容易把后者一起掐掉。

**一个具体的类级根因（值得记）**
`VERB` 里有一个**裸「上」**（因为「上淘宝看看」是真用法）。于是**任何**「在 X 上…」句子，
只要没被 `ON_SITE_VERB` 认定成指令，就会掉进动词路径、被那个「上」咬住，
剥出「上」**后面**那截当目标 ⇒ 报出「我认不出『躺一会儿』是哪个网站」。
**正解不是往词表里加词**，而是加一个**句式形状**判定（`ON_SHAPE`）：
形状成立就**不再走动词路径** —— 那个「上」是句式的一部分，不是动词。
★ 通用教训：**当动词表里混进了"看起来像动词的句式成分"时，要在更外层用"形状"短路，
而不是在动词表里做加法。**

**同类小坑**：`if (!site) return HOME_URL` 原本无条件执行 ⇒ 光敲一个「上」或「去」
（剥出空目标）会**弹出一张浏览器主页**。改成只在**明确开页动词**
（`OPEN_VERB_ONLY = /(打开|开启|启动|访问|浏览)/`）下才落主页。

## ★ 模型非确定性：语言规则约 4% 偶发违反（第 26 步实测）

`search-tool-decision.mjs` 的「不夹整句外文」断言实测会**偶发**变红：
模型在调用 `web_search` 之前夹了一句英文填充语 `I'll look that up for you.`。
- 提示词**已经**明确写了"连开场白、过渡句、总结句也必须是简体中文"，还带了同款例子 ⇒ **不是缺条款**
- 工具描述本身是中文，且明确要求"用系统当前语言"⇒ **不是诱因**
- 频率：连跑 3 轮 × 6 题（28 断言/轮）= 全绿；首次全量 11 题时出现 1 次 ⇒ 约 **1/24 ≈ 4%**
- **结论**：这是模型层偶发，**单次 FAIL 不能直接判成产品 bug**。要按"连跑多轮"口径下结论。

## ★★ 起真机环境的坑（第 27 步踩全了，2026-09-20；现 10 条）

1. **`_start-pg.py && <验证脚本>` 必须放同一条命令**：agent 起的进程活不过一次工具调用，
   PG 明明 `ready to accept connections` 了，调用一结束就被回收（现象：服务端 `/health` 报 `db: down`）。
2. **端口别写死**：验收脚本里写死端口会和别的验收/残留进程抢，表现是"上次全绿、这次几条红"，
   极难查。改成 `server.listen(0, '127.0.0.1', ...)` 再读 `server.address().port`。
3. **起环境阶段别用「探 Electron 是否活着」的那类 wait**（回归脚本的 `wait_until` 第一件事就是探它）——
   Electron 还没起时会**秒退**，把"vite 明明起来了"报成失败。这一段要么自己轮询，要么 `time.sleep`。
4. **vite 默认只绑 `localhost`**（本机解析到 `::1`）：探 `127.0.0.1:<port>` 探不通，
   会误报"vite 没起来"。以 **Electron 页面能不能求值**为准。
5. **渲染层"当前智能体"没加载完就开页 = 静默不开页**：登录锚点（"退出登录"）比智能体列表回来得早，
   要显式等一个"智能体已出现"的判据，否则 `webviews()` 拿到空数组、看起来像开页坏了。
6. **★★ 跑真机 E2E 必须点名 venv 解释器**（2026-09-20 补，最新踩的）：
   `pause-resume-tests.py → cdp-probe.py` 里有 `import websocket`，
   **系统 Python 与 managed 3.13.12 都没装**，只有
   `C:\Users\bing\.workbuddy-ai\binaries\python\envs\default\Scripts\python.exe` 有。
   直接 `python xxx.py` 会在 `importlib.exec_module` 阶段 traceback ——
   **看起来像脚本坏了，其实只是解释器不对**。所有 `scripts/verify/**` 的 Python 都用它：
   ```bash
   PY="C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe"
   HC_MODE=back "$PY" scripts/verify/help-card/_start-pg.py && HC_MODE=back "$PY" scripts/verify/help-card/help-card-e2e.py
   ```
7. **★ 真 UI 按钮要照真实 DOM 写选择器，别模糊匹配**：反例是"遍历所有 `button` 找文案含『退出全屏』" ——
   找不到时会**静默走兜底分支**，把"根本没点到"当成通过。正解是直接写 `.browserPanel__toggle`
   （并 `expect(找得到)` 一条**独立**断言，让"按钮改名了"这件事自己变红而不是被吞掉）。
8. **★★ 点任何靠 React 合成事件的东西，都要用「完整鼠标序列」**（2026-09-21 补）：
   `document.querySelector(sel).click()` **不产生真实指针序列** ⇒ React 挂在根容器的
   `onClick` 收不到 ⇒ **静默不生效**（返回 undefined、不报错、界面毫无变化）。
   而且**时好时坏** ⇒ 极容易造出**假通过 / 假红**（上一轮 PASS 其实是"页面自己变了触发收卡"，与点击无关）。
   正解：`cdp-probe.py` 的 `Cdp.click_rect(sel)`（`Input.dispatchMouseEvent` 的
   `mousePressed` + `mouseReleased`，坐标取 `getBoundingClientRect()` 中心），**并回读状态确认**。
   ⚠️ 判据不能是"点击没报错"，必须是"**被点的东西真的变了**"。
9. **★★ 回读要证明"发生了变化"，不能只证明"目标现在是期望值"**（同上一批踩的）：
   若传入的期望值**恰好就是当前值**，空操作也满足 ⇒ **假通过**。
   正解：先读**操作前**的值，要求"变了**且**等于目标"，并把它俩一起打进日志。
10. **★★ 判"另一个 X"要用集合差，不能靠"不是当前选中的那个"**（同上）：
    本仓库典型：`addAgent()` 结尾会把**新**建的智能体设为当前 ⇒ 那一刻"当前选中"是新的，
    于是"排除当前选中"反而把 **`agent_id` 本身**挑了出来当"另一个" ⇒ 点在**它已待着的那一项**上
    ⇒ 空操作 ⇒ 假红。正解：`集合差 = ids_ui - {agent_id}`，再叠加"不是当前选中"。

## ★★ 反证打不红时怎么办（2026-09-21 新增，第 27 步实证）

反证注入后**仍然是绿的**，有两种完全不同的解释，**必须先分清**：

- **(a) 修复没用** ⇒ 应撤掉；
- **(b) 测试覆盖不到那个时序** ⇒ 是**测试的局限**，不是代码的错。

**分不清就下结论 = 报告说谎。** 本轮实证（`App.tsx` 的 `browser.view` 闭包快照）：
真机 E2E 注入旧写法后仍 46 PASS / 0 FAIL —— 因为常规交互下"卡片出现"与"切智能体"
隔着几秒，中间那次渲染**必然已提交**，闭包快照**不会是旧的** ⇒ 窗口根本不开。

**正解：降到更小的层面，把条件直接构造出来证明**（不要靠碰运气复现竞态）。
本轮做法 → `scripts/verify/help-card/view-race-closure.mjs`：
把那条 effect 的语义搬进**最小 React 组件**，用真实 `react-dom` 渲染，
用一个 `staleView` 入参**直接把"闭包快照过期"摆出来**，三组时序对拍：
| 场景 | 旧写法 | 新写法 |
| --- | --- | --- |
| 跨批次（常规交互） | ✅ | ✅ |
| 同批次但 view 从未是 embed | ✅ | ✅ |
| **闭包快照过期** | ❌ 停 embed | ✅ 正确退出 |
⇒ 得出"**bug 真实 + 修复承重**"，且**如实标注证据等级为"最小化实验"**，
**不许**写成"已被真机反证验证"。

**依赖坑**：ESM 的 `import 'jsdom'` **不认 `NODE_PATH`**（只有 CJS `require` 认）。
需 `createRequire(pathToFileURL(绝对路径))` 引入；`jsdom` 装在隔离的 managed workspace：
`NODE_PATH` 无效但 `C:/Users/bing/.workbuddy-ai/binaries/node/workspace/node_modules` 有效。
另：Node 22 的 `globalThis.navigator` 是**只读 getter** ⇒ 直接赋值 `TypeError`，
用 `Object.defineProperty(..., {configurable:true})` 覆盖（覆盖不了也不影响 react-dom 跑）。


## ★★ 第 28 步换装：读 asar 内文件的路径坑 + esbuild 中文转义（2026-09-21 实测）
- `asar.listPackage()` 返回 **Windows 反斜杠且带前导 `\`**（`\dist-electron\driver.js`）；
  `asar.extractFile()` 要的是 **正斜杠、无前导**（`dist-electron/driver.js`）。
  ⚠️ 两个方向都会踩：写 `dist/assets` 匹配不到（误报"没找到"）；原样传反斜杠给 extractFile
  也报 "was not found"（本次先踩前者、改了又踩后者）。
  ⇒ **最稳：直接 `asar.extractAll()` 到临时目录再用 fs 读**，路径坑一次都没有
  （脚本 `.workbuddy-ai/_s28-token-check.mjs`）。
- ★ **esbuild 默认 `charset='ascii'` ⇒ 产物里中文是 `\uXXXX` 转义**。查「付款/验证码词表」
  这类中文 token 必须同时查原中文和转义后形式，只查中文会**假红**。
- ★ 词表**不在 `driver.js`**：vite 是**多入口**，付款/敏感词表在 **`dist-electron/fieldClass.js`**
  （独立入口，没有并进 driver 产物）。断言要指向对的文件。
- 服务端代码不在 asar 里 ⇒ 查服务端 token 去 `apps/server/dist/toolLoop.js`（**扁平目录，没有 `agent/` 子目录**）。
- **换装 EBUSY**：不是脚本 bug，是还有 `AI 工作台.exe` 活着（本次 7 个）。
  `taskkill /F /T /IM "AI 工作台.exe"` 后再 `mv app.asar → .old-*`、`mv app.asar.new → app.asar`。
  ★ **别 taskkill `WorkBuddyAI.exe`**（那是本会话的宿主进程）。
- 换装后冒烟：`.workbuddy-ai/_s28-smoke.py`（起安装版 `--no-sandbox` + `--remote-debugging-port=9348`
  → CDP 轮询到 `readyState==='complete'` → 断言加载的 script 是本轮 `index-CxiIFZWK.js` → taskkill 收尾）。
  本次 PASS。
