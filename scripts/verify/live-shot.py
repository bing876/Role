# -*- coding: utf-8 -*-
"""给「正在运行的真实窗口」截图（带重试）。

用法：
  python live-shot.py [输出png路径]

为什么不用 cdp-probe 的 Cdp 类：它为了做断言会先 Runtime.enable 并吃掉一堆通知；
在「真实运行中的应用窗口」上复用那条连接发 Page.captureScreenshot 会**必超时**。
这里刻意只做最少的事：连上 -> 发一帧 -> 收一帧 -> 写盘。

超时重试：Electron 窗口在忙（刚导航完 / React 正在渲染）时，
第一条 ws 连接**会**在建连后立刻拿到超时，重开一条往往就成功了。
"""
import base64
import json
import os
import sys
import time
import urllib.request

import websocket

CDP = 'http://127.0.0.1:%s' % os.environ.get('WB_LIVE_PORT', '9333')
MATCH = os.environ.get('WB_LIVE_MATCH', 'localhost:5273')


def pick():
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    lst = json.load(op.open(CDP + '/json/list', timeout=15))
    for t in lst:
        if t.get('type') == 'page' and MATCH in (t.get('url') or ''):
            return t
    raise RuntimeError('no page target for %s' % MATCH)


def grab_one(out, timeout=25):
    t = pick()
    ws = websocket.create_connection(t['webSocketDebuggerUrl'], timeout=timeout,
                                     suppress_origin=True)
    try:
        ws.send(json.dumps({'id': 1, 'method': 'Page.captureScreenshot',
                            'params': {'format': 'png'}}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get('id') == 1:
                if 'error' in msg:
                    raise RuntimeError(msg['error'])
                data = msg['result']['data']
                break
    finally:
        try:
            ws.close()
        except Exception:  # noqa: BLE001
            pass
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, 'wb') as f:
        f.write(base64.b64decode(data))
    return os.path.getsize(out)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else 'docs/acceptance/live/current.png'
    last = None
    for k in range(5):
        try:
            n = grab_one(out)
            print('saved -> %s (%d bytes, 第 %d 次尝试)' % (out, n, k + 1), flush=True)
            return 0
        except Exception as e:  # noqa: BLE001
            last = e
            print('[retry %d] %s' % (k + 1, e), flush=True)
            time.sleep(1.5 * (k + 1))
    print('FAILED:', last, flush=True)
    return 1


if __name__ == '__main__':
    sys.exit(main())
