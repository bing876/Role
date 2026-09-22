# -*- coding: utf-8 -*-
r"""
**卡顿（帧时间）探针** —— 只诊断，不改产品代码。

为什么还要做这个
  前面的探针量的是 **CPU 百分比**，但"卡顿"的本质是**帧时间** ——
  CPU 只有 0.2% 也可能照样掉帧（等 GPU / 合成器 / 主线程被长任务占住）。
  所以这里换成直接量"卡不卡"：

    ① 主窗口 rAF **帧间隔分布**（p50 / p95 / p99 / 最大，以及 >33ms、>100ms 的帧数）
    ② Chromium `Performance.getMetrics` 的增量（Task / Script / Layout / RecalcStyle 时长）
    ③ `longtask` 长任务计数与总时长
    ④ **真实打字延迟**：往聊天输入框里逐字写值，量"写入 → React 提交后那一帧"的耗时
       （这是最典型的"卡顿"体感）

三段对照（唯一变量 = 有没有那张页）：
    A 0 张页   →  B 1 张页·全屏（带动画）  →  C 1 张页·后台

★ 前提（上一次踩过的坑）：**每次测量前都确认 `document.hidden === false`**。
  Chromium 遮挡检测会把被别的窗口盖住的应用标成 hidden，帧率直接失真。
  所以本探针会先把应用窗口用 Win32 提到前台，并**回读确认**。

用法
  C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe \
      -u scripts/verify/browser-idle-jank-probe.py
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

os.environ['FB_CDP_PORT'] = os.environ.get('IJ_CDP_PORT', '9359')
os.environ['FB_API_PORT'] = os.environ.get('IJ_API_PORT', '8809')
os.environ['FB_FAKE_PORT'] = os.environ.get('IJ_FAKE_PORT', '8910')
os.environ['FB_VITE_PORT'] = os.environ.get('IJ_VITE_PORT', '5195')

_spec = importlib.util.spec_from_file_location(
    'fbt', os.path.join(HERE, 'fullscreen-browser-tests.py'))
F = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(F)

OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'browser-idle-perf')
F.OUTDIR = OUTDIR
F.TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wb-jank')
F.PROFILE = os.path.join(F.TMP, 'profile')
os.makedirs(OUTDIR, exist_ok=True)

P = F.P
NODE = F.NODE
API, FAKE = F.API, F.FAKE
FAKE_PORT = F.FAKE_PORT
API_PORT, VITE_PORT, CDP_PORT = F.API_PORT, F.VITE_PORT, F.CDP_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm-jank.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server-jank.log')

FRAME_SECS = int(os.environ.get('IJ_FRAME_SECS', '10'))
TYPE_CHARS = int(os.environ.get('IJ_TYPE_CHARS', '25'))
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


def find_app_windows(pids):
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
                    found.append((hwnd, pid.value, buf.value))
        except Exception:
            pass
        return True

    _u32.EnumWindows(WNDENUMPROC(cb), 0)
    return found


def raise_app_window(pids):
    """把标题非空的可见窗口提到最前，返回 hwnd。"""
    wins = find_app_windows(pids)
    if not wins:
        return None, wins
    hwnd = wins[0][0]
    _u32.ShowWindow(hwnd, 9)   # SW_RESTORE
    time.sleep(0.2)
    _u32.SetWindowPos(hwnd, 0, 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0040)  # TOP|NOMOVE|NOSIZE|SHOW
    time.sleep(0.2)
    _u32.SetForegroundWindow(hwnd)
    return hwnd, wins


# ------------------------------------------------------------------ 页面侧脚本

# 帧间隔记录 + 长任务记录
INSTALL_METRICS_JS = r"""
(() => {
  if (window.__jk) return 'already';
  const s = window.__jk = { frames: [], long: [], t0: performance.now() };
  let last = performance.now();
  const loop = () => {
    const t = performance.now();
    s.frames.push(t - last);
    last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) s.long.push({ d: Math.round(e.duration),
                                                       n: e.name });
    });
    po.observe({ entryTypes: ['longtask'] });
    s.po = po;
  } catch (e) { s.poErr = String(e); }
  return 'installed';
})()
"""

READ_METRICS_JS = r"""
(() => {
  const s = window.__jk;
  if (!s) return null;
  const f = s.frames.slice();
  s.frames = [];
  s.long = [];
  const longTotal = 0;
  return { frames: f, longCount: 0, hidden: document.hidden,
           vis: document.visibilityState };
})()
"""

# 帧间隔统计：只在页面侧算，避免把大数组搬回来
STATS_JS = r"""
(() => {
  const s = window.__jk;
  if (!s) return null;
  const f = s.frames.slice();
  s.frames = [];
  const long = s.long.slice();
  s.long = [];
  if (!f.length) return { n: 0 };
  const sorted = f.slice().sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    n: f.length,
    p50: Math.round(q(0.5) * 10) / 10,
    p95: Math.round(q(0.95) * 10) / 10,
    p99: Math.round(q(0.99) * 10) / 10,
    max: Math.round(sorted[sorted.length - 1] * 10) / 10,
    over33: f.filter((x) => x > 33).length,
    over100: f.filter((x) => x > 100).length,
    fps: Math.round(1000 / (f.reduce((a, b) => a + b, 0) / f.length) * 10) / 10,
    longCount: long.length,
    longTotalMs: Math.round(long.reduce((a, b) => a + (b.d || 0), 0)),
    longMaxMs: long.length ? Math.max(...long.map((x) => x.d || 0)) : 0,
    hidden: document.hidden, vis: document.visibilityState,
  };
})()
"""

# 真实打字延迟：逐字写值 → 等 React 提交后那一帧 → 记录耗时
TYPE_BURST_JS = r"""
(async () => {
  const el = document.querySelector('.inputBar input');
  if (!el) return { err: 'no .inputBar input' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const times = [];
  for (let i = 0; i < %d; i++) {
    const t0 = performance.now();
    setter.call(el, '压测'.repeat(1) + String(i));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    times.push(performance.now() - t0);
  }
  // 读回确认真的写进去了（React 受控输入必须回读）
  const propsKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  const propVal = propsKey ? (el[propsKey] || {}).value : null;
  const sorted = times.slice().sort((a, b) => a - b);
  return {
    n: times.length,
    p50: Math.round(sorted[Math.floor(sorted.length * 0.5)] * 10) / 10,
    p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
    max: Math.round(sorted[sorted.length - 1] * 10) / 10,
    total: Math.round(times.reduce((a, b) => a + b, 0)),
    domValue: el.value, reactValue: propVal,
  };
})()
"""


def perf_metrics(c):
    """Chromium Performance.getMetrics 快照。"""
    try:
        c.send('Performance.enable')
        r = c.send('Performance.getMetrics')
        return {m['name']: m['value'] for m in (r.get('metrics') or [])}
    except Exception as e:
        return {'__err': str(e)[:80]}


def diff_metrics(a, b, keys):
    out = {}
    for k in keys:
        if k in a and k in b:
            out[k] = round(b[k] - a[k], 4)
    return out


PERF_KEYS = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration',
             'JSHeapUsedSize', 'Nodes', 'LayoutCount', 'RecalcStyleCount']


def measure_phase(c, label):
    """一段测量：帧间隔统计 + Performance 增量 + 打字延迟。"""
    log('')
    log('  ── %s ──' % label)
    m0 = perf_metrics(c)
    c.js(INSTALL_METRICS_JS)
    # 清空已有样本
    c.js("(() => { const s=window.__jk; if(s){ s.frames=[]; s.long=[]; } return 'clear'; })()")
    time.sleep(FRAME_SECS)
    st = c.js(STATS_JS)
    m1 = perf_metrics(c)
    if not isinstance(st, dict) or not st.get('n'):
        log('    ★ 没拿到帧数据：%s' % st)
        st = {}
    else:
        log('    帧：%d 帧 / %d 秒 ⇒ 实测 %.1f fps' % (st['n'], FRAME_SECS, st['fps']))
        log('    帧间隔 p50=%.1fms  p95=%.1fms  p99=%.1fms  max=%.1fms'
            % (st['p50'], st['p95'], st['p99'], st['max']))
        log('    掉帧：>33ms %d 帧（%.1f%%）   >100ms %d 帧（%.1f%%）'
            % (st['over33'], 100.0 * st['over33'] / st['n'],
               st['over100'], 100.0 * st['over100'] / st['n']))
        log('    长任务：%d 个，合计 %dms，最长 %dms'
            % (st['longCount'], st['longTotalMs'], st['longMaxMs']))
        log('    可见性：%s hidden=%s' % (st.get('vis'), st.get('hidden')))
    d = diff_metrics(m0, m1, PERF_KEYS)
    log('    Performance 增量：%s' % json.dumps(d, ensure_ascii=False))
    # 打字延迟
    tb = c.js(TYPE_BURST_JS % TYPE_CHARS, await_promise=True)
    if isinstance(tb, dict) and not tb.get('err'):
        log('    打字延迟（%d 字）：p50=%.1fms  p95=%.1fms  max=%.1fms  合计 %dms'
            % (tb['n'], tb['p50'], tb['p95'], tb['max'], tb['total']))
        log('      回读：DOM.value=%r  React.props.value=%r'
            % ((tb.get('domValue') or '')[:20], (tb.get('reactValue') or '')[:20]))
    else:
        log('    打字延迟：%s' % tb)
    return {'frames': st, 'perf': d, 'typing': tb}


def wait_db_ready(base, timeout=150, need=2, gap=3.0):
    """
    严格等后端**真的**可用。

    ★ 为什么不能只等一次 `/health` 说 up：本机 PG 会周期性崩溃重启，
      上一轮就是"探针看到 up 就放行 → 应用启动时 PG 又在重启 → 应用的 supervisor
      自己拉了一套 PG + 8787 服务端 → 环境变混合态 → 登录流程失败"。
      所以这里要求**连续 need 次**都 up，间隔 gap 秒。
    """
    t0 = time.time()
    streak = 0
    last = None
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
    """无条件收尾（main 提前 return 时也保证不留进程）。"""
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

    section('1. 数据库')
    if not F.RPR.ensure_pg():
        log('  ★ 数据库起不来')
        return 2
    log('  数据库可查询')

    section('2. 起环境')
    shutil.rmtree(F.TMP, ignore_errors=True)
    os.makedirs(F.PROFILE, exist_ok=True)
    VITE_BIN = F.first_existing(os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                                os.path.join(F.DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'))
    F.spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], REPO,
            env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_DELAY_MS': '2500',
                 'FAKE_STEPS': '30', 'FAKE_LOG': FAKE_LOG},
            log=os.path.join(OUTDIR, 'fake-jank.log'))
    if F.wait_health(FAKE).get('ok') is not True:
        log('  ★ 假模型没起来')
        return 2
    F.spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
            env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
                 'DEEPSEEK_API_KEY': 'fake-key-jank', 'DEEPSEEK_MODEL': 'fake-jank'},
            log=SERVER_LOG)
    if F.wait_health(API).get('db') != 'up':
        log('  ★ 后端没起来')
        return 2
    log('  后端就绪（db=up）')
    # ★ 再严格等一次：连续 2 次 up、间隔 3 秒 —— 避开 PG 周期性重启窗口
    okdb, lastdb = wait_db_ready(API)
    log('  严格等 DB：%s（最后一次 /health=%s）'
        % (okdb, json.dumps(lastdb, ensure_ascii=False)[:160]))
    if not okdb:
        log('  ★ DB 始终不稳（本机 PG 周期性重启）—— 本轮放弃，避免环境混合态')
        return 2
    F.spawn('vite', [NODE, VITE_BIN, '--port', str(VITE_PORT), '--strictPort'], F.DESKTOP,
            log=os.path.join(OUTDIR, 'vite-jank.log'))
    time.sleep(4)
    F.spawn('electron', [NODE, 'scripts/start-electron.mjs',
                         '--user-data-dir=%s' % F.PROFILE,
                         '--remote-debugging-port=%d' % CDP_PORT], F.DESKTOP,
            env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT},
            log=os.path.join(OUTDIR, 'electron-jank.log'))
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
    st, sess = F.http_json('/auth/login/sms', 'POST',
                           body={'phone': F.TEST_PHONE, 'code': code or ''})
    token = (sess or {}).get('token')
    if not token:
        log('  ★ 登录失败 HTTP %s' % st)
        return 2
    c = P.Cdp()
    ok = False
    for attempt in range(1, 4):
        # 每次重试前先确认 DB 还稳（PG 周期性重启会让 token 校验失败）
        okdb, _ = wait_db_ready(API, timeout=60, need=1, gap=2.0)
        if not okdb:
            log('  第 %d 次尝试：DB 又不稳，等下一轮' % attempt)
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
        try:
            log('    页面文本片段：%r' % (c.js('(document.body.innerText||"")') or '')[:120])
        except Exception:
            pass
        time.sleep(5)
    if not ok:
        log('  ★ 三次都没进工作台 —— 环境不稳，放弃本轮')
        return 2

    section('4. ★ 提前台并确认窗口可见（否则帧率数据不可信）')
    hwnd, wins = raise_app_window(electron_pids())
    log('  可见顶层窗口：%s' % [(h, t) for h, _, t in wins])
    if hwnd:
        time.sleep(1.5)
        h = c.js('({hidden: document.hidden, vis: document.visibilityState})')
        log('  提前台后主窗口：%s' % json.dumps(h, ensure_ascii=False))
        if (h or {}).get('hidden'):
            log('  ⚠️ 仍是 hidden —— 帧率数据要打折扣（先把应用窗口点出来再跑更准）')
    else:
        log('  ⚠️ 没找到应用窗口，无法提前台')

    res = {}

    section('5. Phase A —— 0 张页（基线）')
    res['a_no_tab'] = measure_phase(c, 'A 0 张页')

    section('6. Phase B —— 开 1 张页（全屏，页内带动画）')
    c.js('window.workbench.openBrowser(%s); "ok"' % json.dumps(FAKE + '/shop'))
    ok, _, ms = F.wait_until(
        lambda: len([w for w in F.webviews() if isinstance(w.get('wcId'), int)]) >= 1, timeout=90)
    log('  内嵌页建起来：%s（%dms）' % (ok, ms))
    if not ok:
        return 2
    time.sleep(6)
    gc = F.guest_cdp('127.0.0.1:%d' % FAKE_PORT)
    if gc:
        # 给内嵌页注入动画（模拟"真实网页的轮播/动效"）
        gc.js(r"""
        (() => {
          if (window.__jkAnim) return 'already';
          window.__jkAnim = 1;
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
    if hwnd:
        raise_app_window(electron_pids())
        time.sleep(1)
    res['b_one_tab_full'] = measure_phase(c, 'B 1 张页 · 全屏')

    section('7. Phase C —— 同一张页切后台（opacity:0）')
    try:
        F.exit_fullscreen()
    except Exception as e:
        log('  ★ 切后台失败：%s' % e)
    time.sleep(3)
    log('  层：%s' % json.dumps(F.layer(), ensure_ascii=False))
    if hwnd:
        raise_app_window(electron_pids())
        time.sleep(1)
    res['c_one_tab_bg'] = measure_phase(c, 'C 1 张页 · 后台')

    section('8. 汇总')
    log('  %-16s %8s %8s %8s %8s %9s %9s %10s'
        % ('阶段', 'fps', 'p50ms', 'p95ms', 'p99ms', '>33ms帧', '长任务数', '打字p95ms'))
    for name, key in [('A 0 张页', 'a_no_tab'), ('B 1张·全屏', 'b_one_tab_full'),
                      ('C 1张·后台', 'c_one_tab_bg')]:
        d = res.get(key) or {}
        f = d.get('frames') or {}
        t = d.get('typing') or {}
        log('  %-16s %8s %8s %8s %8s %9s %9s %10s'
            % (name, f.get('fps', '-'), f.get('p50', '-'), f.get('p95', '-'),
               f.get('p99', '-'), f.get('over33', '-'), f.get('longCount', '-'),
               t.get('p95', '-')))
    log('')
    log('  判读：fps 应接近 60；p95 明显大于 16.7ms 或 >33ms 帧占比高 ⇒ 有掉帧（卡顿）。')
    log('        打字 p95 是"按下到画面更新"的体感延迟，>50ms 就会觉得打字发涩。')

    with open(os.path.join(OUTDIR, 'jank-result.json'), 'w', encoding='utf-8') as fp:
        json.dump(res, fp, ensure_ascii=False, indent=2)
    with open(os.path.join(OUTDIR, 'jank-report.txt'), 'w', encoding='utf-8') as fp:
        fp.write('\n'.join(REPORT))

    section('9. 收尾')
    try:
        c.js("(() => { const s=window.__jk; if(s&&s.po) s.po.disconnect(); window.__jk=null; return 'off'; })()")
    except Exception:
        pass
    if gc:
        try:
            gc.js("(() => { const b=document.querySelector('div[style*=\"z-index: 2147483647\"]');"
                  " if(b) b.remove(); window.__jkAnim=0; return 'removed'; })()")
        except Exception:
            pass
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
    new = sorted(electron_pids())
    if new:
        subprocess.run(['taskkill', '/F'] + sum([['/PID', str(x)] for x in new], []),
                       capture_output=True)
        log('  已结束 electron.exe：%s' % new)
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
