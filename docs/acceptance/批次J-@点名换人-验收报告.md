# 批次 J · `@点名` 中途拉人 —— 验收报告

日期：2026-09-24　分支：`arena/01a0d0a8-role`　基线：远端 `main` = `ac75d63`
上一批（收尾 6 + 补丁）已 push 到 `43c6067`；本批 J1（解析器）已 push 到 `aa534b7`。

---

## 0. 一句话结论

会话中途打 `@研究员 帮我看看这组数据`，**这一轮就由研究员开口**（用它自己的人设/项目记忆/技能，
但仍看得到这条会话的前文），这句话在库里记着「是谁说的」，`/chat/history` 与 SSE `meta` 都能把发言人交回界面；
被点名者正忙时**不静默改派**，而是回一句人话告诉用户它在做什么、要不要等或换人；
`@` 的就是当前发言人时按「没写 @」处理；交给模型的正文一律剥掉 `@名字`。

四层验收全绿：**解析器 41/0、决定层 41/0、渲染层 35/0、真机端到端 67/0**（合计 184 项）；
`npm run verify` / `npm run typecheck` / `npm run verify:db`（真库）三个 EXIT 全 0；
6 处变异注入全部把对应断言打红，且还原后 md5 与 git status 逐字节一致。

---

## 1. 交付内容

| 文件 | 干了什么 |
| --- | --- |
| `packages/shared/src/mention.ts`（J1，已 push `aa534b7`） | 唯一的解析实现：`parseMention(text, roster, currentAgentId?)` + `mentionSummary()`（日志用，永不带正文）。本批新增 `tidy()`：摘掉 `@名字` 后只压空格/制表符，**换行原样保留** |
| `packages/shared/src/index.ts` | 导出 `ChatSpeaker`（`{id,name}`）、`ChatRow.speaker?`、`ChatMentionMeta`，`meta` 事件负载加 `mention?` |
| `apps/server/src/orchestrator/mention.ts` **（新）** | 服务端决定层：`loadMentionRoster`（当前项目名单，与「委派同事」同一份名字口径）、`resolveChatMention`（→ `none/self/switch/busy/empty` 五种决定）、`decisionNotice`、`decisionSpeaker`、`pickNoticeSpeaker`（那句告知由谁开口） |
| `apps/server/src/db.ts` | `messages` 加 `speaker_agent_id BIGINT NULL REFERENCES agents(id) ON DELETE SET NULL` + 索引（照 `sources` 那列的幂等 `ADD COLUMN IF NOT EXISTS` 写法） |
| `apps/server/src/routes/chat.ts` | 点名解析接进 `/chat/stream`（在路由闸之后、开会话之前，**不受**「新会话才路由」限制）；换人轮改用被点名者的人设/记忆/技能；模型只收剥过 `@` 的正文；5 处助手写入全部记 `speaker_agent_id`；4 处 SSE `meta` 全部带 `mention`；`/chat/history` 回 `speaker:{id,name}`；换人轮不进工具循环 |
| `apps/desktop/src/mentionGate.ts` **（新）** | 渲染层唯一一处点名判定：`mentionRosterOf` / `parseLocalMention` / `shouldFallbackLaunch`（第 21 步那道兜底发车闸）。按**源码相对路径**引 shared，Vite 内联进产物 |
| `apps/desktop/src/App.tsx` | 消息模型加 `speaker`；历史映射带上；流式结束按 `meta.mention` 挂发言人；气泡上「换人那一句」挂名字牌（`msg__speaker`，版式最小、className 留给 1:1 还原）；兜底发车改走 `shouldFallbackLaunch` |
| `apps/desktop/vite.config.ts` | `server.fs.allow: ['../..']`（渲染层要 import 仓库根下的 shared 源码，别让 dev 起不起得来取决于 Vite 猜不猜得到 workspace 根） |
| `scripts/verify/mention-decision.mts` **（新）** | 决定层验收 41 项 → `npm run verify:mention:decision` |
| `scripts/verify/mention-desktop.mts` **（新）** | 渲染层验收 35 项（含接线断言）→ `npm run verify:mention:desktop` |
| `scripts/verify/mention-e2e.mjs` **（新）** | 真后端 + 真 Postgres + 桩模型端到端 67 项 → `npm run verify:mention:e2e` |
| `scripts/verify/mention-revert-proof.py` **（新）** | 6 处变异注入 + md5/git status 还原核对 |
| `scripts/verify/mention-parse.mts` | J1 那份，本批加了第 ⑨ 段（换行不被抹掉）与第 ⑩ 段（shared 的 dist 不许「半份跟踪」，见 §7.5）→ 41 项 |
| `package.json` | `verify:mention` = parse + decision + desktop（在 `verify` 主链里，紧跟 `verify:redact`）；`verify:mention:e2e` 单独一条（要真库 + build） |
| `scripts/verify/mem-merge-batch2.mjs` | 两条咬字面量的老断言升级成「抓出所有 `buildMemoryBlock` 调用、逐个看最后一个实参」（要求没变，见 §7.4；变异 M6 证明它照样咬得住） |

