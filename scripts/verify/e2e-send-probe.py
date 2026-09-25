"""
诊断探针：为什么点了「发送」但任务没进服务端？

不猜，直接把应用里的关键状态读出来：
  1. 输入框 DOM value vs React 认为的值
  2. streaming 状态（按钮文案是「发送」还是「打字中…」）
  3. 当前 token / 登录态
  4. 点发送前后 /health 的 llmCalls
  5. 有没有 chatNote（被本地闸拦下会写提示语）

跑法：python scripts/verify/e2e-send-probe.py
"""
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = r"C:\Users\bing\workbuddy-ai\work123"
PG_HOME = r"C:\Users\bing\workbuddy-ai\pg2"
PG_BIN = os.path.join(PG_HOME, "pg", "bin")
PG_DATA = os.path.join(PG_HOME, "data")
OUT = os.path.join(ROOT, "docs", "acceptance", "root-cause")
CDP_PORT = "9555"

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


def wait_port(port, seconds=60):
    end = time.time() + seconds
    while time.time() < end:
        if port_open(port):
            return True
        time.sleep(0.8)
    return False


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


# 1) PG
log("=== 1) PostgreSQL ===")
if not port_open(5432):
    procs["pg"] = subprocess.Popen(
        [os.path.join(PG_BIN, "postgres.exe"), "-D", PG_DATA],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not wait_port(5432, 60):
        log("  ★ PG 没起来")
        sys.exit(1)
log("  ✓ 5432 监听中")

# 2) 服务端（确保重启，拿干净的 llmCalls 基线）
log("=== 2) 服务端 ===")
kill_port(8787)
time.sleep(1.5)
srv_log = open(os.path.join(OUT, "probe-server.log"), "w", encoding="utf-8")
procs["server"] = subprocess.Popen(
    ["node", os.path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts"],
    cwd=os.path.join(ROOT, "apps", "server"),
    stdout=srv_log, stderr=subprocess.STDOUT)
if not wait_port(8787, 90):
    log("  ★ 服务端没起来")
    sys.exit(1)
for _ in range(40):
    if '"db":"up"' in http_get("http://127.0.0.1:8787/health"):
        break
    time.sleep(1)
h = http_get("http://127.0.0.1:8787/health")
log("  ✓ health:", h[:150])

# 3) 应用
log("=== 3) 启动工作台 ===")
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
            return {"__err__": str(r["exceptionDetails"])[:300]}
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
    log("  ★ 窗口没起来")
    sys.exit(1)
log("  ✓ 窗口:", target.get("url"))

c = Cdp(target["webSocketDebuggerUrl"])
for i in range(60):
    n = c.js("document.querySelectorAll('input').length")
    t = c.js("(document.body.innerText||'').length")
    if isinstance(n, int) and n > 0 and isinstance(t, int) and t > 20:
        log(f"  ✓ 渲染完成（input={n}, 文字={t}）")
        break
    time.sleep(1)

# ── 诊断 ──────────────────────────────────────────────
log("")
log("=== 诊断：登录态 / 按钮 / 输入 ===")
log("  token 在否:", c.js("!!localStorage.getItem('workbench.token')"))
log("  输入框存在:", c.js("!!document.querySelector('.inputbar input')"))
log("  输入框 disabled:", c.js("document.querySelector('.inputbar input')?.disabled"))
log("  inputbar 按钮:", c.js(
    "JSON.stringify(Array.from(document.querySelectorAll('.inputbar button'))"
    ".map(b=>({t:b.innerText,d:b.disabled})))"))
log("  输入框 placeholder:", c.js("document.querySelector('.inputbar input')?.placeholder"))

TASK = "打开 example.com，然后告诉我页面标题是什么"
log("")
log("=== 用 Key 事件真打字（最接近真人），对比 insertText ===")

# 方式 A：先试 insertText + 原生 setter
c.js("document.querySelector('.inputbar input').focus()")
c.js("""
(()=>{const el=document.querySelector('.inputbar input');
 const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
 s.call(el,''); el.dispatchEvent(new Event('input',{bubbles:true})); return 'OK';})()
""")
c.send("Input.insertText", text=TASK)
c.js("document.querySelector('.inputbar input').dispatchEvent(new Event('input',{bubbles:true}))")
log("  insertText 后 DOM value:", c.js("document.querySelector('.inputbar input').value")[:40])
log("  insertText 后 React 值(间接: 按钮 disabled):",
    c.js("Array.from(document.querySelectorAll('.inputbar button')).map(b=>b.disabled).join(',')"))

h0 = http_get("http://127.0.0.1:8787/health")
b0 = int((re.search(r'"llmCalls":(\d+)', h0) or ["", "0"])[1])
log(f"  点击前 llmCalls={b0}")

r = c.js("""
(()=>{const bs=Array.from(document.querySelectorAll('.inputbar button'));
 const b=bs.find(x=>/发送/.test(x.innerText||''));
 if(!b) return 'NO_BTN';
 if(b.disabled) return 'DISABLED';
 b.click(); return 'CLICKED';})()
""")
log("  点发送:", r)
time.sleep(6)
h1 = http_get("http://127.0.0.1:8787/health")
b1 = int((re.search(r'"llmCalls":(\d+)', h1) or ["", "0"])[1])
log(f"  点击后 llmCalls={b1}  (差={b1 - b0})")

log("")
log("  === 界面反馈 ===")
log("  chatNote:", c.js("document.querySelector('.chatNote')?.innerText || '(无)'"))
log("  输入框当前值:", c.js("document.querySelector('.inputbar input')?.value"))
log("  会话尾部:", str(c.js("document.body.innerText.slice(-300)"))[-300:])

log("")
log("=== 服务端日志尾部 ===")
srv_log.flush()
log(open(os.path.join(OUT, "probe-server.log"), encoding="utf-8", errors="replace").read()[-1200:])

log("")
log("=== 收尾 ===")
for p in procs.values():
    try:
        p.terminate()
    except Exception:
        pass
time.sleep(1)
kill_port(8787)
log("  已停止")
with open(os.path.join(OUT, "e2e-send-probe.log"), "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
