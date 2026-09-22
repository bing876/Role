# -*- coding: utf-8 -*-
r"""
**任务跑完之后的"闲置态"** —— 只诊断，不改产品代码。

为什么必须测这一条
  我前面所有测量里，那张页都是我用 `openBrowser()` **手动**开的 ——
  也就是说**从来没跑过任务**。而真实用户的那张页是 **AI 在任务里开的**，
  他看到的"闲置"是**任务刚跑完**的状态。

  两者可能不同，因为"任务跑完"会经过一整套收尾：
    · 主进程把这一路从运行表里摘掉（lane 移除）
    · 渲染层收到 `kind:'done'` 事件 → `refreshDriving()`（+1200ms 补刷一次）
    · `drivingIds` 若不刷新，那张页会被 `decideSleep` 第①条**永久跳过**（永不休眠）
    · driver 侧可能还挂着监听/轮询（敏感字段观察是 1.2s 一次）

  代码注释说这些都处理了 —— **但这一轮的教训就是"别信注释，去量"**。

测法：同一张页，**任务前**与**任务后**各量一段（CPU / 帧时间 / 长任务），
并检查任务后 `agentLanes()` 是否真的空了、测试条相位是否回到"空闲"。

用法
  C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe \
      -u scripts/verify/browser-idle-posttask-probe.py
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

os.environ['FB_CDP_PORT'] = os.environ.get('IT2_CDP_PORT', '9371')
os.environ['FB_API_PORT'] = os.environ.get('IT2_API_PORT', '8821')
os.environ['FB_FAKE_PORT'] = os.environ.get('IT2_FAKE_PORT', '8922')
os.environ['FB_VITE_PORT'] = os.environ.get('IT2_VITE_PORT', '5207')

_spec = importlib.util.spec_from_file_location(
    'fbt', os.path.join(HERE, 'fullscreen-browser-tests.py'))
F = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(F)

OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'browser-idle-perf')
F.OUTDIR = OUTDIR
F.TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wb-posttask')
F.PROFILE = os.path.join(F.TMP, 'profile')
os.makedirs(OUTDIR, exist_ok=True)

P = F.P
NODE = F.NODE
API, FAKE = F.API, F.FAKE
FAKE_PORT = F.FAKE_PORT
API_PORT, VITE_PORT, CDP_PORT = F.API_PORT, F.VITE_PORT, F.CDP_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm-posttask.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server-posttask.log')
# F.llm_calls() 读的是 F.FAKE_LOG —— 这里换成我们这次实际用的那份
F.FAKE_LOG = FAKE_LOG

FAKE_STEPS = os.environ.get('IT2_FAKE_STEPS', '4')
GOAL = os.environ.get('IT2_GOAL', '搜索下单：帮我在商城买一个无线鼠标')
MEASURE_SECS = int(os.environ.get('IT2_MEASURE_SECS', '15'))
TASK_TIMEOUT = int(os.environ.get('IT2_TASK_TIMEOUT', '180'))
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
  if (window.__pt) return 'already';
  const s = window.__pt = { frames: [], long: [] };
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
  const s = window.__pt;
  if (!s) return null;
  const f = s.frames.slice(); s.frames = [];
  const lg = s.long.slice(); s.long = [];
  if (!f.length) return { n: 0 };
  const sorted = f.slice().sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const bar = document.querySelector('.driveBar');
  return { n: f.length,
           p50: Math.round(q(0.5) * 10) / 10,
           p95: Math.round(q(0.95) * 10) / 10,
           max: Math.round(sorted[sorted.length - 1] * 10) / 10,
           over33: f.filter((x) => x > 33).length,
           fps: Math.round(1000 / (f.reduce((a, b) => a + b, 0) / f.length) * 10) / 10,
           longCount: lg.length, longMax: lg.length ? Math.max(...lg) : 0,
           driveBar: bar ? (bar.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90) : null,
           hidden: document.hidden };
})()
"""


def snap(c):
    try:
        s = c.js('window.workbench.resourceSnapshot()', await_promise=True) or {}
        smp = s.get('sample') or {}
        return {'cpu': smp.get('cpuPct'), 'mem': smp.get('memMB'),
                'nproc': len(smp.get('procs') or []), 'procs': smp.get('procs') or []}
    except Exception as e:
        return {'err': str(e)[:60]}


def lanes(c):
    try:
        return c.js('window.workbench.agentLanes()', await_promise=True)
    except Exception as e:
        return 'ERR:%s' % str(e)[:50]


