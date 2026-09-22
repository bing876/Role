"""
第 26 步收尾 · 问题 A / B 修复的**反证**脚本（桌面本地路由层）。

为什么要有它：
    `search-vs-browser-routing.mts` 现在 97 PASS / 0 FAIL。但"全绿"本身不是证据 ——
    断言可能根本没打到被测路径（本项目踩过多次）。这里故意**把判定逻辑改回修复前**，
    看那几条专项用例是不是真的会变红；再还原，看是不是真的回绿。

三处对照（同一支脚本内做 A/B，避免"两次跑的环境不一样"说不清）：
    ① 基线（不动代码）                     → 期望 0 FAIL
    ② 注入 A：撤掉 intent.ts 的「查资料 vs 页面操作」分流 → 期望 A-1 四条变红
    ③ 注入 B：撤掉 sites.ts 的「在 X 上」识别（两处）    → 期望 B-1 五条 + B-3 两条变红
    ④ 还原                                 → 期望 0 FAIL，且两个文件 sha256 **逐字节一致**

★ 只改这两个文件 —— 它们正是本次用户授权的"判断该走搜索还是该走浏览器"那一层，
  一行驾驶相关代码（driver.ts / agent.ts / 主进程驾驶循环）都没碰。

用法：
    python scripts/verify/search-vs-browser-routing-revert.py
产出：
    docs/acceptance/tavily/search-vs-browser-routing-revert.log
"""
import hashlib
import io
import os
import re
import subprocess
import sys

ROOT = r"C:\Users\bing\workbuddy-ai\work123"
NODE = r"C:\Users\bing\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe"
OUT_DIR = os.path.join(ROOT, "docs", "acceptance", "tavily")
LOG_PATH = os.path.join(OUT_DIR, "search-vs-browser-routing-revert.log")

INTENT = os.path.join(ROOT, "apps", "desktop", "src", "browser", "intent.ts")
SITES = os.path.join(ROOT, "apps", "desktop", "src", "browser", "sites.ts")

lines = []


def log(*a):
    s = " ".join(str(x) for x in a)
    lines.append(s)
    print(s, flush=True)


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def read(p):
    # newline='' 保住原文件的 CRLF，绝不顺手改成 LF
    return io.open(p, encoding="utf-8", newline="").read()


def write(p, s):
    io.open(p, "w", encoding="utf-8", newline="").write(s)


def _norm(s, eol):
    """
    ★ 锚点必须按**文件实际行尾**归一化再匹配。
      上一轮我在这里栽过：脚本里写 `\\n`、文件是 CRLF ⇒ 多行锚点永远匹配不上，
      现象是"注入点没找到"，**极易误判成"代码被别人改了"**。`*.ts` 一律 CRLF。
    """
    return s.replace("\n", eol)


def patch(path, old, new, label):
    s = read(path)
    eol = "\r\n" if "\r\n" in s else "\n"
    o, n = _norm(old, eol), _norm(new, eol)
    if o not in s:
        log(f"  ✗ 注入点没找到（{label}，行尾={eol!r}）—— 判定逻辑已变，先修本脚本")
        return False
    if s.count(o) != 1:
        log(f"  ✗ 注入点不唯一（出现 {s.count(o)} 次，{label}）")
        return False
    write(path, s.replace(o, n, 1))
    log(f"  ✓ 已注入：{label}")
    return True


def unpatch(path, new, old):
    s = read(path)
    eol = "\r\n" if "\r\n" in s else "\n"
    n, o = _norm(new, eol), _norm(old, eol)
    write(path, s.replace(n, o, 1))


# ---------------------------------------------------------------- 注入内容
# A：撤掉 intent.ts 的分流 ⇒ 回到「命中 BROWSE_ACT 就发车」的旧行为
A_OLD = """  // ① 页面上才成立的动作、② 明确指了这张页、③ 用代词指着眼前的东西 —— 任一成立就是页面操作
  if (PAGE_ONLY_ACT.test(t) || PAGE_REF.test(t) || PAGE_DEIXIS.test(t)) return t;
  // ④ 只剩「查资料」的说法、又没指页面 → **不是**页面操作（交给联网搜索）
  if (LOOKUP_ONLY.test(t)) return null;
  // ⑤ 句子里明确在说外部东西（书名号 / 我的笔记 / 那篇论文）→ 也**不是**页面操作
  if (EXTERNAL_OBJ.test(t)) return null;
"""
A_NEW = "  // [REVERT-INJECT-A] 反证：撤掉「查资料 vs 页面操作」分流（回到修复前）\n"

