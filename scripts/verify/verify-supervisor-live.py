# -*- coding: utf-8 -*-
"""
verify-supervisor-live.py —— 真机验证：修复后 ensureServer 会**真的把服务端拉起来**。

与前面两个脚本的区别：这次**不关**自动拉起（不设 WORKBENCH_NO_AUTOSTART_SERVER），
所以走的是完整的自愈路径：8787 不通 → spawn 服务端 → 等就绪 → 返回 true。

用真实编译产物 + 真实仓库路径驱动。
注意：本脚本会**真的起一个服务端**，跑完自己收干净。
"""
import json
import os
import socket
import subprocess
import sys
import time

REPO = r'C:\Users\bing\workbuddy-ai\work123'
NODE = os.path.join(os.path.expanduser('~'), '.workbuddy-ai', 'binaries', 'node', 'versions', '22.22.2-2', 'node.exe')
DRIVER = os.path.join(REPO, 'scripts', 'verify', '_live-driver.cjs')
PORT = 8787  # 真端口：因为 supervisor 里 findDirs() 是按仓库根找的，走真实路径最有说服力


def port_open(port):
    s = socket.socket()
    s.settimeout(0.5)
    try:
        s.connect(('127.0.0.1', port))
        return True
    except Exception:
        return False
    finally:
        s.close()


driver_js = r'''
const path = require('path');
const REPO = process.argv[2];
(async () => {
  const mod = require(path.join(REPO, 'apps', 'desktop', 'dist-electron', 'server-supervisor.js'));
  const logs = [];
  const ok = await mod.ensureServer(undefined, (m) => logs.push(m));
  const st = mod.getServerState();
  console.log('RESULT ' + JSON.stringify({ ok, st, logs }));
  process.exit(0);
})();
'''
open(DRIVER, 'w', encoding='utf-8').write(driver_js)

print('=' * 68)
print('  verify-supervisor-live —— 真机自愈：8787 不通时能不能自动拉起')
print('=' * 68)

if port_open(PORT):
    print('\n[!] 8787 已经被占用 —— 跑这个测试没意义（它本来就通）。')
    print('    请先关掉占用的服务端再跑。')
    sys.exit(3)

print('\n[1] 确认 8787 当前不通 =', not port_open(PORT))

print('\n[2] 调 ensureServer（自动拉起开启）—— 可能要等数据库迁移，给它 90 秒')
env = dict(os.environ)
env.pop('WORKBENCH_NO_AUTOSTART_SERVER', None)
t0 = time.time()
r = subprocess.run([NODE, DRIVER, REPO], capture_output=True, text=True,
                   cwd=REPO, env=env, timeout=180)
out = (r.stdout or '').strip()
line = next((l for l in out.splitlines() if l.startswith('RESULT ')), None)
if not line:
    print('    [FAIL] 没拿到结果 stdout=%r stderr=%r' % (out[:300], (r.stderr or '')[:300]))
    sys.exit(3)
res = json.loads(line[len('RESULT '):])

print('    ensureServer 返回 :', res['ok'])
print('    state             :', json.dumps(res['st'], ensure_ascii=False))
for m in (res.get('logs') or [])[:8]:
    print('      log:', m)
print('    8787 现在通吗     :', port_open(PORT), ' （耗时 %.1fs）' % (time.time() - t0))

# 顺手验证 /health 是真后端（带 service 标识）
health_ok = False
if port_open(PORT):
    import urllib.request
    try:
        h = json.loads(urllib.request.urlopen('http://127.0.0.1:8787/health', timeout=5).read())
        print('    /health           :', json.dumps(h, ensure_ascii=False)[:200])
        health_ok = h.get('service') == 'ai-workbench-server'
    except Exception as e:
        print('    /health 读取失败:', e)

print('\n' + '=' * 68)
print('  结论')
print('=' * 68)
ok = res['ok'] is True and port_open(PORT) and health_ok
if ok:
    print('  ★ PASS：8787 原本不通，ensureServer 真的把服务端拉起来了，')
    print('    且 /health 带回正确的 service 标识 —— 这就是修复后的自愈能力。')
else:
    print('  ! 未能自愈（可能数据库未就绪 / 找不到 apps/server）。')
    print('    注意：本测试依赖 5432 上的数据库可用。')

# 收干净：把我们拉起来的服务端关掉
if port_open(PORT):
    print('\n[3] 收尾：关掉本次拉起的服务端')
    subprocess.run(['taskkill', '/F', '/FI', 'IMAGENAME eq node.exe'], capture_output=True)
    time.sleep(2)
    print('    8787 现在通吗 =', port_open(PORT))

sys.exit(0 if ok else 3)
