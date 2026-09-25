"""
一键跑通「工作台任务」的端到端脚本（全流程自包含）。

★ 为什么必须自包含：
   这台机器上，agent 工具调用一旦结束，**派生的子进程会被全部回收**
   （实测：vite 5173 / 服务端 8787 / Electron 9333 / PostgreSQL 5432
    在一个 turn 之后全部消失，日志里连错误都没有）。
   所以「分步起服务、再慢慢驱动」这条路根本走不通 ——
   必须在**同一个进程里**把 PG + 服务端 + 应用全部拉起、干完活、再收尾。

干的活：
   1. 起 PostgreSQL（本机无 Docker/WSL，用 zonky 嵌入式二进制）
   2. 建 workbench 库
   3. 起服务端（**必须重启**：migrate() 只在启动时跑一次，不重启就没表）
   4. 启动已安装的工作台（--remote-debugging-port 便于 CDP 驱动）
   5. 用短信验证码登录（mock 模式，验证码在服务端 stdout 里）
   6. 发一条任务指令，轮询等 AI 干完
   7. 截图取证 + 收尾

跑法：
   python scripts/verify/run-task-e2e.py
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
SERVER_LOG = os.path.join(OUT, "e2e-server.log")
SHOT_DIR = OUT
CDP_PORT = "9444"

os.makedirs(OUT, exist_ok=True)

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
    except Exception:  # noqa: BLE001
        return ""


def kill_port(port):
    """杀掉占用某端口的进程（本机 sc.exe / wmic 不可用，用 netstat + taskkill）

    ★ netstat 在本机输出是 **GBK**，用默认 utf-8 解码会抛 UnicodeDecodeError
      （表现成 stdout 变 None、后面 AttributeError，错误信息和真正的原因完全无关）。
    """
    try:
        out = subprocess.run(
            ["netstat", "-ano"], capture_output=True,
            encoding="gbk", errors="replace",
        ).stdout
    except Exception:  # noqa: BLE001
        return
    pids = set()
    for ln in out.splitlines():
        if f":{port} " in ln and "LISTENING" in ln:
            parts = ln.split()
            if parts:
                pids.add(parts[-1])
    for p in pids:
        subprocess.run(["taskkill", "/F", "/T", "/PID", p], capture_output=True)


# ─────────────────────────────────────────────
# 1) PostgreSQL
# ─────────────────────────────────────────────
log("=== 第 1 步：起 PostgreSQL ===")
if port_open(5432):
    log("  5432 已在监听")
else:
    pg = subprocess.Popen(
        [os.path.join(PG_BIN, "postgres.exe"), "-D", PG_DATA],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    procs["pg"] = pg
    if not wait_port(5432, 60):
        log("  ★ PostgreSQL 没起来")
        sys.exit(1)
    log("  ✓ 5432 监听中")

# ★★ 端口通了 ≠ 库能用了。
#   PG 绑定端口之后还要跑完崩溃恢复，这期间**任何连接都会报
#   "the database system is starting up"**。服务端的 migrate() 只在启动时跑一次，
#   撞上这个窗口就会抛异常 → 服务端带着「库没连上」的状态一直跑下去（表也可能没建全）
#   → 桌面端 /auth/me 拿到 503 → **App 清掉本地 token 退回登录页**
#   → 后面「点发送没反应」全是这一条的连锁反应。
#   所以：起服务端之前，必须先**真连一次库**确认它接受查询。
log("=== 第 1.5 步：等库真正可用（不只是端口通）===")
pg_ready = False
for i in range(60):
    r = subprocess.run(
        ["node", "-e",
         "const {Client}=require('pg');(async()=>{const c=new Client({host:'127.0.0.1',"
         "port:5432,user:'workbench',database:'postgres'});await c.connect();"
         "await c.query('SELECT 1');await c.end();console.log('READY');})()"
         ".catch(e=>{console.log('WAIT:'+e.message)});"],
        cwd=ROOT, capture_output=True, text=True,
    )
    out = (r.stdout.strip() or r.stderr.strip())
    if out == "READY":
        pg_ready = True
        log(f"  ✓ 库已可接受查询（第 {i + 1} 次尝试）")
        break
    time.sleep(1)
if not pg_ready:
    log("  ★ 60 秒内库仍不可用，最后一次:", out[:200])
    sys.exit(1)

# 建 workbench 库（用 node 的 pg 驱动，本机没有 psql）
log("=== 第 2 步：建 workbench 库 ===")
node_js = (
    "const {Client}=require('pg');(async()=>{"
    "const c=new Client({host:'127.0.0.1',port:5432,user:'workbench',database:'postgres'});"
    "await c.connect();"
    "const r=await c.query(\"SELECT datname FROM pg_database\");"
    "if(!r.rows.some(x=>x.datname==='workbench')){await c.query('CREATE DATABASE workbench');console.log('CREATED');}"
    "else console.log('EXISTS');"
    "await c.end();})().catch(e=>{console.log('ERR '+e.message);process.exit(1)});"
)
# ★ 端口能连 ≠ 库可用：PG 绑定端口后还要跑完恢复流程，
#   这期间连接会报 "the database system is starting up"。必须重试。
db_state = "?"
for attempt in range(30):
    r = subprocess.run(["node", "-e", node_js], cwd=ROOT, capture_output=True, text=True)
    out = (r.stdout.strip() or r.stderr.strip())
    if out in ("CREATED", "EXISTS"):
        db_state = out
        log(f"  ✓ {out}（第 {attempt + 1} 次尝试）")
        break
    time.sleep(1)
else:
    log("  ★ 建库失败（最后一次）:" + out[:200])
    sys.exit(1)

# ─────────────────────────────────────────────
# 3) 服务端（必须重启，migrate() 只在启动时跑）
# ─────────────────────────────────────────────
log("=== 第 3 步：重启服务端（让 migrate 建表）===")
kill_port(8787)
time.sleep(1.5)
srv_log = open(SERVER_LOG, "w", encoding="utf-8")
# ★ 不能用 ["npx","tsx",...]：Windows 上 npx 是 npx.cmd，
#   不走 shell 的 Popen 找不到它（FileNotFoundError: [WinError 2]）。
#   直接用 node 跑 tsx 的 CLI 入口。
procs["server"] = subprocess.Popen(
    ["node", os.path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts"],
    cwd=os.path.join(ROOT, "apps", "server"),
    stdout=srv_log,
    stderr=subprocess.STDOUT,
)
if not wait_port(8787, 90):
    log("  ★ 服务端没起来，日志：")
    srv_log.flush()
    log(open(SERVER_LOG, encoding="utf-8", errors="replace").read()[-2000:])
    sys.exit(1)

# 等 /health 里 db 变成 up（migrate 需要一点时间）
db_up = False
for _ in range(40):
    h = http_get("http://127.0.0.1:8787/health")
    if '"db":"up"' in h:
        db_up = True
        log("  ✓ /health db=up —— 数据库接通了")
        log("    " + h[:180])
        break
    time.sleep(1)
if not db_up:
    h = http_get("http://127.0.0.1:8787/health")
    log("  ★ db 仍未 up：" + h[:200])
    srv_log.flush()
    log("  服务端日志尾部：")
    log(open(SERVER_LOG, encoding="utf-8", errors="replace").read()[-2500:])
    sys.exit(1)

# ★★ db:"up" 还不够 —— migrate() 只在服务端启动时跑一次，
#   如果它启动时撞上 PG 恢复窗口而抛异常，服务端会**带着没建全的表**一直跑下去
#   （/health 的 db 探测只做 SELECT 1，照样报 up）。所以必须直接查表在不在，
#   否则后面会以「已接通」的名义跑出一条注定失败的链路。
srv_log.flush()
srv_txt = open(SERVER_LOG, encoding="utf-8", errors="replace").read()
if "数据库表就绪" not in srv_txt:
    log("  ★ 服务端日志里**没有**「数据库表就绪」—— migrate 没成功。")
    log("    /health 的 db=up 只证明能 SELECT 1，不证明表建好了。")
    log("    服务端日志：")
    log(srv_txt[-1500:])
    sys.exit(1)
log("  ✓ migrate 已成功（日志里有「数据库表就绪」）")

# 再直连核一次关键表真的在
tbl = subprocess.run(
    ["node", "-e",
     "const {Client}=require('pg');(async()=>{const c=new Client({"
     "connectionString:'postgresql://workbench:workbench@127.0.0.1:5432/workbench'});"
     "await c.connect();const r=await c.query(\"SELECT count(*)::int n FROM "
     "information_schema.tables WHERE table_schema='public'\");"
     "console.log('TABLES='+r.rows[0].n);await c.end();})()"
     ".catch(e=>{console.log('ERR:'+e.message)});"],
    cwd=ROOT, capture_output=True, text=True,
)
tbl_out = (tbl.stdout.strip() or tbl.stderr.strip())
log("  直连核表:", tbl_out)
if not tbl_out.startswith("TABLES=") or int(tbl_out.split("=")[1]) < 5:
    log("  ★ 表数量不对，数据库这一环不成立")
    sys.exit(1)

# ─────────────────────────────────────────────
# 4) 启动已安装的工作台
# ─────────────────────────────────────────────
# ★★ 每次用**全新**的 user-data-dir。
#
# 为什么必须清干净（本轮最大的坑，反复让结果"看起来是坏的"）：
#   profile 里残留的 localStorage token 指向**上一轮那个手机号建的账号**。
#   服务端重启后 token 可能不被认（/auth/me 401），App 会**先把 token 清掉再退回登录页**。
#   这个"退登录页"的过渡期间，`.inputbar` 可能**短暂出现**——脚本的
#   `main_ui_ready()` 恰好看到它 → 判定"已有登录态" → 跳过登录 →
#   但此时**没有任何智能体被绑定**（curAgentRef.current === null）→
#   sendChat() 第一句 `if (!agent) return` **静默返回**，
#   点发送毫无反应，不报错、不写 chatNote —— 就是最难查的那种假 PASS。
#
#   干净 profile = 必定落在登录页 → 必定走一遍真登录 → 账号/项目/智能体
#   全部由这一轮现建，没有任何上一轮的残留可依赖。
import shutil as _shutil
PROFILE = os.path.join(ROOT, "_e2e-profile")
if os.path.isdir(PROFILE):
    _shutil.rmtree(PROFILE, ignore_errors=True)
    log("  已清空上次的 user-data-dir（保证从登录页开始，不依赖残留登录态）")

log("")
log("=== 第 4 步：启动已安装的工作台 ===")
EXE = r"C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\AI 工作台.exe"
app = subprocess.Popen(
    [EXE, "--no-sandbox", f"--remote-debugging-port={CDP_PORT}",
     "--user-data-dir=" + os.path.join(ROOT, "_e2e-profile")],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
procs["app"] = app

# ─────────────────────────────────────────────
# CDP 客户端
# ─────────────────────────────────────────────
import websocket  # noqa: E402


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


def app_target():
    raw = http_get(f"http://127.0.0.1:{CDP_PORT}/json/list")
    if not raw:
        return None
    for t in json.loads(raw):
        if t.get("type") == "page" and "devtools://" not in (t.get("url") or ""):
            return t
    return None


log("  等待窗口出现…")
target = None
for _ in range(45):
    target = app_target()
    if target:
        break
    time.sleep(1)
if not target:
    log("  ★ 工作台窗口没起来")
    sys.exit(1)
log("  ✓ 窗口就绪:", target.get("title"), "| url:", target.get("url"))

c = Cdp(target["webSocketDebuggerUrl"])

# ★ 拿到 target ≠ 页面渲染好了。Electron 刚起时 CDP 可能连到一个还没跑 React 的
#   空壳（实测：querySelectorAll('input') 返回 []，填什么都填不进去，
#   最后表现成"没读到验证码"，其实压根没发出短信请求）。
#   必须轮询等到 DOM 真的渲染出来。
rendered = False
for i in range(60):
    n = c.js("document.querySelectorAll('input').length")
    txt_len = c.js("(document.body.innerText||'').length")
    if isinstance(n, int) and n > 0 and isinstance(txt_len, int) and txt_len > 20:
        rendered = True
        log(f"  ✓ 页面已渲染（第 {i + 1} 次轮询，input={n}, 文字 {txt_len} 字）")
        break
    time.sleep(1)
if not rendered:
    log("  ★ 页面一直没渲染出来，body:", str(c.js("document.body.innerHTML.slice(0,300)")))
    sys.exit(1)

# ─────────────────────────────────────────────
# 5) 登录
# ─────────────────────────────────────────────
log("")
log("=== 第 5 步：登录 ===")
# ★★ 不能只看 localStorage 里有没有 token 就跳过登录。
#   坑：App 启动时会拿 token 调 /auth/me，**一旦失败（服务端刚重启/库没就绪 → 503）
#   就会主动把 token 清掉并退回登录页**。于是会出现：
#     · 脚本读到 token 还在（那一刻）→ 报「已有登录态，跳过」
#     · 但界面其实已经/将要变成登录页 → .inputbar 不存在 → 发送静默失败
#   正确做法：等**主界面真的渲染出来**（.inputbar 出现）才算登录成功；
#   没出现就老老实实走一遍验证码登录。
def main_ui_ready(timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        if c.js("!!document.querySelector('.inputbar input')"):
            return True
        time.sleep(1)
    return False


if not main_ui_ready(timeout=20):
    log("  主界面没出来（token 可能已被 /auth/me 清掉），走验证码登录")
    phone = "186" + str(int(time.time()))[-8:]
    log("  手机号:", phone)
    # 填手机号（React 受控：insertText 后必须补 dispatchEvent('input')）
    def fill(sel, text):
        c.js(f"""
        (()=>{{const el=document.querySelector({sel!r});
        if(!el) return 'NO_EL';
        el.focus();
        const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
        s.call(el,''); el.dispatchEvent(new Event('input',{{bubbles:true}}));
        return 'OK';}})()
        """)
        c.send("Input.insertText", text=text)
        c.js(f"""
        document.querySelector({sel!r}).dispatchEvent(new Event('input',{{bubbles:true}}))
        """)
        return c.js(f"document.querySelector({sel!r}).value")

    # 定位手机号输入框
    info = c.js("""
    JSON.stringify(Array.from(document.querySelectorAll('input')).map((el,i)=>({
      i, type:el.type, ph:el.placeholder||'', cls:el.className||''})))
    """)
    log("  输入框:", info)
    try:
        inputs = json.loads(info or "[]")
    except Exception:  # noqa: BLE001
        inputs = []
    phone_sel = None
    for d in inputs:
        if d.get("type") in ("tel", "text") or "手机" in (d.get("ph") or ""):
            phone_sel = f"input[{d['i']}]"
            break
    if not phone_sel:
        phone_sel = "input"
    # 用 nth-of-type 不好定位，直接用下标
    idx = inputs[0]["i"] if inputs else 0
    js_sel = f"document.querySelectorAll('input')[{idx}]"
    c.js(f"{js_sel}.focus()")
    c.send("Input.insertText", text=phone)
    c.js(f"{js_sel}.dispatchEvent(new Event('input',{{bubbles:true}}))")
    log("  已填手机号 ->", c.js(f"{js_sel}.value"))

    # 点「获取验证码」
    clicked = c.js("""
    (()=>{const b=Array.from(document.querySelectorAll('button'))
      .find(x=>(x.innerText||'').includes('获取验证码'));
     if(!b) return 'NO_BTN'; b.click(); return 'CLICKED';})()
    """)
    log("  获取验证码:", clicked)

    # 从服务端日志里读验证码（只读点击后新写入的部分）
    srv_log.flush()
    base = os.path.getsize(SERVER_LOG)
    code = None
    for _ in range(20):
        time.sleep(1)
        with open(SERVER_LOG, encoding="utf-8", errors="replace") as f:
            f.seek(base)
            new = f.read()
        m = re.findall(r"(\d{6})", new)
        if m:
            code = m[-1]
            break
    if not code:
        log("  ★ 没读到验证码")
        sys.exit(1)
    log("  验证码:", code)

    # 填验证码 + 登录
    c.js("""
    (()=>{const els=Array.from(document.querySelectorAll('input'));
     const el=els.find(x=>/验证码/.test(x.placeholder||''))||els[els.length-1];
     if(el){el.focus(); window.__codeEl=el; return 'OK';} return 'NO_EL';})()
    """)
    c.send("Input.insertText", text=code)
    c.js("""
    (()=>{const els=Array.from(document.querySelectorAll('input'));
     const el=els.find(x=>/验证码/.test(x.placeholder||''))||els[els.length-1];
     el.dispatchEvent(new Event('input',{bubbles:true})); return el.value;})()
    """)
    log("  验证码框:", c.js("""
    (()=>{const els=Array.from(document.querySelectorAll('input'));
     const el=els.find(x=>/验证码/.test(x.placeholder||''))||els[els.length-1];
     return el.value;})()
    """))

    c.js("""
    (()=>{const b=Array.from(document.querySelectorAll('button'))
       .find(x=>/登录|注册/.test(x.innerText||''));
     if(!b) return 'NO_BTN'; b.click(); return 'CLICKED';})()
    """)
    time.sleep(4)
    tok = c.js("!!localStorage.getItem('workbench.token')")
    log("  登录态:", tok)
    if not tok:
        log("  ★ 登录失败，当前界面:", str(c.js("document.body.innerText.slice(0,300)")))
        sys.exit(1)
    log("  ✓ 登录成功")
else:
    log("  已有可用登录态（主界面已渲染）")

# ★ 无论走哪条路，**发任务之前必须确认主界面真的在**。
#   否则后面所有 c.js('.inputbar ...') 都会静默失败（`?.` / 异常被吞），
#   最后表现成"点了发送但任务没动"，而日志看上去一切正常。
if not c.js("!!document.querySelector('.inputbar input')"):
    log("  ★ 发任务前主界面仍不存在（.inputbar input 找不到）—— 中止，不能继续")
    log("    当前界面:", str(c.js("document.body.innerText.slice(0,200)")))
    sys.exit(1)

# ─────────────────────────────────────────────
# 6) 发任务
# ─────────────────────────────────────────────
log("")
log("=== 第 6 步：派一条任务 ===")
TASK = "打开 example.com，然后告诉我页面标题是什么"

# ★ 发任务前先记下基线，后面用**服务端计数**判"真的送达了"，
#   不能只看界面文案 —— 用户指令本身就含"标题"二字，会把进度判据喂饱（假 PASS）。
h0 = http_get("http://127.0.0.1:8787/health")
base_llm = int((re.search(r'"llmCalls":(\d+)', h0) or ["", "0"])[1])
base_loop = int((re.search(r'"liveLoops":(\d+)', h0) or ["", "0"])[1])
log(f"  基线：llmCalls={base_llm} liveLoops={base_loop}")

c.js("document.querySelector('.inputbar input')?.focus()")
# ★★ 往 React 受控 input 里塞值，**只有一种方式真的有效**（A/B 实测）：
#
#   | 方式                                   | React props.value | 结果     |
#   | -------------------------------------- | ----------------- | -------- |
#   | native value setter + dispatch('input') | 正确写入           | ✓ 送达   |
#   | CDP Input.insertText                    | 仍是空串           | ✗ 不送达 |
#   | CDP Input.dispatchKeyEvent（逐字符）     | 仍是空串           | ✗ 不送达 |
#
#   原因：`sendChat()` 开头是 `if (!value || streaming) return`，
#   而 value 取自 React 的 input state —— state 没更新就**静默返回**，
#   界面上点发送毫无反应，日志里却看起来一切正常（典型的静默假 PASS）。
#   所以这里必须**把值直接写进 React 认的那个 setter**，不能靠模拟输入法事件。
c.js(f"""
(()=>{{const el=document.querySelector('.inputbar input');
 if(!el) return 'NO_EL';
 // 先清空（走原生 setter），再写目标值 —— 两步都要派发 input 事件
 const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
 s.call(el,''); el.dispatchEvent(new Event('input',{{bubbles:true}}));
 s.call(el,{json.dumps(TASK)}); el.dispatchEvent(new Event('input',{{bubbles:true}}));
 return 'SET';}})()
