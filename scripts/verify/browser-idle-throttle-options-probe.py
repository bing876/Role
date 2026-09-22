# -*- coding: utf-8 -*-
r"""
**候选降频手段可行性实验** —— 只诊断，不改产品代码。

为什么要做这个
  诊断报告 §4.2 里我**断言**过一句：「即使传 true，`setBackgroundThrottling(true)` 也救不了
  （因为 guest 自报 visible）」。那是**推理**，不是实测。
  而这句断言直接决定修法完全不同：
    · 若传 true **能**降频 ⇒ 问题只是"我们从没传过 true"，改动极小；
    · 若传 true **不能**降频 ⇒ 机制本身不够，得换手段。
  所以这里用**真实产品 API**（`window.workbench.browserThrottle`）真调一次，看结果。

同时把三个候选手段放在同一台机器上量：
  C1  `browserThrottle(wcId, true)`      —— 产品已有的机制（真实 API，不是手抄）
  C2  `visibility:hidden`（**保真实尺寸**）—— 红线只禁 display:none / 0 尺寸
  C3  离屏 `transform: translate(-100000px,0)`（**保真实尺寸**）
  C4  CDP `Page.setWebLifecycleState('frozen')` —— 冻结 JS

每个手段都量四件事：
  ① 内嵌页真实 rAF 帧率 / 16ms 定时器频率（降没降）
  ② `document.visibilityState`
  ③ **webview 尺寸有没有变**（红线：不能变 0）
  ④ **CDP 驾驶还可不可用**（`Runtime.evaluate` + 真点一次按钮）—— 这是能不能用的前提

用法
  C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe \
      -u scripts/verify/browser-idle-throttle-options-probe.py
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

os.environ['FB_CDP_PORT'] = os.environ.get('IO_CDP_PORT', '9353')
os.environ['FB_API_PORT'] = os.environ.get('IO_API_PORT', '8803')
os.environ['FB_FAKE_PORT'] = os.environ.get('IO_FAKE_PORT', '8904')
os.environ['FB_VITE_PORT'] = os.environ.get('IO_VITE_PORT', '5189')

_spec = importlib.util.spec_from_file_location(
    'fbt', os.path.join(HERE, 'fullscreen-browser-tests.py'))
F = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(F)

OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'browser-idle-perf')
F.OUTDIR = OUTDIR
F.TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wb-thropt')
F.PROFILE = os.path.join(F.TMP, 'profile')
os.makedirs(OUTDIR, exist_ok=True)

P = F.P
NODE = F.NODE
API, FAKE = F.API, F.FAKE
FAKE_PORT = F.FAKE_PORT
API_PORT, VITE_PORT, CDP_PORT = F.API_PORT, F.VITE_PORT, F.CDP_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm-opt.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server-opt.log')

WIN = int(os.environ.get('IO_WINDOW_SECS', '10'))
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


INSTALL_JS = r"""
(() => {
  if (window.__thr) return 'already';
  const s = window.__thr = { raf: 0, iv: 0, t0: performance.now(), vis: [], lastVis: null };
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
  const noteVis = () => {
    const v = document.visibilityState + '/' + (document.hidden ? 'hidden' : 'shown');
    if (v !== s.lastVis) { s.lastVis = v; s.vis.push([Math.round(performance.now() - s.t0), v]); }
  };
  noteVis();
  document.addEventListener('visibilitychange', noteVis);
  return 'installed';
})()
"""

READ_JS = r"""
(() => {
  const s = window.__thr;
  if (!s) return null;
  return { raf: s.raf, iv: s.iv, ms: Math.round(performance.now() - s.t0),
           vis: s.vis.slice(-3), now: document.visibilityState, hidden: document.hidden };
})()
"""

RESET_JS = ("(() => { const s=window.__thr; if(s){ s.raf=0; s.iv=0; s.t0=performance.now();"
            " s.vis=[]; s.lastVis=null; } return 'reset'; })()")


def measure_guest(gc, label, secs):
    """
    量内嵌页的真实帧率 / 定时器频率 / 可见性。

    ★ 冻结（C4）之后 JS 会停，`Runtime.evaluate` 会**挂住直到 socket 超时**。
      所以这里把超时压到 8 秒并兜住异常 —— 读不到本身就是"JS 已停"的证据。
      （`WebSocketTimeoutException` 不在 cdp-probe 的可重试列表里，会立刻抛出，不会重试。）
    """
    try:
        gc.ws.settimeout(8)
    except Exception:
        pass
    try:
        gc.js(RESET_JS)
    except Exception as e:
        log('  %-30s 重置失败（页面可能已停）：%s' % (label, str(e)[:70]))
    time.sleep(secs)
    try:
        r = gc.js(READ_JS)
    except Exception as e:
        log('  %-30s ★ 读不到（%s）⇒ 说明该页 JS 已停 —— 这正是"冻结"的效果'
            % (label, str(e)[:70]))
        return {'raf_fps': 0.0, 'iv_fps': 0.0, 'visibilityState': '(读不到)',
                'hidden': None, 'unreadable': True}
    if not isinstance(r, dict):
        log('  %-30s 读不到计数（%s）' % (label, r))
        return None
    ms = max(1, r.get('ms') or 1)
    raf = (r.get('raf') or 0) * 1000.0 / ms
    iv = (r.get('iv') or 0) * 1000.0 / ms
    log('  %-30s rAF %6.1f/s   16ms定时器 %6.1f/s   %s (hidden=%s)'
        % (label, raf, iv, r.get('now'), r.get('hidden')))
    if r.get('vis'):
        log('      可见性变化：%s' % json.dumps(r['vis'], ensure_ascii=False))
    return {'raf_fps': round(raf, 1), 'iv_fps': round(iv, 1),
            'visibilityState': r.get('now'), 'hidden': r.get('hidden')}


def drive_probe(gc, wc_id):
    """
    ④ CDP 驾驶还可不可用：读一次元素 rect（驾驶算坐标靠它）+ 真点一次按钮看有没有生效。
    返回 (ok, note)
    """
    try:
        gc.ws.settimeout(8)
    except Exception:
        pass
    try:
        r = gc.js("(() => { const b=document.getElementById('btn1');"
                  " if(!b) return {err:'no btn1'};"
                  " b.addEventListener('click', () => { window.__c = (window.__c||0)+1; }, {once:true});"
                  " const q=b.getBoundingClientRect();"
                  " return {x:q.x+q.width/2, y:q.y+q.height/2, w:Math.round(q.width), h:Math.round(q.height)}; })()")
        if not isinstance(r, dict) or 'x' not in r:
            return False, '读 rect 失败：%s' % r
        gc.send('Input.dispatchMouseEvent', type='mouseMoved', x=r['x'], y=r['y'], buttons=0)
        gc.send('Input.dispatchMouseEvent', type='mousePressed', x=r['x'], y=r['y'],
                button='left', buttons=1, clickCount=1)
        gc.send('Input.dispatchMouseEvent', type='mouseReleased', x=r['x'], y=r['y'],
                button='left', buttons=0, clickCount=1)
        time.sleep(0.6)
        c = gc.js('window.__c || 0')
        return bool(c), 'rect=%sx%s 点击计数=%s' % (r.get('w'), r.get('h'), c)
    except Exception as e:
        return False, '异常（页面可能已停）：%s' % str(e)[:80]


def wv_rect(c):
    """宿主页面里 webview 元素的真实尺寸（红线：不能变 0）。"""
    try:
        return c.js("(() => { const v=document.querySelector('webview');"
                    " if(!v) return null; const r=v.getBoundingClientRect();"
                    " const s=getComputedStyle(v);"
                    " return {w:Math.round(r.width), h:Math.round(r.height),"
                    " display:s.display, visibility:s.visibility, opacity:s.opacity,"
                    " transform:s.transform}; })()")
    except Exception as e:
        return {'err': str(e)}


def set_wv_style(c, css):
    """给宿主页面里的 webview 元素设/清内联样式（只动运行时 DOM，不动代码）。"""
    if css is None:
        return c.js("(() => { const v=document.querySelector('webview');"
                    " if(v) v.removeAttribute('style'); return 'cleared'; })()")
    return c.js("(() => { const v=document.querySelector('webview');"
                " if(!v) return 'no webview'; v.style.cssText=%s; return 'set'; })()"
                % json.dumps(css))


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
            log=os.path.join(OUTDIR, 'fake-opt.log'))
    if F.wait_health(FAKE).get('ok') is not True:
        log('  ★ 假模型没起来')
        return 2
    F.spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
            env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
                 'DEEPSEEK_API_KEY': 'fake-key-opt', 'DEEPSEEK_MODEL': 'fake-opt'},
            log=SERVER_LOG)
    if F.wait_health(API).get('db') != 'up':
        log('  ★ 后端没起来')
        return 2
    log('  后端就绪（db=up）')
    F.spawn('vite', [NODE, VITE_BIN, '--port', str(VITE_PORT), '--strictPort'], F.DESKTOP,
            log=os.path.join(OUTDIR, 'vite-opt.log'))
    time.sleep(4)
    F.spawn('electron', [NODE, 'scripts/start-electron.mjs',
                         '--user-data-dir=%s' % F.PROFILE,
                         '--remote-debugging-port=%d' % CDP_PORT], F.DESKTOP,
            env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT},
            log=os.path.join(OUTDIR, 'electron-opt.log'))
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

    section('4. 开 1 张页 + 注入持续动画')
    c.js('window.workbench.openBrowser(%s); "ok"' % json.dumps(FAKE + '/shop'))
    ok, _, ms = F.wait_until(
        lambda: len([w for w in F.webviews() if isinstance(w.get('wcId'), int)]) >= 1, timeout=90)
    log('  内嵌页建起来：%s（%dms）' % (ok, ms))
    if not ok:
        return 2
    time.sleep(6)
    L = F.layer()
    wc_id = L.get('wvWc')
    log('  webview wcId=%s  尺寸=%sx%s' % (wc_id, (L.get('wvRect') or {}).get('w'),
                                          (L.get('wvRect') or {}).get('h')))
    gc = F.guest_cdp('127.0.0.1:%d' % FAKE_PORT)
    if not gc:
        log('  ★ 连不上内嵌页')
        return 2
    log('  注入动画：%s' % gc.js(INSTALL_JS))
    time.sleep(2)

    res = {}

    # ---------------------------------------------------------------- 基线
    section('5. 基线：全屏 · 可见')
    res['base_fullscreen'] = measure_guest(gc, '全屏（基线）', WIN)
    log('  宿主里 webview 元素：%s' % json.dumps(wv_rect(c), ensure_ascii=False))
    log('  CDP 驾驶：%s' % (drive_probe(gc, wc_id),))

    # ---------------------------------------------------------------- 后台态
    section('6. 后台态（opacity:0，当前实现）')
    try:
        F.exit_fullscreen()
    except Exception as e:
        log('  ★ 切后台失败：%s' % e)
    time.sleep(3)
    log('  层：%s' % json.dumps(F.layer(), ensure_ascii=False))
    res['bg_opacity'] = measure_guest(gc, '后台 opacity:0', WIN)
    log('  宿主里 webview 元素：%s' % json.dumps(wv_rect(c), ensure_ascii=False))

    # ---------------------------------------------------------------- C1 真实产品 API
    section('★ C1：真调产品 API `browserThrottle(wcId, true)`（验证我的断言）')
    try:
        r = c.js('window.workbench.browserThrottle(%d, true)' % wc_id, await_promise=True)
        log('  browserThrottle 返回：%s' % json.dumps(r, ensure_ascii=False))
    except Exception as e:
        log('  ★ 调用异常：%s' % e)
    time.sleep(2)
    res['c1_throttle_true_bg'] = measure_guest(gc, 'C1 后台 + throttle(true)', WIN)
    # 全屏下也试一次
    try:
        F.click_floating()
    except Exception:
        pass
    time.sleep(2)
    log('  切回全屏后层：%s' % json.dumps(F.layer(), ensure_ascii=False))
    res['c1_throttle_true_fs'] = measure_guest(gc, 'C1 全屏 + throttle(true)', WIN)
    # 复位
    try:
        r = c.js('window.workbench.browserThrottle(%d, false)' % wc_id, await_promise=True)
        log('  复位 browserThrottle(false)：%s' % json.dumps(r, ensure_ascii=False))
    except Exception as e:
        log('  ★ 复位异常：%s' % e)
    time.sleep(1)

    # ---------------------------------------------------------------- C2 visibility:hidden
    section('★ C2：`visibility:hidden`（保真实尺寸）')
    try:
        F.exit_fullscreen()
    except Exception:
        pass
    time.sleep(2)
    log('  设样式：%s' % set_wv_style(c, 'visibility: hidden !important;'))
    time.sleep(2)
    log('  宿主里 webview 元素：%s' % json.dumps(wv_rect(c), ensure_ascii=False))
    res['c2_visibility_hidden'] = measure_guest(gc, 'C2 visibility:hidden', WIN)
    ok_drive, note = drive_probe(gc, wc_id)
    log('  CDP 驾驶可用=%s（%s）' % (ok_drive, note))
    res['c2_drive_ok'] = ok_drive
    set_wv_style(c, None)
    time.sleep(1)

    # ---------------------------------------------------------------- C3 离屏
    section('★ C3：离屏 `transform: translate(-100000px,0)`（保真实尺寸）')
    log('  设样式：%s' % set_wv_style(c, 'transform: translate(-100000px, 0) !important;'))
    time.sleep(2)
    log('  宿主里 webview 元素：%s' % json.dumps(wv_rect(c), ensure_ascii=False))
    res['c3_offscreen'] = measure_guest(gc, 'C3 离屏', WIN)
    ok_drive, note = drive_probe(gc, wc_id)
    log('  CDP 驾驶可用=%s（%s）' % (ok_drive, note))
    res['c3_drive_ok'] = ok_drive
    set_wv_style(c, None)
    time.sleep(1)

    # ---------------------------------------------------------------- C4 freeze
    section('★ C4：CDP `Page.setWebLifecycleState("frozen")`（冻结 JS）')
    try:
        r = gc.send('Page.setWebLifecycleState', state='frozen')
        log('  冻结返回：%s' % json.dumps(r, ensure_ascii=False))
    except Exception as e:
        log('  ★ 冻结异常：%s' % e)
    time.sleep(2)
    res['c4_frozen'] = measure_guest(gc, 'C4 冻结后', WIN)
    ok_drive, note = drive_probe(gc, wc_id)
    log('  冻结后 CDP 驾驶可用=%s（%s）' % (ok_drive, note))
    res['c4_drive_ok'] = ok_drive
    # 恢复
    try:
        gc.send('Page.setWebLifecycleState', state='active')
        log('  恢复 active 返回 ok')
    except Exception as e:
        log('  ★ 恢复异常：%s' % e)
    time.sleep(2)
    res['c4_after_active'] = measure_guest(gc, 'C4 恢复 active 后', WIN)

    # ---------------------------------------------------------------- 结论
    section('7. 结论（每个手段：降没降 / 尺寸有没有变 / 驾驶还能不能用）')
    base = res.get('base_fullscreen') or {}
    rows = [
        ('基线 全屏', 'base_fullscreen', None),
        ('后台 opacity:0（现状）', 'bg_opacity', None),
        ('C1 throttle(true)·后台', 'c1_throttle_true_bg', None),
        ('C1 throttle(true)·全屏', 'c1_throttle_true_fs', None),
        ('C2 visibility:hidden', 'c2_visibility_hidden', 'c2_drive_ok'),
        ('C3 离屏', 'c3_offscreen', 'c3_drive_ok'),
        ('C4 frozen', 'c4_frozen', 'c4_drive_ok'),
    ]
    log('  %-26s %8s %8s %10s %8s' % ('手段', 'rAF/s', '定时器/s', 'visibility', '可驾驶'))
    for name, key, dkey in rows:
        d = res.get(key) or {}
        dr = res.get(dkey) if dkey else None
        log('  %-26s %8.1f %8.1f %10s %8s'
            % (name, d.get('raf_fps', -1), d.get('iv_fps', -1),
               d.get('visibilityState') or '-',
               ('是' if dr else '否') if dkey else '（未测）'))
    if base.get('raf_fps'):
        log('')
        log('  相对基线的 rAF 保留率（越低=越省）：')
        for name, key, _ in rows[1:]:
            d = res.get(key) or {}
            if d.get('raf_fps') is not None:
                log('    %-26s %5.1f%%' % (name, 100.0 * d['raf_fps'] / base['raf_fps']))
    log('')
    log('  ★ 对报告 §4.2 那句断言的实测裁决：见上面 C1 两行。')

    with open(os.path.join(OUTDIR, 'throttle-options.json'), 'w', encoding='utf-8') as f:
        json.dump(res, f, ensure_ascii=False, indent=2)
    with open(os.path.join(OUTDIR, 'throttle-options-report.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(REPORT))

    section('8. 收尾')
    try:
        gc.js("(() => { const b=document.getElementById('__thrBox'); if(b) b.remove();"
              " window.__thr=null; return 'removed'; })()")
    except Exception:
        pass
    set_wv_style(c, None)
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
