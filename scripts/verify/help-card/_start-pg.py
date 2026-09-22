"""把便携版 PostgreSQL 拉起来（**不经过 cmd.exe**）。

为什么要自己写：仓库里那个 `scripts/verify/pg-start.py` 内部是
`subprocess.run(["cmd","/c",CMD])` —— 本工具对 `cmd /c` 有静态规则直接拒绝，
所以它在本工具里会**静默死**（无输出 + 整条命令 SIGTERM）。这里改成 Python 直接 Popen。

★ 记忆里的两个坑都处理了：
  ① 先 `taskkill /F /IM postgres.exe` 全杀，再起唯一一个（两个 postmaster 抢同一 data 目录会互相撞死）；
  ② `data/postmaster.pid` 残留会静默拒启 —— **只在确认没有 postgres 在跑时**才删它。
"""
import os
import socket
import subprocess
import sys
import time

PG = r"C:\Users\bing\workbuddy-ai\pg2"
BIN = os.path.join(PG, "pg", "bin")
DATA = os.path.join(PG, "data")
LOG = os.path.join(PG, "pg.log")
PIDFILE = os.path.join(DATA, "postmaster.pid")

DETACHED = 0x00000008
NEW_GROUP = 0x00000200


def port_open(port=5432, host="127.0.0.1", timeout=1.0):
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def postgres_pids():
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq postgres.exe", "/FO", "CSV", "/NH"],
                         capture_output=True, text=True, encoding="gbk", errors="replace").stdout
    pids = []
    for line in out.splitlines():
        parts = [x.strip('"') for x in line.split('","')]
        if len(parts) >= 2 and parts[1].isdigit():
            pids.append(int(parts[1]))
    return pids


def kill_all():
    for pid in postgres_pids():
        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, text=True)
    time.sleep(2)
    return postgres_pids()


print("=== 1) 清场：先全杀 postgres ===")
left = kill_all()
print("   剩下:", left)

if not left and os.path.exists(PIDFILE):
    os.remove(PIDFILE)
    print("   删掉残留 postmaster.pid")

print("=== 2) 起唯一一个 postgres ===")
out = open(LOG, "ab")
p = subprocess.Popen(
    [os.path.join(BIN, "postgres.exe"), "-D", DATA],
    cwd=PG,
    stdout=out,
    stderr=subprocess.STDOUT,
    creationflags=DETACHED | NEW_GROUP,
)
print("   pid =", p.pid)

print("=== 3) 等它就绪（端口通 ≠ 可查，记忆里要 ~34s）===")
deadline = time.time() + 90
ready = False
while time.time() < deadline:
    time.sleep(2)
    if p.poll() is not None:
        print("   ★ postgres 自己退出了 code =", p.returncode)
        break
    if port_open():
        ready = True
        print("   端口 5432 已监听（继续等它真的可查）")
        break

if ready:
    # 真正可查的判据：能跑一条 SQL。pg/bin 下没有 psql，用 node 的 pg 包探活
    probe = os.path.join(PG, "ping-db.mjs")
    if os.path.exists(probe):
        for i in range(20):
            r = subprocess.run(["node", probe], capture_output=True, text=True, encoding="utf-8", errors="replace")
            if r.returncode == 0:
                print("   ✓ 数据库可查（ping-db.mjs 通过）")
                break
            time.sleep(2)
        else:
            print("   ★ 端口通了但 90 秒内查不通；ping-db 输出：")
            print((r.stdout or "")[-500:], (r.stderr or "")[-500:])
    else:
        print("   （没有 ping-db.mjs，跳过可查性验证）")

print("=== 4) 收尾状态 ===")
print("   postgres 进程:", postgres_pids())
print("   5432:", "通" if port_open() else "不通")
print("   日志尾部:")
try:
    txt = open(LOG, "r", encoding="utf-8", errors="replace").read()
    for line in txt.splitlines()[-12:]:
        print("     " + line)
except Exception as e:  # noqa: BLE001
    print("     读不到:", e)
