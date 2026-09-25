"""
定位："主界面在、token 有效，但点发送不送达" —— 到底是 React state 没进，还是别的闸。

在同一次运行里做 A/B：
  A. 原生 setter + dispatchEvent('input')  → 读 React props.value
  B. CDP Input.insertText（真实输入法）     → 读 React props.value
  C. 直接调 React 的 onChange 需要的 setter 路径
然后每种方式都点一次发送，看 llmCalls 有没有涨。

跑法：python scripts/verify/send-ab-probe.py
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
PG_BIN = r"C:\Users\bing\workbuddy-ai\pg2\pg\bin"
PG_DATA = r"C:\Users\bing\workbuddy-ai\pg2\data"
CDP_PORT = "9888"
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
    except Exception as e:
        return f"__ERR__ {e}"


def kill_port(port):
    try:
        out = subprocess.run(["netstat", "-ano"], capture_output=True,
                             encoding="gbk", errors="replace").stdout
    except Exception:
        return
    pids = set()
    for ln in out.splitlines():
        if f":{port} " in ln and "LISTENING" in ln:
            p = ln.split()
            if p:
                pids.add(p[-1])
    for p in pids:
        subprocess.run(["taskkill", "/F", "/T", "/PID", p], capture_output=True)


def llm_calls():
    h = http_get("http://127.0.0.1:8787/health")
    if not h.startswith("{"):
        return -1
    try:
        return int(json.loads(h).get("llmCalls", -1))
    except Exception:
        return -1


# 环境
if not port_open(5432):
    procs["pg"] = subprocess.Popen([os.path.join(PG_BIN, "postgres.exe"), "-D", PG_DATA],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        if port_open(5432):
            break
        time.sleep(0.8)

# 等库真可用
for _ in range(60):
    r = subprocess.run(["node", "-e",
                        "const {Client}=require('pg');(async()=>{const c=new Client({host:'127.0.0.1',"
                        "port:5432,user:'workbench',database:'postgres'});await c.connect();"
                        "await c.query('SELECT 1');await c.end();console.log('READY')})()"
                        ".catch(e=>console.log('WAIT'))"],
                       cwd=ROOT, capture_output=True, text=True)
    if "READY" in (r.stdout or ""):
        break
    time.sleep(1)
log("库就绪")

kill_port(8787)
time.sleep(1.5)
srv = open(os.path.join(OUT, "ab-server.log"), "w", encoding="utf-8")
procs["server"] = subprocess.Popen(
    ["node", os.path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts"],
    cwd=os.path.join(ROOT, "apps", "server"), stdout=srv, stderr=subprocess.STDOUT)
for _ in range(90):
    if port_open(8787):
        break
    time.sleep(1)
for _ in range(40):
    if '"db":"up"' in http_get("http://127.0.0.1:8787/health"):
        break
    time.sleep(1)
log("服务端就绪")

EXE = r"C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\AI 工作台.exe"
procs["app"] = subprocess.Popen(
    [EXE, "--no-sandbox", f"--remote-debugging-port={CDP_PORT}",
     "--user-data-dir=" + os.path.join(ROOT, "_e2e-profile")],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

import websocket


class Cdp:
    def __init__(self, url):
        self.ws = websocket.create_connection(url, timeout=30, suppress_origin=True)
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

    def js(self, expr):
        r = self.send("Runtime.evaluate", expression=expr, returnByValue=True,
                      awaitPromise=True, userGesture=True)
        if r.get("exceptionDetails"):
            return {"__err__": str(r["exceptionDetails"])[:300]}
        return r.get("result", {}).get("value")


target = None
for _ in range(45):
    raw = http_get(f"http://127.0.0.1:{CDP_PORT}/json/list")
    if raw and not raw.startswith("__ERR__"):
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
for _ in range(60):
    if c.js("!!document.querySelector('.inputbar input')"):
        break
    time.sleep(1)
log("主界面就绪:", c.js("!!document.querySelector('.inputbar input')"))

READ = """
(()=>{const el=document.querySelector('.inputbar input');
 if(!el) return JSON.stringify({err:'NO_EL'});
 const k=Object.keys(el).find(k=>k.startsWith('__reactProps$'));
 if(!k) return JSON.stringify({err:'NO_REACT_PROPS',keys:Object.keys(el).slice(0,15)});
 return JSON.stringify({dom:el.value, react:el[k].value, hasOnChange: typeof el[k].onChange});})()
"""

TASK = "打开 example.com，然后告诉我页面标题是什么"
results = []


def try_send(label, fill_js):
    c.js("""
    (()=>{const el=document.querySelector('.inputbar input');
     const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
     s.call(el,''); el.dispatchEvent(new Event('input',{bubbles:true})); return 'CLEARED';})()
    """)
    time.sleep(0.3)
    fill_js()
    time.sleep(0.6)
    state = c.js(READ)
    before = llm_calls()
    r = c.js("""
    (()=>{const b=Array.from(document.querySelectorAll('.inputbar button'))
       .find(x=>/发送/.test(x.innerText||''));
     if(!b) return 'NO_BTN'; if(b.disabled) return 'DISABLED'; b.click(); return 'CLICKED';})()
    """)
    time.sleep(6)
    after = llm_calls()
    ok = after > before
    results.append((label, state, r, before, after, ok))
    log(f"  [{label}] react={state}")
    log(f"          点发送={r}  llmCalls {before}->{after}  {'✓ 送达' if ok else '✗ 没送达'}")
    return ok


log("")
log("=== A：原生 setter 写 value + dispatchEvent('input') ===")
try_send("A 原生setter", lambda: c.js(f"""
(()=>{{const el=document.querySelector('.inputbar input');
 const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
 s.call(el,{json.dumps(TASK)}); el.dispatchEvent(new Event('input',{{bubbles:true}})); return 'SET';}})()
"""))

log("")
log("=== B：CDP Input.insertText（真实输入法路径）===")
try_send("B insertText", lambda: c.send("Input.insertText", text=TASK))

log("")
log("=== C：CDP dispatchKeyEvent 逐字符 ===")


def type_chars():
    for ch in TASK:
        c.send("Input.dispatchKeyEvent", type="char", text=ch)
        time.sleep(0.008)


try_send("C 逐字符", type_chars)

log("")
log("=== 汇总 ===")
for label, state, r, b, a, ok in results:
    log(f"  {label:12s} {'✓ 送达' if ok else '✗ 没送达'}   react={state}")

log("")
log("=== 服务端日志 ===")
srv.flush()
log(open(os.path.join(OUT, "ab-server.log"), encoding="utf-8", errors="replace").read()[-800:])

for p in procs.values():
    try:
        p.terminate()
    except Exception:
        pass
time.sleep(1)
kill_port(8787)
with open(os.path.join(OUT, "send-ab-probe.log"), "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
