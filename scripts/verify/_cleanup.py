"""按用户确认的保守方案执行清理（走回收站，可恢复）。

用法：
    python scripts/verify/_cleanup.py --dry-run    # 只列清单，不动
    python scripts/verify/_cleanup.py --go         # 真删（分批，每批核验）

## 用户确认的方案（2026-09-20）
删：A3+A4（备份里的两份 release 副本）、B（测试 Electron 用户目录）、
    C（Python 字节码缓存）、E（空的 NVIDIA Corporation 目录）
移：D（根目录散落的 scen-*.log 等）→ docs/acceptance/ 归档
留：A1+A2（release 本体）、F（_rollback-backup 里的 asar 备份与源码快照）
"""
import ctypes
import glob
import os
import shutil
import struct
import sys
from ctypes import wintypes

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = r"C:\Users\bing\workbuddy-ai\work123"
MANIFEST = os.path.join(REPO, "_deleted_manifest.txt")
ARCHIVE = os.path.join(REPO, "docs", "acceptance")

# ---------------------------------------------------------------------------
# 回收站删除（本机唯一可用写法；详见 skills/win-recycle-delete）
# ---------------------------------------------------------------------------
class SHFILEOPSTRUCTW(ctypes.Structure):
    _fields_ = [
        ("hwnd", wintypes.HWND),
        ("wFunc", wintypes.UINT),
        ("pFrom", wintypes.LPCWSTR),
        ("pTo", wintypes.LPCWSTR),
        ("fFlags", ctypes.c_uint16),
        ("fAnyOperationsAborted", wintypes.BOOL),
        ("hNameMappings", ctypes.c_void_p),
        ("lpszProgressTitle", wintypes.LPCWSTR),
    ]


FO_DELETE = 3
FOF_SILENT = 0x0004
FOF_NOCONFIRMATION = 0x0010
FOF_ALLOWUNDO = 0x0040      # ← 没有它 = 永久删除
FOF_NOERRORUI = 0x0400


def recycle(paths):
    if not paths:
        return 0
    op = SHFILEOPSTRUCTW()
    op.hwnd = None
    op.wFunc = FO_DELETE
    op.pFrom = "\0".join(paths) + "\0\0"   # 双 null 结尾
    op.pTo = None
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI
    return ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))


def recycle_bin_dir():
    """找到当前用户的回收站目录（$I/$R 所在）"""
    root = os.path.join("C:\\", "$RECYCLE.BIN")
    if not os.path.isdir(root):
        return None
    for d in os.listdir(root):
        p = os.path.join(root, d)
        if os.path.isdir(p) and glob.glob(os.path.join(p, "$I*")):
            return p
    return None


def count_recycle():
    rb = recycle_bin_dir()
    if not rb:
        return -1
    return len(glob.glob(os.path.join(rb, "$I*")))


def dir_size(path):
    total = 0
    if os.path.isfile(path):
        try:
            return os.path.getsize(path)
        except OSError:
            return 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def mb(n):
    return "%.1f MB" % (n / 1048576) if n >= 1048576 else "%.1f KB" % (n / 1024)