""")

# ★ 不只看 DOM value —— 要直接读 **React 自己的 props.value**，
#   否则"DOM 里有、React 里没有"这种情况会漏过去（本轮踩的就是这个坑）。
inp_state = c.js("""
(()=>{const el=document.querySelector('.inputbar input');
 if(!el) return JSON.stringify({err:'NO_EL'});
 const k=Object.keys(el).find(k=>k.startsWith('__reactProps$'));
 if(!k) return JSON.stringify({err:'NO_REACT_PROPS'});
 return JSON.stringify({dom:el.value, react:el[k].value});})()
""")
log("  输入框状态:", inp_state)
try:
    parsed = json.loads(inp_state)
except Exception:
    parsed = {}
val = parsed.get("react", "")
if val.strip() != TASK:
    log(f"  ★ 输入没进 React state（react={val!r}，dom={parsed.get('dom')!r}），中止发送")
    sys.exit(1)
log("  ✓ 输入已进 React state")

# ★ 发送按钮要按**文案**挑，不能取 `.inputbar button` 的第一个 ——
#   inputbar 里还有「结束」等其它按钮，取第一个会点到别的、静默不发送。
send_res = c.js("""
(()=>{const bs=Array.from(document.querySelectorAll('.inputbar button'));
 const b=bs.find(x=>/发送|发\\s*送/.test(x.innerText||''));
 if(!b) return 'NO_SEND_BTN:'+bs.map(x=>x.innerText).join('/');
 b.click(); return 'CLICKED';})()
