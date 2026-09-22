"""反证：把修复**改回旧写法**，验证断言真的会变红。

## 为什么必须做
如果改回旧代码后断言照样全绿，说明这些断言根本没在检查东西（测的是摆设）。
只有"坏条件一注入就变红"才能证明断言有区分对错的能力。

## 为什么整个流程必须在**一个进程**里跑完
本机 agent 沙箱会在每次工具调用结束时回收该调用派生的所有子进程
（postgres / 服务端 / 假模型全都会被收走）。
所以"这次起环境、下次跑断言"必然失败。本脚本因此：
  · 只在开头把 PostgreSQL 拉起来**一次**；
  · 之后每轮注入只做「重新构建 → 重启服务端 → 跑断言」，不再碰数据库。

## 三轮注入
  A —— #1 校验退回旧写法（`Number.isInteger` 当前置条件）
       预期变红：②「不传 agentId → 409」
  B —— #8 的 `resumable` 退回「只看 hasLoop」
       预期变红：⑦「已停止 → resumable=false」
  最后恢复源码，确认回到全绿。

用法：
    python scripts/verify/p1-revert-proof.py
"""
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUTDIR = os.path.join(REPO, "docs", "acceptance", "p1-fix")
LOOP_TS = os.path.join(REPO, "apps", "server", "src", "routes", "loop.ts")
SERVER_DIR = os.path.join(REPO, "apps", "server")
os.makedirs(OUTDIR, exist_ok=True)

NODE = "node"
API_PORT = int(os.environ.get("P1_API_PORT", "8794"))
FAKE_PORT = int(os.environ.get("P1_FAKE_PORT", "8894"))
API = "http://127.0.0.1:%d" % API_PORT
FAKE = "http://127.0.0.1:%d" % FAKE_PORT
SERVER_LOG = os.path.join(OUTDIR, "revert-server.log")

PROCS = {}


# --------------------------------------------------------------------------- #
# 基础设施
# --------------------------------------------------------------------------- #
def pid_alive(pid):
    try:
        out = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/NH", "/FO", "CSV"],
                             capture_output=True, text=True, encoding="utf-8",
                             errors="replace", timeout=15).stdout
        return ('"%d"' % pid) in out
    except Exception:
        return False


def port_busy(port, host="127.0.0.1", timeout=1.5):
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def ensure_pg():
    """拉起 PostgreSQL 并等到**真能查表**（崩溃恢复期端口会先通、查询报 57P03）。"""
    pg_home = os.path.join(os.path.expanduser("~"), "workbuddy-ai", "pg2")
    bin_dir = os.path.join(pg_home, "pg", "bin")
    data_dir = os.path.join(pg_home, "data")
    pid_file = os.path.join(data_dir, "postmaster.pid")

    if os.path.exists(pid_file):
        try:
            old = int(open(pid_file, encoding="utf-8", errors="replace").read().splitlines()[0].strip())
            if not pid_alive(old):
                os.remove(pid_file)
                print("  [pg] 清掉残留 pid（PID %d 已死）" % old)
            else:
                print("  [pg] PID %d 还活着" % old)
        except Exception:
            try:
                os.remove(pid_file)
            except Exception:
                pass

    if not port_busy(5432):
        launcher = os.path.join(pg_home, "_boot.cmd")
        with open(launcher, "w", encoding="gbk", errors="replace") as f:
            f.write("\r\n".join([
                "@echo off", "chcp 936 >nul",
                'start "" /B "%s" -D "%s"' % (os.path.join(bin_dir, "postgres.exe"), data_dir),
            ]) + "\r\n")
        # 不能用 capture_output —— postgres 会继承管道并一直持有，导致永久挂住
        subprocess.run(["cmd", "/c", launcher], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=30)
        print("  [pg] 已发出启动命令")

    probe = ("const{Client}=require('pg');const c=new Client({connectionString:"
             "'postgresql://workbench:workbench@127.0.0.1:5432/workbench'});"
             "c.connect().then(()=>c.query('select 1')).then(()=>{console.log('QUERY_OK');"
             "return c.end()}).catch(e=>{console.log('ERR:'+(e.code||e.message));"
             "return c.end().catch(()=>{})})")
    end = time.time() + 240
    while time.time() < end:
        try:
            r = subprocess.run([NODE, "-e", probe], cwd=SERVER_DIR, capture_output=True,
                               text=True, encoding="utf-8", errors="replace", timeout=25)
            last = (r.stdout or "").strip()
        except Exception as e:
            last = "EXC:%s" % e
        if last == "QUERY_OK":
            print("  [pg] 数据库可查询 ✔")
            return True
        print("  [pg] 等待恢复…", last[:50])
        time.sleep(6)
    print("  [pg] 超时未就绪")
    return False


