# ADR-0002:webview → WebContentsView 迁移

日期:2026-09-26(阶段 3 升级路线 33→44 爬完后启动;ADR-0001 决定④ 兑现)
状态:已接受(第五/六片升级完成后开工)

## 背景

- ADR-0001 决定④:webview→WebContentsView 迁移另立 ADR,排期 = 设计定稿后。官方文档对 `<webview>` 的态度是「不推荐,考虑 iframe/WebContentsView」——**仍会发布,但不再演进**,继续留着等于背一个随时可能被动的 API。
- 前置条件已满足:Electron 已爬到最新稳定 44.4.5(WebContentsView 自 E30 起稳定、E37+ 起补齐 `contentView` 子视图 API 族),升级线不再是迁移的阻塞项。
- 自建 CDP 驱动(`driver.ts`)是执行层核心:它今天靠「找到 webview 的 guest `webContents` → `wc.debugger.attach('1.3')`」驾驶内嵌页。迁移必须保住这条链,且**驾驶目标要更确定**(见后果)。

## 现状(迁移前的事实基线,逐条对码核实)

**宿主结构**(`apps/desktop/src/browser/BrowserPanel.tsx`):

- `.browserLayer`(第四列,`div.app` 的孩子)→ `.browserPanel` + `.computerVisibility`(兄弟)→ `.browserPanel__tabs` + `.browserPanel__urlbar` + `.browserPanel__stage`。
- 舞台里**所有智能体、所有 tab** 各挂一个 `<webview key={t.id} className="browserPanel__view …">`:绝对定位铺满舞台,靠 `z-index` 分层(`--on` z2 / 基础 z1 / `--off` z0+opacity 0+pointer-events none);embed(求助卡)态下目标页用**内联 style**(rect + `clip-path`)搬到卡片位置——「影子层方案」:webview 元素本身不动,变的只有 CSS。
- `partition={partitionFor(t.projectId)}`(Phase 3:登录态按**项目**隔离);`allowpopups="true"`(字符串属性,主进程 setWindowOpenHandler 拦 target=_blank → 真开 tab);深休眠的页**不渲染 `<webview>`**(渲染休眠占位卡,这才是真省内存)。
- 事件监听挂在 webview 元素上:`page-title-updated` / `did-navigate` / `did-navigate-in-page` / `will-navigate`(渲染层协议闸)/ `dom-ready` → `ws.notePageInfo` / `ws.noteOwner`;`getWebContentsId()` 是 webview 元素自己的 API(guest 的 webContentsId,驾驶用的目标 id)。

**祖先链 golden**(`docs/acceptance/app-shell/webview-ancestor-chain.golden.json`):

```
webview.browserPanel__view ← div.browserPanel__stage ← div.browserPanel ← div.browserLayer ← div.app ← div ← body ← html
```

BEM 修饰符(`--bg/--embed/--off/--on/--hidden/--overlay/--dragging`)不算结构,已归一化。`verify:shell`(jsdom 挂整个 `<App/>` 走真实路径开一张页)逐字节对链 + **节点身份**(切可见度档位/切视图/切智能体后还是同一个 DOM 元素对象,不是「长得一样的新元素」)。

**第四列三态**(`design/14-browser-column.css` + 规格 C2):

- 基础态 = 第四列(右列,聊天列让位 `app--col`);`--overlay` = 左拖过阈值盖住聊天(聊天列不让位);`--hidden` = **transform 移出视野**(铁律:绝不 `display:none`、绝不尺寸归零);`--dragging` 拖动态;`--embed` 求助卡模式(正交修饰符)。
- **隐藏 ≠ 卸载**:回来不重载(webview 同一元素)。
- **三条有意卸载路径**(除此之外 webview 永不卸载):① `allTabs` 归零(关光所有页);② 该页进入**深休眠**;③ `key={t.id}` 变化(含深休眠唤醒重建,src 用当前 url 兜底保导航)。

