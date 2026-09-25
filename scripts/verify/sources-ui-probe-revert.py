# -*- coding: utf-8 -*-
"""
第 26 步收尾 · **界面层（来源标注）** 的反证脚本。

为什么要有它：
    `sources-ui-probe.py` 现在 32 PASS / 0 FAIL，其中两条是本轮新加的：
      · hit-test：来源条目中心点真的点得到（"点了有没有反应"最接近的机器判据）
      · 刷新后来源仍在：真实 UI 层证明"落库 → 读回 → 渲染"
    "全绿"本身不是证据 —— 断言可能根本没打到被测路径。这里故意注入缺陷，
    看那两条是不是真的会变红；再还原，看是不是真的回绿。

三处对照（同一支脚本内做 A/B）：
    ① 基线（不动代码）                              → 期望 0 FAIL
    ② 注入 A：design/11-chat-bubbles.css 给 .sources__item 加 pointer-events:none
               注入 B：chat.ts 的 /chat/history 不再回传 sources
                                                    → 期望 hit-test 1 条 + 刷新后 2 条变红
    ②b 注入 C（**单独一轮**）：App.tsx 把来源的 target="_blank" 改成 "_self"
                                                    → 期望「点击 → 系统浏览器真取走 url」那组全变红
    ③ 还原                                          → 期望 0 FAIL，且三个文件 sha256 **逐字节一致**

★ 为什么 C 必须**单独一轮**：A（pointer-events:none）会让点击根本到不了 `<a>`。
  若把 C 和 A 塞进同一轮，"点击那条变红"就说不清是 A 造成的还是 C 造成的 ——
  反证要**一次只动一个变量**，否则证明力打折。

★ 为什么注入 B 选 `/chat/history` 而不是落库那一步：
  桌面流式结束后是**本地追加消息**（不重拉 history），所以"只断 history 回传"
  恰好只打掉"刷新/切会话后还在"这一条 —— 精准命中，不会连累其它断言。

★ 为什么注入 A 不用重建桌面端：探针走的是 **vite dev server**
  （`VITE_DEV_SERVER_URL=http://localhost:5273`），渲染层直接吃源码，CSS 改完即生效。
  只有服务端是 `node dist/index.js`，必须 `npm run build -w @ai-workbench/server`。

用法：
    python scripts/verify/sources-ui-probe-revert.py
产出：
    docs/acceptance/tavily/sources-ui-probe-revert.log
"""
import hashlib
import io
import os
import re
import subprocess
import time

ROOT = r"C:\Users\bing\workbuddy-ai\work123"
PY = r"C:\Users\bing\.workbuddy-ai\binaries\python\envs\default\Scripts\python.exe"
OUT_DIR = os.path.join(ROOT, "docs", "acceptance", "tavily")
LOG_PATH = os.path.join(OUT_DIR, "sources-ui-probe-revert.log")

STYLES = os.path.join(ROOT, "apps", "desktop", "src", "design", "11-chat-bubbles.css")  # M5' 起 .sources__ 规则跟聊天区走;M9' 确认 styles.css 已删
CHAT_ROUTE = os.path.join(ROOT, "apps", "server", "src", "routes", "chat.ts")
APP_TSX = os.path.join(ROOT, "apps", "desktop", "src", "App.tsx")

lines = []


def log(*a):
    s = " ".join(str(x) for x in a)
    lines.append(s)
    print(s, flush=True)


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def read(p):
    # newline='' 保住原文件行尾，绝不顺手改成别的
    return io.open(p, encoding="utf-8", newline="").read()


def write(p, s):
    io.open(p, "w", encoding="utf-8", newline="").write(s)


def _norm(s, eol):
    """★ 锚点必须按文件实际行尾归一化再匹配（CRLF 文件 + \n 锚点 = 永远匹配不上）。"""
    return s.replace("\n", eol)


def patch(path, old, new, label):
    s = read(path)
    eol = "\r\n" if "\r\n" in s else "\n"
    o, n = _norm(old, eol), _norm(new, eol)
    if o not in s:
        log(f"  ✗ 注入点没找到（{label}，行尾={eol!r}）—— 被测文件已变，先修本脚本")
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
    if n not in s:
        log(f"  ✗ 还原失败：注入后的文本没找到（{os.path.relpath(path, ROOT)}）")
        return False
    write(path, s.replace(n, o, 1))
    return True


# ---------------------------------------------------------------- 注入内容
# A：让来源条目对 hit-test「隐身」（元素还在、还有尺寸、还是 <a>，但点不到）
A_OLD = """.sources__item {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  max-width: 100%;
  color: #2563eb;
  text-decoration: none;
  cursor: pointer;
}
"""
A_NEW = """.sources__item {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  max-width: 100%;
  color: #2563eb;
  text-decoration: none;
  cursor: pointer;
  /* [REVERT-INJECT-UI-A] 反证：元素还在、还有尺寸、还是 <a>，但 elementFromPoint 不再命中它 */
  pointer-events: none;
}
"""

