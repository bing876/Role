# 收尾 7 验收报告 · H 电脑可见度接线 + I 模型真路由

- 日期：2026-09-24
- 分支：`arena/01a0d0a8-role`（基线 `ac75d63`，上一批 `ad3ae0b`）
- 用户拍板：I 必须**真路由**（简单/复杂选不同模型；未配复杂模型则回落 CHAT 且如实说明），
  验收必须证明「两条路选出的 `model` 字段真的不同」。
- 结论：**H 与 I 都不再空转**。H 快层 40/0、H 真库端到端 26/0、I 31/0；
  变异反证 H 9 处 + I 6 处 + 探针 6 处**全部变红**；全量 `npm run verify`、`npm run typecheck`、
  `npm run verify:db` 均 EXIT 0。

---

## 0. 这两批「空转」到底空在哪（先说病灶，再说改法）

### H（电脑三级可见度）—— 交付时全绿，实际一行没生效

批次 H 当年的验收只有 `readFileSync + includes`，甚至断言了一句字面量
`useState<ComputerVisibility>(propVisibility ?? 'status')`。于是下面四件事**一件都没被咬住**：

| # | 病灶 | 后果 |
|---|---|---|
| 1 | `ComputerVisibility` 只被 `export`，**App.tsx 里根本没渲染** | 用户在界面上找不到这个开关，三档一次都没生效过 |
| 2 | 持久化打的是 `fetch('/api/agents/:id/visibility')`，而服务端注册的是 `/agents/:id/visibility` | 恒 404，档位存不上也读不回 |
| 3 | token 自己摸 `localStorage.getItem('token')`，桌面真实的 key 是 `workbench.token` | 恒等于没带 token → 401 |
| 4 | 从来不 GET 回已存档位；`status` 档还提前 `return`（不渲染 children） | 重开应用丢偏好；一旦挂上去，用户一收起就把**正在跑的那张页**卸载 |

第 4 条里「children 提前 return」尤其危险：`<webview>` 换父节点会被 React 卸载重建，
驾驶算出来的点击坐标全部作废（`styles.css` 里 `.browserLayer--bg` 的注释写的就是这个坑）。

### I（模型路由）—— 日志看着像路由了，模型一次都没换

`resolveModelForTask` 的 `case 'chat'` 里，简单与复杂两个分支的 `model` **都写 `chatModel`**，
只有 `reason` 文案不同。日志里出现「复杂闲聊，路由到推理模型」，上游收到的却还是同一个模型名。

---

## 1. 改了什么

### H

| 文件 | 改动 |
|---|---|
| `apps/desktop/src/browser/ComputerVisibility.tsx` | 整份重写：导出 `visibilityUrl(apiBase, agentId)` / `loadVisibility(...)` / `saveVisibility(...)` / `VISIBILITY_LEVELS` / `formatToolForVisibility`。**无 `/api` 前缀**、**不摸 localStorage**（apiBase 与 token 由调用方给）；读失败一律回 `null`，**绝不回落 `'status'`**；children 恒在同一个 `__host` 宿主里，三档只改宿主周围那圈 chrome；接管档由「全屏黑遮罩」改成**不挡视线的横幅** |
| `apps/desktop/src/browser/index.ts` | 把上面这些导出补进桶文件 |
| `apps/desktop/src/browser/styles.css` | 接管档 `position:fixed; inset:0` 的黑遮罩 → 非阻断的 `__takeoverBanner`；新增 `__host`（`flex:1 1 auto; min-height:0`）与 `__host:empty`（用 `flex:0 0 auto` 归零，**不是** `display:none`）；删掉死规则 `__previewBrowser`；合并重复的根规则 |
| `apps/desktop/src/App.tsx` | 真的渲染组件（`browserLayer` 里、`BrowserPanel` 的**兄弟**节点）；新增 `computerVisibility` 状态、换人/换登录态时读回档位的 effect、`onChangeComputerVisibility` 处理函数；喂给组件的是**真数据**（智能体状态行 + 主进程报上来的最后一条步摘要 + 当前页标题） |
| `apps/server/src/routes/computerVisibility.ts` | 未改动（本来就对）：GET/POST `/agents/:id/visibility`，三档白名单 + 归属校验 |

两条刻意的设计边界（都写进了断言，谁改谁红）：

1. **可见度只改「看得见多少」，绝不改「跑不跑」**：切档不调 `/agent/loop/*` 的任何接口，
   不碰 `agentStop` / `agentDrop` / `browserThrottle`。
