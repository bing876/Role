#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
收尾 7 · H | 电脑三级可见度 —— 变异反证（把生产代码改回「空转」的样子，`verify:visibility` 必须红）
==============================================================================================

    python3 scripts/verify/computer-visibility-revert-proof.py
    python3 scripts/verify/computer-visibility-revert-proof.py --only=HV1,HV4

★ 为什么 H 的反证特别重要：H 当年是**交付时全绿、实际一行没生效**的批次。
  旧验收只做 `readFileSync + includes`，所以下面这九处坏法**它一处都咬不住**（照样全绿）。
  这份反证跑的是重写后的 `npm run -s verify:visibility`（真调桌面本体那三个纯函数 + 接线断言 + CSS 不变量）。

  HV1 App.tsx 里干脆不渲染这个组件      → 组件存在但没人用（H 空转的主症状），⑤-2 必须红
  HV2 fetch 地址加回 `/api` 前缀         → 服务端没有 /api → 404，①-1/①-2 必须红
  HV3 token 改回自己摸 localStorage      → key 摸错等于没带 → 401，②-3/④-1 必须红
  HV4 读不到档位时回落 'status'          → 把「读不到」变成「用户选了收起」，偏好被抹掉，⑤-6 必须红
  HV5 收起档提前 return（丢掉 children） → 用户一收起，正在跑的那张页当场被卸载，④-2 必须红
  HV6 宿主 display:none                  → webview 尺寸归零，驾驶点击坐标静默失效，⑥-1 必须红
  HV7 切档顺手把任务停了                 → 「只改看得见多少」的边界被破，⑤-5 必须红
  HV8 把 BrowserPanel 塞进它的 children  → 切档时 webview 换父节点被 React 重建，⑤-4 必须红
  HV9 默认档位改成 takeover              → 一登录就全屏抢焦点（批次 H 的设计前提被推翻），④-4 必须红

★ 纪律：注入期间**只改产品代码，绝不动断言**（改断言让绿的就不是反证，是自欺）。
★ 每处注入跑完立刻还原，并复核 md5 + git status 与注入前逐字节一致。
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # scripts/verify/ → 仓库根

FILES = {
    "component": "apps/desktop/src/browser/ComputerVisibility.tsx",
    "app": "apps/desktop/src/App.tsx",
    "css": "apps/desktop/src/browser/styles.css",
}

RUN = "npm run -s verify:visibility"


