# -*- coding: utf-8 -*-
r"""
**系统级压力探针** —— 只诊断，不改产品代码。

为什么需要它
  前面我一直在**断言**"系统级内存压力（15.8GB 只剩 2.0GB）是可能的原因"，
  但从没**量化**过。这里用 Windows 性能计数器把"系统到底有没有在猛换页"量出来，
  并对比两段：

    Phase A  应用**没开**      → 系统自身的压力基线
    Phase B  应用 + 1 张闲置页 → 加上我们之后的压力

  判读：
    · 若 A 段就已经有大量硬换页（`Pages Input/sec` 高、磁盘队列长）⇒ 压力来自**系统本身**，
      与我们应用无关 —— 那才是"整机卡顿"的来源。
    · 若只有 B 段才有 ⇒ 我们确实把系统压到了换页。

同时记录应用自己的帧时间（Phase B），看**帧抖动是否与换页尖峰同时发生**。

用法
  C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe \
      -u scripts/verify/system-pressure-probe.py
"""

import csv
import ctypes
import importlib.util
import io
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

os.environ['FB_CDP_PORT'] = os.environ.get('IS2_CDP_PORT', '9367')
os.environ['FB_API_PORT'] = os.environ.get('IS2_API_PORT', '8817')
os.environ['FB_FAKE_PORT'] = os.environ.get('IS2_FAKE_PORT', '8918')
os.environ['FB_VITE_PORT'] = os.environ.get('IS2_VITE_PORT', '5203')

_spec = importlib.util.spec_from_file_location(
    'fbt', os.path.join(HERE, 'fullscreen-browser-tests.py'))
F = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(F)

OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'browser-idle-perf')
F.OUTDIR = OUTDIR
F.TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wb-syspress')
F.PROFILE = os.path.join(F.TMP, 'profile')
os.makedirs(OUTDIR, exist_ok=True)

P = F.P
NODE = F.NODE
API, FAKE = F.API, F.FAKE
FAKE_PORT = F.FAKE_PORT
API_PORT, VITE_PORT, CDP_PORT = F.API_PORT, F.VITE_PORT, F.CDP_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm-syspress.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server-syspress.log')

SECS_A = int(os.environ.get('ISP_SECS_A', '30'))
SECS_B = int(os.environ.get('ISP_SECS_B', '30'))
REPORT = []

CTRS = [
    (r'\Memory\Available MBytes', '可用内存MB', 'down'),
    (r'\Memory\Pages Input/sec', '硬换页(次/秒)', 'up'),
    (r'\Memory\Page Faults/sec', '缺页(次/秒)', 'neutral'),
    (r'\Paging File(_Total)\% Usage', '页面文件占用%', 'up'),
    (r'\PhysicalDisk(_Total)\% Disk Time', '磁盘忙%', 'up'),
    (r'\PhysicalDisk(_Total)\Avg. Disk Queue Length', '磁盘队列', 'up'),
    (r'\Processor(_Total)\% Processor Time', '整机CPU%', 'up'),
    (r'\System\Processor Queue Length', '处理器队列', 'up'),
]


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


