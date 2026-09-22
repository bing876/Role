"""
第 28 步换装后的**启动冒烟**：证明装进去的新 asar 真的能起来、且加载的是本轮渲染层产物。

★ 规则（踩过的坑）：
 - 安装版必须 --no-sandbox（否则 1 秒 GPU FATAL 退出，会误判成"包坏了"）
 - agent 不能常驻进程 ⇒ 启动 / 连 CDP / 断言 / 收尾 必须在**同一次调用**里跑完
 - readyState==='loading' 时读 links/scripts 会得到空（假红）⇒ 必须轮询到 complete
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

EXE = r"C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\AI 工作台.exe"
PORT = 9348
USER_DATA = r"C:\Users\bing\AppData\Roaming\@ai-workbench\desktop"

proc = None
ok = True


def log(tag, msg):
    print(("✓ " if tag == "ok" else "✗ " if tag == "bad" else "  ") + msg, flush=True)


def http_json(url, timeout=3):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


try:
    cmd = [EXE, "--no-sandbox", f"--remote-debugging-port={PORT}", f"--user-data-dir={USER_DATA}"]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    log("--", f"启动 PID={proc.pid}")

    # 1) CDP 端口
    ver = None
    for _ in range(40):
        time.sleep(1)
        if proc.poll() is not None:
            break
        try:
            ver = http_json(f"http://127.0.0.1:{PORT}/json/version")
            break
        except Exception:
            continue
    if not ver:
        log("bad", f"CDP 端口没起来（进程 exit={proc.poll()}）")
        ok = False
        raise SystemExit(1)
    log("ok", "CDP 已通: " + str(ver.get("Browser"))[:60])

    # 2) 找页面
    targets = None
    for _ in range(30):
        time.sleep(1)
        try:
            targets = [t for t in http_json(f"http://127.0.0.1:{PORT}/json/list") if t.get("type") == "page"]
        except Exception:
            continue
        if targets:
            break
    if not targets:
        log("bad", "没有 page 类型的 target")
        ok = False
        raise SystemExit(1)
    log("ok", f"页面 target: {targets[0].get('url', '')[:70]}")

    # 3) WebSocket 直连断言（不装 websocket 库时用 CDP over http 不行 ⇒ 用最小 ws 客户端）
    import base64
    import socket
    import struct

    ws_url = targets[0]["webSocketDebuggerUrl"]

    class WS:
        def __init__(self, url):
            assert url.startswith("ws://")
            rest = url[5:]
            hostport, path = rest.split("/", 1)
            host, port = hostport.split(":")
            self.s = socket.create_connection((host, int(port)), timeout=10)
            key = base64.b64encode(os.urandom(16)).decode()
            self.s.sendall(
                (
                    f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
                    f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
                ).encode()
            )
            buf = b""
            while b"\r\n\r\n" not in buf:
                buf += self.s.recv(4096)
            self.buf = buf.split(b"\r\n\r\n", 1)[1]

        def _recv(self, n):
            while len(self.buf) < n:
                d = self.s.recv(65536)
                if not d:
                    raise EOFError
                self.buf += d
            out, self.buf = self.buf[:n], self.buf[n:]
            return out

        def send(self, obj):
            payload = json.dumps(obj).encode()
            hdr = bytearray([0x81])
            n = len(payload)
            if n < 126:
                hdr.append(0x80 | n)
            elif n < 65536:
                hdr.append(0x80 | 126)
                hdr += struct.pack("!H", n)
            else:
                hdr.append(0x80 | 127)
                hdr += struct.pack("!Q", n)
            mask = os.urandom(4)
            self.s.sendall(bytes(hdr) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

        def recv(self):
            while True:
                b0, b1 = self._recv(2)
                ln = b1 & 0x7F
                if ln == 126:
                    ln = struct.unpack("!H", self._recv(2))[0]
                elif ln == 127:
                    ln = struct.unpack("!Q", self._recv(8))[0]
                data = self._recv(ln) if ln else b""
                try:
                    o = json.loads(data.decode("utf-8"))
                except Exception:
                    continue
                if o.get("id"):
                    return o

        def call(self, method, params=None):
            i = int(time.time() * 1000) % 100000
            self.send({"id": i, "method": method, "params": params or {}})
            while True:
                o = self.recv()
                if o.get("id") == i:
                    return o

    ws = WS(ws_url)
    ws.call("Runtime.enable")

    def ev(expr):
        r = ws.call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
        return (r.get("result") or {}).get("result", {}).get("value")

    # 4) 轮询到页面真的加载完（★ 早读会拿到空 ⇒ 假红）
    info = None
    for _ in range(40):
        time.sleep(1)
        info = ev(
            "JSON.stringify({rs:document.readyState,"
            "u:location.href,"
            "s:[...document.querySelectorAll('script')].map(x=>x.src||''),"
            "c:[...document.querySelectorAll('link')].map(x=>x.href||'')})"
        )
        if info:
            d = json.loads(info)
            if d.get("rs") == "complete" and d.get("s"):
                break
    d = json.loads(info or "{}")
    log("--", f"readyState={d.get('rs')} url={str(d.get('u'))[:70]}")
    if d.get("rs") != "complete":
        log("bad", "页面没加载完")
        ok = False
    else:
        log("ok", "页面加载完")
    if any("index-CxiIFZWK.js" in x for x in d.get("s", [])):
        log("ok", "加载的是本轮渲染层产物 index-CxiIFZWK.js")
    else:
        log("bad", "渲染层产物不是本轮的: " + ",".join(d.get("s", []))[:120])
        ok = False

    # 5) 关键 DOM/文案（登录页或主界面任一即可）
    body = ev("document.body ? document.body.innerText.slice(0,120) : ''") or ""
    log("--", "页面文字: " + body.replace("\n", " | ")[:110])

except SystemExit:
    ok = False
except Exception as e:
    log("bad", f"异常: {type(e).__name__}: {e}")
    ok = False
finally:
    if proc and proc.poll() is None:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        log("--", "已收尾杀掉应用进程")
    print("\n结果: " + ("PASS" if ok else "FAIL"), flush=True)
    sys.exit(0 if ok else 1)
