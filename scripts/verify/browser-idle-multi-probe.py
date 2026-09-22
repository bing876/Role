# -*- coding: utf-8 -*-
r"""
**多实例成本曲线 + 交互（滚动）帧时间** 探针 —— 只诊断，不改产品代码。

要回答两个问题
  ① 你说"只开启 1 个浏览器实例"—— 但按设计**所有智能体、所有项目的 `<webview>` 都是一直挂着的**
     （只有"零页"才卸载）。所以实际挂着的可能不止 1 张。这里把 **1/2/3/4 张**的成本曲线量出来。
  ② "卡顿"最常见的体感是**滚动掉帧**。这里在应用 UI 和内嵌页里各做一次**真实滚轮滚动**，
     量滚动期间的帧间隔。

怎么干净地开多张页
  `isStartPage(url)` = `url.startsWith('data:text/html')`，而起始页**不参与同站复用** ⇒
  传 `data:text/html,…` 每次都会**新开一张 tab**。所以每张页都用一个内容不同的
  `data:` URL（顺带让页面够高，可以滚动）。

★ 前提（沿用教训）：每段前先提前台并**回读 `document.hidden === false`**。

用法
  C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe \
      -u scripts/verify/browser-idle-multi-probe.py
"""

import ctypes
import importlib.util
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import time
from ctypes import wintypes

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

os.environ['FB_CDP_PORT'] = os.environ.get('IM_CDP_PORT', '9363')
os.environ['FB_API_PORT'] = os.environ.get('IM_API_PORT', '8813')
os.environ['FB_FAKE_PORT'] = os.environ.get('IM_FAKE_PORT', '8914')
os.environ['FB_VITE_PORT'] = os.environ.get('IM_VITE_PORT', '5199')

_spec = importlib.util.spec_from_file_location(
    'fbt', os.path.join(HERE, 'fullscreen-browser-tests.py'))
F = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(F)

OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'browser-idle-perf')
F.OUTDIR = OUTDIR
F.TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wb-multi')
F.PROFILE = os.path.join(F.TMP, 'profile')
os.makedirs(OUTDIR, exist_ok=True)

P = F.P
NODE = F.NODE
API, FAKE = F.API, F.FAKE
FAKE_PORT = F.FAKE_PORT
API_PORT, VITE_PORT, CDP_PORT = F.API_PORT, F.VITE_PORT, F.CDP_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm-multi.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server-multi.log')

MAX_N = int(os.environ.get('IM_MAX_N', '4'))
MEASURE_SECS = int(os.environ.get('IM_MEASURE_SECS', '8'))
SCROLL_SECS = int(os.environ.get('IM_SCROLL_SECS', '6'))
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


_u32 = ctypes.windll.user32


def raise_app_window(pids):
    found = []
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _):
        try:
            if not _u32.IsWindowVisible(hwnd):
                return True
            pid = wintypes.DWORD()
            _u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value in pids:
                n = _u32.GetWindowTextLengthW(hwnd)
                buf = ctypes.create_unicode_buffer(n + 1)
                _u32.GetWindowTextW(hwnd, buf, n + 1)
                if buf.value.strip():
                    found.append((hwnd, buf.value))
        except Exception:
            pass
        return True

    _u32.EnumWindows(WNDENUMPROC(cb), 0)
    if not found:
        return None, []
    hwnd = found[0][0]
    _u32.ShowWindow(hwnd, 9)
    time.sleep(0.2)
    _u32.SetWindowPos(hwnd, 0, 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0040)
    time.sleep(0.2)
    _u32.SetForegroundWindow(hwnd)
    return hwnd, found


def wait_db_ready(base, timeout=150, need=2, gap=3.0):
    t0, streak, last = time.time(), 0, None
    while time.time() - t0 < timeout:
        try:
            st, j = F.http_json('/health', base=base, timeout=8)
            last = j
            if st == 200 and (j or {}).get('db') == 'up':
                streak += 1
                if streak >= need:
                    return True, last
            else:
                streak = 0
        except Exception as e:
            last = {'err': str(e)[:80]}
            streak = 0
        time.sleep(gap)
    return False, last


def cleanup_all():
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
    left = sorted(electron_pids())
    if left:
        subprocess.run(['taskkill', '/F'] + sum([['/PID', str(x)] for x in left], []),
                       capture_output=True)
        print('  已结束 electron.exe：%s' % left)


