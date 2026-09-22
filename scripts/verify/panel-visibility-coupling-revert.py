#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
反证：证明 panel-visibility-coupling-probe.py 不是摆设。

做法：把相关源文件复制到**临时副本**（绝不改真实文件），逐个注入"把可见性和
任务执行绑起来"的缺陷，再对副本跑探针 —— 期望对应断言**变红**。
若注入后探针仍全绿，说明该断言测不出回归，是摆设。

运行：
  python scripts/verify/panel-visibility-coupling-revert.py
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REAL_ROOT = HERE.parents[1]
PROBE = HERE / "panel-visibility-coupling-probe.py"

FILES = [
    "apps/desktop/src/App.tsx",
    "apps/desktop/src/browser/BrowserPanel.tsx",
    "apps/desktop/src/browser/useBrowserWorkspace.ts",
    "apps/desktop/src/browser/styles.css",
    "apps/desktop/src/browser/sleepPolicy.ts",
    "apps/desktop/electron/main.ts",
    "apps/desktop/electron/driver.ts",
    "apps/desktop/electron/agent.ts",
]

# 每个缺陷：(名字, 相对文件, 旧片段, 新片段, 期望变红的断言前缀)
DEFECTS = [
    (
        "① 收起态把舞台高度压成 0（尺寸归零 → 驾驶点不中）",
        "apps/desktop/src/browser/styles.css",
        "  /* 收起也留一块看得见的页面（不是 2px） */\n  height: 180px;",
        "  height: 0px;",
        "D1",
    ),
    (
        "② 可见性直接触发停任务（App.tsx 里按 expanded 停）",
        "apps/desktop/src/App.tsx",
        "  const browser = useBrowserWorkspace({",
        "  void (browser as any);\n"
        "  // [注入缺陷] 面板一收起就停掉驾驶 —— 正是那种不该有的耦合\n"
        "  useEffect(() => { if (!browser.expanded) void window.workbench?.agentStop(); }, [browser.expanded]);\n"
        "  const browser = useBrowserWorkspace({",
        "B2",
    ),
    (
        "③ 深休眠丢掉 drivingIds 红线（驾驶中的页被卸载）",
        "apps/desktop/src/browser/BrowserPanel.tsx",
        "const deepSleeping = t.sleep === 'deep' && !ws.drivingIds.includes(t.id);",
        "const deepSleeping = t.sleep === 'deep';",
        "C2",
    ),
    (
        "④ 驾驶执行层开始看可见性（driver 里判 isVisible）",
        "apps/desktop/electron/driver.ts",
        "  if (wc && !wc.isDestroyed() && wc.getType() === 'webview') return wc;",
        "  if (wc && !wc.isDestroyed() && wc.getType() === 'webview' && wc.isVisible()) return wc;",
        "E1",
    ),
]


def build_copy(dest: Path):
    for rel in FILES:
        src = REAL_ROOT / rel
        dst = dest / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)


def run_probe(root: Path):
    env = dict(os.environ, PROBE_ROOT=str(root))
    p = subprocess.run(
        [sys.executable, str(PROBE), ],
        capture_output=True, text=True, encoding="utf-8", errors="replace", env=env,
    )
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def failed_checks(out: str):
    return re.findall(r"\[FAIL\]\s+(\S+)", out)


def main():
    print("=" * 78)
    print("反证：注入缺陷 → 探针必须变红（全程在临时副本上，不动真实文件）")
    print("=" * 78)

    # 先确认副本干净时是绿的（基线）
    with tempfile.TemporaryDirectory(prefix="panelprobe-") as td:
        base = Path(td)
        build_copy(base)
        rc, out = run_probe(base)
        print(f"\n[基线] 未注入任何缺陷 → 探针退出码 {rc}，失败断言 {failed_checks(out) or '无'}")
        if rc != 0:
            print("  ✗ 基线不是全绿，反证无意义 —— 先修探针本身")
            print(out)
            return 2

    all_ok = True
    for name, rel, old, new, expect in DEFECTS:
        with tempfile.TemporaryDirectory(prefix="panelprobe-") as td:
            root = Path(td)
            build_copy(root)
            target = root / rel
            text = target.read_text(encoding="utf-8")
            if old not in text:
                print(f"\n[反证] {name}\n  ✗ 注入锚点未命中（{rel}），该缺陷无法注入")
                all_ok = False
                continue
            target.write_text(text.replace(old, new, 1), encoding="utf-8")
            rc, out = run_probe(root)
            fails = failed_checks(out)
            hit = [f for f in fails if f.startswith(expect)]
            ok = (rc != 0) and bool(hit)
            print(f"\n[反证] {name}")
            print(f"  注入文件：{rel}")
            print(f"  期望变红：{expect}*   实际变红：{fails or '无（仍全绿）'}")
            print("  " + ("[PASS] 探针成功变红 —— 该断言有效" if ok else "[FAIL] 探针没变红 —— 断言是摆设"))
            all_ok = all_ok and ok

    print("\n" + "=" * 78)
    print("反证结论：" + ("全部缺陷都被探针抓到 —— 断言有效" if all_ok else "存在抓不到的缺陷 —— 需补强断言"))
    print("=" * 78)
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
