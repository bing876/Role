"""给 start-dev.cmd 接入 PG 看门狗（保持 GBK 编码，不破坏中文）。

为什么要做：2026-09-20 用户报「登录不进去」，根因就是 PG 停了而没人把它拉起来。
`start-dev.cmd` 只负责「起」PG，不负责「保活」—— PG 一旦被关掉/杀掉，
服务端就一直 503，界面红字「数据库没连上」。

接法：在第 2 步（起 PG）之后、第 3 步（起服务端）之前，插一段启动看门狗的代码。

判重口径（★ 本机踩过两个坑）：
  · 不能用窗口标题判 —— 本机 console 窗口标题读出来是乱码
    （`tasklist /FI "WINDOWTITLE eq pgwatchdog"` 恒为"没有匹配"）；
  · 光看锁文件也不行 —— 重启后锁还在、看门狗没了，会误判"已在运行"。
  → 用「锁文件 + **PG 是否活着**」双判：
      PG 活着 + 有锁  → 认为看门狗在工作，跳过；
      PG 死了 + 有锁  → 看门狗也失效了，清锁重启它。
"""
import io
import os
import sys

REPO = r"C:\Users\bing\workbuddy-ai\work123"
TARGET = os.path.join(REPO, "start-dev.cmd")

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

raw = open(TARGET, "rb").read()
text = raw.decode("gbk")

if "watchdog" in text:
    print("已经接过看门狗，无需重复修改")
    sys.exit(0)

ANCHOR = ":PG_OK\r\n"
if ANCHOR not in text:
    print("✗ 找不到锚点 :PG_OK —— 文件结构变了，请人工确认")
    sys.exit(1)

INSERT = (
    "\r\n"
    "REM ---------- 2.5) 起 PG 看门狗（保活） ----------\r\n"
    "REM ★ PG 是独立进程：被关掉/杀掉后没人拉起来的话，服务端会一直回 503\r\n"
    "REM   （界面红字「数据库没连上」）。看门狗每 10 秒探一次 postgres.exe，\r\n"
    "REM   不在就清掉残留 postmaster.pid 再重新拉起。\r\n"
    "if not exist \"%PG_HOME%\\watchdog.cmd\" (\r\n"
    "  echo       [跳过] 没找到 %PG_HOME%\\watchdog.cmd\r\n"
    "  goto WD_DONE\r\n"
    ")\r\n"
    "if exist \"%PG_HOME%\\watchdog.lock\" (\r\n"
    "  tasklist /FI \"IMAGENAME eq postgres.exe\" /NH 2>nul | find /I \"postgres.exe\" >nul\r\n"
    "  if not errorlevel 1 (\r\n"
    "    echo       看门狗已在运行（锁在、PG 也在），跳过\r\n"
    "    goto WD_DONE\r\n"
    "  )\r\n"
    "  echo       锁还在但 PG 没在跑 —— 看门狗已失效，重新启动\r\n"
    "  del /f /q \"%PG_HOME%\\watchdog.lock\"\r\n"
    ")\r\n"
    "echo       启动 PG 看门狗（PG 掉了会自动重启）...\r\n"
    "start \"pgwatchdog\" /MIN cmd /c \"%PG_HOME%\\watchdog.cmd\"\r\n"
    "echo started > \"%PG_HOME%\\watchdog.lock\"\r\n"
    ":WD_DONE\r\n"
)

text = text.replace(ANCHOR, ANCHOR + INSERT, 1)

with io.open(TARGET, "wb") as f:
    f.write(text.encode("gbk", errors="replace"))

print("已接入看门狗 ->", TARGET)
print("新文件大小:", os.path.getsize(TARGET))