def md5(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


def read(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def write(path: str, text: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def sh(cmd: str, timeout: int = 900) -> tuple[int, str]:
    """跑一条命令，回 (exit code, 输出末尾若干行)。exit!=0 就是「红了」。"""
    p = subprocess.run(cmd, shell=True, cwd=REPO, capture_output=True, text=True, timeout=timeout)
    out = (p.stdout or "") + (p.stderr or "")
    tail = "\n".join([ln for ln in out.splitlines() if ln.strip()][-16:])
    return p.returncode, tail


# App.tsx 里那个 JSX 元素（逐字，HV1 要整块摘掉）
JSX_BLOCK = """            <ComputerVisibility
              agentId={curAgentId}
              loopStatus={visAgent?.status ?? (runningLoopId ? 'running' : 'idle')}
              statusDetail={visAgent?.statusDetail ?? null}
              step={visAgent?.statusStep ?? null}
              currentTool={visLastStep}
              pageSummary={visPage}
              visibility={computerVisibility}
              onChange={onChangeComputerVisibility}
              apiBase={API_BASE()}
              token={session?.token ?? null}
            />
"""

MUTATIONS = [
    {
        "id": "HV1",
        "file": "app",
        "why": "App.tsx 里不渲染这个组件 —— 组件存在但没人用（批次 H 空转的主症状）",
        "edits": [(JSX_BLOCK, "            {/* 【反证注入 HV1】组件不渲染 */}\n")],
    },
    {
        "id": "HV2",
        "file": "component",
        "why": "fetch 地址加回 `/api` 前缀 —— 服务端注册的是 /agents/:id/visibility，打过去就是 404",
        "edits": [
            (
                "  return `${base}/agents/${agentId}/visibility`;",
                "  return `${base}/api/agents/${agentId}/visibility`;  // 【反证注入 HV2】",
            ),
        ],
    },
    {
        "id": "HV3",
        "file": "component",
        "why": "token 改回组件自己摸 localStorage —— 桌面真实 key 是 workbench.token，摸 'token' 等于没带 → 401",
        "edits": [
            (
                "      method: 'GET',\n      headers: authHeaders(input.token),",
                "      method: 'GET',\n      headers: authHeaders(localStorage.getItem('token')),  // 【反证注入 HV3】",
            ),
        ],
    },
    {
        "id": "HV4",
        "file": "app",
        "why": "读不到档位时回落 'status' —— 把「读不到」当成「用户选了收起」，服务端存的偏好被界面抹掉",
        "edits": [
            (
                "      if (off || !v) return;",
                "      if (off) return;\n      setComputerVisibility(v ?? 'status');  // 【反证注入 HV4】读不到就猜一个",
            ),
        ],
    },
    {
        "id": "HV5",
        "file": "component",
        "why": "收起档提前 return —— children 不渲染，用户一收起，正在跑的那张页当场被卸载",
        "edits": [
            (
                "  return (\n    <div className={`computerVisibility computerVisibility--${visibility}`}",
                "  if (visibility === 'status') {\n"
                "    // 【反证注入 HV5】收起档只画那一条，children 丢掉\n"
                "    return <div className=\"computerVisibility computerVisibility--status\" />;\n"
                "  }\n"
                "  return (\n    <div className={`computerVisibility computerVisibility--${visibility}`}",
            ),
        ],
    },
    {
        "id": "HV6",
        "file": "css",
        "why": "宿主 display:none —— webview 尺寸归零，驾驶算出来的点击坐标全部静默失效",
        "edits": [
            (
                ".computerVisibility__host {\n  position: relative;",
                ".computerVisibility__host {\n  display: none;  /* 【反证注入 HV6】 */\n  position: relative;",
            ),
        ],
    },
    {
        "id": "HV7",
        "file": "app",
        "why": "切档顺手把任务停了 —— 破掉「可见度只改看得见多少，绝不改跑不跑」这条边界",
        "edits": [
            (
                "    if (v !== 'status') browser.showFullscreen();",
                "    if (v !== 'status') browser.showFullscreen();\n"
                "    if (v === 'status') void fetch('/agent/loop/stop', { method: 'POST' });  // 【反证注入 HV7】",
            ),
        ],
    },
    {
        "id": "HV8",
        "file": "app",
        "why": "把 BrowserPanel 塞进它的 children —— 切档时 webview 换父节点，被 React 卸载重建",
        "edits": [
            (
                "              token={session?.token ?? null}\n            />\n            <BrowserPanel",
                "              token={session?.token ?? null}\n            >\n              <BrowserPanel  // 【反证注入 HV8】",
            ),
        ],
    },
    {
        "id": "HV9",
        "file": "component",
        "why": "默认档位改成 takeover —— 一登录就全屏抢焦点（批次 H「默认收起」的设计前提被推翻）",
        "edits": [
            (
                "useState<ComputerVisibility>(propVisibility ?? 'status')",
                "useState<ComputerVisibility>(propVisibility ?? 'takeover')  /* 【反证注入 HV9】 */",
            ),
        ],
    },
]


def main() -> int:
    only = None
    for a in sys.argv[1:]:
        if a.startswith("--only="):
            only = {x.strip() for x in a[len("--only="):].split(",") if x.strip()}

    print("=== 收尾 7 · H 电脑可见度：变异反证 ===")
    print(f"    仓库 {REPO}")
    print(f"    每处注入后跑 {RUN}，要求 exit != 0（红）")
    before = {k: md5(os.path.join(REPO, v)) for k, v in FILES.items()}
    for k, v in before.items():
        print(f"    注入前 md5 {k:10s} {v}  ({FILES[k]})")
    # ★ 树「干净」的标准不是 git status 空 —— 本批次的改动本来就还没提交。
    #   正确的不变量是：**注入前后 git status 逐字节相同**（该改的还在、不该多的一个都没多）。
    _, git_before = sh("git status --porcelain -- " + " ".join(FILES.values()))
    print("    注入前 git status：\n" + "\n".join("      " + x for x in git_before.splitlines()))

    rows: list[tuple[str, str, str]] = []
    try:
        for m in MUTATIONS:
            if only and m["id"] not in only:
                continue
            path = os.path.join(REPO, FILES[m["file"]])
            src = read(path)
            bad = [(o, src.count(o)) for o, _ in m["edits"] if src.count(o) != 1]
            if bad:
                rows.append((m["id"], "SKIP", "锚点不唯一：" + "; ".join(f"出现 {c} 次" for _, c in bad)))
                print(f"\n[SKIP] {m['id']} 锚点不唯一，跳过（不许糊里糊涂地注入）")
                continue
            print(f"\n----- {m['id']} 注入：{m['why']} -----")
            print(f"      文件 {os.path.relpath(path, REPO)}（{len(m['edits'])} 处替换）")
            t0 = time.time()
            mutated = src
            for o, n in m["edits"]:
                mutated = mutated.replace(o, n, 1)
            write(path, mutated)
            try:
                rc, tail = sh(RUN)
                ok = rc != 0
                rows.append((m["id"], "RED" if ok else "★GREEN(不该)", f"exit={rc}\n{tail}"))
                print(f"      → exit={rc} {'（红了，符合预期）' if ok else '（★居然还是绿的：断言没咬住这处改动！）'}")
                red = [x for x in tail.splitlines() if "FAIL" in x] or tail.splitlines()[-6:]
                print("      红在这些断言上：\n" + "\n".join("        " + x.strip()[:200] for x in red[:8]))
            finally:
                write(path, src)
            print(f"      已还原（{time.time() - t0:.1f}s）；md5 复核 = {md5(path)}")
    finally:
        print("\n=== 还原核对 ===")
        dirty = []
        for k, v in FILES.items():
            p = os.path.join(REPO, v)
            now = md5(p)
            same = now == before[k]
            print(f"    {k:10s} {now}  {'一致' if same else '★不一致'}")
            if not same:
                dirty.append(v)
        _, out = sh("git status --porcelain -- " + " ".join(FILES.values()))
        clean = out == git_before
        print(f"    git status 与注入前：{'逐字节一致' if clean else '★不一致'}\n{out}")
        rows.append(("RESTORE", "OK" if (not dirty and clean) else "★FAIL", "md5 与 git status 都回到注入前" if (not dirty and clean) else "还原不干净"))

    print("\n=== 反证小结 ===")
    bad = 0
    for mid, verdict, detail in rows:
        good = verdict.startswith("RED") or verdict == "OK"
        flag = "OK " if good else ("SKIP" if verdict == "SKIP" else "★BAD")
        if flag == "★BAD":
            bad += 1
        first = detail.splitlines()[0] if detail else ""
        print(f"    [{flag}] {mid:8s} {verdict:14s} {first}")
    print(f"\n    注入 {len([r for r in rows if r[0] != 'RESTORE'])} 处；不该绿而绿 / 还原不干净：{bad}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
