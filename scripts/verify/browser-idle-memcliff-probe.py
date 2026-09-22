# -*- coding: utf-8 -*-
r"""
**内存悬崖探测：把内嵌页逐张加到 `maxBrowserInstances` 上限** —— 只诊断，不改产品代码。

为什么做这个
  我在 §14 测"系统级压力"时**没能复现卡顿** —— 但那是因为我**从没把内存压到那么狠**
  （只有 1 张页、多用 518 MB）。而 `maxBrowserInstances` **在设置里可以调到 20**：
  按 +101 MB/张算约 **2.5 GB**，在这台只剩 ~2 GB 空闲的机器上会直接触发换页。
  **这是唯一还没测、又可能解释"整体卡顿"的路径。**

做法
  临时 profile 里把 `maxBrowserInstances` 设为 20，然后 **1→2→4→6→8→10→12** 逐档加页，
  每档量：系统可用内存、应用整机 CPU/内存、主窗口帧时间（p95 / >33ms / 长任务）。

★ **安全阀**：可用内存跌破 `IH_MIN_FREE_MB`（默认 700 MB）就**立刻中止**，
  并把已开的页全部关掉 —— 不让这台本来就紧张的机器被拖进重度换页。

用法
  C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe \
      -u scripts/verify/browser-idle-memcliff-probe.py
"""

import ctypes
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
from ctypes import wintypes

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

os.environ['FB_CDP_PORT'] = os.environ.get('IC_CDP_PORT', '9373')
os.environ['FB_API_PORT'] = os.environ.get('IC_API_PORT', '8823')
os.environ['FB_FAKE_PORT'] = os.environ.get('IC_FAKE_PORT', '8924')
os.environ['FB_VITE_PORT'] = os.environ.get('IC_VITE_PORT', '5209')

_spec = importlib.util.spec_from_file_location(
    'fbt', os.path.join(HERE, 'fullscreen-browser-tests.py'))
F = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(F)

OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'browser-idle-perf')
F.OUTDIR = OUTDIR
F.TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wb-memcliff')
F.PROFILE = os.path.join(F.TMP, 'profile')
os.makedirs(OUTDIR, exist_ok=True)

P = F.P
NODE = F.NODE
API, FAKE = F.API, F.FAKE
FAKE_PORT = F.FAKE_PORT
API_PORT, VITE_PORT, CDP_PORT = F.API_PORT, F.VITE_PORT, F.CDP_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm-memcliff.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server-memcliff.log')

STEPS = [int(x) for x in os.environ.get('IC_STEPS', '1,2,4,6,8,10,12').split(',')]
MAX_INSTANCES = int(os.environ.get('IC_MAX_INSTANCES', '20'))
MIN_FREE_MB = int(os.environ.get('IC_MIN_FREE_MB', '700'))
FRAME_SECS = int(os.environ.get('IC_FRAME_SECS', '8'))
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


# ---------------------------------------------------------------- 系统内存

class _MEMSTATUS(ctypes.Structure):
    _fields_ = [('dwLength', ctypes.c_ulong), ('dwMemoryLoad', ctypes.c_ulong),
                ('ullTotalPhys', ctypes.c_ulonglong), ('ullAvailPhys', ctypes.c_ulonglong),
                ('ullTotalPageFile', ctypes.c_ulonglong), ('ullAvailPageFile', ctypes.c_ulonglong),
                ('ullTotalVirtual', ctypes.c_ulonglong), ('ullAvailVirtual', ctypes.c_ulonglong),
                ('ullAvailExtendedVirtual', ctypes.c_ulonglong)]


def sys_mem():
    m = _MEMSTATUS()
    m.dwLength = ctypes.sizeof(_MEMSTATUS)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return {'freeMB': round(m.ullAvailPhys / 1048576),
            'totalMB': round(m.ullTotalPhys / 1048576),
            'loadPct': int(m.dwMemoryLoad),
            'commitFreeMB': round(m.ullAvailPageFile / 1048576)}


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
        return None
    hwnd = found[0][0]
    _u32.ShowWindow(hwnd, 9)
    time.sleep(0.2)
    _u32.SetWindowPos(hwnd, 0, 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0040)
    time.sleep(0.2)
    _u32.SetForegroundWindow(hwnd)
    return hwnd


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


INSTALL_JS = r"""
(() => {
  if (window.__mc) return 'already';
  const s = window.__mc = { frames: [], long: [] };
  let last = performance.now();
  const loop = () => { const t = performance.now(); s.frames.push(t - last); last = t;
                       requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) s.long.push(Math.round(e.duration));
    });
    po.observe({ entryTypes: ['longtask'] });
    s.po = po;
  } catch (e) {}
  return 'installed';
})()
"""

