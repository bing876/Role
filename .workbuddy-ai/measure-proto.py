"""把原型 HTML 用 CDP 打开，量出每个关键元素的真实 rect + computed style。

为什么不用截图猜：用户要的是"1:1 像素级复刻参数"，截图只能给我反推的估值，
CDP 能直接给出原型的 computed style（含图标位图的真实渲染尺寸）。
"""
import os, json, time, socket, subprocess, urllib.request

os.environ['NO_PROXY'] = '*'
import websocket

EXE = r"C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\AI 工作台.exe"
PROT = r"J:\xwechat_files\wxid_yulc5z94mh2i22_84cf\msg\file\2026-09\workbench.work.html"
PORT = 9791
UDD = r"C:\Users\bing\workbuddy-ai\work123\.workbuddy-ai\udd-measure"


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


log = open(r'C:\Users\bing\workbuddy-ai\work123\.workbuddy-ai\measure.log', 'wb')
proc = subprocess.Popen([EXE, '--no-sandbox', '--remote-debugging-port=%d' % PORT,
                         '--user-data-dir=%s' % UDD],
                        stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
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

url = 'file:///' + PROT.replace('\\', '/')
send('Page.navigate', url=url)
time.sleep(6)
print('[2] 已加载:', str(ev("location.href"))[:80])

MEASURE = """
(() => {
  const S = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const c = getComputedStyle(e);
    return {
      w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      x: +r.x.toFixed(1), y: +r.y.toFixed(1),
      radius: c.borderRadius, bg: c.backgroundColor, bgi: c.backgroundImage.slice(0,60),
      fs: c.fontSize, fw: c.fontWeight, color: c.color,
      pad: c.padding, gap: c.gap, border: c.borderWidth + ' ' + c.borderColor
    };
  };
  const out = {};
  const sels = [
    '.frame', '.rail', '.menu-btn', '.user-avatar-ico',
    '.tab.tab-msg', '.tab.tab-msg img, .tab.tab-msg svg, .tab.tab-msg .ico',
    '.rail-kb', '.rail-kb img, .rail-kb svg, .rail-kb .ico',
    '.rail-quick-add', '.qadd-h', '.qadd-v',
    '.hamburger', '.hamburger span',
    '.agent-list', '.sidebar', '.splitter',
    '.search-pill.search-component', '.search-ico-v11',
    '.search-ico-v11 svg', '.search-field',
    '.contact-list', '.contact-item', '.contact-avatar', '.contact-name',
    '.main-area', '.top-area', '.inputbar',
    '.inputbar-btn.attach', '.composer', '.inputbar-field',
    '.inputbar-btn.voice', '.inputbar-btn.send',
    '.send-sparkle', '.send-stop', '.win-controls', '.win-btn'
  ];
  for (const s of sels) out[s] = S(s);
  // 数量
  out['__count'] = {
    contact: document.querySelectorAll('.contact-item').length,
    tab: document.querySelectorAll('.tab').length,
    winbtn: document.querySelectorAll('.win-btn').length,
  };
  return JSON.stringify(out, null, 1);
})()
"""
print('\n=== 原型实测参数 ===')
print(ev(MEASURE))

ws.close()
proc.kill()
time.sleep(1)
print('\nDONE')