---

## 2. 规则 → 实现位置 → 验收编号

| 规则 | 实现 | 验收（层级·编号） |
| --- | --- | --- |
| 1 名单精确匹配（不是子串/模糊） | `mention.ts` `sorted.find(startsWith)` | 解析器 ①②；端到端 T7.1/T7.5 |
| 2 邮箱里的 `@` 不算 | `EMAIL_LOCAL_CHAR` 左邻判定 | 解析器 ②；端到端 T6.1–T6.3 |
| 3 最长名优先（`研究员助手` 不被 `研究员` 抢走） | 名单按名字长度降序、同长按 id 升序 | 解析器 ③ |
| 4 跨项目不生效 | `loadMentionRoster` 只查 `currentProjectId` 的名单 | 端到端 T7.1–T7.7（真库真接口） |
| 5 **拍板1**：`@` 必须紧跟名字（`@ 研究员` 不算） | `src.startsWith(n, i+1)` | 解析器 ⑤；决定层 ⑤；渲染层 ③；端到端 T5.1–T5.5 |
| 6 **拍板2**：只有第一个命中是发言人，其余进 meta 列表 | `mentions[0]` → speaker；全量 → `meta.mention.hits` | 解析器 ⑥；决定层 ⑥；端到端 T1.3/T1.4 |
| **R-A** 被点名者忙/等 → 不静默改派，回一句「在做什么 + 要不要等/换人」 | `BUSY_STATUSES`（working/thinking/waiting）+ `busyPhrase` + notice 文案；`decisionSpeaker` 恒 null | 决定层 ③⑨；端到端 T3.1–T3.10 |
| **R-B** `@` 的就是当前发言人 → 视作没写 @，不报错、不重路由 | `parseMention.selfMention` → 决定 `kind:'self'` | 决定层 ②；端到端 T2.1–T2.5 |
| **R-C** 交给智能体的正文剥掉 `@名字` | `tidy()` 按 span 从后往前摘；chat.ts 的 `mentionText` 贯穿模型正文/记忆/技能/知识库/任务 goal | 解析器 ④⑨；端到端 **T1.6（桩模型截到的真实请求体）**、T2.4 |
| R-C 边界：整条只有 `@名字` → 不调模型，反问 | `textEmpty` → `kind:'empty'` + notice | 决定层 ④；端到端 T4.1–T4.5（桩请求数 = 0） |
| 记发言人 | `messages.speaker_agent_id`（5 处助手写入） | 端到端 T0.5、T1.9、T9.1–T9.3（真库 SELECT） |
| 历史返回发言人 | `/chat/history` LEFT JOIN agents，名字口径 = `persona.name || agents.name` | 端到端 T0.6、T1.10、T8.1–T8.3 |
| SSE meta 带 mention | 4 处 `meta` 帧全部带（含三条早退分支） | 端到端 T0.2、T1.2、T5.1；渲染层 ⑥ |
| 本轮不启动浏览器循环 | `mentionSwitchRound` → `isTaskMode=false`；桌面兜底也闸住 | 端到端 T1.8/T3.7；渲染层 ③；决定层无 |
| 界面看得出换了人 | 气泡名字牌（只在换人那一句上挂） | 渲染层 ⑤（接线断言） |

---

## 3. 关键设计决定（**这几条请用户过一眼**，要改都是一行的事）

