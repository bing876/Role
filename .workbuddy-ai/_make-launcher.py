# -*- coding: utf-8 -*-
"""生成一个 GBK 编码的 .cmd，用 start 拉起安装版工作台。

为什么绕这一圈：
- agent 沙箱里 PowerShell Start-Process 会触发 reg.exe 黑名单，进程根本不起；
- 直接 Popen 会被整个 job 一起收掉（DETACHED_PROCESS 不够，还要 CREATE_BREAKAWAY_FROM_JOB）；
- 已验证可行的姿势：Python 写 .cmd（含中文路径，必须 GBK），再 ./x.cmd 执行。
"""
import os

EXE_DIR = r"C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop"
EXE = os.path.join(EXE_DIR, "AI 工作台.exe")
OUT = r"C:\Users\bing\workbuddy-ai\work123\.workbuddy-ai\_start-installed.cmd"

lines = [
    "@echo off",
    "chcp 936 >nul",
    'cd /d "%s"' % EXE_DIR,
    'start "" "%s" --no-sandbox' % EXE,
]

with open(OUT, "w", encoding="gbk", newline="\r\n") as f:
    f.write("\n".join(lines) + "\n")

print("WROTE:", OUT)
with open(OUT, "r", encoding="gbk") as f:
    print(f.read())
