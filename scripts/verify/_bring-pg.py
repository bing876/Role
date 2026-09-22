"""单次调用内：清陈旧 pid -> 用独立窗口起 postgres -> 等真能查 -> 报告。"""
import os, subprocess, sys, time, socket
PG = r"C:/Users/bing/workbuddy-ai/pg2"
BIN = os.path.join(PG, "pg", "bin")
DATA = os.path.join(PG, "data")
PIDF = os.path.join(DATA, "postmaster.pid")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

def port_open():
    s = socket.socket(); s.settimeout(1.5)
    try: s.connect(("127.0.0.1", 5432)); return True
    except OSError: return False
    finally: s.close()

def alive(pid):
    r = subprocess.run(["tasklist","/FI",f"PID eq {pid}","/NH","/FO","CSV"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return f'"{pid}"' in (r.stdout or "")

# 1) 清陈旧 pid
if os.path.exists(PIDF):
    try:
        first = open(PIDF, encoding="utf-8", errors="replace").readline().strip()
        if first.isdigit() and not alive(int(first)):
            os.remove(PIDF); print("[1] 清掉陈旧 pid", first)
        elif first.isdigit():
            print("[1] pid", first, "还活着，跳过启动"); 
        else:
            os.remove(PIDF); print("[1] pid 文件异常，已清")
    except Exception as e:
        print("[1] 清 pid 出错:", e)

# 2) 独立窗口起 postgres（本机唯一能活过调用边界的姿势）
if not port_open():
    cmd = os.path.join(PG, "_start_pg_once.cmd")
    with open(cmd, "w", encoding="gbk", errors="replace") as f:
        f.write("@echo off\r\nchcp 936 >nul\r\n"
                f'start "AI工作台-PostgreSQL" /MIN "{os.path.join(BIN,"postgres.exe")}" -D "{DATA}"\r\n')
    r = subprocess.run(["cmd", "/c", cmd], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=30)
    print("[2] 已发出启动命令 rc=", r.returncode)
else:
    print("[2] 5432 已在监听")

# 3) 等端口
t0 = time.time()
while time.time() - t0 < 90:
    if port_open(): print(f"[3] 5432 就绪（{time.time()-t0:.1f}s）"); break
    time.sleep(3)
else:
    print("[3] 90s 内端口没起来"); sys.exit(1)

# 4) 等真能查（★ 端口通 != 可用）
import json
NODE = r"C:/Users/bing/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe"
PING = r"C:/Users/bing/workbuddy-ai/work123/scripts/verify/_ping-db.cjs"
t1 = time.time()
while time.time() - t1 < 240:
    r = subprocess.run([NODE, PING], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    out = (r.stdout or "").strip()
    if "QUERY_OK" in out:
        print(f"[4] 数据库真可查（{time.time()-t1:.1f}s）:", out.replace("\n"," | ")); break
    time.sleep(4)
else:
    print("[4] 240s 内仍不可查:", out[:120]); sys.exit(1)
print("DONE")