# B：/chat/history 不再回传 sources（落库照旧，只掐"读回来"这一环）
B_OLD = "          sources: Array.isArray(r.sources) ? r.sources : undefined,\n"
B_NEW = "          sources: undefined, // [REVERT-INJECT-UI-B] 反证：history 不再回传来源\n"

# C：来源的 target="_blank" → "_self"。
#    这样点击就变成「同标签页导航」→ 主进程 will-navigate 把它拦掉 ⇒ 系统浏览器**不再被唤起**，
#    而 DOM 里一切都还在（还是 <a>、还有 href、还有尺寸）⇒ 精准只打掉"那一跳"。
C_OLD = (
    '                        href={src.url}\n'
    '                        target="_blank"\n'
)
C_NEW = (
    '                        href={src.url}\n'
    '                        target="_self" // [REVERT-INJECT-UI-C] 反证：不再走 target=_blank\n'
)


def build_server():
    r = subprocess.run(
        "npm.cmd run build -w @ai-workbench/server",
        cwd=ROOT, capture_output=True, text=True, shell=True,
    )
    ok = r.returncode == 0
    if not ok:
        log("  ✗ 服务端编译失败：")
        log((r.stdout or "")[-1200:])
        log((r.stderr or "")[-1200:])
    return ok


def settle():
    """
    ★ 连跑三次探针之间必须清残留 + 沉降。
      实测踩过：上一轮 Electron 的 GPU 子进程还没退干净，下一轮启动后
      中途 GPU FATAL（`GPU process isn't usable. Goodbye.`），
      现象是登录后 CDP `Connection timed out` —— **极易误判成"探针坏了"**。
    """
    subprocess.run(["taskkill", "/F", "/IM", "electron.exe"],
                   capture_output=True, shell=False)
    time.sleep(6)


def run_probe(tag):
    """跑一遍探针。`tag` 用于把这一轮的**完整输出**存档 —— 出问题时不必重跑就能诊断。"""
    settle()
    r = subprocess.run(
        [PY, os.path.join(ROOT, "scripts", "verify", "sources-ui-probe.py")],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=1800,
    )
    text = (r.stdout or "") + (r.stderr or "")
    io.open(os.path.join(OUT_DIR, "sources-ui-probe-revert-%s.log" % tag),
            "w", encoding="utf-8", newline="\n").write(text)
    m = re.search(r"汇总：(\d+) PASS / (\d+) FAIL", text)
    if not m:
        log("  ✗ 没解析到汇总行，输出尾部：")
        log(text[-1500:])
        return -1, -1, text
    return int(m.group(1)), int(m.group(2)), text


