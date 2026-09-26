#!/usr/bin/env python3
"""ADR-0004 · 浏览器深度 第二片 —— 稳健元素定位(语义定位层)反证:拆掉一级必红 + sha 还原。

「真」在哪:
  - 直接改**生产那份 core**(`apps/desktop/electron/semantic-locate.ts` 的 SEMANTIC_RESOLVE_BODY),
    再跑**真驱动 core 的验收**(`semantic-locate-smoke.mts`,Node vm 真跑那段解析 JS),看对应目标是否
    如预期**变红**;还原后看是否**转回全绿**。
  - 拆级是「定向」的:只拆一级,断言「**只有**依赖那一级的那些目标变红,其余不受影响」——
    证明「抗改版」确实来自被拆的那一级,而不是别处兜底。

两级(ADR-0004):
  ① 稳定属性:id → data-testid → aria-label → name(取首个可见)
  ② 文本 + tag + 结构(within 祖先范围,完全相等>前缀>包含)

反证:
  R1 删掉 ① 稳定属性级  → 只给 testid 的目标必红(S2 红),而 text+tag+within 目标不受影响(S1 仍绿)
  R2 拆掉 ② 文本+结构级的「文本匹配」→ 只给文本的目标必红(S1 红),而稳定属性目标不受影响(S2 仍绿)
  每步还原后核对 sha256 与改前一致,并复跑确认回绿。

用法:python3 scripts/verify/semantic-locate-revert.py(需已 npm i;会临时改生产文件,结束必还原)。
"""
import hashlib
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # scripts/verify → 仓库根
LOCATE = os.path.join(REPO, "apps", "desktop", "electron", "semantic-locate.ts")
SMOKE = os.path.join(REPO, "scripts", "verify", "semantic-locate-smoke.mts")

MARK1 = "// ---- ① 稳定属性"
MARK2 = "// ---- ② 文本 + tag + 结构"
TEXTMATCH = "textOf(el).indexOf(wantText) >= 0"


def sha256(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def read(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def write(path: str, s: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write(s)


def run_smoke():
    r = subprocess.run(["npx", "tsx", SMOKE], cwd=REPO, capture_output=True, text=True, timeout=180)
    return r.returncode, r.stdout


orig = read(LOCATE)
orig_sha = sha256(LOCATE)

fails = []


def check(cond: bool, label: str, detail: str = "") -> None:
    print(("  PASS  " if cond else "  FAIL  ") + label + (("   " + detail) if (detail and not cond) else ""))
    if not cond:
        fails.append(label)


def restore() -> None:
    write(LOCATE, orig)
    assert sha256(LOCATE) == orig_sha, "还原后 sha 不一致(不该发生)"


try:
    print("=" * 72)
    print("ADR-0004 · 浏览器深度 第二片:稳健元素定位(语义定位层)反证 —— 拆级必红 + sha 还原")
    print("=" * 72)
    print(f"  生产文件:{os.path.relpath(LOCATE, REPO)}")
    print(f"  改前 sha256:{orig_sha[:16]}…")

    # ------------------------------------------------------------------ R1
    print("\n[R1] 删掉 ① 稳定属性级 → 只给 testid 的目标必红(S2),text+tag+within 目标不受影响(S1 仍绿)")
    assert MARK1 in orig and MARK2 in orig, "找不到 ①/② 段落标记"
    s1 = orig.index(MARK1)
    e1 = orig.index(MARK2)
    write(LOCATE, orig[:s1] + orig[e1:])  # 删掉整个 ① 段(含 return)
    try:
        code, out = run_smoke()
        check(code != 0, "R1 拆级后:smoke 变红(exit!=0)", f"exit={code}")
        check("FAIL  S2" in out, "R1:只给 testid 的目标变红(S2 FAIL)")
        check("FAIL  S1" not in out, "R1:text+tag+within 目标不受影响(S1 仍绿)")
    finally:
        restore()
    code, out = run_smoke()
    check(code == 0, "R1 还原后:smoke 回全绿", f"exit={code}")

    # ------------------------------------------------------------------ R2
    print("\n[R2] 拆掉 ② 文本+结构级的「文本匹配」→ 只给文本的目标必红(S1),稳定属性目标不受影响(S2 仍绿)")
    assert orig.count(TEXTMATCH) == 1, "文本匹配锚点不是唯一(该不该发生)"
    write(LOCATE, orig.replace(TEXTMATCH, "false", 1))  # 关掉「文本包含」匹配 → 文本级失效
    try:
        code, out = run_smoke()
        check(code != 0, "R2 拆级后:smoke 变红(exit!=0)", f"exit={code}")
        check("FAIL  S1" in out, "R2:只给文本的目标变红(S1 FAIL)")
        # 只有「纯 testid」断言(S2 v1/v2)必须仍绿;S2 v2b 是回落断言、本就依赖文本级,红掉是预期
        pure_testid_red = ("FAIL  S2 v1:testId" in out) or ("FAIL  S2 v2:testId" in out)
        check(not pure_testid_red, "R2:纯 testid 目标不受影响(S2 v1/v2 仍绿)")
    finally:
        restore()
    code, out = run_smoke()
    check(code == 0, "R2 还原后:smoke 回全绿", f"exit={code}")

    # ------------------------------------------------------------------ 收尾
    assert sha256(LOCATE) == orig_sha, "收尾时生产文件 sha 与改前不一致(不该发生)"
    print(f"\n  收尾核对:生产文件 sha256 与改前一致({orig_sha[:16]}…)")

    print("\n=== 结论 ===")
    if fails:
        print(f"  {len(fails)} FAIL")
        for f in fails:
            print("    - " + f)
        sys.exit(1)
    print("  反证全绿:拆掉任一级,依赖它的目标必红(且只红那批);sha 还原后回全绿")
except Exception as e:  # noqa: BLE001
    # 任何异常都尽力还原,绝不留下被拆的 core
    try:
        restore()
        print("\n  (异常)已尝试还原生产文件")
    except Exception:
        pass
    print("  反证运行异常:", e)
    sys.exit(1)
