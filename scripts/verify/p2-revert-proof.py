"""P1 批次（#3 / #4 / #5）反证：把修复改回旧写法，验证断言真的会变红。

## 为什么必须做
如果改回旧代码后断言照样全绿，说明这些断言根本没在检查东西（测的是摆设）。
只有"坏条件一注入就变红"才能证明断言有区分对错的能力。

## 三条注入
  A —— #3 把形状闸关掉（`validateBrowserAction` 对非对象直接放行）
       预期变红：`drive(null)` 等畸形入参**抛异常**（旧行为），断言"没有抛异常"失败
  B —— #4 退回旧写法（容量维护不跑 + 重复 IP 分支里 `clear()` 整表清空）
       预期变红：扫描让表无限涨 / 撑满表后攻击者重新拿到额度 / 过期条目不清理
  C —— #5 退回"先 SELECT 判 used，再 UPDATE"的非原子消费
       预期变红：**并发提交同一个验证码会成功多次**（这就是 TOCTOU 本身）

## 一个进程跑完
本机 agent 沙箱在工具调用结束时回收派生进程 —— "上一步起环境、下一步跑断言"必然失败。
所以这里在**同一个进程**里：起一次 PG → 依次跑三条（各自 基线→注入→还原）。

用法： python scripts/verify/p2-revert-proof.py
"""
import os
import re
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUTDIR = os.path.join(REPO, "docs", "acceptance", "p1-fix")
os.makedirs(OUTDIR, exist_ok=True)

DRIVER_TS = os.path.join(REPO, "apps", "desktop", "electron", "driver.ts")
AUTH_TS = os.path.join(REPO, "apps", "server", "src", "routes", "auth.ts")

PY = sys.executable
NODE = "node"


# --------------------------------------------------------------------------- #
def build_server():
    r = subprocess.run(["npm", "run", "build", "-w", "@ai-workbench/server"], cwd=REPO,
                       shell=True, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=300)
    if r.returncode != 0:
        print("    [!!] server 构建失败:", (r.stdout or "")[-500:])
        return False
    return True


def build_electron():
    r = subprocess.run(["npm", "run", "build:electron", "-w", "@ai-workbench/desktop"], cwd=REPO,
                       shell=True, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=300)
    if r.returncode != 0:
        print("    [!!] electron 构建失败:", (r.stdout or "")[-500:])
        return False
    return True


def run_probe(cmd, tag, cwd=None, timeout=900):
    log = os.path.join(OUTDIR, "p2-revert-%s.log" % tag)
    # ★ 必须走 shell：Windows 上 `npx` 其实是 `npx.cmd`，
    #   直接 CreateProcess 会报 WinError 2（"系统找不到指定的文件"）。
    #   用 list2cmdline 拼命令行，路径里的空格会被正确加引号。
    cmdline = subprocess.list2cmdline([str(c) for c in cmd])
    with open(log, "w", encoding="utf-8", errors="replace") as f:
        subprocess.run(cmdline, shell=True, cwd=cwd or REPO, stdout=f,
                       stderr=subprocess.STDOUT, timeout=timeout)
    txt = open(log, encoding="utf-8", errors="replace").read()
    m = re.search(r"结果：(\d+) 条断言，(\d+) 条失败", txt)
    fails = re.findall(r"^\s*✗\s+(.+)$", txt, re.M)
    n = int(m.group(1)) if m else -1
    f = int(m.group(2)) if m else -1
    print("    [result] %s 条断言 / %s 条失败" % (n, f))
    if n < 0:
        print("    [!!] 没解析到结果行，日志尾部：")
        for line in txt.strip().splitlines()[-8:]:
            print("        |", line)
    for x in fails:
        print("        ✗", x.strip())
    return n, f, fails, txt


def patch(path, pairs, direction="inject"):
    pairs = [(a, b) if direction == "inject" else (b, a) for a, b in pairs]
    src = open(path, encoding="utf-8").read()
    for old, new in pairs:
        if old not in src:
            print("    [!!] 找不到片段（%s）：%s" % (os.path.basename(path), old[:70]))
            return False
        src = src.replace(old, new, 1)
        print("    [patch] %s :: %s" % (os.path.basename(path), old.strip().splitlines()[0][:58]))
    open(path, "w", encoding="utf-8").write(src)
    return True


# --------------------------------------------------------------------------- #
# 注入对
# --------------------------------------------------------------------------- #
INJ_3 = [(
    "  if (!isPlainObject(raw)) return bad(`动作必须是一个对象（收到 ${typeOf(raw)}）`);",
    "  if (!isPlainObject(raw)) return { ok: true, action: raw as unknown as BrowserAction };",
)]