# ---------------------------------------------------------------------------
# 清理计划
# ---------------------------------------------------------------------------
def build_plan():
    """返回 [(批次名, [待删绝对路径...], 说明)]"""
    plan = []

    a3 = os.path.join(REPO, "_rollback-backup-20260918", "release-frameless")
    a4 = os.path.join(REPO, "_rollback-backup-20260918", "release-ui15")
    plan.append(("A3+A4 备份里的两份 release 副本（与 A1/A2 同内容）",
                 [p for p in (a3, a4) if os.path.exists(p)],
                 "apps/desktop/release-* 本体保留"))

    b = [os.path.join(REPO, "_e2e-profile"), os.path.join(REPO, "_probe-profile-fresh")]
    e = os.path.join(REPO, "NVIDIA Corporation")
    plan.append(("B 测试用 Electron 用户目录 + E 空目录",
                 [p for p in b + [e] if os.path.exists(p)],
                 "测试脚本会重建"))

    c_dirs = [os.path.join(REPO, "scripts", "verify", "__pycache__"),
              os.path.join(REPO, "_rollback-backup-20260918", "verify", "__pycache__")]
    plan.append(("C1+C2 __pycache__ 目录",
                 [p for p in c_dirs if os.path.isdir(p)],
                 "Python 自动重建"))

    pycs = []
    for root, dirs, files in os.walk(REPO):
        if "node_modules" in root or ".git" in root:
            continue
        for f in files:
            if f.endswith(".pyc"):
                pycs.append(os.path.join(root, f))
    # 每批最多 10 项
    for i in range(0, len(pycs), 10):
        plan.append(("C3 散落 .pyc 第 %d 批" % (i // 10 + 1), pycs[i:i + 10], ""))

    return plan


def move_plan():
    """D 组：移动到 docs/acceptance/ 归档（不是删除）"""
    items = []
    for f in sorted(os.listdir(REPO)):
        if not os.path.isfile(os.path.join(REPO, f)):
            continue
        if f.startswith("scen-") and f.endswith(".log"):
            items.append(f)
        elif f in ("dev-run.log", "smoke.log"):
            items.append(f)
    return items


def main():
    dry = "--dry-run" in sys.argv
    go = "--go" in sys.argv
    if not dry and not go:
        print("用法：--dry-run 或 --go")
        return 2

    print("=" * 72)
    print("清理计划" + ("（DRY RUN —— 不会动任何文件）" if dry else "（真实执行）"))
    print("=" * 72)

    plan = build_plan()
    total_bytes = 0
    total_items = 0
    for name, paths, note in plan:
        if not paths:
            continue
        size = sum(dir_size(p) for p in paths)
        total_bytes += size
        total_items += len(paths)
        print("\n[%s]  %d 项 / %s%s" % (name, len(paths), mb(size), ("   ← " + note) if note else ""))
        for p in paths:
            rel = os.path.relpath(p, REPO)
            print("    %-72s %s" % (rel[:72], mb(dir_size(p))))

    moves = move_plan()
    print("\n[D 组：移动到 docs/acceptance/ 归档，**不是删除**]  %d 项" % len(moves))
    for f in moves:
        print("    %s → docs/acceptance/%s" % (f, f))

    print("\n" + "-" * 72)
    print("合计待删：%d 项 / %s" % (total_items, mb(total_bytes)))
    print("合计待移：%d 项" % len(moves))

    if dry:
        print("\nDRY RUN 结束，未做任何改动。")
        return 0

    # ------------------------------ 真删 ------------------------------
    lines = ["# 删除清单（走回收站，可恢复）  生成于 %s" % __import__("time").strftime("%Y-%m-%d %H:%M:%S"), ""]
    before = count_recycle()
    print("\n回收站现有 $I 条数：%d" % before)

    ok = True
    for name, paths, _note in plan:
        if not paths:
            continue
        print("\n>>> 删除 [%s]（%d 项）" % (name, len(paths)))
        rc = recycle(paths)
        # ⚠️ rc 不是可靠判据（实测 rc=2 也可能全部成功）—— 只看"还在不在"
        left = [p for p in paths if os.path.exists(p)]
        print("    rc=%s | 仍存在 %d 项" % (rc, len(left)))
        for p in paths:
            lines.append("%s\t%s" % ("OK" if not os.path.exists(p) else "FAIL", p))
        if left:
            ok = False
            for p in left[:5]:
                print("    !! 没删掉：", p)

    with open(MANIFEST, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("\n清单已写：", MANIFEST)

    after = count_recycle()
    print("回收站现有 $I 条数：%d（增加 %d）" % (after, after - before))

    # ------------------------------ D 组：移动 ------------------------------
    print("\n>>> D 组：移动到 docs/acceptance/")
    moved = 0
    for f in moves:
        src = os.path.join(REPO, f)
        dst = os.path.join(ARCHIVE, f)
        if os.path.exists(dst):
            print("    跳过（目标已存在）：", f)
            continue
        shutil.move(src, dst)
        moved += 1
        print("    %s → docs/acceptance/" % f)
    print("    共移动 %d 项" % moved)

    print("\n" + "=" * 72)
    print("删除结果：", "全部成功 ✔" if ok else "有失败项 ✗（见上）")
    print("=" * 72)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
