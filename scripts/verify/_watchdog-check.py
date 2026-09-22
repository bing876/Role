"""起 PG 看门狗，并用「杀掉 PG 看它会不会自己回来」验证看门狗真的活着。

本机限制：agent 工具调用结束时，该调用派生的子进程会被回收。
`start "title" cmd /c ...` 起的**独立窗口**进程是唯一能活过调用边界的姿势。

用法：
  python scripts/verify/_watchdog-check.py            # 起看门狗 + 反证
  python scripts/verify/_watchdog-check.py --no-kill  # 只起，不杀 PG
"""
import os
import subprocess
import sys
import time

PG = r"C:\Users\bing\workbuddy-ai\pg2"
WD = os.path.join(PG, "watchdog.cmd")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def pg_pids():
    r = subprocess.run(["tasklist", "/NH", "/FO", "CSV"], capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    pids = []
    for line in (r.stdout or "").splitlines():
        if "postgres.exe" in line.lower():
            parts = line.split('","')
            if len(parts) > 1 and parts[1].strip('"').isdigit():
                pids.append(int(parts[1].strip('"')))
    return sorted(pids)


def port_open():
    import socket
    s = socket.socket()
    s.settimeout(1.5)
    try:
        s.connect(("127.0.0.1", 5432))
        return True
    except OSError:
        return False
    finally:
        s.close()


def main():
    if not os.path.exists(WD):
        print("✗ 找不到 watchdog.cmd:", WD)
        return 1

    # 1) 起看门狗（独立窗口）
    launcher = os.path.join(PG, "_launch_watchdog.cmd")
    with open(launcher, "w", encoding="gbk", errors="replace") as f:
        f.write("@echo off\r\nchcp 936 >nul\r\n"
                f'start "pgwatchdog" /MIN cmd /c "{WD}"\r\n')
    # ★ 不能用 capture_output=True：`start` 起的新窗口会继承管道，
    #   父进程会一直等它关闭 → 卡死（实测 30s TimeoutExpired）。
    #   丢到 DEVNULL 让它彻底脱离。
    r = subprocess.run(["cmd", "/c", launcher], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                       timeout=30)
    print("[1] 已发出看门狗启动命令 rc =", r.returncode)
    time.sleep(5)

    before = pg_pids()
    print("[2] 当前 postgres pid:", before, " 5432 =", port_open())

    if "--no-kill" in sys.argv:
        print("(跳过反证)")
        return 0

    if not before:
        print("[3] PG 本来就没跑，等看门狗把它拉起来…")
    else:
        # 2) 反证：杀掉 PG，看门狗应当在 ~10s 内把它拉回来
        print("[3] 反证：杀掉全部 postgres.exe …")
        subprocess.run(["taskkill", "/F", "/IM", "postgres.exe"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
        time.sleep(3)
        print("    杀完后 pid:", pg_pids(), " 5432 =", port_open())

    # 3) 等看门狗把 PG 拉回来
    t0 = time.time()
    came_back = False
    while time.time() - t0 < 90:
        if pg_pids() and port_open():
            came_back = True
            break
        time.sleep(3)

    after = pg_pids()
    print(f"[4] {time.time() - t0:.0f}s 后 pid: {after}  5432 = {port_open()}")
    if came_back:
        print("=== 看门狗有效：PG 被拉回来了 ===")
        return 0
    print("=== ✗ 看门狗没生效（PG 没回来）—— 需要人工启动 ===")
    return 1


if __name__ == "__main__":
    sys.exit(main())
