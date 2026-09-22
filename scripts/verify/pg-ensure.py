"""把 PostgreSQL 拉起来并保持存活（本机专用）。

比 scripts/verify/pg-start.py 多做两件事：
  ① 清理**残留的 postmaster.pid**：上一次 postgres 被硬杀时不会自己清，
     留着会让新实例拒绝启动（或误判"已在运行"）；
  ② 启动后**等到真正能查表**为止（崩溃恢复期间只 listen、不接查询，
     光看端口开着会误判成功）。

用 `start "" /B` 起 postgres.exe 本体（不是 pg_ctl）—— pg_ctl fork 完就退出，
（★ 必须是 `/B`：不带 `/B` 的 `start ""` 会**新开一个可见控制台窗口**，
  每次重启 PG 就弹一个黑窗 —— 用户报过「一直弹终端」。见 pg-launch-window-test.cjs）
进程会被沙箱回收；postgres.exe 自己就是前台驻留的服务器，`start` 能让它脱离。
"""
import os
import socket
import subprocess
import sys
import time

PG = r"C:\Users\bing\workbuddy-ai\pg2"
BIN = os.path.join(PG, "pg", "bin")
DATA = os.path.join(PG, "data")
PIDFILE = os.path.join(DATA, "postmaster.pid")
CMD = os.path.join(PG, "start-pg.cmd")

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def pid_alive(pid: int) -> bool:
    """本机 tasklist 读不到非 ASCII 进程名，但纯数字 PID 是可靠的。

    注意 capture 必须指定 errors='replace' —— tasklist 输出是 GBK，
    用默认 utf-8 解码会在内部 reader 线程里抛 UnicodeDecodeError。
    """
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH", "/FO", "CSV"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15,
        ).stdout
        return f'"{pid}"' in out
    except Exception:
        return False


def port_open(host="127.0.0.1", port=5432, timeout=2.0) -> bool:
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def cleanup_stale_pid():
    if not os.path.exists(PIDFILE):
        return "无 pid 文件"
    try:
        lines = open(PIDFILE, encoding="utf-8", errors="replace").read().splitlines()
        pid = int(lines[0].strip())
    except Exception as e:
        os.remove(PIDFILE)
        return f"pid 文件不可解析（{e}），已删"
    if pid_alive(pid):
        return f"PID {pid} 还活着，不动"
    os.remove(PIDFILE)
    return f"PID {pid} 已死 → 清掉残留 pid 文件"


def main():
    action = cleanup_stale_pid()
    print("[pg] pid 文件:", action)

    if port_open():
        print("[pg] 5432 已在监听")
    else:
        script = (
            "@echo off\r\n"
            "chcp 936 >nul\r\n"
            f'start "" /B "{os.path.join(BIN, "postgres.exe")}" -D "{DATA}"\r\n'
        )
        with open(CMD, "w", encoding="gbk", errors="replace") as f:
            f.write(script)
        subprocess.run(["cmd", "/c", CMD], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
        print("[pg] 已发出启动命令")

    # 等到能真正执行查询为止（崩溃恢复期间 TCP 会通但查询报 57P03）
    deadline = time.time() + 300
    last = ""
    while time.time() < deadline:
        try:
            r = subprocess.run(
                ["node", "-e",
                 "const{Client}=require('pg');const c=new Client({connectionString:"
                 "'postgresql://workbench:workbench@127.0.0.1:5432/workbench'});"
                 "c.connect().then(()=>c.query('select 1')).then(()=>{console.log('QUERY_OK');"
                 "return c.end()}).catch(e=>{console.log('ERR:'+(e.code||e.message));"
                 "return c.end().catch(()=>{})})"],
                cwd=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                 "apps", "server"),
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=25,
            )
            last = (r.stdout or "").strip()
        except Exception as e:
            last = f"EXC:{e}"
        print("[pg]", last[:90])
        if last == "QUERY_OK":
            print("[pg] 数据库已就绪 ✔")
            return 0
        time.sleep(6)

    print("[pg] 超时未就绪，最后状态:", last)
    return 1


if __name__ == "__main__":
    sys.exit(main())