**主进程接线**(`apps/desktop/electron/main.ts`):

- `app.on('web-contents-created')` 对 `getType() === 'webview'` 的 guest:`setBackgroundThrottling(false)`;`will-download` → 下载落**项目目录**+记 owner 归因;`setWindowOpenHandler`(http(s) → 推 `workbench:browser:opentab` 给渲染层真开 tab,一律 `deny`);`will-navigate` / `will-redirect` / `will-frame-navigate` 协议闸(非 http(s) 全拦);`did-finish-load` 补 `window.chrome`。
- **分区闸**:`will-attach-webview`(同步事件,唯一能钉死 partition 的时机)——分区形状必须 `persist:workbench-browser-project-<正整数>`(或兜底 `-none`)且项目号属于当前账号,否则**改写到隔离分区**(不 preventDefault,页照开只是没登录态)+ 推 `workbench:webview:blocked` 给渲染层。
- 渲染层 → 主进程桥(preload 白名单):`drive` / `readPage` / task 族 / agent 族(全部点名 `targetWebContentsId`)、`browserOwner(wcId, agentId)`(下载归因)、`browserThrottle(wcId, on)`(浅休眠,被驾驶的页拒节流)、`syncProjects`(分区闸的账号项目清单)。

**驱动层**(`apps/desktop/electron/driver.ts`):

- `resolveTarget(id)`:`webContents.fromId(id)` 且 `wc.getType() === 'webview'`,否则 **fail-fast 报错,绝不猜**(第 22 步删掉了盲选第一个 webview)。
- CDP:`wc.debugger.attach('1.3')` + 统一 8s 超时补丁(防死锁硬闸);状态机 per-target(Map,无全局单例)。
- 浅休眠 = `wc.setBackgroundThrottling(true)`;深休眠 = 渲染层卸载 `<webview>` 元素 → guest 进程销毁。

**反证网**:`app-shell-smoke-revert.py` R1–R6(套一层 div→golden 咬;挂到条件渲染/key 上→节点身份咬;`.browserLayer{display:none}`→样式红线咬;CSS 零残留审计×2,锚点跟 App.tsx/14-browser-column.css 的生产码走);`browser-column-revert.py` C1–C5(隐藏态改 display:none 咬、层里多包一层 div→golden 咬,…)。

## 备选

| 方案 | 结论 |
|---|---|
| **A. 维持 `<webview>`** | 官方「不推荐但仍发布」。不迁移 = 把「哪天被移/被坑」的风险无限期挂账;44 已爬到最新,没有升级侧的收益可对冲。否决(但保留一个片长的回滚窗口,见决定②) |
| **B. BrowserView** | 已 DEPRECATED(ADR-0001 来源节确认,官方指向 WebContentsView)。否决 |
| **C. iframe** | 能加载 http(s),但 guest 不再是独立 `webContents`:CDP 驾驶要整条 `driver.ts` 从 `wc.debugger` 改走主窗口 debugger + sessionId 路由(执行层大改);每项目 partition 的 cookie 隔离没有干净落点(iframe 与宿主同进程同 session 族);分区闸、下载归因、window.open 拦截全部要重做。迁移成本 > 收益。否决 |
| **D. WebContentsView(选定)** | 主进程创建、`BrowserWindow.contentView.addChildView` 挂载;每个 view 自带 `webContents` → **`wc.debugger` CDP 挂载机制与 webview guest 完全同构**(driver 改动最小);`webPreferences.session = session.fromPartition(…)` 直接落项目分区(比 will-attach-webview 更直);`setBounds` / `setVisible` / z-order 由主进程精确控制;创建即拿到确定的 `wcId`(渲染层不再等 `dom-ready` 才 `getWebContentsId()`) |

## 决定

