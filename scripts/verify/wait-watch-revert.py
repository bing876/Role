#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ADR-0003 · 浏览器深度 第一片 —— wait-for / watch 反证(拆掉必红)。

对 `apps/desktop/electron/wait-watch.ts` 做 5 处**定点变异**,每处都让 `wait-watch-smoke.mts`
变红(退出码非 0),然后还原并核对 sha256 逐字一致。证明验收断言**真的**咬住了生产 core,
不是自我圆谎的绿。

变异逐条对应 ADR 失败模式表:
  R1 (F1) 谓词恒 found=true        → 假阳性防线被拆
  R2 (F2) 删 deadline 判断          → 超时不触发,死循环
  R3 (F5) 跳过 Runtime.addBinding   → watch 从不触发
  R4 (F6) 重复订阅 message 监听      → 同一插入双发
  R5 (F7) 让 stop() 失效            → stop 后泄漏

用法:python3 scripts/verify/wait-watch-revert.py
"""
import hashlib
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(REPO, "apps", "desktop", "electron", "wait-watch.ts")
SMOKE = os.path.join(REPO, "scripts", "verify", "wait-watch-smoke.mts")

# ★ Windows 修（2026-09-26）：CreateProcess 只按 `.exe` 补后缀，**不解析 `.cmd`**，
# 而 PATH 上只有 npx.cmd ⇒ `["npx", ...]` 必 FileNotFoundError: [WinError 2]。
# 改成「当前 node + 本地 tsx CLI」，跨平台且不依赖 npx / PATH。
import shutil as _shutil

NODE = _shutil.which("node") or "node"
TSX_CLI = os.path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs")


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def run_smoke():
    r = subprocess.run(
        [NODE, TSX_CLI, SMOKE],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=120,
    )
    return r.returncode, r.stdout + r.stderr


def fail_lines(out):
    return [ln.strip() for ln in out.splitlines() if ln.strip().startswith("FAIL")]


# (id, 说明, 旧串(必须恰好 1 处), 新串, 期望命中的场景前缀)
REVERTS = [
    (
        "R1",
        "F1 谓词恒 found=true(拆掉假阳性防线)",
        "return { found: false };",
        "return { found: true, how: 'selector' };",
        ("S3", "S9"),
    ),
    (
        "R2",
        "F2 删 deadline 判断(超时不触发 → 死循环,看门狗抓)",
        "if (now() >= deadline) {",
        "if (false && now() >= deadline) {",
        ("S3",),
    ),
    (
        "R3",
        "F5 跳过 Runtime.addBinding(watch 从不触发)",
        "await send('Runtime.addBinding', { name: WATCH_BIND_NAME });",
        "// ADR-REVERT: await send('Runtime.addBinding', { name: WATCH_BIND_NAME });",
        ("S5",),
    ),
    (
        "R4",
        "F6 重复订阅 message 监听(同一插入双发)",
        "events.on('message', listener);",
        "events.on('message', listener); events.on('message', listener);",
        ("S5",),
    ),
    (
        "R5",
        "F7 让 stop() 失效(stop 后仍收事件 → 泄漏)",
        "const stop = (): void => {\n    if (stopped) return;",
        "const stop = (): void => {\n    return; // ADR-REVERT: stop 被禁用\n    if (stopped) return;",
        ("S6",),
    ),
]


def main():
    original = open(TARGET, "r", encoding="utf8").read()
    original_sha = sha256(TARGET)
    print("=" * 70)
    print("ADR-0003 · wait-for / watch 反证:拆掉必红")
    print("=" * 70)

    # 先确认基线是绿的(不然反证没有意义)
    code0, out0 = run_smoke()
    if code0 != 0:
        print("!! 基线不是绿的(退出码 %d),反证无意义。先看这个:" % code0)
        print(out0[-2000:])
        sys.exit(2)
    print("基线:wait-watch-smoke 全绿(退出码 0)✔\n")

    all_ok = True
    for rid, desc, old, new, expect_scenes in REVERTS:
        print("--- %s:%s" % (rid, desc))
        cnt = original.count(old)
        if cnt != 1:
            print("  !! 锚点不唯一(出现 %d 次),反证无法定点。跳过。" % cnt)
            all_ok = False
            continue
        open(TARGET, "w", encoding="utf8").write(original.replace(old, new, 1))
        try:
            code, out = run_smoke()
        except subprocess.TimeoutExpired:
            code, out = -1, "(smoke 超时 —— 本身也说明拆掉了超时保护)"
        red = code != 0
        fl = fail_lines(out)
        hit = any(any(ln.startswith(s + " ") or ln.startswith("  FAIL  " + s) or (s in ln) for s in expect_scenes) for ln in fl)
        print("  注入后:退出码=%d  变红=%s" % (code, red))
        for ln in fl[:6]:
            print("    " + ln)
        ok = red and hit
        print("  期望命中场景 %s:命中=%s" % (list(expect_scenes), hit))
        print("  [PASS] 探针变红且命中预期场景 —— 断言有效" if ok else "  [FAIL] 未如预期变红/未命中")
        all_ok = all_ok and ok

        # 还原
        open(TARGET, "w", encoding="utf8").write(original)
        if sha256(TARGET) != original_sha:
            print("  !! 还原后 sha 不一致,文件被污染!")
            all_ok = False
        else:
            print("  已还原(sha256 %s…)一致 ✔" % original_sha[:12])
        print()

    # 最终再跑一遍,确认还原后仍是绿的
    codef, outf = run_smoke()
    print("=== 最终复核(还原后)===  退出码=%d" % codef)
    if codef != 0:
        print(outf[-2000:])
        all_ok = False
    else:
        print("还原后 wait-watch-smoke 仍全绿 ✔")

    print("\n" + "=" * 70)
    print("反证结论:%s" % ("全部 %d 处拆掉都红 ✔" % len(REVERTS) if all_ok else "存在未变红的探针 ✗"))
    print("=" * 70)
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