def build_server():
    r = subprocess.run(["npm", "run", "build", "-w", "@ai-workbench/server"], cwd=REPO,
                       shell=True, capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=300)
    if r.returncode != 0:
        print("    [!!] 构建失败:", (r.stdout or "")[-500:], (r.stderr or "")[-300:])
        return False
    return True


def start_server():
    if "server" in PROCS and PROCS["server"].poll() is None:
        PROCS["server"].terminate()
        try:
            PROCS["server"].wait(timeout=10)
        except Exception:
            PROCS["server"].kill()
    f = open(SERVER_LOG, "a", encoding="utf-8", errors="replace")
    f.write("\n===== 重启服务端 @ %s =====\n" % time.strftime("%H:%M:%S"))
    f.flush()
    PROCS["server"] = subprocess.Popen(
        [NODE, "dist/index.js"], cwd=SERVER_DIR,
        env={**os.environ, "PORT": str(API_PORT), "DEEPSEEK_BASE_URL": FAKE,
             "DEEPSEEK_API_KEY": "fake-p1", "DEEPSEEK_MODEL": "fake-p1"},
        stdout=f, stderr=subprocess.STDOUT)
    end = time.time() + 60
    while time.time() < end:
        st, body = http("GET", API + "/health", timeout=4)
        if st == 200 and body.get("db") == "up":
            return True
        time.sleep(1.5)
    return False


def start_fake():
    f = open(os.path.join(OUTDIR, "revert-llm.log"), "a", encoding="utf-8", errors="replace")
    PROCS["fake"] = subprocess.Popen(
        [NODE, os.path.join(HERE, "fake-llm.mjs")], cwd=REPO,
        env={**os.environ, "FAKE_PORT": str(FAKE_PORT), "FAKE_DELAY_MS": "50", "FAKE_STEPS": "2"},
        stdout=f, stderr=subprocess.STDOUT)
    time.sleep(1.5)


def cleanup():
    for k in ("server", "fake"):
        p = PROCS.get(k)
        if p and p.poll() is None:
            try:
                p.terminate()
                p.wait(timeout=8)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass


