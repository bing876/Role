# 概览 · 架构审查 + GitHub 全量同步（云端审查用）

## 已交付

| 交付物 | 位置 | 说明 |
|---|---|---|
| `ARCHITECTURE_REVIEW.md` | 仓库根目录 | 338 行。进程拓扑图 + Mermaid 执行链路时序图 + 五环节（下发/感知/决策/执行/校验）逐环节实现情况 + 三层定位 + 「打开浏览器不执行」三条根因链 |
| `BUG_LIST.md` | 仓库根目录 | 170 行。P0(3) / P1(6) / P2(8) 分级，每条含问题描述、涉及文件、复现路径、修复建议、**证据等级** |
| `.gitignore` | 仓库根目录 | 新增 4 条规则，固化「数据库导出快照禁止入库」 |
| GitHub 分支 | `review/architecture-audit`（tip `ca2475a`） | 全量代码 + 两份文档 + 安全清理 |

## 核心结论

**「AI 打开浏览器后不执行操作」不是 Loop 缺失。** 桌面 `runToolLoop` 的持续循环与服务端 `advanceInner` 都在，`toolToAction → drive() → CDP` 四段链路完整。

真正的病灶在**发车前置闸**：`App.tsx:1928-1993` 用纯本地正则做三判定（`openUrl`/`goNow`/`browseGoal`），全空时不带 `taskMode`，于是走**普通聊天分支** —— 而该分支的工具表只有 `web_search`（`chat.ts:490` 源码注释自己写明「浏览器工具不在这条路上」）。表现就是「AI 嘴上答应、手上不动」。源码注释 `App.tsx:2015-2034` **自己承认这是根因**，但修复只覆盖了「步数上限后的继续」一种措辞。

**关键判断：三条独立原因链对用户的观感完全一致**（都只有一句开场白然后静默），**不能只修一条就宣布好了**：

| 症状 | 原因链 | 判据 |
|---|---|---|
| 服务端**无**循环日志 | ① 未发车（P0-1） | 三判定全 null 且请求体无 `taskMode` |
| 有循环但只 1 格、无 tool 消息 | ② 首格不调工具（P1-1） | `advanceInner` 返回 `{kind:'say'}`，`step===0` |
| 有循环、跑了 1~2 格且都失败 | ③ 20s 超时误判（P1-2） | `drive` 错误含「20 秒没有完成」 |

排查第一步建议：在 `App.tsx:1993` 后加一行日志落盘三判定结果 —— 一步就能分流三条链。

## 推送前安全检查（最重的一步）

- **API 密钥没有泄漏**：`.env` 被 `.gitignore:18` 正确挡住，全仓库无硬编码密钥。
- **但发现 2 个真实用户 PII 数据库导出**，GitHub 上当时还没有，一推就会公开：
  - `docs/acceptance/root-cause/accounts-backup-before-purge-*.json` —— 17 个用户 × 13 张表，含 `phone_hash` / `phone_enc` / `password_hash` / `wechat_openid`
  - `docs/acceptance/p1-fix/users-before-pepper-migration.json`
- 经确认后用 `git filter-repo --invert-paths` 从**全部历史**清除；复查 `git log --all` = 0 条、`git rev-list --all --objects` 无命中。
- 原文件备份在 `.workbuddy-ai/_pii-purge-backup/`（该目录已 gitignore）。
- 备注：开发用测试手机号（`18665594441` 等）仍留在验证脚本与记忆文件里，属文档化的本机开发号、非客户数据，未处理。

## 推送决策

远端 `main`（`dc335d6 step3: freeze before review`）是一个**旧快照**，与当前 77 个新提交**历史不相交**，push 报 non-fast-forward。经选择，**不改动 `main`**，改推新分支 `review/architecture-audit`。

## 过程中的意外与处理

`git filter-repo` 重写本身成功，但收尾的 repack 在 497MB 的 `.git/objects` 上挂死 40+ 分钟，只能 kill。kill 落在中间态，导致分支 ref 丢失、工作区 1107 个文件显示 deleted。

恢复方法（已记入记忆）：从 `.git/filter-repo/ref-map` 取新 sha → `printf` 写回 ref → `git read-tree <sha>` → `git checkout-index -a -f`。注意 `git checkout HEAD -- .` 与 `git reset` 都会失败，因为 ref-guard hook 会在 reset 时删 ref（报 `invalid reference: HEAD`）。另外 filter-repo 会删掉 `origin` remote，需重加。

最终状态：远端 tip `ca2475a` == 本地 HEAD，工作区干净，`main` 未被改动。

## 需要你亲自体验的主观项

以下是自动化测不出的部分，建议你打开应用亲自判断：

1. **发车成功率** —— 用你自己的自然说法（别用简报里的措辞）下 3~5 个任务，看有几个真跑起来。这是 P0-1 最直观的量化。
2. **任务进行中的会话观感** —— 任务真跑起来后，会话面板里**除了那句开场白还有没有别的东西**。如果全程只有那一句，就是 P0-2 说的「过程不可见」。
3. **浏览器工作区面板** —— AI 干活时你主动点开浏览器面板，步骤流是否清楚、是否看得出它在干什么。
4. **卡住时的姿态** —— 故意给一个难任务，看它停下来时是否让人安心（有明确说明 vs 莫名静默）。