1. **宿主换轨**:每张活页 = 主进程一个 `WebContentsView`(`session = fromPartition(partitionFor(projectId))`),挂到 `mainWindow.contentView`;渲染层舞台里原来的 `<webview>` 换成**同名同类的占位 div**(class 不变:`browserPanel__view` 及其修饰符),只当几何锚点与结构占位。
2. **分片,回滚窗口**:第一片只换宿主(本文范围),`webPreferences.webviewTag: true` **保留一个片长**——生产代码里 `<webview>` 标签与 `webview.d.ts` 随换轨消失,但 webview 能力仍可用,出问题把渲染层改回 `<webview>` 即可回到迁移前;下一片关 `webviewTag` + 清 `will-attach-webview` 等 webview 专属件。
3. **IPC 契约**(新增,全部经 preload 白名单 + shared 类型):
   - `browserViewCreate({tabKey, projectId, url}) → {wcId}`(主进程跑分区闸 → 建 view → 挂 guest 全套接线 → 附 contentView → 返回 wcId);
   - `browserViewRect({tabKey, rect, visible})`(渲染层 ResizeObserver + 层 class MutationObserver,rAF 合并 + 签名去重,主进程取最新,`setBounds` + `setVisible`;零尺寸 rect 只改可见性不碰 bounds,守「不归零」红线);
   - `browserViewOrder({tabKey})`(切到前台 = `contentView.addChildView` 重排到最上);
   - `browserViewNavigate({tabKey, url})`(URL 栏回车/同站改道;实现期发现的老 `<webview>.loadURL` 替代通道,协议闸在 guest 侧照旧兜底);
   - `browserViewFocus({tabKey})`(切 tab/聚焦/唤醒后聚焦;原生视图没有 DOM focus,走 `wc.focus()`;实现期发现,老代码是元素 `.focus()`);
   - `browserViewClose({tabKey})`(关页/深休眠 = 摘 view + `wc.close()`(Electron 44 的 graceful 销毁,`destroy()` 已不存在),内存真释放);
   - `workbench:browser:pageinfo {wcId, title?, url?}`(主→渲染事件,接替 webview 元素上的 `page-title-updated`/`did-navigate`/`did-navigate-in-page`);
   - **复用不动**:`browserThrottle(wcId, …)` / `browserOwner(wcId, agentId)` / drive / task / agent 族——它们本来就点名 wcId,wcId 的来源从「webview 元素自报」变成「create 时主进程发」,下游零改动。
4. **驱动层**:`resolveTarget` 的接受条件从 `getType() === 'webview'` 扩为 `type === 'webview' || viewHostRegistry.has(wc.id)`(registry 在主进程,create 时登记、close 时注销);fail-fast 语义与报错口径不变,CDP 超时补丁不动。
5. **分区闸搬家**:规则(`decideWebviewPartition`:形状 + 账号项目归属,越界改写隔离分区 + 推 `workbench:webview:blocked`)**原样**搬到 `browserViewCreate` 入口;`will-attach-webview` 处理器保留一个片长(与 webviewTag 同退)。主进程从此**只有一个**建页入口——渲染层被攻破也造不出 view。
6. **休眠语义不变**:浅休眠 = `wc.setBackgroundThrottling(true)`(通道不变,被驾驶的页照旧拒节流);深休眠 = `browserViewClose`(进程销毁,真省内存),唤醒 = `browserViewCreate` 且 url 用当前真实地址(等价于今天「key 变化 + src 兜底」)。
7. **验收口径**:`verify:shell` 的祖先链 golden 围绕**新的宿主 div** 重画(显式 `--update-golden`,且只在确认结构变更是有意的时用);节点身份断言从「`<webview>` 同一元素」改为「宿主 div 同一元素」;三条有意卸载路径、隐藏≠卸载、三态 class 白名单、样式红线(`--hidden` = transform、无 display:none/归零)全部照旧,只换对象;`app-shell-smoke-revert.py` R1–R6 / `browser-column-revert.py` C1–C5 的**锚点跟随生产码**重指(生产码没动的锚点不动),反证全红才算网没漏。
8. **红线照旧**(冲突就停下报告):浏览器不卸载(三条路径外)/ 不 `display:none` / 不归零;不删工作;不开/合 PR;留在自己分支;`browser/` 本片只动宿主相关文件(BrowserPanel.tsx / useBrowserWorkspace.ts / webview.d.ts / index.ts 的导出面),`browser/` 其余文件(sites/intent/sleepPolicy/styles/HelpCard/ComputerVisibility/SleepBadge)与全部 CSS **零改动**;后端(`apps/server`)**零改动**(用户明令)。

