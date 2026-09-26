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
| 36 | 2025-04-28 | 136.0.7103.48 / 22.14.0 / 13.6 | `NativeImage.getBitmap()` 弃用、Session extensions API 挪到 `Session.extensions`、`isAeroGlassEnabled` **移除**、PrinterInfo 字段删、`clearDataStorage({quota:'syncable'})` 移除、GTK 4 成 GNOME 默认(平台行为) |
| 37 | 2025-06-24 | 138.0.7204.35 / 22.16.0 / 13.8 | Web Serial/WebUSB blocklist 支持(加性)、utilityProcess 两处崩溃修复、移除 `ProtocolResponse.session=null` |
| 38 | 2025-09-02 | 140.0.7339.41 / 22.18.0 / 14.0 | **macOS 11 停止支持**;`ELECTRON_OZONE_PLATFORM_HINT` 移除(ozone 默认 auto,Linux Wayland 会话原生 Wayland);`plugin-crashed` 事件移除;`webFrame.routingId`/`findFrameByRoutingId` 弃用;35.x EOL |
| 39 | 2025-10-27 | 142.0.7444.52 / 22.20.0 / 14.2 | **ASAR Integrity 转正**(未启用则无影响);`--host-rules` 弃用;`window.open` popup 恒可缩放;`desktopCapturer` 在 macOS≥14.2 需 `NSAudioCaptureUsageDescription`;共享纹理 OSR `paint` 数据结构变化;36.x EOL |
| 40 | 2026-01-13 | 144.0.7559.60 / 24.11.1 / 14.4 | **Node 22→24 跨代点**(已核实):renderer 端 clipboard 弃用;macOS dSYM 改 tar.xz;E37 EOL。Node 24 代际项:undici 7、require(esm) 默认、`url.parse` 弃用、`tls.createSecurePair` 移除、`spawn/execFile` + `shell:true` 禁 args |
| 41 | 2026-03-10 | 146.0.7680.65 / 24.14.0 / 14.6 | macOS ASAR Integrity digest;Wayland 改进;MSIX 自动更新;官方建议装 41.0.2+ |
| 42 | 2026-05-07 | 148.0.7778.96 / 24.15.0 / 14.8 | — |
| 43 | 2026-07-02 | 150.0.7871.46 / 24.17.0 / 15.0 | — |
| **44(最新稳定)** | 2026-08-25(44.4.5 @ 09-22) | 152.0.7977.130 / 24.21.0 / 15.2 | 当前 stable |

