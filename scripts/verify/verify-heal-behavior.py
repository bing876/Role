# -*- coding: utf-8 -*-
"""
verify-heal-behavior.py —— 验证修复后 ensureServer 会**重新探测**（而不是永久信任）。

★ 关键：必须让「外部服务端活着 → 死掉 → 再查」发生在**同一个 Node 进程**里。
  因为 `externalServerSeen` 是模块级变量；分两个进程跑的话第二个进程里它又是 false，
  老的短路分支永远走不到 —— 反证会**假 PASS**（这个坑已经踩过一次，见
  docs/acceptance/root-cause/heal-revert.log 的记录）。

所以流程是：
  1. 主进程起一个桩服务端，占住端口；
  2. 主进程再起一个 Node 子进程（驱动），子进程里：
       ensureServer() 第 1 次  → 应 True（此时桩活着）
       然后**阻塞等**主进程把桩杀掉
       ensureServer() 第 2 次  → 修复后应 False；老代码会是 True（永久信任）
  3. 主进程杀掉桩、写标志文件；子进程继续并输出结果。
"""
import json
import os
import socket
import subprocess
import sys
import time

REPO = r'C:\Users\bing\workbuddy-ai\work123'
NODE = os.path.join(os.path.expanduser('~'), '.workbuddy-ai', 'binaries', 'node', 'versions', '22.22.2-2', 'node.exe')
DRIVER = os.path.join(REPO, 'scripts', 'verify', '_heal-driver3.cjs')
PORT = 8797
FLAG = os.path.join(REPO, 'scripts', 'verify', '_heal-flag.txt')


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


def start_stub(port):
    code = (
        "import http.server,socketserver,json\n"
        "class H(http.server.BaseHTTPRequestHandler):\n"
        "    def do_GET(self):\n"
        "        b=json.dumps({'ok':True,'service':'ai-workbench-server'}).encode()\n"
        "        self.send_response(200)\n"
        "        self.send_header('content-type','application/json')\n"
        "        self.send_header('content-length',str(len(b)))\n"
        "        self.end_headers(); self.wfile.write(b)\n"
        "    def log_message(self,*a): pass\n"
        "socketserver.TCPServer.allow_reuse_address=True\n"
        f"s=socketserver.TCPServer(('127.0.0.1',{port}),H)\n"
        "s.serve_forever()\n"
    )
    return subprocess.Popen([sys.executable, '-c', code],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if os.path.exists(FLAG):
    os.remove(FLAG)

print('=' * 68)
print('  verify-heal-behavior —— 外部服务端先活后死，ensureServer 会不会自愈')
print('  （同一进程内完成，才能覆盖模块级 externalServerSeen）')
print('=' * 68)

print('\n[1] 起一个带正确标识的"外部服务端"桩')
stub = start_stub(PORT)
for _ in range(40):
    if port_open(PORT):
        break
    time.sleep(0.1)
print('    端口通 =', port_open(PORT))

env = dict(os.environ)
env['WORKBENCH_NO_AUTOSTART_SERVER'] = '1'  # 关自动拉起，只验"重新探测"这一步

print('\n[2] 起驱动子进程（它先查一次，然后等桩被杀，再查一次）')
proc = subprocess.Popen([NODE, DRIVER, REPO, str(PORT), FLAG],
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                        cwd=REPO, env=env)

# 等子进程完成"第一次"查询（它会在文件系统上没什么痕迹，所以固定等一会）
time.sleep(6)

print('\n[3] 主进程杀掉桩，并写标志文件让子进程继续')
stub.terminate()
stub.wait(timeout=10)
for _ in range(40):
    if not port_open(PORT):
        break
    time.sleep(0.1)
print('    端口通 =', port_open(PORT))
open(FLAG, 'w').write('dead')

out, err = proc.communicate(timeout=90)
line = next((l for l in (out or '').splitlines() if l.startswith('RESULT ')), None)
if not line:
    print('    [FAIL] 子进程没给结果。stdout=%r stderr=%r' % ((out or '')[:300], (err or '')[:300]))
    sys.exit(3)
res = json.loads(line[len('RESULT '):])

live = res.get('first')
dead = res.get('second')
print('\n    同一进程内：')
print('      ensureServer 第 1 次（桩活着）=', live, ' 状态 =', json.dumps(res.get('s1'), ensure_ascii=False))
print('      ensureServer 第 2 次（桩已死）=', dead, ' 状态 =', json.dumps(res.get('s2'), ensure_ascii=False))
for m in (res.get('logs') or [])[:8]:
    print('        log:', m)

if os.path.exists(FLAG):
    os.remove(FLAG)

print('\n' + '=' * 68)
print('  结论')
print('=' * 68)
print('  桩活着时 → ensureServer =', live, '（期望 True）')
print('  桩死后   → ensureServer =', dead, '（期望 False —— 老代码这里会是 True）')

ok = (live is True) and (dead is False)
if ok:
    print('\n  ★ PASS：桩消失后 ensureServer 会重新探测、如实报「不可用」，')
    print('    不再永久返回 true。应用因此能走到自愈/如实报错分支。')
else:
    print('\n  ! 不符合预期（或注入老行为后本该如此）—— 需人工核对。')
sys.exit(0 if ok else 3)
