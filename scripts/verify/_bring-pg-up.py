"""把本机那个便携 PostgreSQL 拉起来，并**真的等它可查**（不是等端口通）。

为什么要单独写它（本机踩过的两个坑，缺一个就会误判）：
  1. `data/postmaster.pid` 残留 → postgres **静默拒启**（日志里什么都没有，进程直接没影）。
     所以启动前必须先确认「没有 postgres 进程」再删掉残留的 pid 文件。
  2. **端口通 ≠ 可查**：崩溃恢复期间 5432 早就监听了，但任何查询都报
     `the database system is starting up`。判据必须是 `SELECT 1` 真的成功。

用法：python scripts/verify/_bring-pg-up.py   （退出码 0 = 数据库可用）
"""
import os
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
PG2 = os.path.join(os.path.expanduser('~'), 'workbuddy-ai', 'pg2')
DATA = os.path.join(PG2, 'data')
POSTGRES = os.path.join(PG2, 'pg', 'bin', 'postgres.exe')
PING = os.path.join(PG2, 'ping-db.mjs')
NODE = 'node'


def kill_all_postgres():
    """本机规矩：先全杀，再起唯一一个 —— 两个 postmaster 抢同一 data 目录会互相撞死。"""
    subprocess.run(['taskkill', '/F', '/IM', 'postgres.exe'],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def running():
    """有没有活着的 postgres。

    ⚠️ `tasklist` 在中文 Windows 上输出的是 **GBK**，用 utf-8 解码会直接抛
    `UnicodeDecodeError`（异常发生在 subprocess 的读线程里，不进主流程、很隐蔽），
    于是 `running()` 恒为 False —— 会把「正在做崩溃恢复的实例」误判成没在跑，
    然后删它的 pid 文件、再起一个，两边抢同一个 data 目录互相撞死。
    所以这里必须显式按 GBK 解、并且失败时**如实抛**而不是静默吞掉。
    """
    try:
        raw = subprocess.run(['tasklist'], capture_output=True, timeout=20).stdout
        out = raw.decode('gbk', errors='replace')
        return 'postgres.exe' in out.lower()
    except Exception as e:
        print('  · 查进程失败（按「没在跑」处理）：%s' % e)
        return False


def clear_stale_pid():
    pid_file = os.path.join(DATA, 'postmaster.pid')
    if os.path.exists(pid_file):
        # 只有确认没有活进程时才删（正在跑的库绝不能动它的 pid 文件）
        if not running():
            os.remove(pid_file)
            print('  · 清掉残留的 postmaster.pid（无活进程）')
        else:
            print('  · 有活进程，pid 文件保持不动')


def ping():
    """★ `cwd` 必须是**仓库根**，不能是 pg2 —— 那目录里没有 `node_modules/pg`，
    `ping-db.mjs` 一 import pg 就抛错，于是 `returncode != 0`，
    看上去像「数据库没起来」，其实库早就 ready 了（本轮就是被这个骗了 5 分钟）。
    """
    try:
        r = subprocess.run([NODE, PING], capture_output=True, timeout=30, cwd=REPO)
        return r.returncode == 0
    except Exception:
        return False


def main():
    print('=' * 70)
    print('把便携 PG 拉起来')
    print('=' * 70)
    for p in (POSTGRES, PING):
        if not os.path.exists(p):
            print('  [MISS] 缺少 %s' % p)
            return 1
    if ping():
        print('  [OK] 数据库本来就可查，不用起')
        return 0

    kill_all_postgres()
    time.sleep(1.5)
    clear_stale_pid()

    # ★★ 必须用 `cmd /c start "" /B` 启动，不能直接 Popen。
    #
    # 本机实测：直接 Popen 起的 postgres 会**随着发起它的那次工具调用一起被清掉**
    # （调用一结束进程就没了，下一次调用里查不到任何 postgres）。
    # 于是「这一调用起库、下一调用跑验收」永远连不上 —— 表现是服务端 `/health` 报
    # `db=down`，很容易误判成"代码改坏了"。
    # `start /B` 起的进程会脱离调用方的作业，跨调用存活。
    logf = open(os.path.join(PG2, 'pg.log'), 'ab')
    print('  · 启动 postgres（脱离式：cmd start /B）…')
    subprocess.Popen(
        ['cmd', '/c', 'start', '', '/B', POSTGRES, '-D', DATA],
        cwd=PG2, stdout=logf, stderr=subprocess.STDOUT,
        creationflags=0x00000008,
    )

    # 崩溃恢复（syncing data directory）实测要 1~5 分钟，中途**绝不能打断**：
    # 打断一次就得从头再来一遍 fsync。所以这里给足 300 秒，判据仍是 SELECT 1 成功。
    t0 = time.time()
    while time.time() - t0 < 300:
        time.sleep(5)
        if ping():
            print('  [OK] 数据库可查（耗时 %.0fs）' % (time.time() - t0))
            return 0
    print('  [MISS] 等了 300 秒仍不可查；看 pg2/pg.log')
    return 1


if __name__ == '__main__':
    sys.exit(main())
