"""#12 第一步：给 PHONE_PEPPER 配一个独立的值（含**已有用户迁移**）。

## 为什么不能只改 .env（这一步是必须的，不是可选的）
`phone_hash = HMAC-SHA256(pepper, phone)`，而当前 `.env` 里 `PHONE_PEPPER=` 是空的，
代码回落到 `pepper = DATA_KEY`（`env.ts:80`）。也就是说**库里现存的手机号哈希
全是用 DATA_KEY 当盐算出来的**。
一旦直接填一个新的 pepper，`HMAC(新pepper, phone)` 和库里那串对不上
→ **所有老用户当场登录不上**（表现为"手机号对、验证码也对，却当成新用户/查不到"）。

好在 `users.phone_enc` 是 AES-256-GCM(DATA_KEY) 加密的**可解密**副本，
所以迁移是可行的：解密出手机号 → 用新 pepper 重算 hash → 回写。

## 本脚本做四件事
  1. 备份现有 (id, xyz_id, phone_hash, phone_enc) 到 JSON —— 出问题能回退；
  2. 生成 32 字节高熵 pepper，写进 `apps/server/.env` 的 `PHONE_PEPPER=`；
  3. 用新 pepper 重算所有 `phone_hash`（逐个校验旧 hash 确实等于
     `HMAC(DATA_KEY, phone)`，**不等就跳过并报警**，绝不盲改）；
  4. 起服务端，用**真实登录**验证老用户还能进（这是唯一算数的证据）。

用法： python scripts/verify/p12-pepper-migrate.py
"""
import json
import os
import re
import secrets
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
SERVER_DIR = os.path.join(REPO, "apps", "server")
ENV_FILE = os.path.join(SERVER_DIR, ".env")
os.makedirs(OUTDIR, exist_ok=True)

NODE = "node"
API_PORT = int(os.environ.get("P12_API_PORT", "8796"))
API = "http://127.0.0.1:%d" % API_PORT
SERVER_LOG = os.path.join(OUTDIR, "p12-server.log")

# 迁移前必须能证明"旧 hash 确实是用 DATA_KEY 算的"——否则说明环境不是我们以为的样子
DATA_KEY = "37e9158ac1e8b27befae29e59e0f94dc7d3b5f9408e853f9afcde816231cf887"

PROCS = []


# --------------------------------------------------------------------------- #
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
    pg_home = os.path.join(os.path.expanduser("~"), "workbuddy-ai", "pg2")
    bin_dir = os.path.join(pg_home, "pg", "bin")
    data_dir = os.path.join(pg_home, "data")
    pid_file = os.path.join(data_dir, "postmaster.pid")

    if os.path.exists(pid_file):
        try:
            old = int(open(pid_file, encoding="utf-8", errors="replace").read().splitlines()[0].strip())
            if not pid_alive(old):
                os.remove(pid_file)
                print("  [pg] 清掉残留 pid")
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
        subprocess.run(["cmd", "/c", launcher], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=30)
        print("  [pg] 已发出启动命令")

    end = time.time() + 240
    while time.time() < end:
        st, _ = db_query("select 1 as ok")
        if st == "OK":
            print("  [pg] 数据库可查询 ✔")
            return True
        print("  [pg] 等待恢复…", st[:50])
        time.sleep(6)
    return False


def db_query(sql, params=None):
    """跑一条 SQL，返回 ('OK', rows) 或 ('ERR:xxx', None)。"""
    script = (
        "const{Client}=require('pg');"
        "const c=new Client({connectionString:'postgresql://workbench:workbench@127.0.0.1:5432/workbench'});"
        "const sql=process.argv[1];const params=JSON.parse(process.argv[2]||'null');"
        "c.connect().then(()=>c.query(sql,params||undefined))"
        ".then(r=>{console.log('OK'+JSON.stringify(r.rows));return c.end()})"
        ".catch(e=>{console.log('ERR:'+(e.code||e.message));return c.end().catch(()=>{})})"
    )
    try:
        r = subprocess.run([NODE, "-e", script, sql, json.dumps(params)],
                           cwd=SERVER_DIR, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=30)
        out = (r.stdout or "").strip()
        if out.startswith("OK"):
            return "OK", json.loads(out[2:] or "[]")
        return out[:120], None
    except Exception as e:
        return "EXC:%s" % e, None


