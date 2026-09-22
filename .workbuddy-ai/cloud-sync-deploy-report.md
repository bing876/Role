# 云端代码同步 → 本地部署验收报告

时间：2026-09-21 14:40 ~ 15:14
分支：`arena/01a0c1e3-work123` @ `3c68c22`（= 远程 tip，`git pull` 报 Already up to date）

## 1. 同步了什么

云端比本地多 9 个提交，+3289 行 / 22 个文件：

| 层 | 内容 |
|---|---|
| 桌面端 | `App.tsx` +280、新增 `webBridge.ts`(380)、新增 `dashboard/index.html`(1079)、`main.tsx`、`styles.css` +176 |
| 服务端 | 新增 `loopSse.ts`、`routes/loop.ts`、`llm.ts` +133、`db.ts` 接入 PGlite、`toolLoop.ts` |
| 依赖 | 新增 `@electric-sql/pglite`、`pg-mem`、`jsdom` |

## 2. 部署链路

```
装依赖 → 三端构建 → 校验产物指纹 → 换装 asar → 启动 → 验收
```

- 构建：`shared` / `server` / `desktop` 全部 exit 0
- 产物指纹：渲染层含 `webBridge`、主进程含 `backgroundThrottling`、服务端 `db.js` 含 `pglite`
  → 排除"主进程新、UI 旧"的半同步包
- 换装：`node .workbuddy-ai/swap-dist.mjs`（STAMP = `cloud-sync-01a0c1e3`）
  - 旧包归档：`_rollback-backup-20260918\app.asar.old-cloud-sync-01a0c1e3`
  - 新包：`C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\resources\app.asar`（5572486 B）

## 3. 验收结果

| 项 | 判据 | 结果 |
|---|---|---|
| 包内是不是本轮代码 | `_cloud9-token-check.mjs` 直读 asar 字节 | **6/6 通过** |
| 旧功能没被换丢 | 包内仍有 `loop_gone` / `risk` / `helpState` | 通过 |
| 数据库 | 直读库：13 张表，`users` 141 行 | **通过** |
| 后端 | `/health` 连续两次 `db:"up"` | 通过 |
| 窗口 | `ps -W` 命中 `AI 工作台.exe` | 在运行 |
| 云端新能力 | `dist/loopSse.js`、`routes/loop.js`、`/agent/loop/*` | 已注册 |

## 4. 需要你亲自看的主观项

自动化测不到的部分，建议你打开应用亲自判断：

1. **常驻顶栏浏览器切换** —— 入口位置和存在感是否合适，会不会挡住会话内容
2. **欢迎引导卡片** —— 会不会挡视线，示例提示（"帮我打开百度搜索"之类）是否自然
3. **可视化看板** —— 信息密度会不会太高
4. 打开一个网页让 AI 执行时，**顶栏切换 + 后台运行**的观感是否连贯

## 5. 已知遗留

- 仓库现在是 partial clone（`blob:none`）：`git log` / `show --stat` 正常，
  但旧提交的**文件内容**（331 个 blob）按需联网拉取。要彻底补齐需先腾 C 盘空间再 `git fetch --refetch`
- C 盘仍偏紧（约 2GB）
- 已设 `gc.auto=0`、`maintenance.auto=false`，防止历史对象再被误删