2. **面板与组件是兄弟，不是父子**：把 `BrowserPanel` 塞进 `children` 就等于「切档时 webview 换父节点被重建」。
   组件内部已经保证「children 恒在同一宿主」，App 这边再保守一层，两条一起保证。

### I

| 文件 | 改动 |
|---|---|
| `apps/server/src/modelRouter.ts` | `case 'chat'` 真路由：复杂闲聊配了 `DEEPSEEK_MODEL_CHAT_COMPLEX` 就选它；没配则回落 `DEEPSEEK_MODEL_CHAT`，且 `reason` **如实写「回落快速模型（没有换模型）」**；`MODEL_ROUTING_ENABLED=0` 仍是一键退回默认模型 |
| `apps/server/src/llm.ts` | 沿用 `getModelForTask` / `inferTaskKindFromTag`（未改动逻辑） |

---

## 2. 验收：两份脚本，一份快、一份真

### 2.1 `npm run verify:visibility` —— 快层（不需要库）：**PASS 40 / FAIL 0**

`scripts/verify/computer-visibility.mts`。**真调桌面本体导出的那三个函数**（用假 fetch 截住，
验地址、方法、鉴权头、请求体、返回口径），不是验「源码里出现过这些字」：

| 节 | 验什么 | 条数 |
|---|---|---|
| ① | `visibilityUrl` 与服务端注册的路由逐字对得上；无 `/api`；尾斜杠不拼出双斜杠；三档与服务端白名单一致 | 4 |
| ② | `loadVisibility`：GET + `Bearer`；404/401/500/非法值/缺字段一律回 `null`；fetch 抛错不冒到界面；没有 `agentId` 时**一个请求都不发** | 10 |
| ③ | `saveVisibility`：POST + `content-type` + `Bearer` + `{visibility}`；失败回 `false`；档位非法自己就拒（不发请求） | 6 |
| ④ | 组件本体的安全不变量：**代码行**里不许有 `/api/`、不许摸 localStorage；children 不许被某一档提前 `return` 丢掉；宿主只许出现一次（三档共用）；不碰 loop 控制接口；默认档位仍是 `status` | 5 |
| ⑤ | 接线：App.tsx **真的渲染**了组件；传了 `apiBase={API_BASE()}` 与 `token`；是 `BrowserPanel` 的**兄弟**节点；切档只碰视图；读档「读不到就不动」；喂的是真数据 | 7 |
| ⑥ | CSS：宿主不许 `display:none`/尺寸归零（`min-height:0` 是 flex 常规写法，先剔掉再判）；空宿主用 `flex-basis` 归零；接管档不再是全屏黑遮罩；三档类名齐；根规则 `flex:0 0 auto` 不跟面板抢空间 | 5 |
| ⑦ | 服务端路由的白名单/归属/400（**真库往返不在这份里假装验过**，见 2.2） | 3 |

> ④ 那节只查**代码行**：把注释行剔掉再断言。这个文件的注释里本来就要写清「老版本打的是 `/api/…`」
> 「不调 `/agent/loop/…`」—— 拿全文做 `includes` 会把历史说明当成违规（这份脚本第一遍跑就是这么假红了一次）。

### 2.2 `npm run verify:visibility:e2e` —— 真后端 + 真 Postgres + 桌面本体函数：**PASS 26 / FAIL 0**

`scripts/verify/computer-visibility-e2e.mts`（先 `build` shared+server，再自己起后端于 `127.0.0.1:8795`，
打真库 `postgres://postgres:***@127.0.0.1:55432/verifydb`）。

关键设计：**用桌面自己的函数去打真路由**（`import { loadVisibility, saveVisibility, visibilityUrl }`
直接来自 `ComputerVisibility.tsx`）。这样「前端拼的地址」与「后端注册的路由」对不上时会当场红 ——
正是当年 404/401 的形状。

| 节 | 结果（节选，逐条见下方取证） |
|---|---|
| V0 | 拿到当前项目的智能体：`projectId=68, agentId=97`（★ `GET /agents` 不带 `projectId` 会回所有项目的名单） |
| V1 | GET → `{visibility:'status'}`；**回真库查那一列**也是 `status`（不是接口现编的默认值） |
| V2 | `visibilityUrl('',97)` = `/agents/97/visibility`；`loadVisibility` 真读回 `status`；`saveVisibility('takeover')` → `true`，**库里那一列变成 `takeover`**；再读一次仍是 `takeover`（存读同口径，重开应用能恢复） |
| V3 | 三档轮一遍：`preview/status/takeover` 都 200 且库里逐一对上；非法档位 `fullscreen` → **400**（话里列出合法三档），库里仍是上一个合法值；不带 `visibility` → 400 |
| V4 | 不带 token → **401** 且库里没被改；**另一个测试账号**改这个智能体 → **404**（不泄漏存在性）且库里没被改，连读也 404；不存在的智能体 → 404 |
| V5 | token 无效：`loadVisibility` → `null`（不是 `status`）、`saveVisibility` → `false`，库里没被改；无 `agentId` → `null`；后端连不上 → `null`；档位非法 → `false` 且不发请求 |
| Z1 | **两个测试账号跑完整体删除**（`2/2`），活库里既有账号一行没碰 |