## 后果

**正面**:

- 退出「不推荐」API,宿主落在官方主推的 `WebContentsView` + `contentView` 体系,后续 Electron 版本只会更稳。
- **驾驶目标确定**:wcId 在 create 时由主进程发,不再依赖 webview 元素 `dom-ready` 时序与 `getWebContentsId()` 的 try/catch 重试(`awaitWebContentsId` 的 25 轮轮询可以退役)。
- 分区闸从「同步事件的被动改写」变成「建页入口的主动校验」,且建页入口唯一。
- 深休眠语义显式化:今天靠「DOM 卸载 → Electron 顺手销毁 guest」,迁移后是显式 `destroy()`——省内存这件事不再依赖实现细节。
- 安全面(下一片关 webviewTag 后):渲染层 XSS 再也造不出新 web 宿主;今天它是造得出的(webviewTag: true + partition 闸只拦分区不拦创建)。

**负面(如实登记)**:

- **原生视图永远盖在 DOM 之上**:`<webview>` 是 DOM 元素,任何 DOM 浮层能盖住它;`WebContentsView` 是原生子视图,**任何 DOM 都盖不住它**。第四列的三态里:基础态/覆盖态无所谓(要的就是它在上面);**embed 求助卡**是唯一有 DOM 覆盖需求的场景——卡片区域外的聊天内容不与卡片 rect 重叠,可盖住卡片的只有浮层(下拉/tooltip),这是已知取舍,登记为真机观测项(决定:第一片接受,若真机上浮层遮挡碍事,第二片再处理)。
- 几何多一跳 IPC:首帧有「create → 第一次 rect 同步」的窗口,处理办法 = create 时先离屏(rect 到了才 `setVisible(true)`),白闪风险登记为真机观测项。
- 坐标系两份:渲染层量 viewport rect(CSS px = DIP),主进程 `setBounds` 也是 DIP 相对 contentView——常规窗口下两者原点一致(已核 `createMainWindow` 无 frameless 偏移),但这条一致性要进真机观测项。
- 多一张「占位 div 必须和原生 view 对齐」的隐式契约:占位 div 的 rect 就是 setBounds 的输入,div 被 CSS 挪走而 IPC 没跟上 = 页漂移。冒烟网新增断言守住「占位 div 的几何只在 stage 内变化」。

## 失败模式表(doubt-driven:迁移后第四列拖拽/覆盖/隐藏不卸载怎么被影响,验收逐行怎么盖)

