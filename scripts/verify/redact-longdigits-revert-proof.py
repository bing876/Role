#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
longdigits 脱敏规则 · 变异反证（把生产代码改坏，`verify:redact` 必须红）
========================================================================

    python3 scripts/verify/redact-longdigits-revert-proof.py
    python3 scripts/verify/redact-longdigits-revert-proof.py --only=L1,L4

规则本身（用户 2026-09-24 拍板，批次 J 之后补）：**≥21 位连续纯数字串**整段脱敏，标签 `longdigits`，
且**判定（`detectSensitive`）与掩码（`VALUE_PATTERNS`）必须共用同一组边界**。

要反证的正是「共用」这两个字最容易坏的几种坏法：

  L1 边界常量从 21 挪到 25            → 21~24 位重新漏网，⑤-1 逐长度对照表必须红
  L2 掩码表里那条摘掉                  → 明文照旧落库（判定说敏感、库里却是原文），③-7/③-8/⑤-1 必须红
  L3 判定那半条摘掉                    → 委派/派工不再拒绝（库里抹了、任务照发），⑤-1 必须红
  L4 掩码表里把 longdigits 挪到 otp 之后 → 短上限的 otp 先跑会**留 11 位明文尾巴**，⑤-2b/⑤-3 必须红
  L5 判定那份正则带上 `g`              → `.test()` 因 lastIndex 在连续调用间漏判，⑤-9 必须红
  L6 判定改成硬编码 `\\d{21,}`（第二份边界）→ 两处从此各自漂移，⑤-2 必须红
  L7 `sensitiveLabel` 的 case 摘掉      → 拒绝原因里那句人话退化成「敏感信息」，⑤-2c 必须红

★ 纪律：注入期间**只改产品代码，绝不动断言**（改断言让绿的就不是反证，是自欺）。
★ L1 与 L6 是一对：L1 证明「边界值被断言钉住」，L6 证明「边界只许有一个来源」——
  只钉值不钉来源，将来就会有人在第二处写死一个 21，两边各自改各自漂。
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # scripts/verify/ → 仓库根

FILES = {
    "redact": "apps/server/src/orchestrator/redact.ts",
}

RUN = "npm run -s verify:redact"


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


# ---------------------------------------------------------------------------
# 每处注入：edits = [(把什么, 换成什么), ...]（每段的锚点必须在文件里**恰好出现一次**）
# ---------------------------------------------------------------------------
MUTATIONS = [
    {
        "id": "L1",
        "why": "边界常量从 21 挪到 25 —— 21~24 位的连续数字串重新整段漏网",
        "edits": [
            ("const LONG_DIGITS_MIN = 21;", "const LONG_DIGITS_MIN = 25;  // 【反证注入 L1】"),
        ],
    },
    {
        "id": "L2",
        "why": "掩码表里 longdigits 那条摘掉 —— 判定照样说敏感，库里却是**原文**（payload.steps 是明文列）",
        "edits": [
            ("  { re: LONG_DIGITS_RE_G, tag: 'longdigits' },\n", "  // 【反证注入 L2】掩码这条摘掉\n"),
        ],
    },
    {
        "id": "L3",
        "why": "判定那半条摘掉 —— 库里抹了，委派/派工却不再拒绝（两处不同步的典型坏法）",
        "edits": [
            (
                "  if (LONG_DIGITS_RE.test(t)) return 'longdigits';",
                "  // 【反证注入 L3】判定这半条摘掉",
            ),
        ],
    },
    {
        "id": "L4",
        "why": "掩码表里把 longdigits 挪到 otp **之后** —— otp 的值上限只有 10，会留 11 位明文尾巴",
        "edits": [
            ("  { re: LONG_DIGITS_RE_G, tag: 'longdigits' },\n", ""),
            (
                "  { re: /((?:验证码|校验码|短信码|动态口令|otp|captcha|verification\\s*code)\\s*[:：是为]?\\s*)([A-Za-z0-9]{3,10})/gi, tag: 'otp' },",
                "  { re: /((?:验证码|校验码|短信码|动态口令|otp|captcha|verification\\s*code)\\s*[:：是为]?\\s*)([A-Za-z0-9]{3,10})/gi, tag: 'otp' },\n"
                "  { re: LONG_DIGITS_RE_G, tag: 'longdigits' },  // 【反证注入 L4】挪到 otp 之后",
            ),
        ],
    },
    {
        "id": "L5",
        "why": "判定那份正则带上 `g` —— 带 g 的 `.test()` 会因 lastIndex 在连续调用之间漏判",
        "edits": [
            (
                "const LONG_DIGITS_RE = new RegExp(LONG_DIGITS_SRC);",
                "const LONG_DIGITS_RE = new RegExp(LONG_DIGITS_SRC, 'g');  // 【反证注入 L5】",
            ),
        ],
    },
    {
        "id": "L6",
        "why": "判定改成硬编码 `\\d{21,}` —— 边界有了第二份来源，两处从此各自漂移",
        "edits": [
            (
                "  if (LONG_DIGITS_RE.test(t)) return 'longdigits';",
                "  if (/\\b\\d{21,}\\b/.test(t)) return 'longdigits';  // 【反证注入 L6】",
            ),
        ],
    },
    {
        "id": "L7",
        "why": "`sensitiveLabel` 的 longdigits case 摘掉 —— 拒绝原因退化成一句「敏感信息」",
        "edits": [
            (
                "    case 'longdigits':\n"
                "      // 说人话，但**不说位数以下的内容**：这句话会进拒绝原因与频道留痕，绝不能带原文\n"
                "      return '超长数字串（21 位以上的连续数字）';\n",
                "    // 【反证注入 L7】case 摘掉\n",
            ),
        ],
    },
]


def main() -> int:
    args = sys.argv[1:]
    only = None
    for a in args:
        if a.startswith("--only="):
            only = {x.strip() for x in a[len("--only="):].split(",") if x.strip()}

    print("=== longdigits 脱敏规则：变异反证 ===")
    print(f"    仓库 {REPO}")
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
            path = os.path.join(REPO, m.get("file", FILES["redact"]))
            src = read(path)
            # 每段锚点必须恰好出现一次，否则不注入（不许糊里糊涂地改）
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
                print(f"      跑 {RUN}")
                print(f"      → exit={rc} {'（红了，符合预期）' if ok else '（★居然还是绿的：断言没咬住这处改动！）'}")
                # 红在哪几条断言上，是反证的**内容**（只报 exit code 等于只说「有东西坏了」）
                red = [x for x in tail.splitlines() if "FAIL" in x or x.strip().startswith("- ")] or tail.splitlines()[-6:]
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
        if dirty or not clean:
            rows.append(("RESTORE", "★FAIL", "还原不干净"))
        else:
            rows.append(("RESTORE", "OK", "md5 与 git status 都回到注入前"))

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