def measure(c, label):
    log('')
    log('  ── %s ──' % label)
    s = snap(c)
    log('    整机 CPU %5.2f%%   内存 %4.0f MB   进程数 %s'
        % (s.get('cpu') or 0, s.get('mem') or 0, s.get('nproc')))
    for p in s.get('procs') or []:
        log('      %-9s %-20s cpu %6.3f%%  mem %7.1f MB'
            % (p.get('type'), (p.get('name') or '-')[:20], p.get('cpuPct') or 0, p.get('memMB') or 0))
    log('    agentLanes() = %s' % lanes(c))
    c.js("(() => { const s=window.__pt; if(s){ s.frames=[]; s.long=[]; } return 'c'; })()")
    time.sleep(MEASURE_SECS)
    fr = c.js(FRAME_JS) or {}
    if fr.get('n'):
        log('    帧：%d 帧 ⇒ %.1f fps   p50 %.1f  p95 %.1f  max %.1f   >33ms %d'
            % (fr['n'], fr['fps'], fr['p50'], fr['p95'], fr['max'], fr['over33']))
        log('    长任务：%d 个（最长 %dms）' % (fr.get('longCount', 0), fr.get('longMax', 0)))
        log('    测试条 DOM：%s' % fr.get('driveBar'))
        log('    可见性：hidden=%s' % fr.get('hidden'))
    return {'snap': {k: v for k, v in s.items() if k != 'procs'}, 'frames': fr,
            'lanes': lanes(c)}


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

    section('2. 起环境（假模型只走 %s 步，让任务能跑完）' % FAKE_STEPS)
    shutil.rmtree(F.TMP, ignore_errors=True)
    os.makedirs(F.PROFILE, exist_ok=True)
    VITE_BIN = F.first_existing(os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                                os.path.join(F.DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'))
    F.spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], REPO,
            env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_DELAY_MS': '400',
                 'FAKE_STEPS': FAKE_STEPS, 'FAKE_LOG': FAKE_LOG},
            log=os.path.join(OUTDIR, 'fake-posttask.log'))
    if F.wait_health(FAKE).get('ok') is not True:
        log('  ★ 假模型没起来')
        return 2
    F.spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
            env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
                 'DEEPSEEK_API_KEY': 'fake-key-posttask', 'DEEPSEEK_MODEL': 'fake-posttask'},
            log=SERVER_LOG)
    if F.wait_health(API).get('db') != 'up':
        log('  ★ 后端没起来')
        return 2
    okdb, last = wait_db_ready(API)
    log('  严格等 DB：%s（%s）' % (okdb, json.dumps(last, ensure_ascii=False)[:120]))
    if not okdb:
        log('  ★ DB 不稳，放弃')
        return 2
    F.spawn('vite', [NODE, VITE_BIN, '--port', str(VITE_PORT), '--strictPort'], F.DESKTOP,
            log=os.path.join(OUTDIR, 'vite-posttask.log'))
    time.sleep(4)
    F.spawn('electron', [NODE, 'scripts/start-electron.mjs',
                         '--user-data-dir=%s' % F.PROFILE,
                         '--remote-debugging-port=%d' % CDP_PORT], F.DESKTOP,
            env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT},
            log=os.path.join(OUTDIR, 'electron-posttask.log'))
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
    st, al = F.http_json('/agents', token=token)
    agents = (al or {}).get('agents') or []
    agent_id = int(next(a['id'] for a in agents if a.get('id')))
    log('  agentId = %d' % agent_id)

    section('4. 用 openBrowser 开一张页（与之前测量同口径）')
    c.js('window.workbench.openBrowser(%s); "ok"' % json.dumps(FAKE + '/shop'))
    ok, _, ms = F.wait_until(
        lambda: len([w for w in F.webviews() if isinstance(w.get('wcId'), int)]) >= 1, timeout=90)
    log('  内嵌页建起来：%s（%dms）' % (ok, ms))
    if not ok:
        return 2
    time.sleep(6)
    L = F.layer()
    wc_id = L.get('wvWc')
    log('  wcId = %s' % wc_id)
    hwnd = raise_app_window(electron_pids())
    time.sleep(1.5)
    c.js(INSTALL_JS)

    section('5. 测量 A：**从未跑过任务**的闲置态')
    a = measure(c, 'A · 从未跑任务')

    section('6. 真跑一个任务（%s 步），等它**跑完**' % FAKE_STEPS)
    c.js('window.workbench.agentStart(%s, %s, %s, %d, {agentId: %d}); "ok"'
         % (json.dumps(GOAL), json.dumps(API), json.dumps(token), wc_id, agent_id))
    ok, _, ms = F.wait_until(lambda: len(F.llm_calls(GOAL)) >= 1, timeout=60)
    log('  任务发车：%s（%dms）' % (ok, ms))

    def done():
        txt = c.js('(document.body.innerText||"")') or ''
        if '任务完成' in txt:
            return 'done-text'
        try:
            st2 = c.js('window.workbench.getTaskState(%d)' % wc_id, await_promise=True) or {}
            if isinstance(st2, dict) and st2.get('phase') in ('idle', 'done'):
                return 'phase=%s' % st2.get('phase')
        except Exception:
            pass
        return None

    ok, why, ms = F.wait_until(done, timeout=TASK_TIMEOUT)
    log('  任务结束：%s（%s，%dms）' % (ok, why, ms))
    if not ok:
        log('  ⚠️ 等不到"任务完成"，仍然继续测（任务后态就是它现在的样子）')
    # 等收尾事件 + 补刷（代码里是 +1200ms 再刷一次 refreshDriving）
    log('  等 6 秒让收尾事件与 refreshDriving 补刷跑完…')
    time.sleep(6)
    log('  任务完成后 agentLanes() = %s' % lanes(c))
    log('  测试条 DOM：%s'
        % (c.js("(() => { const b=document.querySelector('.driveBar');"
                " return b ? (b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,90) : null; })()") or '（无）'))

    section('7. 测量 B：**任务跑完之后**的闲置态')
    if hwnd:
        raise_app_window(electron_pids())
        time.sleep(1)
    b = measure(c, 'B · 任务跑完后')

    section('8. 汇总：任务前 vs 任务后（同一张页、同一个"闲置"）')
    fa, fb = (a.get('frames') or {}), (b.get('frames') or {})
    log('  %-24s %16s %16s' % ('指标', 'A 从未跑任务', 'B 任务跑完后'))
    for k, lab in [('fps', 'fps'), ('p50', '帧 p50 ms'), ('p95', '帧 p95 ms'),
                   ('max', '帧 max ms'), ('over33', '>33ms 掉帧'), ('longCount', '长任务个数')]:
        log('  %-24s %16s %16s' % (lab, fa.get(k, '-'), fb.get(k, '-')))
    log('  %-24s %16s %16s' % ('整机 CPU %',
                               (a.get('snap') or {}).get('cpu'), (b.get('snap') or {}).get('cpu')))
    log('  %-24s %16s %16s' % ('内存 MB',
                               (a.get('snap') or {}).get('mem'), (b.get('snap') or {}).get('mem')))
    log('  %-24s %16s %16s' % ('agentLanes()', a.get('lanes'), b.get('lanes')))
    log('  %-24s %16s %16s' % ('测试条', fa.get('driveBar'), fb.get('driveBar')))
    log('')
    dcpu = (fb.get('snap', {}) or {}).get('cpu') if False else ((b.get('snap') or {}).get('cpu') or 0)
    acpu = (a.get('snap') or {}).get('cpu') or 0
    log('  CPU 变化：%+.3f 个百分点；帧 p95 变化：%+.1f ms；掉帧 %s → %s'
        % (dcpu - acpu, (fb.get('p95') or 0) - (fa.get('p95') or 0),
           fa.get('over33'), fb.get('over33')))
    lanes_b = b.get('lanes')
    if isinstance(lanes_b, list) and len(lanes_b) == 0:
        log('  ⇒ 任务后 **agentLanes() 已清空** —— 收尾把这一路摘干净了。')
    elif isinstance(lanes_b, list):
        log('  ⇒ ⚠️ 任务后 agentLanes() **仍有 %d 路**：%s —— 收尾可能没摘干净（值得进一步查）。'
            % (len(lanes_b), lanes_b))
    else:
        log('  ⇒ agentLanes() 读不到：%s' % lanes_b)
    if (fb.get('over33') or 0) == 0 and abs(dcpu - acpu) < 0.5:
        log('  ⇒ 任务后的闲置态与"从未跑任务"**没有可测量差异**。')

    with open(os.path.join(OUTDIR, 'posttask-result.json'), 'w', encoding='utf-8') as fp:
        json.dump({'goal': GOAL, 'fakeSteps': FAKE_STEPS, 'wcId': wc_id,
                   'A_before': a, 'B_after': b}, fp, ensure_ascii=False, indent=1)
    with open(os.path.join(OUTDIR, 'posttask-report.txt'), 'w', encoding='utf-8') as fp:
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
