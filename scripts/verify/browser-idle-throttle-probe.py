# -*- coding: utf-8 -*-
"""
闲置浏览器**降频**探针 —— 只诊断，不改产品代码。

要回答的问题
  「市面上的浏览器对后台/不可见标签页会降频（暂停动画、降 rAF、钳 JS 定时器精度）。
   我们有没有做？如果做了，能省多少？」

做法
  1. 往**内嵌页自己**注入一个持续动画（rAF 自循环 + 16ms 定时器），
     分别量它在两种视图下的**真实帧率 / 定时器频率**：
       · requestAnimationFrame 每秒回调多少次
       · setInterval(…, 16) 每秒实际触发多少次（定时器精度）
       · document.visibilityState / document.hidden（Chromium 眼里的可见性）
  2. 同时用**内置资源哨兵**（1 秒采样）采整个应用的 CPU，
     对比"全屏"与"后台"两段的 CPU —— 这就是"降频能省多少"的答案。

判读
  · 后台态 rAF 仍 ≈ 60fps、定时器仍 ≈ 62 次/秒 ⇒ **完全没降频**。
  · 后台态 rAF 掉到 ≈ 1fps、定时器被钳到 1 次/秒 ⇒ 被 Chromium 后台规则接管了。

用法
  C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe \
      -u scripts/verify/browser-idle-throttle-probe.py
"""

import importlib.util
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

os.environ['FB_CDP_PORT'] = os.environ.get('IT_CDP_PORT', '9347')
os.environ['FB_API_PORT'] = os.environ.get('IT_API_PORT', '8797')
os.environ['FB_FAKE_PORT'] = os.environ.get('IT_FAKE_PORT', '8898')
os.environ['FB_VITE_PORT'] = os.environ.get('IT_VITE_PORT', '5183')

_spec = importlib.util.spec_from_file_location(
    'fbt', os.path.join(HERE, 'fullscreen-browser-tests.py'))
F = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(F)

OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'browser-idle-perf')
F.OUTDIR = OUTDIR
F.TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wb-idlethr')
F.PROFILE = os.path.join(F.TMP, 'profile')
os.makedirs(OUTDIR, exist_ok=True)

P = F.P
NODE = F.NODE
API, FAKE = F.API, F.FAKE
FAKE_PORT = F.FAKE_PORT
API_PORT, VITE_PORT, CDP_PORT = F.API_PORT, F.VITE_PORT, F.CDP_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm-thr.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server-thr.log')

WIN = int(os.environ.get('IT_WINDOW_SECS', '15'))
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


# 注入：持续动画 + 计数器（模拟"有动画的页面"，比如首页轮播 / 视频 / 滚动动效）
INSTALL_JS = r"""
(() => {
  if (window.__thr) return 'already';
  const s = window.__thr = { raf: 0, iv: 0, t0: performance.now(), vis: [], lastVis: null };
  const loop = () => { s.raf += 1; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  setInterval(() => { s.iv += 1; }, 16);
  // 再加一层"真的在画东西"的负载：每帧改一个元素的样式，逼合成器干活
  const box = document.createElement('div');
  box.id = '__thrBox';
  box.style.cssText = 'position:fixed;left:0;top:0;width:120px;height:120px;'
                    + 'background:linear-gradient(45deg,#f0f,#0ff);opacity:.35;z-index:2147483647;'
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
           vis: s.vis.slice(-4), now: document.visibilityState, hidden: document.hidden };
})()
"""

RESET_JS = ("(() => { const s=window.__thr; if(s){ s.raf=0; s.iv=0; s.t0=performance.now();"
            " s.vis=[]; s.lastVis=null; } return 'reset'; })()")

UNINSTALL_JS = ("(() => { const b=document.getElementById('__thrBox'); if(b) b.remove();"
                " window.__thr = null; return 'removed'; })()")


