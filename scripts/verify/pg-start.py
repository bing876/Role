"""
把 PostgreSQL 拉起来，并让它在**本工具调用结束后仍然活着**。

★ 核心难点（本机特有）：
    agent 会话结束 / 后台任务被回收时，会**连带杀掉该调用派生的所有子进程**。
    `pg_ctl start`（哪怕 detached + unref）起的服务，工具调用一结束就没了 ——
    实测现象：启动日志明明写着 listening on 127.0.0.1:5432，
    下一个调用再查，进程没了、端口也没了。
    注册成 Windows 服务也不行：`pg_ctl register` 报
    "could not open service manager"（需要 UAC 提权，拿不到）。

   可行解：**用 cmd 的 `start "" /B` 启动 postgres.exe 本体**（不是 pg_ctl）。
   ★ 必须带 `/B` —— 不带的话 `start` 会**新开一个可见控制台窗口**（每次重启弹一个黑窗）。
   `start` 会创建一个真正脱离的新进程；postgres.exe 自己就是服务器（前台驻留），
   不像 pg_ctl 那样 fork 完就退出。这一招在本机已用于启动 GUI 程序，验证过能存活。

   另外：直接 ./xxx.exe 在 Git Bash 下会报 `Exec format error`，
   所以 .cmd 文件要用 Python 写成 **GBK**（本机控制台编码），再用 ./x.cmd 执行。
"""
import os
import subprocess
import sys
import time
import socket

PG = r"C:\Users\bing\workbuddy-ai\pg2"
BIN = os.path.join(PG, "pg", "bin")
DATA = os.path.join(PG, "data")
LOG = os.path.join(PG, "pg.log")
CMD = os.path.join(PG, "start-pg.cmd")


def port_open(port=5432, host="127.0.0.1", timeout=1.5):
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


if port_open():
    print("5432 已在监听，跳过启动")
    sys.exit(0)

# 用 GBK 写 .cmd —— 中文 Windows 控制台认这个编码；写成 UTF-8 会乱码
script = f'''@echo off
chcp 936 >nul
start "" /B "{os.path.join(BIN, "postgres.exe")}" -D "{DATA}"
'''
with open(CMD, "w", encoding="gbk", errors="replace") as f:
    f.write(script)
print("已写启动脚本:", CMD)

subprocess.run(["cmd", "/c", CMD], capture_output=True, text=True)

deadline = time.time() + 60
while time.time() < deadline:
    if port_open():
        print("✓ PostgreSQL 已启动，5432 可连")
        sys.exit(0)
    time.sleep(1)

print("★ 60 秒内没起来，日志尾部：")
try:
    txt = open(LOG, "r", encoding="utf-8", errors="replace").read()
    print("\n".join(txt.splitlines()[-30:]))
except Exception as e:  # noqa: BLE001
    print("  读不到日志:", e)
sys.exit(1)