# --------------------------------------------------------------------------- #
# HTTP / 断言
# --------------------------------------------------------------------------- #
def http(method, url, body=None, token=None, timeout=20):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    if token:
        req.add_header("authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw or "{}")
        except Exception:
            return e.code, {"raw": raw}
    except Exception as e:
        return 0, {"error": str(e)}


def login(phone):
    st, b = http("POST", API + "/auth/sms/send", {"phone": phone})
    if st != 200:
        print("    sms/send 失败:", st, b)
        return None
    code = None
    end = time.time() + 25
    while time.time() < end and not code:
        try:
            txt = open(SERVER_LOG, encoding="utf-8", errors="replace").read()
        except Exception:
            txt = ""
        for line in reversed(txt.splitlines()):
            if "[sms:mock]" in line and "验证码" in line:
                m = re.search(r"验证码\s*(\d{6})", line)
                if m:
                    code = m.group(1)
                    break
        if not code:
            time.sleep(1.5)
    if not code:
        print("    取不到验证码")
        return None
    st, b = http("POST", API + "/auth/login/sms", {"phone": phone, "code": code})
    if st != 200:
        print("    login/sms 失败:", st, b)
        return None
    return b.get("token") or b.get("session", {}).get("token")


def run_assertions(tag, phone):
    """跑一轮完整断言，返回 (总数, 失败列表)。"""
    fails, total = [], 0

    def chk(cond, label, detail=""):
        nonlocal total
        total += 1
        if not cond:
            fails.append(label)
            print("      ✗ %s   %s" % (label, detail))
        return cond

    token = login(phone)
    if not chk(bool(token), "拿到登录凭证"):
        return total, fails

    st, b = http("GET", API + "/agents", token=token)
    agents = (b.get("agents") or []) if st == 200 else []
    if not chk(len(agents) >= 1, "账号下有智能体"):
        return total, fails
    AG = agents[0]["id"]
    WC = 77

    st, b = http("POST", API + "/agent/loop/start",
                 {"goal": "反证用循环", "agentId": AG, "wcId": WC, "state": {}}, token)
    if not chk(st == 200 and b.get("loopId"), "建循环成功", "%s %s" % (st, b)):
        return total, fails
    loop_id = b["loopId"]

    # ① 传对 → 200
    st, _ = http("POST", API + "/agent/loop/next",
                 {"loopId": loop_id, "agentId": AG, "wcId": WC, "result": {"ok": True, "detail": "x"}}, token)
    chk(st == 200, "① 传对 → 200", "实际 %s" % st)

    # ② ★ 只不传 agentId（wcId 传对）→ 期望 409 agent_mismatch
    #    ★★ 为什么必须把 wcId 传对：两个闸门是**冗余**的，全不传的话
    #       wcId 那道闸也会拦住，于是"agentId 这道闸有没有失效"根本看不出来
    #       （第一版就是这么写的，反证时才发现它区分不出新旧代码 —— 见报告）。
    #       把 wcId 传对，才只剩 agentId 一道闸在守，漏洞才暴露得出来。
    st, b2 = http("POST", API + "/agent/loop/next",
                  {"loopId": loop_id, "wcId": WC, "result": {"ok": True, "detail": "x"}}, token)
    chk(st == 409, "② 不传 agentId → 409", "实际 %s %s" % (st, json.dumps(b2, ensure_ascii=False)[:90]))
    chk(b2.get("code") == "agent_mismatch", "② 错因是 agent_mismatch（不是被 wcId 那道闸代拦）",
        "code=%s" % b2.get("code"))

    # ②b 只不传 wcId（agentId 传对）→ 期望 409 page_mismatch（wcId 那道闸也要单独验）
    st, b2b = http("POST", API + "/agent/loop/next",
                   {"loopId": loop_id, "agentId": AG, "result": {"ok": True}}, token)
    chk(st == 409, "②b 不传 wcId → 409", "实际 %s" % st)
    chk(b2b.get("code") == "page_mismatch", "②b 错因是 page_mismatch", "code=%s" % b2b.get("code"))

    # ③ 传错 → 409
    st, _ = http("POST", API + "/agent/loop/next",
                 {"loopId": loop_id, "agentId": 999999, "wcId": WC, "result": {"ok": True}}, token)
    chk(st == 409, "③ 传错 agentId → 409", "实际 %s" % st)

    # ④ 传 null → 409
    st, _ = http("POST", API + "/agent/loop/next",
                 {"loopId": loop_id, "agentId": None, "wcId": None, "result": {"ok": True}}, token)
    chk(st == 409, "④ 传 null → 409", "实际 %s" % st)

    # ⑥ 挂起 → inMemory=true 且 resumable=true
    st_p, b_p = http("POST", API + "/agent/loop/pause", {"loopId": loop_id, "pausedBy": "user"}, token)
    st, b = http("GET", API + "/agent/loop/pauses?loopId=" + loop_id, token=token)
    recs = b.get("records") or []
    if chk(len(recs) >= 1, "能查到暂停记录", "pause=%s %s" % (st_p, json.dumps(b_p, ensure_ascii=False)[:100])):
        r = recs[0]
        chk(r.get("inMemory") is True, "⑥ 挂起中 → inMemory=true", "实际 %s" % r.get("inMemory"))
        chk(r.get("resumable") is True, "⑥ 挂起中 → resumable=true", "实际 %s" % r.get("resumable"))

    # ⑦ 停止 → resumable=false（★ 注入 B 要打红的就是这条）
    http("POST", API + "/agent/loop/stop", {"loopId": loop_id}, token)
    time.sleep(0.8)
    st, b = http("GET", API + "/agent/loop/pauses?loopId=" + loop_id, token=token)
    recs2 = b.get("records") or []
    if chk(len(recs2) >= 1, "停止后仍能查到记录"):
        r2 = recs2[0]
        chk(r2.get("resumable") is False, "⑦ 已停止 → resumable=false",
            "实际 %s —— 若为 true 说明把'点了没反应'的按钮放出去了" % r2.get("resumable"))
        chk(r2.get("inMemory") is True, "⑦ 已停止但仍在内存 → inMemory=true",
            "实际 %s" % r2.get("inMemory"))

    return total, fails


# --------------------------------------------------------------------------- #
# 注入
# --------------------------------------------------------------------------- #
INJ_A = [
    ("if (session.agentId !== null && agentIdRaw !== session.agentId) {",
     "if (session.agentId !== null && Number.isInteger(agentIdRaw) && agentIdRaw !== session.agentId) {"),
    ("if (session.wcId !== null && wcIdRaw !== session.wcId) {",
     "if (session.wcId !== null && Number.isInteger(wcIdRaw) && wcIdRaw !== session.wcId) {"),
]
INJ_B = [("resumable: hasLoop(x.loop_id) && isLoopPaused(x.loop_id),",
          "resumable: hasLoop(x.loop_id),")]


def patch(pairs, direction):
    pairs = [(a, b) if direction == "inject" else (b, a) for a, b in pairs]
    for old, new in pairs:
        src = open(LOOP_TS, encoding="utf-8").read()
        if old not in src:
            print("    [!!] 找不到片段:", old[:60])
            return False
        open(LOOP_TS, "w", encoding="utf-8").write(src.replace(old, new, 1))
        print("    [patch] %s" % old[:56])
    return True


def main():
    print("=" * 70)
    print("第一批修复 · 反证（注入坏条件 → 断言必须变红）")
    print("=" * 70)

    original = open(LOOP_TS, encoding="utf-8").read()

    # ★ 开工前先自检：源码必须是**修复后**的形态。
    #   踩过 —— 上一次反证被中途杀掉，finally 没跑完，源码留在"已注入"状态；
    #   下一次跑就把注入态当成了基线，整轮结论全错（而且看起来还很像成功）。
    #   这几个 token 就是"修复已生效"的指纹，缺任何一个都直接拒绝开工。
    fingerprints = [
        "agentIdRaw !== session.agentId",
        "wcIdRaw !== session.wcId",
        "resumable: hasLoop(x.loop_id) && isLoopPaused(x.loop_id),",
    ]
    missing = [t for t in fingerprints if t not in original]
    if missing:
        print("!! 源码不是修复后的形态，拒绝开工（可能上次反证被中途杀掉）")
        for t in missing:
            print("   缺失指纹:", t)
        print("   请先把 apps/server/src/routes/loop.ts 恢复成修复版再跑。")
        return 2

    results = {}
    try:
        print("\n[1] 起环境（只起一次）")
        if not ensure_pg():
            return 1
        start_fake()
        if not build_server() or not start_server():
            print("  !! 服务端没起来")
            return 1
        print("  环境就绪")

        # 手机号必须是 **11 位**（1[3-9] 开头）—— 每轮换一个新号，
        # 避免上一轮的循环/暂停记录串到下一轮（那会让失败归因变得不可信）。
        rounds = [
            ("baseline", None, "18100000001"),
            ("inj-A", INJ_A, "18100000002"),
            ("restored-1", None, "18100000003"),
            ("inj-B", INJ_B, "18100000004"),
            ("restored-2", None, "18100000005"),
        ]

        for tag, inj, phone in rounds:
            print("\n[%s]" % tag)
            if inj is not None:
                if not patch(inj, "inject"):
                    return 1
            elif tag.startswith("restored"):
                open(LOOP_TS, "w", encoding="utf-8").write(original)
                print("    [restore] 已还原源码")
            if inj is not None or tag.startswith("restored"):
                if not build_server():
                    return 1
            if not start_server():
                print("  !! 服务端重启失败")
                return 1
            t, f = run_assertions(tag, phone)
            results[tag] = (t, f)
            print("    结果：%d 条断言 / %d 条失败" % (t, len(f)))
            for x in f:
                print("      ✗", x)
    finally:
        open(LOOP_TS, "w", encoding="utf-8").write(original)
        build_server()
        cleanup()

    print("\n" + "=" * 70)
    print("反证判定")
    print("=" * 70)
    ok = True
    b = results.get("baseline", (0, ["?"]))
    print("基线失败数            :", len(b[1]), "（期望 0）")
    ok &= len(b[1]) == 0

    a = results.get("inj-A", (0, []))
    a_hit = any("不传 agentId → 409" in x for x in a[1])
    a_hit_b = any("不传 wcId → 409" in x for x in a[1])
    print("注入 A（#1 两道闸都退回旧写法）失败数:", len(a[1]), "（期望 >0）")
    print("   命中「不传 agentId → 409」:", a_hit)
    print("   命中「不传 wcId → 409」   :", a_hit_b)
    ok &= (len(a[1]) > 0 and a_hit and a_hit_b)

    r1 = results.get("restored-1", (0, ["?"]))
    print("还原后失败数          :", len(r1[1]), "（期望回到 0）")
    ok &= len(r1[1]) == 0

    bb = results.get("inj-B", (0, []))
    b_hit = any("resumable=false" in x for x in bb[1])
    print("注入 B（resumable 只看 hasLoop）失败数:", len(bb[1]), "（期望 >0）")
    print("   命中「resumable=false」:", b_hit)
    ok &= (len(bb[1]) > 0 and b_hit)

    r2 = results.get("restored-2", (0, ["?"]))
    print("最终还原失败数        :", len(r2[1]), "（期望 0）")
    ok &= len(r2[1]) == 0

    print("\n结论：", "反证成立 ✔ 断言有效且修复可逆" if ok else "反证不成立 ✗ 需补强断言")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
