# ADR-0001 浏览器控制与 Electron 升级

- 状态:已接受(2026-09-26,用户「阶段 3 开工」指令后,调研+本 ADR 先行,未先改代码)
- 依据纪律:`docs/工程纪律.md` #1(重要决策写 ADR)、#3(先列失败模式)、#4(不熟先查官方)

## 背景

1. **我们的浏览器控制 = 自建 CDP 驱动**。主进程拿 `<webview>` 的 guest `webContents`,挂 `webContents.debugger`(CDP 1.3),用 `Runtime.evaluate` / `Input.dispatchMouseEvent` 等协议命令直接操作内嵌页(`apps/desktop/electron/driver.ts` 头部注释)。明确不引 Playwright/Puppeteer、不下载第二份 Chrome——「驾驶现有内嵌页」是产品红线。
2. **Electron 钉在 `^33.2.1`**(Chromium 130 / Node 20.16)。`docs/智能体协同-总计划.md` 2026-09-24 用户重排时明确:「Electron 升级(33 → 新版)排到阶段 3,现在不动」。本 ADR 即阶段 3 开工的第一步。
3. **版本差距(2026-09-26 官方数据)**:最新稳定 **44.4.5**(Chromium 152.0.7977.130 / Node 24.21.0),我们落后 **11 个 major**(33→44)。Electron 约每 8 周一个 major,35.x 已 EOL(38 发布时的官方通知)。
4. **上游对 `<webview>` 的态度**:官方文档 webview-tag 页有警告——基于 Chromium webview、正经历重大架构变化、「目前建议不要用 webview 标签,考虑 iframe / WebContentsView / 避免嵌入内容」;`BrowserView` 已标记 deprecated,由 `WebContentsView` 取代。但 webview **仍随每个版本发布**,且官方到 37/38 还在持续修 webview 相关崩溃(release notes 多次出现「Fixed a possible crash using the WebView tag and calling focus」)。
5. **我们的红线**(批次 M 用户拍板):除三条有意卸载路径(allTabs 归零 / 深休眠 / key 变化)外,webview 祖先链与节点身份逐字节不变(golden);宿主不许 display:none / 尺寸归零。约束对象是我们自己的 DOM/JSX,但 **Chromium 跨 major 会改 webview 的渲染/导航/事件路由**,所以升级片必须持续用 `verify:shell` 护住。
6. 任务(用户 2026-09-26):调研 browser-use / Stagehand / Nanobrowser 与 Electron 迁移说明 → 写 ADR → 失败模式表 → 选最小安全第一片。

## 备选

### 三家开源项目对比(source-driven,2026-09-26 抓取官方文档+源码)

| | **browser-use** | **Stagehand** | **Nanobrowser** | **自建 CDP 驱动(现状)** |
|---|---|---|---|---|
| 形态 | Python **agent loop**(LLM 循环决定下一步,CDP 驱动 Chromium;可连云) | TS/Python/Go **SDK**:`act/extract/observe`(LLM 驱动);Browserbase 云或本地 Chrome | **Chrome 扩展**(MV3,多 agent:planner→navigator→validator),Chrome/Edge 商店产品 | Electron 主进程 `webContents.debugger` 直驱内嵌 webview |
| **能否跑在我们 Electron webview 里** | **否**。是独立 Python 进程,接**浏览器级** CDP endpoint(`cdp_url` / `BU_CDP_URL`);Electron webview 只有进程内 `webContents.debugger`,不暴露 WS endpoint。要接=先自建 CDP 桥+随包 Python 运行时 | **否**(同理)。`localBrowser.connect({ cdpUrl })` 要求浏览器已暴露 DevTools endpoint(`:9222` 一类);Electron webview 没有。且 `act/extract` 需另配 LLM key(OpenAI 等) | **否**。扩展只能装在独立 Chrome/Edge 里,不能装进 `<webview>` guest;架构上也不是可嵌入 SDK | **能**(本来就是) |
| 依赖与体积 | Python 3.12 + 大依赖树;LLM key 或其云(`BROWSER_USE_API_KEY`)。进桌面端=带 Python 运行时 | npm `@browserbasehq/stagehand` + puppeteer/playwright 依赖;LLM key;云=Browserbase(BROWSERBASE_API_KEY) | 扩展本体小,但需用户自带 LLM key;非可嵌入件 | 零外部驱动依赖、零新增运行时(纯 Electron API) |
| 许可 | MIT(© 2024 Gregor Zunic,已核 LICENSE 原文) | MIT(© 2024 Browserbase Inc.,已核 LICENSE 原文) | Apache-2.0 | 自有 |
| 活跃度(2026-09-26) | 116k★/12.8k fork,10,295 commits,最后提交 2026-09-15,148 tags,商业化(云) | 25.4k★/1.7k fork,1,539 commits,最后提交 2026-09-25(当日),144 tags,Browserbase 公司背书 | 13.8k★,50 open issues,仓库最后更新 2026-08-18,Reddit 自述约 1 名全职开发 | — |
| 对它的结论 | 是「大脑」不是「手」;我们服务端 `toolLoop.ts` 已是大脑,LLM 出口已统一在 `llm.ts` | 同上;其 CDP 连接工程实践值得抄(见下) | 形态不匹配(Chrome 扩展产品) | 保留 |

