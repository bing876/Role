"""跑既有的「暂停/继续」回归测试（方案 B 的五条验收标准）。

## 为什么要有这个包装
`pause-resume-tests.py` 自己会起假模型 / 假页面 / 验收后端 / vite / 真 Electron 窗口，
但它**不负责把 PostgreSQL 拉起来** —— 它只轮询 `/health` 等 `db == "up"`。
而本机 PG 经常处于「已被回收」或「崩溃恢复中」的状态，不先弄好，
整个回归会以"验收后端起不来"草草失败，看起来像代码坏了。

所以这里：先确保 PG 真能查表 → 再原样调 `pause-resume-tests.py`（不改它一行）。

★ 必须在**一次工具调用**里跑完：本机 agent 沙箱会在调用结束时回收派生进程，
  跨调用编排必然让 PG / 服务端在下一轮消失。

用法： python scripts/verify/run-pause-resume.py
"""
import os
import re
import socket
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SERVER_DIR = os.path.join(REPO, "apps", "server")
NODE = "node"

# 这个测试要用的端口（见 pause-resume-tests.py 顶部）
PORTS = {"API": 8791, "fake-llm": 8891, "site2": 8892, "site3": 8893,
         "vite": 5178, "CDP": 9341}


def port_busy(port, host="127.0.0.1", timeout=1.2):
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def pid_alive(pid):
    try:
        out = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/NH", "/FO", "CSV"],
                             capture_output=True, text=True, encoding="utf-8",
                             errors="replace", timeout=15).stdout
        return ('"%d"' % pid) in out
    except Exception:
        return False


def kill_all_pg():
    """先把**所有** postgres 杀掉，确保后面只跑一个实例。

    ★ 为什么必须这么做（踩过）：PG 崩溃恢复期间**端口就已经在监听**了，
      于是 `if not port_busy(5432): 启动` 这种判断会在"上一个实例还在恢复、
      但端口还没绑定"的瞬间误判成"没在跑"，于是**再起一个实例** ——
      两个 postmaster 抢同一个 data 目录，互相把对方撞死，数据目录被写脏，
      下一个实例又要做恢复……表现成"刚起来就 57P03"的死循环。
      所以宁可先全杀干净，再起唯一一个。
    """
    subprocess.run(["taskkill", "/F", "/IM", "postgres.exe"], capture_output=True,
                   text=True, encoding="utf-8", errors="replace", timeout=30)
    time.sleep(3)


def ensure_pg():
    pg_home = os.path.join(os.path.expanduser("~"), "workbuddy-ai", "pg2")
    bin_dir = os.path.join(pg_home, "pg", "bin")
    data_dir = os.path.join(pg_home, "data")
    pid_file = os.path.join(data_dir, "postmaster.pid")

    kill_all_pg()

    # 现在 PG 一定没在跑 → pid 文件必然是残留的
    if os.path.exists(pid_file):
        try:
            os.remove(pid_file)
            print("  [pg] 清掉残留 pid 文件")
        except Exception as e:
            print("  [pg] 清 pid 失败：", e)
            return False

    launcher = os.path.join(pg_home, "_boot.cmd")
    with open(launcher, "w", encoding="gbk", errors="replace") as f:
        f.write("\r\n".join([
            "@echo off", "chcp 936 >nul",
            'start "" /B "%s" -D "%s"' % (os.path.join(bin_dir, "postgres.exe"), data_dir),
        ]) + "\r\n")
    subprocess.run(["cmd", "/c", launcher], stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=30)
    print("  [pg] 已启动唯一实例")

    # 只要「查询成功」就开跑 —— **不要求连续多次**。
    # ★ 为什么放宽（前台跑 postgres 才看明白的）：
    #   本机沙箱会周期性 SIGTERM 掉 postgres 的子进程，日志里是
    #     `background worker "logical replication launcher" exited with exit code 143`
    #     `terminating any other active server processes` → 重新初始化 → 又一轮恢复。
    #   也就是说 PG 会**周期性自己重启**，这是环境限制、不是数据损坏。
    #   要求"连续 3 次成功"会因为撞上重启窗口而永远等不到 ——
    #   真实策略应该是"看到能查就赶紧跑"，由测试自身的重试去吸收抖动。
    probe = ("const{Client}=require('pg');const c=new Client({connectionString:"
             "'postgresql://workbench:workbench@127.0.0.1:5432/workbench'});"
             "c.connect().then(()=>c.query('select 1')).then(()=>{console.log('QUERY_OK');"
             "return c.end()}).catch(e=>{console.log('ERR:'+(e.code||e.message));"
             "return c.end().catch(()=>{})})")
    end = time.time() + 300
    last = ""
    while time.time() < end:
        try:
            r = subprocess.run([NODE, "-e", probe], cwd=SERVER_DIR, capture_output=True,
                               text=True, encoding="utf-8", errors="replace", timeout=25)
            last = (r.stdout or "").strip()
        except Exception as e:
            last = "EXC:%s" % e
        if last == "QUERY_OK":
            print("  [pg] 数据库可查询 ✔（立即开跑，抖动交给测试自身重试吸收）")
            return True
        print("  [pg] 等待恢复…", last[:50])
        time.sleep(5)
    print("  [pg] 超时未就绪")
    return False


