# 部署报告：当前项目 → 桌面端（构建 + 换装 + 登录验收）

> 时间：2026-09-22 09:11 ~ 09:20
> 结论：**全部成功。登录修复已在真实安装版里端到端验证通过。**

---

## 一、交付清单

| 步骤 | 结果 |
|---|---|
| 构建（shared + desktop 主进程/渲染层 + server） | ✅ 24 秒完成，无报错 |
| 换装前 token 校验 | ✅ 两处产物都含 `isElectron` |
| 换装（写入已安装 app.asar） | ✅ **55 项自检全绿** |
| 安装包字节级复核 | ✅ 解包直读，`isElectron: true` 在位 |
| 启动应用 + 后端自愈 | ✅ 应用自己拉起 PG + 服务端，60 秒内 `db=up` |
| 渲染层运行时探针 | ✅ `isElectron = true`，页面内 fetch `/health` 成功 |
| 端到端登录 | ✅ 点「快捷登录」→ `hasToken: true`（165 字符），登录门消失 |

---

## 二、关键证据

### 2.1 换装结果

```
已替换 -> C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\resources\app.asar
  旧 5572642 B  ->  新 5572642 B
  sha256(app.asar) = 691205b2919d718a6cefb563d4d6d60583356b23591a4d3f89df8e52114e2853
  旧包已归档 -> ...\_rollback-backup-20260918\app.asar.old-isElectron-fix-r8-final
```

- 备份（换装前）：`resources\app.asar.bak-isElectron-fix-r8-final-pre`
- 归档（换下来的旧包）：`_rollback-backup-20260918\app.asar.old-isElectron-fix-r8-final`

### 2.2 换装脚本自检（本轮新增的 2 条 + 存量 53 条）

```
✓ 主进程: ★ preload.js 暴露 isElectron（本轮登录修复）
✓ 渲染层: ★ API_BASE 用 isElectron 判定（本轮登录修复）
✓ 主进程: 装进去的 main.js 与刚构建的逐字节一致
✓ 主进程: 装进去的 server-supervisor.js 与刚构建的逐字节一致
… 共 55 项，全部 ✓
```

> 📌 换装脚本原本**没有** `isElectron` 断言（`STAMP` 写着 `isElectron-fix-r8-final` 但自检漏了）。
> 我按脚本自己的约定补了 2 条 —— 否则「换装成功」无法证明登录修复真的进包。

### 2.3 安装包字节级复核（解包直读，不靠 grep）

```
preload.js            isElectron 出现 1 次，含 "isElectron: true"
dist/assets/*.js      isElectron 出现 2 次，含 API_BASE 判定、含「正在准备后端」
main.js / server-supervisor.js 含 ensurePostgres
条目总数 113（dist 4 + dist-electron 10）—— 不是空壳包
```

### 2.4 渲染层运行时探针（CDP 直插真实安装版）

```
window.workbench 存在      = true
isElectron                 = true        ← ★ 登录修复生效
platform                   = win32
页面内 fetch /health       = {"ok":true,"service":"ai-workbench-server","db":"up","sms":"mock",...}
含「正在准备后端」          = false       ← ★ 不再卡住
起始页 URL                 = file:///.../app.asar/dist/index.html
```

### 2.5 端到端登录

```
快捷登录按钮: {"x":582,"y":471.25,"w":334,"h":37,"tag":"BUTTON"}   （完整鼠标序列点击）
点击 6 秒后: 当前项目：默认项目 | 小助 | 在线 | 💬 对话 | 🌐 浏览器 |
            欢迎使用 AI 自主浏览器工作台 …
hasToken        = true（165 字符）
stillLoginGate  = false
```

---

## 三、构建产物

| 产物 | 路径 | 大小 |
|---|---|---|
| 渲染层 | `apps/desktop/dist/assets/index-CE1ahFpL.js` | 236.69 kB |
| 渲染层样式 | `apps/desktop/dist/assets/index-Hv5nFBUk.css` | 18.53 kB |
| 主进程 | `apps/desktop/dist-electron/*.js` | preload.js 10177 B |
| 服务端 | `apps/server/dist/index.js` | 9559 B |

> 渲染层 bundle 哈希与上一版**完全相同**（`index-CE1ahFpL.js`）—— **符合预期**：
> 登录修复改的是主进程 `preload.ts`，渲染层 `App.tsx` 本来就未改动。

---

## 四、需要你知道的几件事

### 4.1 ⚠️ 应用进程已被回收，请双击桌面图标启动

本机限制：我用命令行启动的 GUI 进程，会在我这条命令结束时被一起回收（实测两次都是这样）。
**桌面已有快捷方式 `AI 工作台.lnk`，双击即可**（会自动拉起 PG + 服务端，约 60 秒后可用）。

### 4.2 ⚠️ 一个需要你亲自判断的观察项

登录页文案里出现过这一句：

> 「数据库没连上：双击仓库根目录的 start-dev.cmd（它会起库 + 服务端并等到真正可用），再点一次」

但探针同时显示 `/health` 的 `db` 是 `up`、页面内 fetch 也成功。可能是**后端就绪前渲染的那一帧留下的提示**。
**请你在应用里亲眼看一下**：登录页是否还挂着这句「数据库没连上」的红字？
如果是常态显示，那是文案/状态清理的问题，需要单独修 —— 这个自动化测不出来（它不区分"一闪而过"和"一直挂着"）。

### 4.3 git 回滚/重新克隆已按你的指示取消

- 旧仓库目录**未重命名**（被会话进程锁住，无法改名）—— 原样保留在 `C:\Users\bing\workbuddy-ai\work123`
- 我临时克隆的 `work123-fresh` 目录（只有 9K、克隆失败）已清理
- J 盘工作区备份仍在：`J:\11111\wb-backup-20260922\work123-worktree.tar`（350MB）

---

## 五、回滚方式（如需退回换装前）

```sh
# 方式一：用换装时自动做的备份还原
cd "C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\resources"
mv app.asar app.asar.new-broken
mv app.asar.bak-isElectron-fix-r8-final-pre app.asar

# 方式二：从归档还原
mv app.asar app.asar.new-broken
cp "C:\Users\bing\workbuddy-ai\work123\_rollback-backup-20260918\app.asar.old-isElectron-fix-r8-final" app.asar
```

> 回滚前先确认 `AI 工作台.exe` 已退出，否则会 EBUSY。
