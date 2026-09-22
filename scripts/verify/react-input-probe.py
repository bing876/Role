"""
最小验证：用 CDP 往 React 受控输入框里塞值，哪些方式**真的更新了 React state**？

判据不靠猜：用 React 的 __reactProps$ / __reactFiber$ 内部属性读出 props.value。

跑法：python scripts/verify/react-input-probe.py
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = r"C:\Users\bing\workbuddy-ai\work123"
OUT = os.path.join(ROOT, "docs", "acceptance", "root-cause")
CDP_PORT = "9666"
ROOT_DIR = ROOT
procs = {}
lines = []


def log(*a):
    s = " ".join(str(x) for x in a)
    lines.append(s)
    print(s, flush=True)


def port_open(port, host="127.0.0.1", timeout=1.5):
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def http_get(url, timeout=8):
    try:
        return urllib.request.urlopen(url, timeout=timeout).read().decode("utf-8", "replace")
    except Exception:
        return ""


def kill_port(port):
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True,
                             encoding="gbk", errors="replace").stdout
    except Exception:
        return
    pids = set()
    for ln in out.splitlines():
        if f":{port} " in ln and "LISTENING" in ln:
            parts = ln.split()
            if parts:
                pids.add(parts[-1])
    for p in pids:
        subprocess.run(["taskkill", "/F", "/T", "/PID", p], capture_output=True)


# PG + 服务端（应用要能连上，否则登录态/会话可能不加载）
if not port_open(5432):
    procs["pg"] = subprocess.Popen(
        [r"C:\Users\bing\workbuddy-ai\pg2\pg\bin\postgres.exe",
         "-D", r"C:\Users\bing\workbuddy-ai\pg2\data"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        if port_open(5432):
            break
        time.sleep(0.8)
log("PG 5432:", port_open(5432))

kill_port(8787)
time.sleep(1.5)
srv = open(os.path.join(OUT, "react-probe-server.log"), "w", encoding="utf-8")
procs["server"] = subprocess.Popen(
    ["node", os.path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts"],
    cwd=os.path.join(ROOT, "apps", "server"), stdout=srv, stderr=subprocess.STDOUT)
for _ in range(90):
    if port_open(8787):
        break
    time.sleep(1)
log("服务端 8787:", port_open(8787))

EXE = r"C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\AI 工作台.exe"
procs["app"] = subprocess.Popen(
    [EXE, "--no-sandbox", f"--remote-debugging-port={CDP_PORT}",
     "--user-data-dir=" + os.path.join(ROOT, "_e2e-profile")],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

import websocket


class Cdp:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=30, suppress_origin=True)
        self.i = 0

    def send(self, method, **p):
        self.i += 1
        mid = self.i
        self.ws.send(json.dumps({"id": mid, "method": method, "params": p}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == mid:
                if "error" in m:
                    raise RuntimeError(f"{method}: {m['error']}")
                return m.get("result", {})

    def js(self, expr, await_promise=True):
        r = self.send("Runtime.evaluate", expression=expr, returnByValue=True,
                      awaitPromise=await_promise, userGesture=True)
        if r.get("exceptionDetails"):
            return {"__err__": str(r["exceptionDetails"])[:400]}
        return r.get("result", {}).get("value")


target = None
for _ in range(45):
    raw = http_get(f"http://127.0.0.1:{CDP_PORT}/json/list")
    if raw:
        for t in json.loads(raw):
            if t.get("type") == "page" and "devtools://" not in (t.get("url") or ""):
                target = t
                break
    if target:
        break
    time.sleep(1)
if not target:
    log("★ 窗口没起来")
    sys.exit(1)

c = Cdp(target["webSocketDebuggerUrl"])
for i in range(60):
    n = c.js("document.querySelectorAll('input').length")
    if isinstance(n, int) and n > 0 and isinstance(c.js("(document.body.innerText||'').length"), int) \
            and c.js("(document.body.innerText||'').length") > 20:
        break
    time.sleep(1)
log("渲染完成，input 数 =", c.js("document.querySelectorAll('input').length"))

# ★ 有两种页面状态：未登录（只有手机号/验证码两个 input）和已登录（有 .inputBar）。
#   探针要能区分，否则会得出"输入框不存在"这种与真实原因无关的结论。
state = c.js("""
(()=>{return JSON.stringify({
  hasToken: !!localStorage.getItem('workbench.token'),
  hasInputBar: !!document.querySelector('.inputBar input'),
  inputs: Array.from(document.querySelectorAll('input')).map(e=>e.placeholder||''),
  bodyHead: (document.body.innerText||'').slice(0,120)
});})()
""")
log("页面状态:", state)

if "NO_EL" in str(c.js("""
(()=>{return document.querySelector('.inputBar input')?'OK':'NO_EL'})()
""")):
    log("")
    log("★ 当前是登录页，不是主界面 —— 先不做输入探针。")
    log("  这说明 _e2e-profile 里的登录态**丢了**（E2E 脚本走的是「已有登录态，跳过」，")
    log("  但那次能读到 inputBar，说明当时是登录的；这次不是）。")
    log("  → 需要在探针里**自己登录一次**，不能依赖残留登录态。")
    for p in procs.values():
        try:
            p.terminate()
        except Exception:
            pass
    time.sleep(1)
    kill_port(8787)
    with open(os.path.join(OUT, "react-input-probe.log"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    sys.exit(0)

# React 内部 props 的读法：元素上挂 __reactProps$<random>
READ = """
(()=>{const el=document.querySelector('.inputBar input');
 if(!el) return JSON.stringify({err:'NO_EL'});
 const k=Object.keys(el).find(k=>k.startsWith('__reactProps$'));
 if(!k) return JSON.stringify({err:'NO_REACT_PROPS', keys:Object.keys(el).slice(0,20)});
 return JSON.stringify({dom:el.value, react:el[k].value, reactKey:k});})()
