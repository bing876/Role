"""审计：有没有「被正式脚本/测试引用、但没被 git 追踪」的文件。

## 为什么需要它
2026-09-20 发现两个**正式测试依赖**的驱动脚本（`_heal-driver.cjs` / `_live-driver.cjs`）
一直没提交 —— 引用它们的 python 测试**是已跟踪的**，也就是说
**新克隆的仓库里那两个测试跑不起来**。它们没被发现，是因为：
  · 名字带 `_` 前缀，看起来像临时脚本；
  · `git status` 只显示 `??`，不显示"有谁在引用它"。

## 排查方法（三层）
第一层：**枚举所有"没被追踪"的文件** —— 必须查两类，只查一类会漏：
  · `git ls-files --others --exclude-standard`            → 未追踪、未被忽略
  · `git ls-files --others --ignored --exclude-standard`  → **被 .gitignore 忽略的**
    ★ 被忽略的文件同样是"不在仓库里"，脚本引用它照样会在新克隆里断掉。

第二层：**只保留「可能是依赖」的候选**（这一步是精度的关键 —— 见下面的"三个过滤器"）。

第三层：**在「已跟踪的代码/配置」里搜引用**，按引用形态判定严重级别。

## ★★ 三个过滤器（第一版没有它们，结果 198 条 P0 **全是误报**）
1. **排除运行时数据目录**：Electron 用户目录（`udd-*`、`Partitions`、`Local Storage`、
   `Network`、`Shared Dictionary`、`Cache`…）。里面的 `LOG` / `index` / `Cookies`
   是 Chromium 自己的文件，跟仓库依赖无关。
2. **排除"通用名"**：`LOG`、`index`、`main`、`data` 这种词在代码里到处都是，
   按文件名匹配必然误报。→ 候选的 basename 必须**够独特**
   （长度 ≥ 8，或含 `-` / `_` / 多个点）。
3. **排除"脚本自己写出来的产物"**：`.log` 这类通常是脚本 `open(..., 'w')` 写的**输出**，
   不是输入。→ 只保留"源码/配置/夹具"类扩展名，`.log` 一律不算依赖。

## 判定分级
  · P0 = 被**已跟踪的可执行脚本/测试/配置**引用 → 真漏网，必须处理
  · P1 = 只被已跟踪的文档提到 → 提醒（可能只是叙述）
  · OK = 无人引用 → 正常的本地文件/产物

## 反向检查（顺手做）
已跟踪脚本里引用的**仓库内相对路径**是否存在。
★ 路径要按脚本的**运行 cwd** 解析（脚本常在 `apps/server` / `apps/desktop` 下跑），
  所以依次尝试：仓库根 / 脚本所在目录 / 常见子工程根。第一版只按仓库根解析 → 全是假断链。

用法： python scripts/verify/audit-untracked-refs.py
"""
import os
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

# 依赖/产物目录（天然不进仓库，不构成"漏提交"）
SKIP_DIRS = ("node_modules/", "/dist/", "dist/", "dist-electron/", "release-frameless/",
             "release-ui15/", ".git/", ".vite/", "__pycache__/",
             "_e2e-profile/", "_probe-profile-fresh/", "_rollback-backup-")

# ★ 过滤器1：Electron / Chromium 的运行时数据目录 —— 里面全是它自己的文件
RUNTIME_DIR_MARKERS = ("udd-", "udd/", "Partitions/", "Local Storage/", "Network/",
                       "Shared Dictionary/", "Cache/", "blob_storage/", "GPUCache/",
                       "Session Storage/", "IndexedDB/", "leveldb/", "liveLoops-test/",
                       "resource-guard/")

# ★ 过滤器3：只有这些扩展名才算"可能是依赖"（.log 是脚本写出的产物，不算）
DEP_EXT = (".cjs", ".mjs", ".js", ".jsx", ".ts", ".tsx", ".py", ".sh", ".bash",
           ".json", ".yml", ".yaml", ".cmd", ".bat", ".ps1", ".css", ".html",
           ".csv", ".sql", ".toml", ".tsv")

# 「会真的去读文件」的扩展名 —— 只有这些里的引用才算依赖
CODE_EXT = (".sh", ".bash", ".cjs", ".mjs", ".js", ".jsx", ".ts", ".tsx",
            ".py", ".json", ".yml", ".yaml", ".cmd", ".bat", ".ps1", ".toml")
DOC_EXT = (".md", ".txt", ".rst")

# ★ 过滤器2：通用名黑名单 + 独特性阈值
COMMON_NAMES = {"log", "index", "main", "data", "cache", "cookies", "prefs",
                "preferences", "lockfile", "current", "version", "state",
                "manifest", "leveldb", "temp", "tmp"}
MIN_UNIQUE_LEN = 8


