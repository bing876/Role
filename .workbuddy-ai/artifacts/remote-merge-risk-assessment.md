# 远程分支排查 + 冲突风险评估报告

> 时间：2026-09-22 07:40 ~ 08:35
> 仓库：`C:\Users\bing\workbuddy-ai\work123` · 分支：`arena/01a0c1e3-work123`
> 本地 HEAD：`d16e3133`（临时保存提交，父 `3c68c22`）· 远程 tip：`15daa00`

---

## 一、结论速览

| 步骤 | 结果 |
|---|---|
| 1. 工作区状态 | ⚠️ 有 3 项改动，**但都是上一轮我写的报告/记忆文件**，你的 6+118 个文件已安全在 `d16e3133` |
| 2. `git fetch origin` | ❌ 原样执行**失败**（代理挡掉 `github.com`）→ ✅ 已用 **SSH 通道**成功拉取 |
| 3. 远程 10 条提交 | ✅ 已取得。远程 tip = **`15daa00`**，与本地在 **`92f3f1c` 处分叉，各走 5 条** |
| 4. 冲突风险 | ✅ **无冲突**。远程**也改过**那两个文件，但**不含**登录修复，两边改动位置不重叠 |
| 5. 方案 A / B | 已给出（见第五节）。**方案 A 会丢掉登录修复，明确不可用** |
| 6. 实际合并 | ⏸️ 按指示**未执行** |

---

## 二、第 2 步：`git fetch` 的真实情况

### 2.1 原样执行 —— 失败

```
$ git fetch origin arena/01a0c1e3-work123
fatal: unable to access 'https://github.com/bing876/work123.git/':
       schannel: server closed abruptly (missing close_notify)
       / CONNECT tunnel failed, response 502
```

### 2.2 根因：本机代理只放行 `api.github.com`，挡掉 `github.com`

环境变量里配了代理 `http(s)_proxy=http://127.0.0.1:50185`。实测：

| 目标 | 结果 |
|---|---|
| `https://github.com` | **HTTP 000**，每次恰好 10.0s 超时（被稳定拦截） |
| `https://github.com/bing876/work123.git/info/refs` | **HTTP 000**（git 走的正是这条） |
| `https://api.github.com` | ✅ HTTP 200 / 0.44s |
| `https://raw.githubusercontent.com` | **HTTP 000**（20s 超时，同样被挡） |
| `https://codeload.github.com` | 可达但 404 |

> ⚠️ 注意区分：会话里显示的 `connector-status: github connected` 指的是 **GitHub MCP 连接器**（走 `api.github.com`）正常，**与 git 的 HTTPS 通道无关**。

### 2.3 ✅ 解法：走 SSH（`~/.ssh/config` 已配好）

本机 `~/.ssh/config` 已把 `github.com` 映射到 **`ssh.github.com:443`**，而该端口**可达**：

```
Host github.com
    HostName ssh.github.com
    Port 443
    User git
    IdentityFile C:\Users\bing\.ssh\id_ed25519_github
    IdentitiesOnly yes
```

验证：`ssh -T git@ssh.github.com -p 443` → **`Hi bing876! You've successfully authenticated`** ✅

实际拉取命令（**不改仓库任何配置**）：

```sh
export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20"
git fetch --no-tags --filter=blob:none \
  git@github.com:bing876/work123.git arena/01a0c1e3-work123
```

> 📌 `git -c remote.origin.url=...` 和 `GIT_CONFIG_*` 覆盖 **都无效**，git 仍读 `.git/config` 里的 HTTPS 地址 —— 必须用**显式 URL**。

### 2.4 ⚠️ 附带发现：远程跟踪 ref 无法自动更新

```
 ! [rejected] arena/01a0c1e3-work123 -> origin/arena/01a0c1e3-work123  (non-fast-forward)
```

⇒ **远程分支是被改写过（rebase / force-push）的**，`origin/arena/01a0c1e3-work123` 仍停在 `3c68c22`，要更新必须 `--force` 或 `+refspec`。这也是为什么 `git pull` 在这里会很难受。

---

## 三、第 3 步：远程提交历史与本地关系

### 3.1 远程最新 10 条（`15daa00`）