| # | 怀疑(怎么会失败) | 失败后用户看到什么 | 验收怎么盖(行级) |
|---|---|---|---|
| F1 | **拖拽**(.browserCol__resizer 左拖右收):rect IPC 逐帧发,主进程 setBounds 跟不上/乱序 → 页在拖的过程中漂移、撕裂、停在旧宽度 | 拖宽时页「掉队」,松手才对上 | ① 渲染层 rAF 合并 + 主进程**取最新一条**(同 tabKey 的旧 rect 丢弃)——实现内保证;② 冒烟网 ⑧-2/⑧-3(拖过阈值→`--overlay`/收回→`app--col`)仍断言 DOM 侧宽度状态不变;③ 新增断言:拖拽期间占位 div 的 rect 流被**完整发出**(桥桩记录,末态 = stage 现态);④ 真机观测项:拖一次看页无撕裂 |
| F2 | **覆盖**(`--overlay`):原生 view 物理在 DOM 之上,「盖住聊天」从 CSS z-index 变成真盖——但如果 overlay 时 view 没排到最上、或聊天区有更高的原生层 | 页没盖住聊天,或盖错了地方 | ① 进 overlay = `browserViewOrder` 排最上(实现内);② 冒烟网 ⑧-2 断言 `--overlay` class + 聊天列不让位(`app--col` 不在)不变;③ 真机观测项:拖过阈值看页确实盖在聊天上 |
| F3 | **隐藏 ≠ 卸载**(`--hidden` = transform 移出视野):迁移后若把「隐藏」实现成 `removeChildView` + destroy,或 `setVisible(false)` 但 view 被 GC → 回来重载/任务断 | 点「💬 对话」再回来,页重载了(登录态还在但导航丢了)/ 任务停 | ① 实现口径:隐藏 = 保持 attach + `setVisible(false)`(**不 destroy**);② 冒烟网 ⑧-4/⑩-3(隐藏后宿主 div 仍在 document、层 class 带 `--hidden`;启用后回来)照旧,对象从 `<webview>` 换成宿主 div;③ 新增真机观测项:隐藏期间跑一个循环任务,回来任务没断(驾驶走 wcId,与可见性无关,但要真机钉一次) |
| F4 | **别的智能体的页 `--off`**(opacity 0 不露脸但照活照驾驶):迁移后若把 `--off` 也实现成 destroy/setVisible(false) 后忘了恢复,或恢复时序错 | 切回该智能体时页空白/要重载;或驾驶打不到(其实打得到,只是看不见) | ① 可见性映射写死:visible = 层非 hidden 且 (`--on` 那张 或 embed 目标),其余 `setVisible(false)` **不 destroy**;② 冒烟网 ⑤(切智能体不换宿主 div)+ 节点身份断言照旧;③ 真机观测项:两智能体各开一页,切来切去都秒回不重载 |
| F5 | **深休眠**:close 时机错(驾驶中页被误休眠)/唤醒 url 不对(回 bootUrl 丢导航) | 正在跑的任务页被「省内存」掉了;或唤醒后回到首页 | ① 判定层(sleepPolicy)不变:drivingIds 里的页**永远不会** deep(判定层 + 渲染层双闸,照旧);② 冒烟网路径②(深休眠 = 有意卸载,占位卡出现)照旧;③ 唤醒 create 的 url = 当前 `t.url`(等价今天 src 兜底逻辑),单测随 workspace 逻辑;④ 真机观测项:休眠页唤醒后停在离开前的地址 |
| F6 | **embed 求助卡**(clip = `inset(…)` 矩形裁剪):原生 view 不能 clip-path → 用「bounds 收缩到裁剪后的矩形」等价替代;滚动跟随 = rect 流;卡片区域上的 DOM 浮层会被原生 view 盖住 | 卡片滚动时页跟不上/裁切不对;浮层(如设置下拉)被页盖住 | ① `inset(t r b l)` → bounds 四边收缩,数学上等价(实现内);② HelpCard 的 rect 流通道不变,onRect → browserViewRect;③ 浮层遮挡 = 已知取舍(后果节),登记真机观测项,第一片不修 |
| F7 | **首帧白闪**:create 返回 → 第一次 rect 到达之间,view 若已可见 | 开页瞬间一个错位的白块/页闪现 | ① 实现口径:create 时 `setVisible(false)` + 离屏 bounds,rect 到了才显示;② 真机观测项:新开一页看无白闪 |
| F8 | **golden 重画造假**:`--update-golden` 顺手把错的链写成 golden(反证全绿 = 假网) | 网失效,以后真出事咬不住 | ① 重画只允许在「确认结构变更是有意」时(本次 = 宿主换轨,唯一);② 重画后**立刻跑反证** R1–R6/C1–C5 必须全红;③ golden 的 note 字段更新为宿主 div 口径;④ R1(套一层 div)重画后仍必须咬住新链 |
| F9 | **驾驶丢目标**:`resolveTarget` 只认 `type === 'webview'` → 迁移后所有驾驶 fail-fast | 「指定的内嵌页已经不在了」,全部任务失败 | ① registry 扩展(决定④);② 既有驾驶验收(computer-visibility 系列 / drive-shape-probe,CDP 桩走 `type === 'webview'` 的老路)必须照绿——**桩不动**,证明老路没被改坏;③ 真机观测项:迁移后真跑一轮驾驶 |
| F10 | **分区闸漏口**:view 的 session 绕过 decideWebviewPartition(比如 projectId=null 落默认 session → 与主窗口共用 cookie) | 隔离失效,账号间串登录态 | ① create 入口**唯一**且必过闸(projectId=null → `-none` 兜底分区,与今天 webview 空分区处置一致);② 冒烟网桥桩走 create 路径,`workbench:webview:blocked` 事件路径照旧可触达;③ 真机观测项:跨项目页的登录态互不可见 |
| F11 | **事件链断**:webview 元素事件(title/did-navigate/dom-ready)没了 → URL 栏/标题不跟、owner 归因断、下载记录认错人 | tab 标题永远不变;下载记录 agentId 未知 | ① 主进程 `pageinfo` 事件接管 title/url(create 返回即等价 dom-ready,owner 在 create 时即可上报);② 冒烟网:桥桩发 `pageinfo` → URL 栏/tab 标题跟着变(新增断言);③ 真机观测项:下载一条文件,记录里 agentId 正确 |
| F12 | **window.open / 协议闸 / 下载落目录**没随宿主搬家 | 点 target=_blank 又变回「点了没反应」;非 http(s) 弹出系统框;下载落错目录 | ① 三个 handler 在 create 时对 `view.webContents` 原样重挂(与今天 web-contents-created 段逐条对应);② 冒烟网 `opentab` 桥路径照旧;③ 真机观测项:页内点 target=_blank 真开 tab / 点抖音「打开 App」不弹系统框 / 下载落项目目录 |
| F13 | **反证锚点漂移**:R1–R6/C1–C5 锚点跟的是旧生产码,重指时指错 → 锚点不唯一/找不到,反证脚本自废 | 反证假绿(脚本自己失败被误读) | ① 生产码没动的锚点**一个不改**(R1/R2/R3 在 App.tsx 的 BrowserPanel 挂载、R4 在 14-browser-column.css——本切片全不动);② 只改 `expect` 文案跟随断言消息;③ 跑完 6/6 + 5/5 全红才算过 |