1. **`@` 是「这一轮换人说话」，不是「把会话转给别人」。**
   `conversations.agent_id`（会话归属）**不动**：换人轮由被点名者开口并落 `speaker_agent_id`，
   下一轮不带 `@` 就回到会话原本那位。理由：改会话归属等于把用户和「小助」那条聊天悄悄变成别人的，
   那是另一种静默改派；而且任务态（`current_task` 等）挂在会话上，跟着换主人会串。
   *（若用户要「@ 之后一直由它答」，改一行：换人轮顺手 `UPDATE conversations SET agent_id`。）*
2. **换人轮不进工具循环（不发车）。** 工具循环认的是**会话自己的** `agent_id`、`wcId`、页面状态与循环名额，
   让被点名者去接管别人正在跑的那张页才会出乱子。换人轮走聊天路径（自带 `web_search`），桌面侧兜底也不发车。
3. **`blocked` 不算忙。** `resolveAgentStatus` 把「循环 paused / stopped / failed」都归到 `blocked`（那是**头像**语义：
   「这条循环需要你来看一眼」），它并不代表腾不出手。把 `blocked` 当忙的后果是
   「一个智能体只要停过一次循环，五分钟内就再也点不动它」—— 这条是端到端 T3.10 **打红之后**改的（见 §7.3）。
4. **库里存原文，模型收剥过的正文。** 用户气泡必须显示他真打了什么（含 `@名字`），
   模型那边 `@名字` 只是点名、不是任务内容。两件事分开做，谁也不迁就谁。
5. **老数据不回填、不猜。** `speaker_agent_id` 为 NULL 的行（本批之前入库的、以及 user 行）历史里回 `undefined`，
   界面**不挂名字牌**，绝不拿「会话当前智能体」冒充（冒充就等于把「换过人」这件事抹掉）。
6. **那句「告知」由谁开口。** R-A（忙）那一轮**绝不能**由被点名的正忙者开口（替它说话 = 又一次静默改派），
   顺序是：会话当前发言人 → 请求/路由带来的那个 → 项目管家 → 名单里任何一个不是它的人 → 都没有就 NULL；
   R-C 边界（只写了 `@名字`）相反，**优先让被点名者自己问**「你要我做什么」（它此刻不忙，最自然）。

---

## 4. 验收结果

### 4.1 四层

| 层 | 脚本 | 命令 | 结果 |
| --- | --- | --- | --- |
| J1 解析器（两端同一份实现） | `scripts/verify/mention-parse.mts` | `npm run verify:mention:parse` | **PASS 41 / FAIL 0** |
| J3 服务端决定层（R-A/R-B/R-C） | `scripts/verify/mention-decision.mts` | `npm run verify:mention:decision` | **PASS 41 / FAIL 0** |
| J4 渲染层（闸门 + 接线） | `scripts/verify/mention-desktop.mts` | `npm run verify:mention:desktop` | **PASS 35 / FAIL 0** |
| J5 真机端到端（真后端 + 真 PG + 桩模型） | `scripts/verify/mention-e2e.mjs` | `npm run verify:mention:e2e` | **PASS 67 / FAIL 0** |

### 4.2 全量

| 命令 | 结果 |
| --- | --- |
| `npm run verify`（主链，含 redact 57、mention 41+41+35、tools、r4、orch 全套、websearch、memory、persona、collab、batches、pglite 56） | **EXIT 0** |
| `npm run typecheck`（shared + desktop + server 三个 workspace） | **EXIT 0** |
| `VERIFY_DATABASE_URL=… npm run verify:db`（真库 checkpoint/board/task 加密 + pglite） | **EXIT 0**，PASS 行 171、FAIL 行 0 |

日志留在沙箱 `/home/user/verify-logs/`（工作区外，随沙箱回收）；关键数字与逐条输出已抄进本报告。

### 4.3 端到端为什么用桩模型（不是偷懒，是**只有这样才能证明 R-C**）

R-C 要证明的是「**模型实际收到的正文**里没有 `@名字`」。真模型的回复内容抖动，证明不了它收到了什么；
桩把每一次上游请求的 body 原样记进 `docs/acceptance/mention/stub-llm-requests.jsonl`，
于是 T1.6 直接拿「最后一次请求里最后一条 user 消息」与 `'帮我看看这组数据'` 精确相等。
另外 R-A（忙）与 R-C 边界（只写 `@名字`）这两轮**根本不该调模型**，桩这边「请求数 = 0」就是铁证（T3.3、T4.2）。
桩只替「上游模型」，路由、解析、决定、落库、历史、SSE 全是真的。
忙碌状态也不是假标记：T3 用 `POST /agent/loop/start` 给被点名者建一条**真循环**（生产里让它变忙的正是这条路）。

