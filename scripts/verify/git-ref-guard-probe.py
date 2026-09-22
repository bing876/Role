"""ref-guard 验证探针：6 个场景 + 反证。

## 为什么在**临时仓库**里测，而不是直接在真仓库上折腾
真仓库的 ref 是"活"的 —— 测试要故意删它。虽然守卫会修回来，但万一守卫本身有 bug，
测试就变成了事故。所以在临时仓库里**复现同样的条件**（含 `/` 的分支名 + reflog），
既安全又能反复跑。

**真仓库上的端到端演练**由"最后一次真提交"完成（见交付报告）——
那一次会真的触发 post-commit 钩子、真的丢 ref、真的被自动修回来。

## 覆盖的场景
  1. 正常        → 静默通过、退出 0、ref 一个字节都不动
  2. 删 ref 文件  → 检测 + 修复
  3. ref 写成旧 sha（模拟"提交没落盘，还停在上一次"） → 检测 + 修复
  4. 删掉整个 refs/heads/<dir>/ 目录（**真实故障形态**） → 重建目录 + 修复
  5. detached HEAD → 跳过，不误改
  6. 历史塌陷（根提交 > 1） → **报警**（但不自动改历史）

## 反证
把守卫里"写回 ref"那一步换成空操作（只检测不修），
则 **场景 2/3/4 必须变红** —— 否则说明断言根本没打到修复路径。

用法： python scripts/verify/git-ref-guard-probe.py
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
GUARD = os.path.join(REPO, "scripts", "git", "ref-guard.sh")

fails, total = [], 0


def chk(cond, label, detail=""):
    global total
    total += 1
    if cond:
        print("  PASS  " + label)
    else:
        print("  FAIL  " + label + ("   " + detail if detail else ""))
        fails.append(label)
    return cond


def run(cmd, cwd, check=True):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", shell=isinstance(cmd, str))
    if check and r.returncode != 0:
        raise RuntimeError("命令失败: %s\n%s\n%s" % (cmd, r.stdout, r.stderr))
    return r


def git(args, cwd, check=True):
    return run(["git"] + args, cwd, check=check)


def make_repo(tmp, branch="arena/probe-branch"):
    """造一个带 `/` 分支名、有两条提交的临时仓库。"""
    git(["init", "-q"], tmp)
    git(["config", "user.email", "probe@local"], tmp)
    git(["config", "user.name", "probe"], tmp)
    git(["config", "commit.gpgsign", "false"], tmp)
    with open(os.path.join(tmp, "a.txt"), "w") as f:
        f.write("a\n")
    git(["add", "a.txt"], tmp)
    git(["commit", "-qm", "first"], tmp)
    first = git(["rev-parse", "HEAD"], tmp).stdout.strip()
    git(["checkout", "-q", "-b", branch], tmp)
    with open(os.path.join(tmp, "b.txt"), "w") as f:
        f.write("b\n")
    git(["add", "b.txt"], tmp)
    git(["commit", "-qm", "second"], tmp)
    second = git(["rev-parse", "HEAD"], tmp).stdout.strip()
    return first, second


def ref_path(tmp, branch="arena/probe-branch"):
    return os.path.join(tmp, ".git", "refs", "heads", *branch.split("/"))


def read_ref(tmp, branch="arena/probe-branch"):
    p = ref_path(tmp, branch)
    if not os.path.exists(p):
        return None
    return open(p).read().strip()


def run_guard(tmp, guard=GUARD, quiet=False):
    cmd = ["sh", guard] + (["--quiet"] if quiet else [])
    return run(cmd, tmp, check=False)


def main():
    print("=" * 70)
    print("ref-guard 验证探针")
    print("=" * 70)

    if not chk(os.path.exists(GUARD), "守卫脚本存在", GUARD):
        return 1

    tmp = tempfile.mkdtemp(prefix="refguard_")
    try:
        first, second = make_repo(tmp)
        print("    临时仓库：%s" % tmp)
        print("    分支 arena/probe-branch，first=%s second=%s" % (first[:8], second[:8]))

        # ---------------- 1. 正常 ----------------
        print("\n[1] 正常：不该动任何东西")
        before = read_ref(tmp)
        r = run_guard(tmp)
        chk(r.returncode == 0, "① 退出码 0", "rc=%s" % r.returncode)
        chk(read_ref(tmp) == before, "① ref 未被改动", "before=%s after=%s" % (before, read_ref(tmp)))
        chk("正常" in r.stdout, "① 报告「正常」", r.stdout.strip()[:120])

        # ---------------- 2. 删 ref 文件 ----------------
        print("\n[2] 删掉 ref 文件 → 应检测并修复")
        os.remove(ref_path(tmp))
        chk(read_ref(tmp) is None, "② 前提：ref 文件确实没了")
        r = run_guard(tmp)
        chk(r.returncode == 0, "② 退出码 0（修复成功）", "rc=%s stderr=%s" % (r.returncode, r.stderr[:120]))
        chk(read_ref(tmp) == second, "② ★ ref 被修回正确 sha", "实际=%s" % read_ref(tmp))
        chk("已自动修复" in r.stdout, "② ★ 打出了修复提示", r.stdout.strip()[:150])
        log = os.path.join(tmp, ".git", "ref-guard.log")
        chk(os.path.exists(log) and "FIXED" in open(log, encoding="utf-8", errors="replace").read(),
            "② ★ 写进了 ref-guard.log", log)

        # ---------------- 3. ref 写成旧 sha ----------------
        print("\n[3] 把 ref 写成旧 sha（模拟「提交没落盘」）→ 应纠正")
        with open(ref_path(tmp), "w") as f:
            f.write(first + "\n")
        chk(read_ref(tmp) == first, "③ 前提：ref 指向旧 sha")
        r = run_guard(tmp)
        chk(r.returncode == 0, "③ 退出码 0", "rc=%s" % r.returncode)
        chk(read_ref(tmp) == second, "③ ★ 被纠正到最新 sha", "实际=%s" % read_ref(tmp))

        # ---------------- 4. 删掉整个 refs/heads/<dir>/ 目录（真实故障形态） ----------------
        print("\n[4] 删掉整个 refs/heads/arena/ 目录（★ 真实故障形态）→ 应重建")
        shutil.rmtree(os.path.join(tmp, ".git", "refs", "heads", "arena"))
        chk(not os.path.isdir(os.path.join(tmp, ".git", "refs", "heads", "arena")), "④ 前提：目录没了")
        r = run_guard(tmp)
        chk(r.returncode == 0, "④ 退出码 0", "rc=%s" % r.returncode)
        chk(os.path.isdir(os.path.join(tmp, ".git", "refs", "heads", "arena")), "④ ★ 目录被重建")
        chk(read_ref(tmp) == second, "④ ★ ref 写回正确 sha", "实际=%s" % read_ref(tmp))
        chk(git(["rev-parse", "HEAD"], tmp).returncode == 0, "④ ★ git rev-parse HEAD 恢复正常")
        chk(git(["log", "-1", "--oneline"], tmp).stdout.strip().endswith("second"),
            "④ ★ git log -1 能看到提交", git(["log", "-1", "--oneline"], tmp).stdout.strip()[:60])

        # ---------------- 5. detached HEAD ----------------
        print("\n[5] detached HEAD → 应跳过，不误改")
        git(["checkout", "-q", first], tmp)
        # 此时 ref 仍在，但 HEAD 不指向它
        before5 = read_ref(tmp)
        r = run_guard(tmp)
        chk(r.returncode == 0, "⑤ 退出码 0", "rc=%s" % r.returncode)
        chk(read_ref(tmp) == before5, "⑤ ★ ref 未被误改", "before=%s after=%s" % (before5, read_ref(tmp)))
        git(["checkout", "-q", "arena/probe-branch"], tmp)

        # ---------------- 6. 历史塌陷（根提交 > 1） ----------------
        print("\n[6] 合并两条无关历史（根提交 = 2）→ 应报警但不改历史")
        git(["checkout", "-q", "--orphan", "orphan-side"], tmp)
        git(["rm", "-rf", "."], tmp, check=False)
        with open(os.path.join(tmp, "c.txt"), "w") as f:
            f.write("c\n")
        git(["add", "c.txt"], tmp)
        git(["commit", "-qm", "orphan"], tmp)
        git(["checkout", "-q", "arena/probe-branch"], tmp)
        git(["merge", "-q", "--allow-unrelated-histories", "orphan-side", "-m", "merge"], tmp)
        roots = git(["rev-list", "--max-parents=0", "HEAD"], tmp).stdout.strip().splitlines()
        chk(len(roots) == 2, "⑥ 前提：确实有 2 个根提交", "实际 %d 个" % len(roots))
        head6 = git(["rev-parse", "HEAD"], tmp).stdout.strip()
        r = run_guard(tmp)
        chk(r.returncode == 0, "⑥ 退出码 0（报警不是失败）", "rc=%s" % r.returncode)
        chk("历史异常" in r.stderr or "根提交" in r.stderr, "⑥ ★ 报了历史异常警", r.stderr.strip()[:150])
        chk(git(["rev-parse", "HEAD"], tmp).stdout.strip() == head6,
            "⑥ ★ 没有自动改历史（HEAD 未变）")

        # ---------------- 反证 ----------------
        print("\n[反证] 把「写回 ref」那步换成空操作 → 场景 2/3/4 必须变红")
        broken = os.path.join(tmp, "ref-guard-broken.sh")
        src = open(GUARD, encoding="utf-8").read()
        # 注入坏条件：保留"检测"，但**不修**（保持函数签名/返回类型不变）
        inj = src.replace('printf \'%s\\n\' "$LAST" > "$REF_PATH" 2>/dev/null',
                          ': # 注入：故意不写回（反证用）')
        if inj == src:
            chk(False, "反证注入点找得到", "没找到要替换的那一行")
        else:
            open(broken, "w", encoding="utf-8").write(inj)
            tmp2 = tempfile.mkdtemp(prefix="refguard_rev_")
            try:
                f2, s2 = make_repo(tmp2)
                # 场景 2'
                os.remove(ref_path(tmp2))
                r2 = run_guard(tmp2, guard=broken)
                chk(read_ref(tmp2) is None,
                    "★ 反证②：不写回时 ref 修不好（若这里没红，说明断言没打到修复路径）",
                    "竟然修好了=%s" % read_ref(tmp2))
                # 场景 4'
                shutil.rmtree(os.path.join(tmp2, ".git", "refs", "heads", "arena"))
                r4 = run_guard(tmp2, guard=broken)
                chk(not os.path.isdir(os.path.join(tmp2, ".git", "refs", "heads", "arena"))
                    or read_ref(tmp2) != s2,
                    "★ 反证④：不写回时目录/ref 恢复不了")
                # 对照：恢复真实守卫 → 立刻能修好（证明"红的确实是注入造成的"）
                r5 = run_guard(tmp2)
                chk(read_ref(tmp2) == s2, "★ 对照组：真实守卫能修好（证明上面的红是注入造成的）",
                    "实际=%s" % read_ref(tmp2))
            finally:
                shutil.rmtree(tmp2, ignore_errors=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n" + "=" * 70)
    print("结果：%d 条断言，%d 条失败" % (total, len(fails)))
    for x in fails:
        print("   ✗", x)
    print("=" * 70)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
