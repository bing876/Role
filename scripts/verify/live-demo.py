# -*- coding: utf-8 -*-
"""一站式现场演示：起后端 + 起窗口 + 登录 + 截图，全程一个进程管到底。

为什么要有这个脚本（踩过的坑，按顺序）：
  1. 用工具的 run_in_background 启动 Electron，会在该后台任务被回收时**一起被杀**
     （约 60~80 秒后 code=1 退出，看起来像窗口自己崩了，其实是生命周期问题）。
  2. `nohup ... &` 同样会被回收。
  3. Node `spawn(detached:true)` 在本机也没能留住（日志 0 字节，进程直接没了）。
  4. 更早的坑：dev 模式下主进程会自动 `openDevTools({mode:'detach'})`，
     那个 devtools:// 窗口附着到同一渲染进程后，CDP 的 `Page.captureScreenshot`
     会**永久挂住**（同一连接上 Runtime.evaluate 却完全正常）。
     → 已给主进程加 `WORKBENCH_NO_DEVTOOLS=1` 开关并在本脚本里使用。

结论：**让所有子进程都由本脚本自己派发并 wait**，脚本活着窗口就活着；
拍完照、拿到结果再统一收尾，不依赖任何外部任务容器。

用法：
  python live-demo.py                 # 起栈 + 登录 + 截图 + 保持运行
  python live-demo.py --keep          # 同上（默认）
  python live-demo.py --no-keep       # 截图后把栈停掉
"""
import base64
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request

import websocket

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LIVE = os.path.join(ROOT, 'docs', 'acceptance', 'live')
NODE = 'C:/Users/bing/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe'
PY = sys.executable

API_PORT = int(os.environ.get('WB_API_PORT', 8799))
CDP_PORT = int(os.environ.get('WB_CDP_PORT', 9333))
VITE_PORT = int(os.environ.get('WB_VITE_PORT', 5273))
VITE_URL = 'http://localhost:%d' % VITE_PORT
USER_DATA = os.environ.get('WB_USER_DATA',
                           'C:/Users/bing/AppData/Local/Temp/wbdemo')

PHONE = os.environ.get('WB_PHONE') or ('186%08d' % (int(time.time()) % 100000000))
procs = []


def log(*a):
    print(*a, flush=True)


def alive(port):
    """端口探活：IPv4 和 IPv6 **都要试**。

    本机 vite 默认只监听 `[::1]`（IPv6 回环）。只探 127.0.0.1 会一直判「未就绪」，
    脚本误以为启动失败就退出了 —— 但 vite 其实是好的，白白浪费一轮排查。
    """
    import socket
    for host in ('127.0.0.1', '::1'):
        af = socket.AF_INET6 if ':' in host else socket.AF_INET
        s = socket.socket(af, socket.SOCK_STREAM)
        s.settimeout(1)
        try:
            s.connect((host, port))
            s.close()
            return True
        except Exception:  # noqa: BLE001
            pass
        finally:
            try:
                s.close()
            except Exception:  # noqa: BLE001
                pass
    return False


def wait_port(port, secs=40, label=''):
    t0 = time.time()
    while time.time() - t0 < secs:
        if alive(port):
            return True
        time.sleep(0.5)
    log('  [timeout] 端口未就绪:', port, label)
    return False


def spawn(args, cwd, logfile, env=None):
    os.makedirs(LIVE, exist_ok=True)
    f = open(os.path.join(LIVE, logfile), 'w', encoding='utf-8', errors='ignore')
    e = dict(os.environ)
    if env:
        e.update(env)
    p = subprocess.Popen(args, cwd=cwd, stdout=f, stderr=subprocess.STDOUT, env=e,
                         bufsize=1, text=True)
    procs.append((p, label_of(logfile)))
    log('  [spawn]', label_of(logfile), 'pid=', p.pid)
    return p


def label_of(x):
    return x.replace('.log', '')


# ---------------------------------------------------------------- CDP helpers
def cdp_target():
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(25):
        try:
            for t in json.load(op.open('http://127.0.0.1:%d/json/list' % CDP_PORT, timeout=10)):
                if t.get('type') == 'page' and str(VITE_PORT) in (t.get('url') or ''):
                    return t
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1)
    return None