---

## 5. 端到端逐条取证（真库 `verifydb`，测试账号跑完整体删除）

账号 `186****2567`（本次新建）；名单：小助 `#35`、研究员 `#36`、文案 `#37`、数据分析 `#38`；
第二项目里另建「外协」`#40`。桩模型共收到 **9** 次请求（每一轮该调几次都对得上）。

| 用例 | 发出去的话 | `meta.mention` | 桩模型**实际收到**的正文 | 库里落的发言人 |
| --- | --- | --- | --- | --- |
| T0 基线 | `你好，我们先随便聊聊` | `kind=none, hits=[], speakerAgentId=35` | `你好，我们先随便聊聊`（逐字相同） | `#35 小助`；user 行 speaker = 无 |
| **T1 换人** | `@研究员 @文案 帮我看看这组数据` | `kind=switch, speakerAgentId=36, hits=[36 研究员, 37 文案]` | **`帮我看看这组数据`** | `#36 研究员`（上一句仍是 `#35 小助`）；user 行存**原文**含 `@` |
| T1.7 人设 | 同上 | — | 系统提示词首句 = `你是用户桌面工作台里的一个 AI 智能体（…先用「研究员」）`，**不含**「你是「小助」」 | — |
| **T2 R-B** | `@小助 你觉得呢`（当前发言人就是小助） | `kind=self, speakerAgentId=35, hits=[35]` | `你觉得呢` | `#35 小助`（没重路由、没报错，HTTP 200） |
| **T3 R-A** | `@研究员 再看一眼那份数据`（研究员正在跑循环） | `kind=busy, speakerAgentId=35`（**不是 36**），`notice` 与流里正文逐字一致 | **桩请求数 = 0**（没冒充模型说话） | `#35 小助` 说的这句告知 |
| T3 告知原文 | — | — | — | 「你点的 研究员 此刻正在处理上一轮、还没腾出手（思考中）。我没有把这轮偷偷改派给它，也没有替你另换一个人。你可以：等它忙完再 @ 它一次；或者 @ 别的智能体；或者直接说你要什么，这轮就按现在的会话继续。」 |
| T3.10 反例 | 循环 `stop` 之后同一句话 | `kind=switch, speakerAgentId=36`，桩 1 次 | — | `#36 研究员` |
| **T4 R-C 边界** | `@数据分析`（光秃秃一个点名） | `kind=empty, speakerAgentId=38` | **桩请求数 = 0** | `#38 数据分析` 自己问「你要我做什么」 |
| **T5 拍板1** | `@ 研究员 你好`（`@` 后有空格） | `kind=none, hits=[], speakerAgentId=35` | `@ 研究员 你好`（**一个字没动**） | `#35 小助` |
| T6 邮箱 | `把结论发到 foo@研究员.com 谢谢` | `kind=none, hits=[]` | 原文 | `#35 小助` |
| **T7 跨项目** | 当前项目切到项目2 后 `@小助 你在吗` | `kind=none, unknown=["小助"]` | `@小助 你在吗` | `#35 小助`（会话本来的主人，没换人） |
| T7.5 | 切回项目1 后 `@外协 来一下` | `kind=none, unknown=["外协"]` | — | `#35 小助` |
| T7.7 反例 | 切回项目1 后 `@文案 换你来看` | `kind=switch, speakerAgentId=37` | — | `#37 文案` |
| **T8 老数据** | 把一条助手行的 `speaker_agent_id` UPDATE 成 NULL | — | — | 历史里这一行 `speaker === undefined`（不是 null、不是 0、不是当前智能体），正文一个字没变 |

### 5.1 库里这条会话的完整台账（T9，真库 SELECT）

