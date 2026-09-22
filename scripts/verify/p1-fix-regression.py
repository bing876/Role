"""第一批修复的定向回归（#1 循环归属硬闸 + #8 循环存活字段）。

它**自己起一套独立环境**（独立端口 8794 / 独立库 schema 不必要——只用 HTTP 层），
不依赖任何手工预置，跑完自己收干净。用法：

    C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe \
        scripts/verify/p1-fix-regression.py

## 为什么这么设计（先说清楚"测的是什么"）

#1 的 bug 形态很特殊：**它只在"调用方不传参数"时才暴露**。
正常调用（桌面端 `main.ts` 那一路）永远显式传 agentId + wcId，所以
「正常路径」无论如何都测不出 bug —— 必须**故意不传 / 传错**才能区分对错。
所以本脚本的核心是四组对照：

    ① 传对     → 200（正常路径不能被误伤）
    ② 只不传 agentId（wcId 传对）→ **409 agent_mismatch**
    ②b 只不传 wcId（agentId 传对）→ **409 page_mismatch**
    ③ 传错     → 409
    ④ 传 null  → 409

★ 为什么 ②/②b 要"只缺一个"而不是"两个都不传"（第一版写错了，反证时才发现）：
  两道闸是**冗余**的 —— 全不传时，即使 agentId 那道闸失效，wcId 那道也会拦住，
  于是"agentId 闸有没有失效"根本测不出来（新旧代码都返回 409，断言区分不了）。
  把另一个参数传对，才只剩目标那道闸在守，漏洞才暴露得出来。
  这正是反证的价值：它把"看起来在测、其实测不出"的弱断言逼了出来。

#8 测的是「新增字段真的反映了内存态」：
  循环刚建好 → inMemory 必须是 true；
  停掉循环后（内存里没了）→ 同一条记录 inMemory 必须变 false。
只断言"字段存在"是不够的 —— 那在"永远返回同一个常量"时也会 PASS。
"""
import importlib.util
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
TMP = os.path.join(os.environ.get("TEMP", "/tmp"), "wbp1")
PROFILE = os.path.join(TMP, "profile")
DESKTOP = os.path.join(REPO, "apps", "desktop")
os.makedirs(OUTDIR, exist_ok=True)

API_PORT = int(os.environ.get("P1_API_PORT", "8794"))
FAKE_PORT = int(os.environ.get("P1_FAKE_PORT", "8894"))
API = "http://127.0.0.1:%d" % API_PORT
FAKE = "http://127.0.0.1:%d" % FAKE_PORT
SERVER_LOG = os.path.join(OUTDIR, "server-%d.log" % API_PORT)
TEST_PHONE = os.environ.get("P1_PHONE") or ("187%08d" % (int(time.time()) % 100000000))

NODE = "node"
FAILS = []
CHECKS = []


def expect(cond, label, detail=""):
    CHECKS.append(label)
    if cond:
        print("  PASS  %s" % label)
    else:
        print("  FAIL  %s   %s" % (label, detail))
        FAILS.append(label)
    return cond


def port_busy(port, host="127.0.0.1"):
    s = socket.socket()
    s.settimeout(1.0)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


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


def pid_alive(pid):
    """tasklist 输出是 GBK，必须显式 errors='replace'，否则内部 reader 线程会抛 UnicodeDecodeError。"""
    try:
        out = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/NH", "/FO", "CSV"],
                             capture_output=True, text=True, encoding="utf-8",
                             errors="replace", timeout=15).stdout
        return ('"%d"' % pid) in out
    except Exception:
        return False


