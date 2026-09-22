"""反证：把改动点 3 **改回旧写法**（404 不带语义码），验证 loop-gone-probe 会变红。

## 注入点
`apps/server/src/routes/loop.ts` 里 `/agent/loop/resume` 的两处 404：

    改前：errJson(reply, 404, '这个循环不存在或已过期', { code: 'loop_gone' })
    改后：errJson(reply, 404, '这个循环不存在或已过期')        ← 旧行为：笼统 404

只改 `/agent/loop/resume` 这一条路由（用带 `loop_gone` 的原文精确匹配，
其它路由的 404 文案不同，不会被误伤）。**保持可编译**：去掉一个可选参数而已。

## 预期
    变红：① 循环不存在 → 带 code=loop_gone
    不变：② 缺 loopId → 400（本来就没码）
          ③ 未登录   → 401（本来就没码）

用法：
    python scripts/verify/p0-loop-ttl/loop-gone-revert-proof.py
"""
import os
import re
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
LOOP_TS = os.path.join(REPO, "apps", "server", "src", "routes", "loop.ts")
PROBE = os.path.join(HERE, "loop-gone-probe.mjs")
NODE = (
    r"C:\Users\bing\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe"
    if os.path.exists(r"C:\Users\bing\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe")
    else "node"
)

OLD = "'这个循环不存在或已过期', { code: 'loop_gone' })"
NEW = "'这个循环不存在或已过期')"

EXPECT_RED = {1}
EXPECT_GREEN = {2, 3}


def build():
    p = subprocess.run(
        ["npm", "run", "build", "-w", "@ai-workbench/server"],
        cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace", shell=True,
    )
    return p.returncode == 0, (p.stdout or "") + (p.stderr or "")


def run_probe():
    p = subprocess.run(
        [NODE, PROBE], cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    out = (p.stdout or "") + (p.stderr or "")
    red, green = set(), set()
    for line in out.splitlines():
        m = re.match(r"(PASS|FAIL) (\d+)\.", line)
        if m:
            (green if m.group(1) == "PASS" else red).add(int(m.group(2)))
    return red, green, out


def main():
    src = open(LOOP_TS, "r", encoding="utf-8").read()
    cnt = src.count(OLD)
    if cnt != 2:
        print(f"FAIL 注入点数量不对：期望 2 处，实际 {cnt} 处）—— 先确认 routes/loop.ts 有没有被别人改过")
        return 2

    backup = LOOP_TS + ".bak-revert-proof"
    shutil.copyfile(LOOP_TS, backup)
    print(f"已备份源码 → {os.path.basename(backup)}（注入点 {cnt} 处）")

    try:
        open(LOOP_TS, "w", encoding="utf-8").write(src.replace(OLD, NEW))
        patched = open(LOOP_TS, "r", encoding="utf-8").read()
        if NEW not in patched or OLD in patched:
            print("FAIL 注入没落盘")
            return 2
        ok, log = build()
        if not ok:
            print("FAIL 构建失败：\n" + log[-2000:])
            return 2
        print("已注入：两处 404 去掉 code=loop_gone，并已重新构建 dist\n")

        red, green, out = run_probe()
        print("── 注入后的探针输出 ──")
        for line in out.splitlines():
            if re.match(r"(PASS|FAIL|合计|失败)", line):
                print("  " + line)

        verdict = True
        missing = sorted(EXPECT_RED - red)
        if missing:
            verdict = False
            print(f"\n!! 应该变红却没红：{missing} —— 断言没打到被测路径，是摆设")
        else:
            print(f"\n✓ 预期变红的 {sorted(EXPECT_RED)} 变红")
        extra = sorted(red & EXPECT_GREEN)
        if extra:
            verdict = False
            print(f"!! 不该红的却红了：{extra}")
        else:
            print(f"✓ 预期不受影响的 {sorted(EXPECT_GREEN)} 仍然全绿（注入是精确的）")
    finally:
        shutil.copyfile(backup, LOOP_TS)
        os.remove(backup)
        restored = open(LOOP_TS, "r", encoding="utf-8").read()
        if OLD not in restored:
            print("\n!! 恢复失败 —— 请手工检查 routes/loop.ts！")
            return 2
        print("\n已恢复源码（复查：原始写法已回）")
        ok2, log2 = build()
        if not ok2:
            print("!! 恢复后构建失败：\n" + log2[-1500:])
            return 2

    red2, green2, out2 = run_probe()
    print("\n── 恢复后的探针输出 ──")
    for line in out2.splitlines():
        if re.match(r"(PASS|FAIL|合计|失败)", line):
            print("  " + line)
    if red2:
        print("!! 恢复后仍有红的")
        return 1
    print("\n反证结论：注入坏条件 → ① 变红；恢复 → 3 条全绿。断言有效。")
    return 0 if verdict else 1


if __name__ == "__main__":
    sys.exit(main())
