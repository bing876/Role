import os
import subprocess
import sys
import time

# 安装版路径（中文目录，这里用 raw 字符串避免转义问题）
APP_DIR = r"C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop"
EXE = os.path.join(APP_DIR, "AI 工作台.exe")

if not os.path.exists(EXE):
    print("EXE_NOT_FOUND:", EXE)
    sys.exit(2)

# ★ 安装版必须 --no-sandbox：否则 1 秒 GPU FATAL，极易被误判成"包坏了"
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200

p = subprocess.Popen(
    [EXE, "--no-sandbox"],
    cwd=APP_DIR,
    creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
    close_fds=True,
)
print("LAUNCHED pid=", p.pid)
time.sleep(2)
print("still alive:", p.poll() is None)
