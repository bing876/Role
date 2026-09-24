# 批次 M · 已知 UX 缺陷清单（先记账，不顺手改）

> 规矩（用户 2026-09-24 拍板）：**重构片一个字都不许改产品行为**。
> 在抽逻辑过程中读出来的既有 UX 问题，一律先记在这里，等阶段 1① 收尾（片 7 之后）
> 用一个**单独的小提交**去修，并且那个提交要带**自己的验收 + 反证**。

| 编号 | 现象 | 位置 | 性质 | 状态 |
|---|---|---|---|---|
| F1 | 新建项目后那句「项目「X」建好了（自带一只母鸡），已经切过去。」紧接着被 `loadProjects()` 末尾的 `setProjectNote('')` 清掉 —— 界面上等于**没有确认** | `features/projects/useProjects.ts`（`createProject` → `loadProjects`） | 既有（重构前顺序一模一样，片 4 逐字保留） | ✅ **已修（2026-09-25，独立小提交）**：`loadProjects` 不再动提示文案（清空只发生在每个动作开始时与登出时）。验收：片 4 那条断言**反过来**（成功文案必须留得住）；反证 **P4**（把清空那句加回去 → 当场红，user-visible） |
| F2 | 「切换项目」与「新建项目」失败时只把错误写进 `projectNote`，成功时 note 被清空 —— 成功/失败**用的同一个位置**，用户不容易分清是"刚做完的事"还是"出错了" | 同上 | 既有 | 待修（与 F1 一起考虑） |

## 既有的健壮性缺口

| 编号 | 现象 | 位置 | 触发条件 | 状态 |
|---|---|---|---|---|
| **F3** | `bridge.getTaskState().then(setTask)` **不校验返回值**，三处不设防：① 桥给 `undefined`/`null` → 渲染期 `task.phase` 抛 `TypeError: Cannot read properties of undefined (reading 'phase')` → **整页白屏**；② `bridge.getTaskState` 不是函数（老 preload / 版本不一致）→ **同步 TypeError**，更直接；③ `state` 广播只挡了空负载：`JSON.parse('null')` 是**合法解析**，于是 `setTask(null)` → 同样白屏 | `App.tsx` 第 4 步"状态机镜像"那段 effect | 桥给了空值 / 桥方法缺失 / 广播负载形状不对 | ✅ **已修（2026-09-24，用户点名提前修）**：先校验形状（`isTaskState`）再落 state；桥方法用 `?.()` + try/catch 兜住同步异常；广播负载同校验。验收 `verify:logic` F3-A / F3-A2 / F3-C1 / F3-C2 四条；反证 `F3-1` / `F3-2`（拆掉校验 → 当场白屏/覆盖好值） |
| **F4** | **`.authWrap` 一名两义**：真登录页（`AuthScreen`）与「正在恢复登录状态…」占位页**共用同一个类名**。当前靠"占位页里没有 `.authTabs`"来区分。阶段 2 改样式时一个选择器会同时打中两个状态；以后写测试还会再踩（片 5 已经踩过一次：一开始用 `.authWrap` 判"是否回到登录页"，把"卡在检查中"误判成"已回到登录页"= 假绿） | `App.tsx`：`checkingAuth` 分支的 `<div className="authWrap">` 与 `AuthScreen` 的 `<div className="authWrap">` | — | 待修（**阶段 2**）：拆成 `.authWrap--checking` / `.authWrap--login` 两个类名，验收网里的 `onLoginScreen()` / `onCheckingScreen()` 随之简化为单一选择器 |

| **F5** | **登出不清这三个值**：`resetChat()` **有意**不清 `searchHint` / `runningLoopId` / `runningLoopWcId`（抽 hook 时逐字保留既有行为）。若在**流式进行中**登出/换号，残留的循环号会在下次登录后的**第一轮**、meta 还没回来的那一瞬被渲染成「🚀 AI 任务执行中 · 可在下方输入补充指令」，输入框也会从「打字中…」变回「发送补充」（判据是 `streaming && runningLoopId`）；残留的 `searchHint` 同理可能闪一下上一轮的"正在搜索：…" | `features/chat/useChat.ts`（`resetChat`） | 登出发生在流式进行中（含换账号） | 待修（**独立小提交**，3 行 + 一条断言 + 一条反证；本片不许顺手改行为） |

> 补充（2026-09-24，用户第 2 条）：还专门查了"批次 D 重启恢复时会不会踩到" —— `getTaskState` 走的是
> **IPC 到主进程**（`workbench:task:state` → `driver.getTaskState()` → `aggregateState()`，**永远有返回值**），
> 而批次 D 重启的是**服务端**，所以"后端重启 → `getTaskState` 返回 undefined"这条**不成立**。
> 会白屏的是上面 ①②③ 三条独立路径（都已修、都有验收）。用户点名的场景按"C1 冷启动撞上后端重启 / C2 正用着后端重启"两条断言守着。

> F3 是**验收网抓出来的**：片 6 给逻辑网补了 `/agent/task/current` 的假数据后，
> `curTask` 变成非空 → 走到 `task.phase` 那一行 → 崩。根因不在片 6 的抽离，
> 而是"桥桩没实现 `getTaskState` + 生产代码没校验返回值"这两件事凑到了一起。
> 改法（将来）：`if (s && typeof s.phase === 'string') setTask(s)`，
> 并且给逻辑网保留这条"桥返回 undefined 不许崩"的断言。

## 修 F1 时的注意（现在先记下来，免得改坏）

- F1 的根因是**顺序**：`setProjectNote(成功文案)` 在前、`await loadProjects()`（内部 `setProjectNote('')`）在后。
- 最稳的改法是让 `loadProjects` **不要**清 note（只清自己的错误文案），而不是在 `createProject` 里再写一遍 ——
  后者会在别处（比如切换失败后又刷新）留下同一个坑。
- 修的时候必须让**片 4 的验收网**里那条「钉住 F1」的断言**反过来**变红（把"note 现在是空的"改成"note 是成功文案"），
  而且反证里要有一条**user-visible** 注入（把顺序倒回去 → 断言红）。
