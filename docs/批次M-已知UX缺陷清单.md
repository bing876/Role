# 批次 M · 已知 UX 缺陷清单（先记账，不顺手改）

> 规矩（用户 2026-09-24 拍板）：**重构片一个字都不许改产品行为**。
> 在抽逻辑过程中读出来的既有 UX 问题，一律先记在这里，等阶段 1① 收尾（片 7 之后）
> 用一个**单独的小提交**去修，并且那个提交要带**自己的验收 + 反证**。

| 编号 | 现象 | 位置 | 性质 | 状态 |
|---|---|---|---|---|
| F1 | 新建项目后那句「项目「X」建好了（自带一只母鸡），已经切过去。」紧接着被 `loadProjects()` 末尾的 `setProjectNote('')` 清掉 —— 界面上等于**没有确认** | `features/projects/useProjects.ts`（`createProject` → `loadProjects`） | 既有（重构前顺序一模一样，片 4 逐字保留） | 待修：片 7 之后单独提交 |
| F2 | 「切换项目」与「新建项目」失败时只把错误写进 `projectNote`，成功时 note 被清空 —— 成功/失败**用的同一个位置**，用户不容易分清是"刚做完的事"还是"出错了" | 同上 | 既有 | 待修（与 F1 一起考虑） |

## 既有的健壮性缺口（同样"先记账，不顺手改"）

| 编号 | 现象 | 位置 | 触发条件 | 状态 |
|---|---|---|---|---|
| F3 | `bridge.getTaskState().then(setTask)` **不校验返回值** —— 桥返回 `undefined`（老版本主进程没这个通道 / IPC 失败）时，`task` 被置成 `undefined`，随后渲染期 `task.phase` / `task.phase === 'running'` 直接抛 `TypeError: Cannot read properties of undefined (reading 'phase')`，**整个应用白屏** | `App.tsx` 第 4 步"状态机镜像"那段 effect（`.then(setTask)`） | 桥给了 `undefined`（网络/版本/IPC 任一出问题） | 待修（与 F1/F2 一起或单独提交） |

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
