"""
第 26 步 · 真机端到端（HTTP 层）的**反证**脚本。

为什么要有它：
    自动化测试全绿本身不构成证据 —— 断言可能根本没打到被测路径（这是本项目踩过多次的坑）。
    这里故意往代码里**注入缺陷**，看那几条关键断言是不是真的会变红；再还原，看是不是真的回绿。
    全程在同一支脚本里做 A/B，避免"两次跑的环境不一样"这种说不清的情况。

四处对照（顺序执行）：
    ① 基线（不动代码）      → 期望 0 FAIL（证明这轮环境里 S1 本来就会走搜索）
    ② 注入 A：关掉工具      → 期望「S1 该搜索 → SSE 里真的有 search 事件」变红
                              （`chatLoop.ts` 把 toolChoice 恒设为 'none'，模型再也调不到工具）
    ③ 注入 B：搜索轮 bind 页 → 期望「S1 ★ 该搜索 → 没有制造任何浏览器侧状态」变红
                              （`routes/chat.ts` 里注入一次 bindPageLoop ⇒ pageStates 涨到 1）
    ④ 还原                  → 期望 0 FAIL，且两个文件的 sha256 与开工前**逐字节一致**

★ 注入的都是**本步自己新增/改过的文件**，一行浏览器相关代码都没碰。

用法：
    python scripts/verify/search-chat-e2e-revert.py
产出：
    docs/acceptance/tavily/search-chat-e2e-revert.log
"""
import hashlib
import io
import os
import re
import subprocess
import sys
import time

ROOT = r"C:\Users\bing\workbuddy-ai\work123"
NODE = r"C:\Users\bing\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe"
OUT_DIR = os.path.join(ROOT, "docs", "acceptance", "tavily")
LOG_PATH = os.path.join(OUT_DIR, "search-chat-e2e-revert.log")

CHAT_LOOP = os.path.join(ROOT, "apps", "server", "src", "search", "chatLoop.ts")
CHAT_ROUTE = os.path.join(ROOT, "apps", "server", "src", "routes", "chat.ts")

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


def patch(path, old, new, label):
    """
    ★ 锚点必须按**文件实际行尾**归一化再匹配。
      第一版我在脚本里写 `\n`，而 `chat.ts` 是 CRLF ⇒ 多行锚点永远匹配不上
      （现象是"注入点没找到"，很容易误判成"代码变了"）。`*.ts` 一律 CRLF。
    """
    s = read(path)
    eol = "\r\n" if "\r\n" in s else "\n"
    old = old.replace("\n", eol)
    new = new.replace("\n", eol)
    if old not in s:
        log(f"  ✗ 注入点没找到（{label}，行尾={eol!r}）—— 断言基准已变，先修脚本")
        return False
    if s.count(old) != 1:
        log(f"  ✗ 注入点不唯一（出现 {s.count(old)} 次，{label}）")
        return False
    write(path, s.replace(old, new, 1))
    log(f"  ✓ 已注入：{label}")
    return True


def unpatch(path, new, old):
    """注入的**原样撤掉**（同一套行尾归一化），撤完必须与开工前 sha256 一致。"""
    s = read(path)
    eol = "\r\n" if "\r\n" in s else "\n"
    new = new.replace("\n", eol)
    old = old.replace("\n", eol)
    write(path, s.replace(new, old, 1))


# ---------------------------------------------------------------- 注入内容
INJ_A_OLD = "        toolChoice: forceAnswer ? 'none' : 'auto',"
INJ_A_NEW = "        toolChoice: 'none', // [REVERT-INJECT-A] 反证：模型再也调不到工具"

INJ_B_ANCHOR = "        const out = await streamChatWithSearch("
INJ_B_NEW = (
    "        // [REVERT-INJECT-B] 反证：让搜索轮也去 bind 一张页（正常代码里只有浏览器链路会做）\n"
    "        {\n"
    "          const __ps = await import('../pageState');\n"
    "          __ps.bindPageLoop(424242, 'inject-probe', claims.sub, agentId ?? null);\n"
    "        }\n"
    "        const out = await streamChatWithSearch("
)

# 第 26 步 · 来源标注：让服务端算出的来源变成空数组 ⇒ 既不下发也不落库
INJ_C_OLD = "        const sources = collectSources(searches);"
INJ_C_NEW = "        const sources: ChatSource[] = []; // [REVERT-INJECT-C] 反证：来源标注整条链路被掉掉"