def failed(text):
    """
    ★ 两种失败行格式都要认（这是我踩过的坑）：
      · 本项目的 `*.py` 探针（`sources-ui-probe.py`）用的是  `FAIL  <名字> :: <细节>`
      · `*.mts`/`*.mjs` 脚本用的是 `[FAIL] <id> — <细节>`
      第一版我照抄了 `.mts` 那份，只匹配 `[FAIL]` ⇒ 这个探针的失败行**一条都抓不到**，
      现象是"明明 4 FAIL，却说受影响断言 0 条变红"，**极易误判成断言是摆设**。
    """
    return [ln.strip() for ln in text.splitlines()
            if ln.startswith("[FAIL]") or ln.startswith("FAIL ")]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    log("=" * 74)
    log("第 26 步收尾 · 来源标注（界面层）的反证")
    log("=" * 74)

    before = {STYLES: sha(STYLES), CHAT_ROUTE: sha(CHAT_ROUTE), APP_TSX: sha(APP_TSX)}
    log("\n[0] 开工前指纹")
    for p, h in before.items():
        log(f"    {os.path.relpath(p, ROOT)}  {h[:16]}")

    # ------------------------------------------------------------ ① 基线
    log("\n[1] 基线（不动代码）—— 期望 0 FAIL")
    if not build_server():
        return 2
    base_p, base_f, base_text = run_probe("1-baseline")
    log(f"    → {base_p} PASS / {base_f} FAIL")
    if base_f != 0:
        log("    ✗ 基线就不绿，反证没有意义（先修功能/断言，再跑本脚本）")
        return 2

    # ------------------------------------------------------------ ② 注入
    log("\n[2] 注入 A（CSS: pointer-events:none）+ 注入 B（history 不回传 sources）")
    log("    期望变红：")
    log("      · ★ 每条来源的中心点真的点得到（hit-test 命中自己…）")
    log("      · ★ 刷新后来源块仍在（证明来源真的落了库…）")
    log("      · ★ 刷新后来源与刷新前逐条一致（同 url 同序）")
    if not patch(STYLES, A_OLD, A_NEW, "11-chat-bubbles.css pointer-events"):
        return 2
    if not patch(CHAT_ROUTE, B_OLD, B_NEW, "chat.ts history sources"):
        unpatch(STYLES, A_NEW, A_OLD)
        return 2
    if not build_server():
        unpatch(STYLES, A_NEW, A_OLD)
        unpatch(CHAT_ROUTE, B_NEW, B_OLD)
        return 2

    p, f, text = run_probe("2-injected")
    red = failed(text)
    log(f"    → {p} PASS / {f} FAIL")
    for x in red:
        log(f"      {x}")

    """★ 阈值要**精确点名受本次注入影响的那几条**，不能写成"整组全红"：
       hit-test 只影响 1 条；"视口内"那条不受影响（元素位置没变）。
       组里混着保底用例时，拿它们要求变红属于断言打错路径。"""
    expect_red = [
        "每条来源的中心点真的点得到",
        "刷新后来源块仍在",
        "刷新后来源与刷新前逐条一致",
    ]
    hit = [k for k in expect_red if any(k in x for x in red)]
    inj_ok = len(hit) == len(expect_red)
    log(f"    受影响的断言：期望 {len(expect_red)} 条变红，实际 {len(hit)} 条 → "
        + ("✓ 全变红" if inj_ok else "✗ 没红 —— 断言是摆设！")
        + ("" if inj_ok else f"（缺：{[k for k in expect_red if k not in hit]}）"))

    # ------------------------------------------------------------ ②b 注入 C（单独一轮）
    log("\n[2b] 先把 A+B 还原干净，然后**只**注入 C（App.tsx: target=_blank → _self）")
    log("    期望变红：")
    log("      · ★ 点击前 href 已改写到本机探针服务，但 target/rel 原样没动")
    log("      · ★ 点击来源后，系统默认浏览器**真的取走了这个 url**")
    unpatch(STYLES, A_NEW, A_OLD)
    unpatch(CHAT_ROUTE, B_NEW, B_OLD)
    if not build_server():
        return 2
    if not patch(APP_TSX, C_OLD, C_NEW, "App.tsx target=_blank → _self"):
        return 2
    pc, fc, textc = run_probe("2b-injected-c")
    redc = failed(textc)
    log(f"    → {pc} PASS / {fc} FAIL")
    for x in redc:
        log(f"      {x}")
    """★ 阈值照样精确点名：C 只影响「点击那一跳」这一组；
       「点完之后应用没被顶掉」是**对照项**，注入 C 后它更该是绿的（同页导航被拦掉了）。"""
    expect_red_c = [
        "点击前 href 已改写到本机探针服务",
        "点击来源后，系统默认浏览器",
    ]
    hitc = [k for k in expect_red_c if any(k in x for x in redc)]
    inj_c_ok = len(hitc) == len(expect_red_c)
    log(f"    受影响的断言：期望 {len(expect_red_c)} 条变红，实际 {len(hitc)} 条 → "
        + ("✓ 全变红" if inj_c_ok else "✗ 没红 —— 断言是摆设！")
        + ("" if inj_c_ok else f"（缺：{[k for k in expect_red_c if k not in hitc]}）"))

    # ------------------------------------------------------------ ③ 还原
    log("\n[3] 还原（A/B 已在 2b 开头还原，这里只需还原 C）")
    ok_c = unpatch(APP_TSX, C_NEW, C_OLD)
    log(f"    App.tsx 还原={'✓' if ok_c else '✗'}")
    if not build_server():
        return 2

    p2, f2, text2 = run_probe("3-restored")
    log(f"    → {p2} PASS / {f2} FAIL")
    for x in failed(text2):
        log(f"      {x}")

    after = {STYLES: sha(STYLES), CHAT_ROUTE: sha(CHAT_ROUTE), APP_TSX: sha(APP_TSX)}
    same = all(before[k] == after[k] for k in before)
    log("\n[4] 还原后指纹")
    for k in before:
        log(f"    {os.path.relpath(k, ROOT)}  {before[k][:16]} → {after[k][:16]}  "
            + ("✓ 一致" if before[k] == after[k] else "✗ 不一致"))

    verdict = inj_ok and inj_c_ok and base_f == 0 and f2 == 0 and same
    log("\n" + "=" * 74)
    log("结论")
    log(f"  ① 基线 0 FAIL                        : {'✓' if base_f == 0 else '✗'}")
    log(f"  ② 注入 A+B → 3 条断言全变红           : {'✓' if inj_ok else '✗'}")
    log(f"  ②b 注入 C（单独一轮）→ 2 条全变红      : {'✓' if inj_c_ok else '✗'}")
    log(f"  ③ 还原后 0 FAIL                      : {'✓' if f2 == 0 else '✗'}")
    log(f"  ④ 三个文件 sha256 逐字节一致           : {'✓' if same else '✗'}")
    log(f"  ⇒ 反证{'成立' if verdict else '不成立'}")
    log("=" * 74)

    io.open(LOG_PATH, "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")
    print(f"\n日志：{LOG_PATH}")
    return 0 if verdict else 1


if __name__ == "__main__":
    raise SystemExit(main())