def wrap_workbench(conn):
    """
    给关键 IPC 套计数器。

    ⚠️ 不能直接 `window.workbench.getTaskState = wrapper` ——
    `contextBridge.exposeInMainWorld` 暴露出来的对象属性是**只读**的，
    赋值会**静默失败**（非严格模式下不报错），于是计数器永远是 0、
    看上去像"这个轮询根本没跑"（第一版探针就被这个坑骗过一次）。
    所以这里逐个策略试，并且**回读验证**到底哪种生效。
    """
    strategies = [
        ("直接赋值", """
          window.workbench.getTaskState = function (...a) { window.__ip.getTaskState += 1; return window.__orig.gts.apply(this, a); };
          return window.workbench.getTaskState !== window.__orig.gts;"""),
        ("defineProperty 单属性", """
          Object.defineProperty(window.workbench, 'getTaskState', { configurable: true, writable: true,
            value: function (...a) { window.__ip.getTaskState += 1; return window.__orig.gts.apply(this, a); } });
          return window.workbench.getTaskState !== window.__orig.gts;"""),
        ("整体替换 window.workbench", """
          const copy = {};
          for (const k of Object.keys(window.workbench)) copy[k] = window.workbench[k];
          copy.getTaskState = function (...a) { window.__ip.getTaskState += 1; return window.__orig.gts.apply(this, a); };
          copy.browserThrottle = function (...a) { window.__ip.browserThrottle += 1; return window.__orig.bt.apply(this, a); };
          Object.defineProperty(window, 'workbench', { configurable: true, writable: true, value: copy });
          return window.workbench.getTaskState !== window.__orig.gts;"""),
    ]
    conn.js("(() => { window.__ip = { getTaskState: 0, browserThrottle: 0 };"
            " window.__orig = { gts: window.workbench.getTaskState, bt: window.workbench.browserThrottle };"
            " return 'saved'; })()")
    for name, body in strategies:
        try:
            ok = conn.js('(() => { %s })()' % body)
        except Exception as e:
            log('  计数器策略「%s」异常：%s' % (name, e))
            continue
        if ok is True:
            log('  计数器已装上（策略：%s）' % name)
            return name
    log('  ★ 三种策略都没能装上计数器 —— 改用「测试条 DOM」间接判断')
    return None


def read_raw(guard_dir):
    rows = []
    if not os.path.isdir(guard_dir):
        return rows
    for n in os.listdir(guard_dir):
        if not (n.startswith('raw-') and n.endswith('.jsonl')):
            continue
        try:
            with open(os.path.join(guard_dir, n), 'r', encoding='utf-8', errors='replace') as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            rows.append(json.loads(line))
                        except Exception:
                            pass
        except Exception:
            pass
    rows.sort(key=lambda r: r.get('at') or 0)
    return rows


def cpu_of(rows, t0, t1):
    seg = [r for r in rows if t0 <= (r.get('at') or 0) <= t1]
    if not seg:
        return None
    out = {'n': len(seg),
           'cpuMean': round(statistics.mean([r.get('cpuPct') or 0 for r in seg]), 2),
           'cpuMax': round(max(r.get('cpuPct') or 0 for r in seg), 2),
           'memMean': round(statistics.mean([r.get('memMB') or 0 for r in seg]), 0)}
    per = {}
    for r in seg:
        for p in r.get('procs') or []:
            per.setdefault(p.get('type') or '?', []).append(p.get('cpuPct') or 0.0)
    out['byType'] = {k: round(statistics.mean(v), 2) for k, v in per.items()}
    return out


def measure(conn, label, secs):
    conn.js(RESET_JS)
    time.sleep(secs)
    r = conn.js(READ_JS)
    if not isinstance(r, dict):
        log('  %-26s 读不到计数（%s）' % (label, r))
        return None
    ms = max(1, r.get('ms') or 1)
    raf_fps = (r.get('raf') or 0) * 1000.0 / ms
    iv_fps = (r.get('iv') or 0) * 1000.0 / ms
    log('  %-26s rAF %6.1f 次/秒    setInterval(16ms) %6.1f 次/秒    %s hidden=%s'
        % (label, raf_fps, iv_fps, r.get('now'), r.get('hidden')))
    if r.get('vis'):
        log('      可见性变化：%s' % json.dumps(r['vis'], ensure_ascii=False))
    return {'raf_fps': round(raf_fps, 1), 'iv_fps': round(iv_fps, 1),
            'visibilityState': r.get('now'), 'hidden': r.get('hidden')}


