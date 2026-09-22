"""反证：把改动点 1 **改回旧写法**，验证 ttl-probe 的断言真的会变红。

## 为什么必须做
「测试全绿」有两种可能：断言真的在检查东西，或者断言根本没打到被测路径。
区分的唯一办法是**注入坏条件**：把修复退回旧行为，看断言会不会红。
不红 = 断言是摆设，必须补强后重跑。

## 注入点
只改 `ttlOf()` 的函数体一行：

    改前：return WAITING_STATUSES.has(s.status) ? WAITING_TTL_MS : LOOP_TTL_MS;
    改后：return LOOP_TTL_MS;          ← 等价于「所有状态一律 10 分钟」的旧行为

单点注入即可覆盖三处调用（sweep / getLoop 各一），**且保持可编译**
（`WAITING_STATUSES` 变成未使用的常量，不影响运行）。

## 预期
    变红：① 挂起 11 分钟还在 / ④ waiting 11 分钟还在 / ⑤ 挂起 11 分钟后 resume 成功
    不变：② 挂起 7 小时被回收（新旧都会被回收，本来就没有区分度）
          ③ running 11 分钟被回收（这条守的就是"没被顺手改坏"，注入不影响它）
          ⑥ 淘汰上界（与 TTL 分档无关）

用法（cwd 任意）：
    python scripts/verify/p0-loop-ttl/ttl-revert-proof.py
"""
import os
import re
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
TOOL_TS = os.path.join(REPO, "apps", "server", "src", "toolLoop.ts")
PROBE = os.path.join(HERE, "ttl-probe.mjs")
SERVER_DIR = os.path.join(REPO, "apps", "server")
TSX_CLI = os.path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs")
# ★ Windows 下 node_modules/.bin/tsx 是个 shim，不能直接 CreateProcess（WinError 193）
NODE = (
    r"C:\Users\bing\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe"
    if os.path.exists(r"C:\Users\bing\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe")
    else "node"
)

OLD_LINE = "  return WAITING_STATUSES.has(s.status) ? WAITING_TTL_MS : LOOP_TTL_MS;"
NEW_LINE = "  return LOOP_TTL_MS; // ← 反证注入：退回「所有状态一律 10 分钟」的旧行为"

EXPECT_RED = {1, 4, 5}
EXPECT_GREEN = {2, 3, 6}


def run_probe():
    p = subprocess.run(
        [NODE, TSX_CLI, PROBE],
        cwd=SERVER_DIR,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    out = (p.stdout or "") + (p.stderr or "")
    red = set()
    green = set()
    for line in out.splitlines():
        m = re.match(r"(PASS|FAIL) (\d+)\.", line)
        if m:
            (green if m.group(1) == "PASS" else red).add(int(m.group(2)))
    return p.returncode, red, green, out


def main():
    src = open(TOOL_TS, "r", encoding="utf-8").read()
    if OLD_LINE not in src:
        print("FAIL 找不到注入点（源码指纹不符）—— 先确认 toolLoop.ts 是不是被别人改过")
        return 2

    backup = TOOL_TS + ".bak-revert-proof"
    shutil.copyfile(TOOL_TS, backup)
    print("已备份源码 →", os.path.basename(backup))

    try:
        # ── 注入 ──────────────────────────────────────────────────────
        open(TOOL_TS, "w", encoding="utf-8").write(src.replace(OLD_LINE, NEW_LINE, 1))
        revert = open(TOOL_TS, "r", encoding="utf-8").read()
        if NEW_LINE not in revert:
            print("FAIL 注入没落盘（写入后复查不到新行）")
            return 2
        print("已注入退回旧行为：ttlOf() 恒返回 LOOP_TTL_MS\n")

        rc, red, green, out = run_probe()
        print("── 注入后的探针输出 ──")
        for line in out.splitlines():
            if re.match(r"(PASS|FAIL|合计|失败)", line):
                print("  " + line)

        ok = True
        missing_red = sorted(EXPECT_RED - red)
        if missing_red:
            ok = False
            print(f"\n!! 应该变红却没红：{missing_red} —— 断言没打到被测路径，是摆设")
        else:
            print(f"\n✓ 预期变红的 {sorted(EXPECT_RED)} 全部变红")

        unexpected_red = sorted(red & EXPECT_GREEN)
        if unexpected_red:
            ok = False
            print(f"!! 不该红的却红了：{unexpected_red}")
        else:
            print(f"✓ 预期不受影响的 {sorted(EXPECT_GREEN)} 仍然全绿（说明注入是精确的）")
    finally:
        # ── 恢复（放在 finally：哪怕断言中途崩了也必须还原源码）──────
        shutil.copyfile(backup, TOOL_TS)
        os.remove(backup)
        restored = open(TOOL_TS, "r", encoding="utf-8").read()
        if OLD_LINE not in restored or NEW_LINE in restored:
            print("\n!! 恢复失败 —— 请手工检查 toolLoop.ts！")
            return 2
        print("\n已恢复源码（复查：注入行已不在、原始行已回）")

    # ── 恢复后必须重新全绿 ────────────────────────────────────────────
    rc2, red2, green2, out2 = run_probe()
    print("\n── 恢复后的探针输出 ──")
    for line in out2.splitlines():
        if re.match(r"(PASS|FAIL|合计|失败)", line):
            print("  " + line)
    if red2:
        print("!! 恢复后仍有红的 —— 源码没干净还原")
        return 1

    print("\n反证结论：注入坏条件 → " + f"{sorted(EXPECT_RED)} 变红；" +
          f"恢复 → 6 条全绿。断言有效。")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
