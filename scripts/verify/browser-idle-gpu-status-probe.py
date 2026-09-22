# -*- coding: utf-8 -*-
r"""
闲置浏览器 **GPU 加速状态** 探针 —— 只诊断，不改产品代码。

为什么需要它
  前一个 GPU 探针发现：本应用那几个 electron.exe 进程**一条 GPU Engine 计数器都没有**
  （其他进程有）。这通常意味着**根本没在用 GPU**（退回软件渲染 SwiftShader）。
  用 CDP 的 `SystemInfo.getInfo`（连**浏览器级**端点，不需要登录）拿权威结论：
    · `gpu.featureStatus` —— 各特性是 enabled / disabled / unavailable
    · `gpu.auxAttributes.gl_renderer` —— 真正的渲染器（SwiftShader = 软件渲染）
    · `gpu.devices` —— 有没有可用 GPU 设备

用法
  C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe \
      -u scripts/verify/browser-idle-gpu-status-probe.py
"""

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

os.environ['FB_CDP_PORT'] = os.environ.get('IS_CDP_PORT', '9351')
os.environ['FB_API_PORT'] = os.environ.get('IS_API_PORT', '8801')
os.environ['FB_FAKE_PORT'] = os.environ.get('IS_FAKE_PORT', '8902')
os.environ['FB_VITE_PORT'] = os.environ.get('IS_VITE_PORT', '5187')

_spec = importlib.util.spec_from_file_location(
    'fbt', os.path.join(HERE, 'fullscreen-browser-tests.py'))
F = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(F)

OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'browser-idle-perf')
F.OUTDIR = OUTDIR
F.TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wb-gpustat')
F.PROFILE = os.path.join(F.TMP, 'profile')
os.makedirs(OUTDIR, exist_ok=True)

NODE = F.NODE
API_PORT, VITE_PORT, CDP_PORT = F.API_PORT, F.VITE_PORT, F.CDP_PORT
VITE_LOG = os.path.join(OUTDIR, 'vite-gpustat.log')
ELECTRON_LOG = os.path.join(OUTDIR, 'electron-gpustat.log')

REPORT = []


def log(*a):
    s = ' '.join(str(x) for x in a)
    REPORT.append(s)
    print(s, flush=True)


def section(t):
    log('')
    log('=' * 78)
    log(t)
    log('=' * 78)


def electron_pids():
    try:
        out = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq electron.exe', '/FO', 'CSV', '/NH'],
                             capture_output=True).stdout.decode('gbk', 'replace')
    except Exception:
        return set()
    return set(int(m.group(1)) for m in
               (re.match(r'"electron\.exe","(\d+)"', l.strip()) for l in out.splitlines()) if m)


def browser_ws(port, tries=20):
    """拿**浏览器级** CDP 端点（不是某个页面）。"""
    import urllib.request
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(tries):
        try:
            d = json.load(op.open('http://127.0.0.1:%d/json/version' % port, timeout=4))
            ws = d.get('webSocketDebuggerUrl')
            if ws:
                return ws, d
        except Exception:
            pass
        time.sleep(1)
    return None, None