```
id  role       speaker_agent_id  名字
67  user       NULL              —
68  assistant  35                小助        ← T0 基线
69  user       NULL              —
70  assistant  36                研究员      ← T1 @点名换人
71  user       NULL              —
72  assistant  35                小助        ← T2 R-B（@ 自己 = 没换人）
73  user       NULL              —
74  assistant  35                小助        ← T3 R-A 告知（**不是**正忙的研究员开口）
75  user       NULL              —
76  assistant  36                研究员      ← T3.10 循环停掉后换人成功
77  user       NULL              —
78  assistant  38                数据分析    ← T4 R-C 边界反问（被点名者自己问）
79  user       NULL              —
80  assistant  35                小助        ← T5 拍板1（@ 后有空格，没点名）
81  user       NULL              —
82  assistant  35                小助        ← T6 邮箱里的 @
84  user       NULL              —
85  assistant  35                小助        ← T7.1 跨项目点不到
86  user       NULL              —
87  assistant  35                小助        ← T7.5 跨项目点不到
88  user       NULL              —
89  assistant  NULL              —           ← T7.7 那句（T8 把它改成「老数据」了）
```

三条收账断言全过：**所有 user 行 `speaker_agent_id` 都是 NULL**；**至少出现过两个不同发言人**
（换人这件事在库里看得见，不是只在界面上画一下）；**没有任何一行指向名单外的智能体**。

---

## 6. 变异反证（把生产代码改坏，验收必须红）

脚本：`scripts/verify/mention-revert-proof.py`（`python3 scripts/verify/mention-revert-proof.py`）。
纪律：注入期间**只改产品代码，绝不动断言**；每处跑完立刻还原，用 md5 逐文件核对，
最后再比「注入前后 `git status --porcelain` 是否逐字节一致」（本批改动静在，所以「树干净」不是正确的不变量）。

| 注入 | 改坏了什么 | 跑哪条验收 | 结果 |
| --- | --- | --- | --- |
| **M1** | `parseMention` 里把命中列表清空 → 永远「谁都点不到」 | `verify:mention:parse` | **RED**：J1 从 41/0 变成 **PASS 23 / FAIL 18** |
| **M2** | 助手落库不再写 `speaker_agent_id` | `mention-e2e --only=T1,T9` | **RED**：`PASS 12 / FAIL 4`（T1.9/T1.10/T1.12 与 T9.2「至少两个不同发言人」全红，T9.2 实测 `[null]`） |
| **M3** | `BUSY_STATUSES` 清空 → R-A 形同废除（正忙的也被硬派活） | `verify:mention:decision` | **RED**：J3 从 41/0 变成 **PASS 32 / FAIL 9** |
| **M4** | `mentionText = message` → R-C 不剥 `@名字`，原文直接喂模型 | `mention-e2e --only=T1,T2` | **RED**：`PASS 16 / FAIL 2`（T1.6/T2.4：桩截到的正文里带着 `@研究员 @文案`） |
| **M5** | 桌面兜底发车摘掉本地那道闸（只信服务端 meta） | `verify:mention:desktop` | **RED**：J4 从 35/0 变成 **PASS 34 / FAIL 1**（正是「流被掐、meta 一个都没回来」那条） |
| **M6** | 闲聊轮记忆检索不传 `convId` | `mem-merge-batch2.mjs` | **RED**：证明 §7.4 里被我升级过的那条老断言**没有变松** |

还原核对（注入前 → 注入后）：

```
parser    87931594f5f6bdc5a51fd81de0b13ac5  一致
chat      91733ee1ff1b87a93c5bdc6bcbf2588d  一致
decision  39873dbc09a0ffd342887b9af39c0117  一致
gate      d0a9c9a02b2f3071e62d3af0cd9f832a  一致
git status（这四个文件）与注入前：逐字节一致
```

---

## 7. 本批顺手抓出的 6 个真问题（都不在计划里，都是读代码 / 跑真链路 / 跑验收撞出来的）

### 7.1 `sseLocal` 把 `\n` 写成 `\\n` —— 「对话式建智能体」的确认句在界面上凭空消失

`chat.ts` 里那两条早退分支（`要建一个「XX」，确认就建？` 与 `已建好「XX」`）各自抄了一份 SSE 写帧函数，
模板字面量里写的是 `\\n` → 输出的是**反斜杠 + n 两个字符**，不是换行。
后果：SSE 帧永远不结束，桌面那头一直buffering，`res.end()` 时把不完整帧丢掉 ——
**用户在聊天里说「建一个数据分析师」，服务端确实建好了、也确实发了确认句，界面上却什么都看不到。**
修法：删掉两份复制品，统一走文件里本来就有的 `sse()`（`\n` 正确）。
与 `@点名` 同一条原则：一份实现，不许各处抄（J1 的第 ⑧ 段防漂移闸就是为此存在的）。

