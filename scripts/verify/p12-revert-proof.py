"""#12 反证：把 PHONE_PEPPER 校验改回「缺省回落 DATA_KEY」，验证断言变红。

注入（还原加固前的真实形态）：
  · 去掉 `PHONE_PEPPER` 进 missing 的强制检查
  · 去掉「太短」检查
  · 返回值改回 `phonePepper || dataKey`

预期变红：
  ② 缺 PHONE_PEPPER 时**拒绝启动**   → 旧代码会照常启动
  ② 错误信息点名 PHONE_PEPPER
  ② 用的是「缺少环境变量」这条既有错误路径
  ③ 过短的 PHONE_PEPPER 被拒
  ③ 报的是「太短」而不是别的错

跑完自动还原并复跑确认回到全绿。

用法： python scripts/verify/p12-revert-proof.py
"""
import os
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUTDIR = os.path.join(REPO, "docs", "acceptance", "p1-fix")
ENV_TS = os.path.join(REPO, "apps", "server", "src", "env.ts")
os.makedirs(OUTDIR, exist_ok=True)

INJECTIONS = [
    # 1) 去掉"必填"强制
    ("""  if (!phonePepper) {
    missing.push('PHONE_PEPPER');
  }
""", ""),
    # 2) 去掉长度检查
    ("""  if (phonePepper.length < 16) {
    throw new Error('PHONE_PEPPER 太短：至少 16 字符，建议用 64 位十六进制。');
  }
""", ""),
    # 3) 返回值改回旧的回退写法
    ("    phonePepper,\n", "    phonePepper: phonePepper || dataKey,\n"),
]


def build():
    r = subprocess.run(["npm", "run", "build", "-w", "@ai-workbench/server"], cwd=REPO,
                       shell=True, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=300)
    if r.returncode != 0:
        print("    [!!] 构建失败:", (r.stdout or "")[-500:], (r.stderr or "")[-300:])
        return False
    return True


def run_verify(tag):
    log = os.path.join(OUTDIR, "p12-revert-%s.log" % tag)
    with open(log, "w", encoding="utf-8", errors="replace") as f:
        subprocess.run([sys.executable, "-u", os.path.join(HERE, "p12-env-verify.py")],
                       cwd=REPO, stdout=f, stderr=subprocess.STDOUT, timeout=600)
    txt = open(log, encoding="utf-8", errors="replace").read()
    fails = re.findall(r"^\s*✗\s+(.+)$", txt, re.M)
    m = re.search(r"结果：(\d+) 条断言，(\d+) 条失败", txt)
    if m:
        print("    [result] %s 条断言 / %s 条失败" % (m.group(1), m.group(2)))
    for x in fails:
        print("        ✗", x.strip())
    return (int(m.group(1)) if m else -1), (int(m.group(2)) if m else -1), fails


def main():
    print("=" * 70)
    print("#12 反证：改回「缺省回落 DATA_KEY」→ 断言必须变红")
    print("=" * 70)

    original = open(ENV_TS, encoding="utf-8").read()
    results = {}
    try:
        print("\n[0] 基线（已加固）—— 期望 0 条失败")
        if not build():
            return 1
        t, f, _ = run_verify("baseline")
        results["baseline"] = (t, f, [])
        if f != 0:
            print("    !! 基线不绿，反证无意义")
            return 1

        print("\n[1] 注入：改回旧写法")
        src = original
        for cur, old in INJECTIONS:
            if cur not in src:
                print("    [!!] 找不到片段:", repr(cur[:60]))
                return 1
            src = src.replace(cur, old, 1)
            print("    [patch] %s" % (cur.strip().splitlines()[0][:60]))
        open(ENV_TS, "w", encoding="utf-8").write(src)

        if not build():
            return 1
        t, f, fails = run_verify("injected")
        results["injected"] = (t, f, fails)
    finally:
        print("\n[2] 还原")
        open(ENV_TS, "w", encoding="utf-8").write(original)
        print("    [restore] 已还原 env.ts")
        build()

    t, f, _ = run_verify("restored")
    results["restored"] = (t, f, [])

    print("\n" + "=" * 70)
    print("反证判定")
    print("=" * 70)
    ok = True
    print("基线失败数    :", results["baseline"][1], "（期望 0）")
    ok &= results["baseline"][1] == 0

    inj = results["injected"]
    expect_hits = [
        "缺 PHONE_PEPPER 时**拒绝启动**",
        "错误信息点名 PHONE_PEPPER",
        "过短的 PHONE_PEPPER 被拒",
        "报的是「太短」而不是别的错",
    ]
    print("注入后失败数  :", inj[1], "（期望 >0）")
    all_hit = True
    for h in expect_hits:
        hit = any(h in x for x in inj[2])
        print("   命中 %-32s: %s" % (h, hit))
        all_hit &= hit
    ok &= (inj[1] > 0 and all_hit)

    print("还原后失败数  :", results["restored"][1], "（期望回到 0）")
    ok &= results["restored"][1] == 0

    print("\n结论：", "反证成立 ✔ 断言有效且加固可逆" if ok else "反证不成立 ✗ 需补强断言")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
