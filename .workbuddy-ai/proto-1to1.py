"""把原型按真实 1:1（取消 0.96 缩放、取消居中）渲染并截图。

为什么必须做这一步：
  原型 demo 页把 1400×900 的设计稿整体 scale(0.96) 居中放在 .stage 里，
  所以直接截的 S1-default-3agents.png 里，工作台只有 1344×864、四周还有壁纸。
  拿它跟"铺满窗口的桌面端"做逐像素 diff 是**错位比较** —— 数字会很差且没有意义。

本脚本在页面里把 .frame 还原成 1400×900 贴原点，再截图，得到真正的 1:1 基准图。
"""
import os, json, time, base64, socket, subprocess, urllib.request

os.environ['NO_PROXY'] = '*'
import websocket

EXE = r"C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\AI 工作台.exe"
PROT = r"J:\xwechat_files\wxid_yulc5z94mh2i22_84cf\msg\file\2026-09\workbench.work.html"
OUT = r"C:\Users\bing\workbuddy-ai\work123\docs\acceptance\ui1_5\proto-1to1.png"
PORT = 9793
UDD = r"C:\Users\bing\workbuddy-ai\work123\.workbuddy-ai\udd-1to1"
SCALE = 0.96


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


proc = subprocess.Popen([EXE, '--no-sandbox', '--remote-debugging-port=%d' % PORT,
                         '--user-data-dir=%s' % UDD],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        stdin=subprocess.DEVNULL)
print('[1] 启动', proc.pid, wait_port(PORT))

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
assert tgt, 'NO_PAGE'

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
send('Page.navigate', url='file:///' + PROT.replace('\\', '/'))
time.sleep(6)

# 还原 1:1：去掉 stage 的缩放，把 .frame 钉到原点并放大回 1/0.96
FIX = """
(() => {
  const st = document.querySelector('.stage');
  if (st) { st.style.transform = 'none'; st.style.zoom = '1'; }
  const f = document.querySelector('.frame');
  if (!f) return 'NO_FRAME';
  f.style.position = 'fixed';
  f.style.left = '0px';
  f.style.top = '0px';
  f.style.margin = '0';
  f.style.transformOrigin = '0 0';
  f.style.transform = 'none';   /* 帧自身若带 scale(0.96) 也一并去掉 */
  const r = f.getBoundingClientRect();
  return JSON.stringify({w: Math.round(r.width), h: Math.round(r.height),
                         x: Math.round(r.x), y: Math.round(r.y)});
})()
"""
print('[2] 还原后 .frame =', ev(FIX))
time.sleep(2)

# 校验关键元素是否落在设计稿位置
CHK = """
(() => {
  const g = (s) => { const e=document.querySelector(s); if(!e) return null;
    const r=e.getBoundingClientRect(); return {x:+r.x.toFixed(1), y:+r.y.toFixed(1),
    w:+r.width.toFixed(1), h:+r.height.toFixed(1)}; };
  return JSON.stringify({
    rail: g('.rail'), menu: g('.menu-btn'), tabMsg: g('.tab.tab-msg'),
    kb: g('.rail-kb'), ham: g('.hamburger'),
    sb: g('.sidebar'), pill: g('.search-pill.search-component'),
    row: g('.contact-item'), avatar: g('.contact-avatar'),
    main: g('.main-area'), ib: g('.inputbar')
  });
})()
"""
print('[3] 关键元素（应为设计稿像素）:')
print(ev(CHK))

s = send('Page.captureScreenshot', format='png')
open(OUT, 'wb').write(base64.b64decode(s['result']['data']))
print('\n[4] 1:1 原型基准图 ->', OUT, os.path.getsize(OUT), 'B')

ws.close()
proc.kill()
time.sleep(1)
print('DONE')
