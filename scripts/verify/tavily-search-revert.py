#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
第 26 步 · 反证脚本：证明 tavily-search-check.mjs 的 D 组（隔离自检）**不是摆设**。

做法（不是"删掉检查"，而是"注入坏条件"，且保持签名/返回类型不变）：
  1. 备份 apps/server/src/search/tavily.ts（记录 sha256）
  2. 往**代码**里注入：
       - 一个引用 `webview` / `BrowserPanel` 的导出函数（模拟"顺手碰了浏览器"）
       - 一个引用 `deepseek` 的字符串（模拟"绑上了 DeepSeek 专属逻辑"）
       - 一次 `require('node:os')`（模拟"引入了模块依赖"）
  3. 重新编译 + 跑 --offline 自检 ⇒ 期望 D.1 / D.2 / D.4 / D.5 **变红**
  4. 还原文件 + 重新编译 + 再跑 ⇒ 期望 **全绿**，且 sha256 与备份一致
  5. 两份日志落盘到 .workbuddy-ai/tavily-search-test/（该目录被 .gitignore 挡住）

用法：python scripts/verify/tavily-search-revert.py
"""

import hashlib
import os
import subprocess
import sys
from datetime import datetime

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TARGET = os.path.join(ROOT, "apps", "server", "src", "search", "tavily.ts")
OUT_DIR = os.path.join(ROOT, ".workbuddy-ai", "tavily-search-test")
NODE = r"C:\Users\bing\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe"
CHECK = os.path.join(ROOT, "scripts", "verify", "tavily-search-check.mjs")

INJECT_ANCHOR = "export function isWebSearchConfigured"
INJECT_BLOCK = (
    "/** \u53cd\u8bc1\u6ce8\u5165\uff08\u4e34\u65f6\uff0c\u8dd1\u5b8c\u7acb\u5373\u8fd8\u539f\uff09 */\r\n"
    "export function __revert_probe__(): string {\r\n"
    "  const dep = require('node:os');\r\n"
    "  return String(process.env.webview ?? '') + 'BrowserPanel' + 'deepseek' + typeof dep;\r\n"
    "}\r\n"
)


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def run(cmd, log_path):
    env = dict(os.environ)
    env["PATH"] = os.path.dirname(NODE) + os.pathsep + env.get("PATH", "")
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, env=env)
    out = (p.stdout or b"").decode("utf-8", "replace") + (p.stderr or b"").decode("utf-8", "replace")
    with open(log_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(out)
    return p.returncode, out


def build():
    npm = "npm.cmd" if os.name == "nt" else "npm"
    return subprocess.run(
        [npm, "run", "build", "-w", "@ai-workbench/server"],
        cwd=ROOT, capture_output=True, shell=(os.name == "nt"),
    )


def summarize(out):
    """从日志里抽出 D 组结果与总汇总"""
    d_lines = [l for l in out.splitlines() if l.strip().startswith(("[PASS] D.", "[FAIL] D."))]
    tail = [l for l in out.splitlines() if l.startswith("===== 汇总")]
    return d_lines, (tail[-1] if tail else "(未找到汇总行)")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    ok = True

    if not os.path.exists(TARGET):
        print("找不到被测文件：", TARGET)
        return 2

    original = open(TARGET, "rb").read()
    orig_sha = hashlib.sha256(original).hexdigest()
    print("原始 sha256:", orig_sha)

    backup = os.path.join(OUT_DIR, f"tavily.ts.bak-{stamp}")
    with open(backup, "wb") as f:
        f.write(original)
    print("备份到：", backup)

    try:
        # ---------- 注入 ----------
        text = original.decode("utf-8")
        if INJECT_ANCHOR not in text:
            print("注入锚点找不到，放弃：", INJECT_ANCHOR)
            return 2
        injected = text.replace(INJECT_ANCHOR, INJECT_BLOCK + INJECT_ANCHOR, 1)
        with open(TARGET, "wb") as f:
            f.write(injected.encode("utf-8"))
        print("已注入坏条件（webview/BrowserPanel/deepseek/require）")

        b = build()
        print("注入后编译 returncode =", b.returncode)

        log_inj = os.path.join(OUT_DIR, f"revert-injected-{stamp}.log")
        rc, out = run([NODE, CHECK, "--offline"], log_inj)
        d_lines, summary = summarize(out)
        print("\n--- 注入后 D 组 ---")
        for l in d_lines:
            print("  " + l)
        print("  汇总:", summary, f"(exit={rc})")

        red = sum(1 for l in d_lines if l.startswith("[FAIL]"))
        # 期望至少 D.1 / D.2 / D.4 / D.5 变红
        if red >= 4:
            print(f"✅ 反证成立：注入后 D 组有 {red} 条变红（断言真的在检查东西）")
        else:
            print(f"❌ 反证失败：注入后 D 组只有 {red} 条变红，断言太弱")
            ok = False
    finally:
        # ---------- 还原 ----------
        with open(TARGET, "wb") as f:
            f.write(original)
        build()
        print("\n已还原源码并重新编译")

    restored_sha = sha256(TARGET)
    if restored_sha == orig_sha:
        print("✅ 还原校验通过：sha256 与备份一致")
    else:
        print(f"❌ 还原校验失败：{restored_sha} != {orig_sha}")
        ok = False

    # 还原后再跑一遍，必须全绿
    log_res = os.path.join(OUT_DIR, f"revert-restored-{stamp}.log")
    rc2, out2 = run([NODE, CHECK, "--offline"], log_res)
    d_lines2, summary2 = summarize(out2)
    print("\n--- 还原后 D 组 ---")
    for l in d_lines2:
        print("  " + l)
    print("  汇总:", summary2, f"(exit={rc2})")

    if rc2 == 0 and "0 FAIL" in summary2:
        print("✅ 还原后全绿")
    else:
        print("❌ 还原后没有全绿")
        ok = False

    # 关键 token 复查（防止"报成功但文件没变"）
    now = open(TARGET, "r", encoding="utf-8").read()
    if "__revert_probe__" in now:
        print("❌ 注入残留未清除！")
        ok = False
    else:
        print("✅ 源码里已无注入残留（__revert_probe__）")

    print("\n日志：")
    print("  注入后:", log_inj)
    print("  还原后:", log_res)
    print("\n反证结论：", "通过（测试有效）" if ok else "不通过")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