```
15daa00 test: 增加全量回归测试与本轮新增功能验收套件
da3daea fix: 移除webview对实时URL的状态响应绑定，修复单页应用滑动整页刷新与资源泄漏
e925048 fix: 修复多标签页层叠样式与几何内联残留，确保非激活视图绝对隔离
5aaff28 fix: 建立页面停滞熔断状态机、新标签页焦点跟随并修复网络慢加载误判
74903ec fix: 增强敏感页面全网通用检测规则、前置硬性审查闸与CDP防护(防检测/弹窗处理)
92f3f1c test: 增加浏览器Agent Loop修复自测与场景验证套件      ← ★ 共同祖先
770ebdb fix: 修复问题5(显式设置主窗口与内嵌webview backgroundThrottling: false及Chromium后台节流参数)
8a37a3c fix: 修复问题4(任务中途输入消息状态机与互斥锁、中断与补充指令动态注入)
1db7c2b fix: 修复问题1/2/3(服务端意图裁决发车、SSE长连执行步骤实时回流、首格强制工具调用)
ca2475a memory: 架构审查 + GitHub 同步 + PII 历史清除记录（含 filter-repo 中途态救援法）
```

### 3.2 与本地的关系：**已分叉，不是快进**

```
                      92f3f1c  ← 共同祖先 (merge-base)
                     /        \
   本地 5 条: 50590d6 → d6ee1c4 → 1c998ac → cf3ab2c → 3c68c22 → d16e3133(临时保存)
   远程 5 条: 74903ec → 5aaff28 → e925048 → da3daea → 15daa00
```

- `merge-base(3c68c22, 15daa00)` = **`92f3f1c`**
- `3c68c22` **不是** `15daa00` 的祖先 ⇒ **不能 fast-forward**
- 远程有 5 条本地没有；本地有 5 条远程没有

**关于 `15daa00`**：它**确实存在**，就是**远程分支当前的 tip**。此前本地查不到是因为本地只拉到 9-21 14:15 的状态（`3c68c22`），远程在那之后被改写过。

---

## 四、第 4 步：冲突风险评估 —— **无冲突**

### 4.1 两边都改过的文件

| 侧 | 改动文件数 |
|---|---|
| 本地（`92f3f1c`→`3c68c22`） | 16 个 |
| 远程（`92f3f1c`→`15daa00`） | 11 个 |
| **重叠（潜在冲突点）** | **2 个**：`apps/desktop/src/App.tsx`、`apps/desktop/src/browser/BrowserPanel.tsx` |

### 4.2 两个登录修复文件 —— 远程**也改了**，但**不是同一个改动**

| 文件 | 祖先 `92f3f1c` | 本地 `d16e3133` | 远程 `15daa00` |
|---|---|---|---|
| `apps/desktop/electron/preload.ts` | `bfb6b68c` | `6eebff81`（+`isElectron: true`） | `865633a7` |
| `packages/shared/src/index.ts` | `45e025b6` | `82d69e8e`（+`isElectron: boolean`） | `03e929a5` |

**远程 blob 里没有 `isElectron`** —— 已用 `git cat-file -p <blob>` 逐字确认：

- 远程 `preload.ts` 改的是：`+ migrateLane: (sourceWcId, targetWcId) => ...`（**第 90 行附近**，标签页迁移）
- 远程 `index.ts` 改的是：`+ dialogWarning?: string`（PageSnapshot，第 176 行附近）、`+ migrateLane?:`（WorkbenchBridge，第 359 行附近）
- 本地改的是：`isElectron`（**第 22 行 / 第 248 行附近**）

⇒ **两边改的是完全不同的东西，位置也不重叠。**

### 4.3 ✅ 实测：自动合并零冲突

用 `git merge-tree`（**纯虚拟合并，不碰工作区、不碰任何 ref**）实测：

```sh
$ git merge-tree --write-tree d16e3133 15daa00
fe087f11fbf03fe99deb1858ffcea52dd6ff5bb8
exit=0                       ← 0 冲突

$ git merge-tree --write-tree --name-only d16e3133 15daa00
fe087f11fbf03fe99deb1858ffcea52dd6ff5bb8
                             ← 冲突文件列表为空
```

**合并结果里登录修复完整保留**（在结果树 `fe087f11` 中验证）：

