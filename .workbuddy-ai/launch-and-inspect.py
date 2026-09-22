"""Launch + connect + seed token + reload + measure + screenshot, ALL IN ONE PROCESS.

Why one process: a GUI process started from a Bash tool call is reaped as soon as the
call returns, so `launch` and `inspect` cannot be two separate calls. Keep everything
inside one python invocation and end it by killing the app.
"""
import os, json, time, socket, base64, subprocess, urllib.request, hmac, hashlib, sys

os.environ['NO_PROXY'] = '*'
import websocket

EXE = r"C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\AI 工作台.exe"
PORT = 9781
OUT = r"C:\Users\bing\workbuddy-ai\work123\docs\acceptance\ui1_5"
UDD = r"C:\Users\bing\workbuddy-ai\work123\.workbuddy-ai\udd-ui16"


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


# ---- token -----------------------------------------------------------------
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
print('[1] token 已生成 len=%d' % len(SECRET))
try:
    req = urllib.request.Request('http://127.0.0.1:8787/auth/me',
                                 headers={'Authorization': 'Bearer ' + TOKEN})
    r = op().open(req, timeout=5)
    print('    /auth/me ->', r.status)
except Exception as e:
    print('    /auth/me 失败:', repr(e)[:120])

# ---- launch ----------------------------------------------------------------
log = open(r'C:\Users\bing\workbuddy-ai\work123\.workbuddy-ai\launchX.log', 'wb')
proc = subprocess.Popen([EXE, '--no-sandbox', '--remote-debugging-port=%d' % PORT,
                         '--user-data-dir=%s' % UDD],
                        stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
print('[2] 启动 pid=%d  端口就绪=%s' % (proc.pid, wait_port(PORT)))

# ---- find page -------------------------------------------------------------
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
    print('!! 找不到 page，/json/list 内容：')
    try:
        print(op().open('http://127.0.0.1:%d/json/list' % PORT, timeout=3).read()[:800])
    except Exception as e:
        print('  读取失败', repr(e)[:120])
    proc.kill(); sys.exit(1)
print('[3] page:', str(tgt.get('url'))[:100])

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

print('[4] origin:', ev("location.origin"))
ev("localStorage.setItem('workbench.token', %s)" % json.dumps(TOKEN))
send('Page.reload', ignoreCache=True)
time.sleep(11)

print('\n=== 登录后 ===')
print('  url        :', str(ev("location.href"))[:110])
print('  .wtApp     :', ev("!!document.querySelector('.wtApp')"))
print('  .authWrap  :', ev("!!document.querySelector('.authWrap')"))
print('  inner      :', ev("innerWidth+'x'+innerHeight"))

print('\n=== 关键结构（照原型重写后）===')
checks = [
    ('.wtRail', "(()=>{const e=document.querySelector('.wtRail');if(!e)return 'MISSING';const r=e.getBoundingClientRect();const c=getComputedStyle(e);return JSON.stringify({w:Math.round(r.width),h:Math.round(r.height),radius:c.borderRadius,bg:c.backgroundColor});})()"),
    ('.wtRail__me', "(()=>{const e=document.querySelector('.wtRail__me');if(!e)return 'MISSING';const r=e.getBoundingClientRect();return JSON.stringify({x:+r.x.toFixed(1),y:+r.y.toFixed(1),w:Math.round(r.width),h:Math.round(r.height)});})()"),
    ('rail tab 数', "document.querySelectorAll('.wtRail__tab').length"),
    ('rail quickAdd', "!!document.querySelector('.wtRail__quickAdd')"),
    ('rail settings', "!!document.querySelector('.wtRail__settings')"),
    ('.wtSb 宽', "(()=>{const e=document.querySelector('.wtSb');if(!e)return 'MISSING';return Math.round(e.getBoundingClientRect().width);})()"),
    ('.wtSb__searchPill', "(()=>{const e=document.querySelector('.wtSb__searchPill');if(!e)return 'MISSING';const r=e.getBoundingClientRect();const c=getComputedStyle(e);return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),radius:c.borderRadius});})()"),
    ('联系人行数', "document.querySelectorAll('.wtSb__row').length"),
    ('.inputBar', "(()=>{const e=document.querySelector('.inputBar');if(!e)return 'MISSING';const r=e.getBoundingClientRect();const c=getComputedStyle(e);return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),radius:c.borderRadius});})()"),
    ('.inputBar 底色', "(()=>{const e=document.querySelector('.inputBar');if(!e)return 'MISSING';const c=getComputedStyle(e);return c.backgroundColor+' | pad='+c.padding+' | borderTop='+c.borderTopWidth;})()"),
    ('.inputBar__send', "(()=>{const e=document.querySelector('.inputBar__send');if(!e)return 'MISSING';const r=e.getBoundingClientRect();const c=getComputedStyle(e);return JSON.stringify({w:Math.round(r.width),h:Math.round(r.height),bg:c.backgroundColor});})()"),
    ('.inputBar__attach', "(()=>{const e=document.querySelector('.inputBar__attach');if(!e)return 'MISSING';const r=e.getBoundingClientRect();const c=getComputedStyle(e);return JSON.stringify({w:Math.round(r.width),h:Math.round(r.height),bg:c.backgroundColor});})()"),
    ('.plugOutside', "(()=>{const e=document.querySelector('.plugOutside');if(!e)return 'MISSING';const r=e.getBoundingClientRect();const c=getComputedStyle(e);return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),gap:c.gap});})()"),
    ('.plugBtn ×N', "document.querySelectorAll('.plugBtn').length"),
    ('.plugBtn[0]', "(()=>{const e=document.querySelector('.plugBtn');if(!e)return 'MISSING';const r=e.getBoundingClientRect();const c=getComputedStyle(e);return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),radius:c.borderRadius,bg:c.backgroundColor});})()"),
    ('.plugH / .plugV', "(()=>{const h=document.querySelector('.plugH'),v=document.querySelector('.plugV');if(!h||!v)return 'MISSING';const a=h.getBoundingClientRect(),b=v.getBoundingClientRect();return JSON.stringify({h:[+a.width.toFixed(1),+a.height.toFixed(1)],v:[+b.width.toFixed(1),+b.height.toFixed(1)],bg:getComputedStyle(h).backgroundColor});})()"),
    ('浏览器占位还在吗', "!!document.querySelector('.wtMain__empty')"),
    ('body class', "document.body.className"),
]
for name, expr in checks:
    print('  %-18s: %s' % (name, ev(expr)))

s = send('Page.captureScreenshot', format='png')
fp = os.path.join(OUT, 'app-ui16.png')
open(fp, 'wb').write(base64.b64decode(s['result']['data']))
print('\n[5] 截图 ->', fp, os.path.getsize(fp), 'B')

ws.close()
proc.kill()
time.sleep(1)
print('DONE')