# B1：撤掉 detectOpenUrl 里的「在 X 上」识别（连 ON_SHAPE 守卫一起去掉 = 回到修复前）
B1_OLD = """  if (ON_SHAPE.test(t)) {
    const onTarget = targetFromOnPattern(t);
    if (onTarget) {
      const hit = lookupSite(onTarget);
      if (hit) return hit;
    }
    // ★ 形状成立就**到此为止**：那个「上」是句式的一部分，走动词路径只会剥出错误目标。
    //   没登记时交给 detectUnknownOpenTarget 去决定"如实说认不出"还是"什么都不说"。
    return null;
  }
"""
B1_NEW = "  // [REVERT-INJECT-B1] 反证：撤掉「在 X 上」识别（回到修复前）\n"

# C：撤掉「空目标只在开页动词下才落主页」的收紧 ⇒ 回到「裸『上』也弹主页」
C_OLD = "  if (!site) return OPEN_VERB_ONLY.test(t) ? HOME_URL : null;\n"
C_NEW = "  if (!site) return HOME_URL; // [REVERT-INJECT-C]\n"

# B2：撤掉 detectUnknownOpenTarget 里的「在 X 上」目标纠正（含 ON_SHAPE 守卫）
B2_OLD = """  if (ON_SHAPE.test(t)) {
    const onTarget = targetFromOnPattern(t);
    // ★ 形状成立就到此为止：剥不出目标（比如「在沙发上躺一会儿」没有干活动词）时，
    //   绝不能继续走动词路径 —— 那条路会咬住裸「上」，把「躺一会儿」当成站点名报出去。
    if (!onTarget) return null;
    return looksLikeSiteName(onTarget) ? onTarget : null;
  }
"""
B2_NEW = "  // [REVERT-INJECT-B2] 反证：撤掉「在 X 上」目标纠正（回到修复前）\n"


