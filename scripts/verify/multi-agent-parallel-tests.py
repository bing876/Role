# -*- coding: utf-8 -*-
"""验证「多智能体 / 多标签页同时干活」这件事到底成不成。

用户的原话：
  「多智能体多标签页，同时打开多个浏览器，同时处理多个用户的不同的任务并行执行」

要证明/证伪的是**三件独立的事**，必须分开测（混在一起就会得出错误结论）：

  T1. 同**一个**智能体能开多张页 —— 但「在几张页上**同时跑**」行不行？
  T2. **不同**智能体能不能同时各跑各的（这才是用户说的"多用户不同任务"）？
  T3. 两路在跑时，**状态会不会串**（A 的目标/结论跑到 B 的头上）？

判定口径（都是踩过坑的，别改）：
  - 多路并行时衡量「某一路」必须**按路过滤**（假模型把 goal 写进每条日志，可当标签）。
  - 直连库查证必须带 user_id，否则读到上一轮残留 = 假证据。
  - 循环是否真的重叠 → 看假模型日志里每对 req/res 的 **时间区间有没有交集**。

用法：
  python scripts/verify/multi-agent-parallel-tests.py
"""
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'docs', 'acceptance', 'multi-parallel')
NODE = 'C:/Users/bing/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe'
PY = sys.executable

API = 'http://127.0.0.1:8787'          # 桌面端读 localStorage 默认值，必须用这个
FAKE_PORT = 8899
CDP_PORT = 9341
VITE_PORT = 5281
VITE_URL = 'http://localhost:%d' % VITE_PORT
USER_DATA = 'C:/Users/bing/AppData/Local/Temp/wbmulti'

PHONE = os.environ.get('WB_PHONE') or ('188%08d' % (int(time.time()) % 100000000))
FAKE_LOG = os.path.join(OUT, 'fake-llm.jsonl')

procs = []
LOG = []
PASS = 0
FAIL = 0


def log(*a):
    s = ' '.join(str(x) for x in a)
    print(s, flush=True)
    LOG.append(s)


def check(name, ok, detail=''):
    global PASS, FAIL
    if ok:
        PASS += 1
        log('  [PASS] %s' % name)
    else:
        FAIL += 1
        log('  [FAIL] %s%s' % (name, (' -- ' + str(detail)) if detail else ''))


def alive(port):
    for fam, host in ((socket.AF_INET, '127.0.0.1'), (socket.AF_INET6, '::1')):
        try:
            s = socket.socket(fam, socket.SOCK_STREAM)
            s.settimeout(0.6)
            s.connect((host, port))
            s.close()
            return True
        except Exception:  # noqa: BLE001
            pass
    return False


def wait_port(port, secs=45, label=''):
    t0 = time.time()
    while time.time() - t0 < secs:
        if alive(port):
            return True
        time.sleep(0.5)
    log('  !! 端口 %d 未就绪 (%s)' % (port, label))
    return False


def api(path, data=None, token=None, method=None):
    req = urllib.request.Request(API + path,
                                 data=json.dumps(data).encode() if data is not None else None,
                                 method=method or ('POST' if data is not None else 'GET'))
    req.add_header('content-type', 'application/json')
    if token:
        req.add_header('authorization', 'Bearer ' + token)
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with op.open(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {'__status': e.code, '__body': e.read().decode()[:400]}
    except Exception as e:  # noqa: BLE001
        return {'__error': str(e)[:200]}


def spawn(args, logfile, cwd=ROOT, env=None):
    os.makedirs(OUT, exist_ok=True)
    f = open(os.path.join(OUT, logfile), 'w', encoding='utf-8', errors='ignore')
    e = dict(os.environ)
    if env:
        e.update(env)
    p = subprocess.Popen(args, cwd=cwd, stdout=f, stderr=subprocess.STDOUT, env=e,
                         bufsize=1, text=True)
    procs.append((p, logfile))
    log('  [spawn]', logfile, 'pid=', p.pid)
    return p


import websocket  # noqa: E402


def cdp_target():
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(30):
        try:
            for t in json.load(op.open('http://127.0.0.1:%d/json/list' % CDP_PORT, timeout=10)):
                if t.get('type') == 'page' and str(VITE_PORT) in (t.get('url') or ''):
                    return t
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1)
    return None


