#!/bin/sh
#
# install-hooks.sh —— 把 core.hooksPath 指向仓库内的 scripts/git/hooks。
#
# 为什么用 core.hooksPath 而不是把文件拷进 .git/hooks/：
#   拷进去的文件**不进版本控制**，换机器 / 重新克隆就没了，得靠人记得重装。
#   指到仓库内目录后，钩子**随仓库版本化** —— 克隆下来跑一次本脚本即可。
#
# 用法：sh scripts/git/install-hooks.sh

set -u

ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$ROOT" ]; then
  echo "❌ 当前目录不在 git 仓库里" >&2
  exit 1
fi

HOOKS="$ROOT/scripts/git/hooks"
GITDIR=$(git rev-parse --absolute-git-dir 2>/dev/null)

if [ ! -d "$HOOKS" ]; then
  echo "❌ 找不到钩子目录：$HOOKS" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1) 先看 .git/hooks/ 里有没有**别人的**钩子 —— 有的话要提醒，
#    因为一旦设了 core.hooksPath，git 就只认新目录，旧钩子**静默失效**。
# ---------------------------------------------------------------------------
EXISTING=""
if [ -n "$GITDIR" ] && [ -d "$GITDIR/hooks" ]; then
  for h in "$GITDIR/hooks"/*; do
    [ -f "$h" ] || continue
    case "$h" in *.sample) continue ;; esac
    EXISTING="$EXISTING $(basename "$h")"
  done
fi
if [ -n "$EXISTING" ]; then
  echo "⚠️  .git/hooks/ 里已有自定义钩子：$EXISTING"
  echo "    设了 core.hooksPath 之后，这些钩子**不会再被 git 调用**。"
  echo "    请先把它们合并进 $HOOKS ，或自行确认可以弃用。"
  echo
fi

# ---------------------------------------------------------------------------
# 2) 设置 core.hooksPath —— **用绝对路径**。
#    git 文档对"相对路径相对谁"的说法绕（$GIT_DIR 还是工作区），
#    绝对路径没有歧义，换 cwd 也不会错。
# ---------------------------------------------------------------------------
git config core.hooksPath "$HOOKS" || {
  echo "❌ 设置 core.hooksPath 失败" >&2
  exit 1
}

# 3) 可执行位（Windows 上通常无所谓，但跨平台克隆时需要）
chmod +x "$HOOKS"/* "$ROOT/scripts/git/ref-guard.sh" 2>/dev/null

# ---------------------------------------------------------------------------
# 4) 自检：把 git 实际认到的路径打出来，并真跑一次守卫
# ---------------------------------------------------------------------------
EFFECTIVE=$(git config core.hooksPath)
echo "✅ 已安装"
echo "   core.hooksPath = $EFFECTIVE"
if [ "$EFFECTIVE" != "$HOOKS" ]; then
  echo "   ⚠️  读回来的值与写入的不一致，请检查是否有更高优先级的配置覆盖了它"
fi
echo "   钩子文件：$(ls "$HOOKS" 2>/dev/null | tr '\n' ' ')"

echo
echo "自检：跑一次守卫"
sh "$ROOT/scripts/git/ref-guard.sh" || echo "   （守卫报了非零退出码，见上面输出）"