def ensure_pg():
    """把 PostgreSQL 拉起来并**等到真能查表**。

    ★ 为什么必须在**本脚本进程内**完成、而不是"先起好再跑测试"：
      本机 agent 沙箱会在每次工具调用结束时回收该调用派生的所有子进程。
      所以「上一步起 PG、下一步跑测试」这种跨调用的安排必然失败
      （现象：上一步刚看到 5432 在监听，下一步就 ECONNREFUSED）。
      唯一可行的姿势是**一次调用里把 PG → 服务端 → 断言全跑完**。

    另外两件必须做的事：
      ① 清掉残留 postmaster.pid —— PG 被硬杀时不会自己清，留着会让新实例拒绝启动；
      ② 等到 `select 1` 真的成功 —— 崩溃恢复期间端口会先通、查询报 57P03，
         只看端口会误判成功（本机实测空窗可达 30 秒以上）。
    """
    pg_home = os.path.join(os.path.expanduser("~"), "workbuddy-ai", "pg2")
    bin_dir = os.path.join(pg_home, "pg", "bin")
    data_dir = os.path.join(pg_home, "data")
    pid_file = os.path.join(data_dir, "postmaster.pid")

    if not os.path.exists(os.path.join(bin_dir, "postgres.exe")):
        print("  !! 找不到 postgres.exe：", bin_dir)
        return False

    # ① 先**全杀干净**再起唯一一个。
    #    ★ 不能只靠 `if not port_busy(5432)` 判断"要不要起"：
    #      PG 崩溃恢复期间**端口就已经在监听**，而上一个实例可能还没绑定，
    #      于是会误判成"没在跑"→ 再起一个 → 两个 postmaster 抢同一 data 目录
    #      → 互相撞死 → 数据目录写脏 → 恢复 → 死循环。
    subprocess.run(["taskkill", "/F", "/IM", "postgres.exe"], capture_output=True,
                   text=True, encoding="utf-8", errors="replace", timeout=30)
    time.sleep(3)

    # 现在 PG 一定没在跑 → pid 文件必然是残留的
    if os.path.exists(pid_file):
        try:
            os.remove(pid_file)
            print("  [pg] 清掉残留 pid 文件")
        except Exception as e:
            print("  [pg] 清 pid 失败：", e)
            return False

    launcher = os.path.join(pg_home, "_boot.cmd")
    with open(launcher, "w", encoding="gbk", errors="replace") as f:
        f.write("\r\n".join([
            "@echo off",
            "chcp 936 >nul",
            'start "" /B "%s" -D "%s"' % (os.path.join(bin_dir, "postgres.exe"), data_dir),
        ]) + "\r\n")
    # ★ 绝不能用 capture_output=True / PIPE：
    #   被 `start` 拉起的 postgres.exe 会**继承**这个 stdout 管道并一直持有它，
    #   于是 cmd 明明已经退出，管道也等不到 EOF —— subprocess.run 会**永久挂住**。
    #   用 DEVNULL 让它彻底断开继承。
    subprocess.run(["cmd", "/c", launcher], stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=30)
    print("  [pg] 已启动唯一实例")

    # ③ 等到真能查询（不是只看端口）
    probe = (
        "const{Client}=require('pg');"
        "const c=new Client({connectionString:'postgresql://workbench:workbench@127.0.0.1:5432/workbench'});"
        "c.connect().then(()=>c.query('select 1')).then(()=>{console.log('QUERY_OK');return c.end()})"
        ".catch(e=>{console.log('ERR:'+(e.code||e.message));return c.end().catch(()=>{})})"
    )
    end = time.time() + 240
    last = ""
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
        print("  [pg] 等待恢复…", last[:60])
        time.sleep(6)
    print("  [pg] 超时未就绪：", last[:80])
    return False


def spawn(tag, cmd, cwd, env=None, log=None):
    e = dict(os.environ)
    if env:
        e.update({k: str(v) for k, v in env.items()})
    f = open(log, "w", encoding="utf-8", errors="replace") if log else subprocess.DEVNULL
    p = subprocess.Popen(cmd, cwd=cwd, env=e, stdout=f, stderr=subprocess.STDOUT)
    print("  [spawn] %s pid=%s" % (tag, p.pid))
    return p


PROCS = []


def cleanup():
    for p in PROCS:
        try:
            p.terminate()
        except Exception:
            pass
    for p in PROCS:
        try:
            p.wait(timeout=8)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass


def wait_health(timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        st, body = http("GET", API + "/health", timeout=4)
        if st == 200 and body.get("db") == "up":
            return body
        time.sleep(2)
    return None


def login():
    """走短信 mock 登录：/auth/sms/send → 日志里读码 → /auth/sms/verify。"""
    st, b = http("POST", API + "/auth/sms/send", {"phone": TEST_PHONE})
    if st != 200:
        # 老账号可能已设密码 → 换密码登录
        st2, b2 = http("POST", API + "/auth/login/password", {"phone": TEST_PHONE, "password": "P1test!pass"})
        if st2 == 200:
            return b2.get("token") or b2.get("session", {}).get("token")
        print("  login send failed:", st, b, "| pwd:", st2, b2)
        return None
    # 从服务端日志抓验证码（SMS_MOCK 只写日志）。
    # ★ 注意日志里的手机号是**打码的**（`187****3053`），所以不能用完整号码去匹配行 ——
    #   必须认 `[sms:mock]` + `验证码` 这个结构，否则永远匹配不上（踩过一次）。
    end = time.time() + 25
    code = None
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
        print("  没能从日志里取到验证码")
        return None
    st, b = http("POST", API + "/auth/login/sms", {"phone": TEST_PHONE, "code": code})
    if st != 200:
        print("  login/sms failed:", st, b)
        return None
    return b.get("token") or b.get("session", {}).get("token")


def main():
    print("=" * 70)
    print("第一批修复 · 定向回归（#1 归属硬闸 / #8 存活字段）")
    print("=" * 70)

    for port, what in ((API_PORT, "API"), (FAKE_PORT, "fake-llm")):
        if port_busy(port):
            print("!! 端口 %d（%s）已被占用，先腾出来再跑" % (port, what))
            return 2

    print("\n[1] 起环境")
    # ★ 先确保数据库可用 —— 本机 PG 经常处于崩溃恢复或已被回收的状态，
    #   不先把它弄好，后面所有断言都会因为 /auth 返回 503 而假失败。
    if not expect(ensure_pg(), "PostgreSQL 可用（能真查表，不只是端口通）"):
        return 1

    PROCS.append(spawn("fake-llm", [NODE, os.path.join(HERE, "fake-llm.mjs")], REPO,
                       env={"FAKE_PORT": str(FAKE_PORT), "FAKE_DELAY_MS": "50", "FAKE_STEPS": "2"},
                       log=os.path.join(OUTDIR, "llm.log")))
    time.sleep(1.5)
    PROCS.append(spawn("server", [NODE, "dist/index.js"], os.path.join(REPO, "apps", "server"),
                       env={"PORT": str(API_PORT), "DEEPSEEK_BASE_URL": FAKE,
                            "DEEPSEEK_API_KEY": "fake-p1", "DEEPSEEK_MODEL": "fake-p1"},
                       log=SERVER_LOG))
    hs = wait_health()
    if not expect(hs is not None, "验收后端起来了且 db=up",
                  json.dumps(hs, ensure_ascii=False)[:200] if hs else "健康检查超时/库不通"):
        return 1
    print("    health:", json.dumps(hs, ensure_ascii=False)[:160])

    print("\n[2] 登录拿 token")
    token = login()
    if not expect(bool(token), "拿到登录凭证"):
        return 1
    print("    token 长度:", len(token))

    print("\n[3] 取一个真实智能体 id（新账号自带「小助」，不能编一个）")
    st, b = http("GET", API + "/agents", token=token)
    agents = (b.get("agents") or []) if st == 200 else []
    if not expect(len(agents) >= 1, "账号下有智能体可用", "%s %s" % (st, json.dumps(b, ensure_ascii=False)[:150])):
        return 1
    AG = agents[0]["id"]
    WC = 77
    print("    用智能体 id =", AG, "(", agents[0].get("name"), ")")

    print("\n[4] 建一个「带 agentId + wcId」的循环（模拟桌面端正常发车）")
    st, b = http("POST", API + "/agent/loop/start",
                 {"goal": "P1 归属校验回归", "agentId": AG, "wcId": WC, "state": {}}, token)
    if not expect(st == 200 and b.get("loopId"), "建循环成功", "%s %s" % (st, b)):
        return 1
    loop_id = b["loopId"]
    print("    loopId =", loop_id, "| 服务端记的 agentId =", b.get("agentId"))

    print("\n[5] ★ #1 核心：四组对照（判据是 409 有没有真的拦下来）")
    print("    ① 传对 → 期望 200（正常路径不能误伤）")
    st_ok, b_ok = http("POST", API + "/agent/loop/next",
                       {"loopId": loop_id, "agentId": AG, "wcId": WC, "result": {"ok": True, "detail": "x"}}, token)
    expect(st_ok == 200, "① 传对 → 200", "实际 %s %s" % (st_ok, json.dumps(b_ok, ensure_ascii=False)[:120]))

    print("    ② 只不传 agentId（wcId 传对）→ 期望 409 agent_mismatch")
    print("       ★ 必须把 wcId 传对：两道闸是冗余的，全不传的话 wcId 那道也会拦住，")
    print("         于是'agentId 这道闸有没有失效'根本看不出来 —— 这是反证时才发现的。")
    st_no, b_no = http("POST", API + "/agent/loop/next",
                       {"loopId": loop_id, "wcId": WC, "result": {"ok": True, "detail": "x"}}, token)
    expect(st_no == 409, "② 不传 agentId → 409", "实际 %s %s" % (st_no, json.dumps(b_no, ensure_ascii=False)[:120]))
    expect(b_no.get("code") == "agent_mismatch", "② 错因是 agent_mismatch（不是被 wcId 代拦）",
           "实际 code=%s" % b_no.get("code"))

    print("    ②b 只不传 wcId（agentId 传对）→ 期望 409 page_mismatch")
    st_nb, b_nb = http("POST", API + "/agent/loop/next",
                       {"loopId": loop_id, "agentId": AG, "result": {"ok": True}}, token)
    expect(st_nb == 409, "②b 不传 wcId → 409", "实际 %s" % st_nb)
    expect(b_nb.get("code") == "page_mismatch", "②b 错因是 page_mismatch", "实际 code=%s" % b_nb.get("code"))

    print("    ③ 传错的 agentId → 期望 409")
    st_bad, b_bad = http("POST", API + "/agent/loop/next",
                         {"loopId": loop_id, "agentId": 999999, "wcId": WC, "result": {"ok": True}}, token)
    expect(st_bad == 409, "③ 传错 agentId → 409", "实际 %s" % st_bad)

    print("    ④ 显式传 null → 期望 409")
    print("       （注：这条新旧代码都会拦 —— Number(null)=0 是整数，旧写法也过得去比较。")
    print("         所以它**不是**区分新旧的那条断言，只作为长期回归护栏保留。）")
    st_null, b_null = http("POST", API + "/agent/loop/next",
                           {"loopId": loop_id, "agentId": None, "wcId": None, "result": {"ok": True}}, token)
    expect(st_null == 409, "④ 传 null → 409", "实际 %s %s" % (st_null, json.dumps(b_null, ensure_ascii=False)[:120]))

    print("\n[5b] ★ 反向护栏：循环**建的时候就没记** agentId/wcId → 不该被硬闸拦住")
    print("     （硬闸的语义是「会话有约束 ⇒ 调用方必须自证相符」，")
    print("       没有约束时再拦就是误伤 —— 会把'客户端确实不知道'的合法调用挡在门外）")
    st, b = http("POST", API + "/agent/loop/start",
                 {"goal": "无归属约束的循环", "state": {}}, token)
    if expect(st == 200 and b.get("loopId"), "建一条不带 agentId/wcId 的循环", "%s %s" % (st, b)):
        free_id = b["loopId"]
        expect(b.get("agentId") is None, "服务端如实记成 agentId=null", "实际 %s" % b.get("agentId"))
        st, b2 = http("POST", API + "/agent/loop/next",
                      {"loopId": free_id, "result": {"ok": True, "detail": "x"}}, token)
        expect(st == 200, "★ 没有约束时，不传 agentId/wcId 也放行（不误伤）",
               "实际 %s %s" % (st, json.dumps(b2, ensure_ascii=False)[:120]))

    print("\n[5c] ★ 新增的 /agent/loop/info：让主进程能问到循环的权威身份")
    print("     （这是修 #1 时发现的配套缺口：循环可能是渲染层 /chat/stream 建的，")
    print("       主进程只有 loopId、不知道它属于哪个智能体 → 硬闸会误判成不匹配）")
    st, b = http("GET", API + "/agent/loop/info?loopId=" + loop_id, token=token)
    expect(st == 200, "/agent/loop/info 可读", "实际 %s" % st)
    if st == 200:
        expect(b.get("agentId") == AG, "★ 回的 agentId 与建循环时一致", "实际 %s（期望 %s）" % (b.get("agentId"), AG))
        expect(b.get("wcId") == WC, "★ 回的 wcId 与建循环时一致", "实际 %s（期望 %s）" % (b.get("wcId"), WC))
        expect(isinstance(b.get("status"), str) and b.get("status"), "回了 status", "实际 %s" % b.get("status"))
    # ⚠️ 这个 loopId 必须是**纯 ASCII**：urlopen 碰到 URL 里的非 ASCII 会直接抛异常，
    #    被 http() 兜成 status=0，看起来像"服务端没回 404"，实际是请求根本没发出去（踩过）。
    st, _ = http("GET", API + "/agent/loop/info?loopId=loop_nonexistent_xyz", token=token)
    expect(st == 404, "不存在的 loopId → 404（不泄漏它存不存在）", "实际 %s" % st)
    st, _ = http("GET", API + "/agent/loop/info", token=token)
    expect(st == 400, "缺 loopId → 400", "实际 %s" % st)
    st, _ = http("GET", API + "/agent/loop/info?loopId=" + loop_id)
    expect(st == 401, "未登录 → 401", "实际 %s" % st)

    print("\n[6] #8：挂起中的循环 → inMemory=true 且 resumable=true")
    st_p, b_p = http("POST", API + "/agent/loop/pause", {"loopId": loop_id, "pausedBy": "user"}, token)
    st, b = http("GET", API + "/agent/loop/pauses?loopId=" + loop_id, token=token)
    recs = b.get("records") or []
    if expect(len(recs) >= 1, "能查到这条循环的暂停记录", "pause=%s %s" % (st_p, json.dumps(b_p, ensure_ascii=False)[:120])):
        rec = recs[0]
        expect("inMemory" in rec, "记录里带 inMemory 字段", "字段列表=%s" % sorted(rec.keys()))
        expect("resumable" in rec, "记录里带 resumable 字段", "字段列表=%s" % sorted(rec.keys()))
        expect(rec.get("inMemory") is True, "★ 循环在内存 → inMemory=true", "实际 %s" % rec.get("inMemory"))
        expect(rec.get("resumable") is True, "★ 挂起中 → resumable=true（能继续）", "实际 %s" % rec.get("resumable"))

    print("\n[7] #8 关键反面对照：停掉循环后 → resumable 必须变 false")
    print("    （inMemory 仍会是 true —— stopLoop 只改 status，不删 Map 条目，")
    print("      这正是「不能只看 inMemory」的实证，两个字段必须分开看）")
    st_s, b_s = http("POST", API + "/agent/loop/stop", {"loopId": loop_id}, token)
    time.sleep(1.0)
    st, b = http("GET", API + "/agent/loop/pauses?loopId=" + loop_id, token=token)
    recs2 = b.get("records") or []
    if expect(len(recs2) >= 1, "停掉后仍能查到同一条记录"):
        r2 = recs2[0]
        expect(r2.get("resumable") is False,
               "★ 已停止（终态）→ resumable=false（点了没反应的情况被挡住）",
               "实际 %s（stop=%s）" % (r2.get("resumable"), st_s))
        expect(r2.get("inMemory") is True,
               "★ 已停止但仍在内存 → inMemory=true（如实反映 stopLoop 不删条目）",
               "实际 %s —— 若这里变 false 说明语义与实现不符，需复核" % r2.get("inMemory"))
        # 两个字段必须能区分开：这是"字段有信息量"的硬判据。
        expect(r2.get("inMemory") != r2.get("resumable"),
               "★ inMemory 与 resumable 在这一态下取值不同（证明两者不是同一个东西）",
               "两者都=%s" % r2.get("inMemory"))

    print("\n" + "=" * 70)
    print("结果：%d 条断言，%d 条失败" % (len(CHECKS), len(FAILS)))
    for f in FAILS:
        print("   ✗", f)
    print("=" * 70)
    return 1 if FAILS else 0


if __name__ == "__main__":
    try:
        code = main()
    finally:
        cleanup()
    sys.exit(code)