**核心判断**:三家都是「agent 层」或「独立浏览器环境」,没有一个能落进我们 webview 当「手」;我们缺的不是手(自建 CDP 驱动已在),把它们当运行时依赖引入=加 Python 运行时/CDP 桥/新 LLM key,与「脑在服务端、手在内嵌页」的架构冲突。三家定位**参考实现**:browser-use 的 agent loop/观测结构、Stagehand 的 CDP 连接与校验实践(如 #2542 修 `DevToolsActivePort` 陈旧缓存——对我们这种「连现有浏览器」的路径是好警示)、Nanobrowser 的 planner→navigator→validator 分工。

### Electron 升级路线(官方 release notes,逐 major)

| major | 发布 | Chromium / Node / V8 | 与升级相关的要点(节选) |
|---|---|---|---|
| **33(现状)** | 2024-11 | 130 / 20.16 / 12.3 | 基线 |
| **34(第一片目标)** | 2025-01-14 | 132.0.6834.83 / 20.18.1 / 13.2 | **breaking 仅 1 条**:Windows 全屏时隐藏菜单栏(#43402)。Node 仍是 20.x |
| 35 | 2025-03-04 | 134.0.6998.44 / 22.14.0 / 13.4 | breaking:`console-message` 参数移进 event 对象、webRequest filter 空数组弃用、`getPreloads/setPreloads` 弃用(改 `registerPreloadScript`)、`isAeroGlassEnabled` 弃用 |
| 36 | 2025 | 136(按规律外推,以官方 notes 为准)/ 22.x | 维护期为主(36.2.1 修 webview focus 崩溃等) |
| 37 | 2025 | 138(同上)/ 22.x | Web Serial/WebUSB blocklist;移除弃用的 `ProtocolResponse.session=null` |
| 38 | 2025-09-02 | 140(同上)/ 22.x | 崩溃修复批次;官方通知 35.x EOL |
| 39 | 2025 底 | 142(同上)/ 22.x | **ASAR Integrity 转正**(默认不影响我们:没启用就不会校验) |
| 40 | 2026-01-13 | 144.0.7559.60 / 24.11.1 / 14.4 | **Node 20→22→24 跨两代发生在 40** |
| 41 | 2026-03-10 | 146.0.7680.65 / 24.14.0 / 14.6 | macOS ASAR Integrity digest;Wayland 改进;MSIX 自动更新;官方建议装 41.0.2+ |
| 42 | 2026-05-07 | 148.0.7778.96 / 24.15.0 / 14.8 | — |
| 43 | 2026-07-02 | 150.0.7871.46 / 24.17.0 / 15.0 | — |
| **44(最新稳定)** | 2026-08-25(44.4.5 @ 09-22) | 152.0.7977.130 / 24.21.0 / 15.2 | 当前 stable |

(34/35/37/38/40–44 的数字与要点均逐条取自官方 release notes/blog,2026-09-26 抓取;36–39 的 Chromium/Node 为按「每 major +2 Chromium」规律的外推,已在表中注明,该片动手前按纪律 #4 以官方 notes 复核。)

### 我们受 breaking 影响的 API 面(grep 实测)

- `console-message` / `webRequest` / `getPreloads|setPreloads` / `isAeroGlassEnabled`:**桌面端零使用**(grep 无命中)。
- 我们实际用的:BrowserWindow + `webPreferences.webviewTag: true`(main.ts:306)、guest `webContents` 及其 `debugger`(CDP 1.3)、IPC(`workbench:drive` 等)、session 分区(`persist:` 按项目)。
- 无原生模块(dependencies 仅 react/react-dom;无 node-gyp 依赖)→ 升级不需 rebuild 原生件。
- 打包:electron-builder ^26.15.3,`--publish never`,未配签名。

## 决定

1. **保留自建 CDP 驱动为唯一执行层**。本轮不引入 browser-use / Stagehand / Nanobrowser 中任何一个作运行时依赖;三家定位参考实现(抄工程实践,不引代码)。
2. **Electron 逐 major 升,一次一片**:每片只升一个 major,升前抓该 major 官方 release notes 的 breaking 清单、对照我们用的 API 面逐条过;每片 `verify:shell` + 全量 `npm run verify` 全绿才 push;版本号回滚即回退(改动只有 package.json/lock)。
3. **第一片(本轮):33.2.1 → 34.x**。理由:34 的 breaking 只有一条(Windows 全屏菜单栏隐藏,产品无此场景),Chromium 130→132,Node 仍在 20.x——最小跳。
4. **`<webview>` → `WebContentsView` 迁移另立 ADR,不进升级片**。它涉及第四列布局(用户待拍板)、BrowserPanel 结构、祖先链 golden 重画,与「升级」是两件事;迁移前每片升级必须继续用 `verify:shell` 护 webview golden。
5. 每片升级的交付报告必须含:目标 major 的 breaking 清单对照结果、装后版本核对、`verify:shell` 与全量 verify 输出、真机差异的「盖不到+理由」(沙箱无 GUI/无 Windows)。

## 后果

- **好**:版本差距逐片收窄、吃到 Chromium 安全补丁;每片风险小、回滚 = 改回版本号。
- **代价**:11 个 major = 至多 11 片;Chromium 跨 major 的 webview 行为变化需要持续维护 golden/探针。
- **风险(如实)**:webview 是上游 sunset 路径——升级追平也不解决「上游不推荐」;WebContentsView 迁移 ADR 必须在阶段 3 内立项(排期:第四列/设计定稿后,因为祖先链 golden 会跟着重画)。
- **不选的代价**:若本轮引入任三家=桌面端多一个 Python 运行时或 CDP 桥+新 LLM key,且它们驱动的仍是**另一个浏览器**,与我们「驾驶现有内嵌页」冲突;若跳着升(33→44 一次)=11 个 major 的 breaking 叠加,出问题无法二分定位。

## 失败模式与验收覆盖(纪律 #3,第一片 33→34)

| # | 怎么会失败 | 验收怎么盖 | 盖不到?理由 |
|---|---|---|---|
| 1 | Chromium 132 改 webview 渲染/导航/事件路由,页面表现变(黑闪/事件丢失) | `verify:shell` golden 逐字节(护我们的 DOM 结构)+ 全量 verify(工具循环/kill-9/e2e 探针走 CDP 路径) | **真机渲染差异盖不到**:沙箱无 GUI,jsdom 不跑真 webview。理由已写明;交付报告列出需用户本地真机复跑的既有探针(`browser-idle-history-probe.py` 等),用户 `npm run dev:desktop` 手验一次开页/驾驶 |
| 2 | `webContents.debugger` CDP 行为变(命令时序/字段) | 全量 verify 链(toolLoop、loop:kill9、e2e 探针)跑通即证 CDP 路径可用;34 官方 notes 无 debugger breaking(已核) | 罕见页面形态(iframe/OOPIF)覆盖不全:无「已知受影响页面清单」;第一片后若用户报某页驾驶异常,补探针用例 |
| 3 | Node 20.16→20.18 行为差异 | typecheck(4 个包)+ 全量 verify(主进程 TS 代码);34 notes 无 Node breaking(patch 级) | 无 |
| 4 | 34 唯一 breaking:Windows 全屏隐藏菜单栏(#43402) | 已查实:electron 主进程 grep 零命中 `setApplicationMenu`/`Menu.buildFromTemplate`/`new Menu`/fullscreen 处理 → 无原生菜单、无全屏切换代码,**零暴露面** | **Windows 真机盖不到**(行为项):沙箱是 Linux;因暴露面为零,风险仅「未来加菜单时撞上」,届时随该片复核 |
| 5 | electron-builder 与 Electron 34 打包不兼容 / 签名问题 | 本未配签名;`package:dir` 需 electron 二进制而沙箱按惯例 skip 二进制下载 | **真打包盖不到**:沙箱不拉 ~100MB electron 二进制;交付报告注明,用户本地 `npm run package:dir` 验一次 |
| 6 | 包体积膨胀(Chromium 130→132) | 观测项:装后 `node_modules/electron` 体积记录进报告 | 最终安装包体积同上(依赖 #5 的真打包) |
| 7 | 原生模块 rebuild 失败 | 桌面端**零原生模块**(grep dependencies 确认)→ 无此暴露面;`npm ci`+typecheck 即覆盖 | 无 |
| 8 | 红线被破:webview 卸载 / display:none / 归零 / 祖先链变 | 本片**只改 electron 版本号,前端一行不动**;`verify:shell` golden 逐字节 + 既有反证 R1–R4 在场 | 无 |
| 9 | 34+ 上游加速弃 webview(删 webviewTag/行为收紧) | 34 notes 确认未移除;机制上每片升前抓 notes 复核 | 未来事件不列覆盖:靠「每片升前抓官方 notes」的制度化动作兜底;若真发生→WebContentsView 迁移 ADR 提前立项 |
| 10 | 升级装不上/沙箱环境差异(二进制下载等) | `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 既有惯例;`verify:shell` 是 jsdom,不依赖 electron 二进制 | 无 |

## 来源(纪律 #4,2026-09-26 抓取)

- browser-use:https://github.com/browser-use/browser-use(README/AGENTS.md;LICENSE 原文=MIT;116k★,最后提交 2026-09-15)、https://docs.browser-use.com/open-source/browser-use-cli(CDP 连接:`BU_CDP_URL`/`cdp_url`)
- Stagehand:https://github.com/browserbase/stagehand(LICENSE 原文=MIT;25.4k★,最后提交 2026-09-25)、https://docs.stagehand.dev/v4/configuration/browser(`localBrowser.connect({cdpUrl})` 需已暴露 DevTools endpoint)、PR #3018 / #2542(CDP 连接工程实践)
- Nanobrowser:https://github.com/nanobrowser/nanobrowser(Chrome 扩展、Apache-2.0、13.8k★、仓库最后更新 2026-08-18、50 open issues)
- Electron:https://releases.electronjs.org/(44.4.5/43.7.5/42.11.8 及 Chromium/Node 对应表)、v34.0.0 与 v35.0.0 release notes(breaking 清单)、v37.0.0/v38.0.0 release notes(webview 修复记录、35 EOL 通知)、https://www.electronjs.org/blog(40/41/42/43/44 发布与 ASAR Integrity@39)、https://www.electronjs.org/docs/latest/api/webview-tag(webview 不推荐警告)、browser-view 文档(BrowserView deprecated)
- 库内:`docs/智能体协同-总计划.md`(Electron 升级排阶段 3)、`apps/desktop/electron/driver.ts`(自建 CDP 驱动)、`apps/desktop/electron/main.ts:306`(`webviewTag: true`)、`apps/desktop/package.json`(electron `^33.2.1`、无原生依赖)
