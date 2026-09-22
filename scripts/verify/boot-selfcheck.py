# -*- coding: utf-8 -*-
"""
boot-selfcheck.py —— 复刻 start-dev.cmd 的全部逻辑做一次「同调用内」自检。
用途：证明 start-dev.cmd 会成功（PG 就绪 -> 服务端就绪 -> /health db:up）。
注意：agent 工具调用结束会回收派生进程，所以本脚本只用于自检，不用于常驻。
"""
import subprocess, time, os, socket, sys, urllib.request

HOME = os.path.expanduser('~')
PG_HOME = os.path.join(HOME, 'workbuddy-ai', 'pg2')
PG_BIN = os.path.join(PG_HOME, 'pg', 'bin')
PG_DATA = os.path.join(PG_HOME, 'data')
REPO = r'C:\Users\bing\workbuddy-ai\work123'
NODE = os.path.join(HOME, '.workbuddy-ai', 'binaries', 'node', 'versions', '22.22.2-2', 'node.exe')


def port_open(p):
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect(('127.0.0.1', p))
        return True
    except Exception:
        return False
    finally:
        s.close()


def alive(pid):
    r = subprocess.run(['tasklist', '/FI', 'PID eq ' + pid, '/NH', '/FO', 'CSV'],
                       capture_output=True)
    return ('"' + pid + '"') in r.stdout.decode('gbk', errors='replace')


# 0) 自检
if not os.path.exists(os.path.join(PG_BIN, 'postgres.exe')):
    print('[FAIL] 找不到 postgres.exe'); sys.exit(1)
print('[0] 自检 OK  PG_BIN=', PG_BIN)

# 1) 清陈旧 pid
pidf = os.path.join(PG_DATA, 'postmaster.pid')
if os.path.exists(pidf):
    old = open(pidf).readline().strip()
    if alive(old):
        print('[1] pid %s 仍活着 -> pg_ctl stop' % old)
        subprocess.run([os.path.join(PG_BIN, 'pg_ctl.exe'), 'stop', '-D', PG_DATA, '-m', 'immediate'],
                       capture_output=True)
        time.sleep(3)
        if os.path.exists(pidf):
            os.remove(pidf)
    else:
        os.remove(pidf)
        print('[1] 陈旧 pid %s 已死 -> 删除' % old)
else:
    print('[1] 无 pid 残留')

print('[1] 开局端口: 5432=%s 8787=%s' % (port_open(5432), port_open(8787)))

# 2) 起 PG
if not port_open(5432):
    subprocess.Popen(
        ['cmd', '/c', 'start "AItest-PG" /MIN "%s" -D "%s"'
         % (os.path.join(PG_BIN, 'postgres.exe'), PG_DATA)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
        creationflags=0x00000008 | 0x00000200)
for i in range(1, 61):
    if port_open(5432):
        print('[2] PG 就绪，用时 %ds' % i)
        break
    time.sleep(1)
else:
    print('[2][FAIL] 60s 内 5432 没起来'); sys.exit(1)

# 3) 起服务端
if not port_open(8787):
    subprocess.Popen(
        ['cmd', '/c', 'start "AItest-SRV" /MIN cmd /c ""%s" "%s\\node_modules\\tsx\\dist\\cli.mjs" src\\index.ts"'
         % (NODE, REPO)],
        cwd=os.path.join(REPO, 'apps', 'server'),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
        creationflags=0x00000008 | 0x00000200)
for i in range(1, 91):
    if port_open(8787):
        print('[3] 服务端就绪，用时 %ds' % i)
        break
    time.sleep(1)
else:
    print('[3][FAIL] 90s 内 8787 没起来'); sys.exit(1)

# 4) /health
ok = False
for attempt in range(10):
    try:
        h = urllib.request.urlopen('http://127.0.0.1:8787/health', timeout=5).read().decode()
        print('[4] HEALTH: %s' % h[:500])
        if '"up"' in h or '"db":"up"' in h.replace(' ', ''):
            ok = True
        break
    except Exception as e:
        print('[4] retry %d: %s' % (attempt, e))
        time.sleep(2)

# 5) 服务端日志里的 migrate 字样
log = os.path.join(REPO, 'apps', 'server', 'dev-server.log')
if not os.path.exists(log):
    for cand in ['server.log', 'dev-run.log', os.path.join(REPO, 'dev-run.log')]:
        p = cand if os.path.isabs(cand) else os.path.join(REPO, cand)
        if os.path.exists(p):
            log = p
            break
if os.path.exists(log):
    t = open(log, encoding='utf-8', errors='replace').read()
    print('[5] 日志里含「数据库表就绪」: %s' % ('数据库表就绪' in t))
else:
    print('[5] 未找到服务端日志文件（跳过）')

print('[RESULT] %s' % ('PASS' if ok else 'FAIL'))
sys.stdout.flush()