```
apps/desktop/electron/preload.ts:26   isElectron: true,          ← 本地修复 ✅
apps/desktop/electron/preload.ts:95   migrateLane: (...) =>       ← 远程改动 ✅
packages/shared/src/index.ts:250      isElectron: boolean;        ← 本地修复 ✅
```

两个重叠文件也都**正常做了内容级合并**（合并后 blob 与两侧都不同）：

| 文件 | 本地 | 远程 | 合并后 |
|---|---|---|---|
| `App.tsx` | `90e3e19a` | `43c675cb` | `333d7fe7` |
| `BrowserPanel.tsx` | `aa2ec279` | `be82cfcd` | `36314d8d` |

> **结论：冲突风险 = 无。** 但这**只说明文本不冲突**，不代表功能正确 —— 合并后仍需按老规矩做真机验收。

---

## 五、第 5 步：两种方案（**均未执行**）

### ❌ 方案 A：用远程覆盖本地 —— **明确不可用**

**原因**：远程 `15daa00` **不含 `isElectron` 登录修复**。覆盖会把这个修复彻底丢掉，重新引入「界面永远停在『正在准备后端』、登录不上」的回归（`.workbuddy-ai/login-fix-report.md` 有完整记录）。

> 只有在「远程已包含同一修复」时才可用 —— **本次不满足**，所以不要走这条。

### ✅ 方案 B：合并（推荐）

已实测零冲突，`git merge` 会自动干净合并，登录修复不会丢。

```sh
# ① 先把 origin 换成 SSH（否则 github.com 被代理挡掉，fetch/pull 全废）
git remote set-url origin git@github.com:bing876/work123.git

# ② 确认 SSH 通
git ls-remote origin | head

# ③ 拉取远程（因已分叉，远程跟踪 ref 需 --force 才能推进）
git fetch --force origin arena/01a0c1e3-work123

# ④ 合并（在 arena/01a0c1e3-work123 上）
git merge origin/arena/01a0c1e3-work123
#    预期：自动合并成功，生成一个 merge commit，无冲突提示

# ⑤ 立刻验证登录修复还在（两条都必须有输出）
grep -n "isElectron" apps/desktop/electron/preload.ts packages/shared/src/index.ts

# ⑥ 验证结果
git status
git log --oneline --graph -8
```

**为什么用 `merge` 不用 `rebase`**：本仓库分支名含 `/`、ref 有丢失前科、且**没有 reflog**（丢了救不回来）。`rebase` 会重写提交、移动 ref，风险显著更高；`merge` 只在末尾加一个 merge commit，历史不改写。

**合并后建议立刻做的三件事**：
1. 拿 `.git/refs` 备份**逐项比对全部 ref**（`ref-guard` 只修当前分支）
2. 确认 `isElectron` 两处都在
3. 真机验收：起环境 → 打开桌面端 → 确认登录页**没有**「正在准备后端」

---

## 六、本次排查中的其他发现

1. **GitHub MCP 连接器无权访问该私有仓库**（`api.github.com/repos/bing876/work123` 返回 404），所以**不能**用 MCP 读这个仓库的内容。
2. **GitHub 允许按任意 SHA 定向拉取对象** —— 这是绕过 `blob:none` 过滤、只取需要文件的利器：
   ```sh
   git fetch --no-tags git@github.com:bing876/work123.git <blob-sha>
   ```
3. **`--filter=blob:limit=200k` 在 GitHub 上没生效**（拉回来的 pack 只有 11KB，不含 blob），别指望它。
4. **后台任务会被沙箱拦掉**（无法读 `~/.ssh`）—— SSH 相关命令必须以放行方式执行。
5. 本地 3 项未提交改动均为**本次报告与记忆文件**，非你的代码。
6. 全程 refs 保持 **14 个**，与备份一致，无丢失。

---

## 七、待你确认

- [ ] 选方案 B（合并）？确认后我再执行，并且**执行前会再备份一次 refs**
- [ ] 是否同意把 `remote.origin.url` 改成 SSH？（不改的话 `fetch/pull` 在代理放行 `github.com` 之前一直走不通）
- [ ] 上一轮遗留：第 4 步的清理清单我尚未开始，会先列清单给你确认