## 分片

- **第一片(本 ADR 的执行范围,最小)**:只换「浏览器页的宿主」——view-host 主进程模块 + IPC 契约 + BrowserPanel 占位 div + workspace 的 wcId 来源改造 + driver registry 扩展 + 冒烟网对象切换与 golden 重画 + 反证重指。第四列 UI(class/DOM 结构/CSS/三态/拖拽/覆盖/隐藏语义)逐字节不变;`webviewTag` 保留;后端零改动。
- **第二片(后续,等指令)**:关 `webviewTag` + 清 `will-attach-webview`/`webview.d.ts` + 安全面收口。
- **之后**:真机观测项逐条销账(F1/F2/F3/F4/F5/F6/F7/F10/F11/F12 的真机列);embed 浮层遮挡若碍事再立子项。

## 实施记录(第一片,2026-09-26)

- 实现中补了两条契约外的通道:`browserViewNavigate` / `browserViewFocus`(老代码 `el.loadURL(url)` / `el.focus()` 的替代,决定③ 已同步)。
- **最后一张页的卸载路径**(F3 补强):关**最后一张**页时 `allTabs` 归零 → App 把整个浏览器层卸掉 → BrowserPanel 的宿主生命周期 effect **不会再跑**(没有下一次渲染去发现「少了一张」)→ 最后一张的 close 会漏。修法:卸载标志(独立 effect 的 cleanup 先于宿主 effect 跑)+ 真卸载时把登记在册的宿主全销毁。冒烟网 ⑥ 断言「每条 create 过的页都有对应 close」。
- **后台开页语义**:`open` 事件走 `openFromMain` → `openUrl` 只把 `view` 切 fullscreen,**不**开列(colOpen 不动)→ 层是 `--hidden` → 视图 `visible:false` 但**不销毁**。这是既有语义(敏感字段等待场景:页在后台挂着),不是回归;冒烟网 ④ 按此断言(visible=false + 无 close),「露脸」断言放在 ⑧-4「🌐 启用」之后。
- **visible 映射以层 class 为准**:BrowserPanel 的 rect 效果读 App 算好的 `.browserLayer--hidden/--embed` class(MutationObserver 跟踪),不另维护一套「何时可见」逻辑——两份逻辑对不齐才是事故之源。
- **create 回执与首帧**(F7):create 期间视图离屏;回执落地后 BrowserPanel 强制重发一次几何(签名去重之外的 force 通道),页才落位。
- **验收资产同步**:
  - golden 重画:首节点 `webview.browserPanel__view` → `div.browserPanel__view`,其余 7 层不变;
  - `app-logic-smoke`(verify:logic)的桥桩补 `browserViewCreate` 真值(回 wcId)——`useChat` 的发送路径 `await awaitWebContentsId()`,桩不回 wcId 时发送被 25×120ms 重试拖满 3 秒,片 7b 全红(基线对照确认:桩给真值后 56/0);
  - `app-logic-smoke` 的「切项目绝不碰浏览器」节点身份断言:`q('webview')` → `q('.browserPanel__view')`;
  - `sleep-wiring-tests.mts` 三条静态探针的锚点跟生产码重指(占位卡先于宿主 div return / 唤醒后延迟 `browserViewFocus` / 唤醒 url 口径搬进 workspace 的 `hostMounted`);`sleep-revert-tests.mts` 的 deepSleeping 变异 `count: 1→3`(判定现在有三处必须一致的落点);9/9 照抓。
  - `webview.d.ts` 随生产 `<webview>` 标签消失(决定②),`global.d.ts` 里对应注释同步删。

