"""
工作台遥控器 —— 通过 CDP 连上正在跑的 Electron 窗口，读界面 / 点按钮 / 打字。

为什么用 CDP 而不是 OS 级鼠标键盘（见 electron-ui-verify 技能）：
    这台机器桌面常被别的应用抢前台，OS 点击经常落空，而且落空时**看起来和"按钮坏了"一样**。
    CDP 直接作用于渲染进程，不受前台影响。

用法（把 PORT 当环境变量，同一套脚本能连不同实例）：
    python wbctl.py list                      # 列所有 target
    python wbctl.py js "<表达式>"              # 在应用窗口里跑 JS，打印结果
    python wbctl.py health                    # 打服务端 /health
"""
import json
import os
import sys
import time
import urllib.request

PORT = os.environ.get("WB_PORT", "9333")


def _opener():
    # 必须绕过宿主机代理，否则连 localhost 也会被劫持
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def targets():
    raw = _opener().open(f"http://127.0.0.1:{PORT}/json/list", timeout=10).read()
    return json.loads(raw)


def app_target(match="localhost:5173"):
    for t in targets():
        if t.get("type") == "page" and match in (t.get("url") or ""):
            return t
    raise SystemExit(f"没找到匹配 {match!r} 的 page target；现有："
                     + ", ".join(f"{t['type']}:{t.get('url','')[:60]}" for t in targets()))


class Cdp:
    """一个带重连的 CDP 客户端。

    ★ 必须自带重连：Electron 刚起时 /json/list 可能回一个还没就绪的渲染进程，
      ws 连得上但第一条命令就超时。没有重连会把"一次抖动"升级成"整轮失败"。
    """

    def __init__(self, target, timeout=30):
        import websocket

        self.ws_url = target["webSocketDebuggerUrl"]
        self.timeout = timeout
        self._id = 0
        self._connect()

    def _connect(self):
        import websocket

        self.ws = websocket.create_connection(
            self.ws_url, timeout=self.timeout, suppress_origin=True
        )
        # 握手要验活：发一条最便宜的命令，失败就抛出去让上层重连
        self.send("Runtime.evaluate", expression="1", returnByValue=True)

    def send(self, method, **params):
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method} 出错: {msg['error']}")
                return msg.get("result", {})

    def js(self, expr, await_promise=True):
        r = self.send(
            "Runtime.evaluate",
            expression=expr,
            returnByValue=True,
            awaitPromise=await_promise,
            userGesture=True,
        )
        res = r.get("result", {})
        if r.get("exceptionDetails"):
            return {"__error__": str(r["exceptionDetails"])[:400]}
        return res.get("value")

    def close(self):
        try:
            self.ws.close()
        except Exception:  # noqa: BLE001
            pass


def connect(match="localhost:5173", retries=3):
    last = None
    for _ in range(retries):
        try:
            return Cdp(app_target(match))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5)
    raise SystemExit(f"连不上 CDP：{last}")


def health():
    raw = _opener().open("http://127.0.0.1:8787/health", timeout=10).read()
    return json.loads(raw)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "list":
        for t in targets():
            print(f"  {t['type']:8s} {t.get('url','')[:90]}")
    elif cmd == "js":
        c = connect()
        print(json.dumps(c.js(sys.argv[2]), ensure_ascii=False, indent=2))
        c.close()
    elif cmd == "health":
        print(json.dumps(health(), ensure_ascii=False, indent=2))
    else:
        print("用法: wbctl.py [list|js <表达式>|health]")