class P:
    """CDP 会话。带**自动重连**：Electron 刚起时 /json/list 常常给出一个还没就绪的
    渲染进程，ws 能连上但第一条 Runtime.evaluate 就 recv 超时。
    之前这里直接抛异常，把「一次抖动」升级成「整轮失败」，还会连带
    触发收尾逻辑把栈全杀了。现在遇到连接问题就重新挑目标、重连、重试。"""

    def __init__(self, tries=4):
        self.i = 0
        self.t = None
        self.ws = None
        self._connect(tries)

    def _connect(self, tries=4):
        last = None
        for k in range(tries):
            try:
                t = cdp_target()
                if not t:
                    raise RuntimeError('没有页面目标')
                self.t = t
                self.ws = websocket.create_connection(
                    t['webSocketDebuggerUrl'], timeout=45, suppress_origin=True)
                # 握一次手，确认这条连接真的能用（不发这个，坏连接会拖到业务调用才暴露）
                self.call('Runtime.evaluate', expression='1', returnByValue=True)
                return
            except Exception as e:  # noqa: BLE001
                last = e
                log('  [cdp 重连 %d] %s' % (k + 1, str(e)[:80]))
                try:
                    self.ws.close()
                except Exception:  # noqa: BLE001
                    pass
                time.sleep(1.5 * (k + 1))
        raise RuntimeError('CDP 连接连续失败：%s' % last)

    def call(self, method, **params):
        last = None
        for attempt in range(3):
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
                log('  [cdp 调用重试 %d] %s: %s' % (attempt + 1, method, str(e)[:70]))
                try:
                    self.ws.close()
                except Exception:  # noqa: BLE001
                    pass
                time.sleep(1.2)
                try:
                    self._connect(3)
                except Exception as e2:  # noqa: BLE001
                    last = e2
                    break
        raise RuntimeError('CDP %s 连续失败：%s' % (method, last))

    def js(self, e):
        r = self.call('Runtime.evaluate', expression=e, returnByValue=True,
                      userGesture=True)
        if r.get('exceptionDetails'):
            return {'__error': str(r['exceptionDetails'])[:200]}
        return r.get('result', {}).get('result', {}).get('value')


def click_text(p, text):
    """按**可见文字**点按钮，用**真鼠标事件**而不是 DOM `.click()`。

    两个坑叠在一起，只修一个都不够：
      1) 不能按下标点：登录页 `button[0]` 是「手机验证码」页签，
         点它不报错也不发请求，表现为「验证码根本没发出去」。
      2) `el.click()` 派发的是**不可信事件**（isTrusted=false），
         React 的合成事件系统在部分路径下会忽略它 —— 表现为「点了但 handler 没跑」。
         用 CDP 的 `Input.dispatchMouseEvent` 发真鼠标事件，`isTrusted=true`，
         跟人手点完全等价。
    """
    r = p.js("(()=>{const b=Array.prototype.filter.call(document.querySelectorAll('button'),"
             "function(x){return (x.innerText||'').indexOf(%s)>=0&&!x.disabled;});"
             "if(!b.length)return null;"
             "b[0].scrollIntoView({block:'center'});"
             "const q=b[0].getBoundingClientRect();"
             "return {x:q.x+q.width/2,y:q.y+q.height/2,t:b[0].innerText.slice(0,12)};})()"
             % json.dumps(text))
    if not r:
        return 'no-btn'
    for kind in ('mousePressed', 'mouseReleased'):
        p.call('Input.dispatchMouseEvent', type=kind, x=r['x'], y=r['y'],
               button='left', clickCount=1)
    return 'clicked %s @(%d,%d)' % (r['t'], r['x'], r['y'])


def set_input(p, sel, value):
    return p.js(
        "(function(){const el=document.querySelector(%s);if(!el)return 'no-el';"
        "const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');"
        "d.set.call(el,%s);"
        "el.dispatchEvent(new Event('input',{bubbles:true}));"
        "return el.value;})()" % (json.dumps(sel), json.dumps(value)))