def main():
    print("=" * 70)
    print("暂停/继续 回归（既有验收脚本，原样调用）")
    print("=" * 70)

    print("\n[0] 端口自检（EADDRINUSE 会伪装成「服务起不来」）")
    busy = [("%s(%d)" % (k, p)) for k, p in PORTS.items() if port_busy(p)]
    if busy:
        print("  !! 这些端口已被占用，先腾出来：", "、".join(busy))
        return 2
    print("  全部空闲 ✔")

    print("\n[1] 确保数据库可用")
    if not ensure_pg():
        return 1

    print("\n[2] 跑 pause-resume-tests.py（原样，不改它）")
    outdir = os.path.join(REPO, "docs", "acceptance", "pause-resume")
    os.makedirs(outdir, exist_ok=True)
    log = os.path.join(outdir, "rerun-after-p1.log")
    with open(log, "w", encoding="utf-8", errors="replace") as f:
        r = subprocess.run([sys.executable, "-u", os.path.join(HERE, "pause-resume-tests.py")],
                           cwd=REPO, stdout=f, stderr=subprocess.STDOUT, timeout=2400)
    txt = open(log, encoding="utf-8", errors="replace").read()

    # ★ 只回显统计与结论，**不要**再打印 `txt[-4000:]` 那种"尾部切片"：
    #   切片会从半截开始（上次就是这样：日志从 ③ 开始，看着像前半段没跑），
    #   而真实完整日志在 log 文件里。要看细节去看文件，终端只给结论。
    n_pass = len(re.findall(r"^\s*\[PASS\]", txt, re.M))
    n_fail = len(re.findall(r"^\s*\[FAIL\]", txt, re.M))
    print("    完整日志：%s（%d 行）" % (log, txt.count("\n") + 1))
    print("    断言：PASS %d / FAIL %d" % (n_pass, n_fail))
    print("\n    ---- 各 section ----")
    for line in txt.splitlines():
        s = line.strip()
        if re.match(r"^[①-⑦]\s|^\d+\.\s", s) and len(s) < 60:
            print("      " + s)
    fails = [x.strip() for x in re.findall(r"^\s*\[FAIL\]\s*(.+)$", txt, re.M)]
    if fails:
        print("\n    ---- 失败项 ----")
        for x in fails:
            print("      ✗", x)
    print("\n    ---- 结论 ----")
    for l in [l for l in txt.splitlines() if l.strip()][-6:]:
        print("      " + l.strip())
    return r.returncode


if __name__ == "__main__":
    sys.exit(main())
