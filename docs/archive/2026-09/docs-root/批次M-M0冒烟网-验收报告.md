# 批次 M · M0 冒烟网 —— 验收报告

> 切片：**M0（原样做，未缩水）**。基线 `9dc9894` 之上；本片**没有改任何产品代码**
> （只新增验收脚本 + golden + 文档；`App.tsx` / `styles.css` 的 md5 与 HEAD 逐字节一致，
> 见 §5）。日期 2026-09-24。

## 0. 一句话

先织网再动刀：**jsdom 挂载整个 `<App/>`**，走**真实路径**开出一张页，
把 `<webview>` 的祖先链写成 golden、把"切档/切视图/切智能体不许换元素"写死；
再用 4 种"重构时最可能犯的错"做反证 —— **4/4 全部咬住**（其中一种当场揭穿了一个会
让整条网崩掉的假网写法，见 §4）。

## 1. 为什么是这张网（它挡什么）

M1'–M8' 要把 3714 行的 `App.tsx` 拆成外壳 + 7 个 feature。任何一次「顺手加个布局容器」
「把面板挪进条件渲染」都可能把 `<webview>` 从原父节点上摘下来 —— 而
`browser/` 里驾驶（AI 操作网页）的点击坐标全部来自页内 `getBoundingClientRect`，
**元素一旦卸载重建，正在跑的那张页当场没了、坐标全废**（收尾 7 的
`.browserLayer--bg` 注释与 `panel-visibility-coupling-probe.py` 都在守这条）。

## 2. 网络本身（17 条断言）

脚本：`scripts/verify/app-shell-smoke.mts`（driver，esbuild 打包）
+ `scripts/verify/app-shell-smoke.run.tsx`（跑起来的那一半，jsdom）。
命令：`npm run verify:shell`（已接进主链 `npm run verify` 末尾）。

| 段 | 断言 | 说明 |
|---|---|---|
| ① 外壳三列 | 4 条 | `aside.sidebar` / `main.middle` / `.chat` + `.inputBar`（且后两者真的是 `main.middle` 的孩子）/ 已越过登录页（`/auth/me` 真的请求过） |
| ② 前置条件 | 2 条 | 没开页时 `.browserLayer` **不该存在**；桥上注册了 `open` / `opentab` 订阅（主进程开页的唯一入口） |
| ③ 真实路径开页 | 4 条 | 触发主进程 `open` 事件 → `browser.openFromMain` → `openUrl` → 层出现、层是 `main.middle` 的孩子、`BrowserPanel` 与 `ComputerVisibility` **互为兄弟**（这是收尾 7 定的、不许改的关系）、舞台里真的有 `<webview>` |
| ④ 祖先链 golden | 1 条 | 逐字节比对 `docs/acceptance/app-shell/webview-ancestor-chain.golden.json` |
| ⑤ 节点身份 | 4 条 | 切**可见度三档**（×3 个按钮）/ 切**浏览器视图**（全屏↔后台）/ 切**智能体**（换人）之后，**还是同一个 DOM 元素对象**；层的 class 始终在文档化的三态里 |
| ⑥ 路径①有意卸载 | 1 条 | 关光所有页 → 层与 `<webview>` **必须**一起消失（正向断言"有意路径"） |
| ⑦ 样式红线 | 1 条 | `.browserLayer` / `.browserPanel` / `.browserPanel__stage` 的 CSS 规则里不许出现 `display:none`、`height:0`、`width:0`（排除 `min-height:0`），层上也不许有内联 `display:none` |

**祖先链（golden，由内到外）**：

```
webview.browserPanel__view  ←  div.browserPanel__stage  ←  div.browserPanel
  ←  div.browserLayer  ←  main.middle  ←  div.app  ←  div(#root)  ←  body  ←  html
```

