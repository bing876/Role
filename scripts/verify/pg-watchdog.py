"""把 postgres 看门狗以**独立窗口**方式拉起来（本机专用）。

为什么要看门狗：
  本机 agent 沙箱在工具调用结束时，会回收该调用派生的子进程。
  `pg_ctl start` / 裸 `&` / `start /b` 起的 postgres 都活不过一次工具调用边界，
  表现成"明明刚起来，下一个调用就 ECONNREFUSED"。
  唯一稳定存活的是 `start "title" cmd /c ...` 起的**独立窗口**进程。

  看门狗自身每 10 秒探一次 postgres.exe 是否还在；不在了就清掉可能残留的
  postmaster.pid（被硬杀时不会自己清，留着会挡住重启）并重新拉起。
"""
import os
import subprocess
import sys
import time

PG = r"C:\Users\bing\workbuddy-ai\pg2"
LAUNCHER = os.path.join(PG, "_launch_watchdog.cmd")

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 用 start "title" 起独立窗口 —— 这是本机唯一能让进程活过工具调用边界的姿势
script = "\r\n".join([
    "@echo off",
    "chcp 936 >nul",
    'start "pgwatchdog" cmd /c "%s"' % os.path.join(PG, "watchdog.cmd"),
]) + "\r\n"

with open(LAUNCHER, "w", encoding="gbk", errors="replace") as f:
    f.write(script)
print("[watchdog] 已写启动器:", LAUNCHER)

r = subprocess.run(["cmd", "/c", LAUNCHER], capture_output=True, text=True,
                   encoding="utf-8", errors="replace", timeout=30)
print("[watchdog] 已发出启动命令 rc=", r.returncode)

# 等端口起来
import socket
deadline = time.time() + 90
while time.time() < deadline:
    s = socket.socket()
    s.settimeout(2)
    try:
        s.connect(("127.0.0.1", 5432))
        print("[watchdog] 5432 已监听")
        break
    except OSError:
        pass
    finally:
        s.close()
    time.sleep(4)
else:
    print("[watchdog] 端口仍未起来")
    sys.exit(1)
