# 🚨 事故报告：合并过程中 git 对象库被删

> 时间：2026-09-22 08:44 ~ 08:56  
> 仓库：`C:\Users\bing\workbuddy-ai\work123` · 分支：`arena/01a0c1e3-work123`

---

## 一、一句话结论

**执行你确认的「方案 B 合并」时，`git merge` 被超时中断，`.git` 对象库被大规模删除（217M → 962K）。**

**但你的工作成果没有丢**：工作区 2280 个文件完好无损，且已立刻备份到 J 盘。

---

## 二、损害范围（已精确核实）

| 项目                    | 状态                                                                   |
| --------------------- | -------------------------------------------------------------------- |
| **工作区文件**             | ✅ **完好**（2280 个文件 / 1.2G，含登录修复两处）                                    |
| **J 盘备份**             | ✅ `J:\11111\wb-backup-20260922\work123-worktree.tar`（350MB / 1697 项） |
| **本地 5 条提交**          | ✅ **对象存活**（`git log 3c68c22` 可完整遍历到根）                                |
| **远端历史 `15daa00`**    | ✅ 对象存活，且可经 SSH 重新拉取                                                  |
| **`d16e3133` 临时提交对象** | ❌ **丢失**（但其内容 = 工作区，可重新提交复原）                                         |
| **17 个 pack 文件**      | ❌ 被删（`pack-*.idx` 还在，`pack-*.pack` 没了）                               |
| **松散对象**              | ❌ 0 个（原先有 238 个重建的 blob）                                             |
| **`refs/` 目录**        | ❌ 被整个删除 → 已从备份恢复（14 项）                                               |
| **多数 tree / blob**    | ❌ 丢失（远端历史部分可重新 fetch；本地独有内容在工作区里）                                    |

**当前仓库处于「半坏」状态**：

- `refs/heads/arena/01a0c1e3-work123` → `d16e3133`（**对象已不存在**）⇒ `git log` 报 `bad object HEAD`
- `origin/arena/01a0c1e3-work123` → `3c68c22`（回退到备份时的值；force-fetch 的更新随 refs 一起丢了）

---

## 三、事件时间线

| 时刻           | 事件                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| 08:44        | 备份 refs → 改 `remote.origin.url` 为 SSH → `git fetch --force origin` **成功**（`3c68c22...15daa00 forced update`） |
| 08:44        | refs 复查：14 项，完好                                                                                              |
| 08:44~08:46  | 执行 `git merge --no-edit origin/arena/01a0c1e3-work123`                                                       |
| **08:46:34** | **`.git/objects/pack` 的 mtime；17 个 pack 在此前后被删**                                                             |
| ~08:49       | merge 命令 **SIGTERM**（300s 超时被杀）                                                                              |
| 08:51        | 发现 `git status` 认错仓库（跑到 `C:\Users\bing`）                                                                     |
| 08:52        | 查明 `.git/refs` 被整个删除                                                                                         |
| 08:53        | 从 `_refs-backup-work123-premerge` 恢复 14 个 ref                                                                |
| 08:54        | 发现对象库仅剩 962K，17 pack 缺失                                                                                      |
| 08:54        | **工作区备份到 J 盘**（350MB）                                                                                        |
| 08:56        | 确认本地 5 条提交 + 远端 `15daa00` 的对象均存活                                                                             |

---

## 四、根因分析（诚实标注证据等级）

**确定的事实**：

- 删除发生在 **08:46:34**，与 `git merge` 执行窗口完全重合
- 删除对象是 `.git/objects/pack/*.pack`（17 个）与 `.git/refs/`（整目录）
- 当时 `.git/config` 里 `gc.auto = 0`、`maintenance.auto = false` ⇒ **不是自动 gc 触发的**

**推断（未证实）**：

1. **最可能**：`git merge` 在 partial clone 上触发了对大量缺失 blob 的懒加载（promisor 远端此时已改成可达的 SSH），进程被 SIGTERM 强杀在写 pack / 重建索引的中间态，留下了「新 pack 写了一半、旧 pack 已被删」的状态。
2. 次可能：命令在**沙箱**内执行，SIGTERM 后沙箱的清理机制（机器上有 `sandbox-cli-gc.exe`）回收了它认为属于该次执行的文件。
3. 已排除：自动 gc / prune（配置明确关闭）、磁盘写满（当时还有 3.0G）。

> ⚠️ **我没有确证根因。** 在弄清之前，**不应再次对 `.git` 执行 merge / fetch / gc 类操作**。

---

## 五、建议的恢复步骤（**待你确认后再执行**）

### 第 1 步：修复 ref（只改一个文件，安全）

```sh
printf '3c68c22948772577163bb3b34dccd3807b75ce45\n' > .git/refs/heads/arena/01a0c1e3-work123
git log --oneline -3          # 应恢复显示 3c68c22 / cf3ab2c / 1c998ac
git status                    # 应重新出现「6 个修改 + 未跟踪文件」
```

### 第 2 步：重新提交工作区（复原 `d16e3133` 的内容）

`d16e3133` 的树 = 工作区当前状态，所以重新提交即可等价复原：

```sh
export GIT_NO_LAZY_FETCH=1
git add -A
git commit -m "临时保存：切换分支前的本地修改备份（重建）"
```

### 第 3 步：恢复远端对象（**建议先只做这一步，不要急着 merge**）

```sh
export GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20"
git fetch --force origin arena/01a0c1e3-work123
```

### 第 4 步：合并（**先搞清楚第四节的根因再做**）

```sh
git merge origin/arena/01a0c1e3-work123
```

### 第 5 步：立刻把修复结果推到远端

现在**本地是唯一的副本**（`.git` 已损坏、无 reflog）。合并完成后应尽快 `git push` 到远端，  
让远端成为第二份副本，否则再出一次同样的事故就真没救了。

---

## 六、当前可用的资产

| 资产      | 位置                                                               | 说明                        |
| ------- | ---------------------------------------------------------------- | ------------------------- |
| 工作区快照   | `J:\11111\wb-backup-20260922\work123-worktree.tar`               | 350MB / 1697 项，含全部源码与探针脚本 |
| refs 备份 | `C:\Users\bing\workbuddy-ai\_refs-backup-work123-premerge\refs\` | 14 项，pre-merge 状态         |
| refs 备份 | `C:\Users\bing\workbuddy-ai\_refs-backup-work123-0740\`          | 14 项                      |
| 回滚点记录   | `C:\Users\bing\workbuddy-ai\_rollback-premerge.txt`              | 记录 d16e3133 与回滚命令         |
| 远端仓库    | `git@github.com:bing876/work123.git`（经 SSH）                      | 含 `15daa00` 完整历史          |

---

## 七、必须告诉你的两件事

1. **你的代码一行没丢。** 工作区完好 + 已备份。丢的是 git 的**历史包装**（pack 文件、一个临时提交对象），不是文件内容。
2. **本地 `.git` 现在是脆弱的。** 在根因查清之前，我不会再对它跑 merge/fetch/gc。如果你希望，我可以先只做「第 1、2 步」（纯本地、不碰网络、不碰远端），把仓库恢复到「有干净 HEAD + 工作区已提交」的可用状态。
