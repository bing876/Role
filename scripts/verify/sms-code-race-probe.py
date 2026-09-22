"""#5 验证：验证码消费的原子性（TOCTOU）。

## 命题
同一个验证码，**并发**提交 N 次，必须**只有 1 次**能换到 token。

修复前的写法是「先 SELECT 判 used，再 UPDATE SET used=true」——
两个并发请求会**双双通过**那句 SELECT（都读到 used=false），
然后各自置 used=true 并各自发一份 token：**一个验证码被消费两次**。
6 位码 + 5 分钟有效期，重放一次就是多一个会话。

## 为什么必须打真库
这不是纯内存逻辑：正确性完全依赖「数据库的行锁 + WHERE 条件在同一条语句里」。
用假库 / 串行调用都验不出来 —— 串行时旧写法**也是对的**（第二次 SELECT 会读到 used=true）。
所以本脚本必须：
  · 起真 PostgreSQL + 真服务端；
  · 用**真并发**（多个线程同时发 HTTP）而不是 for 循环；
  · 断言"恰好 1 个 200，其余全 401"。

★ 本机环境限制：派生的进程活不过工具调用边界，所以"起环境 → 断言 → 收尾"
  必须在**一次调用**里跑完（本脚本自己就是这么做的）。

用法： python scripts/verify/sms-code-race-probe.py
"""
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SERVER_DIR = os.path.join(REPO, "apps", "server")
OUTDIR = os.path.join(REPO, "docs", "acceptance", "p1-fix")
os.makedirs(OUTDIR, exist_ok=True)

NODE = "node"
API_PORT = int(os.environ.get("RACE_API_PORT", "8797"))
API = "http://127.0.0.1:%d" % API_PORT
SERVER_LOG = os.path.join(OUTDIR, "race-server.log")
CONCURRENCY = int(os.environ.get("RACE_N", "12"))

fails, total = [], 0
PROCS = []


def chk(cond, label, detail=""):
    global total
    total += 1
    if cond:
        print("  PASS  " + label)
    else:
        print("  FAIL  " + label + ("   " + detail if detail else ""))
        fails.append(label)
    return cond


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


def pid_alive(pid):
    try:
        out = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/NH", "/FO", "CSV"],
                             capture_output=True, text=True, encoding="utf-8",
                             errors="replace", timeout=15).stdout
        return ('"%d"' % pid) in out
    except Exception:
        return False


def ensure_pg():
    """起唯一一个 PG 实例并等到真能查表（详见工作区记忆里的那三个坑）。"""
    pg_home = os.path.join(os.path.expanduser("~"), "workbuddy-ai", "pg2")
    bin_dir = os.path.join(pg_home, "pg", "bin")
    data_dir = os.path.join(pg_home, "data")
    pid_file = os.path.join(data_dir, "postmaster.pid")

    # 先全杀干净，避免"恢复期端口已在监听"导致误判后**再起一个实例**
    subprocess.run(["taskkill", "/F", "/IM", "postgres.exe"], capture_output=True,
                   text=True, encoding="utf-8", errors="replace", timeout=30)
    time.sleep(3)
    if os.path.exists(pid_file):
        try:
            os.remove(pid_file)
        except Exception as e:
            print("  [pg] 清 pid 失败：", e)
            return False

    launcher = os.path.join(pg_home, "_boot.cmd")
    with open(launcher, "w", encoding="gbk", errors="replace") as f:
        f.write("\r\n".join([
            "@echo off", "chcp 936 >nul",
            'start "" /B "%s" -D "%s"' % (os.path.join(bin_dir, "postgres.exe"), data_dir),
        ]) + "\r\n")
    subprocess.run(["cmd", "/c", launcher], stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=30)
    print("  [pg] 已启动唯一实例")

    probe = ("const{Client}=require('pg');const c=new Client({connectionString:"
             "'postgresql://workbench:workbench@127.0.0.1:5432/workbench'});"
             "c.connect().then(()=>c.query('select 1')).then(()=>{console.log('QUERY_OK');"
             "return c.end()}).catch(e=>{console.log('ERR:'+(e.code||e.message));"
             "return c.end().catch(()=>{})})")
    end = time.time() + 300
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
        print("  [pg] 等待恢复…", last[:45])
        time.sleep(5)
    return False