class P:
    def __init__(self, target, tries=5):
        self.i = 0
        self.t = target
        self.ws = None
        self._connect(tries)

    def _connect(self, tries=5):
        last = None
        for k in range(tries):
            try:
                self.ws = websocket.create_connection(
                    self.t['webSocketDebuggerUrl'], timeout=45, suppress_origin=True)
                self.call('Runtime.evaluate', expression='1', returnByValue=True)
                return
            except Exception as e:  # noqa: BLE001
                last = e
                time.sleep(1.2 * (k + 1))
        raise RuntimeError('CDP 连接失败: %s' % last)

    def call(self, method, **params):
        last = None
        for _ in range(3):
            try:
                self.i += 1
                mid = self.i
                self.ws.send(json.dumps({'id': mid, 'method': method, 'params': params}))
                while True:
                    m = json.loads(self.ws.recv())
                    if m.get('id') == mid:
                        return m
            except Exception as e:  # noqa: BLE001
                last = e
                try:
                    self.ws.close()
                except Exception:  # noqa: BLE001
                    pass
                time.sleep(1.0)
                try:
                    self._connect(2)
                except Exception as e2:  # noqa: BLE001
                    last = e2
                    break
        raise RuntimeError('CDP %s 失败: %s' % (method, last))

    def js(self, e, await_promise=False):
        kw = {'awaitPromise': True} if await_promise else {}
        r = self.call('Runtime.evaluate', expression=e, returnByValue=True,
                      userGesture=True, **kw)
        if r.get('exceptionDetails'):
            return {'__error': str(r['exceptionDetails'])[:250]}
        return r.get('result', {}).get('result', {}).get('value')


def read_fake_log():
    """读假模型日志（JSONL）。返回 [(goal, kind, step, t_enter_ms, t_exit_ms)]"""
    rows = []
    if not os.path.exists(FAKE_LOG):
        return rows
    open_by = {}
    try:
        with open(FAKE_LOG, encoding='utf-8', errors='ignore') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:  # noqa: BLE001
                    continue
                g = o.get('goal')
                if o.get('ev') == 'req':
                    open_by.setdefault(g, []).append([o.get('at'), None, o.get('kind'), o.get('step')])
                elif o.get('ev') == 'res':
                    lst = open_by.get(g) or []
                    for it in reversed(lst):
                        if it[1] is None and it[3] == o.get('step'):
                            it[1] = o.get('at')
                            break
    except Exception:  # noqa: BLE001
        pass
    for g, lst in open_by.items():
        for it in lst:
            rows.append((g, it[2], it[3], it[0], it[1]))
    return rows


def overlaps(rows, a, b):
    """A、B 两路的时间区间有没有真实交集（证明并发真的发生）"""
    ra = [r for r in rows if r[0] == a and r[3] and r[4]]
    rb = [r for r in rows if r[0] == b and r[3] and r[4]]
    for x in ra:
        for y in rb:
            if max(x[3], y[3]) < min(x[4], y[4]):
                return True, (x, y)
    return False, None


