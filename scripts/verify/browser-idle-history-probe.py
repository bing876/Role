# -*- coding: utf-8 -*-
r"""
**长聊天记录（200 条）对闲置性能的影响** —— 只诊断，不改产品代码。

为什么怀疑这一条
  - `App.tsx` 里那个 **1.2 秒轮询**（喂「临时测试条」）每次都会 `setDriveBar(新对象)`
    ⇒ **整棵 App 组件树重渲染**。
  - 而聊天消息是 `{messages.map((m, idx) => ...)}` **平铺渲染**，全文件搜不到
    `React.memo` / `useMemo` / 虚拟列表。
  - 服务端 `GET /chat/history` 一次返回**最新 200 条**（`LIMIT 200`）。
  - ⇒ 有 200 条历史时，**每 1.2 秒要重渲染 200 条消息**。
  我前面所有测量都在**空库**里跑的（0 条消息）—— Profile 99.99% idle，
  **恰恰是这条路径完全没被走到**。

本探针做 A/B：
    A  空会话（0 条）
    B  同一会话塞进 **200 条**（用服务端自己的 crypto 加密后写入，见 seed-messages.mjs）
  两段都量：帧间隔 p50/p95/max、>33ms 掉帧、`longtask`、打字延迟、DOM 里 `.msg` 条数。

★ 一次调用跑完（起 PG → 起环境 → 造数据 → 测量 → 收尾）：
  agent 起的进程**只在同一次调用内有效**，分两次调用会拿不到环境。

用法
  C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe \
      -u scripts/verify/browser-idle-history-probe.py
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

os.environ['FB_CDP_PORT'] = os.environ.get('IH_CDP_PORT', '9369')
os.environ['FB_API_PORT'] = os.environ.get('IH_API_PORT', '8819')
os.environ['FB_FAKE_PORT'] = os.environ.get('IH_FAKE_PORT', '8920')
os.environ['FB_VITE_PORT'] = os.environ.get('IH_VITE_PORT', '5205')

_spec = importlib.util.spec_from_file_location(
    'fbt', os.path.join(HERE, 'fullscreen-browser-tests.py'))
F = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(F)

OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'browser-idle-perf')
F.OUTDIR = OUTDIR
F.TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wb-history')
F.PROFILE = os.path.join(F.TMP, 'profile')
os.makedirs(OUTDIR, exist_ok=True)

P = F.P
NODE = F.NODE
API, FAKE = F.API, F.FAKE
FAKE_PORT = F.FAKE_PORT
API_PORT, VITE_PORT, CDP_PORT = F.API_PORT, F.VITE_PORT, F.CDP_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm-history.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server-history.log')

N_MSGS = int(os.environ.get('IH_MSGS', '200'))
FRAME_SECS = int(os.environ.get('IH_FRAME_SECS', '15'))
TYPE_CHARS = int(os.environ.get('IH_TYPE_CHARS', '25'))
NODE_EXE = os.environ.get(
    'IH_NODE', r'C:\Users\bing\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe')
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
  if (window.__hf) return 'already';
  const s = window.__hf = { frames: [], long: [] };
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
  const s = window.__hf;
  if (!s) return null;
  const f = s.frames.slice(); s.frames = [];
  const lg = s.long.slice(); s.long = [];
  if (!f.length) return { n: 0 };
  const sorted = f.slice().sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { n: f.length,
           p50: Math.round(q(0.5) * 10) / 10,
           p95: Math.round(q(0.95) * 10) / 10,
           p99: Math.round(q(0.99) * 10) / 10,
           max: Math.round(sorted[sorted.length - 1] * 10) / 10,
           over33: f.filter((x) => x > 33).length,
           over100: f.filter((x) => x > 100).length,
           fps: Math.round(1000 / (f.reduce((a, b) => a + b, 0) / f.length) * 10) / 10,
           longCount: lg.length, longMax: lg.length ? Math.max(...lg) : 0,
           msgNodes: document.querySelectorAll('.msg').length,
           domNodes: document.querySelectorAll('*').length,
           hidden: document.hidden, vis: document.visibilityState };
})()
"""

TYPE_BURST_JS = r"""
(async () => {
  const el = document.querySelector('.inputbar input');
  if (!el) return { err: 'no .inputbar input' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const times = [];
  for (let i = 0; i < %d; i++) {
    const t0 = performance.now();
    setter.call(el, '压测' + String(i));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    times.push(performance.now() - t0);
  }
  const sorted = times.slice().sort((a, b) => a - b);
  return { n: times.length,
           p50: Math.round(sorted[Math.floor(sorted.length * 0.5)] * 10) / 10,
           p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
           max: Math.round(sorted[sorted.length - 1] * 10) / 10 };
})()
"""