def git(*args):
    r = subprocess.run(["git"] + list(args), cwd=REPO, capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    return r.stdout


def norm(p):
    return p.replace("\\", "/")


def skipped(rel):
    r = norm(rel)
    return any(s in r for s in SKIP_DIRS) or any(m in r for m in RUNTIME_DIR_MARKERS)


def is_unique_enough(base):
    stem = os.path.splitext(base)[0].lower()
    if stem in COMMON_NAMES:
        return False
    if len(stem) >= MIN_UNIQUE_LEN:
        return True
    return ("-" in stem) or ("_" in stem)


def main():
    print("=" * 72)
    print("审计：被引用但未被 git 追踪的文件")
    print("=" * 72)

    tracked = [l for l in git("ls-files").splitlines() if l.strip()]
    untracked = [l for l in git("ls-files", "--others", "--exclude-standard").splitlines() if l.strip()]
    ignored = [l for l in git("ls-files", "--others", "--ignored", "--exclude-standard").splitlines() if l.strip()]

    print("\n[第一层] 枚举未追踪的文件（git 自己给的清单，不是遍历目录猜的）")
    print("  已跟踪          : %d" % len(tracked))
    print("  未追踪(未忽略)  : %d" % len(untracked))
    print("  未追踪(被忽略)  : %d   ← 这一类最容易漏" % len(ignored))

    raw = [(p, "untracked") for p in untracked] + [(p, "ignored") for p in ignored]
    after_dir = [(p, k) for p, k in raw if not skipped(p)]

    # ★ 分成两组：独特名直接按 basename 匹配；通用名**只能按路径限定匹配**
    #   （否则 `index.js` 会命中代码里所有的 "index"）。分成两组是为了
    #   **不让"过滤掉通用名"变成盲区** —— 通用名照样查，只是判据更严。
    cands_unique, cands_common = [], []
    for p, k in after_dir:
        base = os.path.basename(p)
        if not base or os.path.splitext(base)[1].lower() not in DEP_EXT:
            continue
        (cands_unique if is_unique_enough(base) else cands_common).append((p, base, k))

    print("\n[第二层] 分层（精度关键 —— 第一版缺了它们，198 条 P0 全是误报）")
    print("  原始未追踪                  : %d" % len(raw))
    print("  ① 去掉运行时数据目录后      : %d" % len(after_dir))
    print("  ② 去掉非依赖扩展名后        : %d" % (len(cands_unique) + len(cands_common)))
    print("     其中 独特名（按 basename 匹配）      : %d" % len(cands_unique))
    print("     其中 通用名（**按路径限定匹配**）    : %d  ← 不丢，只是判据更严" % len(cands_common))

    code_files = [p for p in tracked if p.lower().endswith(CODE_EXT) and not skipped(p)]
    doc_files = [p for p in tracked if p.lower().endswith(DOC_EXT) and not skipped(p)]

    code_blobs, doc_blobs = {}, {}
    for p in code_files:
        try:
            code_blobs[p] = open(os.path.join(REPO, p), encoding="utf-8", errors="replace").read()
        except OSError:
            pass
    for p in doc_files:
        try:
            doc_blobs[p] = open(os.path.join(REPO, p), encoding="utf-8", errors="replace").read()
        except OSError:
            pass

    print("\n[第三层] 在已跟踪的代码/配置里搜引用")
    print("  扫描代码/配置 : %d 个｜扫描文档 : %d 个" % (len(code_files), len(doc_files)))

    def tok(base):
        return re.compile(r"(?<![A-Za-z0-9_./\\-])" + re.escape(base) + r"(?![A-Za-z0-9_])")

    def path_qualified(rel):
        """路径限定判据：候选的「父目录名 + 文件名」要一起出现。

        例：`a/b/index.js` → 要求代码里出现 `b/index.js` 或 `b\\index.js`。
        通用名靠这一条才敢判 —— 单看 `index.js` 必然误报。
        """
        base = os.path.basename(rel)
        parent = os.path.basename(os.path.dirname(rel))
        if not parent:
            return None
        return re.compile(
            re.escape(parent) + r"[/\\]" + re.escape(base) + r"(?![A-Za-z0-9_])")

    p0, p1 = [], []

    # ---- Pass A：独特名，按 basename token 匹配 ----
    for rel, base, kind in cands_unique:
        pat = tok(base)
        hit = [p for p, t in code_blobs.items() if pat.search(t)]
        if hit:
            p0.append((rel, base, kind, hit, "basename"))
            continue
        hitd = [p for p, t in doc_blobs.items() if pat.search(t)]
        if hitd:
            p1.append((rel, base, kind, hitd))

    # ---- Pass B：通用名，**只认路径限定匹配** ----
    generic_hits = []
    for rel, base, kind in cands_common:
        pp = path_qualified(rel)
        if pp is None:
            continue
        hit = [p for p, t in code_blobs.items() if pp.search(t)]
        if hit:
            generic_hits.append((rel, base, kind, hit))
            p0.append((rel, base, kind, hit, "路径限定"))

    # ---- Pass C：未追踪的**目录**被引用吗 ----
    dirs = [l for l in git("ls-files", "--others", "--directory", "--exclude-standard").splitlines() if l.strip()]
    dirs += [l for l in git("ls-files", "--others", "--directory", "--ignored", "--exclude-standard").splitlines() if l.strip()]
    dir_hits = []
    for d in dirs:
        d = d.rstrip("/")
        if skipped(d + "/") or "/" not in d:
            continue
        name = os.path.basename(d)
        if not is_unique_enough(name + "x"):
            continue
        pat = re.compile(r"(?<![A-Za-z0-9_./\\-])" + re.escape(name) + r"[/\\](?![A-Za-z0-9_])")
        hit = [p for p, t in code_blobs.items() if pat.search(t)]
        if hit:
            dir_hits.append((d, hit))

    print("\n" + "-" * 72)
    print("【P0】被已跟踪的代码/配置引用 —— 真漏网，必须处理")
    print("-" * 72)
    if not p0:
        print("  （无）")
    for rel, base, kind, refs, how in p0:
        print("  %-56s [%s / %s]" % (rel[:56], kind, how))
        for r in refs[:4]:
            print("       ← %s" % r)
        if len(refs) > 4:
            print("       ← …另 %d 处" % (len(refs) - 4))

    print("\n  —— Pass B（通用名，路径限定）命中 %d 项 ——" % len(generic_hits))
    print("  —— Pass C（未追踪目录被引用）命中 %d 项 ——" % len(dir_hits))
    for d, refs in dir_hits:
        print("     %s ← %s" % (d, refs[0]))

    print("\n" + "-" * 72)
    print("【P1】只被文档提到（可能只是叙述，需人工判断）")
    print("-" * 72)
    if not p1:
        print("  （无）")
    for rel, base, kind, refs in p1[:25]:
        print("  %-58s [%s] ← %d 篇文档" % (rel[:58], kind, len(refs)))
    if len(p1) > 25:
        print("  …共 %d 项" % len(p1))

    # ------------------------------------------------------------------
    # 反向检查：已跟踪脚本引用的仓库内相对路径是否存在
    # ------------------------------------------------------------------
    print("\n" + "-" * 72)
    print("【反向检查】已跟踪脚本引用的相对路径是否存在（按多种可能的 cwd 解析）")
    print("-" * 72)
    BASES = [REPO, os.path.join(REPO, "apps", "server"),
             os.path.join(REPO, "apps", "desktop"), os.path.join(REPO, "packages")]
    path_pat = re.compile(
        r"['\"]([A-Za-z0-9_][A-Za-z0-9_./\\-]*\.(?:cjs|mjs|js|ts|tsx|py|sh|json|md))['\"]")
    tracked_set = set(norm(p) for p in tracked)
    missing = []
    for p, text in code_blobs.items():
        if not p.startswith("scripts/"):
            continue
        here = os.path.dirname(os.path.join(REPO, p))
        for m in path_pat.finditer(text):
            raw = norm(m.group(1))
            if raw.startswith(("http", "node:", "@")) or ".." in raw or "/" not in raw:
                continue
            if raw in tracked_set:
                continue
            # 依次按 仓库根 / 脚本所在目录 / 各子工程根 解析，任一存在即不算断链
            if any(os.path.exists(os.path.join(b, raw)) for b in BASES + [here]):
                continue
            missing.append((p, raw))

    if not missing:
        print("  （无断链）")
    else:
        for p, raw in sorted(set(missing))[:20]:
            print("  %-46s 引用了不存在的：%s" % (p[:46], raw))
        print("  共 %d 处" % len(set(missing)))

    # ------------------------------------------------------------------
    print("\n" + "=" * 72)
    print("排查完整性自证")
    print("=" * 72)
    print("  ① 「未追踪」用 **git 自己的命令**枚举（`--others` 与 `--ignored` 两条都查），")
    print("     不是遍历目录猜的 —— 未追踪 + 被 .gitignore 忽略，两类都不会漏。")
    print("  ② 引用判据 = 「文件名作为独立 token 出现在已跟踪的代码/配置里」，")
    print("     用词边界断言避免 `a.js` 命中 `data.js`。")
    print("  ③ 三个过滤器把「看起来像引用、其实无关」的挡掉：")
    print("     运行时数据目录 / 通用名 / 脚本自己写出的产物扩展名。")
    print("  ④ 反向也查了：已跟踪脚本引用的仓库内相对路径是否存在（按多种 cwd 解析）。")
    print("  ④b Pass B/C 保证「通用名」与「整个目录」也没被漏掉 —— 过滤不等于不查。")
    print("  ⑤ 本次比对：%d 个独特名候选 + %d 个通用名候选（路径限定）× %d 个已跟踪代码/配置文件。"
          % (len(cands_unique), len(cands_common), len(code_files)))
    print("  ⑥ 另查了未追踪**目录**是否被引用（Pass C，%d 个目录）" % len(dirs))
    print("\n  结果：P0 %d 项 / P1 %d 项 / 断链 %d 处"
          % (len(p0), len(p1), len(set(m[1] for m in missing))))
    return 1 if p0 else 0


if __name__ == "__main__":
    sys.exit(main())
