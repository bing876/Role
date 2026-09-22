# -*- coding: utf-8 -*-
r"""
**长时间闲置 soak 探针** —— 只诊断，不改产品代码。

为什么还要做这个
  前面所有测量都只有 60~75 秒。而"**闲置时会卡**"这类描述往往意味着**随时间累积**：
    · 定时器 / 事件监听器泄漏（每轮重渲染都挂一个，越挂越多）
    · 堆或 DOM 节点持续增长
    · 某个 interval 里悄悄做越来越重的事
  75 秒的窗口抓不到这些。本探针跑 **5 分钟**，每 5 秒采一次，专门看**趋势**：

    ① 整机 / 按进程 内存 —— 线性斜率（MB/分钟）
    ② `Performance.getMetrics`：`JSHeapUsedSize` / `Nodes` / `Documents` /
       `LayoutCount` / `RecalcStyleCount` / `TaskDuration` 的累积与斜率
    ③ 每 5 秒窗口内的主窗口 rAF **帧间隔 p95** —— 看有没有"越跑越卡"
    ④ 每 30 秒分桶的总 CPU —— 看有没有台阶式上升

★ 前提（沿用上次的教训）：先提前台并**回读 `document.hidden === false`**，
  否则帧率数据全是遮挡造成的假象。

用法
  C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe \
      -u scripts/verify/browser-idle-soak-probe.py
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

os.environ['FB_CDP_PORT'] = os.environ.get('IK_CDP_PORT', '9361')
os.environ['FB_API_PORT'] = os.environ.get('IK_API_PORT', '8811')
os.environ['FB_FAKE_PORT'] = os.environ.get('IK_FAKE_PORT', '8912')
os.environ['FB_VITE_PORT'] = os.environ.get('IK_VITE_PORT', '5197')

_spec = importlib.util.spec_from_file_location(
    'fbt', os.path.join(HERE, 'fullscreen-browser-tests.py'))
F = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(F)

OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'browser-idle-perf')
F.OUTDIR = OUTDIR
F.TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wb-soak')
F.PROFILE = os.path.join(F.TMP, 'profile')
os.makedirs(OUTDIR, exist_ok=True)

P = F.P
NODE = F.NODE
API, FAKE = F.API, F.FAKE
FAKE_PORT = F.FAKE_PORT
API_PORT, VITE_PORT, CDP_PORT = F.API_PORT, F.VITE_PORT, F.CDP_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm-soak.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server-soak.log')

SOAK_SECS = int(os.environ.get('IK_SOAK_SECS', '300'))
SAMPLE_EVERY = int(os.environ.get('IK_SAMPLE_EVERY', '5'))
# ★ 对照组开关：
#   IK_ANIM=0   不给内嵌页注入持续动画（隔离"页面自己在动"这个变量）
#   IK_LIGHT=1  轻采样：不装 rAF 循环、不取 Performance.getMetrics、只每 30s 取一次内存
#               （隔离"探针自己的测量开销"这个变量）
DO_ANIM = os.environ.get('IK_ANIM', '1') == '1'
LIGHT = os.environ.get('IK_LIGHT', '0') == '1'
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


# ------------------------------------------------------------------ 采样脚本

INSTALL_JS = r"""
(() => {
  if (window.__sk) return 'already';
  const s = window.__sk = { frames: [], t0: performance.now() };
  let last = performance.now();
  const loop = () => {
    const t = performance.now();
    s.frames.push(t - last);
    last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return 'installed';
})()
"""

# 取本窗口 5 秒内的帧间隔统计（并在页面侧清空，避免大数组来回搬）
FRAME_JS = r"""
(() => {
  const s = window.__sk;
  if (!s) return null;
  const f = s.frames.slice();
  s.frames = [];
  if (!f.length) return { n: 0 };
  const sorted = f.slice().sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { n: f.length,
           p50: Math.round(q(0.5) * 10) / 10,
           p95: Math.round(q(0.95) * 10) / 10,
           max: Math.round(sorted[sorted.length - 1] * 10) / 10,
           over33: f.filter((x) => x > 33).length,
           hidden: document.hidden };
})()
"""

PERF_KEYS = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration',
             'JSHeapUsedSize', 'Nodes', 'Documents', 'LayoutCount', 'RecalcStyleCount']


def perf(c):
    try:
        c.send('Performance.enable')
        r = c.send('Performance.getMetrics')
        return {m['name']: m['value'] for m in (r.get('metrics') or [])}
    except Exception as e:
        return {'__err': str(e)[:80]}


def slope(xs, ys):
    """线性回归斜率（y 单位/点）。"""
    n = len(xs)
    if n < 3:
        return 0.0
    mx, my = sum(xs) / n, sum(ys) / n
    den = sum((x - mx) ** 2 for x in xs) or 1e-9
    return sum((xs[i] - mx) * (ys[i] - my) for i in range(n)) / den


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

    section('1. 数据库（严格等就绪，避免两个 postmaster 撞死）')
    if not F.RPR.ensure_pg():
        log('  ★ 数据库起不来')
        return 2
    log('  ensure_pg 返回 True')

    section('2. 起环境')
    shutil.rmtree(F.TMP, ignore_errors=True)
    os.makedirs(F.PROFILE, exist_ok=True)
    VITE_BIN = F.first_existing(os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                                os.path.join(F.DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'))
    F.spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], REPO,
            env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_DELAY_MS': '2500',
                 'FAKE_STEPS': '30', 'FAKE_LOG': FAKE_LOG},
            log=os.path.join(OUTDIR, 'fake-soak.log'))
    if F.wait_health(FAKE).get('ok') is not True:
        log('  ★ 假模型没起来')
        return 2
    F.spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
            env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
                 'DEEPSEEK_API_KEY': 'fake-key-soak', 'DEEPSEEK_MODEL': 'fake-soak'},
            log=SERVER_LOG)
    if F.wait_health(API).get('db') != 'up':
        log('  ★ 后端没起来')
        return 2
    okdb, last = wait_db_ready(API)
    log('  严格等 DB：%s（%s）' % (okdb, json.dumps(last, ensure_ascii=False)[:140]))
    if not okdb:
        log('  ★ DB 不稳，放弃（避免环境混合态）')
        return 2
    F.spawn('vite', [NODE, VITE_BIN, '--port', str(VITE_PORT), '--strictPort'], F.DESKTOP,
            log=os.path.join(OUTDIR, 'vite-soak.log'))
    time.sleep(4)
    F.spawn('electron', [NODE, 'scripts/start-electron.mjs',
                         '--user-data-dir=%s' % F.PROFILE,
                         '--remote-debugging-port=%d' % CDP_PORT], F.DESKTOP,
            env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT},
            log=os.path.join(OUTDIR, 'electron-soak.log'))
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

    section('4. 开 1 张页 + 内嵌页动画，然后**长时间不动**')
    c.js('window.workbench.openBrowser(%s); "ok"' % json.dumps(FAKE + '/shop'))
    ok, _, ms = F.wait_until(
        lambda: len([w for w in F.webviews() if isinstance(w.get('wcId'), int)]) >= 1, timeout=90)
    log('  内嵌页建起来：%s（%dms）' % (ok, ms))
    if not ok:
        return 2
    time.sleep(6)
    gc = F.guest_cdp('127.0.0.1:%d' % FAKE_PORT)
    if gc and DO_ANIM:
        gc.js(r"""
        (() => {
          if (window.__skAnim) return 'already';
          window.__skAnim = 1;
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
        log('  内嵌页动画已注入（模拟真实网页的轮播/动效）')
    elif gc:
        log('  ★ 对照组：**不注入动画**（隔离"页面自己在动"这个变量）')

    hwnd, wins = raise_app_window(electron_pids())
    log('  提前台：%s（%s）' % (hwnd, wins))
    time.sleep(1.5)
    hv = c.js('({hidden: document.hidden, vis: document.visibilityState})')
    log('  主窗口可见性：%s' % json.dumps(hv, ensure_ascii=False))
    if (hv or {}).get('hidden'):
        log('  ⚠️ 仍是 hidden —— 帧率数据要打折扣')

    section('5. Soak %d 秒（每 %d 秒采一点）%s'
            % (SOAK_SECS, SAMPLE_EVERY, '【轻采样对照组】' if LIGHT else ''))
    if not LIGHT:
        c.js(INSTALL_JS)
        c.js("(() => { const s=window.__sk; if(s) s.frames=[]; return 'clear'; })()")
    else:
        log('  ★ 对照组：不装 rAF 循环、不取 Performance 指标、不装动画')
    t0 = time.time()
    samples = []
    n = int(SOAK_SECS / SAMPLE_EVERY)
    for i in range(n):
        target = t0 + (i + 1) * SAMPLE_EVERY
        try:
            snap = c.js('window.workbench.resourceSnapshot()', await_promise=True) or {}
            smp = snap.get('sample') or {}
            fr = ({} if LIGHT else (c.js(FRAME_JS) or {}))
            pf = ({} if LIGHT else perf(c))
            rec = {
                't': round(time.time() - t0, 1),
                'cpu': smp.get('cpuPct'), 'mem': smp.get('memMB'),
                'heapMB': round((pf.get('JSHeapUsedSize') or 0) / 1048576, 1),
                'nodes': pf.get('Nodes'), 'docs': pf.get('Documents'),
                'layoutCount': pf.get('LayoutCount'), 'recalcCount': pf.get('RecalcStyleCount'),
                'taskDur': pf.get('TaskDuration'), 'scriptDur': pf.get('ScriptDuration'),
                'fps': round(1000 / (fr.get('p95') or 16.7), 1) if fr.get('n') else None,
                'p95': fr.get('p95'), 'over33': fr.get('over33'), 'frames': fr.get('n'),
                'procs': smp.get('procs'),
            }
            samples.append(rec)
            log('  t=%4ds  CPU %5.2f%%  内存 %4.0fMB  堆 %5.1fMB  节点 %5s  帧p95 %5sms  >33ms %s'
                % (rec['t'], rec['cpu'] or 0, rec['mem'] or 0, rec['heapMB'],
                   rec['nodes'], rec['p95'], rec['over33']))
        except Exception as e:
            log('  t=%4ds  采样失败：%s' % (round(time.time() - t0), str(e)[:70]))
        dt = target - time.time()
        if dt > 0:
            time.sleep(dt)

    section('6. 趋势分析（"越跑越卡"就看这里）')
    if len(samples) < 4:
        log('  样本太少（%d），无法判趋势' % len(samples))
    else:
        ts = [s['t'] for s in samples]
        mins = [(s['t'] / 60.0) for s in samples]

        def trend(key, label, unit):
            ys = [s.get(key) for s in samples]
            ys = [0.0 if y is None else float(y) for y in ys]
            sl = slope(mins, ys)
            log('  %-22s 首 %-9.2f 末 %-9.2f 最小 %-9.2f 最大 %-9.2f | 斜率 %+8.3f %s/分钟'
                % (label, ys[0], ys[-1], min(ys), max(ys), sl, unit))
            return sl

        log('  ── 内存 / 堆 / DOM ──')
        trend('mem', '整机内存(MB)', 'MB')
        trend('heapMB', '主窗口 JS 堆(MB)', 'MB')
        trend('nodes', 'DOM 节点数', '个')
        trend('docs', 'Document 数', '个')
        log('  ── 累积计数（只看增量，绝对值没意义）──')
        for k, lb in [('layoutCount', 'LayoutCount'), ('recalcCount', 'RecalcStyleCount'),
                      ('taskDur', 'TaskDuration(秒)'), ('scriptDur', 'ScriptDuration(秒)')]:
            ys = [float(s.get(k) or 0) for s in samples]
            log('  %-22s 增量 %+10.2f（首 %.2f → 末 %.2f）'
                % (lb, ys[-1] - ys[0], ys[0], ys[-1]))
        log('  ── CPU ──')
        trend('cpu', '整机 CPU(%)', '%')
        # 每 30 秒分桶
        buckets = {}
        for s in samples:
            buckets.setdefault(int(s['t'] // 30) * 30, []).append(s['cpu'] or 0)
        log('  每 30 秒桶的 CPU 均值：%s'
            % {k: round(statistics.mean(v), 2) for k, v in sorted(buckets.items())})
        log('  ── 帧时间 ──')
        p95s = [s['p95'] for s in samples if s.get('p95')]
        if p95s:
            log('  帧间隔 p95：最小 %.1fms  中位 %.1fms  最大 %.1fms'
                % (min(p95s), statistics.median(p95s), max(p95s)))
            log('  >33ms 掉帧总数：%d（%d 个采样窗口）'
                % (sum(s.get('over33') or 0 for s in samples), len(p95s)))
            # 前后半段对比
            half = len(p95s) // 2
            log('  前半段 p95 中位 %.1fms → 后半段 %.1fms（看有没有变差）'
                % (statistics.median(p95s[:half]), statistics.median(p95s[half:])))
        else:
            log('  没拿到帧数据')

    with open(os.path.join(OUTDIR, 'soak-result.json'), 'w', encoding='utf-8') as fp:
        json.dump({'soakSecs': SOAK_SECS, 'samples': samples}, fp, ensure_ascii=False, indent=1)
    with open(os.path.join(OUTDIR, 'soak-report.txt'), 'w', encoding='utf-8') as fp:
        fp.write('\n'.join(REPORT))

    section('7. 收尾')
    try:
        c.js("(() => { const s=window.__sk; if(s) s.frames=[]; window.__sk=null; return 'off'; })()")
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