INJ_4 = [
    # 关掉容量维护（旧代码里它只在"同 IP 第 2 次以后"才可能跑到）
    ("      if (hits.size > softCap) {\n        // ① 过期的先清",
     "      if (false) {\n        // ① 过期的先清"),
    # 把旧的"整表 clear"放回重复 IP 的分支里
    ("      hit.count += 1;\n      return hit.count > maxPerMinute;",
     "      hit.count += 1;\n      if (hits.size > softCap) hits.clear();\n      return hit.count > maxPerMinute;"),
]

INJ_5 = [(
    """      const consumed = await pool.query(
        `UPDATE sms_codes SET used = true
          WHERE id = $1 AND used = false AND attempts < $2 AND expires_at > now()
          RETURNING id`,
        [c.rows[0].id, VERIFY_MAX_ATTEMPTS],
      );
      if (consumed.rowCount !== 1) {
        return reply.code(401).send({ error: '验证码不对或已失效（错 5 次作废，可重新获取）' });
      }""",
    "      await pool.query('UPDATE sms_codes SET used = true WHERE id = $1', [c.rows[0].id]);",
)]


def ensure_pg():
    pg_home = os.path.join(os.path.expanduser("~"), "workbuddy-ai", "pg2")
    bin_dir = os.path.join(pg_home, "pg", "bin")
    data_dir = os.path.join(pg_home, "data")
    pid_file = os.path.join(data_dir, "postmaster.pid")
    subprocess.run(["taskkill", "/F", "/IM", "postgres.exe"], capture_output=True,
                   text=True, encoding="utf-8", errors="replace", timeout=30)
    time.sleep(3)
    if os.path.exists(pid_file):
        try:
            os.remove(pid_file)
        except Exception:
            pass
    launcher = os.path.join(pg_home, "_boot.cmd")
    with open(launcher, "w", encoding="gbk", errors="replace") as f:
        f.write("\r\n".join([
            "@echo off", "chcp 936 >nul",
            'start "" /B "%s" -D "%s"' % (os.path.join(bin_dir, "postgres.exe"), data_dir),
        ]) + "\r\n")
    subprocess.run(["cmd", "/c", launcher], stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=30)
    probe = ("const{Client}=require('pg');const c=new Client({connectionString:"
             "'postgresql://workbench:workbench@127.0.0.1:5432/workbench'});"
             "c.connect().then(()=>c.query('select 1')).then(()=>{console.log('QUERY_OK');"
             "return c.end()}).catch(e=>{console.log('ERR:'+(e.code||e.message));"
             "return c.end().catch(()=>{})})")
    end = time.time() + 300
    while time.time() < end:
        try:
            r = subprocess.run([NODE, "-e", probe], cwd=os.path.join(REPO, "apps", "server"),
                               capture_output=True, text=True, encoding="utf-8",
                               errors="replace", timeout=25)
            last = (r.stdout or "").strip()
        except Exception as e:
            last = "EXC:%s" % e
        if last == "QUERY_OK":
            print("  [pg] 数据库可查询 ✔")
            return True
        time.sleep(5)
    return False