取证文件：`docs/acceptance/visibility/visibility-e2e.json`（可再生，已进 `.gitignore`），本次内容：

```json
{ "at": "2026-09-24T06:08:51.328Z", "base": "http://127.0.0.1:8795",
  "db": "postgres://postgres:***@127.0.0.1:55432/verifydb", "pass": 26, "fail": 0, "failures": [],
  "evidence": { "summary": { "account": "#63", "secondAccount": "#64", "projectId": 68, "agentId": 97,
    "finalDbVisibility": "takeover",
    "desktopHelpers": { "urlNoBase": "/agents/97/visibility",
      "urlWithBase": "http://127.0.0.1:8795/agents/97/visibility", "loaded": "takeover" } } } }
```

### 2.3 `npm run verify:routing` —— I 真路由：**PASS 31 / FAIL 0**

`scripts/verify/model-routing.mts`（9 节 ①-⑨，真 import 生产模块，`withEnv` 存/还原环境变量）。要点：

- **①-2：简单闲聊与复杂闲聊选出的 `model` 字段真的不同**（`DEEPSEEK_MODEL_CHAT` vs `DEEPSEEK_MODEL_CHAT_COMPLEX`）—— 用户拍板要的那条证明。
- ②-2：未配 `DEEPSEEK_MODEL_CHAT_COMPLEX` 时回落 CHAT，且 `reason` **不许**再声称「路由到推理模型」。
- ⑦：分类器口径按**代码真实的优先级**钉死 —— `isSimple` 先看 `text.trim().length < 10`，
  所以 8 个字的「帮我分析这份数据」判**简单**（关键词在后，压根没轮到）；≥10 字且含关键词才判复杂。
  ⑦-4 专门钉这条长度边界，改优先级的人会先红。
- ⑧：`MODEL_ROUTING_ENABLED=0` 一律回 `deepseek-chat`；且不许有「拿 `env.deepseekModel` 覆盖路由结果」的回头路。
- ⑨：`inferTaskKindFromTag` 的 tag → taskKind 映射逐条对。

> 这份脚本第一遍跑是 29/1：红的是**断言写错了**（⑦-1 以为「有分析关键词就该判复杂」），不是生产代码错。
> 修法是让断言如实编码代码的优先级，而不是去改生产代码迁就断言。

---

## 3. 变异反证（把代码改回「空转」的样子，验收必须红）

★ 纪律：注入期间**只改产品代码，绝不动断言**；每处注入跑完立刻还原，并复核 md5 + `git status` 与注入前逐字节一致。

### 3.1 H —— `python3 scripts/verify/computer-visibility-revert-proof.py`：**9/9 RED，还原干净**

| 注入 | 坏法 | 结果 | 红在哪 |
|---|---|---|---|
| HV1 | App.tsx 里不渲染组件（H 空转的主症状） | RED | ⑤-2 |
| HV2 | fetch 地址加回 `/api` 前缀 | RED | ①-1/①-2 |
| HV3 | token 改回自己摸 `localStorage.getItem('token')` | RED | ②-3 + ④-1 |
| HV4 | 读不到档位时回落 `'status'` | RED | ⑤-6 |
| HV5 | 收起档提前 `return`（丢掉 children） | RED | ④-2 |
| HV6 | 宿主 `display:none` | RED | ⑥-1 |
| HV7 | 切档顺手把任务停了 | RED | ⑤-5 |
| HV8 | 把 `BrowserPanel` 塞进 children | RED | ⑤-4 |
| HV9 | 默认档位改成 `takeover` | RED | ④-4 |

还原核对：`component 6af13e8a…` / `app 2051547a…` / `css c689b8dc…` 三个 md5 与注入前一致，
`git status --porcelain` 与注入前**逐字节一致**。

> 这九处坏法，**旧验收（`includes` 那版）一处都咬不住** —— 这就是 H 能空转一整批的原因。

