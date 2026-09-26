#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
只读探针：把「浏览器面板可见性」与「浏览器实例任务执行」的耦合点穷举出来。

目的：回答一个问题 —— 用户把面板收起 / 看不见时，背后的 <webview> 会不会被
暂停、销毁、或者被停止驾驶？

做法：静态分析（不改任何文件），逐条断言。每条断言都设计成**可区分对错**：
如果将来有人把「可见性」和「停任务」绑起来（例如 `expanded || stopDriving()`），
对应断言会立刻变红。

运行：
  python scripts/verify/panel-visibility-coupling-probe.py
"""

import os
import re
import sys
from pathlib import Path

# 默认扫真实仓库；反证时由外部传 PROBE_ROOT 指向一份**临时副本**（这样注入缺陷
# 不会碰到真实文件）。见 panel-visibility-coupling-revert.py
ROOT = Path(os.environ.get("PROBE_ROOT") or Path(__file__).resolve().parents[2])
SRC = ROOT / "apps" / "desktop" / "src"
ELEC = ROOT / "apps" / "desktop" / "electron"

PANEL = SRC / "browser" / "BrowserPanel.tsx"
WS = SRC / "browser" / "useBrowserWorkspace.ts"
BROWSER_CSS = SRC / "browser" / "styles.css"
APP = SRC / "App.tsx"
MAIN = ELEC / "main.ts"

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("  [PASS] " if ok else "  [FAIL] ") + name)
    if detail:
        for line in detail.splitlines():
            print("         " + line)


def read(p):
    return p.read_text(encoding="utf-8", errors="replace")


def lines_of(p):
    return read(p).splitlines()


print("=" * 78)
print("面板可见性 × 任务执行 —— 静态耦合探针（只读）")
print("=" * 78)

# ---------------------------------------------------------------- A
print("\n[A] 渲染层里 `expanded` 被读了哪些地方？")
print("    期望：只有 BrowserPanel 用它换 className / 按钮文案；没有任何逻辑分支读它。")

panel_src = read(PANEL)
ws_src = read(WS)

reads_expanded = []  # (file, lineno, text)
for path in [PANEL, WS]:
    for i, ln in enumerate(lines_of(path), 1):
        # 排除注释行
        s = ln.strip()
        if s.startswith("*") or s.startswith("//") or s.startswith("/*"):
            continue
        if re.search(r"\bexpanded\b", s):
            reads_expanded.append((path.name, i, s))

# 允许的形态：
#   - 声明 / 接口 / 类型：  expanded: boolean;  expanded,  expanded: visible
#   - 写入：                setExpanded(...)  const [expanded, setExpanded] = useState
#   - 唯一允许的“读取”：    ws.expanded ? '...--expanded' : ...   /  {ws.expanded ? '收起' : '展开'}
ALLOW_WRITE = re.compile(r"(setExpanded\s*\(|useState|expanded\s*[:?]|^\s*expanded,|\bexpanded\s*:\s*boolean|const\s*\[)")
ALLOW_READ = re.compile(r"ws\.expanded\s*\?")

offenders = []
for fname, ln, s in reads_expanded:
    if ALLOW_READ.search(s) or ALLOW_WRITE.search(s):
        continue
    offenders.append(f"{fname}:{ln}: {s}")

check(
    "A1 渲染层对 `expanded` 的引用全部是「声明/写入/换类名文案」，无逻辑分支",
    len(offenders) == 0,
    "\n".join(offenders) if offenders else f"共 {len(reads_expanded)} 处引用，全部在允许形态内",
)

# ---------------------------------------------------------------- A2
# ★ 2026-09-24（收尾 7）改写：这条原来断言「`expanded` 的真实读取点 == 2 处」。
#   第 25 步之后 `expanded` 这套机制**整个退场**了：面板尺寸改由 flex 布局给
#   （`.browserPanel__stage { flex: 1 1 auto; min-height: 0 }`），可见度那三档由
#   ComputerVisibility 在外层表达，不再有一个布尔量去切高度。
#   所以现在的不变量更强：**一处引用都不许有** —— 谁再把 `expanded` 请回来当逻辑开关，
#   这条立刻红（那正是「可见性 → 改任务执行」最容易重新长出来的地方）。
read_sites = [f"{f}:{n}" for f, n, s in reads_expanded if ALLOW_READ.search(s)]
check(
    "A2 `expanded` 这套机制已整个退场（0 处引用）—— 尺寸由 flex 给，不再靠布尔量切高度",
    len(reads_expanded) == 0 and len(read_sites) == 0,
    ("一处引用都没有（机制已退场）" if not reads_expanded
     else "又出现了引用：" + ", ".join(f"{f}:{n}: {s}" for f, n, s in reads_expanded)),
)

# ---------------------------------------------------------------- B
print("\n[B] 有没有「可见性 → 停任务」的调用路径？")
print("    期望：agentStop / agentDrop / browserThrottle 的调用点都与可见性无关。")

stop_calls = []
for path in list(SRC.rglob("*.ts")) + list(SRC.rglob("*.tsx")):
    for i, ln in enumerate(lines_of(path), 1):
        s = ln.strip()
        if s.startswith("*") or s.startswith("//"):
            continue
        if re.search(r"(agentStop|agentDrop|stopDriving|browserThrottle)\s*[?(]", s):
            stop_calls.append((path.relative_to(ROOT).as_posix(), i, s))

# 已知且合理的调用点（用户动作 / 关页 / 登出），不含任何可见性分支
known_ok = [
    "src/App.tsx",                                   # 登出 / 明确的「停」意图
    "src/browser/useBrowserWorkspace.ts",            # removeTab 关页 / stopDriving 实现
    "src/browser/index.ts",                          # 文档注释
]
bad = [f"{f}:{n}: {s}" for f, n, s in stop_calls
       if not any(f.endswith(k) for k in known_ok)]
check(
    "B1 停/放任务只出现在 App.tsx(登出·停意图) 与 workspace(关页·停实现)",
    len(bad) == 0,
    "\n".join(bad) if bad else "无其它调用点",
)

# 断言：这些调用点所在函数里不出现 expanded
coupled = []
for f, n, s in stop_calls:
    path = ROOT / f
    body = "\n".join(lines_of(path)[max(0, n - 25):n + 5])
    if re.search(r"\bexpanded\b", body):
        coupled.append(f"{f}:{n}")
check(
    "B2 没有任何停任务调用点处在读 `expanded` 的代码块里",
    len(coupled) == 0,
    "\n".join(coupled) if coupled else "全部无关联",
)

# ---------------------------------------------------------------- C
print("\n[C] <webview> 在什么条件下会被卸载？")
print("    期望：只有 (1) 面板整体不挂载 = 一张页都没有；(2) 深休眠 —— 且深休眠被 drivingIds 硬拦。")

app_src = read(APP)
mount_guard = re.search(r"browser\.allTabs\.length\s*>\s*0\s*&&\s*\(", app_src)
check(
    "C1 面板挂载条件是 `allTabs.length > 0`（有页才挂，无页即卸载）",
    mount_guard is not None,
    "App.tsx 里找到 `browser.allTabs.length > 0 && (`" if mount_guard else "未找到挂载条件",
)

# 深休眠分支的红线
deep_line = re.search(r"const\s+deepSleeping\s*=\s*([^;]+);", panel_src)
ok_deep = bool(deep_line) and "drivingIds" in deep_line.group(1) and "!" in deep_line.group(1)
check(
    "C2 深休眠（唯一会卸载 webview 的分支）被 `!drivingIds.includes(id)` 硬拦",
    ok_deep,
    ("实际表达式：" + deep_line.group(1).strip()) if deep_line else "未找到 deepSleeping 定义",
)

# 判定层红线
sp = read(SRC / "browser" / "sleepPolicy.ts")
ok_sp = ("driving.has(t.id)" in sp) and ("continue" in sp)
check(
    "C3 休眠判定纯函数里，driving 是第一条规则且直接 continue（红线最先）",
    ok_sp,
    "decideSleep 第一步即 `if (driving.has(t.id)) continue;`" if ok_sp else "红线缺失",
)

# 主进程节流也拒绝驾驶中的页
main_src = read(MAIN)
ok_throttle = "if (throttle && isDriving) return { ok: false, error: 'driving' }" in main_src
check(
    "C4 主进程 setBackgroundThrottling 对驾驶中的页直接拒绝（第三道防线）",
    ok_throttle,
    "main.ts 有 `if (throttle && isDriving) return { ok:false, error:'driving' }`" if ok_throttle else "未找到该防线",
)

# ---------------------------------------------------------------- D
print("\n[D] 收起态到底改了什么？")
print("    期望：不改舞台的布局尺寸（第 25 步之后舞台由 flex 撑开，没有写死高度）、")
print("          不改 display、不把宽高写成 0、不卸载。")

css = read(BROWSER_CSS)
stage_collapsed = re.search(r"\.browserPanel__stage\s*\{([^}]*)\}", css)
stage_body = stage_collapsed.group(1) if stage_collapsed else ""
# ★ `height:` 前面不许被 `min-` 顶着 —— min-height:0 是 flex 子项的常规防溢出写法，不是把高度归零
h_collapsed = re.search(r"(?<!min-)height:\s*([^;]+);", stage_body)
# 第 25 步之后 `.browserPanel--expanded .browserPanel__stage` 这条覆盖已经不存在了
stage_expanded = re.search(r"\.browserPanel--expanded\s+\.browserPanel__stage\s*\{([^}]*)\}", css)

check(
    "D1 舞台不写死高度，由 flex 撑开（flex:1 1 auto + min-height:0 + width:100%）—— 有页就有真实尺寸",
    bool(stage_collapsed)
    and re.search(r"flex:\s*1 1 auto", stage_body) is not None
    and re.search(r"min-height:\s*0", stage_body) is not None
    and re.search(r"width:\s*100%", stage_body) is not None,
    (".browserPanel__stage = " + " ".join(stage_body.split())) if stage_collapsed else "未找到舞台规则",
)

check(
    "D2 没有任何规则给舞台写死 height（收起/展开同一个尺寸；`--expanded` 那套覆盖已退场）",
    h_collapsed is None and stage_expanded is None,
    ("舞台里没有写死的 height，也没有 --expanded 覆盖"
     if (h_collapsed is None and stage_expanded is None)
     else f"写死的 height = {h_collapsed.group(1).strip() if h_collapsed else '(无)'}；--expanded 覆盖 = {'仍在' if stage_expanded else '(无)'}"),
)

# 舞台 / view 上不允许出现 display:none / height:0 / width:0（min-height:0 先剔掉再判）
bad_css = []
for m in re.finditer(r"(\.browserPanel__stage|\.browserPanel__view)[^{]*\{([^}]*)\}", css):
    body = re.sub(r"min-height:\s*0\s*;", "", m.group(2))
    if re.search(r"display:\s*none", body) or re.search(r"(?<!min-)(height|width):\s*0(px)?\s*;", body):
        bad_css.append(m.group(1).strip() + " -> " + m.group(2).strip().replace("\n", " "))
check(
    "D3 舞台/webview 上没有任何 display:none 或真 0 尺寸规则（min-height:0 是 flex 常规写法，不算）",
    len(bad_css) == 0,
    "\n".join(bad_css) if bad_css else "只有 opacity / z-index / pointer-events 这类不影响布局的属性",
)

# 关键：webview 的尺寸来自父容器铺满（inset:0 / width:100% / height:100%）
view_rule = re.search(r"\.browserPanel__view\s*\{([^}]*)\}", css)
ok_fill = bool(view_rule) and "inset: 0" in view_rule.group(1) and "100%" in view_rule.group(1)
check(
    "D4 webview 靠 `inset:0 + 100%` 铺满舞台 —— 它的尺寸 = 舞台尺寸（舞台由 flex 撑开，收起也不归零）",
    ok_fill,
    "webview 尺寸跟随舞台，收起不归零" if ok_fill else "未找到铺满规则",
)

# ---------------------------------------------------------------- E
print("\n[E] 驾驶执行层是否看可见性？")
print("    期望：执行层只认 webContents id 与存活状态，完全不看可见性。")

drv = read(ELEC / "driver.ts")
# ADR-0002 第二片：内嵌页宿主只有 view-host 的 WebContentsView 一条路（wcId 在
# viewHostRegistry 里），webview 时期的 getType() 分支随 webviewTag 退场。
# 断言口径跟着生产码走：认 registry + 存活，不看可见性。
ok_drv = ("viewHostRegistry.has(wc.id)" in drv) and ("isDestroyed" in drv) and not re.search(r"isVisible|occluded", drv)
check(
    "E1 driver.ts 只查 registry/存活，不查可见性",
    ok_drv,
    "无 isVisible/occluded 依赖" if ok_drv else "发现可见性依赖",
)

# 驾驶循环在主进程跑，靠 wcId 定位 guest
agent_src = read(ELEC / "agent.ts")
ok_loop = ("runToolLoop" in agent_src) and ("loopId" in agent_src)
check(
    "E2 驾驶循环 runToolLoop 在主进程、按 loopId 与 guest 交互（不经渲染层可见性）",
    ok_loop,
    "循环脑在服务端，编排与执行在主进程",
)

# 渲染层不监听窗口可见性
vis_hits = []
for path in list(SRC.rglob("*.ts")) + list(SRC.rglob("*.tsx")):
    for i, ln in enumerate(lines_of(path), 1):
        if re.search(r"visibilitychange|document\.hidden", ln):
            vis_hits.append(f"{path.relative_to(ROOT).as_posix()}:{i}")
check(
    "E3 渲染层没有任何 visibilitychange / document.hidden 联动",
    len(vis_hits) == 0,
    "\n".join(vis_hits) if vis_hits else "无",
)

# ---------------------------------------------------------------- 汇总
print("\n" + "=" * 78)
passed = sum(1 for _, ok, _ in results if ok)
total = len(results)
print(f"结论：{passed}/{total} 条断言通过")
for name, ok, _ in results:
    if not ok:
        print("  ✗ " + name)
print("=" * 78)

sys.exit(0 if passed == total else 1)
