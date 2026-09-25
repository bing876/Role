"""
定位第 3 道闸：主界面在、React state 正确、点了发送，任务仍不送达。

把 sendChat() 会 early-return 的每个条件逐个读出来：
  - session 在不在（token 有效?）
  - curAgentRef.current（当前智能体 id）—— null 的话 sendChat 第一句就 return
  - streaming 是不是 true
  - detectUnknownOpenTarget / detectOpenUrl 的判定结果
  - chatNote（被本地闸拦下会写提示）

做法：读 DOM 判断不出这些，直接**在页面里把 React 状态hook出来**不方便，
改用一个等价办法：点发送后**看聊天区有没有多出一条用户消息**——
sendChat 在第 1712 行 `patchChat(... concat user)` 是无条件执行的（在 return 之前之后要分清），
所以"用户消息有没有出现"能精确切分是"更早 return"还是"走到后面失败了"。

跑法：python scripts/verify/send-gate-probe.py
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
CDP_PORT = "9999"
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


if not port_open(5432):
    procs["pg"] = subprocess.Popen([os.path.join(PG_BIN, "postgres.exe"), "-D", PG_DATA],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        if port_open(5432):
            break
        time.sleep(0.8)
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

kill_port(8787)
time.sleep(1.5)
srv = open(os.path.join(OUT, "gate-server.log"), "w", encoding="utf-8")
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

EXE = r"C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\AI 工作台.exe"
procs["app"] = subprocess.Popen(
    [EXE, "--no-sandbox", f"--remote-debugging-port={CDP_PORT}",
     "--user-data-dir=" + os.path.join(ROOT, "_probe-profile-fresh")],
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
c = Cdp(target["webSocketDebuggerUrl"])
for _ in range(60):
    if c.js("!!document.querySelector('.inputbar input')"):
        break
    time.sleep(1)

log("=== 界面体检 ===")
log("  主界面:", c.js("!!document.querySelector('.inputbar input')"))
log("  token:", c.js("!!localStorage.getItem('workbench.token')"))
# 智能体卡片数（左栏）—— 0 个的话 curAgentRef 就是 null
log("  左栏智能体卡片:", c.js("""
(()=>{const els=Array.from(document.querySelectorAll('[class*=agentCard],[class*=agentRow],[class*=sidebar] button'));
 return els.map(e=>(e.innerText||'').trim().slice(0,10)).filter(Boolean).slice(0,10).join(' | ');})()
"""))
log("  左栏文字:", c.js("(document.querySelector('aside')?.innerText||'无aside').slice(0,200).replace(/\\n/g,'|')"))
log("  聊天消息数:", c.js("document.querySelectorAll('[class*=msg],[class*=bubble]').length"))

TASK = "打开 example.com，然后告诉我页面标题是什么"
before_txt = c.js("(document.body.innerText||'').length")
h0 = http_get("http://127.0.0.1:8787/health")
b0 = json.loads(h0).get("llmCalls", -1) if h0.startswith("{") else -1
log(f"  发送前：文字长度={before_txt} llmCalls={b0}")

log("")
log("=== 填值 + 发送 ===")
c.js("document.querySelector('.inputbar input').focus()")
# ★ 关键：直接调 React 自己的 onChange，而不是"派发 input 事件碰运气"。
#   派发事件要 React 认为"值真的变了"才会走 onChange —— 而受控组件里
#   React 自己维护 value 跟踪，手写 setter 有时会被判成"没变"而丢弃。
#   直接调 onChange 是**确定的**：React 一定收到这次变更。
# ★ 用 A/B 实测**唯一有效**的方式（见 send-ab-probe 结论）：
#   原生 value setter 写入目标值 + 派发 input —— 关键是**写入目标值那一步**，
#   而不是先清空。清空后必须立刻写回，两步都要派发事件。
setres = c.js(f"""
(()=>{{const el=document.querySelector('.inputbar input');
 if(!el) return 'NO_EL';
 const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
 s.call(el,{json.dumps(TASK)});
 el.dispatchEvent(new Event('input',{{bubbles:true}}));
 return 'SET';}})()
""")
log("  写值:", setres)
st = c.js("""
(()=>{const el=document.querySelector('.inputbar input');
 const k=Object.keys(el).find(k=>k.startsWith('__reactProps$'));
 return JSON.stringify({dom:el.value,react:k?el[k].value:'?'});})()
""")
log("  输入状态:", st)
r = c.js("""
(()=>{const b=Array.from(document.querySelectorAll('.inputbar button'))
   .find(x=>/发送/.test(x.innerText||''));
 if(!b) return 'NO_BTN'; if(b.disabled) return 'DISABLED'; b.click(); return 'CLICKED';})()
""")
log("  点发送:", r)
time.sleep(5)

after_txt = c.js("(document.body.innerText||'').length")
h1 = http_get("http://127.0.0.1:8787/health")
b1 = json.loads(h1).get("llmCalls", -1) if h1.startswith("{") else -1
log(f"  发送后：文字长度={after_txt} llmCalls={b1}")

log("")
log("=== 判定：哪一道闸拦住了 ===")
log("  用户消息有没有进聊天区（文字变长 / 输入框被清空）:")
log("    输入框现值:", repr(c.js("document.querySelector('.inputbar input').value")))
log("    chatNote:", repr(c.js("document.querySelector('.chatNote')?.innerText || '(无)'")))
log("    projectNote:", repr(c.js("document.querySelector('.projectBox__note')?.innerText || '(无)'")))
log("    项目框全文:", repr(c.js("document.querySelector('[class*=projectBox]')?.innerText || '(无)'")))
log("    界面尾部:", str(c.js("document.body.innerText.slice(-200)"))[-200:])
log("")
if b1 > b0:
    log("  ✓ 送达服务端")
elif c.js("document.querySelector('.inputbar input').value") == "":
    log("  → 输入框被清空但没送达：可能是未知站点闸/被拦下并写了 chatNote")
else:
    log("  → 输入框没被清空、也没送达：sendChat 在最前面就 return 了")
    log("    （大概率是 curAgentRef.current === null，即当前没有选中智能体）")

log("")
log("=== 服务端日志 ===")
srv.flush()
log(open(os.path.join(OUT, "gate-server.log"), encoding="utf-8", errors="replace").read()[-600:])

for p in procs.values():
    try:
        p.terminate()
    except Exception:
        pass
time.sleep(1)
kill_port(8787)
with open(os.path.join(OUT, "send-gate-probe.log"), "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
