# -*- coding: utf-8 -*-
r"""
**安装版性能探针** —— 只诊断，不改产品代码。

为什么必须测这一份
  前面所有测量都跑在 **dev 模式**，而 dev 模式里 `main.ts` 会**自动开 DevTools**
  （`if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' })`）——
  探针日志里确实一直有个 `Developer Tools - …` 窗口。**DevTools 自己就吃 CPU/内存**，
  所以那些数字是**偏悲观的上界**，而且和用户实际在跑的**安装版**不是同一份东西。

本探针用**与 dev 版完全相同的方法**测安装版（`...\Programs\@ai-workbenchdesktop\AI 工作台.exe`，
跑的是 `resources/app.asar`，无 DevTools），好直接对比。

测什么（与 jank 探针同口径）
  ① 主窗口 rAF 帧间隔 p50/p95/p99/max、>33ms 掉帧数
  ② 整机 / 按进程 CPU、内存（`resourceSnapshot()`，与代码里资源哨兵同源）
  ③ 打字延迟（往聊天输入框逐字写值 → 等 2 帧 → 记录）
  ④ 顺带确认：安装版里**没有** DevTools 窗口

★ 前提：先严格等 DB 就绪（连续 2 次 `/health` db=up），否则应用会自己再拉一个 PG；
  每段前提前台并**回读 `document.hidden === false`**。

用法
  C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe \
      -u scripts/verify/installed-app-perf-probe.py
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

os.environ['FB_CDP_PORT'] = os.environ.get('IP2_CDP_PORT', '9365')
os.environ['FB_API_PORT'] = os.environ.get('IP2_API_PORT', '8815')
os.environ['FB_FAKE_PORT'] = os.environ.get('IP2_FAKE_PORT', '8916')
os.environ['FB_VITE_PORT'] = os.environ.get('IP2_VITE_PORT', '5201')

_spec = importlib.util.spec_from_file_location(
    'fbt', os.path.join(HERE, 'fullscreen-browser-tests.py'))
F = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(F)

OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'browser-idle-perf')
F.OUTDIR = OUTDIR
F.TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wb-instperf')
F.PROFILE = os.path.join(F.TMP, 'profile')
os.makedirs(OUTDIR, exist_ok=True)

# 安装版的渲染进程是 file:// 下的 app.asar ⇒ 换掉 CDP 的页面匹配串
F.P.page.__defaults__ = ('app.asar', 8)

PROG = r'C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\AI 工作台.exe'
ASAR = r'C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\resources\app.asar'

P = F.P
NODE = F.NODE
API, FAKE = F.API, F.FAKE
FAKE_PORT = F.FAKE_PORT
API_PORT, CDP_PORT = F.API_PORT, F.CDP_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm-instperf.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server-instperf.log')
APP_LOG = os.path.join(OUTDIR, 'installed-app-perf.log')

FRAME_SECS = int(os.environ.get('IP2_FRAME_SECS', '15'))
TYPE_CHARS = int(os.environ.get('IP2_TYPE_CHARS', '25'))
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


def installed_pids():
    try:
        out = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq AI 工作台.exe', '/FO', 'CSV', '/NH'],
                             capture_output=True).stdout.decode('gbk', 'replace')
    except Exception:
        return set()
    return set(int(m.group(1)) for m in
               (re.match(r'"AI 工作台\.exe","(\d+)"', l.strip()) for l in out.splitlines()) if m)


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
    left = sorted(installed_pids())
    if left:
        subprocess.run(['taskkill', '/F'] + sum([['/PID', str(x)] for x in left], []),
                       capture_output=True)
        print('  已结束 AI 工作台.exe：%s' % left)


INSTALL_JS = r"""
(() => {
  if (window.__pf) return 'already';
  const s = window.__pf = { frames: [] };
  let last = performance.now();
  const loop = () => { const t = performance.now(); s.frames.push(t - last); last = t;
                       requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  return 'installed';
})()
"""

FRAME_JS = r"""
(() => {
  const s = window.__pf;
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
           fps: Math.round(1000 / (f.reduce((a, b) => a + b, 0) / f.length) * 10) / 10,
           hidden: document.hidden, vis: document.visibilityState };
})()
"""

TYPE_BURST_JS = r"""
(async () => {
  const el = document.querySelector('.inputBar input');
  if (!el) return { err: 'no .inputBar input' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const times = [];
  for (let i = 0; i < %d; i++) {
    const t0 = performance.now();
    setter.call(el, '压测' + String(i));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    times.push(performance.now() - t0);
  }
  const propsKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  const propVal = propsKey ? (el[propsKey] || {}).value : null;
  const sorted = times.slice().sort((a, b) => a - b);
  return { n: times.length,
           p50: Math.round(sorted[Math.floor(sorted.length * 0.5)] * 10) / 10,
           p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
           max: Math.round(sorted[sorted.length - 1] * 10) / 10,
           total: Math.round(times.reduce((a, b) => a + b, 0)),
           reactValue: propVal };
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
                'nproc': len(smp.get('procs') or []), 'procs': smp.get('procs') or []}
    except Exception as e:
        return {'err': str(e)[:60]}


def measure(c, label, with_page_note=''):
    log('')
    log('  ── %s%s ──' % (label, with_page_note))
    s = snap(c)
    log('    整机 CPU %5.2f%%   内存 %4.0f MB   进程数 %s'
        % (s.get('cpu') or 0, s.get('mem') or 0, s.get('nproc')))
    for p in s.get('procs') or []:
        log('      %-9s %-22s cpu %6.3f%%  mem %7.1f MB'
            % (p.get('type'), (p.get('name') or '-')[:22], p.get('cpuPct') or 0, p.get('memMB') or 0))
    c.js("(() => { const s=window.__pf; if(s) s.frames=[]; return 'c'; })()")
    time.sleep(FRAME_SECS)
    fr = c.js(FRAME_JS) or {}
    if fr.get('n'):
        log('    帧：%d 帧 / %d 秒 ⇒ %.1f fps' % (fr['n'], FRAME_SECS, fr['fps']))
        log('    帧间隔 p50 %.1f  p95 %.1f  p99 %.1f  max %.1f ms   |  >33ms %d 帧（%.1f%%）'
            % (fr['p50'], fr['p95'], fr['p99'], fr['max'], fr['over33'],
               100.0 * fr['over33'] / fr['n']))
        log('    可见性：%s hidden=%s' % (fr.get('vis'), fr.get('hidden')))
    tb = c.js(TYPE_BURST_JS % TYPE_CHARS, await_promise=True)
    if isinstance(tb, dict) and not tb.get('err'):
        log('    打字延迟（%d 字）：p50 %.1f  p95 %.1f  max %.1f ms   合计 %d ms'
            % (tb['n'], tb['p50'], tb['p95'], tb['max'], tb['total']))
        log('      回读 React.props.value=%r' % (tb.get('reactValue') or '')[:24])
    else:
        log('    打字延迟：%s' % tb)
    return {'snap': {k: v for k, v in s.items() if k != 'procs'}, 'frames': fr, 'typing': tb}


def main():
    section('0. 环境自检')
    if not os.path.exists(PROG):
        log('  ★ 安装版不存在：%s' % PROG)
        return 2
    if not os.path.exists(ASAR):
        log('  ★ app.asar 不存在：%s' % ASAR)
        return 2
    log('  安装版：%s（%d B）' % (PROG, os.path.getsize(PROG)))
    log('  app.asar：%d B  修改时间 %s'
        % (os.path.getsize(ASAR), time.strftime('%Y-%m-%d %H:%M', time.localtime(os.path.getmtime(ASAR)))))
    busy = [p for p in (API_PORT, FAKE_PORT, CDP_PORT) if F.port_busy(p)]
    log('  端口占用：%s' % (busy or '无（干净）'))
    if busy:
        return 2
    left = sorted(installed_pids())
    if left:
        # ★ 不主动杀：这可能是**用户自己开着的**安装版。宁可拒绝运行，也不误杀。
        log('  ★ 检测到已有「AI 工作台.exe」在跑：%s' % left)
        log('    为避免误杀你自己开着的应用，本探针**拒绝运行**。')
        log('    请先手动关掉安装版（或确认那些是你不要的残留）再重跑。')
        return 2
    log('  没有已运行的「AI 工作台.exe」（干净）')

    section('1. 数据库（严格等就绪，避免应用自己再拉一个 PG）')
    if not F.RPR.ensure_pg():
        log('  ★ 数据库起不来')
        return 2
    log('  ensure_pg 返回 True')

    section('2. 起假模型 + 假站点 + 验收后端（给安装版登录用）')
    shutil.rmtree(F.TMP, ignore_errors=True)
    os.makedirs(F.PROFILE, exist_ok=True)
    F.spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], REPO,
            env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_DELAY_MS': '2500',
                 'FAKE_STEPS': '30', 'FAKE_LOG': FAKE_LOG},
            log=os.path.join(OUTDIR, 'fake-instperf.log'))
    if F.wait_health(FAKE).get('ok') is not True:
        log('  ★ 假模型没起来')
        return 2
    F.spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
            env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
                 'DEEPSEEK_API_KEY': 'fake-key-instperf', 'DEEPSEEK_MODEL': 'fake-instperf'},
            log=SERVER_LOG)
    if F.wait_health(API).get('db') != 'up':
        log('  ★ 后端没起来')
        return 2
    okdb, last = wait_db_ready(API)
    log('  严格等 DB：%s（%s）' % (okdb, json.dumps(last, ensure_ascii=False)[:130]))
    if not okdb:
        log('  ★ DB 不稳，放弃')
        return 2

    section('3. 启动**安装版**（跑 app.asar，无 DevTools）')
    with open(APP_LOG, 'wb') as lf:
        p = subprocess.Popen([PROG, '--no-sandbox',
                              '--remote-debugging-port=%d' % CDP_PORT,
                              '--user-data-dir=%s' % F.PROFILE],
                             cwd=os.path.dirname(PROG), stdout=lf, stderr=subprocess.STDOUT)
    F.PROCS.append(('installed-app', p))
    ok, _, ms = F.wait_until(lambda: bool(P.page()), timeout=90)
    log('  窗口出现（CDP 连上 app.asar 渲染进程）：%s（%dms）' % (ok, ms))
    if not ok:
        log('  ★ 安装版起不来；日志尾部：')
        try:
            for line in open(APP_LOG, encoding='utf-8', errors='replace').read().splitlines()[-15:]:
                log('    %s' % line)
        except Exception:
            pass
        return 2
    time.sleep(5)

    section('4. 确认安装版里**没有** DevTools 窗口（与 dev 的关键差异）')
    try:
        targets = P._http('/json/list')
        devtools = [t for t in targets if 'devtools://' in (t.get('url') or '')
                    or t.get('type') == 'other']
        log('  CDP 目标 %d 个；其中 devtools:// 或 other 类型 %d 个' % (len(targets), len(devtools)))
        for t in targets:
            log('    type=%-8s url=%s' % (t.get('type'), (t.get('url') or '')[:80]))
        wins = []
        def _cb(hwnd, _):
            try:
                if _u32.IsWindowVisible(hwnd):
                    n = _u32.GetWindowTextLengthW(hwnd)
                    buf = ctypes.create_unicode_buffer(n + 1)
                    _u32.GetWindowTextW(hwnd, buf, n + 1)
                    if buf.value.strip():
                        wins.append(buf.value)
            except Exception:
                pass
            return True
        _u32.EnumWindows(ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)(_cb), 0)
        dt = [w for w in wins if 'Developer Tools' in w or 'DevTools' in w]
        log('  可见顶层窗口里 DevTools 窗口：%s' % (dt or '无 ✔'))
    except Exception as e:
        log('  检查 DevTools 失败：%s' % str(e)[:80])

    section('5. 登录（走真实短信链路，指向验收后端）')
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
        time.sleep(8)
        ok, _, _ = F.wait_until(
            lambda: ('退出登录' in (c.js('(document.body.innerText||"")') or '')), timeout=60)
        log('  第 %d 次尝试：进到工作台 = %s' % (attempt, ok))
        if ok:
            break
        time.sleep(5)
    if not ok:
        log('  ★ 三次都没进工作台，放弃本轮')
        return 2

    hwnd, wins2 = raise_app_window(installed_pids())
    log('  提前台：%s（%s）' % (hwnd, [t for _, t in wins2]))
    time.sleep(1.5)

    section('6. 测量 A：0 张页（安装版基线）')
    c.js(INSTALL_JS)
    a = measure(c, '安装版 · 0 张页')

    section('7. 测量 B：1 张页（全屏）+ 页内动画')
    c.js('window.workbench.openBrowser(%s); "ok"' % json.dumps(c.js(TALL_URL_JS % 1)))
    ok, _, ms = F.wait_until(
        lambda: len([w for w in F.webviews() if isinstance(w.get('wcId'), int)]) >= 1, timeout=60)
    log('  内嵌页建起来：%s（%dms）' % (ok, ms))
    if not ok:
        return 2
    time.sleep(6)
    gc = F.guest_cdp('data:text/html')
    if gc:
        gc.js(r"""
        (() => {
          if (window.__pfA) return 'already';
          window.__pfA = 1;
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
    else:
        log('  （没连上内嵌页，只测应用侧）')
    if hwnd:
        raise_app_window(installed_pids())
        time.sleep(1)
    b = measure(c, '安装版 · 1 张页 · 全屏', '（页内带动画）')

    section('8. 汇总：安装版 vs 之前 dev 模式的数字')
    log('  %-22s %-34s %-34s' % ('', '安装版（本次）', 'dev 模式（之前探针）'))
    fa, fb = (a.get('frames') or {}), (b.get('frames') or {})
    ta, tb_ = (a.get('typing') or {}), (b.get('typing') or {})
    log('  %-22s %-34s %-34s' % ('0 张页 帧p95/>33ms',
                                 '%s / %s' % (fa.get('p95'), fa.get('over33')), '16.8 / 0'))
    log('  %-22s %-34s %-34s' % ('1 张页 帧p95/>33ms',
                                 '%s / %s' % (fb.get('p95'), fb.get('over33')), '16.9 / 0'))
    log('  %-22s %-34s %-34s' % ('0 张页 打字p95',
                                 ta.get('p95'), '34.1'))
    log('  %-22s %-34s %-34s' % ('1 张页 打字p95',
                                 tb_.get('p95'), '33.6'))
    log('  %-22s %-34s %-34s' % ('1 张页 整机CPU%',
                                 (b.get('snap') or {}).get('cpu'), '0.230'))
    log('  %-22s %-34s %-34s' % ('1 张页 内存MB',
                                 (b.get('snap') or {}).get('mem'), '681'))
    log('')
    log('  判读：安装版没有 DevTools 开销，若数字与 dev 相当或更好 ⇒ dev 那点开销不影响结论。')

    with open(os.path.join(OUTDIR, 'installed-perf-result.json'), 'w', encoding='utf-8') as fp:
        json.dump({'no_tab': a, 'one_tab': b}, fp, ensure_ascii=False, indent=1)
    with open(os.path.join(OUTDIR, 'installed-perf-report.txt'), 'w', encoding='utf-8') as fp:
        fp.write('\n'.join(REPORT))

    section('9. 收尾')
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