def run_test():
    r = subprocess.run(
        [NODE, os.path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
         os.path.join(ROOT, "scripts", "verify", "search-vs-browser-routing.mts")],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    text = (r.stdout or "") + (r.stderr or "")
    m = re.search(r"汇总：(\d+) PASS / (\d+) FAIL", text)
    if not m:
        log("  ✗ 没解析到汇总行，输出尾部：")
        log(text[-1500:])
        return -1, -1, text
    return int(m.group(1)), int(m.group(2)), text


def failed_ids(text):
    return [ln for ln in text.splitlines() if ln.startswith("[FAIL]")]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    log("=" * 74)
    log("第 26 步收尾 · 问题 A / B 修复的反证（桌面本地路由层）")
    log("=" * 74)

    before = {INTENT: sha(INTENT), SITES: sha(SITES)}
    log("\n[0] 开工前指纹")
    for p, h in before.items():
        log(f"    {os.path.relpath(p, ROOT)}  {h[:16]}")

    # ------------------------------------------------------------ ① 基线
    log("\n[1] 基线（不动代码）—— 期望 0 FAIL")
    base_p, base_f, text = run_test()
    log(f"    → {base_p} PASS / {base_f} FAIL")
    if base_f != 0:
        log("    ✗ 基线就不绿，反证没有意义（先修功能/断言，再跑本脚本）")
        return 2

    # ------------------------------------------------------------ ② 注入 A
    log("\n[2] 注入 A：撤掉 intent.ts 的「查资料 vs 页面操作」分流")
    log("    期望：A-1 四条（查资料类不该驱动浏览器）全部变红")
    if not patch(INTENT, A_OLD, A_NEW, "intent.ts 分流"):
        return 2
    p, f, text = run_test()
    red = [x for x in failed_ids(text) if "A-1" in x]
    log(f"    → {p} PASS / {f} FAIL")
    for x in failed_ids(text):
        log(f"      {x}")
    """
    ★ 阈值要**精确点名受本次修复影响的那几条**，不能写成"A-1 全红"：
      A-1 里还有一条「今天北京天气怎么样」是**保底用例**（它压根不命中 BROWSE_ACT，
      修复前后都不发车）—— 拿它去要求变红，属于**断言打错了路径**。
      这个错误是我自己第一次跑出来的（报了"3 条 → ✗ 没红"），修的是阈值不是断言。
    """
    expect_red = [
        "帮我查一下今天的美元汇率",
        "帮我搜一下今天的新闻",
        "查一下碳化硅主要用在哪",
    ]
    hit = [q for q in expect_red if any(q in x for x in red)]
    inj_a_ok = len(hit) == len(expect_red)
    log(f"    受修复影响的 A-1 用例：期望 {len(expect_red)} 条变红，实际 {len(hit)} 条 → "
        f"{'✓ 全变红' if inj_a_ok else '✗ 没红 —— 断言是摆设！'}"
        + ("" if inj_a_ok else f"（缺：{[q for q in expect_red if q not in hit]}）"))
    unpatch(INTENT, A_NEW, A_OLD)
    log("    ✓ 已还原 intent.ts")

    # ------------------------------------------------------------ ③ 注入 B
    log("\n[3] 注入 B：撤掉 sites.ts 的「在 X 上」识别（detectOpenUrl + detectUnknownOpenTarget 两处）")
    log("    期望：B-1 五条（在必应上/在京东上…能开出站点）变红，B-3 两条（报对站点名）变红")
    if not patch(SITES, B1_OLD, B1_NEW, "sites.ts detectOpenUrl"):
        return 2
    if not patch(SITES, B2_OLD, B2_NEW, "sites.ts detectUnknownOpenTarget"):
        unpatch(SITES, B1_NEW, B1_OLD)
        return 2
    p, f, text = run_test()
    red_b1 = [x for x in failed_ids(text) if "B-1" in x]
    red_b3 = [x for x in failed_ids(text) if "B-3" in x]
    log(f"    → {p} PASS / {f} FAIL")
    for x in failed_ids(text):
        log(f"      {x}")
    inj_b_ok = len(red_b1) >= 5 and len(red_b3) >= 2
    log(f"    期望变红的 B-1：{len(red_b1)} 条、B-3：{len(red_b3)} 条 → "
        f"{'✓ 变红了' if inj_b_ok else '✗ 没红 —— 断言是摆设！'}")
    unpatch(SITES, B2_NEW, B2_OLD)
    unpatch(SITES, B1_NEW, B1_OLD)
    log("    ✓ 已还原 sites.ts")

    # ------------------------------------------------------------ ③.5 注入 C（裸动词）
    log("\n[3.5] 注入 C：撤掉「空目标只在开页动词下才落主页」的收紧")
    log("      期望：E-7 里「上」「去」两条变红（回到「裸动词也弹主页」）")
    if not patch(SITES, C_OLD, C_NEW, "sites.ts 空目标收紧"):
        return 2
    p, f, text = run_test()
    red_c = [x for x in failed_ids(text) if "E-7" in x]
    log(f"    → {p} PASS / {f} FAIL")
    for x in red_c:
        log(f"      {x}")
    expect_red_c = ["E-7「上」", "E-7「去」"]
    hit_c = [k for k in expect_red_c if any(k in x for x in red_c)]
    inj_c_ok = len(hit_c) == len(expect_red_c)
    log(f"    受影响的 E-7 用例：期望 {len(expect_red_c)} 条变红，实际 {len(hit_c)} 条 → "
        + ("✓ 全变红" if inj_c_ok else "✗ 没红 —— 断言是摆设！")
        + ("" if inj_c_ok else f"（缺：{[k for k in expect_red_c if k not in hit_c]}）"))
    unpatch(SITES, C_NEW, C_OLD)
    log("    ✓ 已还原 sites.ts")

    # ------------------------------------------------------------ ④ 还原复核
    log("\n[4] 还原后复核 —— 期望 0 FAIL，且 sha256 与开工前一致")
    after = {INTENT: sha(INTENT), SITES: sha(SITES)}
    same = all(before[k] == after[k] for k in before)
    for k in before:
        log(f"    {os.path.relpath(k, ROOT)}  {before[k][:16]} → {after[k][:16]}  "
            f"{'一致' if before[k] == after[k] else '★ 不一致'}")
    p, f, text = run_test()
    log(f"    → {p} PASS / {f} FAIL")
    for x in failed_ids(text):
        log(f"      {x}")

    # ------------------------------------------------------------ 结论
    log("\n" + "=" * 74)
    log("结论")
    log("=" * 74)
    log(f"  ① 基线 0 FAIL                     : {'✓' if base_f == 0 else '✗'}")
    log(f"  ② 注入 A → A-1 变红                : {'✓' if inj_a_ok else '✗'}")
    log(f"  ③ 注入 B → B-1 / B-3 变红          : {'✓' if inj_b_ok else '✗'}")
    log(f"  ③.5 注入 C → E-7 变红              : {'✓' if inj_c_ok else '✗'}")
    log(f"  ④ 还原 → 0 FAIL 且 sha256 一致     : {'✓' if f == 0 and same else '✗'}")
    verdict = inj_a_ok and inj_b_ok and inj_c_ok and base_f == 0 and f == 0 and same
    log(f"\n  反证{'成立 —— 这些断言真的会因「改回旧逻辑」变红，不是摆设' if verdict else '★ 不成立，必须补强测试'}")

    write(LOG_PATH, "\n".join(lines) + "\n")
    log(f"\n日志：{LOG_PATH}")
    return 0 if verdict else 1


if __name__ == "__main__":
    sys.exit(main())