FRAME_JS = r"""
(() => {
  const s = window.__mc;
  if (!s) return null;
  const f = s.frames.slice(); s.frames = [];
  const lg = s.long.slice(); s.long = [];
  if (!f.length) return { n: 0 };
  const sorted = f.slice().sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { n: f.length,
           p50: Math.round(q(0.5) * 10) / 10,
           p95: Math.round(q(0.95) * 10) / 10,
           max: Math.round(sorted[sorted.length - 1] * 10) / 10,
           over33: f.filter((x) => x > 33).length,
           fps: Math.round(1000 / (f.reduce((a, b) => a + b, 0) / f.length) * 10) / 10,
           longCount: lg.length, longMax: lg.length ? Math.max(...lg) : 0,
           webviews: document.querySelectorAll('webview').length,
           hidden: document.hidden };
})()
"""

TALL_URL_JS = r"""
((i) => 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><meta charset="utf-8"><title>压测页 ' + i + '</title>'
  + '<style>body{margin:0;font-family:system-ui;background:#fff}'
  + '.b{height:320px;border-bottom:1px solid #ddd;padding:10px;font-size:14px}</style>'
  + Array.from({length:14},(_,k)=>'<div class="b">压测页 ' + i + ' · 第 ' + k + ' 段</div>').join('')
))(%d)
"""


def snap(c):
    try:
        s = c.js('window.workbench.resourceSnapshot()', await_promise=True) or {}
        smp = s.get('sample') or {}
        return {'cpu': smp.get('cpuPct'), 'mem': smp.get('memMB'),
                'nproc': len(smp.get('procs') or [])}
    except Exception as e:
        return {'err': str(e)[:60]}


