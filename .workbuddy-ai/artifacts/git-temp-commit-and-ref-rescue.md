# 临时提交 + ref 抢救 报告

> 时间：2026-09-22 07:14 ~ 07:30
> 仓库：`C:\Users\bing\workbuddy-ai\work123` · 分支：`arena/01a0c1e3-work123`

---

## 一、结论速览

| 项目 | 结果 |
|---|---|
| 第 1 步：临时提交 | ✅ 成功 —— `d16e3133`，父提交 `3c68c22` |
| 提交内容 | 110 个文件（**104 新增 + 6 修改**，0 删除） |
| 工作区 | ✅ 完全干净 |
| ref 状态 | ⚠️ 提交过程中 `refs/heads/arena/` 被删（**已知故障复发**），已全部恢复，14 个 ref 与备份逐项一致 |
| 第 2 步：`preload.ts` diff | ✅ 已取得（完整 diff 见下） |
| 第 2 步：`packages/shared/src/index.ts` diff | ❌ **取不到**（旧 blob 本地缺失且网络不通），但有**书面铁证**判定其内容 |
| 第 3、4 步 | ⏸️ 按指示未执行 |

---

## 二、这两个改动是什么？——**是「登录相关」的重要修复，不是无关紧要的临时改动**

### 2.1 `apps/desktop/electron/preload.ts`（完整 diff，来自 `git show`）

```diff
diff --git a/apps/desktop/electron/preload.ts b/apps/desktop/electron/preload.ts
index bfb6b68..6eebff8 100644
--- a/apps/desktop/electron/preload.ts
+++ b/apps/desktop/electron/preload.ts
@@ -22,6 +22,8 @@ const BROWSER_CHANNEL_PREFIX = 'workbench:browser:';
 const bridge: WorkbenchBridge = {
   platform: process.platform,
   appVersion: process.env.npm_package_version ?? '0.1.0',
+  // ★ 渲染层据此把后端地址定为 http://127.0.0.1:8787（缺失会被误判成 web 直测模式 → 连不上后端）
+  isElectron: true,
   ping: () => ipcRenderer.invoke('app:ping'),
```

**只加了 2 行**：`isElectron: true` 及其注释。

### 2.2 `packages/shared/src/index.ts`

**diff 无法直接产出**（原因见第四节）。但内容已由仓库内既有文档确证：

> `.workbuddy-ai/login-fix-report.md` 第 55~62 行「三、修复（两处，缺一不可）」明确记载：
>
> | 文件 | 改动 |
> |---|---|
> | `packages/shared/src/index.ts` | `WorkbenchBridge` 接口新增 `isElectron: boolean`（不加则 preload 里 TS 报「多余属性」） |
> | `apps/desktop/electron/preload.ts` | bridge 新增 `isElectron: true` |
>
> `App.tsx` 一行未动 —— 字段补齐后原判断自然成立。

即：**在 `WorkbenchBridge` 接口上新增 `isElectron: boolean` 字段声明**（含说明该字段必须存在的 ★ 注释块）。

### 2.3 为什么这是「登录相关」的关键修复

`apps/desktop/src/App.tsx:270` 的 `API_BASE()` 靠这个字段决定后端地址：

```ts
if (typeof window !== 'undefined' && !(window as any).workbench?.isElectron) {
  return '';                       // web 直测模式走 Vite 代理
}
return 'http://127.0.0.1:8787';
```

preload 缺 `isElectron` 时 → `window.workbench.isElectron === undefined` → `!undefined === true` → 返回空串 → `file://` 起源下 `fetch('/health')` 必然失败 → **界面永远停在「正在准备后端」，登录不上**。

**旁证（已实测）**：
- `apps/desktop/src/webBridge.ts:76` → `isElectron: false,`（web 垫片，按设计走相对路径）
- 本次提交**未触碰** `App.tsx`（与报告「一行未动」一致）
- 修复后 CDP 实测记录：`hasBridge: true, isElectron: true`，页面内 fetch 返回 `{"ok":true,"db":"up",...}`，登录页不再出现「正在准备后端」

> ⚠️ **结论：这 2 个文件必须保留，绝不能丢弃。** 丢掉等于把「登录不上」的回归重新引入。

---

## 三、第 1 步：临时提交明细

```
d16e3133e757665daea1313abbeabc82389cb1ad  临时保存：切换分支前的本地修改备份
3c68c22948772577163bb3b34dccd3807b75ce45  (父) feat: 增加常驻顶栏浏览器切换、欢迎引导卡片…
```