### 7.2 那两条分支的 `done.messageId` 塞的是 `Date.now()`

不是库里那行的 id，而是一个 13 位时间戳。桌面按它记账、刷新后又按真 id 重拉历史 → 两边对不上。
主路径（第 811 行那处）本来就是 `RETURNING id` 再用真 id，这两处是漏改。已统一成真 id。

### 7.3 `blocked` 被当成「忙」→ 智能体停过一次循环，五分钟内点不动（端到端 T3.10 打红）

第一版 `BUSY_STATUSES` 收了 `working/waiting/thinking/blocked` 四态。跑真链路时 T3.10 红了：
`/agent/loop/stop` 之后 `resolveAgentStatus` 返回 `blocked`（detail「已停止」），
于是同一句 `@研究员` 仍然被判成 busy，用户只会得到「它卡住了」—— 而它其实闲着。
根因：`blocked` 是**头像状态**语义（「这条循环需要你来看一眼」，含 paused/stopped/failed），不是「腾不出手」。
修法：`BUSY_STATUSES` 只留 `working/thinking/waiting`，并把理由写在常量上方；
决定层新增第 ⑨ 段用**真的** `startLoop`/`stopLoop` 驱动状态钉住这条（跑着 → busy，停了 → switch）。

### 7.4 `mem-merge-batch2.mjs` 两条老断言咬的是**字面量调用串**（我改实参它就假红）

原断言：`chatContent.includes('buildMemoryBlock(pool, cipher, claims.sub, message, loopAgentId')`。
批次 J 把检索正文换成剥过 `@` 的 `mentionText`、把「按谁取记忆」换成这一轮的发言人
（换人轮必须读被点名者那一份项目记忆，否则第 15 步「绝不串号」在换人之后就破了），字面量散了 → 假红。
它要验的**要求本身一个字没变**：两轮都得把 `convId` 传进去。
修法：升级成「把 chat.ts 里所有 `buildMemoryBlock(...)` 调用抓出来，逐个断言最后一个实参是 `convId ?? null`，
并且任务轮按 `loopAgentId`、闲聊轮按 `turnSpeakerId`」—— 比字面量更严（新增调用点也会被查到）。
**为了不变成「改断言换绿」，加了变异 M6**：把闲聊轮那个 `convId ?? null` 抽掉，升级后的断言照样红。

### 7.5 `packages/shared/dist` 是「半份跟踪」→ 新克隆的服务端**启动即崩**（本批新代码把它引爆）

`.gitignore` 里有 `dist/`，但 `packages/shared/dist/index.js`、`tools.js`（连带 `.d.ts`/`.map`）当年是
`git add -f` 进去的 —— 也就是**部分跟踪**。本批给 shared 新增了 `mention.ts`，
编译出的 `dist/mention.js` 被 `dist/` 规则挡住没进库，而**已跟踪**的 `dist/index.js` 里写着
`__exportStar(require("./mention"))`。

后果：新克隆的仓库如果不先跑 `npm run build -w @ai-workbench/shared` 就起服务端，
`require('@ai-workbench/shared')` 直接 `ERR_MODULE_NOT_FOUND` → **启动即崩**；
而在开发机上永远复现不了（本地 dist 是全的）。这类「只在别人机器上炸」的洞最难查。

修法两步：① `git add -f` 补上 `dist/mention.{js,d.ts,js.map,d.ts.map}`（与既有 index/tools 一致）；
② 在 `verify:mention:parse` 加第 ⑩ 段闸：**只要 dist 里有任何文件被跟踪，磁盘上每个 `.js`/`.d.ts` 就必须都被跟踪**
（反向也查：库里跟踪的必须都还在磁盘上）。理想解是「dist 整份不跟踪、靠 build 生成」，
那要动既有的 index.js/tools.js 与打包流程，不属本批 —— 先用闸把「半份」这个状态挡住，并写清楚为什么。

### 7.6 验收脚本自己的坑：ESM 里写 `require` 被 try/catch 吞成「git 不可用」→ 断言没跑却看着像跑了