# 每张页用一个内容不同、且够高的 data: URL（可滚动）
TALL_URL_JS = r"""
((i) => 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><meta charset="utf-8"><title>压测页 ' + i + '</title>'
  + '<style>body{margin:0;font-family:system-ui;background:#fff}'
  + '.b{height:320px;border-bottom:1px solid #ddd;padding:10px;font-size:14px}'
  + '</style>'
  + Array.from({length:14},(_,k)=>'<div class="b">压测页 ' + i + ' · 第 ' + k + ' 段</div>').join('')
))(%d)
"""

INSTALL_FRAME_JS = r"""
(() => {
  if (window.__mf) return 'already';
  const s = window.__mf = { frames: [] };
  let last = performance.now();
  const loop = () => { const t = performance.now(); s.frames.push(t - last); last = t;
                       requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  return 'installed';
})()
"""

FRAME_STATS_JS = r"""
(() => {
  const s = window.__mf;
  if (!s) return null;
  const f = s.frames.slice();
  s.frames = [];
  if (!f.length) return { n: 0 };
  const sorted = f.slice().sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { n: f.length,
           p50: Math.round(q(0.5) * 10) / 10,
           p95: Math.round(q(0.95) * 10) / 10,
           p99: Math.round(q(0.99) * 10) / 10,
           max: Math.round(sorted[sorted.length - 1] * 10) / 10,
           over33: f.filter((x) => x > 33).length,
           over100: f.filter((x) => x > 100).length,
           fps: Math.round(1000 / (f.reduce((a, b) => a + b, 0) / f.length) * 10) / 10,
           hidden: document.hidden };
})()
"""


def frame_stats(conn, label, secs, scroll=None):
    """量一段帧间隔。scroll=(x, y, n) 时，边量边发真实滚轮事件。"""
    conn.js("(() => { const s=window.__mf; if(s) s.frames=[]; return 'c'; })()")
    if scroll:
        x, y, n = scroll
        gap = secs / max(1, n)
        for i in range(n):
            d = 220 if i % 2 == 0 else -220
            try:
                conn.send('Input.dispatchMouseEvent', type='mouseWheel', x=x, y=y,
                          deltaX=0, deltaY=d)
            except Exception as e:
                log('    滚轮事件失败：%s' % str(e)[:60])
                break
            time.sleep(gap)
    else:
        time.sleep(secs)
    st = conn.js(FRAME_STATS_JS)
    if not isinstance(st, dict) or not st.get('n'):
        log('  %-30s 没拿到帧数据（%s）' % (label, st))
        return None
    log('  %-30s fps %5.1f  p50 %5.1f  p95 %5.1f  p99 %5.1f  max %6.1f  >33ms %d(%.1f%%)  >100ms %d'
        % (label, st['fps'], st['p50'], st['p95'], st['p99'], st['max'],
           st['over33'], 100.0 * st['over33'] / st['n'], st['over100']))
    return st


def snap(c):
    try:
        s = c.js('window.workbench.resourceSnapshot()', await_promise=True) or {}
        smp = s.get('sample') or {}
        return {'cpu': smp.get('cpuPct'), 'mem': smp.get('memMB'),
                'procs': smp.get('procs') or [], 'nproc': len(smp.get('procs') or [])}
    except Exception as e:
        return {'err': str(e)[:60]}


def webview_count():
    try:
        return len([w for w in F.webviews() if isinstance(w.get('wcId'), int)])
    except Exception:
        return 0


