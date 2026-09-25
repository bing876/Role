"""
决定性取证：E2E 脚本「点了发送但没送达」到底卡在哪一步？

不再猜。在同一次运行里，把每一步的前置条件都打出来：
  A. localStorage 有没有 token
  B. /auth/me 是不是通的（token 有没有被服务端认）
  C. 界面是登录页还是主界面
  D. .inputbar input 在不在、React props.value 是什么
  E. 点发送前后 /health 的 llmCalls

关键：**不重启服务端**，看是不是"服务端重启把登录态打没了"。

跑法：python scripts/verify/e2e-race-probe.py
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
CDP_PORT = "9777"
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
            parts = ln.split()
            if parts:
                pids.add(parts[-1])
    for p in pids:
        subprocess.run(["taskkill", "/F", "/T", "/PID", p], capture_output=True)


# ── 关键差异：**不重启服务端**（如果 8787 已在跑就复用），
#    以隔离出"服务端重启"这个变量对登录态的影响。
log("=== 0) 环境 ===")
log("  5432:", port_open(5432), "| 8787:", port_open(8787))
if not port_open(5432):
    log("  ★ 需要先起 PG（用 run-task-e2e.py 那套）")
if not port_open(8787):
    log("  ★ 8787 不在跑 —— 先跑一次 run-task-e2e.py 或手动起服务端")

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
log("")
log("=== 1) 刚起来的界面状态（每 2 秒采一次，看登录态稳不稳）===")
for i in range(8):
    st = c.js("""
    (()=>{const tok=localStorage.getItem('workbench.token');
     return JSON.stringify({
       hasToken: !!tok,
       tokenLen: tok?tok.length:0,
       hasInputBar: !!document.querySelector('.inputbar input'),
       inputs: Array.from(document.querySelectorAll('input')).map(e=>e.placeholder||''),
       head: (document.body.innerText||'').slice(0,60).replace(/\\n/g,'|')
     });})()
    """)
    log(f"  T+{i*2}s {st}")
    time.sleep(2)

log("")
log("=== 2) /auth/me 对这个 token 通不通 ===")
tok = c.js("localStorage.getItem('workbench.token')")
if tok:
    req = urllib.request.Request("http://127.0.0.1:8787/auth/me",
                                headers={"authorization": f"Bearer {tok}"})
    try:
        body = urllib.request.urlopen(req, timeout=8).read().decode("utf-8", "replace")
        log("  /auth/me ->", body[:200])
    except Exception as e:
        log("  /auth/me 失败 ->", str(e)[:200], "  ← 这个 401/503 会让 App 清 token 回登录页")
else:
    log("  没有 token，跳过")

log("")
log("=== 3) 如果已在主界面，做一次发送测试 ===")
if c.js("!!document.querySelector('.inputbar input')"):
    TASK = "打开 example.com，然后告诉我页面标题是什么"
    h0 = http_get("http://127.0.0.1:8787/health")
    b0 = int((json.loads(h0).get("llmCalls", 0)) if h0.startswith("{") else 0)
    c.js("document.querySelector('.inputbar input').focus()")
    c.js(f"""
    (()=>{{const el=document.querySelector('.inputbar input');
     const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
     s.call(el,{json.dumps(TASK)}); el.dispatchEvent(new Event('input',{{bubbles:true}})); return 'SET';}})()
    """)
    time.sleep(0.5)
    log("  React props.value:", c.js("""
    (()=>{const el=document.querySelector('.inputbar input');
     const k=Object.keys(el).find(k=>k.startsWith('__reactProps$'));
     return k?el[k].value:'NO_KEY';})()
    """))
    r = c.js("""
    (()=>{const b=Array.from(document.querySelectorAll('.inputbar button'))
       .find(x=>/发送/.test(x.innerText||''));
     if(!b) return 'NO_BTN'; if(b.disabled) return 'DISABLED'; b.click(); return 'CLICKED';})()
    """)
    log("  点发送:", r)
    time.sleep(8)
    h1 = http_get("http://127.0.0.1:8787/health")
    b1 = int((json.loads(h1).get("llmCalls", 0)) if h1.startswith("{") else 0)
    log(f"  llmCalls {b0} -> {b1}  (差={b1-b0})")
    log("  chatNote:", c.js("document.querySelector('.chatNote')?.innerText||'(无)'"))
else:
    log("  当前在登录页，无法测发送")

log("")
log("=== 收尾 ===")
for p in procs.values():
    try:
        p.terminate()
    except Exception:
        pass
time.sleep(1)
with open(os.path.join(OUT, "e2e-race-probe.log"), "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
log("日志已写")