第 ⑩ 段第一版用 `const { execFileSync } = require('node:child_process')` 取 git 跟踪清单，
但 `.mts` 是 ESM，没有 `require` → 抛 ReferenceError → 被外层的 `try/catch`（本意是「git 不可用就跳过」）吞掉，
输出「git 不可用 → 这一段跳过（不作数，也不算失败）」，**全绿**。
如果不是顺手看了一眼那行输出，这条闸就等于不存在 —— 这正是最坏的一种假绿：断言没跑，报表却是绿的。
修法：`execFileSync` 改成顶部 `import`；并在脚本里把这条坑写在注释里。
（顺带的教训：「跳过」必须打印出来，且不能与「通过」长得一样 —— 这条已经是本仓验收脚本的既有规矩。）

---

## 8. 怎么复现

```bash
# 0) 依赖与真库（沙箱回收过 node_modules / pgverify 时）
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --no-audit --no-fund
node /home/user/pgverify/start-pg.mjs          # PG 17.10 @ 127.0.0.1:55432，库名 verifydb

# 1) apps/server/.env（gitignore 挡住，永不提交）：
#    DATABASE_URL / JWT_SECRET(≥16) / DATA_KEY(64hex) / PHONE_PEPPER(64hex，≠DATA_KEY) / SMS_MOCK=1

# 2) 三层快验收（不需要库，已挂进主链）
npm run verify:mention            # parse 41 + decision 41 + desktop 35

# 3) 真机端到端（会自己 build shared+server、起桩模型 8898、起后端 8794、建号跑完删号）
npm run verify:mention:e2e
#    或指定库：DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/verifydb node scripts/verify/mention-e2e.mjs

# 4) 变异反证（6 处，跑完自动还原 + md5 核对）
python3 scripts/verify/mention-revert-proof.py

# 5) 全量
npm run verify && npm run typecheck
VERIFY_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/verifydb npm run verify:db
```

取证产物：`docs/acceptance/mention/mention-e2e.json`（逐用例证据）、
`stub-llm-requests.jsonl`（桩模型收到的每一次请求原文，R-C 的物证）、`server-8794.log`。
三者都是**可再生**的，已进 `.gitignore`（照 `r4-acceptance-HEAD.json` 那条既有规矩：
每跑一次就脏一次树的东西不跟踪），要长期留着的数字**抄进本报告**。

---

## 9. 本批没做 / 已知边界

1. **`@` 的补全菜单没做**（打 `@` 弹出名单供选）。本批只做「打得对就认得准」；
   菜单属于界面，等用户的 1:1 设计稿。名字牌同理，只给了最小可读样式 + `msg__speaker` className。
2. **重名**：同项目两个智能体同名时，`parseMention` 按「同长按 id 升序」取小的那个（确定性优先）。
   名单侧 `loadProjectRoster` 也是这个口径，所以「点到的」与「委派到的」永远是同一个。
   真要区分重名，得先让界面能显示/编辑重名 —— 不在本批。
3. **`@` 点名与「对话式建智能体」的优先级**：点名解析在前，
   所以 `@研究员 建一个销售助手` 会先按点名把这一轮交给研究员（若研究员正忙则先回 R-A 告知），
   建智能体的意图检测照旧在其后运行 —— 用户原始需求里那条「`@研究员 建一个销售助手` 要交给研究员」满足。
4. **主进程不解析点名**（Electron 主进程运行时不得 import shared：tsc 直出、打包后没有 `node_modules`，
   启动即崩）。主进程要知道「这轮点了谁」只能读服务端 SSE 的 `meta.mention`。
   J1 的第 ⑧ 段防漂移闸（全仓 `parseMention` 只许有一处定义）继续守着这条。
5. **`packages/shared/dist` 仍是「半份跟踪」**（§7.5）：本批用第 ⑩ 段闸挡住了「新增文件漏进库」，
   但没把 dist 从版本控制里摘出去（那要动打包流程与既有 index.js/tools.js，属另一批的活）。
   长期正解：`git rm --cached packages/shared/dist -r` + 让所有入口都先 build shared。
6. **老数据不回填 `speaker_agent_id`**（决定 5）。若将来要回填，唯一诚实的依据是 `conversations.agent_id`，
   而它只代表「会话归属」，不代表每一句是谁说的 —— 回填等于造证据，所以不做。