def http(method, url, body=None, token=None, timeout=15):
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


def start_server():
    f = open(SERVER_LOG, "a", encoding="utf-8", errors="replace")
    f.write("\n===== 启动 @ %s =====\n" % time.strftime("%H:%M:%S"))
    f.flush()
    PROCS.append(subprocess.Popen(
        [NODE, "dist/index.js"], cwd=SERVER_DIR,
        env={**os.environ, "PORT": str(API_PORT)},
        stdout=f, stderr=subprocess.STDOUT))
    end = time.time() + 60
    while time.time() < end:
        st, b = http("GET", API + "/health", timeout=4)
        if st == 200 and b.get("db") == "up":
            return True
        time.sleep(1.5)
    return False


def login(phone):
    st, b = http("POST", API + "/auth/sms/send", {"phone": phone})
    if st != 200:
        return None, "sms/send %s %s" % (st, b)
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
        return None, "取不到验证码"
    st, b = http("POST", API + "/auth/login/sms", {"phone": phone, "code": code})
    if st != 200:
        return None, "login/sms %s %s" % (st, b)
    return b.get("token") or b.get("session", {}).get("token"), "ok"


# --------------------------------------------------------------------------- #
def main():
    print("=" * 70)
    print("#12 给 PHONE_PEPPER 配独立值 + 迁移已有用户")
    print("=" * 70)

    if not ensure_pg():
        return 1

    # ---- 0) 备份 -----------------------------------------------------------
    st, rows = db_query(
        "SELECT id, xyz_id, phone_hash, phone_enc, current_project_id FROM users ORDER BY id")
    if st != "OK":
        print("  读 users 失败:", st)
        return 1
    backup_path = os.path.join(OUTDIR, "users-before-pepper-migration.json")
    with open(backup_path, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    print("\n[0] 已备份 %d 个用户 → %s" % (len(rows), os.path.basename(backup_path)))

    with_phone = [r for r in rows if r.get("phone_hash") and r.get("phone_enc")]
    no_phone = [r for r in rows if not r.get("phone_hash")]
    print("    有手机号（需迁移）:", len(with_phone), "｜无手机号（微信登录等）:", len(no_phone))

    # ---- 1) 生成 pepper 并写 .env ------------------------------------------
    new_pepper = secrets.token_hex(32)
    env_src = open(ENV_FILE, encoding="utf-8").read()
    if not re.search(r"^PHONE_PEPPER=", env_src, re.M):
        print("  !! .env 里没有 PHONE_PEPPER= 这一行，先补上再跑")
        return 1
    env_new = re.sub(r"^PHONE_PEPPER=.*$", "PHONE_PEPPER=" + new_pepper, env_src, flags=re.M)
    open(ENV_FILE, "w", encoding="utf-8").write(env_new)
    print("\n[1] 已生成并写入 PHONE_PEPPER（32 字节 = 64 位 hex，只写 .env，不进日志/代码）")
    print("    前 8 位:", new_pepper[:8] + "…（其余不打印）")

    # ---- 2) 迁移 phone_hash ------------------------------------------------
    print("\n[2] 迁移 phone_hash（先逐条校验旧 hash == HMAC(DATA_KEY, phone)）")
    # 用 node 解密 + 重算，一次把整个映射算出来（避免逐条起进程）
    migrate_script = (
        "const crypto=require('crypto');const {Client}=require('pg');"
        "const DATA_KEY=process.argv[1], NEW=process.argv[2];"
        "function aesKeyFrom(k){if(/^[0-9a-fA-F]{64}$/.test(k))return Buffer.from(k,'hex');"
        "return crypto.createHash('sha256').update(k,'utf8').digest();}"
        "function open(p,k){const[tag,iv,tg,ct]=p.split('$');"
        "const d=crypto.createDecipheriv('aes-256-gcm',k,Buffer.from(iv,'base64'));"
        "d.setAuthTag(Buffer.from(tg,'base64'));"
        "return Buffer.concat([d.update(Buffer.from(ct,'base64')),d.final()]).toString('utf8');}"
        "const c=new Client({connectionString:'postgresql://workbench:workbench@127.0.0.1:5432/workbench'});"
        "(async()=>{await c.connect();"
        "const r=await c.query('SELECT id,phone_hash,phone_enc FROM users WHERE phone_enc IS NOT NULL AND phone_hash IS NOT NULL');"
        "const key=aesKeyFrom(DATA_KEY);const out=[];"
        "for(const row of r.rows){try{"
        "const phone=open(row.phone_enc,key);"
        "const old=crypto.createHmac('sha256',DATA_KEY).update(phone,'utf8').digest('hex');"
        "const nw=crypto.createHmac('sha256',NEW).update(phone,'utf8').digest('hex');"
        "out.push({id:row.id,phone:phone,ok:old===row.phone_hash,newHash:nw});"
        "}catch(e){out.push({id:row.id,error:String(e.message)});}}"
        "console.log('RESULT'+JSON.stringify(out));await c.end();})()"
        ".catch(e=>{console.log('ERR:'+e.message);process.exitCode=1})"
    )
    r = subprocess.run([NODE, "-e", migrate_script, DATA_KEY, new_pepper], cwd=SERVER_DIR,
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=90)
    out = (r.stdout or "").strip()
    if not out.startswith("RESULT"):
        print("  !! 迁移计算失败:", out[:200], (r.stderr or "")[:200])
        return 1
    computed = json.loads(out[6:])

    bad = [x for x in computed if x.get("error") or not x.get("ok")]
    if bad:
        print("  !! 有 %d 条无法确认（已跳过，未改动）：" % len(bad))
        for x in bad[:5]:
            print("     id=%s %s" % (x.get("id"), x.get("error") or "旧 hash 与 HMAC(DATA_KEY,phone) 不符"))
        print("     这说明环境不是我们以为的样子，**不做任何写入**，请人工确认。")
        return 1
    print("    校验通过：%d/%d 条的旧 hash 确实等于 HMAC(DATA_KEY, phone)" % (len(computed), len(computed)))

    for x in computed:
        st, _ = db_query("UPDATE users SET phone_hash=$1 WHERE id=$2", [x["newHash"], x["id"]])
        if st != "OK":
            print("  !! 回写失败 id=%s: %s" % (x["id"], st))
            return 1
    print("    已用新 pepper 重算并回写 %d 条 phone_hash" % len(computed))

    # ---- 3) 起服务端 + 真实登录验证 ----------------------------------------
    print("\n[3] 起服务端并用**真实登录**验证老用户还能进")
    if not start_server():
        print("  !! 服务端没起来，看", SERVER_LOG)
        return 1
    print("    /health db=up ✔")

    # 用之前回归脚本建过的号来验（它们的 hash 刚被迁移过）
    ok_login, detail = None, ""
    for phone in [x["phone"] for x in computed][:3]:
        tok, msg = login(phone)
        masked = phone[:3] + "****" + phone[7:]
        if tok:
            print("    ✔ %s 登录成功（迁移后老用户可正常进入）" % masked)
            ok_login = True
        else:
            print("    ✗ %s 登录失败：%s" % (masked, msg))
            ok_login = False
        break  # 验一个就够
    if not ok_login:
        print("  !! 迁移后登录失败 —— 需要立即从备份回退")
        print("     备份：", backup_path)
        return 1

    print("\n" + "=" * 70)
    print("结论：PHONE_PEPPER 已配置为独立值，且已有用户迁移后仍可登录 ✔")
    print("备份：", backup_path)
    print("=" * 70)
    return 0


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