(34–40 的 breaking 清单已逐条取自官方 release notes + 官方 blog(2026-09-26 抓取,数字全部核实);41–44 目前为官方 blog 级别摘要,各自动手那片前按纪律 #4 抓完整 release notes 复核。)

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

## 分片记录(纪律 #5:增量追加,不覆盖)

### 第一片:33.2.1 → 34.5.8(2026-09-26,fa639f8)

- 34 官方 breaking 清单仅 1 条(Windows 全屏隐藏菜单栏 #43402);grep 证实无原生菜单/无全屏代码 → 零暴露面。
- 装后版本 = 34.5.8;lock 只动 electron 一项。verify:shell 50/0;verify:electron 5/0;反证 2/2 红;全量 verify RC=0(359 真实请求,logic 56/0)。

### 第二片:34.5.8 → 37.10.3,合并 35–37 三个 major(2026-09-26)

**合并依据(用户加速口径 2026-09-26)**:连续 35/36/37 三个 major 的官方 breaking 清单逐条核实均零暴露面 → 按口径 2–3 个 major 合一片;每个 major 仍单独过清单(下表)。一旦某 major 有暴露面,立刻拆回单 major。

**35.0.0**(Chromium 134.0.6998.44 / Node 22.14.0)— 逐条对照:

| 官方 breaking | 我们的暴露面(grep 全 apps/desktop,ts+tsx) |
|---|---|
| webRequest filter `excludeUrls` + urls 空数组弃用(#45678) | 零:`webRequest` 零命中 |
| `getPreloads`/`setPreloads` 弃用(#45329) | 零:两 API 零命中 |
| `console-message` 参数移进 event 对象(#43617) | 零:`console-message` 零命中 |
| `isAeroGlassEnabled` 弃用(#45554) | 零:零命中 |
| ServiceWorkers `fromVersionID`(#45341) | 加性,无主进程 service worker 管理 |

→ **35 零暴露面。**

**36.0.0**(Chromium 136.0.7103.48 / Node 22.14.0)— 逐条对照:

| 官方 breaking | 我们的暴露面 |
|---|---|
| `NativeImage.getBitmap()` 弃用(#46736) | 零:零命中 |
| app.commandLine 畸形开关崩溃修复(#46446) | 我们用 3 处 `appendSwitch`(main.ts:49–51,均为合法布尔开关、无值)——此项是**崩溃修复**非行为变更,方向上更安全 |
| Session extensions API 挪到 `Session.extensions`(#45597) | 零:无 `loadExtension`/extensions 使用 |
| `isAeroGlassEnabled` **移除**(#45563) | 零:零命中 |
| PrinterInfo 删 status/isDefault(#45500) | 零:无 `webContents.print`/PrinterInfo 使用 |
| `clearDataStorage({quota:'syncable'})` 移除(#45923) | 零:零命中 |
| GTK 4 成 GNOME 默认(Chromium 平台行为) | 我们不直接用 GTK API;观测项——Linux/GNOME 用户的窗口行为差异归「真机复跑」(失败模式表 #1 口径) |

→ **36 零暴露面。**

**37.0.0**(Chromium 138.0.7204.35 / Node 22.16.0)— 逐条对照:

| 官方 breaking | 我们的暴露面 |
|---|---|
| Web Serial & WebUSB blocklist 支持(#46600) | 加性:不配 blocklist 条目=行为零变化;我们代码零命中 navigator.serial/usb |
| utilityProcess 未处理 rejection 崩溃修复(#45921)/ exit 后跑脚本修复(#47492) | 零:无 `utilityProcess` 使用(两条本也是修复) |
| 移除 `ProtocolResponse.session=null`(#46264) | 零:无 `protocol.handle`/`protocol.intercept` 使用 |

→ **37 零暴露面。**

**结果**:装后版本 = **37.10.3**(34.5.8 → 37.10.3,lock 只动 electron 一项);双 tsconfig 类型绿;verify:shell **50/0**;verify:electron **5/0**(装后版本核对=37.10.3/声明 ^37/shell 真跑/类型/零原生依赖);反证 **2/2 红**(M1 装后版本回退 34.5.8→红在装后核对;M2 声明回退 ^34.5.8→红在声明核对);全量 verify **RC=0**(359 真实请求,logic 56/0)。前端/`browser/` 零改动,红线网(golden+R1–R4)原样在场。
**盖不到的照旧**(失败模式表 #1/#4/#5):真机 webview 渲染(本片 Chromium 132→138,跨度比第一片大,真机复跑优先级提高)/ Windows 行为 / 真打包。

### 第三片:37.10.3 → 39.8.10,合并 38–39 两个 major(2026-09-26)

**合并依据(同加速口径)**:38/39 官方 breaking 清单(含 Chromium 继承项,取自官方 release notes + 官方 blog)逐条核实**零代码暴露面** → 合一片。

**38.0.0**(Chromium 140.0.7339.41 / Node 22.18.0 / V8 14.0)— 逐条对照:

| 官方 breaking | 我们的暴露面 |
|---|---|
| **macOS 11 停止支持**(E38+ 要求 macOS 12+) | 平台支持项,非代码 API——我们不声明最低 macOS 版本、代码零接触。**行为变化,已报告**:若用户群有 macOS 11,那部分用户需停留在 E37 版本线(分发策略事项,不触发拆片) |
| `ELECTRON_OZONE_PLATFORM_HINT` 移除;ozone 默认 auto(Linux Wayland 会话**默认原生 Wayland**) | 我们不设该 env(grep 零命中)。行为项:Linux Wayland 用户窗口行为可能与 X11 不同(可用 `--ozone-platform=x11` 回退)——归真机观测 |
| `plugin-crashed` 事件移除 | 零命中 |
| `webFrame.routingId` 弃用 | 零命中 |
| `webFrame.findFrameByRoutingId` 弃用 | 零命中 |

→ **38 零代码暴露面**(两条平台行为项已单列报告)。

**39.0.0**(Chromium 142.0.7444.52 / Node 22.20.0 / V8 14.2)— 逐条对照:

| 官方 breaking | 我们的暴露面 |
|---|---|
| `--host-rules` 开关弃用(改 `--host-resolver-rules`) | 零:我们只 appendSwitch 三个后台节流开关(main.ts:49–51) |
| `window.open` popup 恒可缩放 | **零**——两处 `setWindowOpenHandler`(webview guest main.ts:223 / 主窗口 main.ts:322)均 `action:'deny'`(新 tab 走渲染层 / 外链走系统浏览器),Electron 从不为我们创建 popup,行为变化无落点 |
| `desktopCapturer` 在 macOS≥14.2 需 `NSAudioCaptureUsageDescription` | 零:`desktopCapturer` 零命中(无屏幕/音频捕获功能) |
| 共享纹理 OSR `paint` 数据结构变化(`OffscreenSharedTexture` 统一 handle) | 零:offscreen/paint/SharedTexture 零命中 |
| ASAR Integrity 转正(Notable,非 breaking) | 未启用该功能 → 无校验行为,零影响 |

→ **39 零代码暴露面。**

**结果**:装后版本 = **39.8.10**(37.10.3 → 39.8.10,lock 只动 electron 一项);双 tsconfig 类型绿;verify:shell **50/0**;verify:electron **5/0**(装后版本核对=39.8.10/声明 ^39/shell 真跑/类型/零原生依赖);反证 **2/2 红**(M1 装后版本回退 37.10.3→红在装后核对;M2 声明回退 ^37.10.3→红在声明核对);全量 verify **RC=0**(359 真实请求,logic 56/0)。前端/`browser/` 零改动。
**盖不到的照旧 + 新增真机关注点**:真机 webview 渲染(Chromium 138→142)/ Windows 行为 / 真打包 / **macOS 11 用户停 E37** / **Linux Wayland 默认原生**(观测项)。
**下一片**:39→40——**Node 22.20→24.11 跨代点**,40 那片单独细看 Node 24 变化(不合并);40–44 的 breaking 清单动手前抓完整 release notes 复核(目前为 blog 摘要)。

### 第四片:39.8.10 → 40.10.6,单 major 39→40,不合并(2026-09-26)

**不合并依据(用户口径)**:40 是 **Node 22.20→24.11.1 跨代点**,单独细看——除 Electron 级 breaking 外,还要把 Node 24 代际项(undici/fetch 行为、require(esm)、被移除 API)与 Chromium 143/144 继承项逐条对照我们 server+desktop 代码与依赖。

**Electron 40.0.0**(Chromium 144.0.7559.60 / Node 24.11.1 / V8 14.4)— 官方 breaking 仅两条:

| 官方 breaking | 我们的暴露面 |
|---|---|
| renderer 进程直接调 `clipboard` API 弃用(官方迁移路径:preload + contextBridge) | 全仓 grep `clipboard` 零命中(桌面 main/preload/渲染层/服务端均无) |
| macOS dSYM 改 `dsym.tar.xz` 压缩(原 dsym.zip) | 无 dsym 工具链、未配签名(grep 零命中);打包 `--publish never`,零影响 |

另:E37 EOL(支持策略表,与我们无关)。

**Node 24 代际项**(nodejs.org v24.0.0 官方 blog)— 逐条对照:

| Node 24 变化 | 我们的暴露面 |
|---|---|
| **Undici 7**(内置 fetch/HTTP client 升级) | 我们只用**全局 fetch 的 JSON POST**(llm.ts 上游 LLM / auth.ts 短信 / tavily.ts 搜索);无 undici 直接 import、无自定义 dispatcher、无 undici 专属选项。memories.ts 的 `fetch('active')` 是局部闭包函数,非全局 fetch。零暴露面 |
| **require(esm) 默认生效**(CJS 可 require 同步 ESM) | 桌面 main 源码零 `require()`(tsc CJS 产物,无原生 require 调用);server 的 pglite 是**双模块**(main=dist/index.cjs,CJS require 直接命中 CJS 入口,根本不走 require(esm));且 E39 的 Node 22.20 已默认启用 require(esm)——行为与上一片完全一致,零变化 |
| `tls.createSecurePair` **移除** | 零命中 |
| `url.parse()` 运行时弃用 | 全仓零命中(含 url 模块 import 检查) |
| `SlowBuffer` 运行时弃用 | 零命中 |
| Zlib 类不带 `new` 弃用 | 零命中(无 zlib 直接类实例化) |
| `spawn`/`execFile` 传 args **且 `shell:true`** 将抛错 | 我们全部 3 处 spawn(server-supervisor.ts:拉 server / taskkill / 拉 PG)均为 `(file, args, options)` 标准形,**无一处 `shell:true`**。零暴露面 |
| `AsyncLocalStorage` 默认改用 AsyncContextFrame | 零命中 |
| V8 13.6 新特性(Float16Array 等,加性)/ npm 11 / URLPattern global / `--permission` flag 改名 | 均加性或零接触 |

**Chromium 143/144 继承项**(developer.chrome.com 官方 release notes)— 逐条对照:

| 移除/弃用 | 我们的暴露面 |
|---|---|
| 144:Private Aggregation API 移除 | 零(广告/隐私沙箱 API,未用) |
| 144:Shared Storage API 移除 | 零 |
| 144:Protected Audience 移除 | 零 |
| 144:XML 外部实体加载 | 零(无 XML 解析路径) |
| 143:Deprecate XSLT | 零(无 XSLT) |
| 143:Intl.Locale info getters 弃用 | 零(无 `new Intl.Locale`/getter 命中) |
| 143:FedCM 两项(隐私强制/nonce 迁移) | 零(无 FedCM 登录) |

→ **40 全维度零代码暴露面**(Electron 级 / Node 24 代际 / Chromium 143–144 继承,三条线各自逐条核完)。

**结果**:装后版本 = **40.10.6**(39.8.10 → 40.10.6,lock 变更全部在 electron 子树:electron 本体 + 安装期依赖 `@electron/get` 5.x 换血 + 嵌套 `@types/node 24`);双 tsconfig 类型绿;verify:shell **50/0**;verify:electron **5/0**(装后版本核对=40.10.6/声明 ^40/shell 真跑/类型/零原生依赖);反证 **2/2 红**(M1 装后版本回退 39.8.10→红在装后核对;M2 声明回退 ^39.8.10→红在声明核对);全量 verify **RC=0**(429s,359 真实请求,logic 56/0)。前端/`browser/` 零改动,webview 未碰。

**盖不到的照旧 + 真机关注点**:Chromium 142→144 真机 webview 渲染探针优先级继续提高;打包/Windows 照旧。另注意:桌面 supervisor 用 `ELECTRON_RUN_AS_NODE=1` 让 server 跑在 Electron 自带 node 里 → 打包桌面端 server 进程自此跑 **Node 24.11.1**(上片 22.20),Node 24 代际项已核零暴露面,但真机驱动时值得看一眼 server 日志无 deprecation 告警。

**下一片**:40→41(macOS ASAR Integrity digest,配签名才需重签;41 完整 notes 动手前抓)。

## 来源(纪律 #4,2026-09-26 抓取)

- browser-use:https://github.com/browser-use/browser-use(README/AGENTS.md;LICENSE 原文=MIT;116k★,最后提交 2026-09-15)、https://docs.browser-use.com/open-source/browser-use-cli(CDP 连接:`BU_CDP_URL`/`cdp_url`)
- Stagehand:https://github.com/browserbase/stagehand(LICENSE 原文=MIT;25.4k★,最后提交 2026-09-25)、https://docs.stagehand.dev/v4/configuration/browser(`localBrowser.connect({cdpUrl})` 需已暴露 DevTools endpoint)、PR #3018 / #2542(CDP 连接工程实践)
- Nanobrowser:https://github.com/nanobrowser/nanobrowser(Chrome 扩展、Apache-2.0、13.8k★、仓库最后更新 2026-08-18、50 open issues)
- Electron:https://releases.electronjs.org/(44.4.5/43.7.5/42.11.8 及 Chromium/Node 对应表)、v34.0.0/v35.0.0/v36.0.0/v37.0.0/v38.0.0/v39.0.0/v40.0.0 release notes(breaking 清单,2026-09-26 逐条复核)、官方 blog electron-38-0 / electron-39-0 / electron-40-0(Chromium 继承 breaking:macOS 11 移除 / OZONE 默认 auto / plugin-crashed 移除 / routingId 弃用;--host-rules 弃用 / window.open 恒可缩放 / desktopCapturer plist / OSR paint 结构;renderer clipboard 弃用 / dSYM tar.xz)、https://www.electronjs.org/blog(41/42/43/44 发布与 ASAR Integrity@39)、https://www.electronjs.org/docs/latest/api/webview-tag(webview 不推荐警告)、browser-view 文档(BrowserView deprecated)
- Node 24 代际项:https://nodejs.org/en/blog/release/v24.0.0(undici 7 / require(esm) 默认 / `url.parse` 弃用 / `tls.createSecurePair` 移除 / Zlib 无 `new` 弃用 / `spawn`+`shell:true` 禁 args / AsyncLocalStorage 默认)、https://github.com/nodejs/node/pull/57199(shell:true 禁 args 的精确语义)
- Chromium 143/144:https://developer.chrome.com/release-notes/143 / https://developer.chrome.com/release-notes/144(移除项:Private Aggregation / Shared Storage / Protected Audience / XML 外部实体;XSLT / Intl.Locale getters / FedCM 两项)
- 库内:`docs/智能体协同-总计划.md`(Electron 升级排阶段 3)、`apps/desktop/electron/driver.ts`(自建 CDP 驱动)、`apps/desktop/electron/main.ts:306`(`webviewTag: true`)、`apps/desktop/package.json`(electron `^33.2.1`、无原生依赖)
