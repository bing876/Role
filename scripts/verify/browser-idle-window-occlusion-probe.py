# -*- coding: utf-8 -*-
r"""
**决定性实验**：`opacity:0` 到底有没有让内嵌页降频？还是只是"我的宿主窗口盖住了应用窗口"？

为什么要做
  重复性实验发现：guest 的 rAF 与 **guest 自己的 `document.hidden`** 一一对应
  （hidden=False ⇒ 60/s；hidden=True ⇒ 1/s）。但有两个假设都能解释数据：

    A) **`opacity:0` 让 guest 变 hidden** ⇒ 降频真的生效了（好事，报告 §4.1 要改）
    B) **只是应用窗口被我的宿主窗口盖住了**（Chromium 的遮挡降频，与我们代码无关）
       —— 那种情况下 `opacity:0` 什么也没干，报告 §4.1 的结论成立

判别方法：**用 Win32 把应用窗口提到前台并确认 `document.hidden=False`**，
然后再做「全屏 → 后台 → 全屏 → 后台」两轮。窗口确实可见时：
  · 若后台 rAF 掉下来、且切回全屏能恢复 ⇒ 假设 A（`opacity:0` 有效）
  · 若后台 rAF 仍是 60/s ⇒ 假设 B（`opacity:0` 无效）

用法
  C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe \
      -u scripts/verify/browser-idle-window-occlusion-probe.py
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

os.environ['FB_CDP_PORT'] = os.environ.get('IW_CDP_PORT', '9357')
os.environ['FB_API_PORT'] = os.environ.get('IW_API_PORT', '8807')
os.environ['FB_FAKE_PORT'] = os.environ.get('IW_FAKE_PORT', '8908')
os.environ['FB_VITE_PORT'] = os.environ.get('IW_VITE_PORT', '5193')

_spec = importlib.util.spec_from_file_location(
    'fbt', os.path.join(HERE, 'fullscreen-browser-tests.py'))
F = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(F)

OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'browser-idle-perf')
F.OUTDIR = OUTDIR
F.TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wb-occl')
F.PROFILE = os.path.join(F.TMP, 'profile')
os.makedirs(OUTDIR, exist_ok=True)

P = F.P
NODE = F.NODE
API, FAKE = F.API, F.FAKE
FAKE_PORT = F.FAKE_PORT
API_PORT, VITE_PORT, CDP_PORT = F.API_PORT, F.VITE_PORT, F.CDP_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm-occl.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server-occl.log')

WIN = int(os.environ.get('IW_WINDOW_SECS', '8'))
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


# ------------------------------------------------------------------ Win32 提窗口

_u32 = ctypes.windll.user32
_HWND_TOP = 0
_SWP_NOSIZE = 0x0001
_SWP_NOMOVE = 0x0002
_SWP_SHOWWINDOW = 0x0040
_SW_RESTORE = 9


def find_app_windows(pids):
    """按 pid 找可见顶层窗口（返回 [(hwnd, pid, title)]）。"""
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
                found.append((hwnd, pid.value, buf.value))
        except Exception:
            pass
        return True

    _u32.EnumWindows(WNDENUMPROC(cb), 0)
    return found


def raise_window(hwnd):
    """把窗口提到最前（先 restore，再 TOP，再 SetForegroundWindow）。"""
    _u32.ShowWindow(hwnd, _SW_RESTORE)
    time.sleep(0.2)
    _u32.SetWindowPos(hwnd, _HWND_TOP, 0, 0, 0, 0,
                      _SWP_NOMOVE | _SWP_NOSIZE | _SWP_SHOWWINDOW)
    time.sleep(0.2)
    ok = _u32.SetForegroundWindow(hwnd)
    return bool(ok)


def is_occluded(hwnd):
    """`IsIconic` + 是否被别的窗口完全盖住（粗略：看窗口矩形中心点属于谁）。"""
    try:
        r = wintypes.RECT()
        _u32.GetWindowRect(hwnd, ctypes.byref(r))
        cx = (r.left + r.right) // 2
        cy = (r.top + r.bottom) // 2
        pt = wintypes.POINT(cx, cy)
        _u32.WindowFromPoint(ctypes.byref(pt))
        return {'rect': [r.left, r.top, r.right, r.bottom], 'iconic': bool(_u32.IsIconic(hwnd))}
    except Exception as e:
        return {'err': str(e)}


INSTALL_JS = r"""
(() => {
  if (window.__thr) return 'already';
  const s = window.__thr = { raf: 0, iv: 0, t0: performance.now() };
  const loop = () => { s.raf += 1; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  setInterval(() => { s.iv += 1; }, 16);
  const box = document.createElement('div');
  box.id = '__thrBox';
  box.style.cssText = 'position:fixed;left:0;top:0;width:120px;height:120px;'
    + 'background:linear-gradient(45deg,#f0f,#0ff);opacity:.4;z-index:2147483647;'
    + 'pointer-events:none;will-change:transform';
  document.documentElement.appendChild(box);
  let a = 0;
  const spin = () => { a = (a + 3) % 360;
    box.style.transform = 'translate(' + (200 + 150 * Math.sin(a * Math.PI / 180)).toFixed(1)
      + 'px,' + (200 + 150 * Math.cos(a * Math.PI / 180)).toFixed(1) + 'px) rotate(' + a + 'deg)';
    requestAnimationFrame(spin); };
  requestAnimationFrame(spin);
  return 'installed';
})()
"""

READ_JS = r"""
(() => {
  const s = window.__thr;
  return { raf: s ? s.raf : null, iv: s ? s.iv : null,
           ms: s ? Math.round(performance.now() - s.t0) : null,
           vis: document.visibilityState, hidden: document.hidden };
})()
"""

RESET_JS = "(() => { const s=window.__thr; if(s){ s.raf=0; s.iv=0; s.t0=performance.now(); } return 'r'; })()"


def measure(gc, c, label, secs):
    gc.js(RESET_JS)
    time.sleep(secs)
    g = gc.js(READ_JS)
    m = c.js(READ_JS)
    if not isinstance(g, dict):
        log('  %-30s 读不到' % label)
        return None
    ms = max(1, g.get('ms') or 1)
    raf = (g.get('raf') or 0) * 1000.0 / ms
    iv = (g.get('iv') or 0) * 1000.0 / ms
    log('  %-30s guest rAF %6.1f/s  定时器 %6.1f/s  | guest %s/hidden=%s | 主窗口 %s/hidden=%s'
        % (label, raf, iv, g.get('vis'), g.get('hidden'),
           (m or {}).get('vis'), (m or {}).get('hidden')))
    return {'raf_fps': round(raf, 1), 'iv_fps': round(iv, 1),
            'guest_hidden': g.get('hidden'), 'guest_vis': g.get('vis'),
            'main_hidden': (m or {}).get('hidden')}


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
    e_before = electron_pids()

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
            log=os.path.join(OUTDIR, 'fake-occl.log'))
    if F.wait_health(FAKE).get('ok') is not True:
        log('  ★ 假模型没起来')
        return 2
    F.spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
            env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
                 'DEEPSEEK_API_KEY': 'fake-key-occl', 'DEEPSEEK_MODEL': 'fake-occl'},
            log=SERVER_LOG)
    if F.wait_health(API).get('db') != 'up':
        log('  ★ 后端没起来')
        return 2
    log('  后端就绪（db=up）')
    F.spawn('vite', [NODE, VITE_BIN, '--port', str(VITE_PORT), '--strictPort'], F.DESKTOP,
            log=os.path.join(OUTDIR, 'vite-occl.log'))
    time.sleep(4)
    F.spawn('electron', [NODE, 'scripts/start-electron.mjs',
                         '--user-data-dir=%s' % F.PROFILE,
                         '--remote-debugging-port=%d' % CDP_PORT], F.DESKTOP,
            env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT},
            log=os.path.join(OUTDIR, 'electron-occl.log'))
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
    c.js("localStorage.setItem('workbench.token', %s);"
         "localStorage.setItem('workbench.apiBase', %s); 'set'"
         % (json.dumps(token), json.dumps(API)))
    c.send('Page.reload')
    time.sleep(6)
    ok, _, _ = F.wait_until(
        lambda: ('退出登录' in (c.js('(document.body.innerText||"")') or '')), timeout=60)
    log('  进到工作台：%s' % ok)
    if not ok:
        return 2

    section('4. 开 1 张页 + 注入动画')
    c.js('window.workbench.openBrowser(%s); "ok"' % json.dumps(FAKE + '/shop'))
    ok, _, ms = F.wait_until(
        lambda: len([w for w in F.webviews() if isinstance(w.get('wcId'), int)]) >= 1, timeout=90)
    log('  内嵌页建起来：%s（%dms）' % (ok, ms))
    if not ok:
        return 2
    time.sleep(6)
    gc = F.guest_cdp('127.0.0.1:%d' % FAKE_PORT)
    if not gc:
        log('  ★ 连不上内嵌页')
        return 2
    log('  注入动画：%s' % gc.js(INSTALL_JS))

    section('5. ★ 把应用窗口提到前台（关键控制变量）')
    pids = electron_pids()
    log('  应用 electron.exe pid：%s' % sorted(pids))
    wins = find_app_windows(pids)
    log('  找到可见顶层窗口：%s' % [(h, p, t) for h, p, t in wins])
    if not wins:
        log('  ★ 没找到窗口，无法提前台 —— 本实验无法定论')
    hwnd = None
    for h, p, t in wins:
        if t.strip():
            hwnd = h
            break
    if hwnd is None and wins:
        hwnd = wins[0][0]
    if hwnd:
        log('  提前台 hwnd=%s（%s）' % (hwnd, [t for _, _, t in wins if _ == hwnd][:1]))
        log('  raise 返回：%s' % raise_window(hwnd))
        time.sleep(1.5)
        log('  窗口状态：%s' % json.dumps(is_occluded(hwnd), ensure_ascii=False))
        # 提前台后确认主窗口 document.hidden
        m = c.js(READ_JS)
        log('  提前台后主窗口：%s/hidden=%s' % ((m or {}).get('vis'), (m or {}).get('hidden')))
        if (m or {}).get('hidden'):
            log('  ⚠️ 主窗口仍是 hidden —— 提前台没成功，结论要打折扣')

    section('6. 窗口确认可见后：全屏 → 后台 → 全屏 → 后台')
    res = {}
    for i in (1, 2):
        log('')
        log('  ── 第 %d 轮 ──' % i)
        # 确保全屏
        try:
            L = F.layer()
            if '--bg' in (L.get('layerCls') or ''):
                F.click_floating()
                time.sleep(2)
        except Exception as e:
            log('    切全屏失败：%s' % str(e)[:60])
        if hwnd:
            raise_window(hwnd)
            time.sleep(1)
        res['fs%d' % i] = measure(gc, c, '第%d轮 全屏' % i, WIN)
        try:
            F.exit_fullscreen()
        except Exception as e:
            log('    切后台失败：%s' % str(e)[:60])
        time.sleep(2.5)
        if hwnd:
            raise_window(hwnd)
            time.sleep(1)
        res['bg%d' % i] = measure(gc, c, '第%d轮 后台' % i, WIN)

    section('7. 结论')
    fs = [res.get('fs1'), res.get('fs2')]
    bg = [res.get('bg1'), res.get('bg2')]
    log('  全屏 guest rAF：%s   （guest hidden：%s）'
        % ([d and d.get('raf_fps') for d in fs], [d and d.get('guest_hidden') for d in fs]))
    log('  后台 guest rAF：%s   （guest hidden：%s）'
        % ([d and d.get('raf_fps') for d in bg], [d and d.get('guest_hidden') for d in bg]))
    ok_fs = [d for d in fs if d and d.get('raf_fps') and d['raf_fps'] > 30]
    if ok_fs:
        log('')
        log('  ★ 窗口确实可见（全屏 rAF 恢复到 60 档）⇒ 以这一轮为准：')
        log('    后台 rAF = %s' % [d and d.get('raf_fps') for d in bg])
        b_ok = [d for d in bg if d and d.get('raf_fps') is not None]
        if b_ok and all(d['raf_fps'] < 5 for d in b_ok):
            log('    ⇒ **假设 A 成立**：`opacity:0` 确实让内嵌页降频（rAF 掉到 1/s 档）')
        elif b_ok and all(d['raf_fps'] > 30 for d in b_ok):
            log('    ⇒ **假设 B 成立**：`opacity:0` 没有降频（rAF 仍 60/s）—— 之前的 1/s 是遮挡造成的')
        else:
            log('    ⇒ 两轮不一致，仍需更多轮次才能定论')
    else:
        log('')
        log('  ⚠️ 全屏 rAF 也没到 60 档 ⇒ 窗口始终被遮挡，**本实验无法判别 A/B**。')
        log('     此时应改用「人工把应用窗口点到最前」后重跑本探针。')

    with open(os.path.join(OUTDIR, 'occlusion-result.json'), 'w', encoding='utf-8') as fp:
        json.dump({'res': res, 'windows': [(h, p, t) for h, p, t in wins]}, fp,
                  ensure_ascii=False, indent=2)
    with open(os.path.join(OUTDIR, 'occlusion-report.txt'), 'w', encoding='utf-8') as fp:
        fp.write('\n'.join(REPORT))

    section('8. 收尾')
    try:
        gc.js("(() => { const b=document.getElementById('__thrBox'); if(b) b.remove();"
              " window.__thr=null; return 'removed'; })()")
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
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