> ★ 链里的 BEM **修饰符**（`--bg` / `--embed` / `--off`）已在比对前归一化。
> 理由：它们正是「只改看得见多少、不改跑不跑」的实现方式，**有意变化**；
> 算进 golden 会让每次正常切视图都假红。而**块/元素名**照旧逐字节比 ——
> 多加一层 wrapper、把面板塞进别人 children，都会立刻现形（见 §4 的 R1/R2/R3）。

## 3. 硬规则的准确表述（★ 这条判断在本片被确认）

> **除了三条有意路径** —— ① `allTabs` 归零（关光所有页）、② 该页进入**深休眠**、
> ③ `key={t.id}` 变化 —— **之外**，`<webview>` 的祖先链与节点身份必须逐字节不变。

- 写成「webview 永远不卸载」是**错的**，按那种写法测会在这三条上**假红**（侦查报告 §4.2 已列出）。
- 本片对路径 ① 做**正向断言**（关光页就必须卸载）；② 与 ③ 无法在 jsdom 里稳定触发，
  由 `panel-visibility-coupling-probe.py`（CSS 层）与 M5'/M6' 的 DOM 断言继续守。

## 4. 反证：4 种真实搬错方式，必须全红

脚本：`scripts/verify/app-shell-smoke-revert.py`（先确认基线绿 → 注入 → 必须非 0 → 命中断言 → 还原 → md5 校验）

| # | 注入的错 | 结果 | 命中 |
|---|---|---|---|
| R1 | 在 `<BrowserPanel>` 外面**套一层 `<div>`**（"顺手加个布局容器"） | 退出码 1，**15 PASS / 2 FAIL** | `祖先链与 golden 一致`（+ 兄弟关系） |
| R2 | 把浏览器层挂到 `browser.view === 'fullscreen'` 上（切后台就卸载） | 退出码 1，**13 PASS / 4 FAIL** | `切浏览器视图（全屏 ↔ 后台）不换 webview 元素` |
| R3 | 给 `<BrowserPanel>` 加 `key={browser.view}`（切视图即重建） | 退出码 1，**15 PASS / 2 FAIL** | `切浏览器视图（全屏 ↔ 后台）不换 webview 元素` |
| R4 | `.browserLayer { display: none }`（用 display 藏，而不是 opacity） | 退出码 1，**16 PASS / 1 FAIL** | `styles.css 里 .browserLayer / .browserPanel__stage 没有 display:none / 0 尺寸` |

**结论：4/4 咬住**；每次还原后 `apps/desktop/src/App.tsx` / `styles.css` 的 md5 逐字节一致。

### ★★ 反证当场抓出一个"假网"（这条值得单独记）

第一次做 R1 时，进程**退出码 137（被 OOM 杀掉）**，而不是干净地失败 —— 于是
`4/4` 变成 `0/4`：网看起来在跑，实际**注入错误时整条网会崩掉**。

根因：断言里把 **jsdom DOM 元素**直接交给了 `assert.equal(a, b)`：

```ts
assert.equal(panel?.parentElement, vis?.parentElement, '两者不再是兄弟');
```

失败时 Node 要为错误信息 `inspect()` 这两个元素 —— jsdom 的元素图**环状且巨大**，
inspect 直接吃光内存 → 进程被杀。基线绿的时候它永远不会走到那一步，所以**只有反证能发现**。

修法：DOM 元素一律用 `assert.ok(a === b, 人话)`（自己拼消息），不把元素对象交给断言库。
同类隐患一并扫掉（`assert.equal(q('.browserLayer'), null, …)` → `assert.ok(… === null, …)`），
共 3 处。**这也是"必须写反证"这条规矩的又一次兑现**：只跑一次绿，等于没测。

## 5. 树干净（产品代码零改动）

| 文件 | HEAD 的 md5 | 工作区的 md5 |
|---|---|---|
| `apps/desktop/src/App.tsx` | `2051547a791c2e6ff46426245db98094` | 同左 ✅ |
| `apps/desktop/src/styles.css` | `b77759716631eed69877f84c2f22b52f` | 同左 ✅ |