def sys_sample(secs):
    """
    用**一个长驻 typeperf** 采 secs 秒系统计数器（每秒一点）。
    返回 {计数器短名: [值…]}。★ 一次别查太多计数器（本机实测超过几百条会出垃圾值）。
    """
    cf = os.path.join(F.TMP, 'sys-counters.txt')
    os.makedirs(F.TMP, exist_ok=True)
    with open(cf, 'w', encoding='utf-8') as f:
        f.write('\n'.join(c[0] for c in CTRS) + '\n')
    try:
        p = subprocess.Popen(['typeperf', '-cf', cf, '-si', '1', '-sc', str(int(secs))],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        txt = p.communicate(timeout=secs * 4 + 90)[0].decode('gbk', 'replace')
    except Exception as e:
        log('  ★ typeperf 失败：%s' % e)
        return {}
    rows = [r for r in csv.reader(io.StringIO(txt)) if r and any(c.strip() for c in r)]
    hdr, data = None, []
    for r in rows:
        if r[0].strip().startswith('(PDH-CSV'):
            hdr = [c.strip() for c in r]
            continue
        if hdr and len(r) == len(hdr):
            data.append(r)
    if not hdr:
        log('  ★ 没解析到表头')
        return {}
    out = {}
    for i, (_, label, _) in enumerate(CTRS):
        vals = []
        for row in data:
            try:
                v = float(row[i + 1])
            except Exception:
                continue
            if abs(v) > 1e9:      # 垃圾值保护
                continue
            vals.append(v)
        out[label] = vals
    return out


def report_sys(s, label):
    if not s:
        log('  %s：没拿到数据' % label)
        return None
    log('  ── %s（%d 个样本）──' % (label, len(next(iter(s.values())))))
    log('    %-16s %10s %10s %10s %10s' % ('指标', '最小', '均值', '最大', '峰值个数>均值×3'))
    res = {}
    for _, label2, _ in CTRS:
        v = s.get(label2) or []
        if not v:
            continue
        m = statistics.mean(v)
        hi = sum(1 for x in v if m > 0 and x > m * 3)
        log('    %-16s %10.2f %10.2f %10.2f %10d' % (label2, min(v), m, max(v), hi))
        res[label2] = {'min': round(min(v), 2), 'mean': round(m, 2),
                       'max': round(max(v), 2), 'spikes': hi}
    return res


INSTALL_FRAME_JS = r"""
(() => {
  if (window.__sp) return 'already';
  const s = window.__sp = { frames: [] };
  let last = performance.now();
  const loop = () => { const t = performance.now(); s.frames.push(t - last); last = t;
                       requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  return 'installed';
})()
"""

FRAME_JS = r"""
(() => {
  const s = window.__sp;
  if (!s) return null;
  const f = s.frames.slice(); s.frames = [];
  if (!f.length) return { n: 0 };
  const sorted = f.slice().sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { n: f.length, p50: Math.round(q(0.5) * 10) / 10,
           p95: Math.round(q(0.95) * 10) / 10,
           max: Math.round(sorted[sorted.length - 1] * 10) / 10,
           over33: f.filter((x) => x > 33).length,
           frames: f.map((x) => Math.round(x * 10) / 10),
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

    # ---------------------------------------------------------------- Phase A
    section('Phase A：**应用没开** —— 系统自身的压力基线（%d 秒）' % SECS_A)
    a = sys_sample(SECS_A)
    ra = report_sys(a, 'Phase A · 应用未运行')

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
            log=os.path.join(OUTDIR, 'fake-syspress.log'))
    if F.wait_health(FAKE).get('ok') is not True:
        log('  ★ 假模型没起来')
        return 2
    F.spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
            env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
                 'DEEPSEEK_API_KEY': 'fake-key-syspress', 'DEEPSEEK_MODEL': 'fake-syspress'},
            log=SERVER_LOG)
    if F.wait_health(API).get('db') != 'up':
        log('  ★ 后端没起来')
        return 2
    okdb, _ = wait_db_ready(API)
    if not okdb:
        log('  ★ DB 不稳，放弃')
        return 2
    F.spawn('vite', [NODE, VITE_BIN, '--port', str(VITE_PORT), '--strictPort'], F.DESKTOP,
            log=os.path.join(OUTDIR, 'vite-syspress.log'))
    time.sleep(4)
    F.spawn('electron', [NODE, 'scripts/start-electron.mjs',
                         '--user-data-dir=%s' % F.PROFILE,
                         '--remote-debugging-port=%d' % CDP_PORT], F.DESKTOP,
            env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT},
            log=os.path.join(OUTDIR, 'electron-syspress.log'))
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

    section('4. 开 1 张页（+页内动画）后闲置')
    c.js('window.workbench.openBrowser(%s); "ok"' % json.dumps(c.js(TALL_URL_JS % 1)))
    ok, _, ms = F.wait_until(
        lambda: len([w for w in F.webviews() if isinstance(w.get('wcId'), int)]) >= 1, timeout=60)
    log('  内嵌页建起来：%s（%dms）' % (ok, ms))
    if not ok:
        return 2
    time.sleep(5)
    gc = F.guest_cdp('data:text/html')
    if gc:
        gc.js(r"""
        (() => {
          if (window.__spA) return 'already';
          window.__spA = 1;
          const box = document.createElement('div');
          box.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px;'
            + 'background:linear-gradient(45deg,#f0f,#0ff);opacity:.5;z-index:2147483647;'
            + 'pointer-events:none;will-change:transform';
          document.documentElement.appendChild(box);
          let a = 0;
          const spin = () => { a = (a + 4) % 360;
            box.style.transform = 'translate(' + (300 + 250 * Math.sin(a * Math.PI / 180)).toFixed(1)
              + 'px,' + (300 + 250 * Math.cos(a * Math.PI / 180)).toFixed(1) + 'px) rotate(' + a + 'deg)';
            requestAnimationFrame(spin); };
          requestAnimationFrame(spin);
          return 'anim installed';
        })()""")
        log('  内嵌页动画已注入')
    if raise_app_window(electron_pids()):
        time.sleep(1)
    c.js(INSTALL_FRAME_JS)
    c.js("(() => { const s=window.__sp; if(s) s.frames=[]; return 'c'; })()")

    # ---------------------------------------------------------------- Phase B
    section('Phase B：**应用 + 1 张闲置页** —— 加上我们之后的压力（%d 秒）' % SECS_B)
    b = sys_sample(SECS_B)
    rb = report_sys(b, 'Phase B · 应用 + 1 张闲置页')
    fr = c.js(FRAME_JS) or {}
    if fr.get('n'):
        log('')
        log('  同段的应用帧时间：%d 帧 ⇒ %.1f fps   p50 %.1f  p95 %.1f  max %.1f   >33ms %d'
            % (fr['n'], 1000 / (sum(fr['frames']) / len(fr['frames'])),
               fr['p50'], fr['p95'], fr['max'], fr['over33']))

    section('5. 结论：压力是我们造成的，还是系统本来就有的？')
    def pick(r, k):
        return (r or {}).get(k) or {}
    log('  %-16s %12s %12s' % ('指标', 'A(应用未开)均值', 'B(应用+1页)均值'))
    for _, label, _ in CTRS:
        log('  %-16s %12s %12s'
            % (label, pick(ra, label).get('mean', '-'), pick(rb, label).get('mean', '-')))
    log('')
    a_hard = pick(ra, '硬换页(次/秒)').get('max', 0) or 0
    b_hard = pick(rb, '硬换页(次/秒)').get('max', 0) or 0
    a_free = pick(ra, '可用内存MB').get('mean', 0) or 0
    b_free = pick(rb, '可用内存MB').get('mean', 0) or 0
    log('  可用内存：A 均 %.0f MB → B 均 %.0f MB（差 %+.0f MB）' % (a_free, b_free, b_free - a_free))
    log('  硬换页峰值：A %.0f 次/秒 → B %.0f 次/秒' % (a_hard, b_hard))
    log('')
    if a_hard > 200 or (pick(ra, '磁盘队列').get('mean', 0) or 0) > 2:
        log('  ⇒ **A 段（应用还没开）系统就已在猛换页** ⇒ 压力来自**系统本身**，与我们应用无关。')
    elif b_hard > a_hard * 3 and b_hard > 200:
        log('  ⇒ 应用 + 1 张页**显著加重了**换页 ⇒ 我们确实把系统压到了换页（但注意绝对量）。')
    else:
        log('  ⇒ 两段都没有明显硬换页 ⇒ 在这两个 %d 秒窗口里，**系统没有在猛换页**；'
            % SECS_A)
        log('     "内存压力"在本次采样中**没有**表现为磁盘级抖动。')
    log('     注意：这只是两个短窗口的观察，长时间/别的负载下可能不同。')

    with open(os.path.join(OUTDIR, 'syspress-result.json'), 'w', encoding='utf-8') as fp:
        json.dump({'A_no_app': ra, 'B_app_1page': rb,
                   'frame': {k: v for k, v in fr.items() if k != 'frames'}}, fp,
                  ensure_ascii=False, indent=1)
    with open(os.path.join(OUTDIR, 'syspress-report.txt'), 'w', encoding='utf-8') as fp:
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