"""

log("")
log("=== 初始 ===")
log(" ", c.js(READ))

TASK = "打开 example.com，然后告诉我页面标题是什么"

# ── 方式 A：原生 setter + input 事件（脚本当前用法）
log("")
log("=== 方式 A：原生 value setter + dispatchEvent('input') ===")
c.js("document.querySelector('.inputBar input').focus()")
c.js("""
(()=>{const el=document.querySelector('.inputBar input');
 const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
 s.call(el,''); el.dispatchEvent(new Event('input',{bubbles:true})); return 'OK';})()
""")
c.js(f"""
(()=>{{const el=document.querySelector('.inputBar input');
 const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
 s.call(el,{json.dumps(TASK)}); el.dispatchEvent(new Event('input',{{bubbles:true}})); return 'SET';}})()
""")
time.sleep(0.6)
log(" ", c.js(READ))

# ── 方式 B：CDP Input.insertText（模拟真实输入法）
log("")
log("=== 方式 B：清空后用 CDP Input.insertText ===")
c.js("""
(()=>{const el=document.querySelector('.inputBar input');
 const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
 s.call(el,''); el.dispatchEvent(new Event('input',{bubbles:true})); return 'CLEARED';})()
""")
time.sleep(0.3)
c.send("Input.insertText", text=TASK)
time.sleep(0.6)
log(" ", c.js(READ))

# ── 方式 C：逐字符真键盘事件（最接近真人）
log("")
log("=== 方式 C：CDP Input.dispatchKeyEvent 逐字符 ===")
c.js("""
(()=>{const el=document.querySelector('.inputBar input');
 const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
 s.call(el,''); el.dispatchEvent(new Event('input',{bubbles:true})); return 'CLEARED';})()
""")
time.sleep(0.3)
for ch in TASK:
    c.send("Input.dispatchKeyEvent", type="char", text=ch)
    time.sleep(0.01)
time.sleep(0.8)
log(" ", c.js(READ))

log("")
log("=== 收尾 ===")
for p in procs.values():
    try:
        p.terminate()
    except Exception:
        pass
time.sleep(1)
kill_port(8787)
with open(os.path.join(OUT, "react-input-probe.log"), "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