def snap(c):
    try:
        s = c.js('window.workbench.resourceSnapshot()', await_promise=True) or {}
        smp = s.get('sample') or {}
        return {'cpu': smp.get('cpuPct'), 'mem': smp.get('memMB'),
                'nproc': len(smp.get('procs') or [])}
    except Exception as e:
        return {'err': str(e)[:60]}


def measure(c, label):
    log('')
    log('  ── %s ──' % label)
    s = snap(c)
    log('    整机 CPU %5.2f%%   内存 %4.0f MB   进程数 %s'
        % (s.get('cpu') or 0, s.get('mem') or 0, s.get('nproc')))
    c.js("(() => { const s=window.__hf; if(s){ s.frames=[]; s.long=[]; } return 'c'; })()")
    time.sleep(FRAME_SECS)
    fr = c.js(FRAME_JS) or {}
    if fr.get('n'):
        log('    帧：%d 帧 ⇒ %.1f fps   p50 %.1f  p95 %.1f  p99 %.1f  max %.1f ms'
            % (fr['n'], fr['fps'], fr['p50'], fr['p95'], fr['p99'], fr['max']))
        log('    掉帧：>33ms %d（%.2f%%）  >100ms %d   |   长任务 %d 个（最长 %dms）'
            % (fr['over33'], 100.0 * fr['over33'] / fr['n'], fr['over100'],
               fr.get('longCount', 0), fr.get('longMax', 0)))
        log('    DOM：.msg 消息节点 %d 个，全部节点 %d 个   |   可见性 %s hidden=%s'
            % (fr.get('msgNodes'), fr.get('domNodes'), fr.get('vis'), fr.get('hidden')))
    tb = c.js(TYPE_BURST_JS % TYPE_CHARS, await_promise=True)
    if isinstance(tb, dict) and not tb.get('err'):
        log('    打字延迟（%d 字）：p50 %.1f  p95 %.1f  max %.1f ms'
            % (tb['n'], tb['p50'], tb['p95'], tb['max']))
    else:
        log('    打字延迟：%s' % tb)
    return {'snap': s, 'frames': fr, 'typing': tb}


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
    log('  node：%s（%s）' % (NODE_EXE, '存在' if os.path.exists(NODE_EXE) else '★不存在'))
    if not os.path.exists(NODE_EXE):
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

    section('2. 起环境')
    shutil.rmtree(F.TMP, ignore_errors=True)
    os.makedirs(F.PROFILE, exist_ok=True)
    VITE_BIN = F.first_existing(os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                                os.path.join(F.DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'))
    F.spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], REPO,
            env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_DELAY_MS': '2500',
                 'FAKE_STEPS': '30', 'FAKE_LOG': FAKE_LOG},
            log=os.path.join(OUTDIR, 'fake-history.log'))
    if F.wait_health(FAKE).get('ok') is not True:
        log('  ★ 假模型没起来')
        return 2
    F.spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
            env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
                 'DEEPSEEK_API_KEY': 'fake-key-history', 'DEEPSEEK_MODEL': 'fake-history'},
            log=SERVER_LOG)
    if F.wait_health(API).get('db') != 'up':
        log('  ★ 后端没起来')
        return 2
    okdb, last = wait_db_ready(API)
    log('  严格等 DB：%s（%s）' % (okdb, json.dumps(last, ensure_ascii=False)[:130]))
    if not okdb:
        log('  ★ DB 不稳，放弃')
        return 2
    F.spawn('vite', [NODE, VITE_BIN, '--port', str(VITE_PORT), '--strictPort'], F.DESKTOP,
            log=os.path.join(OUTDIR, 'vite-history.log'))
    time.sleep(4)
    F.spawn('electron', [NODE, 'scripts/start-electron.mjs',
                         '--user-data-dir=%s' % F.PROFILE,
                         '--remote-debugging-port=%d' % CDP_PORT], F.DESKTOP,
            env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT},
            log=os.path.join(OUTDIR, 'electron-history.log'))
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

    # 拿 agentId / conversationId
    st, al = F.http_json('/agents', token=token)
    agents = (al or {}).get('agents') or []
    agent_id = int(next(a['id'] for a in agents if a.get('id')))
    log('  agentId = %d' % agent_id)
    st, hist = F.http_json('/chat/history?agentId=%d' % agent_id, token=token)
    conv_id = (hist or {}).get('conversationId')
    log('  conversationId = %s（当前 %d 条消息）'
        % (conv_id, len((hist or {}).get('messages') or [])))
    if not conv_id:
        log('  ★ 拿不到 conversationId')
        return 2

    # 先清空，保证 A 段是"0 条"
    r = subprocess.run([NODE_EXE, os.path.join(HERE, 'seed-messages.mjs'),
                        '--conversation', str(conv_id), '--clear'],
                       cwd=REPO, capture_output=True)
    log('  清空会话：%s' % (r.stdout.decode('utf-8', 'replace').strip()
                          or r.stderr.decode('utf-8', 'replace').strip())[:160])

    hwnd = raise_app_window(electron_pids())
    log('  提前台：%s' % hwnd)
    time.sleep(1.5)

    section('4. 测量 A：空会话（0 条消息）')
    c.send('Page.reload')
    time.sleep(8)
    F.wait_until(lambda: ('退出登录' in (c.js('(document.body.innerText||"")') or '')), timeout=60)
    if hwnd:
        raise_app_window(electron_pids())
        time.sleep(1)
    c.js(INSTALL_JS)
    a = measure(c, 'A · 0 条消息')

    section('5. 造数据：往该会话写入 %d 条（服务端 crypto 加密）' % N_MSGS)
    r = subprocess.run([NODE_EXE, os.path.join(HERE, 'seed-messages.mjs'),
                        '--conversation', str(conv_id), '--count', str(N_MSGS)],
                       cwd=REPO, capture_output=True)
    out = r.stdout.decode('utf-8', 'replace').strip()
    err = r.stderr.decode('utf-8', 'replace').strip()
    log('  seed 输出：%s' % (out or '(空)')[:300])
    if err:
        log('  seed stderr：%s' % err[:300])
    if r.returncode != 0:
        log('  ★ 造数据失败')
        return 2
    # 确认库里真有
    st, hist2 = F.http_json('/chat/history?agentId=%d' % agent_id, token=token)
    log('  接口复核：/chat/history 现在返回 %d 条'
        % len((hist2 or {}).get('messages') or []))

    section('6. 测量 B：同一会话 %d 条消息' % N_MSGS)
    c.send('Page.reload')
    time.sleep(10)
    F.wait_until(lambda: ('退出登录' in (c.js('(document.body.innerText||"")') or '')), timeout=60)
    if hwnd:
        raise_app_window(electron_pids())
        time.sleep(1)
    c.js(INSTALL_JS)
    b = measure(c, 'B · %d 条消息' % N_MSGS)

    section('7. 汇总：A（0 条）vs B（%d 条）' % N_MSGS)
    fa, fb = (a.get('frames') or {}), (b.get('frames') or {})
    ta, tb_ = (a.get('typing') or {}), (b.get('typing') or {})
    log('  %-22s %16s %16s' % ('指标', 'A 0 条', 'B %d 条' % N_MSGS))
    for k, lab in [('msgNodes', '.msg 消息节点'), ('domNodes', '全部 DOM 节点'),
                   ('fps', 'fps'), ('p50', '帧 p50 ms'), ('p95', '帧 p95 ms'),
                   ('p99', '帧 p99 ms'), ('max', '帧 max ms'), ('over33', '>33ms 掉帧数'),
                   ('longCount', '长任务个数')]:
        log('  %-22s %16s %16s' % (lab, fa.get(k, '-'), fb.get(k, '-')))
    log('  %-22s %16s %16s' % ('打字 p95 ms', ta.get('p95', '-'), tb_.get('p95', '-')))
    log('  %-22s %16s %16s' % ('打字 max ms', ta.get('max', '-'), tb_.get('max', '-')))
    log('')
    d95 = (fb.get('p95') or 0) - (fa.get('p95') or 0)
    dty = (tb_.get('p95') or 0) - (ta.get('p95') or 0)
    log('  帧 p95 变化：%+.1f ms；打字 p95 变化：%+.1f ms' % (d95, dty))
    if (fb.get('over33') or 0) == 0 and abs(d95) < 2 and abs(dty) < 5:
        log('  ⇒ **200 条历史没有造成可测量的卡顿**（掉帧仍为 0、帧 p95 与打字延迟基本不变）。')
    elif (fb.get('over33') or 0) > 0:
        log('  ⇒ **200 条历史确实带来了掉帧**（>33ms %d 帧）—— 这条路径值得修。'
            % fb.get('over33'))
    else:
        log('  ⇒ 有差异但不大，需要更多轮次确认（见"同一状态至少测 2~3 轮"那条规矩）。')

    with open(os.path.join(OUTDIR, 'history-result.json'), 'w', encoding='utf-8') as fp:
        json.dump({'n': N_MSGS, 'conversationId': conv_id, 'A_empty': a, 'B_full': b},
                  fp, ensure_ascii=False, indent=1)
    with open(os.path.join(OUTDIR, 'history-report.txt'), 'w', encoding='utf-8') as fp:
        fp.write('\n'.join(REPORT))

    section('8. 收尾')
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