""")
log("  点发送:", send_res)
if not str(send_res).startswith("CLICKED"):
    log("  ★ 没找到发送按钮，中止")
    sys.exit(1)
log("  已发送，等 AI 干活…")

# ★ 送达校验：必须看到 llmCalls 真的涨、或 liveLoops 真的起过。
#   只看界面文案是不够的 —— 上一版就是这样把"没发出去"报成了 PASS。
delivered = False
prev = ""
done = False
for i in range(45):
    time.sleep(2)
    txt = str(c.js("document.body.innerText.slice(-500)") or "")
    h = http_get("http://127.0.0.1:8787/health")
    ll = int((re.search(r'"liveLoops":(\d+)', h) or ["", "0"])[1])
    lc = int((re.search(r'"llmCalls":(\d+)', h) or ["", "0"])[1])
    if lc > base_llm or ll > 0:
        delivered = True
    if txt != prev:
        log(f"  T+{i*2}s liveLoops={ll} llmCalls={lc} | 尾部: {txt[-120:]}")
        prev = txt
    # 完成判据：模型调用跑过、且已经没有在跑的循环
    if delivered and lc >= base_llm + 2 and ll == 0 and i >= 2:
        done = True
        break

if not delivered:
    log("  ★ 任务没送达服务端（llmCalls 零增长）—— 这是失败，不能记成已发送")
    sys.exit(1)
log("  ✓ 任务已送达并跑完" if done else "  ⚠ 送达了但没在时限内收敛")

# ─────────────────────────────────────────────
# 7) 截图 + 收尾
# ─────────────────────────────────────────────
log("")
log("=== 第 7 步：截图 ===")
try:
    import ctypes
    import win32con
    import win32gui
    import win32ui
    from PIL import Image

    ctypes.windll.shcore.SetProcessDpiAwareness(2)

    pid = app.pid
    hwnd = None

    def cb(h, _):
        global hwnd
        import win32process
        if win32process.GetWindowThreadProcessId(h)[1] == pid:
            if win32gui.IsWindowVisible(h):
                l, t, r, b = win32gui.GetWindowRect(h)
                if (r - l) > 300 and (b - t) > 200:
                    hwnd = h

    win32gui.EnumWindows(cb, None)
    if hwnd:
        win32gui.SetWindowPos(hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0,
                              win32con.SWP_NOMOVE | win32con.SWP_NOSIZE)
        time.sleep(1.8)
        l, t, r, b = win32gui.GetWindowRect(hwnd)
        w, hh = r - l, b - t
        dc = win32gui.GetWindowDC(0)
        mfc = win32ui.CreateDCFromHandle(dc)
        sdc = mfc.CreateCompatibleDC()
        bmp = win32ui.CreateBitmap()
        bmp.CreateCompatibleBitmap(mfc, w, hh)
        sdc.SelectObject(bmp)
        sdc.BitBlt((0, 0), (w, hh), mfc, (l, t), win32con.SRCCOPY)
        info = bmp.GetInfo()
        img = Image.frombuffer("RGB", (info["bmWidth"], info["bmHeight"]),
                               bmp.GetBitmapBits(True), "raw", "BGRX", 0, 1).copy()
        win32gui.DeleteObject(bmp.GetHandle())
        sdc.DeleteDC()
        mfc.DeleteDC()
        win32gui.ReleaseDC(0, dc)
        shot = os.path.join(SHOT_DIR, "e2e-task-running.png")
        img.save(shot)
        log("  ✓ 截图 ->", shot)
    else:
        log("  没找到窗口句柄")
except Exception as e:  # noqa: BLE001
    log("  截图失败:", str(e)[:200])

log("")
log("=== 收尾 ===")
for name, p in procs.items():
    try:
        p.terminate()
    except Exception:  # noqa: BLE001
        pass
time.sleep(1)
kill_port(8787)
log("  已停止")

with open(os.path.join(OUT, "run-task-e2e.log"), "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
log("日志 ->", os.path.join(OUT, "run-task-e2e.log"))