def main():
    section('0. 环境自检')
    for label, path in [('vite 入口', F.first_existing(
                            os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                            os.path.join(F.DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'))),
                        ('electron 二进制', F.first_existing(
                            os.path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'),
                            os.path.join(F.DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe')))]:
        if not path:
            log('  ★ 缺 %s，先构建' % label)
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
    with open(os.path.join(F.PROFILE, 'workbench-settings.json'), 'w', encoding='utf-8') as f:
        json.dump({'resourceGuardEnabled': 1, 'resourceSampleMs': 1000}, f)
    log('  临时 profile：resourceSampleMs=1000 + 原始明细落盘')

    VITE_BIN = F.first_existing(os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                                os.path.join(F.DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'))
    F.spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], REPO,
            env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_DELAY_MS': '2500',
                 'FAKE_STEPS': '30', 'FAKE_LOG': FAKE_LOG},
            log=os.path.join(OUTDIR, 'fake-thr.log'))
    if F.wait_health(FAKE).get('ok') is not True:
        log('  ★ 假模型没起来')
        return 2
    F.spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
            env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
                 'DEEPSEEK_API_KEY': 'fake-key-idlethr', 'DEEPSEEK_MODEL': 'fake-idlethr'},
            log=SERVER_LOG)
    hs = F.wait_health(API)
    if hs.get('db') != 'up':
        log('  ★ 后端没起来：%s' % json.dumps(hs, ensure_ascii=False)[:160])
        return 2
    log('  后端就绪（db=up）')
    F.spawn('vite', [NODE, VITE_BIN, '--port', str(VITE_PORT), '--strictPort'], F.DESKTOP,
            log=os.path.join(OUTDIR, 'vite-thr.log'))
    time.sleep(4)
    F.spawn('electron', [NODE, 'scripts/start-electron.mjs',
                         '--user-data-dir=%s' % F.PROFILE,
                         '--remote-debugging-port=%d' % CDP_PORT], F.DESKTOP,
            env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT,
                 'WB_RESOURCE_GUARD_RAW': '1'},
            log=os.path.join(OUTDIR, 'electron-thr.log'))
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
    log('  登录成功')

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
    wrap_workbench(c)

    section('4. 开 1 张页（不起任务）')
    c.js('window.workbench.openBrowser(%s); "ok"' % json.dumps(FAKE + '/shop'))
    ok, _, ms = F.wait_until(
        lambda: len([w for w in F.webviews() if isinstance(w.get('wcId'), int)]) >= 1, timeout=90)
    log('  内嵌页建起来：%s（%dms）' % (ok, ms))
    if not ok:
        return 2
    time.sleep(6)
    L = F.layer()
    log('  层状态：%s' % json.dumps(L, ensure_ascii=False))
    # 「临时测试条」的 DOM：如果它显示了 wcId，说明那个 1.2 秒轮询**确实在跑并拿到了数据**
    bar = c.js("(() => { const b = document.querySelector('.driveBar');"
               " return b ? (b.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : null; })()")
    log('  临时测试条 DOM：%s' % (bar if bar else '（没有这个元素）'))

    gc = F.guest_cdp('127.0.0.1:%d' % FAKE_PORT)
    if not gc:
        log('  ★ 连不上内嵌页')
        return 2

    res = {}
    marks = {}

    # ---------------- 全屏 + 动画
    section('5. 全屏态 + 内嵌页持续动画（模拟"有动画的真实页面"）')
    log('  内嵌页注入：%s' % gc.js(INSTALL_JS))
    log('  主窗口注入：%s' % c.js(INSTALL_JS))
    time.sleep(2)
    t = time.time()
    res['fullscreen'] = measure(gc, '内嵌页 · 全屏', WIN)
    res['fullscreen_main'] = measure(c, '主窗口 · 全屏', WIN)
    marks['full'] = (t, time.time())

    # ---------------- 后台 + 动画
    section('6. 切「后台运行」（opacity:0）—— 同一张页、动画照跑')
    try:
        F.exit_fullscreen()
    except Exception as e:
        log('  ★ 点退出全屏失败：%s' % e)
    time.sleep(3)
    L2 = F.layer()
    log('  层状态：%s' % json.dumps(L2, ensure_ascii=False))
    log('  webview 尺寸：%sx%s（与全屏一致 ⇒ 不是 0 尺寸）'
        % ((L2.get('wvRect') or {}).get('w'), (L2.get('wvRect') or {}).get('h')))
    t = time.time()
    res['background'] = measure(gc, '内嵌页 · 后台', WIN)
    res['background_main'] = measure(c, '主窗口 · 后台', WIN)
    marks['bg'] = (t, time.time())

    # ---------------- 卸载动画后再采一段（"真降频"长什么样）
    section('7. 对照组：把动画停掉（内嵌页真安静）')
    log('  内嵌页卸载：%s' % gc.js(UNINSTALL_JS))
    time.sleep(2)
    t = time.time()
    time.sleep(WIN)
    marks['quiet'] = (t, time.time())

    # ---------------- 读 CPU
    section('8. 内置资源哨兵的 CPU 数据（1 秒采样，按段）')
    guard_dir = os.path.join(F.PROFILE, 'resource-guard')
    rows = read_raw(guard_dir)
    log('  原始采样点：%d' % len(rows))
    for name, key in [('全屏 + 动画', 'full'), ('后台 + 动画', 'bg'), ('后台 + 无动画', 'quiet')]:
        a, b = marks[key]
        d = cpu_of(rows, int(a * 1000), int(b * 1000))
        if not d:
            log('  %-14s 无采样点' % name)
            continue
        log('  %-14s %2d 点  总CPU 均 %.2f%% / 峰 %.2f%%   内存 均 %.0f MB   按类型 %s'
            % (name, d['n'], d['cpuMean'], d['cpuMax'], d['memMean'],
               json.dumps(d['byType'], ensure_ascii=False)))
        res.setdefault('cpu', {})[key] = d

    section('9. 结论')
    # 那个 1.2 秒轮询到底跑没跑
    span = (marks['bg'][1] - marks['full'][0]) if 'bg' in marks else 0
    ip = c.js('window.__ip') or {}
    log('  闲置期间关键 IPC 计数（跨全屏+后台共 %.0f 秒）：' % span)
    for k, v in ip.items():
        log('    %-18s %4d 次   平均 %.2f 次/秒   周期约 %.2f 秒'
            % (k, v, v / span if span else 0, (span / v) if v else 0))
    log('    测试条 DOM（能看到 wcId ⇒ 轮询确实拿到了数据）：%s'
        % (c.js("(() => { const b=document.querySelector('.driveBar');"
                " return b ? (b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,110) : null; })()")
           or '（无）'))
    f, b = res.get('fullscreen') or {}, res.get('background') or {}
    if f and b:
        log('  内嵌页 rAF：      全屏 %6.1f 次/秒 → 后台 %6.1f 次/秒'
            % (f['raf_fps'], b['raf_fps']))
        log('  内嵌页 16ms 定时器：全屏 %6.1f 次/秒 → 后台 %6.1f 次/秒'
            % (f['iv_fps'], b['iv_fps']))
        log('  visibilityState： 全屏 %s → 后台 %s' % (f.get('visibilityState'),
                                                        b.get('visibilityState')))
        cpu = res.get('cpu') or {}
        if cpu.get('full') and cpu.get('bg'):
            log('  整机 CPU：        全屏 %.2f%% → 后台 %.2f%%（后台/全屏 = %.0f%%）'
                % (cpu['full']['cpuMean'], cpu['bg']['cpuMean'],
                   100.0 * cpu['bg']['cpuMean'] / cpu['full']['cpuMean']
                   if cpu['full']['cpuMean'] else 0))
        if cpu.get('quiet'):
            log('  （对照）后台无动画：%.2f%%' % cpu['quiet']['cpuMean'])

    with open(os.path.join(OUTDIR, 'throttle-result.json'), 'w', encoding='utf-8') as fp:
        json.dump({'res': res,
                   'marks': {k: [round(v[0], 3), round(v[1], 3)] for k, v in marks.items()}},
                  fp, ensure_ascii=False, indent=2)
    with open(os.path.join(OUTDIR, 'throttle-report.txt'), 'w', encoding='utf-8') as fp:
        fp.write('\n'.join(REPORT))

    section('10. 收尾')
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
