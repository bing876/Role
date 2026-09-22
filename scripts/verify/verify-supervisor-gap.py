# -*- coding: utf-8 -*-
"""
verify-supervisor-gap.py —— 把 server-supervisor 的「永久信任外部服务端」缺陷钉死。

缺陷（apps/desktop/electron/server-supervisor.ts:374-378）：
    if (externalServerSeen) {
      setState({ reachable: true, ownedByUs: false });
      return true;          // 连 probe 都不做
    }
一旦探测到 8787 上有"不是我们起的"服务端，就把它记成 externalServerSeen=true，
**此后永久认定后端可用**。那个外部服务端后来死了，应用也不知道、也不自愈。

本脚本复刻这段逻辑（不改仓库代码），演示：
    场景 A：外部服务端先活后死 —— 旧逻辑仍然报 reachable=true（缺陷）
    场景 B：同样的时序 —— 每次重新探测的写法会正确报 false（修复后的行为）
"""
import socket
import subprocess
import sys
import time
import os

PORT = 8791  # 用未占用的端口，别撞 8787/5432/8901
PY = sys.executable


def port_open(port):
    s = socket.socket()
    s.settimeout(0.3)
    try:
        s.connect(('127.0.0.1', port))
        return True
    except Exception:
        return False
    finally:
        s.close()


def start_fake_server():
    """起一个只监听端口的最小 HTTP 服务，冒充"外部服务端"。"""
    code = (
        "import http.server,socketserver\n"
        "class H(http.server.BaseHTTPRequestHandler):\n"
        "    def do_GET(self):\n"
        "        b=b'{\"ok\":true}'\n"
        "        self.send_response(200)\n"
        "        self.send_header('content-type','application/json')\n"
        f"        self.send_header('content-length',str(len(b)))\n"
        "        self.end_headers()\n"
        "        self.wfile.write(b)\n"
        "    def log_message(self,*a): pass\n"
        f"socketserver.TCPServer.allow_reuse_address=True\n"
        f"s=socketserver.TCPServer(('127.0.0.1',{PORT}),H)\n"
        "s.serve_forever()\n"
    )
    return subprocess.Popen([PY, '-c', code],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class SupervisorOld:
    """复刻旧逻辑（带 externalServerSeen 短路）。"""

    def __init__(self, port):
        self.port = port
        self.external_server_seen = False
        self.probe_count = 0

    def probe(self):
        self.probe_count += 1
        return port_open(self.port)

    def ensure(self):
        if self.external_server_seen:          # ★ 缺陷点：连探测都省
            return True
        if self.probe():
            self.external_server_seen = True
            return True
        return False


class SupervisorFixed:
    """每次调用都重新探测（只是把短路去掉，其余不动）。"""

    def __init__(self, port):
        self.port = port
        self.probe_count = 0

    def probe(self):
        self.probe_count += 1
        return port_open(self.port)

    def ensure(self):
        return self.probe()


def scenario(kind):
    print('\n' + '=' * 64)
    print('  场景 %s：%s' % (kind, '旧逻辑（externalServerSeen 短路）'
                            if kind == 'A' else '修复后（每次重新探测）'))
    print('=' * 64)
    srv = SupervisorOld(PORT) if kind == 'A' else SupervisorFixed(PORT)

    # ---- 阶段 1：外部服务端活着 ----
    proc = start_fake_server()
    for _ in range(40):
        if port_open(PORT):
            break
        time.sleep(0.1)
    print('  外部服务端已起，8787 端口通 =', port_open(PORT))
    r1 = srv.ensure()
    print('  ensure() 第 1 次 → %s   (probe 次数=%d)' % (r1, srv.probe_count))

    # ---- 阶段 2：外部服务端死了（模拟 agent 工具调用结束回收进程）----
    proc.terminate()
    proc.wait(timeout=10)
    for _ in range(40):
        if not port_open(PORT):
            break
        time.sleep(0.1)
    print('  外部服务端已被回收，端口通 =', port_open(PORT))

    # ---- 阶段 3：用户此时点登录 ----
    r2 = srv.ensure()
    print('  ensure() 第 2 次 → %s   (probe 次数=%d)' % (r2, srv.probe_count))
    if r2:
        print('  应用认为后端**可用** → 用户请求打向一个已经没人监听的端口 → 报错')
    else:
        print('  应用发现后端**不可用** → 会去自动拉起 / 如实报错')
    return {'first': r1, 'second': r2, 'probes': srv.probe_count}


a = scenario('A')
b = scenario('B')

print('\n' + '=' * 64)
print('  结论')
print('=' * 64)
print('  旧逻辑：第1次=%s 第2次=%s（probe 只跑了 %d 次）'
      % (a['first'], a['second'], a['probes']))
print('  修复后：第1次=%s 第2次=%s（probe 跑了 %d 次）'
      % (b['first'], b['second'], b['probes']))

ok = (a['second'] is True) and (b['second'] is False) and (b['probes'] > a['probes'])
if ok:
    print('\n  ★ PASS：旧逻辑在外部服务端死后**仍然报可用**（这就是用户登录失败的机制）；')
    print('    去掉短路、每次重新探测后，能正确发现后端已死。')
else:
    print('\n  ! 结果不符合预期，需人工核对。')
sys.exit(0 if ok else 3)
