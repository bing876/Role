"""清掉残留 postmaster.pid 并把 postgres 起起来（本机专用）。

单独拆出来是因为：内联在 bash 里写 Python 字符串时，路径里的反斜杠
会先被 shell 吃掉一层，转义极难写对 —— 写成文件就没这个问题。
"""
import os
import sys

PG = r"C:\Users\bing\workbuddy-ai\pg2"
BIN = os.path.join(PG, "pg", "bin")
DATA = os.path.join(PG, "data")
PIDFILE = os.path.join(DATA, "postmaster.pid")
CMD = os.path.join(PG, "start-pg.cmd")

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

if os.path.exists(PIDFILE):
    os.remove(PIDFILE)
    print("[pg] 已清掉残留 postmaster.pid")

lines = [
    "@echo off",
    "chcp 936 >nul",
    'start "" /B "%s" -D "%s"' % (os.path.join(BIN, "postgres.exe"), DATA),
]
with open(CMD, "w", encoding="gbk", errors="replace") as f:
    f.write("\r\n".join(lines) + "\r\n")
print("[pg] 启动脚本已写:", CMD)