**6 个修改文件**

| 文件 | 性质 |
|---|---|
| `apps/desktop/electron/preload.ts` | 🔴 登录修复（代码） |
| `packages/shared/src/index.ts` | 🔴 登录修复（代码） |
| `.workbuddy-ai/swap-dist.mjs` | 换装脚本 |
| `.workbuddy-ai/memory/MEMORY.md` | 记忆 |
| `.workbuddy-ai/memory/2026-09-21.md` | 日志 |
| `.workbuddy-ai/artifacts/overview.md` | 产物说明 |

**104 个新增文件**：`.workbuddy-ai/` 下 17 个探针/报告 + `workbench-ui/` 目录（84 个：源码、`dist-single/index.html`、10 张 `docs/*.png` 截图等）。

> 📌 口径修正：你提到的「19 个未跟踪文件」是 `git status` 把 `workbench-ui/` 折叠成一行后的计数；展开后实际是 **118 个**，减去被我移出仓库的 14 个 refs 备份文件 = **104 个**。

---

## 四、⚠️ 执行中遇到并已解决的三个问题

### 4.1 `git add -A` / `git diff` / `git show` / `git write-tree` 全部失败

**根因**：本仓库是 **partial clone**（`remote.origin.promisor=true` + `partialclonefilter=blob:none`，2026-09-21 恢复历史时留下的副作用），叠加 `core.autocrlf=true` 后，git 在判断"文件是否变化"时会去读**旧 blob 内容**，而旧 blob 不在本地 → 触发懒加载 → 远端不可达 → 失败。

**解法（关键，可复用）**：设 `GIT_NO_LAZY_FETCH=1`，让 git 就地失败而不是去联网。之后 `git add -A` 即正常工作。

### 4.2 `git commit` 需要 238 个缺失 blob → 从工作区重建

即使 `add` 成功，`git commit` 写树时仍要求索引里引用的 blob 全部存在。索引 774 个 blob 中 **238 个缺失**。

**解法**：这些缺失 blob 对应的都是**内容未变的文件**，因此可从工作区逐字节重建 —— 且**只在哈希一致时才写入**：

```sh
h=$(git hash-object --path="$path" -- "$path")   # 带 CRLF 过滤
[ "$h" = "$sha" ] && git hash-object -w --path="$path" -- "$path"
```

**结果：238 → 0，全部重建，无一例哈希不一致。** 脚本：`C:\Users\bing\workbuddy-ai\_recover-blobs2.sh`

### 4.3 ★★★ ref 在提交过程中被删除（已知故障第 8 次复发）

```
[ref-guard] ⚠️  检测到 ref 丢失，已自动修复：refs/heads/arena/01a0c1e3-work123
```

- 提交**前**已按规程 `cp -r .git/refs` 备份（存于仓库外 `C:\Users\bing\workbuddy-ai\_refs-backup-work123-20260922-0714`）
- 提交后复查发现 `refs/heads/arena/` 下 **`01a09b16-work123` 被连带删除**（ref-guard 只修复了当前分支）
- 已按配方写回：`printf 'ca2475ae65a6dfc3867378937a140c7f34e703cb\n' > .git/refs/heads/arena/01a09b16-work123`
- **最终复查：14 个 ref 与备份逐项一致（DIFF=0），`ca2475a` 对象可达，延迟 4 秒二次复查仍稳定**

---

## 五、仍存在的阻塞（第 3 步相关）

1. **远端 GitHub 不可达** —— `schannel: server closed abruptly` / `CONNECT tunnel failed, response 502`。⇒ `fetch / checkout / pull` 全部无法执行。
2. **`packages/shared/src/index.ts` 的旧 blob（`45e025b6`）永久缺失** —— 它对应的是**已被修改**的文件，无法从工作区重建；只能等网络恢复后 `git fetch` 补齐。
3. **目标哈希 `15daa00` 本地不存在** —— 需 fetch 成功后才可能取得。
4. C 盘：执行过程中从 120MB 恢复到 **4.3G 可用**（98%）。

---

## 六、待你确认

- [ ] 确认这 2 个文件是登录修复后，是否继续切分支？（远端恢复前 `fetch/checkout/pull` 都做不了）
- [ ] 第 4 步的清理清单（`node_modules` / `.git` / `.workbuddy-ai` 缓存）—— 我尚未开始，会先列清单给你确认
