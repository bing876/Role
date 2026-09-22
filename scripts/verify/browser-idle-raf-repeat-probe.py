# -*- coding: utf-8 -*-
r"""
**重复性 / 控制变量实验**：内嵌页后台态到底有没有被降频？

背景（为什么必须做这个）
  同一条件测出了**互相矛盾**的两次结果：
    · `browser-idle-throttle-probe.py`：后台 `opacity:0` ⇒ rAF **60.0/s**（没降）
    · `browser-idle-throttle-options-probe.py`：后台 `opacity:0` ⇒ rAF **1.0/s**（降了）
  这违反"同一条件同一结论"，所以**两次单独测量都不可信**，必须一轮会话内重复多次，
  并且把可能的**控制变量**一起记录下来：

    · 主窗口的 `document.visibilityState` / `hidden` / `hasFocus()`
    · 内嵌页 guest 自己的 `visibilityState` / `hidden` / `hasFocus()`
    · 宿主层有没有 `--bg` 类、webview 元素的 opacity / visibility
    · **是否调用过 `Page.bringToFront`（把窗口提到前台）**

  `Page.bringToFront` 是刻意加的控制变量：Chromium 的遮挡检测（occlusion）会让
  "被别的窗口盖住的窗口"里的渲染进程降频。如果"提前台"能改变 rAF，就说明
  之前那次矛盾结果来自**窗口遮挡状态不同**，而不是我们代码的差异。

用法
  C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe \
      -u scripts/verify/browser-idle-raf-repeat-probe.py
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

os.environ['FB_CDP_PORT'] = os.environ.get('IR_CDP_PORT', '9355')
os.environ['FB_API_PORT'] = os.environ.get('IR_API_PORT', '8805')
os.environ['FB_FAKE_PORT'] = os.environ.get('IR_FAKE_PORT', '8906')
os.environ['FB_VITE_PORT'] = os.environ.get('IR_VITE_PORT', '5191')

_spec = importlib.util.spec_from_file_location(
    'fbt', os.path.join(HERE, 'fullscreen-browser-tests.py'))
F = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(F)

OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'browser-idle-perf')
F.OUTDIR = OUTDIR
F.TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wb-rafrep')
F.PROFILE = os.path.join(F.TMP, 'profile')
os.makedirs(OUTDIR, exist_ok=True)

P = F.P
NODE = F.NODE
API, FAKE = F.API, F.FAKE
FAKE_PORT = F.FAKE_PORT
API_PORT, VITE_PORT, CDP_PORT = F.API_PORT, F.VITE_PORT, F.CDP_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm-rep.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server-rep.log')

WIN = int(os.environ.get('IR_WINDOW_SECS', '8'))
ROUNDS = int(os.environ.get('IR_ROUNDS', '3'))
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
           vis: document.visibilityState, hidden: document.hidden,
           focus: document.hasFocus() };
})()
"""

RESET_JS = "(() => { const s=window.__thr; if(s){ s.raf=0; s.iv=0; s.t0=performance.now(); } return 'r'; })()"


def host_state(c):
    """宿主页面：层类名 + webview 元素的计算样式。"""
    try:
        return c.js("(() => { const l=document.querySelector('.browserLayer');"
                    " const v=document.querySelector('webview'); const s=v?getComputedStyle(v):null;"
                    " return {layerCls: l?l.className:null,"
                    " wvOpacity: s?s.opacity:null, wvVisibility: s?s.visibility:null}; })()")
    except Exception as e:
        return {'err': str(e)[:60]}