def main():
    print("=" * 70)
    print("P1 批次（#3/#4/#5）反证")
    print("=" * 70)

    orig3 = open(DRIVER_TS, encoding="utf-8").read()
    orig4 = open(AUTH_TS, encoding="utf-8").read()
    verdicts = {}

    try:
        # ================= #3 =================
        print("\n########## #3 动作形状闸 ##########")
        print("\n[#3 基线]")
        if not build_electron():
            return 1
        n, f, _, _ = run_probe(
            ["npx", "electron", os.path.join(HERE, "drive-shape-probe.mjs"), "--no-sandbox"],
            "3-baseline", cwd=os.path.join(REPO, "apps", "desktop"), timeout=300)
        verdicts["3-base"] = (n, f)

        print("\n[#3 注入] 关掉形状闸")
        if not patch(DRIVER_TS, INJ_3) or not build_electron():
            return 1
        n, f, fails, _ = run_probe(
            ["npx", "electron", os.path.join(HERE, "drive-shape-probe.mjs"), "--no-sandbox"],
            "3-injected", cwd=os.path.join(REPO, "apps", "desktop"), timeout=300)
        verdicts["3-inj"] = (n, f, fails)

        print("\n[#3 还原]")
        open(DRIVER_TS, "w", encoding="utf-8").write(orig3)
        build_electron()
        n, f, _, _ = run_probe(
            ["npx", "electron", os.path.join(HERE, "drive-shape-probe.mjs"), "--no-sandbox"],
            "3-restored", cwd=os.path.join(REPO, "apps", "desktop"), timeout=300)
        verdicts["3-res"] = (n, f)

        # ================= #4 =================
        print("\n########## #4 IP 限流 ##########")
        print("\n[#4 基线]")
        if not build_server():
            return 1
        n, f, _, _ = run_probe([NODE, os.path.join(HERE, "ip-rate-probe.mjs")], "4-baseline", timeout=180)
        verdicts["4-base"] = (n, f)

        print("\n[#4 注入] 退回旧写法（不维护 + 整表 clear）")
        if not patch(AUTH_TS, INJ_4) or not build_server():
            return 1
        n, f, fails, _ = run_probe([NODE, os.path.join(HERE, "ip-rate-probe.mjs")], "4-injected", timeout=180)
        verdicts["4-inj"] = (n, f, fails)

        print("\n[#4 还原]")
        open(AUTH_TS, "w", encoding="utf-8").write(orig4)
        build_server()
        n, f, _, _ = run_probe([NODE, os.path.join(HERE, "ip-rate-probe.mjs")], "4-restored", timeout=180)
        verdicts["4-res"] = (n, f)

        # ================= #5 =================
        print("\n########## #5 验证码原子消费 ##########")
        print("\n[#5 起数据库]")
        if not ensure_pg():
            print("  !! 数据库起不来，跳过 #5")
            verdicts["5-skip"] = (0, 0, [])
        else:
            print("\n[#5 基线]")
            n, f, _, _ = run_probe(
                [PY, "-u", os.path.join(HERE, "sms-code-race-probe.py")], "5-baseline", timeout=900)
            verdicts["5-base"] = (n, f)

            print("\n[#5 注入] 退回非原子消费")
            if not patch(AUTH_TS, INJ_5) or not build_server():
                return 1
            n, f, fails, _ = run_probe(
                [PY, "-u", os.path.join(HERE, "sms-code-race-probe.py")], "5-injected", timeout=900)
            verdicts["5-inj"] = (n, f, fails)

            print("\n[#4/#5 还原]")
            open(AUTH_TS, "w", encoding="utf-8").write(orig4)
            build_server()
            n, f, _, _ = run_probe(
                [PY, "-u", os.path.join(HERE, "sms-code-race-probe.py")], "5-restored", timeout=900)
            verdicts["5-res"] = (n, f)

    finally:
        # 无论成败都必须把源码还原干净，绝不能留下注入过的代码
        open(DRIVER_TS, "w", encoding="utf-8").write(orig3)
        open(AUTH_TS, "w", encoding="utf-8").write(orig4)
        print("\n[finally] 已强制还原两个源文件")
        build_server()
        build_electron()

    # ================= 判定 =================
    print("\n" + "=" * 70)
    print("反证判定")
    print("=" * 70)
    ok = True

    def show(tag, label):
        nonlocal ok
        v = verdicts.get(tag)
        if v is None:
            print("%-28s: （未跑）" % label)
            return None
        print("%-28s: %d 条断言 / %d 条失败" % (label, v[0], v[1]))
        return v

    def hit(fails_list, *keywords):
        """在失败标签里找关键词。

        ★ 先把标签里的 `*` 去掉再比 —— 断言文案里带了 `★`/`**` 这类标记，
          直接拿原字符串做子串匹配很容易因为多一个星号就漏判
          （第一版就是这么漏的：明明变红了，判定却说"没命中"）。
        """
        plain = [x.replace('*', '') for x in fails_list]
        return any(all(k in p for k in keywords) for p in plain)

    b3 = show("3-base", "#3 基线")
    i3 = show("3-inj", "#3 注入（关掉闸）")
    r3 = show("3-res", "#3 还原后")
    if b3 and i3 and r3:
        h = hit(i3[2], "没有抛异常")
        print("   命中「畸形入参抛异常」:", h)
        ok &= (b3[1] == 0 and i3[1] > 0 and h and r3[1] == 0)

    b4 = show("4-base", "#4 基线")
    i4 = show("4-inj", "#4 注入（旧写法）")
    r4 = show("4-res", "#4 还原后")
    if b4 and i4 and r4:
        h1 = hit(i4[2], "攻击者", "限流")
        h2 = hit(i4[2], "表无限涨")
        h3 = hit(i4[2], "过期")
        print("   命中「攻击者被 clear 放掉」:", h1)
        print("   命中「扫描让表无限涨」:", h2)
        print("   命中「过期条目没被优先清理」:", h3)
        ok &= (b4[1] == 0 and i4[1] > 0 and h1 and h2 and r4[1] == 0)

    if "5-base" in verdicts:
        b5 = show("5-base", "#5 基线")
        i5 = show("5-inj", "#5 注入（非原子）")
        r5 = show("5-res", "#5 还原后")
        if b5 and i5 and r5:
            h = hit(i5[2], "恰好 1 次成功")
            h_lock = hit(i5[2], "锁竞争")
            print("   命中「并发下成功多次」:", h)
            print("   命中「锁竞争下成功多次」:", h_lock)
            ok &= (b5[1] == 0 and i5[1] > 0 and h and r5[1] == 0)

    print("\n结论：", "反证成立 ✔ 断言有效且修复可逆" if ok else "反证不成立 ✗ 需补强断言")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