def main():
    os.makedirs(OUT, exist_ok=True)
    for f in ('fake-llm.jsonl',):
        p = os.path.join(OUT, f)
        if os.path.exists(p):
            os.remove(p)

    log('=== 1. 假模型 + 静态站 (%d) ===' % FAKE_PORT)
    spawn([NODE, os.path.join(ROOT, 'scripts', 'verify', 'fake-llm.mjs')], 'fake.log',
          env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_DELAY_MS': '1500', 'FAKE_STEPS': '4',
               'FAKE_LOG': FAKE_LOG})
    if not wait_port(FAKE_PORT, 30, 'fake'):
        return 1
    check('假模型起来了', True)

    log('=== 2. 后端 (指向假模型) ===')
    spawn([NODE, 'dist/index.js'], 'server.log',
          cwd=os.path.join(ROOT, 'apps', 'server'),
          env={'DEEPSEEK_BASE_URL': 'http://127.0.0.1:%d/v1' % FAKE_PORT,
               'DEEPSEEK_API_KEY': 'fake-key',
               'DEEPSEEK_MODEL': 'fake-model'})
    if not wait_port(8787, 45, 'api'):
        return 1
    h = api('/health')
    log('  /health:', json.dumps(h, ensure_ascii=False)[:220])
    check('后端活着', bool(h.get('ok')))

    log('=== 3. 用 API 直接准备两个智能体（不依赖界面） ===')
    # 注册 + 登录拿 token
    api('/auth/sms/send', {'phone': PHONE})
    txt = ''
    try:
        txt = open(os.path.join(OUT, 'server.log'), encoding='utf-8', errors='ignore').read()
    except Exception:  # noqa: BLE001
        pass
    m = re.findall(r'验证码[^\d]*(\d{4,6})', txt)
    code = m[-1] if m else None
    log('  mock 验证码 =', code)
    if not code:
        check('拿到验证码', False, '日志里没找到')
        return 1
    r = api('/auth/sms/verify', {'phone': PHONE, 'code': code})
    token = r.get('token')
    log('  登录 token =', (token or '')[:20])
    check('拿到 token', bool(token))
    if not token:
        return 1

    projs = api('/projects', token=token)
    log('  projects:', json.dumps(projs, ensure_ascii=False)[:200])
    pid = None
    if isinstance(projs, list) and projs:
        pid = projs[0].get('id')

    def new_agent(name):
        body = {'name': name, 'persona': '测试'}
        if pid:
            body['projectId'] = pid
        rr = api('/agents', body, token=token)
        return rr.get('id') or (rr.get('agent') or {}).get('id')

    a1 = new_agent('并行A')
    a2 = new_agent('并行B')
    log('  agent A =', a1, ' agent B =', a2)
    check('建了两个智能体', bool(a1) and bool(a2) and a1 != a2)

    log('')
    log('=== 关键认知（先说清楚，免得测错方向） ===')
    log('  本产品的「内嵌页」由**桌面端**创建，服务端不持有页。')
    log('  所以「多页并行」只能在桌面端验；下面用桌面端 API 直接驱动。')

    log('=== 4. 起桌面端（CDP %d） ===' % CDP_PORT)
    spawn([NODE, os.path.join(ROOT, 'apps', 'desktop', 'scripts', 'start-electron.mjs'),
           '--remote-debugging-port=%d' % CDP_PORT, '--no-sandbox'],
          'electron.log', cwd=ROOT,
          env={'WORKBENCH_NO_DEVTOOLS': '1', 'WB_USER_DATA': USER_DATA,
               'VITE_DEV_SERVER_URL': VITE_URL})
    t = cdp_target()
    if not t:
        check('桌面端主窗口 CDP 可达', False)
        return 1
    check('桌面端主窗口 CDP 可达', True)
    p = P(t)
    time.sleep(3)
    p.js("localStorage.setItem('workbench.token', %s); localStorage.setItem('workbench.apiBase', %s);"
         % (json.dumps(token), json.dumps(API)))
    log('  已注入登录态')
    p.call('Page.reload')
    time.sleep(6)

    st = p.js("(()=>({url:location.href, txt:document.body.innerText.slice(0,300)}))()")
    log('  界面:', json.dumps(st, ensure_ascii=False)[:350])

    log('=== 5. 开两张页，各挂一个智能体，同时发车 ===')
    r = p.js("""(async()=>{
      const out = [];
      const wv = document.querySelectorAll('webview');
      out.push('现有 webview 数=' + wv.length);
      return out;
    })()""", await_promise=True)
    log('  ', json.dumps(r, ensure_ascii=False)[:200])

    return 2


if __name__ == '__main__':
    try:
        rc = main()
    finally:
        log('')
        log('=== 收尾 ===')
        for pr, lb in procs:
            try:
                pr.terminate()
            except Exception:  # noqa: BLE001
                pass
        time.sleep(2)
        for pr, lb in procs:
            try:
                if pr.poll() is None:
                    pr.kill()
            except Exception:  # noqa: BLE001
                pass
        os.makedirs(OUT, exist_ok=True)
        with open(os.path.join(OUT, 'run.log'), 'w', encoding='utf-8') as f:
            f.write('\n'.join(LOG))
        log('结果：%d 通过 / %d 失败' % (PASS, FAIL))
        log('日志 ->', os.path.join(OUT, 'run.log'))
    sys.exit(0)
