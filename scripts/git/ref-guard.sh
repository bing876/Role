#!/bin/sh
#
# ref-guard.sh —— 检测并自动修复「提交后 ref 丢失」
#
# ## 背景（这个 bug 长什么样）
#   本仓库的分支名含 `/`（`arena/01a09b16-work123`）。在这种分支名下，
#   `git commit` 会**打印 sha、退出码 0**，但 `.git/refs/heads/arena/` **整个目录被删**，
#   于是 `git log` 报 "does not have any commits yet"、`git rev-parse HEAD` 报 fatal。
#   本会话内 4 次提交、4 次复现（100%）。
#
# ## 为什么能修
#   **权威来源是 `.git/logs/HEAD`（reflog），它不受这个 bug 影响** —— 末行永远记着新 sha。
#   实测 ref 是在**提交那一刻**就丢的（不是过后才被删），
#   所以 `post-commit` 钩子运行时它已经丢了 → 钩子看得到、也修得了。
#
# ## 退出码
#   0 = 正常，或已自动修复
#   1 = **修复失败**，需要人工介入（会把手工恢复命令一并打出来）
#
# ## 参数
#   --quiet   正常时完全静默（给钩子用）。**修复/报警信息不受 --quiet 影响，永远打印。**
#
# 用法：
#   sh scripts/git/ref-guard.sh            # 手工查一次（带正常状态输出）
#   sh scripts/git/ref-guard.sh --quiet    # 钩子里用

set -u

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

say()  { [ "$QUIET" = 1 ] || echo "$@"; return 0; }
warn() { echo "$@" >&2; }

# ---------------------------------------------------------------------------
# 0) 定位 .git（--absolute-git-dir 不受 cwd 影响，比 --git-dir 稳）
# ---------------------------------------------------------------------------
GITDIR=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 0
[ -d "$GITDIR" ] || exit 0

REFLOG="$GITDIR/logs/HEAD"
[ -f "$REFLOG" ] || exit 0

# ---------------------------------------------------------------------------
# 1) 权威 sha = reflog 末行的第 2 个字段
#    （reflog 格式：<old> <new> <name> <email> <ts> <tz>\t<message>）
# ---------------------------------------------------------------------------
LAST=$(tail -n 1 "$REFLOG" 2>/dev/null | awk '{print $2}')
[ -n "$LAST" ] || exit 0
# 不像 40 位十六进制就绝不乱写（宁可不动，也不能写坏 ref）
case "$LAST" in
  *[!0-9a-f]*) exit 0 ;;
esac
[ ${#LAST} -eq 40 ] || exit 0

# ---------------------------------------------------------------------------
# 2) HEAD 指向哪个 ref；detached HEAD 一律跳过（rebase / 检出某提交时都走这条）
# ---------------------------------------------------------------------------
HEADCONTENT=$(cat "$GITDIR/HEAD" 2>/dev/null || echo "")
case "$HEADCONTENT" in
  "ref: "*) REF=${HEADCONTENT#ref: } ;;
  *) exit 0 ;;
esac
[ -n "$REF" ] || exit 0

REF_PATH="$GITDIR/$REF"
CUR=$(cat "$REF_PATH" 2>/dev/null || echo "")

# ---------------------------------------------------------------------------
# 3) 历史体检（正常/异常两条路都要跑）
#    根提交数应为 1。>1 说明历史可能塌陷过（本仓库真发生过一次：
#    裸 `git reset` 把 34 条历史搞成根提交）—— **只报警，绝不自动改历史**。
# ---------------------------------------------------------------------------
health_check() {
  ROOTS=$(git rev-list --max-parents=0 "$LAST" 2>/dev/null | wc -l | tr -d ' ')
  if [ "${ROOTS:-0}" -gt 1 ]; then
    warn "[ref-guard] ⚠️  历史异常：根提交有 $ROOTS 个（应为 1）—— 可能发生过 history 塌陷"
    warn "[ref-guard]    不会自动改历史，请人工检查（参考 2026-09-20 的事故复盘）。"
    printf '%s  WARN 根提交数=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$ROOTS" >> "$GITDIR/ref-guard.log" 2>/dev/null
  fi
}

# ---------------------------------------------------------------------------
# 4) 一致 → 正常退出
# ---------------------------------------------------------------------------
if [ "$CUR" = "$LAST" ]; then
  say "[ref-guard] ✔ ref 正常：$REF → $LAST"
  health_check
  exit 0
fi

# ---------------------------------------------------------------------------
# 5) 不一致（或文件/目录整个没了）→ 修复
#    mkdir -p 是为了兜住"整个 refs/heads/<dir>/ 目录被删"这个真实故障形态
# ---------------------------------------------------------------------------
mkdir -p "$(dirname "$REF_PATH")" 2>/dev/null
printf '%s\n' "$LAST" > "$REF_PATH" 2>/dev/null

# ---------------------------------------------------------------------------
# 6) 复查：**修完必须读回来确认**，不能只看写操作没报错
# ---------------------------------------------------------------------------
CUR2=$(cat "$REF_PATH" 2>/dev/null || echo "")
if [ "$CUR2" = "$LAST" ]; then
  # 修复信息**不受 --quiet 影响**：这正是需要人看见的那一条
  echo "[ref-guard] ⚠️  检测到 ref 丢失，已自动修复：$REF"
  echo "[ref-guard]    修复前 = ${CUR:-（文件不存在）}"
  echo "[ref-guard]    修复后 = $LAST"
  printf '%s  FIXED %s  修复前=%s  修复后=%s\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$REF" "${CUR:-MISSING}" "$LAST" \
    >> "$GITDIR/ref-guard.log" 2>/dev/null
  health_check
  exit 0
fi

warn "[ref-guard] ❌ ref 修复失败！需要人工介入"
warn "[ref-guard]    期望 sha : $LAST"
warn "[ref-guard]    实际内容 : ${CUR2:-（写不进去）}"
warn "[ref-guard]    ref 路径 : $REF_PATH"
warn "[ref-guard]    手工恢复："
warn "[ref-guard]      mkdir -p \"$(dirname "$REF_PATH")\""
warn "[ref-guard]      printf '%s\\n' '$LAST' > \"$REF_PATH\""
warn "[ref-guard]      git log -1   # 复查"
printf '%s  FAILED %s  期望=%s 实际=%s\n' \
  "$(date '+%Y-%m-%d %H:%M:%S')" "$REF" "$LAST" "${CUR2:-UNWRITABLE}" \
  >> "$GITDIR/ref-guard.log" 2>/dev/null
exit 1