def build():
    # shell=True：Windows 上 npm 是 npm.cmd，直接给列表形式会找不到可执行文件
    r = subprocess.run(
        "npm run build -w @ai-workbench/server",
        cwd=ROOT, capture_output=True, text=True, shell=True,
    )
    ok = r.returncode == 0
    if not ok:
        log("  ✗ 编译失败：")
        log((r.stdout or "")[-1500:])
        log((r.stderr or "")[-1500:])
    return ok


def run_e2e(only):
    """跑一次端到端（只跑指定用例），返回 (pass, fail, 文本)"""
    r = subprocess.run(
        [NODE, os.path.join(ROOT, "scripts", "verify", "search-chat-e2e.mjs"), f"--only={only}"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    text = (r.stdout or "") + (r.stderr or "")
    m = re.search(r"汇总：(\d+) PASS / (\d+) FAIL", text)
    if not m:
        log("  ✗ 没解析到汇总行，原始输出尾部：")
        log(text[-1500:])
        return -1, -1, text
    return int(m.group(1)), int(m.group(2)), text


def failed_ids(text):
    return [ln for ln in text.splitlines() if ln.startswith("[FAIL]")]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    log("=" * 72)
    log("第 26 步 · 端到端（HTTP 层）反证")
    log("=" * 72)

    before = {CHAT_LOOP: sha(CHAT_LOOP), CHAT_ROUTE: sha(CHAT_ROUTE)}
    log("\n[0] 开工前指纹")
    for p, h in before.items():
        log(f"    {os.path.relpath(p, ROOT)}  {h[:16]}")

    results = {}

    # ------------------------------------------------------------ ① 基线
    log("\n[1] 基线（不动代码）—— 期望 0 FAIL")
    if not build():
        return 2
    p, f, text = run_e2e("S1")
    results["baseline"] = (p, f, failed_ids(text))
    log(f"    → {p} PASS / {f} FAIL")
    if f != 0:
        log("    ✗ 基线就不绿，反证没有意义（先修功能/断言，再跑本脚本）")
        return 2

    # ------------------------------------------------------------ ② 注入 A
    log("\n[2] 注入 A：把 toolChoice 恒设为 'none'（模型调不到搜索工具）")
    log("    期望：「S1 该搜索 → SSE 里真的有 search 事件」变红")
    if not patch(CHAT_LOOP, INJ_A_OLD, INJ_A_NEW, "chatLoop.ts toolChoice"):
        return 2
    if not build():
        unpatch(CHAT_LOOP, INJ_A_NEW, INJ_A_OLD)
        return 2
    p, f, text = run_e2e("S1")
    red = [x for x in failed_ids(text) if "真的有 search 事件" in x]
    results["injectA"] = (p, f, failed_ids(text))
    log(f"    → {p} PASS / {f} FAIL")
    for x in failed_ids(text):
        log(f"      {x}")
    log(f"    期望变红的那条：{'✓ 变红了' if red else '✗ 还是绿的 —— 断言是摆设！'}")
    inj_a_ok = bool(red)
    unpatch(CHAT_LOOP, INJ_A_NEW, INJ_A_OLD)
    log("    ✓ 已还原 chatLoop.ts")

    # ------------------------------------------------------------ ③ 注入 B
    log("\n[3] 注入 B：在聊天路径里注入一次 bindPageLoop（搜索轮也去 bind 页）")
    log("    期望：「S1 ★ 该搜索 → 没有制造任何浏览器侧状态」变红")
    if not patch(CHAT_ROUTE, INJ_B_ANCHOR, INJ_B_NEW, "chat.ts 搜索轮 bind 页"):
        return 2
    if not build():
        unpatch(CHAT_ROUTE, INJ_B_NEW, INJ_B_ANCHOR)
        return 2
    p, f, text = run_e2e("S1")
    red = [x for x in failed_ids(text) if "没有制造任何浏览器侧状态" in x]
    results["injectB"] = (p, f, failed_ids(text))
    log(f"    → {p} PASS / {f} FAIL")
    for x in failed_ids(text):
        log(f"      {x}")
    log(f"    期望变红的那条：{'✓ 变红了' if red else '✗ 还是绿的 —— 探针是摆设！'}")
    inj_b_ok = bool(red)
    unpatch(CHAT_ROUTE, INJ_B_NEW, INJ_B_ANCHOR)
    log("    ✓ 已还原 chat.ts")

    # ------------------------------------------------------------ ③ 注入 C
    log("\n[3.5] 注入 C：把服务端算出的来源改成空数组（不下发、也不落库）")
    log("     期望：来源相关的 5 条全变红")
    if not patch(CHAT_ROUTE, INJ_C_OLD, INJ_C_NEW, "chat.ts sources 清空"):
        return 2
    if not build():
        unpatch(CHAT_ROUTE, INJ_C_NEW, INJ_C_OLD)
        return 2
    p, f, text = run_e2e("S1")
    """
    ★ 阀值要**精确点名受本次注入影响的那几条**：
      注入只能让「来源为空」类断言变红；
      「N1 凭常识 → done 里没有来源」本来就是绿的，拿它去要求变红属于断言打错路径。
    """
    expect_red_c = [
        "★ 搜索轮 → done 事件带回了来源列表",
        "来源条目字段完整",
        "3.4 ★ 来源标注落库了",
        "3.5 ★ 库里读回的来源",
        "5.6 ★ 来源真的落进了库",
    ]
    red_lines = failed_ids(text)
    hit = [k for k in expect_red_c if any(k in x for x in red_lines)]
    results["injectC"] = (p, f, red_lines)
    log(f"    → {p} PASS / {f} FAIL")
    for x in red_lines:
        log(f"      {x}")
    inj_c_ok = len(hit) == len(expect_red_c)
    log(f"    受影响的来源断言：期望 {len(expect_red_c)} 条变红，实际 {len(hit)} 条 → "
        + ("✓ 全变红" if inj_c_ok else "✗ 没红 —— 断言是摆设！")
        + ("" if inj_c_ok else f"（缺：{[k for k in expect_red_c if k not in hit]}）"))
    unpatch(CHAT_ROUTE, INJ_C_NEW, INJ_C_OLD)
    log("    ✓ 已还原 chat.ts")

    # ------------------------------------------------------------ ④ 还原复核
    log("\n[4] 还原后复核 —— 期望 0 FAIL，且 sha256 与开工前一致")
    if not build():
        return 2
    after = {CHAT_LOOP: sha(CHAT_LOOP), CHAT_ROUTE: sha(CHAT_ROUTE)}
    same = all(before[p] == after[p] for p in before)
    for p in before:
        log(f"    {os.path.relpath(p, ROOT)}  {before[p][:16]} → {after[p][:16]}  "
            f"{'一致' if before[p] == after[p] else '★ 不一致'}")

    # 模型是非确定性的：还原后万一它没搜，会假红 —— 允许重试一次，并如实记录是第几次
    ok = False
    tries = 0
    for tries in range(1, 3):
        p, f, text = run_e2e("S1")
        log(f"    第 {tries} 次 → {p} PASS / {f} FAIL")
        if f == 0:
            ok = True
            break
        for x in failed_ids(text):
            log(f"      {x}")
    results["restore"] = (p, f, failed_ids(text))

    # ------------------------------------------------------------ 结论
    log("\n" + "=" * 72)
    log("结论")
    log("=" * 72)
    log(f"  ① 基线 0 FAIL                        : {'✓' if results['baseline'][1] == 0 else '✗'}")
    log(f"  ② 注入 A → 搜索断言变红               : {'✓' if inj_a_ok else '✗'}")
    log(f"  ③ 注入 B → pageStates 断言变红        : {'✓' if inj_b_ok else '✗'}")
    log(f"  ③.5 注入 C → 来源断言变红           : {'✓' if inj_c_ok else '✗'}")
    log(f"  ④ 还原 → 0 FAIL 且 sha256 一致        : {'✓' if ok and same else '✗'}"
        f"（第 {tries} 次跑绿，指纹{'一致' if same else '不一致'}）")
    verdict = inj_a_ok and inj_b_ok and inj_c_ok and ok and same and results["baseline"][1] == 0
    log(f"\n  反证{'成立 —— 这几条断言真的会因缺陷变红，不是摆设' if verdict else '★ 不成立，必须补强测试'}")

    write(LOG_PATH, "\n".join(lines) + "\n")
    log(f"\n日志：{LOG_PATH}")
    return 0 if verdict else 1


if __name__ == "__main__":
    sys.exit(main())
