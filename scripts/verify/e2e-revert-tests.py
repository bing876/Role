"""
反证：证明 run-task-e2e.py 新增的几条断言**不是摆设**。

★ 第一轮跑出来的教训（重要，别重蹈）：
  单纯"删掉某条断言"往往**测不出红** —— 因为被断言保护的那个坏条件当时**并不存在**
  （例：PG 已经恢复好了，所以就算不检查 migrate 也照样成功）。
  这不代表断言没用，而是**反证的手法不对**：必须把"缺陷注入"做成**复合注入**，
  即：不光删掉断言，还要**让被断言的那个坏情况真的发生**，
  才能验证"断言拦不拦得住"。这正是长期记忆里那条 ——
  「存在性 ≠ 正确性；测不出来 = 测试是摆设」，但**测不出来也可能是我没造出那个场景**。

每轮：注入 → 跑 → 立刻还原（把原文件写回）。

注入项（均为复合注入）：
  D1 不等库可用（跳过 1.5 步）
  D2 跳过等库 + 删掉 migrate 断言  → 逼出"库没就绪、migrate 失败"的真实场景
  D3 跳过等库 + 有 token 就跳过登录 → 逼出"登录态被清、界面是登录页"的真实场景
  D4 送达判据退回「看界面文案含『标题』」（不复合，靠文案误判即可复现）
  D5 发送按钮取 .inputBar 第一个（复合：先打乱按钮顺序假设，见下）

跑法：python scripts/verify/e2e-revert-tests.py
"""
import os
import re
import subprocess
import sys

ROOT = r"C:\Users\bing\workbuddy-ai\work123"
TARGET = os.path.join(ROOT, "scripts", "verify", "run-task-e2e.py")
PY = r"C:\Users\bing\.workbuddy-ai\binaries\python\envs\default\Scripts\python.exe"

lines = []


def log(*a):
    s = " ".join(str(x) for x in a)
    lines.append(s)
    print(s, flush=True)


src = open(TARGET, encoding="utf-8").read()


def run_e2e():
    r = subprocess.run([PY, TARGET], cwd=ROOT, capture_output=True,
                       text=True, encoding="utf-8", errors="replace", timeout=900)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def inject(name, mutate):
    broken = mutate(src)
    if broken is None:
        log(f"  ⚠ {name}: 注入点没找到，跳过")
        return None, "注入点没找到"
    open(TARGET, "w", encoding="utf-8").write(broken)
    try:
        code, out = run_e2e()
    finally:
        open(TARGET, "w", encoding="utf-8").write(src)  # 立刻还原
    red = (code != 0) or ("★" in out)
    fails = [l.strip() for l in out.splitlines() if "★" in l]
    return red, (fails[0] if fails else "(无 ★，退出码 %d)" % code)[:200]


# ── 复用的两个"破坏前置条件"片段 ──────────────────────────────
SKIP_WAIT = ('log("=== [注入] 跳过等库可用 ===")\n\n')


def drop_wait(s):
    """把 1.5 步（等库真正可用）整段删掉"""
    needle = 'log("=== 第 1.5 步：等库真正可用（不只是端口通）===")'
    if needle not in s:
        return None
    i = s.index(needle)
    j = s.index("# 建 workbench 库", i)
    return s[:i] + SKIP_WAIT + s[j:]


def d1(s):
    """只跳过等库 —— 若 PG 已就绪就测不出红（第一轮就是这样）"""
    return drop_wait(s)


def d2(s):
    """复合：跳过等库 + 删掉 migrate 断言 → 逼出"库没就绪、migrate 失败"的场景"""
    s2 = drop_wait(s)
    if s2 is None:
        return None
    needle = 'if "数据库表就绪" not in srv_txt:'
    if needle not in s2:
        return None
    i = s2.index(needle)
    j = s2.index("# 再直连核一次关键表真的在", i)
    return s2[:i] + "pass  # [注入] 不检查 migrate\n\n" + s2[j:]


def d3(s):
    """复合：跳过等库 + 登录判定退回"有 token 就跳过" → 逼出"界面停在登录页"的场景"""
    s2 = drop_wait(s)
    if s2 is None:
        return None
    pat = re.compile(r'if not main_ui_ready\(timeout=20\):.*?\n(    log\("  手机号:", phone\))', re.S)
    m = pat.search(s2)
    if not m:
        return None
    return s2[:m.start()] + ('if not c.js("!!localStorage.getItem(\'workbench.token\')"):\n'
                             + m.group(1)) + s2[m.end():]


def d4(s):
    """送达判据退回"看界面文案" —— 用户指令里本来就有"标题"二字"""
    if "if lc > base_llm or ll > 0:" not in s:
        return None
    return s.replace("if lc > base_llm or ll > 0:",
                     "if False:  # [注入] 不用服务端计数判送达", 1).replace(
        "if delivered and lc >= base_llm + 2 and ll == 0 and i >= 2:",
        'if "标题" in txt:  # [注入] 退回看文案', 1)


def d5(s):
    """复合：把发送按钮选择改成"取第一个 button"，**并同时在前面插一个干扰按钮**。

    ★ 为什么必须复合：inputBar 里按钮顺序恰好是 [发送, 结束]，
      所以"取第一个"**碰巧是对的** —— 单删不改会得出"断言无效"的错误结论。
      真正要验的是："当发送按钮不在第一位时，断言拦不拦得住"。
      这里通过在 DOM 上人为前插一个按钮来构造那个条件。
    """
    pat = re.compile(
        r"const bs=Array\.from\(document\.querySelectorAll\('\.inputBar button'\)\);\s*\n"
        r"\s*const b=bs\.find\(x=>/发送\|发\\\\s\*送/\.test\(x\.innerText\|\|''\)\);")
    m = pat.search(s)
    if not m:
        return None
    # 注入 1：改成取第一个；注入 2：在 sleep 前插一个干扰按钮，让"第一个"不再是发送
    injected = ("const bs=Array.from(document.querySelectorAll('.inputBar button'));\n"
                " const b=bs[0];  // [注入] 取第一个")
    s2 = s[:m.start()] + injected + s[m.end():]
    # 在点击之前插入干扰按钮
    anchor = " 点发送"  # 用日志文案定位 nearby 不可靠，改用 send_res 赋值行
    anchor = "send_res = c.js("
    if anchor not in s2:
        return None
    s2 = s2.replace(anchor,
                    "c.js(\"(()=>{const bar=document.querySelector('.inputBar');"
                    "const fake=document.createElement('button');fake.innerText='结束';"
                    "bar.insertBefore(fake, bar.firstChild);return 'INJECTED';})()\")\n"
                    + anchor, 1)
    return s2


for name, fn in [
    ("D1 不等库可用（单缺陷）", d1),
    ("D2 不等库 + 不检查 migrate（复合）", d2),
    ("D3 不等库 + 有 token 就跳过登录（复合）", d3),
    ("D4 送达判据退回看文案", d4),
    ("D5 发送按钮取第一个（复合：前插干扰按钮）", d5),
]:
    log(f"--- {name} ---")
    red, tail = inject(name, fn)
    if red is None:
        log(f"    跳过：{tail}")
    else:
        log(f"    {'✓ 变红（断言有效）' if red else '✗ 仍然全绿（断言是摆设！）'}")
        log(f"      {tail}")

log("")
log("=== 反证汇总 ===")
log(f"  见上。判据：注入缺陷后必须出现 ★ 或以非 0 退出。")

with open(os.path.join(ROOT, "docs", "acceptance", "root-cause", "e2e-revert.log"),
          "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
log("日志 -> docs/acceptance/root-cause/e2e-revert.log")