def measure(gc, c, label, secs, bring_to_front=False):
    """测一次；bring_to_front 是控制变量。"""
    if bring_to_front:
        try:
            c.send('Page.bringToFront')
            time.sleep(1.0)
        except Exception as e:
            log('    bringToFront 失败：%s' % str(e)[:60])
    gc.js(RESET_JS)
    time.sleep(secs)
    g = gc.js(READ_JS)
    m = c.js(READ_JS)          # 主窗口（没注入 __thr，raf 会是 null，但 visibility 有）
    h = host_state(c)
    if not isinstance(g, dict):
        log('  %-34s 读不到' % label)
        return None
    ms = max(1, g.get('ms') or 1)
    raf = (g.get('raf') or 0) * 1000.0 / ms
    iv = (g.get('iv') or 0) * 1000.0 / ms
    log('  %-34s guest rAF %6.1f/s  定时器 %6.1f/s  | guest %s/hidden=%s/focus=%s'
        % (label, raf, iv, g.get('vis'), g.get('hidden'), g.get('focus')))
    log('  %-34s 主窗口 %s/hidden=%s/focus=%s | 层=%s wv.opacity=%s wv.visibility=%s'
        % ('', (m or {}).get('vis'), (m or {}).get('hidden'), (m or {}).get('focus'),
           (h or {}).get('layerCls'), (h or {}).get('wvOpacity'), (h or {}).get('wvVisibility')))
    return {'raf_fps': round(raf, 1), 'iv_fps': round(iv, 1),
            'guest': {'vis': g.get('vis'), 'hidden': g.get('hidden'), 'focus': g.get('focus')},
            'main': {'vis': (m or {}).get('vis'), 'hidden': (m or {}).get('hidden'),
                     'focus': (m or {}).get('focus')},
            'host': h, 'bringToFront': bring_to_front}


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
    # ★ 起跑前先清残留 electron.exe：探针自己的收尾不可靠（实测漏了 4 个），
    #   残留的闲置实例会给 CPU/内存测量加噪声。本机没有别的 electron 应用，全清是安全的。
    left = sorted(electron_pids())
    if left:
        log('  ★ 发现残留 electron.exe %s —— 先清掉（否则污染测量）' % left)
        subprocess.run(['taskkill', '/F'] + sum([['/PID', str(x)] for x in left], []),
                       capture_output=True)
        time.sleep(2)
    e_before = electron_pids()
    log('  起跑前 electron.exe：%s' % (sorted(e_before) or '无'))

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
            log=os.path.join(OUTDIR, 'fake-rep.log'))
    if F.wait_health(FAKE).get('ok') is not True:
        log('  ★ 假模型没起来')
        return 2
    F.spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
            env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
                 'DEEPSEEK_API_KEY': 'fake-key-rep', 'DEEPSEEK_MODEL': 'fake-rep'},
            log=SERVER_LOG)
    if F.wait_health(API).get('db') != 'up':
        log('  ★ 后端没起来')
        return 2
    log('  后端就绪（db=up）')
    F.spawn('vite', [NODE, VITE_BIN, '--port', str(VITE_PORT), '--strictPort'], F.DESKTOP,
            log=os.path.join(OUTDIR, 'vite-rep.log'))
    time.sleep(4)
    F.spawn('electron', [NODE, 'scripts/start-electron.mjs',
                         '--user-data-dir=%s' % F.PROFILE,
                         '--remote-debugging-port=%d' % CDP_PORT], F.DESKTOP,
            env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT},
            log=os.path.join(OUTDIR, 'electron-rep.log'))
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
    time.sleep(2)

    section('5. 重复测量（每轮：全屏 → 后台）')
    log('  窗口初始状态：%s' % json.dumps(host_state(c), ensure_ascii=False))
    runs = []
    for i in range(1, ROUNDS + 1):
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
        a = measure(gc, c, '第%d轮 全屏' % i, WIN, bring_to_front=False)
        try:
            F.exit_fullscreen()
        except Exception as e:
            log('    切后台失败：%s' % str(e)[:60])
        time.sleep(2.5)
        b = measure(gc, c, '第%d轮 后台' % i, WIN, bring_to_front=False)
        # 后台 + 提前台（控制变量）
        b2 = measure(gc, c, '第%d轮 后台(提前台)' % i, WIN, bring_to_front=True)
        # 回到全屏，准备下一轮
        try:
            F.click_floating()
        except Exception:
            pass
        time.sleep(2)
        runs.append({'round': i, 'fullscreen': a, 'background': b, 'background_front': b2})

    section('6. 汇总：后台态 rAF 到底降不降')
    log('  %-6s %-14s %-14s %-14s %s' % ('轮次', '全屏 rAF/s', '后台 rAF/s', '后台(提前台)', '判定'))
    for r in runs:
        f = (r.get('fullscreen') or {}).get('raf_fps')
        b = (r.get('background') or {}).get('raf_fps')
        b2 = (r.get('background_front') or {}).get('raf_fps')
        verdict = '-'
        if f and b:
            verdict = '降频' if b < f * 0.5 else '**没降**'
        log('  %-6d %-14s %-14s %-14s %s' % (r['round'], f, b, b2, verdict))
    fss = [(r.get('fullscreen') or {}).get('raf_fps') for r in runs]
    bgs = [(r.get('background') or {}).get('raf_fps') for r in runs]
    bgs2 = [(r.get('background_front') or {}).get('raf_fps') for r in runs]
    log('')
    log('  全屏 rAF：%s' % fss)
    log('  后台 rAF：%s' % bgs)
    log('  后台(提前台) rAF：%s' % bgs2)
    log('')
    log('  判读口径：全屏稳定在 60 附近；后台若也稳定在 60 ⇒ 没降频；若稳定在 1 附近 ⇒ 降了。')
    log('            若同一状态在几轮里**时高时低** ⇒ 结论本身不确定，必须找出控制变量。')

    with open(os.path.join(OUTDIR, 'raf-repeat.json'), 'w', encoding='utf-8') as fp:
        json.dump(runs, fp, ensure_ascii=False, indent=2)
    with open(os.path.join(OUTDIR, 'raf-repeat-report.txt'), 'w', encoding='utf-8') as fp:
        fp.write('\n'.join(REPORT))

    section('7. 收尾')
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