def main():
    section('0. 环境自检')
    for label, path in [('vite 入口', F.first_existing(
                            os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                            os.path.join(F.DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'))),
                        ('electron 二进制', F.first_existing(
                            os.path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'),
                            os.path.join(F.DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe')))]:
        if not path:
            log('  ★ 缺 %s' % label)
            return 2
    busy = [p for p in (API_PORT, FAKE_PORT, VITE_PORT, CDP_PORT) if F.port_busy(p)]
    log('  端口占用：%s' % (busy or '无（干净）'))
    if busy:
        return 2
    left = sorted(electron_pids())
    if left:
        log('  ★ 清残留 electron.exe：%s' % left)
        subprocess.run(['taskkill', '/F'] + sum([['/PID', str(x)] for x in left], []),
                       capture_output=True)
        time.sleep(2)

    section('1. 数据库（严格等就绪）')
    if not F.RPR.ensure_pg():
        log('  ★ 数据库起不来')
        return 2

    section('2. 起环境')
    shutil.rmtree(F.TMP, ignore_errors=True)
    os.makedirs(F.PROFILE, exist_ok=True)
    VITE_BIN = F.first_existing(os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                                os.path.join(F.DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'))
    F.spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], REPO,
            env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_DELAY_MS': '2500',
                 'FAKE_STEPS': '30', 'FAKE_LOG': FAKE_LOG},
            log=os.path.join(OUTDIR, 'fake-multi.log'))
    if F.wait_health(FAKE).get('ok') is not True:
        log('  ★ 假模型没起来')
        return 2
    F.spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
            env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
                 'DEEPSEEK_API_KEY': 'fake-key-multi', 'DEEPSEEK_MODEL': 'fake-multi'},
            log=SERVER_LOG)
    if F.wait_health(API).get('db') != 'up':
        log('  ★ 后端没起来')
        return 2
    okdb, last = wait_db_ready(API)
    log('  严格等 DB：%s（%s）' % (okdb, json.dumps(last, ensure_ascii=False)[:130]))
    if not okdb:
        log('  ★ DB 不稳，放弃')
        return 2
    F.spawn('vite', [NODE, VITE_BIN, '--port', str(VITE_PORT), '--strictPort'], F.DESKTOP,
            log=os.path.join(OUTDIR, 'vite-multi.log'))
    time.sleep(4)
    F.spawn('electron', [NODE, 'scripts/start-electron.mjs',
                         '--user-data-dir=%s' % F.PROFILE,
                         '--remote-debugging-port=%d' % CDP_PORT], F.DESKTOP,
            env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT},
            log=os.path.join(OUTDIR, 'electron-multi.log'))
    ok, _, ms = F.wait_until(lambda: bool(P.page('localhost:%d' % VITE_PORT)), timeout=90)
    log('  窗口出现：%s（%dms）' % (ok, ms))
    if not ok:
        return 2

    section('3. 登录')
    F.http_json('/auth/sms/send', 'POST', body={'phone': F.TEST_PHONE})
    code = None
    for _ in range(40):
        try:
            txt = open(SERVER_LOG, encoding='utf-8', errors='replace').read()
        except Exception:
            txt = ''
        m = re.findall(r'(\d{6})', txt)
        if m:
            code = m[-1]
            break
        time.sleep(0.5)
    c = P.Cdp()
    token = None
    ok = False
    for attempt in range(1, 4):
        okdb, _ = wait_db_ready(API, timeout=60, need=1, gap=2.0)
        if not okdb:
            log('  第 %d 次：DB 又不稳' % attempt)
            time.sleep(5)
            continue
        st, sess = F.http_json('/auth/login/sms', 'POST',
                               body={'phone': F.TEST_PHONE, 'code': code or ''})
        token = (sess or {}).get('token') or token
        c.js("localStorage.setItem('workbench.token', %s);"
             "localStorage.setItem('workbench.apiBase', %s); 'set'"
             % (json.dumps(token), json.dumps(API)))
        c.send('Page.reload')
        time.sleep(7)
        ok, _, _ = F.wait_until(
            lambda: ('退出登录' in (c.js('(document.body.innerText||"")') or '')), timeout=60)
        log('  第 %d 次尝试：进到工作台 = %s' % (attempt, ok))
        if ok:
            break
        time.sleep(5)
    if not ok:
        log('  ★ 三次都没进工作台，放弃本轮')
        return 2

    hwnd, wins = raise_app_window(electron_pids())
    log('  提前台：%s（%s）' % (hwnd, [t for _, t in wins]))
    time.sleep(1.5)
    hv = c.js('({hidden: document.hidden, vis: document.visibilityState})')
    log('  主窗口可见性：%s' % json.dumps(hv, ensure_ascii=False))
    if (hv or {}).get('hidden'):
        log('  ⚠️ 仍是 hidden —— 帧率数据要打折扣')

    section('4. 逐张开页，量 1/%d 张的成本曲线' % MAX_N)
    c.js(INSTALL_FRAME_JS)
    c.js("(() => { const v=document.querySelector('webview'); return v?1:0; })()")
    results = []
    for n in range(1, MAX_N + 1):
        url = c.js(TALL_URL_JS % n)
        c.js('window.workbench.openBrowser(%s); "ok"' % json.dumps(url))
        ok, _, ms = F.wait_until(lambda: webview_count() >= n, timeout=60)
        got = webview_count()
        log('')
        log('  ── %d 张页 ── 开页 %s（%dms），实际挂载 %d 个 webview' % (n, ok, ms, got))
        if not ok:
            log('    ★ 没能开到第 %d 张（可能到 maxBrowserInstances 上限了）' % n)
            break
        time.sleep(5)   # 等页面稳定
        if hwnd:
            raise_app_window(electron_pids())
            time.sleep(0.8)
        s = snap(c)
        log('    整机 CPU %5.2f%%   内存 %4.0f MB   进程数 %s'
            % (s.get('cpu') or 0, s.get('mem') or 0, s.get('nproc')))
        # 主窗口帧时间
        fm = frame_stats(c, '%d 张页 · 应用 UI 静止' % n, MEASURE_SECS)
        # 应用 UI 滚动
        fs = frame_stats(c, '%d 张页 · 应用 UI 滚动' % n, SCROLL_SECS,
                         scroll=(660, 400, int(SCROLL_SECS / 0.12)))
        # 内嵌页滚动（用最后一张页的 guest 连接）
        fg = None
        gc = None
        try:
            # 按 webContentsId 认最后一张页的 guest；认不到再按 URL 兜底；
            # 两条都不行就把目标清单打出来（不猜）
            wvs = [w for w in F.webviews() if isinstance(w.get('wcId'), int)]
            target_wc = wvs[-1]['wcId'] if wvs else None
            targets = P._http('/json/list')
            for t in targets:
                if target_wc is not None and (t.get('id') == 'webview:%d' % target_wc
                                              or t.get('webContentsId') == target_wc):
                    gc = P.Cdp(t)
                    break
            if gc is None:
                for t in targets:
                    if 'data:text/html' in (t.get('url') or ''):
                        gc = P.Cdp(t)
                        break
            if gc is None:
                log('    ★ 认不到内嵌页目标。wcId=%s；/json/list 有 %d 个：' % (target_wc, len(targets)))
                for t in targets:
                    log('       id=%s type=%s wc=%s url=%s'
                        % (t.get('id'), t.get('type'), t.get('webContentsId'),
                           (t.get('url') or '')[:70]))
            else:
                gc.js(INSTALL_FRAME_JS)
                fg = frame_stats(gc, '%d 张页 · 内嵌页滚动' % n, SCROLL_SECS,
                                 scroll=(700, 400, int(SCROLL_SECS / 0.12)))
        except Exception as e:
            log('    内嵌页滚动失败：%s' % str(e)[:70])
        results.append({'n': n, 'webviews': got, 'cpu': s.get('cpu'), 'mem': s.get('mem'),
                        'nproc': s.get('nproc'), 'frame_idle': fm, 'frame_scroll_app': fs,
                        'frame_scroll_guest': fg})

    section('5. 汇总：成本曲线')
    log('  %-6s %9s %10s %8s | %-28s | %-28s'
        % ('张数', 'CPU%', '内存MB', '进程数', '应用UI静止(帧p95/>33ms)', '应用UI滚动(帧p95/>33ms)'))
    for r in results:
        fi = r.get('frame_idle') or {}
        fs = r.get('frame_scroll_app') or {}
        log('  %-6d %9s %10s %8s | %-28s | %-28s'
            % (r['n'], r.get('cpu'), r.get('mem'), r.get('nproc'),
               '%s / %s' % (fi.get('p95'), fi.get('over33')),
               '%s / %s' % (fs.get('p95'), fs.get('over33'))))
    log('')
    log('  %-6s %-34s' % ('张数', '内嵌页滚动(帧p95/>33ms)'))
    for r in results:
        fg = r.get('frame_scroll_guest') or {}
        log('  %-6d %-34s' % (r['n'], '%s / %s' % (fg.get('p95'), fg.get('over33'))))
    log('')
    if results:
        m1 = next((r for r in results if r['n'] == 1), None)
        mn = results[-1]
        if m1 and mn and m1.get('mem') and mn.get('mem'):
            log('  每加一张页的平均内存增量：%.0f MB' % ((mn['mem'] - m1['mem']) / max(1, mn['n'] - 1)))
        log('  判读：若 4 张时帧 p95 明显变大或 >33ms 帧数上升 ⇒ 多实例确实拖慢了 UI。')

    with open(os.path.join(OUTDIR, 'multi-result.json'), 'w', encoding='utf-8') as fp:
        json.dump(results, fp, ensure_ascii=False, indent=1)
    with open(os.path.join(OUTDIR, 'multi-report.txt'), 'w', encoding='utf-8') as fp:
        fp.write('\n'.join(REPORT))

    section('6. 收尾')
    for conn in (c,):
        try:
            conn.js("(() => { const s=window.__mf; if(s) s.frames=[]; window.__mf=null; return 'x'; })()")
        except Exception:
            pass
    log('  证据目录：%s' % OUTDIR)
    return 0


if __name__ == '__main__':
    try:
        rc = main()
    except KeyboardInterrupt:
        rc = 130
    except Exception as e:                      # noqa: BLE001
        print('探针异常：%s' % e)
        rc = 1
    finally:
        try:
            cleanup_all()
        except Exception:
            pass
    sys.exit(rc)
