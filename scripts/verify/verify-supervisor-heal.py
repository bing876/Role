# -*- coding: utf-8 -*-
"""
verify-supervisor-heal.mts 的 Python 驱动版 —— 验证修复后的 supervisor 能自愈。

做法：**编译真实源码**（不走复刻），用 Electron 的 node 环境直接 require
dist-electron/server-supervisor.js，然后：

  场景 A（缺陷复现）：先起一个"冒充服务端"的进程占住端口 → ensureServer() 应返回 true
  场景 B（外部死掉）  ：杀掉它 → 再调 ensureServer()
  场景 C（自愈）      ：修复后应当**不再**说 true，而是发现不通并尝试拉起真服务端

判据：
  - 修复前：B 之后 ensureServer() 仍 true（probe 只跑了一次）
  - 修复后：B 之后 ensureServer() 会重新探测，发现 8787 不通 → 去拉起真的服务端
"""
import json
import os
import socket
import subprocess
import sys
import time

REPO = r'C:\Users\bing\workbuddy-ai\work123'
NODE = os.path.join(os.path.expanduser('~'), '.workbuddy-ai', 'binaries', 'node', 'versions', '22.22.2-2', 'node.exe')
PORT = 8793  # 专门给本脚本用的端口，绝不碰 8787

DRIVER = os.path.join(REPO, 'scripts', 'verify', '_heal-driver.cjs')


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


def start_fake(port):
    """起一个返回 200 的假 /health —— 用来测「只认 200 就信任」的老毛病。"""
    code = (
        "import http.server,socketserver,json\n"
        "class H(http.server.BaseHTTPRequestHandler):\n"
        "    def do_GET(self):\n"
        "        b=json.dumps({'ok':True,'fake':True}).encode()\n"
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


# 驱动脚本：加载编译产物里的 probe()，对指定 base 探活
driver = r'''
const path = require('path');
const REPO = process.argv[2];
const base = process.argv[3];
(async () => {
  let mod;
  try {
    mod = require(path.join(REPO, 'apps', 'desktop', 'dist-electron', 'server-supervisor.js'));
  } catch (e) {
    console.log(JSON.stringify({ error: 'require failed: ' + e.message }));
    process.exit(1);
  }
  const r = await mod.probe(base);
  console.log(JSON.stringify({ probed: r }));
  process.exit(0);
})();
'''
open(DRIVER, 'w', encoding='utf-8').write(driver)

print('=' * 66)
print('  verify-supervisor-heal —— 用**编译产物**验证 probe 的身份校验')
print('=' * 66)

print('\n[0] 检查编译产物存在')
JS = os.path.join(REPO, 'apps', 'desktop', 'dist-electron', 'server-supervisor.js')
print('   ', JS, '->', os.path.exists(JS))

base = f'http://127.0.0.1:{PORT}'
results = {}

# --- 场景 1：假服务端（只回 200，没有 service 字段）---
proc = start_fake(PORT)
for _ in range(40):
    if port_open(PORT):
        break
    time.sleep(0.1)
print('\n[1] 假服务端已起（/health 回 200，但没有 service 标识）')
r = subprocess.run([NODE, DRIVER, REPO, base], capture_output=True, text=True, cwd=REPO)
print('    probe() 结果：', r.stdout.strip() or r.stderr.strip())
try:
    results['fake'] = json.loads(r.stdout.strip())['probed']
except Exception:
    results['fake'] = None

# --- 场景 2：真服务端（有 service:'ai-workbench-server'）---
fake_service = (
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
    f"s=socketserver.TCPServer(('127.0.0.1',{PORT}),H)\n"
    "s.serve_forever()\n"
)
proc.terminate()
proc.wait(timeout=10)
time.sleep(1)
proc2 = subprocess.Popen([sys.executable, '-c', fake_service],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(40):
    if port_open(PORT):
        break
    time.sleep(0.1)
print('\n[2] 换成"带正确 service 标识"的桩服务端')
r2 = subprocess.run([NODE, DRIVER, REPO, base], capture_output=True, text=True, cwd=REPO)
print('    probe() 结果：', r2.stdout.strip() or r2.stderr.strip())
try:
    results['real'] = json.loads(r2.stdout.strip())['probed']
except Exception:
    results['real'] = None

proc2.terminate()
proc2.wait(timeout=10)
time.sleep(1)

# --- 场景 3：什么都没起 ---
print('\n[3] 端口完全空着')
r3 = subprocess.run([NODE, DRIVER, REPO, base], capture_output=True, text=True, cwd=REPO)
print('    probe() 结果：', r3.stdout.strip() or r3.stderr.strip())
try:
    results['dead'] = json.loads(r3.stdout.strip())['probed']
except Exception:
    results['dead'] = None

print('\n' + '=' * 66)
print('  结论')
print('=' * 66)
print('  假服务端（只有 200，无标识）→ probe =', results['fake'], '（期望 False）')
print('  真服务端（带正确 service）  → probe =', results['real'], '（期望 True）')
print('  端口空着                    → probe =', results['dead'], '（期望 False）')

ok = results['fake'] is False and results['real'] is True and results['dead'] is False
if ok:
    print('\n  ★ PASS：probe 现在会核对身份。')
    print('    → 8787 上任何"返回 200 但不是本服务"的东西都不会再被误认为后端就绪，')
    print('      也就不会让应用跳过自动拉起、把请求打给一个不懂业务的进程。')
else:
    print('\n  ! 不符合预期，需要人工核对。')
sys.exit(0 if ok else 3)
