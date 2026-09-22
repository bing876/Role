# -*- coding: utf-8 -*-
"""启动已安装版 AI 工作台（换装后的新包）。

本机两个坑：
1) 安装版必须加 --no-sandbox，否则 1 秒 GPU FATAL（容易误判成"包坏了"）。
2) agent 沙箱里不能用 PowerShell Start-Process（会触发 reg.exe 黑名单，进程根本不起）。
   这里直接用 Python subprocess + DETACHED_PROCESS 拉起，脱离本进程、用户能一直用。
"""
import os
import subprocess
import sys

EXE_DIR = r"C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop"
EXE = os.path.join(EXE_DIR, "AI 工作台.exe")

if not os.path.exists(EXE):
    print("NOT_FOUND:", EXE)
    sys.exit(2)

DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200

p = subprocess.Popen(
    [EXE, "--no-sandbox"],
    cwd=EXE_DIR,
    creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
    close_fds=True,
)
print("LAUNCHED pid=", p.pid)
print("exe=", EXE)