def shot(p, out):
    t = cdp_target()
    ws = websocket.create_connection(t['webSocketDebuggerUrl'], timeout=30, suppress_origin=True)
    ws.send(json.dumps({'id': 1, 'method': 'Page.captureScreenshot', 'params': {'format': 'png'}}))
    data = None
    while True:
        m = json.loads(ws.recv())
        if m.get('id') == 1:
            if 'error' in m:
                log('  shot error:', m['error'])
                break
            data = m['result']['data']
            break
    ws.close()
    if data:
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, 'wb') as f:
            f.write(base64.b64decode(data))
        log('  截图 ->', out, os.path.getsize(out), 'bytes')
    return bool(data)


def main():
    keep = '--no-keep' not in sys.argv
    os.makedirs(LIVE, exist_ok=True)

    log('=== 1. 后端 %d（捕获 mock 验证码）===' % API_PORT)
    if alive(API_PORT):
        log('  已有人在监听，直接复用')
    else:
        spawn([NODE, 'dist/index.js'], os.path.join(ROOT, 'apps', 'server'),
              'server.log', {'PORT': str(API_PORT), 'SMS_MOCK': '1'})
        wait_port(API_PORT, 40, 'api')

    log('=== 2. vite %d ===' % VITE_PORT)
    if alive(VITE_PORT):
        log('  已有人在监听，直接复用')
    else:
        # --host 127.0.0.1：本机 vite 默认只绑 IPv6 回环 [::1]，
        # 显式绑 v4 让 CDP / curl 都稳定可达。
        spawn([NODE, os.path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
               '--port', str(VITE_PORT), '--strictPort', '--host', '127.0.0.1'],
              os.path.join(ROOT, 'apps', 'desktop'), 'vite.log')
        wait_port(VITE_PORT, 40, 'vite')

    log('=== 3. Electron 窗口（关 DevTools，独立 userData）===')
    import shutil
    shutil.rmtree(USER_DATA, ignore_errors=True)
    spawn([NODE, os.path.join('scripts', 'start-electron.mjs'),
           '--user-data-dir=' + USER_DATA,
           '--remote-debugging-port=%d' % CDP_PORT],
          os.path.join(ROOT, 'apps', 'desktop'), 'electron-live.log',
          {'WORKBENCH_NO_DEVTOOLS': '1', 'VITE_DEV_SERVER_URL': VITE_URL})
    wait_port(CDP_PORT, 45, 'cdp')

    t = cdp_target()
    if not t:
        log('!! 没等到窗口目标'); return 1
    log('  目标 =', t.get('url'))

    p = P()
    log('=== 4. 登录（手机号 %s）===' % PHONE)
    p.js("localStorage.clear();localStorage.setItem('workbench.apiBase',"
         "'http://127.0.0.1:%d');" % API_PORT)
    p.call('Page.navigate', url=VITE_URL)
    # 等登录表单真的挂上再填：只 sleep 固定秒数在慢启动时会填到空白页，
    # 表现为「填号返回 no-el、验证码请求根本没发出」。
    _t0 = time.time()
    while time.time() - _t0 < 25:
        if p.js("!!document.querySelector(\"input[placeholder*='手机号']\")"):
            break
        time.sleep(0.6)
    time.sleep(1.2)
    # ★ 按 placeholder 定位，不按下标：
    #   曾经用 document.querySelectorAll('input')[1]，在页面重渲染的瞬间会取到 null，
    #   返回 None 且不报错，表现为「码填不上、登录按钮一直 disabled」。
    phone_sel = "input[placeholder*='手机号']"
    code_sel = "input[placeholder*='验证码']"
    filled = set_input(p, phone_sel, PHONE)
    log('  填号 ->', filled)
    if filled != PHONE:
        log('  ✗ 手机号没填进去（拿到 %r），后续点了也发不出验证码' % (filled,))
        log('    页面文字:', p.js("(document.body.innerText||'').slice(0,160)"))
        return 1
    log('  点获取验证码 ->', click_text(p, '获取验证码'))
    time.sleep(3)

    code = None
    for _ in range(12):
        try:
            txt = open(os.path.join(LIVE, 'server.log'), encoding='utf-8',
                       errors='ignore').read()
            # ★ 匹配「验证码」后面的 6 位数字，而不是行内第一个 6 位数字：
            #   日志行是 `[sms:mock] → 186****1111 验证码 598663（…）`，
            #   用 `[sms:mock][^\n]*?(\d{6})` 这种写法一旦号段里出现连续数字就会取错。
            ms = re.findall(r'\[sms:mock\][^\n]*?验证码\s*(\d{6})', txt)
            if ms:
                code = ms[-1]
                break
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1)
    log('  验证码 =', code)
    if not code:
        log('  server.log 尾部:', open(os.path.join(LIVE, 'server.log'),
                                      encoding='utf-8', errors='ignore').read()[-300:])
        log('  ⚠️ 服务端 stdout 是**块缓冲**的：非 TTY 下 `console.log` 要攒够一批才落盘，')
        log('     所以刚发完验证码时日志里可能还没有。等一会再看，或改成逐行 flush。')
        return 1

    # 等验证码框出现再填（重渲染期间可能短暂取不到）
    t0 = time.time()
    while time.time() - t0 < 12:
        if p.js("!!document.querySelector(%s)" % json.dumps(code_sel)):
            break
        time.sleep(0.5)
    log('  填码 ->', set_input(p, code_sel, code))
    time.sleep(1)
    # 确认按钮真的可点了再点（React 受控组件必须收到 input 事件才会解禁）
    btn = p.js("(()=>{const b=Array.prototype.filter.call(document.querySelectorAll('button'),"
               "function(x){return (x.innerText||'').indexOf('登录')>=0;});"
               "return b.length?{t:b[0].innerText,d:b[0].disabled}:null;})()")
    log('  登录按钮 =', json.dumps(btn, ensure_ascii=False))
    log('  点登录 ->', click_text(p, '登录'))

    log('=== 5. 等工作台 ===')
    ok = False
    t0 = time.time()
    while time.time() - t0 < 35:
        try:
            if p.js("!!document.querySelector('.wtApp')"):
                ok = True
                break
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1)
    if not ok:
        log('  !! 没进工作台，页面文字:', p.js("(document.body.innerText||'').slice(0,180)"))
        return 1
    time.sleep(3.5)

    st = p.js(r"""(function(){
      function box(s){var e=document.querySelector(s);if(!e)return null;
        var r=e.getBoundingClientRect();
        return {x:Math.round(r.x),w:Math.round(r.width),h:Math.round(r.height)};}
      return {app:box('.wtApp'),rail:box('.wtRail'),sb:box('.wtSb'),main:box('.wtMain'),
       disp:getComputedStyle(document.querySelector('.wtApp')).display,
       railMode:document.querySelector('.wtRail__back')?'projects':'global',
       globals:document.querySelectorAll('[data-wt-global]').length,
       agents:Array.prototype.map.call(document.querySelectorAll('[data-agent-id]'),
         function(e){return e.getAttribute('data-agent-id')+
           (e.hasAttribute('data-agent-hen')?'(hen)':'')+
           (e.querySelector('[data-wt-agent-del]')?'[del]':'[nodel]');}),
       empty:!!document.querySelector('[data-wt-browser-empty]')};})()""")
    log('=== 工作台状态 ===')
    log(json.dumps(st, ensure_ascii=False, indent=1))

    shot(p, os.path.join(LIVE, '01-workbench-default.png'))

    if keep:
        log('=== 保持运行中（窗口已开，Ctrl+C 结束）===')
        reported = set()
        try:
            while True:
                time.sleep(5)
                # 每个子进程**只报一次**退出：不做这个去重，已经死掉的进程会在
                # 每 5 秒的轮询里被反复打印，日志瞬间被 [exit] 刷满（实测刷了 39 行）。
                for idx, (pr, lb) in enumerate(procs):
                    if pr.poll() is not None and idx not in reported:
                        reported.add(idx)
                        log('  [exit] %s code=%s' % (lb, pr.returncode))
        except KeyboardInterrupt:
            pass
    log('=== 收尾 ===')
    for pr, lb in procs:
        try:
            pr.terminate()
        except Exception:  # noqa: BLE001
            pass
    for pr, lb in procs:
        try:
            pr.wait(timeout=8)
        except Exception:  # noqa: BLE001
            pr.kill()
    log('  已停服')
    return 0


if __name__ == '__main__':
    sys.exit(main())