## 6. 本片新增/改动

| 文件 | 说明 |
|---|---|
| `scripts/verify/app-shell-smoke.mts` | esbuild driver（CSS 置空、包依赖 external、产物落 `node_modules/.cache/`） |
| `scripts/verify/app-shell-smoke.run.tsx` | jsdom 挂载 App + 17 条断言 + 桥/fetch 桩 + golden 比对 |
| `scripts/verify/app-shell-smoke-revert.py` | R1–R4 反证 |
| `docs/acceptance/app-shell/webview-ancestor-chain.golden.json` | **golden 本体**（只有显式 `--update-golden` 才会重写，绝不"文件不在就自动写"） |
| `package.json` | 新增 `verify:shell`；并把它接到主链 `npm run verify` 末尾 |
| `scripts/verify/frontend-inventory.py` | 结构普查（侦查报告 §1/§3 每个数字的可复跑来源） |

## 7. 本片顺手堵的一个真窟窿（与 M0 同批）

**`workbench-ui` 在这个仓库里本来编译不起来。**

- 根 `.gitignore` 第 2 行的 `data/` 是**全局通配**，把 `workbench-ui/src/data/` 整个吞了 ——
  `App.tsx` / `Sidebar` / `Rail` / `InputBar` / `lib/storage.ts` 共 **5 处 import 全断**
  （`contacts.ts` 在作者本机存在，但永远提交不上来）。
- 该文件还缺 **`MODELS` / `MODEL_LABEL` 两个导出**（`InputBar` 用）。
- 修法：`.gitignore` 改成 `/data/`（只锚定仓库根）+ **从已入库的构建产物
  `workbench-ui/dist-single/index.html` 里逐字段恢复**（6 个联系人 + 9 个模型 + 中文名表）。
  可复跑校验：`python3 scripts/verify/workbench-ui-recover-contacts.py` → **逐字段一致**。
- 证据：`cd workbench-ui && npm run typecheck` **通过**、`npm run build` **`✓ built in 1.13s`**
  （修之前是 `TS2307` + `TS2305`）。

> 这件事的教训与仓库一贯口径一致：**"我以为它在版本库里"和"它真的在版本库里"是两件事**。
> 顺带说明：这次恢复**不是猜的** —— 每个字段都能在已入库的产物里指出来。

## 8. 复跑命令

```bash
npm install                                    # 沙箱每回合清 node_modules
npm run verify:shell                           # 17 PASS / 0 FAIL
npm run verify:shell -- --update-golden        # 仅在**确认**结构变更是有意的时候用
python3 scripts/verify/app-shell-smoke-revert.py   # 4/4 咬住
python3 scripts/verify/frontend-inventory.py       # 结构底数
python3 scripts/verify/workbench-ui-recover-contacts.py   # workbench-ui 数据缺口（逐字段一致）
cd workbench-ui && npm install && npm run typecheck && npm run build
```

## 9. 下一片（M1'）的开工条件（已满足）

- 网在：`verify:shell` 17/0，且已接进主链。
- 反证有效：R1–R4 全红，且**已排除"注入即崩"的假网**。
- 每条切片的检查项（用户定，逐片执行）：
  1. **搬组件必须连同它对应的编号 CSS 一起搬**，不要混；
  2. `browser/` **一行不动**；
  3. 13 个 ref 里 **7 个是"最新值镜像"** —— Provider 化后**不能删**（Provider 同样是闭包语义）；
  4. 4 个后代选择器（`.inputBar input` / `.inputBar button` / `.authCard h3` / `.guide__table th,td`）
     会**抓住新塞进去的组件** —— 每搬一个组件都要检查有没有被打中；
  5. `.msg` 双重定义（`styles.css` 10px vs `channels/styles.css` 6px，胜负取决于打包顺序）
     在 **M5' 搬 chat 时一并修掉**，并加断言。