### 3.2 I —— `python3 scripts/verify/model-routing-revert-proof.py`：**6/6 RED，还原干净**

| 注入 | 坏法 | 结果 |
|---|---|---|
| RV1 | 复杂档的 `model` 改回 `chatModel`（真路由退回空转） | RED |
| RV2 | 回落分支的 `reason` 谎称「路由到推理模型」 | RED |
| RV3 | kill-switch 失效（`enabled` 恒 `true`） | RED |
| RV4 | `isSimple` 恒 `false` | RED |
| RV5 | `isComplex` 恒 `false` | RED |
| RV6 | `inferTaskKindFromTag` 把 chat 认成 tool | RED |

还原核对：`router 3439d9d8…` md5 一致，`git status` 逐字节一致。
RV1 与 RV2 是一对：RV1 钉「真的换了模型」，RV2 钉「没换的时候不许装作换了」。

### 3.3 顺手修好的旧探针：`panel-visibility-coupling-probe.py` **11/15 → 15/15**

那份「可见性 × 任务执行」静态探针有 4 条断言还停在第 25 步之前的机制上（180px / 56vh / `expanded`），
一直在**假红**（D3 还把 `min-height: 0` 这个 flex 常规写法当成「0 尺寸」）。已按当前机制重写：

- A2：`expanded` 这套机制**已整个退场**（0 处引用）—— 谁再把它请回来当逻辑开关，这条立刻红。
- D1：舞台不写死高度，由 flex 撑开（`flex:1 1 auto` + `min-height:0` + `width:100%`）。
- D2：没有任何规则给舞台写死 `height`，`--expanded` 覆盖已不存在。
- D3：判「真 0 尺寸」之前先剔掉 `min-height: 0`。

配套反证 `panel-visibility-coupling-revert.py` 的缺陷①锚点也过期了（找的还是 `height: 180px` 那段），
已改成三处注入（写死 0 高度 → D2 红；`display:none` → D3 红；改回写死高度 → D1 红），
加上原有的 ②③④，**6 处缺陷全部被探针抓到**。

---

## 4. 全量

| 命令 | 结果 |
|---|---|
| `npm run verify` | **EXIT 0**（主链里已含 `verify:visibility` 40/0 与 `verify:routing` 31/0；`verify:redact` 70/0、批次 J 三份、收尾6 pglite 56/0 等照旧全绿） |
| `npm run typecheck` | **EXIT 0**（shared + desktop + server） |
| `VERIFY_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/verifydb npm run verify:db` | **EXIT 0**（真库；收尾6 的 mismatch 两行照旧「两份都留 + warn 列出 id」） |
| `npm run verify:visibility:e2e` | **PASS 26 / FAIL 0**（真后端 + 真库；测试账号 2/2 删净） |

> 注：`verify:db` 要的是 `VERIFY_DATABASE_URL`（不是 `DATABASE_URL`）；
> 项目里没有 `verify:typecheck` 这个脚本名，正确的是 `npm run typecheck`。

---

## 5. 复跑命令

```bash
# H（快层，不需要库）
npm run verify:visibility

# H（真后端 + 真 Postgres；会先 build shared+server，端口 8795）
npm run verify:visibility:e2e

# I（真路由）
npm run verify:routing

# 变异反证
python3 scripts/verify/computer-visibility-revert-proof.py
python3 scripts/verify/model-routing-revert-proof.py
python3 scripts/verify/panel-visibility-coupling-revert.py

# 静态探针（只读）
python3 scripts/verify/panel-visibility-coupling-probe.py

# 全量
npm run verify && npm run typecheck
VERIFY_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/verifydb npm run verify:db
```

---

## 6. 已知边界（如实记，不假装都验过了）

1. **界面像素没验**：三档在真实窗口里长什么样（横幅位置、收起态高度观感）要等用户给 HTML/CSS 再做 1:1，
   这一批只保证「机制通、尺寸不归零、不卸载 webview」。
2. **`formatToolForVisibility` 的文案**只做了几条已知工具名的形状检查，没有穷举全部工具。
3. **e2e 不打模型**：可见度与任务执行无关，这一批刻意不起桩模型；「切档不影响跑任务」由
   ④-3 / ⑤-5 两条断言 + HV7 反证钉住，不是靠一次跑通的观感。
4. 服务端路由 `computerVisibility.ts` 本批**未改动**；它的行为由 V1-V4 在真库上重新验过一遍
   （含归属 404、非法值 400、未登录 401），不再只有源码文本断言。
