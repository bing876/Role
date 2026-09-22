"""Dump the running desktop app's real DOM tree (class + rect + text) for 1:1 auditing.

Why: I cannot look at the user's screenshot, so instead of guessing from a picture
I diff the ACTUAL rendered tree against the prototype's tree.
"""
import os, json, time, socket, base64, subprocess, urllib.request, hmac, hashlib, sys

os.environ['NO_PROXY'] = '*'
import websocket

EXE = r"C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\AI 工作台.exe"
PORT = 9788
UDD = r"C:\Users\bing\workbuddy-ai\work123\.workbuddy-ai\udd-dump"
OUT = r"C:\Users\bing\workbuddy-ai\work123\docs\acceptance\ui1_5"


def op():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def wait_port(port, timeout=40):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = socket.socket(); s.settimeout(0.4)
        try:
            s.connect(('127.0.0.1', port)); s.close(); return True
        except Exception:
            pass
        finally:
            try: s.close()
            except Exception: pass
        time.sleep(0.4)
    return False


env = {}
for line in open(r'C:\Users\bing\workbuddy-ai\work123\apps\server\.env', encoding='utf-8'):
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, v = line.split('=', 1)
        env[k.strip()] = v.strip()
SECRET = env.get('JWT_SECRET', '')


def b64u(b):
    return base64.urlsafe_b64encode(b).decode().rstrip('=')


now = int(time.time())
claims = {"sub": 1, "xyz": "bing876", "iat": now, "exp": now + 86400 * 30}
h = b64u(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(',', ':')).encode())
p = b64u(json.dumps(claims, separators=(',', ':')).encode())
sig = b64u(hmac.new(SECRET.encode(), (h + '.' + p).encode(), hashlib.sha256).digest())
TOKEN = h + '.' + p + '.' + sig
print('[1] token 已生成')

log = open(r'C:\Users\bing\workbuddy-ai\work123\.workbuddy-ai\dump.log', 'wb')
proc = subprocess.Popen([EXE, '--no-sandbox', '--remote-debugging-port=%d' % PORT,
                         '--user-data-dir=%s' % UDD],
                        stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
print('[2] 启动 pid=%d 端口=%s' % (proc.pid, wait_port(PORT)))

tgt = None
for _ in range(80):
    try:
        pages = [i for i in json.loads(op().open('http://127.0.0.1:%d/json/list' % PORT, timeout=3).read())
                 if i.get('type') == 'page']
        if pages:
            tgt = pages[0]; break
    except Exception:
        pass
    time.sleep(0.5)
if not tgt:
    print('!! NO PAGE'); proc.kill(); sys.exit(1)

ws = websocket.create_connection(tgt['webSocketDebuggerUrl'], suppress_origin=True,
                                 http_proxy_host=None, timeout=60)
mid = [0]


def send(m, **kw):
    mid[0] += 1
    i = mid[0]
    ws.send(json.dumps({'id': i, 'method': m, 'params': kw}))
    while True:
        r = json.loads(ws.recv())
        if r.get('id') == i:
            return r


def ev(e):
    r = send('Runtime.evaluate', expression=e, returnByValue=True, awaitPromise=True).get('result', {})
    if 'exceptionDetails' in r:
        return {'__exc': str(r['exceptionDetails'])[:200]}
    return r.get('result', {}).get('value')


send('Page.enable'); send('Runtime.enable')
send('Emulation.setDeviceMetricsOverride', width=1400, height=900, deviceScaleFactor=1, mobile=False)
time.sleep(3)
ev("localStorage.setItem('workbench.token', %s)" % json.dumps(TOKEN))
send('Page.reload', ignoreCache=True)
time.sleep(11)

print('[3] inner =', ev("innerWidth+'x'+innerHeight"))
print('[4] .wtApp =', ev("!!document.querySelector('.wtApp')"),
      '| .authWrap =', ev("!!document.querySelector('.authWrap')"))

DUMP = """
(sel) => {
  const root = document.querySelector(sel);
  if (!root) return 'MISSING';
  const out = [];
  const walk = (el, depth) => {
    const r = el.getBoundingClientRect();
    const cls = (el.className && typeof el.className === 'string') ? el.className : '';
    const txt = (el.childElementCount === 0 ? (el.textContent || '').trim() : '').slice(0, 28);
    out.push('  '.repeat(depth)
      + (cls || el.tagName.toLowerCase())
      + '  [' + Math.round(r.x) + ',' + Math.round(r.y) + ' '
      + Math.round(r.width) + 'x' + Math.round(r.height) + ']'
      + (txt ? '  "' + txt + '"' : ''));
    if (depth < 3) Array.from(el.children).forEach(c => walk(c, depth + 1));
  };
  walk(root, 0);
  return out.join('\\n');
}
"""

for sel in ['.wtRail', '.wtSb', '.inputBar', '.wtMain']:
    print('\n===== ' + sel + ' =====')
    print(ev("(%s)('%s')" % (DUMP, sel)))

print('\n===== 页面上所有可见文字 =====')
print(ev("""
(() => {
  const out = [];
  document.querySelectorAll('*').forEach(el => {
    if (el.childElementCount === 0) {
      const t = (el.textContent || '').trim();
      if (t && el.getBoundingClientRect().width > 0) out.push(t.slice(0, 40));
    }
  });
  return out.join(' | ');
})()
"""))

s = send('Page.captureScreenshot', format='png')
fp = os.path.join(OUT, 'dump-app.png')
open(fp, 'wb').write(base64.b64decode(s['result']['data']))
print('\n[5] 截图 ->', fp, os.path.getsize(fp), 'B')

ws.close(); proc.kill()
print('DONE')
