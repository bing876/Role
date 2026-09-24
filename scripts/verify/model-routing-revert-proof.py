#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
收尾 7 · I | 模型路由「真路由」—— 变异反证（把生产代码改回「空转」的样子，`verify:routing` 必须红）
================================================================================================

    python3 scripts/verify/model-routing-revert-proof.py
    python3 scripts/verify/model-routing-revert-proof.py --only=RV1,RV2

用户 2026-09-24 拍板：**真路由** —— 简单闲聊与复杂闲聊必须选出**不同的模型**
（`DEEPSEEK_MODEL_CHAT` vs `DEEPSEEK_MODEL_CHAT_COMPLEX`）；没配复杂模型就回落到 CHAT，
但 reason 必须**如实说回落**（不许写着「路由到推理模型」却一次都没换）。

批次 I 当年的空转形状就是：两个分支的 `model` 都写 `chatModel`，只有 reason 不一样 ——
日志看着像路由了，实际一个字节都没换过模型。下面六处正是这件事最容易坏回去的六种坏法：

  RV1 复杂档的 model 改回 chatModel      → 真路由退回空转，「两路模型必须不同」那条断言必须红
  RV2 回落分支的 reason 谎称路由了        → 未配 COMPLEX 时报「路由到推理模型」，如实回落那条必须红
  RV3 kill-switch 失效（enabled 恒 true）→ MODEL_ROUTING_ENABLED=0 不再全走默认模型，⑧ 必须红
  RV4 isSimple 恒 false                  → 问候/短句也走复杂档，简单闲聊那条必须红
  RV5 isComplex 恒 false                 → 带「分析/对比/报告」的长句落回通用闲聊分支，复杂闲聊那条必须红
  RV6 tag→taskKind 把 chat 认成 tool     → llm.ts 那层推断错了，⑨ 的映射断言必须红

★ 纪律：注入期间**只改产品代码，绝不动断言**（改断言让绿的就不是反证，是自欺）。
★ RV1 与 RV2 是一对：RV1 钉住「真的换了模型」，RV2 钉住「没换的时候不许装作换了」。
  只钉 RV1 的话，将来有人把回落分支的 reason 写成「路由到推理模型」，日志就会重新骗人。
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # scripts/verify/ → 仓库根

FILES = {
    "router": "apps/server/src/modelRouter.ts",
}

RUN = "npm run -s verify:routing"


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


MUTATIONS = [
    {
        "id": "RV1",
        "why": "复杂档的 model 改回 chatModel —— 真路由退回「只有 reason 不同」的空转形状",
        "edits": [
            (
                "          ? { apiKey, baseUrl, model: chatComplexModel, taskKind, reason: '复杂闲聊，路由到推理模型' }",
                "          ? { apiKey, baseUrl, model: chatModel, taskKind, reason: '复杂闲聊，路由到推理模型' }  // 【反证注入 RV1】",
            ),
        ],
    },
    {
        "id": "RV2",
        "why": "回落分支的 reason 谎称路由了 —— 未配 DEEPSEEK_MODEL_CHAT_COMPLEX 时报「路由到推理模型」",
        "edits": [
            (
                "              reason: '复杂闲聊，但未配 DEEPSEEK_MODEL_CHAT_COMPLEX，回落快速模型（没有换模型）',",
                "              reason: '复杂闲聊，路由到推理模型',  // 【反证注入 RV2】",
            ),
        ],
    },
    {
        "id": "RV3",
        "why": "kill-switch 失效 —— MODEL_ROUTING_ENABLED=0 时不再一律走默认模型（出事就没法一键退回）",
        "edits": [
            (
                "  const enabled = (process.env.MODEL_ROUTING_ENABLED ?? '1').trim() !== '0';",
                "  const enabled = true;  // 【反证注入 RV3】开关摘掉",
            ),
        ],
    },
    {
        "id": "RV4",
        "why": "isSimple 恒 false —— 问候与短句也被判成复杂，快速模型那条路等于废了",
        "edits": [
            (
                "    return /^(你好|您好|hi|hello|谢谢|感谢)/i.test(text.trim()) || text.trim().length < 10;",
                "    return false;  // 【反证注入 RV4】",
            ),
        ],
    },
    {
        "id": "RV5",
        "why": "isComplex 恒 false —— 带「分析/对比/报告」的长句落回通用闲聊分支，推理模型永远选不上",
        "edits": [
            (
                "    return /(分析|诊断|整理|对比|综合|报告|调研|策划|复杂|深度|全面)/.test(text);",
                "    return false;  // 【反证注入 RV5】",
            ),
        ],
    },
    {
        "id": "RV6",
        "why": "tag→taskKind 把 chat 认成 tool —— llm.ts 那层推断错了，路由从入口就跑偏",
        "edits": [
            (
                "  if (t.includes('chat/stream') || t.includes('chat')) return 'chat';",
                "  if (t.includes('chat/stream') || t.includes('chat')) return 'tool';  // 【反证注入 RV6】",
            ),
        ],
    },
]


def main() -> int:
    only = None
    for a in sys.argv[1:]:
        if a.startswith("--only="):
            only = {x.strip() for x in a[len("--only="):].split(",") if x.strip()}

    print("=== 收尾 7 · I 模型路由：变异反证 ===")
    print(f"    仓库 {REPO}")
    print(f"    每处注入后跑 {RUN}，要求 exit != 0（红）")
    before = {k: md5(os.path.join(REPO, v)) for k, v in FILES.items()}
    for k, v in before.items():
        print(f"    注入前 md5 {k:8s} {v}  ({FILES[k]})")
    # ★ 树「干净」的标准不是 git status 空 —— 本批次的改动本来就还没提交。
    #   正确的不变量是：**注入前后 git status 逐字节相同**（该改的还在、不该多的一个都没多）。
    _, git_before = sh("git status --porcelain -- " + " ".join(FILES.values()))
    print("    注入前 git status：\n" + "\n".join("      " + x for x in git_before.splitlines()))

    rows: list[tuple[str, str, str]] = []
    try:
        for m in MUTATIONS:
            if only and m["id"] not in only:
                continue
            path = os.path.join(REPO, FILES["router"])
            src = read(path)
            bad = [(o, src.count(o)) for o, _ in m["edits"] if src.count(o) != 1]
            if bad:
                rows.append((m["id"], "SKIP", "锚点不唯一：" + "; ".join(f"出现 {c} 次" for _, c in bad)))
                print(f"\n[SKIP] {m['id']} 锚点不唯一，跳过（不许糊里糊涂地注入）")
                continue
            print(f"\n----- {m['id']} 注入：{m['why']} -----")
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
            print(f"    {k:8s} {now}  {'一致' if same else '★不一致'}")
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