def wv_count():
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
    m0 = sys_mem()
    log('  起跑前系统内存：可用 %d MB / 共 %d MB（占用 %d%%），提交可用 %d MB'
        % (m0['freeMB'], m0['totalMB'], m0['loadPct'], m0['commitFreeMB']))
    log('  安全阀：可用内存 < %d MB 就中止' % MIN_FREE_MB)
    log('  计划档位：%s（maxBrowserInstances=%d）' % (STEPS, MAX_INSTANCES))

    section('1. 数据库（严格等就绪）')
    if not F.RPR.ensure_pg():
        log('  ★ 数据库起不来')
        return 2

    section('2. 起环境（临时 profile 里把 maxBrowserInstances 设为 %d）' % MAX_INSTANCES)
    shutil.rmtree(F.TMP, ignore_errors=True)
    os.makedirs(F.PROFILE, exist_ok=True)
    with open(os.path.join(F.PROFILE, 'workbench-settings.json'), 'w', encoding='utf-8') as f:
        json.dump({'maxBrowserInstances': MAX_INSTANCES, 'resourceSampleMs': 1000}, f)
    log('  已写 workbench-settings.json：%s'
        % json.dumps({'maxBrowserInstances': MAX_INSTANCES, 'resourceSampleMs': 1000}))
    VITE_BIN = F.first_existing(os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                                os.path.join(F.DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'))
    F.spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], REPO,
            env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_DELAY_MS': '2500',
                 'FAKE_STEPS': '30', 'FAKE_LOG': FAKE_LOG},
            log=os.path.join(OUTDIR, 'fake-memcliff.log'))
    if F.wait_health(FAKE).get('ok') is not True:
        log('  ★ 假模型没起来')
        return 2
    F.spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
            env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
                 'DEEPSEEK_API_KEY': 'fake-key-memcliff', 'DEEPSEEK_MODEL': 'fake-memcliff'},
            log=SERVER_LOG)
    if F.wait_health(API).get('db') != 'up':
        log('  ★ 后端没起来')
        return 2
    okdb, _ = wait_db_ready(API)
    if not okdb:
        log('  ★ DB 不稳，放弃')
        return 2
    F.spawn('vite', [NODE, VITE_BIN, '--port', str(VITE_PORT), '--strictPort'], F.DESKTOP,
            log=os.path.join(OUTDIR, 'vite-memcliff.log'))
    time.sleep(4)
    F.spawn('electron', [NODE, 'scripts/start-electron.mjs',
                         '--user-data-dir=%s' % F.PROFILE,
                         '--remote-debugging-port=%d' % CDP_PORT], F.DESKTOP,
            env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT},
            log=os.path.join(OUTDIR, 'electron-memcliff.log'))
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
    # 复核设置真的生效（上限没生效就白测了）
    try:
        s = c.js('window.workbench.getSettings()', await_promise=True) or {}
        log('  应用内 getSettings().maxBrowserInstances = %s' % s.get('maxBrowserInstances'))
    except Exception as e:
        log('  读设置失败：%s' % str(e)[:60])

    hwnd = raise_app_window(electron_pids())
    time.sleep(1.5)
    c.js(INSTALL_JS)

    section('4. 逐档加页')
    results = []
    opened = 0
    aborted = None
    for n in STEPS:
        # 加到 n 张（每张用一个内容不同的 data: URL ⇒ 不触发同站复用）
        while opened < n:
            opened += 1
            c.js('window.workbench.openBrowser(%s); "ok"' % json.dumps(c.js(TALL_URL_JS % opened)))
            ok, _, ms = F.wait_until(lambda: wv_count() >= opened, timeout=45)
            if not ok:
                log('  ★ 第 %d 张没开起来（实际 %d 个）' % (opened, wv_count()))
                break
        got = wv_count()
        log('')
        log('  ── %d 张页（实际挂载 %d 个 webview）──' % (n, got))
        if got < n:
            log('    ⚠️ 没到目标张数，以实际为准')
        time.sleep(4)
        if hwnd:
            raise_app_window(electron_pids())
            time.sleep(0.8)
        sm = sys_mem()
        s = snap(c)
        c.js("(() => { const s=window.__mc; if(s){ s.frames=[]; s.long=[]; } return 'c'; })()")
        time.sleep(FRAME_SECS)
        fr = c.js(FRAME_JS) or {}
        log('    系统可用内存 %d MB（占用 %d%%）  应用整机 CPU %5.2f%%  应用内存 %4.0f MB'
            % (sm['freeMB'], sm['loadPct'], s.get('cpu') or 0, s.get('mem') or 0))
        if fr.get('n'):
            log('    帧：%.1f fps  p50 %.1f  p95 %.1f  max %.1f   >33ms %d   长任务 %d（最长 %dms）'
                % (fr['fps'], fr['p50'], fr['p95'], fr['max'], fr['over33'],
                   fr.get('longCount', 0), fr.get('longMax', 0)))
        rec = {'n': n, 'webviews': got, 'sysFreeMB': sm['freeMB'], 'sysLoadPct': sm['loadPct'],
               'appCpu': s.get('cpu'), 'appMem': s.get('mem'), 'frames': fr}
        results.append(rec)
        # ★ 安全阀
        if sm['freeMB'] < MIN_FREE_MB:
            aborted = '系统可用内存 %d MB < 安全阀 %d MB' % (sm['freeMB'], MIN_FREE_MB)
            log('')
            log('  ★★ 安全阀触发：%s ⇒ **立刻停止加页**' % aborted)
            break
        if (fr.get('over33') or 0) > 30:
            aborted = '掉帧已明显（>33ms %d 帧）' % fr.get('over33')
            log('')
            log('  ★★ 安全阀触发：%s ⇒ 停止加页' % aborted)
            break

    section('5. 汇总：加页 → 内存 / 帧时间')
    log('  %-6s %-9s %-14s %-11s %-9s %-8s %-8s %-9s'
        % ('张数', 'webview', '系统可用MB', '应用MB', '应用CPU%', 'fps', '帧p95', '>33ms'))
    for r in results:
        f = r.get('frames') or {}
        log('  %-6d %-9d %-14d %-11.0f %-9s %-8s %-8s %-9s'
            % (r['n'], r['webviews'], r['sysFreeMB'], r.get('appMem') or 0,
               r.get('appCpu'), f.get('fps'), f.get('p95'), f.get('over33')))
    log('')
    if aborted:
        log('  中止原因：%s' % aborted)
    if results:
        r0, rl = results[0], results[-1]
        log('  从 %d 张 → %d 张：应用内存 %+.0f MB（每张 ≈ %+.0f MB）'
            % (r0['n'], rl['n'], (rl.get('appMem') or 0) - (r0.get('appMem') or 0),
               ((rl.get('appMem') or 0) - (r0.get('appMem') or 0)) / max(1, rl['n'] - r0['n'])))
        log('  系统可用内存：%d MB → %d MB（%+d MB）'
            % (r0['sysFreeMB'], rl['sysFreeMB'], rl['sysFreeMB'] - r0['sysFreeMB']))
        f0 = r0.get('frames') or {}
        fl = rl.get('frames') or {}
        log('  帧 p95：%s → %s ms；>33ms 掉帧：%s → %s'
            % (f0.get('p95'), fl.get('p95'), f0.get('over33'), fl.get('over33')))
        log('')
        if not aborted and (fl.get('over33') or 0) == 0:
            log('  ⇒ 加到 %d 张仍**零掉帧**，且未触发安全阀 ⇒ **在默认上限内没找到内存悬崖**。'
                % rl['n'])
        elif aborted:
            log('  ⇒ **在 %d 张附近出现拐点**（%s）—— 这就是"开到多少会卡"的边界。'
                % (rl['n'], aborted))
        else:
            log('  ⇒ 有掉帧但未触发安全阀，值得再看。')

    with open(os.path.join(OUTDIR, 'memcliff-result.json'), 'w', encoding='utf-8') as fp:
        json.dump({'steps': STEPS, 'maxInstances': MAX_INSTANCES, 'minFreeMB': MIN_FREE_MB,
                   'results': results, 'aborted': aborted}, fp, ensure_ascii=False, indent=1)
    with open(os.path.join(OUTDIR, 'memcliff-report.txt'), 'w', encoding='utf-8') as fp:
        fp.write('\n'.join(REPORT))

    section('6. 收尾')
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