## 来源

- `apps/desktop/src/browser/BrowserPanel.tsx`(webview 宿主/影子层/深休眠渲染分支,逐行读)、`useBrowserWorkspace.ts`(wcId 映射/owner/浅休眠)、`webview.d.ts`、`index.ts`、`styles.css`(`.browserPanel__view` z-index 族)
- `apps/desktop/electron/main.ts`(web-contents-created 段 / will-attach-webview 分区闸 / browser:throttle / workbench:open / BrowserWindow 选项)、`driver.ts`(resolveTarget / CDP 超时补丁)、`preload.ts`(桥白名单)、`resource-guard.ts`(实例清单只从渲染层来)
- `docs/产品交互规格.md` C2(第四列:双触发/三形态/隐藏≠卸载/验收口径)、`docs/adr/0001-浏览器控制与Electron升级.md`(决定④ / webview 官方态度 / hyperia 迁移参照)
- `scripts/verify/app-shell-smoke.run.tsx`(50 断言逐条读)、`app-shell-smoke-revert.py`(R1–R6)、`browser-column-revert.py`(C1–C5)、`docs/acceptance/app-shell/webview-ancestor-chain.golden.json`
- Electron 官方文档:webview-tag(不推荐警告)、web-contents-view(创建/contentView 挂载/setBounds/setVisible)、browser-window(contentView)
