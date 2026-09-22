"""UI-1.5：把验收环境**常驻**起来（供 hover 取证 / 手动复核用），直到收到停止信号。

和 ui15-compare.py 的区别：那个是「起→量→收」一次性的；
这个是「起→挂着」，给 ui15-hover.py 和人工看窗口用。

用法：
  python scripts/verify/ui15-up.py          # 起环境并挂住
  Ctrl+C 收工（会清干净自己的端口与进程）
"""
import importlib.util
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'ui1_5')
TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wbui15')
PROFILE = os.path.join(TMP, 'profile')

API_PORT = int(os.environ.get('API_PORT', '8799'))
FAKE_PORT = int(os.environ.get('FAKE_PORT', '8899'))
VITE_PORT = int(os.environ.get('VITE_PORT', '5274'))
CDP_PORT = int(os.environ.get('CDP_PORT', '9334'))
API = 'http://127.0.0.1:%d' % API_PORT
FAKE = 'http://127.0.0.1:%d' % FAKE_PORT
SERVER_LOG = os.path.join(OUTDIR, 'server-%d.log' % API_PORT)

MATCH = 'localhost:%d' % VITE_PORT
os.environ['WB20_PORT'] = str(CDP_PORT)
os.environ['WB20_MATCH'] = MATCH

_spec = importlib.util.spec_from_file_location('cdp_probe', os.path.join(HERE, 'cdp-probe.py'))
P = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(P)
P.MATCH = MATCH

NODE = shutil.which('node') or r'C:\Users\bing\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe'
DESKTOP = os.path.join(REPO, 'apps', 'desktop')
VITE_BIN = None
for c in (os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
          os.path.join(DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js')):
    if os.path.exists(c):
        VITE_BIN = c
        break

TEST_PHONE = os.environ.get('UI15_PHONE') or ('188%08d' % (int(time.time()) % 100000000))
procs = {}


def pbusy(p):
    import socket
    s = socket.socket()
    s.settimeout(0.4)
    try:
        return s.connect_ex(('127.0.0.1', p)) == 0
    finally:
        s.close()


def free_ports():
    for p in (API_PORT, FAKE_PORT, VITE_PORT, CDP_PORT):
        if not pbusy(p):
            continue
        raw = subprocess.run(['netstat', '-ano'], capture_output=True).stdout
        for line in raw.decode('utf-8', errors='replace').splitlines():
            if (':%d ' % p) in line and 'LISTENING' in line:
                pid = line.split()[-1]
                subprocess.run(['taskkill', '/F', '/T', '/PID', pid], capture_output=True)
                print('[clean] port %d -> %s' % (p, pid), flush=True)
    time.sleep(3)


def spawn(name, args, cwd, env=None, log_path=None):
    e = dict(os.environ)
    if env:
        e.update(env)
    f = open(log_path, 'wb') if log_path else subprocess.DEVNULL
    procs[name] = subprocess.Popen(args, cwd=cwd, env=e, stdout=f, stderr=subprocess.STDOUT,
                                   creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0))


def hijson(path, method='GET', token=None, body=None, base=API, timeout=30):
    data, headers = None, {}
    if token:
        headers['authorization'] = 'Bearer ' + token
    if body is not None:
        headers['content-type'] = 'application/json'
        data = json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with op.open(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or '{}')
        except Exception:  # noqa: BLE001
            return e.code, {}
    except Exception as e:  # noqa: BLE001
        return 0, {'error': str(e)}


def slog():
    try:
        return open(SERVER_LOG, encoding='utf-8', errors='replace').read()
    except Exception:  # noqa: BLE001
        return ''


def cleanup(*_):
    print('\n[up] 收工…', flush=True)
    for pr in procs.values():
        try:
            subprocess.run(['taskkill', '/F', '/T', '/PID', str(pr.pid)], capture_output=True)
        except Exception:  # noqa: BLE001
            pass
    time.sleep(1.5)
    left = [p for p in (API_PORT, FAKE_PORT, VITE_PORT, CDP_PORT) if pbusy(p)]
    print('[up] 残留端口：%s' % (left or '无'), flush=True)
    sys.exit(0)


def main():
    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)
    os.makedirs(OUTDIR, exist_ok=True)
    if os.path.isdir(TMP):
        shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(PROFILE, exist_ok=True)
    free_ports()

    print('[up] 起假模型 + 验收后端 + vite + Electron…', flush=True)
    spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], REPO,
          env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_LOG': os.path.join(OUTDIR, 'llm.jsonl')},
          log_path=os.path.join(OUTDIR, 'fake.log'))
    for _ in range(60):
        if hijson('/health', base=FAKE)[0] == 200:
            break
        time.sleep(0.5)

    spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
          env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
               'DEEPSEEK_API_KEY': 'fake-key-ui15', 'DEEPSEEK_MODEL': 'fake-ui15'},
          log_path=SERVER_LOG)
    for _ in range(120):
        if hijson('/health')[0] == 200:
            break
        time.sleep(0.5)

    spawn('vite', [NODE, VITE_BIN, '--port', str(VITE_PORT), '--strictPort'], DESKTOP,
          log_path=os.path.join(OUTDIR, 'vite.log'))
    time.sleep(4)

    spawn('electron', [NODE, 'scripts/start-electron.mjs',
                       '--user-data-dir=%s' % PROFILE,
                       '--remote-debugging-port=%d' % CDP_PORT], DESKTOP,
          env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT},
          log_path=os.path.join(OUTDIR, 'electron.log'))

    for _ in range(120):
        try:
            if P._find(MATCH, kind='page', tries=1, delay=0.2):
                break
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1.0)
    print('[up] 窗口已就绪（CDP :%d）' % CDP_PORT, flush=True)

    # ---- 登录 ----
    st, r = 0, {}
    for _ in range(6):
        st, r = hijson('/auth/sms/send', 'POST', body={'phone': TEST_PHONE})
        if st == 200:
            break
        time.sleep(5)
    import re
    code = None
    for _ in range(80):
        ms = list(re.finditer(r'\[sms:mock\][^\n]*?(\d{6})', slog()))
        if ms:
            code = ms[-1].group(1)
            break
        time.sleep(0.5)
    st, sess = hijson('/auth/login/sms', 'POST', body={'phone': TEST_PHONE, 'code': code})
    token = sess.get('token')
    print('[up] 登录 %s code=%s token=%s' % (st, code, '有' if token else '无'), flush=True)

    t = P._find(MATCH, kind='page', tries=8, delay=0.5)
    c = P.Cdp(t)
    try:
        c.send('Page.enable')
        c.js("localStorage.setItem('workbench.token', %s);"
             "localStorage.setItem('workbench.apiBase', %s); 'set'"
             % (json.dumps(token), json.dumps(API)))
        c.send('Page.reload')
    finally:
        try:
            c.ws.close()
        except Exception:  # noqa: BLE001
            pass

    for _ in range(90):
        try:
            t = P._find(MATCH, kind='page', tries=1, delay=0.2)
            c = P.Cdp(t)
            try:
                if c.js("!!document.querySelector('.wtRail')"):
                    print('[up] 工作台已登录并渲染 ✓', flush=True)
                    break
            finally:
                try:
                    c.ws.close()
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1.0)

    print('[up] 环境常驻中。跑 hover 取证：python scripts/verify/ui15-hover.py', flush=True)
    print('[up] 停止：Ctrl+C 或 kill 本进程', flush=True)
    while True:
        time.sleep(5)


if __name__ == '__main__':
    main()