def main():
    section('0. 环境自检')
    VITE_BIN = F.first_existing(os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                                os.path.join(F.DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'))
    if not VITE_BIN:
        log('  ★ 缺 vite')
        return 2
    busy = [p for p in (API_PORT, VITE_PORT, CDP_PORT) if F.port_busy(p)]
    log('  端口占用：%s' % (busy or '无（干净）'))
    if busy:
        return 2
    e_before = electron_pids()

    section('1. 起 Electron（**不需要登录**，只看 GPU 状态）')
    shutil.rmtree(F.TMP, ignore_errors=True)
    os.makedirs(F.PROFILE, exist_ok=True)
    F.spawn('vite', [NODE, VITE_BIN, '--port', str(VITE_PORT), '--strictPort'], F.DESKTOP,
            log=VITE_LOG)
    time.sleep(4)
    F.spawn('electron', [NODE, 'scripts/start-electron.mjs',
                         '--user-data-dir=%s' % F.PROFILE,
                         '--remote-debugging-port=%d' % CDP_PORT], F.DESKTOP,
            env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT},
            log=ELECTRON_LOG)
    ok, _, ms = F.wait_until(lambda: bool(F.P.page('localhost:%d' % VITE_PORT)), timeout=90)
    log('  窗口出现：%s（%dms）' % (ok, ms))
    if not ok:
        return 2
    time.sleep(3)

    section('2. 这次启动有没有回退 --no-sandbox（看日志）')
    try:
        txt = open(ELECTRON_LOG, encoding='utf-8', errors='replace').read()
    except Exception:
        txt = ''
    log('  GPU 崩溃行数：%d' % len(re.findall(r'GPU process exited unexpectedly', txt)))
    log('  "GPU process isn\'t usable" 出现：%s' % ('Goodbye' in txt))
    log('  回退 --no-sandbox 提示出现：%s' % ('自动回退 --no-sandbox' in txt))
    log('  启动尝试次数（DevTools listening 出现次数）：%d'
        % len(re.findall(r'DevTools listening on', txt)))

    section('3. CDP SystemInfo.getInfo（浏览器级端点）')
    ws, ver = browser_ws(CDP_PORT)
    if not ws:
        log('  ★ 拿不到浏览器级 CDP 端点')
        return 2
    log('  浏览器：%s' % (ver or {}).get('Browser'))
    import websocket
    conn = websocket.create_connection(ws, timeout=30, suppress_origin=True)
    try:
        conn.send(json.dumps({'id': 1, 'method': 'SystemInfo.getInfo', 'params': {}}))
        info = None
        for _ in range(50):
            msg = json.loads(conn.recv())
            if msg.get('id') == 1:
                info = msg.get('result') or {}
                break
    finally:
        try:
            conn.close()
        except Exception:
            pass
    if not info:
        log('  ★ SystemInfo.getInfo 没返回')
        return 2

    gpu = info.get('gpu') or {}
    devs = gpu.get('devices') or []
    log('  GPU 设备数：%d' % len(devs))
    for d in devs:
        log('    · vendorId=%s deviceId=%s  active=%s'
            % (d.get('vendorId'), d.get('deviceId'), d.get('active')))
    aux = gpu.get('auxAttributes') or {}
    log('  gl_renderer : %s' % aux.get('gl_renderer'))
    log('  gl_vendor   : %s' % aux.get('gl_vendor'))
    log('  gl_version  : %s' % aux.get('gl_version'))
    log('  driverBugWorkarounds: %s' % str(aux.get('driverBugWorkarounds'))[:200])
    log('  软件渲染（softwareRendering）= %s' % aux.get('softwareRendering'))
    log('')
    log('  ★ 各特性状态（featureStatus）：')
    fs = gpu.get('featureStatus') or {}
    for k in sorted(fs):
        log('    %-34s %s' % (k, fs[k]))

    section('4. 渲染层自报的 WebGL 渲染器（一锤定音）')
    # ★ featureStatus 说 gpu_compositing=enabled，但 GPU 进程每次都崩、还会回退 --no-sandbox，
    #   两个信号矛盾。WebGL 的 UNMASKED_RENDERER 是渲染进程**实际拿到**的渲染器：
    #   出现 SwiftShader / "Software" ⇒ 真软件渲染；出现 NVIDIA/AMD/Intel ⇒ 真硬件加速。
    webgl_js = r"""
    (() => {
      const out = {};
      try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        if (!gl) { out.webgl = 'no-context'; return out; }
        out.webgl = 'ok';
        const e = gl.getExtension('WEBGL_debug_renderer_info');
        if (e) {
          out.unmaskedRenderer = gl.getParameter(e.UNMASKED_RENDERER_WEBGL);
          out.unmaskedVendor = gl.getParameter(e.UNMASKED_VENDOR_WEBGL);
        } else {
          out.unmaskedRenderer = gl.getParameter(gl.RENDERER);
          out.unmaskedVendor = gl.getParameter(gl.VENDOR);
        }
        out.version = gl.getParameter(gl.VERSION);
      } catch (err) { out.err = String(err); }
      try {
        const c2 = document.createElement('canvas');
        const gl2 = c2.getContext('webgl2');
        out.webgl2 = gl2 ? 'ok' : 'no-context';
      } catch (err) { out.webgl2 = 'err:' + err; }
      return out;
    })()
    """
    try:
        c = F.P.Cdp()
        wg = c.js(webgl_js)
        log('  主窗口渲染进程：%s' % json.dumps(wg, ensure_ascii=False))
    except Exception as e:
        log('  ★ 读 WebGL 失败：%s' % e)
        wg = None

    section('5. 结论')
    sr = aux.get('softwareRendering')
    renderer = str((wg or {}).get('unmaskedRenderer') or '')
    log('  featureStatus.gpu_compositing = %s' % fs.get('gpu_compositing'))
    log('  featureStatus.rasterization   = %s' % fs.get('rasterization'))
    log('  WebGL UNMASKED_RENDERER       = %s' % (renderer or '(拿不到)'))
    if 'swiftshader' in renderer.lower() or 'software' in renderer.lower():
        log('  ⇒ **确认是软件渲染**：所有绘制/合成在 CPU 上，滚动/动画会明显更吃 CPU。')
    elif renderer:
        log('  ⇒ **确认是硬件加速**：渲染器是 %s。GPU 进程启动时崩溃只是"首次尝试"的问题，'
            '回退 --no-sandbox 之后已恢复。' % renderer)
    else:
        log('  ⇒ 两个信号都没拿到，无法判定（需人工看 chrome://gpu）。')

    with open(os.path.join(OUTDIR, 'gpu-status.json'), 'w', encoding='utf-8') as f:
        json.dump(info, f, ensure_ascii=False, indent=2)
    with open(os.path.join(OUTDIR, 'gpu-status-report.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(REPORT))

    section("6. 收尾")
    for tag, p in F.PROCS:
        try:
            p.terminate()
        except Exception:
            pass
    time.sleep(2)
    for tag, p in F.PROCS:
        try:
            if p.poll() is None:
                p.kill()
        except Exception:
            pass
    try:
        new = sorted(electron_pids() - e_before)
        if new:
            subprocess.run(['taskkill', '/F'] + sum([['/PID', str(x)] for x in new], []),
                           capture_output=True)
            log('  已结束新起的 electron.exe：%s' % new)
    except Exception as e:
        log('  收尾出错：%s' % e)
    log('  证据目录：%s' % OUTDIR)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