def http(method, path, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("content-type", "application/json")
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


def read_code(phone):
    """从服务端日志取验证码（SMS_MOCK 只写日志，且日志里手机号是打码的）。"""
    end = time.time() + 25
    while time.time() < end:
        try:
            txt = open(SERVER_LOG, encoding="utf-8", errors="replace").read()
        except Exception:
            txt = ""
        for line in reversed(txt.splitlines()):
            if "[sms:mock]" in line and "验证码" in line:
                m = re.search(r"验证码\s*(\d{6})", line)
                if m:
                    return m.group(1)
        time.sleep(1.5)
    return None


def db_one(sql, params=None):
    script = (
        "const{Client}=require('pg');"
        "const c=new Client({connectionString:'postgresql://workbench:workbench@127.0.0.1:5432/workbench'});"
        "const sql=process.argv[1];const params=JSON.parse(process.argv[2]||'null');"
        "c.connect().then(()=>c.query(sql,params||undefined))"
        ".then(r=>{console.log('OK'+JSON.stringify(r.rows));return c.end()})"
        ".catch(e=>{console.log('ERR:'+(e.code||e.message));return c.end().catch(()=>{})})"
    )
    try:
        r = subprocess.run([NODE, "-e", script, sql, json.dumps(params)], cwd=SERVER_DIR,
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=30)
        out = (r.stdout or "").strip()
        return (True, json.loads(out[2:] or "[]")) if out.startswith("OK") else (False, out[:120])
    except Exception as e:
        return False, str(e)


# --------------------------------------------------------------------------- #
# 确定性竞态：用一个外部事务**先锁住那一行**，把两个请求都卡在 UPDATE 上，
# 再放行 —— 这样"两个请求都读到了 used=false"这件事 100% 会发生，
# 不依赖"本地窗口够不够宽"这种运气。
# --------------------------------------------------------------------------- #
LOCK_SCRIPT = r"""
const {Client} = require('pg');
const id = process.argv[1];
const c = new Client({connectionString:'postgresql://workbench:workbench@127.0.0.1:5432/workbench'});
(async () => {
  await c.connect();
  await c.query('BEGIN');
  await c.query('SELECT id FROM sms_codes WHERE id = $1 FOR UPDATE', [id]);
  console.log('LOCKED');
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', async () => {
    await c.query('COMMIT');
    console.log('COMMITTED');
    await c.end();
  });
})().catch((e) => { console.log('LOCK_ERR:' + e.message); process.exit(1); });
"""


def run_lock_scenario(phone, code, code_row_id):
    """返回 (状态码列表, 说明)。

    步骤：
      1. 外部连接 BEGIN + `SELECT ... FOR UPDATE` 锁住那一行；
      2. 起 2 个线程同时提交同一个验证码 —— 它们都能通过 SELECT，
         然后**双双卡在 UPDATE 上**（行锁）；
      3. 确认两个都卡住了（还在跑），再提交外部事务放行；
      4. 收集结果。
    """
    proc = subprocess.Popen([NODE, "-e", LOCK_SCRIPT, str(code_row_id)], cwd=SERVER_DIR,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True,
                            encoding="utf-8", errors="replace", bufsize=1)
    line = proc.stdout.readline().strip()
    if line != "LOCKED":
        try:
            proc.kill()
        except Exception:
            pass
        return None, "外部事务没锁上：%s" % line

    results = [None, None]
    threads = [threading.Thread(target=lambda i=i: results.__setitem__(
        i, http("POST", "/auth/login/sms", {"phone": phone, "code": code}, timeout=30)))
        for i in range(2)]
    for t in threads:
        t.start()
    # 给它们足够时间跑到 UPDATE 并卡住
    time.sleep(2.5)
    blocked = sum(1 for t in threads if t.is_alive())
    print("    放行前仍卡在 UPDATE 上的请求数：%d / 2" % blocked)

    try:
        proc.stdin.write("go\n")
        proc.stdin.flush()
    except Exception:
        pass
    for t in threads:
        t.join(timeout=30)
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()
    codes = [r[0] if r else 0 for r in results]
    return codes, "blocked=%d" % blocked



def main():
    print("=" * 70)
    print("#5 验证：验证码消费的原子性（并发重放）")
    print("=" * 70)

    if not chk(not port_busy(API_PORT), "端口 %d 空闲" % API_PORT):
        return 1
    if not chk(ensure_pg(), "PostgreSQL 可用"):
        return 1

    f = open(SERVER_LOG, "a", encoding="utf-8", errors="replace")
    f.write("\n===== 启动 @ %s =====\n" % time.strftime("%H:%M:%S"))
    f.flush()
    PROCS.append(subprocess.Popen([NODE, "dist/index.js"], cwd=SERVER_DIR,
                                  env={**os.environ, "PORT": str(API_PORT)},
                                  stdout=f, stderr=subprocess.STDOUT))
    end = time.time() + 60
    up = False
    while time.time() < end:
        st, b = http("GET", "/health", timeout=4)
        if st == 200 and b.get("db") == "up":
            up = True
            break
        time.sleep(1.5)
    if not chk(up, "验收服务端起来了（db=up）"):
        return 1

    # ---------------- 场景 0：★ 确定性竞态（行锁强制制造窗口）----------------
    print("\n[0] ★ 确定性竞态：外部事务先锁住那一行，逼两个请求同时读到 used=false")
    print("    （不用真并发撞窗口 —— 本地 DB 太快，靠运气撞不稳；锁住行能让窗口 100% 出现）")
    phone0 = "185%08d" % (int(time.time()) % 100000000)
    st, b = http("POST", "/auth/sms/send", {"phone": phone0})
    code0 = read_code(phone0)
    if chk(st == 200 and bool(code0), "场景 0 发码并取到码", "%s %s" % (st, b)):
        ok, rows = db_one("SELECT id FROM sms_codes ORDER BY created_at DESC LIMIT 1")
        if chk(ok and rows, "取到这条验证码的行号", str(rows)):
            row_id = rows[0]["id"]
            codes0, note = run_lock_scenario(phone0, code0, row_id)
            if chk(codes0 is not None, "锁场景跑起来了", note):
                print("    两个请求的 HTTP 状态：", codes0, "|", note)
                chk(codes0.count(200) == 1,
                    "★★ 锁竞争下**恰好 1 次**成功（原子消费把重复消费挡住了）",
                    "实际成功 %d 次，状态=%s —— 若 >1 说明一个验证码换了多个 token"
                    % (codes0.count(200), codes0))
                chk(all(c in (200, 401) for c in codes0), "另一个是 401（不是 500/超时）", str(codes0))

    # ---------------- 场景 1：同一验证码并发提交 ----------------
    print("\n[1] 真并发：%d 路同时提交同一个验证码" % CONCURRENCY)
    phone = os.environ.get("RACE_PHONE") or ("189%08d" % (int(time.time()) % 100000000))
    st, b = http("POST", "/auth/sms/send", {"phone": phone})
    if not chk(st == 200, "发码成功", "%s %s" % (st, b)):
        return 1
    code = read_code(phone)
    if not chk(bool(code), "从日志取到验证码"):
        return 1
    print("    手机号 %s****%s，验证码 %s，并发 %d 路" % (phone[:3], phone[7:], code, CONCURRENCY))

    results = [None] * CONCURRENCY
    barrier = threading.Barrier(CONCURRENCY)

    def worker(i):
        barrier.wait()  # 尽量让 N 个请求**同时**打出去
        results[i] = http("POST", "/auth/login/sms", {"phone": phone, "code": code})

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(CONCURRENCY)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)

    codes = [r[0] if r else 0 for r in results]
    ok_n = sum(1 for c in codes if c == 200)
    print("    HTTP 状态分布：", {c: codes.count(c) for c in sorted(set(codes))})

    chk(ok_n == 1,
        "★★ 恰好 1 次成功（一个验证码只能换一个 token）",
        "实际成功 %d 次 —— 状态=%s" % (ok_n, codes))
    chk(all(c in (200, 401) for c in codes), "其余全部是 401（不是 500/超时）", str(codes))

    # ---------------- 场景 2：库里那一行的状态 ----------------
    print("\n[2] 直接查库：这条验证码是不是只被消费一次")
    ok, rows = db_one(
        "SELECT used, attempts FROM sms_codes WHERE id = "
        "(SELECT id FROM sms_codes ORDER BY created_at DESC LIMIT 1)")
    if chk(ok, "能读到 sms_codes 最新一行", str(rows)):
        chk(rows[0].get("used") is True, "★ 该行 used=true（已被消费）", str(rows))
        # 成功那次不应把 attempts 加上去（只有猜错才加）
        chk(int(rows[0].get("attempts", -1)) == 0,
            "★ 成功消费不改 attempts（计数只统计猜错）", str(rows))

    # ---------------- 场景 3：消费后重放必须失败 ----------------
    print("\n[3] 串行重放（消费之后再提交同一个码）")
    st, b = http("POST", "/auth/login/sms", {"phone": phone, "code": code})
    chk(st == 401, "★ 已消费的码不能再用", "实际 %s %s" % (st, b))

    # ---------------- 场景 4：错误码累加 attempts，5 次后作废 ----------------
    print("\n[4] 错误码累加 attempts，到 5 次后该码作废")
    phone2 = "188%08d" % (int(time.time()) % 100000000)
    st, _ = http("POST", "/auth/sms/send", {"phone": phone2})
    code2 = read_code(phone2)
    if chk(bool(code2), "第二个号取到验证码"):
        wrong = "000000" if code2 != "000000" else "111111"
        seen = []
        for _ in range(6):
            st, _b = http("POST", "/auth/login/sms", {"phone": phone2, "code": wrong})
            seen.append(st)
        chk(all(c == 401 for c in seen), "错的码一律 401", str(seen))
        # 5 次之后即使拿**正确的**码也应当被拒（attempts 已到上限）
        st, _b = http("POST", "/auth/login/sms", {"phone": phone2, "code": code2})
        chk(st == 401, "★ 猜错 5 次后，正确的码也失效（attempts 闸生效）",
            "实际 %s（若为 200 说明 attempts 上限没起作用）" % st)

    print("\n" + "=" * 70)
    print("结果：%d 条断言，%d 条失败" % (total, len(fails)))
    for x in fails:
        print("   ✗", x)
    print("=" * 70)
    return 1 if fails else 0


if __name__ == "__main__":
    try:
        code = main()
    finally:
        for p in PROCS:
            try:
                p.terminate()
                p.wait(timeout=8)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass
    sys.exit(code)
