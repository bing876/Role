"""方案 B「暂停/继续」**体验场景**自动演练 + 全程截图。

跟 `pause-resume-tests.py` 的分工：
  * 那一个是**验收**（断言通过/失败、取证）；
  * 这一个是**体验**（把 5 个真实使用场景跑一遍，每一步截图 + 记下聊天说了什么，
    最后产出「发生了什么事」的白话报告，让用户不用动手也能看懂效果）。

五个场景：
  S1 典型：AI 正在搜索并下单 → 暂停 → 我自己跳去了另一个完全无关的网站 → 继续
  S2 验证码：AI 卡在验证码（它本来就不代填敏感框）→ 暂停 → 我自己填验证码并提交 → 继续
  S3 什么都没做：暂停 → 用户啥也没动 → 立刻继续（delta 应为 unchanged）
  S4 长时间暂停：暂停 → 放置 150 秒 → 继续（看有没有超时/页面失效）
  S5 连续暂停继续：短时间内狂点 5 轮 → 看状态会不会乱、按钮会不会卡死

用法：
  python scripts/verify/pause-resume-scenarios.py
环境变量可覆盖端口 / FAKE_DELAY_MS / LONG_PAUSE_SEC。
"""
import importlib.util
import json
import os
import subprocess
import threading
import sys
import time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# ★ 端口一律另起，且必须在 import 之前设好：被复用的验收模块是在 import 时读它们的。
os.environ.setdefault('API_PORT', '8792')
os.environ.setdefault('FAKE_PORT', '8894')
os.environ.setdefault('FAKE2_PORT', '8895')
os.environ.setdefault('FAKE3_PORT', '8896')
os.environ.setdefault('VITE_PORT', '5179')
os.environ.setdefault('CDP_PORT', '9342')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

_spec = importlib.util.spec_from_file_location('prt', os.path.join(HERE, 'pause-resume-tests.py'))
prt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(prt)

OUTDIR = prt.OUTDIR
SHOTDIR = os.path.join(OUTDIR, 'scenarios')
os.makedirs(SHOTDIR, exist_ok=True)
# ★ `llm_calls()` / `req_dumps()` 读的是模块常量 prt.FAKE_LOG（默认 llm.jsonl）。
#   本脚本把模型日志另存到 scen-llm.jsonl，不改这个指向的话会一直读到**上一个脚本的旧日志**，
#   于是「模型调了几次」永远是 0 —— 冒烟时就是这么误判成「AI 没干活」的。
prt.FAKE_LOG = os.path.join(OUTDIR, 'scen-llm.jsonl')
FAKE_LOG = prt.FAKE_LOG

API_PORT = prt.API_PORT
FAKE_PORT = prt.FAKE_PORT
FAKE2_PORT = prt.FAKE2_PORT
VITE_PORT = prt.VITE_PORT
CDP_PORT = prt.CDP_PORT
API = prt.API
FAKE = prt.FAKE
FAKE_LOG = os.path.join(OUTDIR, 'scen-llm.jsonl')
SERVER_LOG = prt.SERVER_LOG.replace('server-%d' % 8791, 'server-%d' % API_PORT)
LONG_PAUSE_SEC = int(os.environ.get('LONG_PAUSE_SEC', '150'))
STEP_MS = int(os.environ.get('FAKE_DELAY_MS', '2600'))

AKEY = '127.0.0.1:%d' % FAKE_PORT          # 主站点（商城 / 验证码页都在这）
BKEY = '127.0.0.1:%d' % FAKE2_PORT         # 「另一个网站」

P = prt.P
ev = prt.ev
eva = prt.eva


def eva_t(expr, timeout=25):
    """带超时的 `eva`。

    为什么必须单独有它：页面弹着 **alert** 的时候，往这张页里执行任何 JS 都会
    **一直阻塞**（Chromium 要等对话框被处理）。`eva` 没有超时，
    一旦撞上就把整个取证脚本挂死 —— s16 第一版就是这么跑了 7 分钟没出来的。
    这里用「线程 + join(超时)」兜住：超时就当它卡住了（本来就是要观测的现象）。
    """
    box = {}

    def run():
        try:
            box['r'] = eva(expr)
        except Exception as e:  # noqa: BLE001
            box['e'] = e

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        raise TimeoutError('等了 %s 秒还没回来（被页面卡住了）' % timeout)
    if 'e' in box:
        raise box['e']
    return box.get('r')
spawn = prt.spawn
wait_until = prt.wait_until
wait_health = prt.wait_health
http_json = prt.http_json
webviews = prt.webviews
guest_cdp = prt.guest_cdp
llm_calls = prt.llm_calls

# ---------------------------------------------------------------- 截图（本机可靠路子）
import ctypes  # noqa: E402

import win32con  # noqa: E402
import win32gui  # noqa: E402
import win32process  # noqa: E402
import win32ui  # noqa: E402
from PIL import Image  # noqa: E402

ctypes.windll.shcore.SetProcessDpiAwareness(2)


def electron_pids():
    pids = set()
    try:
        out = subprocess.check_output(['tasklist', '/FO', 'CSV', '/NH'], stderr=subprocess.DEVNULL)
        for line in out.decode('gbk', errors='replace').splitlines():
            if 'electron.exe' in line.lower():
                parts = [x.strip('"') for x in line.split('","')]
                if len(parts) >= 2 and parts[1].isdigit():
                    pids.add(int(parts[1]))
    except Exception:  # noqa: BLE001
        pass
    return pids


def find_hwnd(debug=False):
    pids = electron_pids()
    best = None      # 按 electron 进程号认（主路径）
    fb = None        # 按窗口标题兜底
    seen = []

    def cb(hwnd, _):
        nonlocal best, fb
        try:
            pid = win32process.GetWindowThreadProcessId(hwnd)[1]
        except Exception:  # noqa: BLE001
            return
        if not win32gui.IsWindowVisible(hwnd):
            return
        l, t, r, b = win32gui.GetWindowRect(hwnd)
        w, h = r - l, b - t
        if w < 600 or h < 400:
            return
        title = win32gui.GetWindowText(hwnd)
        if title.startswith('Developer Tools'):
            return
        if debug:
            seen.append((hwnd, pid, w, h, title[:30]))
        if pid in pids:
            if best is None or (w * h) > (best[1] * best[2]):
                best = (hwnd, w, h)
        elif ('工作台' in title) or ('workbench' in title.lower()):
            # ★ 兜底：electron 进程号这路在本机偶尔会整体失联（整套跑久了出现过
            #   连续 17 张截图「找不到窗口」，而窗口其实一直在屏幕上）。
            #   标题这路不依赖进程号，能把它救回来。
            if fb is None or (w * h) > (fb[1] * fb[2]):
                fb = (hwnd, w, h)

    win32gui.EnumWindows(cb, None)
    if best:
        return best[0]
    if fb:
        print('    (按窗口标题兜底找到窗口)')
        return fb[0]
    if debug:
        print('    (找不到窗口：electron pids=%d，可见大窗口=%d) %s'
              % (len(pids), len(seen), json.dumps(seen[:5], ensure_ascii=False)))
    return None


def shot(name):
    """置顶后从**桌面 DC** BitBlt —— CDP 的 Page.captureScreenshot 在本机会永久挂住。"""
    hwnd = find_hwnd()
    if not hwnd:
        # 全套跑下来偶尔会有一瞬间找不到窗口（窗口刚被别的前台抢过 / 最小化恢复中）。
        # 重试几次再放弃 —— 否则一个场景的所有截图全丢，报告里就只剩文字了。
        for _ in range(3):
            time.sleep(2.0)
            hwnd = find_hwnd()
            if hwnd:
                break
    if not hwnd:
        # 最后一次带上诊断：到底是没有 electron 进程、还是没有可见大窗口
        find_hwnd(debug=True)
        print('    (截图失败：找不到窗口)')
        return None
    try:
        win32gui.SetWindowPos(hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0,
                              win32con.SWP_NOMOVE | win32con.SWP_NOSIZE | win32con.SWP_SHOWWINDOW)
        time.sleep(1.2)
        l, t, r, b = win32gui.GetWindowRect(hwnd)
        w, h = r - l, b - t
        dc = win32gui.GetWindowDC(0)
        mfc = win32ui.CreateDCFromHandle(dc)
        sdc = mfc.CreateCompatibleDC()
        bmp = win32ui.CreateBitmap()
        bmp.CreateCompatibleBitmap(mfc, w, h)
        sdc.SelectObject(bmp)
        sdc.BitBlt((0, 0), (w, h), mfc, (l, t), win32con.SRCCOPY)
        info = bmp.GetInfo()
        img = Image.frombuffer('RGB', (info['bmWidth'], info['bmHeight']),
                               bmp.GetBitmapBits(True), 'raw', 'BGRX', 0, 1).copy()
        win32gui.DeleteObject(bmp.GetHandle())
        sdc.DeleteDC()
        mfc.DeleteDC()
        win32gui.ReleaseDC(hwnd, dc)
        path = os.path.join(SHOTDIR, name + '.png')
        img.save(path)
        return path
    except Exception as e:  # noqa: BLE001
        print('    (截图失败：%s)' % e)
        return None
    finally:
        try:
            win32gui.SetWindowPos(hwnd, win32con.HWND_NOTOPMOST, 0, 0, 0, 0,
                                  win32con.SWP_NOMOVE | win32con.SWP_NOSIZE)
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------- 状态读数
def gjs(key, expr):
    return prt.guest_js(key, expr)


def chat_tail(n=700):
    try:
        t = ev('(() => { const c = document.querySelector(".chat");'
               ' return (c ? c.innerText : document.body.innerText) || ""; })()')
        return (t or '').strip()[-n:]
    except Exception:  # noqa: BLE001
        return ''


def bar_text():
    try:
        return ev('(() => { const b = document.querySelector(".driveBar");'
                  ' return b ? b.innerText : "(无测试条)"; })()')
    except Exception:  # noqa: BLE001
        return ''


def page_view(key):
    try:
        return gjs(key, '({url: location.href, title: document.title,'
                        ' text: (document.body.innerText||"").slice(0,300)})')
    except Exception:  # noqa: BLE001
        return {}


# ★ 当前「用户正在看的那张内嵌页」是哪个 host。
#   s1 里用户跳去了另一个站（8895），之后所有 node() 都必须查 8895 那个 guest，
#   否则会报 `no guest for ...`（查错页面，截图对不上、读数全空）。
CURKEY = AKEY


def node(scen, tag, label):
    """记一个关键节点：截图 + 聊天 + 页面 + 测试条状态。"""
    png = shot('%s-%s' % (scen, tag))
    rec = {
        'label': label,
        'png': os.path.basename(png) if png else None,
        'chat': chat_tail(),
        'bar': bar_text(),
        'page': page_view(CURKEY),
        'at': time.strftime('%H:%M:%S'),
    }
    print('    · 节点[%s] %s' % (tag, label))
    print('      页面: %s' % json.dumps(rec['page'], ensure_ascii=False)[:220])
    print('      测试条: %s' % (rec['bar'] or '').replace('\n', ' | ')[:160])
    return rec


def new_delta_since(offset):
    """从服务端日志里抠出 `delta=` 判定（只取 offset 之后的新内容）。"""
    try:
        with open(SERVER_LOG, 'rb') as f:
            f.seek(offset)
            tail = f.read().decode('utf-8', 'replace')
    except Exception:  # noqa: BLE001
        return None
    import re as _re
    hits = _re.findall(r'delta=(\w+)', tail)
    return hits[-1] if hits else None


def log_offset():
    try:
        return os.path.getsize(SERVER_LOG)
    except Exception:  # noqa: BLE001
        return 0


def shot_node(sid, tag, label):
    """只截图 + 读测试条，**不读内嵌页**（弹窗期间读页面会永久阻塞）。

    页面弹着 alert 时，往这张页里执行任何 JS 都会一直挂着 ——
    不只是 AI 的 read_page，连取证脚本自己的页面读数也一样
    （s16 前两版就是这么把脚本跑挂的：一次 7 分钟、一次被 timeout 300 砍掉）。
    所以弹窗期间的节点只截图（走屏幕像素，不受影响）+ 读测试条（读的是应用 UI，不受影响）。
    """
    p = shot('%s-%s' % (sid, tag))
    return {'label': label,
            'png': os.path.basename(p) if p else None,
            'bar': bar_text(),
            'chat': chat_tail(300),
            'page': {'__error': '（弹窗期间读不到页面：这张页的 JS 被对话框阻塞了）'},
            'at': time.strftime('%H:%M:%S')}


def loop_events_since(offset):
    """抠出**循环层面**的事件（新循环 / 继续 / 挂起 / 恢复），用来判断一件事：

    用户回答之后，AI 是**接回原来那条循环**，还是**重开了一轮**？
    这是第 4 个 bug（ask 被判成终态）最要紧的取证 ——
    日志里出现新的「新循环」= 重开一轮 = 前面走过的历史全丢了。
    """
    try:
        with open(SERVER_LOG, 'rb') as f:
            f.seek(offset)
            tail = f.read().decode('utf-8', 'replace')
    except Exception:  # noqa: BLE001
        return []
    keys = ('新循环', '继续 loop', '已挂起', '已恢复')
    return [ln.strip()[:150] for ln in tail.splitlines() if any(k in ln for k in keys)]


# ---------------------------------------------------------------- 主流程
def start_lane(goal, wc):
    ev('window.workbench.agentStart(%s, %s, %s, %d, {agentId: %d}); "ok"'
       % (json.dumps(goal), json.dumps(API), json.dumps(TOKEN), wc, AGENT_ID))


def wait_steps(goal, n, timeout=90):
    ok, _, _ = wait_until(lambda: len(llm_calls(goal)) >= n, timeout=timeout, interval=0.5)
    return ok


def scenario(scen_id, goal, start_url, user_action, resume_wait=14, extra=None, wait_n=3):
    print('\n' + '#' * 78)
    print('# 场景 %s：%s' % (scen_id, goal))
    print('#' * 78)
    global CURKEY
    CURKEY = AKEY          # 每个场景都从「主站点」这张页起步
    rec = {'id': scen_id, 'goal': goal, 'nodes': [], 'events': []}

    # 干净起步：清掉上一场残留的 lane / 挂起目标
    ev('window.workbench.resetTask(); "ok"')
    time.sleep(1)
    # 把这张页导航回场景起点（模拟「AI 已经在这张页上干活了」的前提）
    gjs(AKEY, 'location.href = %s; "ok"' % json.dumps(start_url))
    time.sleep(3)

    wc = WCS[0]
    rec['nodes'].append(node(scen_id, '0-start', '开跑前：页面已就位'))

    start_lane(goal, wc)
    t0 = time.time()
    # wait_n：等它跑到第几步再按暂停。默认 3（两步之间，最自然的时机）；
    # s15 要用到 5 —— 因为「点搜索」这一步必须**已经落地**（购物车按钮出现）才有得抢。
    ok = wait_steps(goal, wait_n, timeout=90)
    # ★ 等到第 3 步**请求发出**就暂停是不够的：那一刻第 3 个动作可能还在执行途中，
    #   暂停会把动作打断（冒烟时「填搜索词」就是这样被打断的，截图里搜索结果成了「（空）」）。
    #   所以再等 3 秒让这一步**落地**，模拟「AI 两步之间」这个更自然的暂停时机。
    time.sleep(3.0)
    rec['events'].append('AI 跑了 %d 步后我们才暂停（用时 %.1fs，含 3s 让最后一步落地；等到第 %d 步）'
                         % (len(llm_calls(goal)), time.time() - t0, wait_n))
    print('    · AI 已跑 %d 步（%.1fs，等到 3 步=%s）' % (len(llm_calls(goal)), time.time() - t0, ok))
    if not ok:
        rec['events'].append('⚠️ 没等到 3 步，场景数据可能不完整')
        print('    ⚠️ 没等到 3 步')
    rec['nodes'].append(node(scen_id, '1-running', 'AI 正在干活（暂停前）'))

    # ---- 暂停 ----
    off_before = log_offset()
    calls_before = len(llm_calls(goal))
    eva('window.workbench.pauseTask(%d)' % wc)
    time.sleep(2.5)
    rec['nodes'].append(node(scen_id, '2-paused', '点了「暂停」：AI 停手，页面归我'))
    paused_state = prt.task_state(wc)
    rec['paused_phase'] = (paused_state or {}).get('phase')

    # ---- 模拟用户操作 ----
    user_note = user_action()
    rec['user_action'] = user_note
    rec['nodes'].append(node(scen_id, '3-user', '暂停期间：我自己操作了页面'))

    # ---- 继续 ----
    eva('window.workbench.resumeTask(%d)' % wc)
    time.sleep(resume_wait)
    rec['nodes'].append(node(scen_id, '4-resumed', '点了「继续」之后'))

    calls_after = len(llm_calls(goal))
    rec['calls'] = {'before_pause': calls_before, 'after_resume': calls_after}
    rec['delta'] = new_delta_since(off_before)
    rec['chat_after'] = chat_tail(500)
    rec['resumed_phase'] = (prt.task_state(wc) or {}).get('phase')
    if extra:
        rec['extra'] = extra()
    print('    · 模型调用：暂停前 %d → 继续后 %d；服务端判定 delta=%s'
          % (calls_before, calls_after, rec['delta']))
    return rec


def main():
    global TOKEN, AGENT_ID, WCS, CURKEY

    os.makedirs(OUTDIR, exist_ok=True)
    import shutil
    shutil.rmtree(prt.TMP, ignore_errors=True)
    os.makedirs(prt.PROFILE, exist_ok=True)

    VITE_BIN = prt.first_existing(os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                                  os.path.join(prt.DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'))
    START_JS = os.path.join(prt.DESKTOP, 'scripts', 'start-electron.mjs')

    print('=' * 78)
    print('方案 B 体验场景演练（5 个场景，全程截图）')
    print('=' * 78)

    for port in (API_PORT, FAKE_PORT, FAKE2_PORT, VITE_PORT, CDP_PORT):
        if prt.port_busy(port):
            print('❌ 端口 %d 被占，先清干净再跑' % port)
            return 1

    spawn('fake', ['node', os.path.join(HERE, 'fake-llm.mjs')], REPO,
          env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_DELAY_MS': str(STEP_MS),
               'FAKE_STEPS': '30', 'FAKE_LOG': FAKE_LOG, 'FAKE_DUMP': '1'},
          log=os.path.join(OUTDIR, 'scen-fake.log'))
    wait_health(FAKE)
    spawn('site2', ['node', os.path.join(HERE, 'fake-llm.mjs')], REPO,
          env={'FAKE_PORT': str(FAKE2_PORT), 'FAKE_DELAY_MS': '50', 'FAKE_STEPS': '1'},
          log=os.path.join(OUTDIR, 'scen-site2.log'))
    time.sleep(1.5)

    spawn('server', ['node', 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
          env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
               'DEEPSEEK_API_KEY': 'fake-key-scen', 'DEEPSEEK_MODEL': 'fake-scen'},
          log=SERVER_LOG)
    hs = wait_health(API)
    print('  后端: %s' % json.dumps(hs, ensure_ascii=False)[:160])

    spawn('vite', ['node', VITE_BIN, '--port', str(VITE_PORT), '--strictPort'], prt.DESKTOP,
          log=os.path.join(OUTDIR, 'scen-vite.log'))
    time.sleep(4)
    spawn('electron', ['node', 'scripts/start-electron.mjs',
                       '--user-data-dir=%s' % prt.PROFILE,
                       '--remote-debugging-port=%d' % CDP_PORT], prt.DESKTOP,
          env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT},
          log=os.path.join(OUTDIR, 'scen-electron.log'))
    ok, _, ms = wait_until(lambda: bool(P.page('localhost:%d' % VITE_PORT)), timeout=90)
    print('  Electron 窗口出现: %s (%dms)' % (ok, ms))
    if not ok:
        print('❌ Electron 没起来')
        return 1

    # 登录
    import re as _re
    TEST_PHONE = '186%08d' % (int(time.time()) % 100000000)
    http_json('/auth/sms/send', 'POST', body={'phone': TEST_PHONE})
    code = None
    for _ in range(40):
        for m in _re.finditer(r'(\d{6})', prt.server_log()):
            code = m.group(1)
        if code:
            break
        time.sleep(0.5)
    st, sess = http_json('/auth/login/sms', 'POST', body={'phone': TEST_PHONE, 'code': code})
    TOKEN = sess['token']
    st, al = http_json('/agents', token=TOKEN)
    AGENT_ID = int(((al or {}).get('agents') or [{}])[0].get('id') or 1)
    print('  登录成功 agentId=%s' % AGENT_ID)

    c = P.Cdp()
    try:
        c.js("localStorage.setItem('workbench.token', %s);"
             "localStorage.setItem('workbench.apiBase', %s); 'set'"
             % (json.dumps(TOKEN), json.dumps(API)))
        c.send('Page.reload')
    finally:
        try:
            c.ws.close()
        except Exception:  # noqa: BLE001
            pass
    time.sleep(6)
    ok, _, ms = wait_until(
        lambda: ('退出登录' in (ev('(document.body.innerText||"")') or ''))
        and (ev('Boolean(window.workbench && window.workbench.agentStart)') is True), timeout=60)
    print('  进到工作台: %s (%dms)' % (ok, ms))
    if not ok:
        print('❌ 没进到工作台')
        return 1

    ev('window.workbench.openBrowser(%s); "ok"' % json.dumps('%s/shop' % FAKE))
    time.sleep(4)
    ok, _, _ = wait_until(lambda: len([w for w in webviews() if isinstance(w.get('wcId'), int)]) >= 1,
                          timeout=60)
    WCS = [w['wcId'] for w in webviews() if isinstance(w.get('wcId'), int)]
    print('  内嵌页 wcId=%s' % WCS)
    if not WCS:
        print('❌ 没有内嵌页')
        return 1

    # ---- 驱动自检：AI 的「填输入框」这一步到底有没有真的写进去 ----
    # 不加这一段就会踩这个坑：截图里搜索结果写着「搜索「（空）」的结果」，
    # 看上去像演示页面做错了，其实是 driver 的 type 没生效 / 被回退了。先单独验一次。
    print('\n== 驱动自检（单独验一次 type）==')
    gjs(AKEY, 'location.href = %s; "ok"' % json.dumps('%s/shop' % FAKE))
    time.sleep(3)
    _r = eva("window.workbench.drive({action:'type', target:'搜索商品', text:'无线鼠标'}, %d)" % WCS[0])
    print('  drive(type) 返回: %s' % json.dumps(_r, ensure_ascii=False)[:400])
    _v = gjs(AKEY, "(() => { const q = document.getElementById('q1');"
                   " return q ? q.value : '(找不到 q1)'; })()")
    print('  输入框里的值: %r' % _v)
    print('  → %s' % ('✅ type 生效' if _v == '无线鼠标' else '⚠️ type 没写进去，后续截图里搜索关键词会是空的'))

    results = []
    # SCEN_ONLY=s3,s5b 可以只跑部分场景（冒烟用，省时间）
    ONLY = [x.strip() for x in os.environ.get('SCEN_ONLY', '').split(',') if x.strip()]

    def want(sid):
        return (not ONLY) or (sid in ONLY)

    # ---------------------------------------------------------------- s19 专用小工具
    def new_agent(name):
        """用接口建第二个智能体（同账号下），返回它的 id。

        为什么要走接口：界面上「＋ 添加」那条路要过 chips（点/写/跳），跑验收时很脆。
        建出来的智能体**不会自动出现在侧边栏** —— 必须刷新页面（见 reload_ui）。

        ⚠️ `POST /agents` 强制要 `asAgentId`（服务端故意不替你挑身份）；
        只有「母鸡」和自带的「小助」有建智能体的权限，所以拿当前这个智能体当调用者。
        """
        st, r = http_json('/agents', 'POST', token=TOKEN, body={'asAgentId': AGENT_ID})
        aid = ((r or {}).get('agent') or {}).get('id')
        if not aid:
            # 接口形状兜底：再列一次，取不是当前那个的最新一个
            st2, al = http_json('/agents', token=TOKEN)
            ids = [int(a['id']) for a in ((al or {}).get('agents') or [])]
            aid = max([i for i in ids if i != AGENT_ID] or [AGENT_ID])
            print('    · 建智能体返回异常（%s），改用列表兜底' % json.dumps(r, ensure_ascii=False)[:160])
        print('    · 新建智能体 %s → id=%s' % (name, aid))
        return int(aid)

    def reload_ui():
        """刷新宿主页，让新建的智能体出现在侧边栏。

        ★ 必须在**任务开始之前**调用：刷新会把暂停状态清掉，
          放在暂停之后用就等于亲手毁掉要测的东西。
        """
        c = P.Cdp()
        try:
            c.js("localStorage.setItem('workbench.token', %s);"
                 "localStorage.setItem('workbench.apiBase', %s); 'set'"
                 % (json.dumps(TOKEN), json.dumps(API)))
            c.send('Page.reload')
        finally:
            try:
                c.ws.close()
            except Exception:  # noqa: BLE001
                pass
        ok, _, ms = wait_until(
            lambda: ('退出登录' in (ev('(document.body.innerText||"")') or ''))
            and (ev('Boolean(window.workbench && window.workbench.agentStart)') is True), timeout=90)
        time.sleep(3)
        ids = ev("(() => Array.from(document.querySelectorAll('.agentList [data-agent-id]'))"
                 ".map(x => x.getAttribute('data-agent-id')))()")
        # ★ 刷新会把**内嵌页一起收掉**（工作台是单页应用，刷新后浏览器面板回到初始态）。
        #   所以刷新之后必须重新 openBrowser，否则 WCS 是空的、
        #   guest 也找不到（表现为 "no guest for ..." + IndexError）。
        ev('window.workbench.openBrowser(%s); "ok"' % json.dumps('%s/shop' % FAKE))
        time.sleep(4)
        wait_until(lambda: len([w for w in webviews() if isinstance(w.get('wcId'), int)]) >= 1,
                   timeout=60)
        WCS[:] = [w['wcId'] for w in webviews() if isinstance(w.get('wcId'), int)]
        return (ok, None, ms, ids)

    def _click_agent(aid):
        """点侧边栏里的某个智能体。

        ⚠️ aid 必须用 %d 在 **Python 这一侧**插进选择器。上一版写成 JS 里的
           `str(aid)` —— 浏览器里根本没有 str()，点击压根没发生，
           测出来的「没串位」是假证据。
        """
        js = ("(() => { const b = document.querySelector("
              "'.agentList [data-agent-id=\"%d\"]');"
              " if (b) { b.click(); return true; } return false; })()") % int(aid)
        return ev(js)

    # ========== S1 典型：跳去另一个网站 ==========
    def s1_user():
        global CURKEY
        # 模拟「我自己把地址栏改成别的网站并回车」
        gjs(AKEY, 'location.href = %s; "ok"' % json.dumps('http://%s/news' % BKEY))
        time.sleep(3)
        CURKEY = BKEY      # 之后所有节点读数都要看这张新页
        return '把地址栏换成了 %s/news（一个绿皮的「每日新闻」站，和商城毫无关系）' % BKEY

    if want('s1'):
        results.append(scenario('s1', '场景1-搜索下单', '%s/shop' % FAKE, s1_user))

    # ========== S2 验证码 ==========
    def s2_user():
        c = guest_cdp(AKEY)
        if not c:
            return '（拿不到内嵌页，模拟失败）'
        try:
            # 真键盘：聚焦 → Input.insertText（走真实输入通道，不是 JS 改 value）
            c.js("(() => { const el = document.getElementById('otp1');"
                 " if (el) { el.focus(); el.scrollIntoView({block:'center'}); }"
                 " const r = el.getBoundingClientRect();"
                 " return {x: r.x + r.width/2, y: r.y + r.height/2}; })()")
            c.send('Input.insertText', text='123456')
            time.sleep(0.6)
            pos = c.js("(() => { const b = document.getElementById('submit1');"
                       " if (!b) return null; const r = b.getBoundingClientRect();"
                       " return {x: r.x + r.width/2, y: r.y + r.height/2}; })()")
            if pos:
                for kind in ('mousePressed', 'mouseReleased'):
                    c.send('Input.dispatchMouseEvent', type=kind, x=pos['x'], y=pos['y'],
                           button='left', clickCount=1)
            time.sleep(2.5)
            msg = c.js("(() => { const m = document.getElementById('msg');"
                       " const b = document.getElementById('box');"
                       " return {msg: m ? m.textContent : '(已换成通过页)',"
                       " box: b ? b.innerText.slice(0,120) : '', title: document.title}; })()")
            return '自己填了验证码 123456 并点了「提交验证」→ 页面变成：%s' % json.dumps(
                msg, ensure_ascii=False)
        finally:
            try:
                c.ws.close()
            except Exception:  # noqa: BLE001
                pass

    if want('s2'):
        results.append(scenario('s2', '场景2-登录验证', '%s/captcha' % FAKE, s2_user))

    # ========== S3 什么都没做 ==========
    def s3_user():
        time.sleep(3)
        return '暂停后我什么都不做，等 3 秒就直接点「继续」'

    if want('s3'):
        results.append(scenario('s3', '场景3-搜索下单', '%s/shop' % FAKE, s3_user, resume_wait=12))

    # ========== S4 长时间暂停 ==========
    def s4_user():
        print('    · 放置 %d 秒（模拟"我去泡了杯咖啡"）…' % LONG_PAUSE_SEC)
        half = max(1, LONG_PAUSE_SEC // 60)
        for i in range(half):
            time.sleep(30)
            print('      …已放置 %ds' % ((i + 1) * 30))
            if i == 0:
                # 中途抓一张：证明「这段时间里界面就一直停在这儿，没有任何偷偷的动作」
                p = shot('s4-3b-waiting')
                print('      · 中途截图 %s' % (os.path.basename(p) if p else '(失败)'))
        for i in range(half):
            time.sleep(30)
            print('      …已放置 %ds' % ((half + i + 1) * 30))
        return '暂停后放置了 %d 秒（约 %.1f 分钟）没碰它，然后才点「继续」' % (
            LONG_PAUSE_SEC, LONG_PAUSE_SEC / 60.0)

    if want('s4'):
        results.append(scenario('s4', '场景4-搜索下单', '%s/shop' % FAKE, s4_user))

    # ========== S5 连续暂停/继续：短时间内狂点 5 轮 ==========
    # 这个场景的重点不是「用户操作了什么」，而是「按钮会不会被点坏、状态会不会串」，
    # 所以它不走 scenario() 那条「暂停→操作→继续」的通用流程，单独写。
    if want('s5'):
        print('\n' + '#' * 78)
        print('# 场景 s5：短时间内连续点 5 轮「暂停 / 继续」（看会不会点乱、点卡死）')
        print('#' * 78)
        CURKEY = AKEY
        ev('window.workbench.resetTask(); "ok"')
        time.sleep(1)
        gjs(AKEY, 'location.href = %s; "ok"' % json.dumps('%s/shop' % FAKE))
        time.sleep(3)
        rec5 = {'id': 's5', 'goal': '场景5-连续狂点暂停/继续 5 轮', 'nodes': [], 'events': []}
        rec5['nodes'].append(node('s5', '0-start', '开跑前：页面已就位'))
        GOAL5 = '场景5-搜索下单'
        start_lane(GOAL5, WCS[0])
        wait_steps(GOAL5, 3, timeout=90)
        time.sleep(3.0)
        rec5['nodes'].append(node('s5', '1-running', 'AI 正在干活（开始狂点之前）'))
        wc = WCS[0]
        spam = {'rounds': [], 'before': (prt.task_state(wc) or {}).get('phase')}
        for i in range(5):
            eva('window.workbench.pauseTask(%d)' % wc)
            time.sleep(0.4)
            p1 = (prt.task_state(wc) or {}).get('phase')
            b1 = bar_text()
            eva('window.workbench.resumeTask(%d)' % wc)
            time.sleep(0.4)
            p2 = (prt.task_state(wc) or {}).get('phase')
            b2 = bar_text()
            spam['rounds'].append({'round': i + 1, 'after_pause': p1, 'after_resume': p2,
                                   'bar_paused': (b1 or '').replace('\n', ' | ')[:120],
                                   'bar_resumed': (b2 or '').replace('\n', ' | ')[:120]})
            print('    第 %d 轮：暂停后=%s  继续后=%s' % (i + 1, p1, p2))
        rec5['nodes'].append(node('s5', '2-spammed', '5 轮狂点刚结束的瞬间'))
        time.sleep(10)
        spam['after_settle'] = (prt.task_state(wc) or {}).get('phase')
        spam['calls_after'] = len(llm_calls(GOAL5))
        rec5['nodes'].append(node('s5', '3-settled', '狂点完静置 10 秒之后'))
        rec5['events'] = ['连续 5 轮：%s' % json.dumps(spam['rounds'], ensure_ascii=False),
                          '狂点前状态=%s，静置后=%s，模型调用累计=%d'
                          % (spam['before'], spam['after_settle'], spam['calls_after'])]
        rec5['calls'] = {'before_pause': 0, 'after_resume': spam['calls_after']}
        rec5['delta'] = None
        rec5['chat_after'] = chat_tail(500)
        rec5['final_state'] = prt.task_state(wc)
        print('    狂点后稳定态=%s，模型调用累计=%d' % (spam['after_settle'], spam['calls_after']))
        results.append(rec5)

    # ==========================================================================
    # 下面三个是**边界 / 极端**场景（工作方式第 1 条：自己想边界，自己找 bug）
    #   s6 暂停期间我把 AI 已经填好的内容改了 → 看它会不会「重做我已经做过的部分」
    #   s7 暂停期间我把页面导去一个打不开的地址 → 看它会不会卡死 / 报错 / 崩
    #   s8 AI 正停下来问我，这时候我又点暂停、又连点继续 → 看状态叠加会不会点坏
    # ==========================================================================

    # ========== S6 用户改了 AI 已经填好的内容 ==========
    def s6_user():
        c = guest_cdp(AKEY)
        if not c:
            return '（拿不到内嵌页，模拟失败）'
        try:
            before = c.js("(() => { const el = document.getElementById('q1');"
                          " if (!el) return '(无 q1)'; el.focus();"
                          " el.scrollIntoView({block:'center'});"
                          " el.setSelectionRange(0, el.value.length);"
                          " return el.value; })()")
            time.sleep(0.3)
            c.send('Input.insertText', text='机械键盘')
            time.sleep(1.0)
            after = c.js("(() => { const el = document.getElementById('q1');"
                         " return el ? el.value : '(无 q1)'; })()")
            return ('把 AI 刚才填进去的搜索词（%r）**整段改掉**，改成「机械键盘」——'
                    '改完输入框里是 %r。这正好戳「不重做用户已经手动完成的部分」这条规矩。'
                    % (before, after))
        finally:
            try:
                c.ws.close()
            except Exception:  # noqa: BLE001
                pass

    if want('s6'):
        r6 = scenario('s6', '场景6-搜索下单', '%s/shop' % FAKE, s6_user, resume_wait=12)
        # 硬取证：继续之后输入框里到底是谁的值？被覆盖成「无线鼠标」就是 bug。
        v6 = gjs(AKEY, "(() => { const el = document.getElementById('q1');"
                       " return el ? el.value : '(无 q1)'; })()")
        r6['events'].append(
            '★ 继续之后输入框里的值 = %r —— 如果是「无线鼠标」说明 AI 把我改的内容覆盖回去了'
            '（= 重做了我已经做过的部分），是 bug；如果还是「机械键盘」就是对的' % v6)
        print('    · 继续之后输入框 = %r' % v6)
        results.append(r6)

    # ========== S7 暂停期间我把页面导去一个打不开的地址 ==========
    def s7_user():
        global CURKEY
        # 一个**真会 404** 的地址（fake 服务对未知路径返回 not found），等价于
        # 「我在地址栏敲了个不存在的网址 / 页面挂了」。
        gjs(AKEY, 'location.href = %s; "ok"' % json.dumps('http://%s/dead-end' % BKEY))
        time.sleep(3)
        CURKEY = BKEY
        return '把地址栏改成了一个**打不开的地址**（%s/dead-end，服务端返回 404），' \
               '模拟「我自己敲错网址 / 页面挂了」' % BKEY

    if want('s7'):
        r7 = scenario('s7', '场景7-搜索下单', '%s/shop' % FAKE, s7_user, resume_wait=14)
        r7['events'].append('★ 关注点：恢复后不能卡死、不能永久 failed、不能抛异常')
        results.append(r7)

    # ========== S8 AI 停下来问我时，我又点「暂停」，然后又连点「继续」 ==========
    if want('s8'):
        print('\n' + '#' * 78)
        print('# 场景 s8：AI 正停下来等我回答，这时候我又点暂停、又连点继续')
        print('#' * 78)
        CURKEY = AKEY
        ev('window.workbench.resetTask(); "ok"')
        time.sleep(1)
        gjs(AKEY, 'location.href = %s; "ok"' % json.dumps('%s/shop' % FAKE))
        time.sleep(3)
        rec8 = {'id': 's8', 'goal': '场景8-「等你回答」状态下再叠加暂停/继续',
                'nodes': [], 'events': []}
        rec8['nodes'].append(node('s8', '0-start', '开跑前：页面已就位'))
        GOAL8 = '场景8-搜索下单'
        start_lane(GOAL8, WCS[0])
        wait_steps(GOAL8, 3, timeout=90)
        time.sleep(3.0)
        rec8['nodes'].append(node('s8', '1-running', 'AI 正在干活（暂停前）'))
        wc = WCS[0]

        eva('window.workbench.pauseTask(%d)' % wc)
        time.sleep(2.5)
        # 跳站 → 触发「AI 停下来问用户」这个状态
        gjs(AKEY, 'location.href = %s; "ok"' % json.dumps('http://%s/news' % BKEY))
        time.sleep(3)
        CURKEY = BKEY
        rec8['nodes'].append(node('s8', '2-user', '暂停期间：我跳去了另一个网站'))

        off8 = log_offset()
        calls8 = len(llm_calls(GOAL8))
        eva('window.workbench.resumeTask(%d)' % wc)
        time.sleep(12)
        st1 = prt.task_state(wc) or {}
        rec8['nodes'].append(node('s8', '3-asked', 'AI 停下来问我了（状态：%s）' % st1.get('phase')))
        rec8['events'].append('第一次「继续」后：状态=%s，delta=%s，模型调用 %d→%d'
                              % (st1.get('phase'), new_delta_since(off8),
                                 calls8, len(llm_calls(GOAL8))))

        # 在「等你回答」的状态上再叠一次暂停
        eva('window.workbench.pauseTask(%d)' % wc)
        time.sleep(2.5)
        st2 = prt.task_state(wc) or {}
        rec8['nodes'].append(node('s8', '4-paused-again',
                                  'AI 正等着我回答，我又点了「暂停」（状态：%s）' % st2.get('phase')))

        # 再继续，而且手抖多点了一下
        eva('window.workbench.resumeTask(%d)' % wc)
        time.sleep(0.3)
        eva('window.workbench.resumeTask(%d)' % wc)
        time.sleep(12)
        st3 = prt.task_state(wc) or {}
        rec8['nodes'].append(node('s8', '5-resumed-again',
                                  '再点「继续」，还顺手多点了一下（状态：%s）' % st3.get('phase')))

        phases = [st1.get('phase'), st2.get('phase'), st3.get('phase')]
        rec8['events'].append('三次状态读数：%s —— 出现 failed 就是被点坏了' % json.dumps(phases))
        rec8['events'].append('★ 关注点：状态不能串、不能 failed、连点那一下不能被当成两次推进')
        rec8['calls'] = {'before_pause': calls8, 'after_resume': len(llm_calls(GOAL8))}
        rec8['delta'] = new_delta_since(off8)
        rec8['chat_after'] = chat_tail(500)
        rec8['paused_phase'] = st2.get('phase')
        rec8['resumed_phase'] = st3.get('phase')
        rec8['final_state'] = st3
        print('    · 三次状态：%s ｜ 模型调用 %d→%d'
              % (phases, calls8, len(llm_calls(GOAL8))))
        results.append(rec8)

    # ========== S9 AI 停下来问我，我回答之后，它能不能接回原来那条循环 ==========
    # 这是第 4 个 bug 的**核心承诺**的验证：以前 ask 会把循环判成终态，
    # 用户回答之后只能「新建一轮」，前面走过的步全丢。现在必须证明它是接回去的。
    if want('s9'):
        print('\n' + '#' * 78)
        print('# 场景 s9：AI 停下来问我，我回答之后 —— 它是接回去，还是重开一轮？')
        print('#' * 78)
        CURKEY = AKEY
        ev('window.workbench.resetTask(); "ok"')
        time.sleep(1)
        gjs(AKEY, 'location.href = %s; "ok"' % json.dumps('%s/shop' % FAKE))
        time.sleep(3)
        rec9 = {'id': 's9', 'goal': '场景9-回答之后能不能接回原循环', 'nodes': [], 'events': []}
        rec9['nodes'].append(node('s9', '0-start', '开跑前：页面已就位'))
        GOAL9 = '场景9-搜索下单'
        start_lane(GOAL9, WCS[0])
        wait_steps(GOAL9, 3, timeout=90)
        time.sleep(3.0)
        rec9['nodes'].append(node('s9', '1-running', 'AI 正在干活（暂停前）'))
        wc = WCS[0]

        off9 = log_offset()          # ★ 从这一刻开始统计循环事件（初始那条循环已建好）
        eva('window.workbench.pauseTask(%d)' % wc)
        time.sleep(2.5)
        gjs(AKEY, 'location.href = %s; "ok"' % json.dumps('http://%s/news' % BKEY))
        time.sleep(3)
        CURKEY = BKEY
        rec9['nodes'].append(node('s9', '2-user', '暂停期间：我跳去了另一个网站'))

        eva('window.workbench.resumeTask(%d)' % wc)
        time.sleep(12)
        st1 = prt.task_state(wc) or {}
        rec9['nodes'].append(node('s9', '3-asked', 'AI 停下来问我了（状态：%s）' % st1.get('phase')))

        # ---- 我「回答」它：自己把页面弄回商城（等于回答「回到原来的任务」）----
        gjs(BKEY, 'location.href = %s; "ok"' % json.dumps('%s/shop' % FAKE))
        time.sleep(3.5)
        CURKEY = AKEY
        rec9['nodes'].append(node('s9', '4-answered', '我回答了：自己把页面弄回商城'))

        eva('window.workbench.resumeTask(%d)' % wc)
        time.sleep(18)
        st2 = prt.task_state(wc) or {}
        rec9['nodes'].append(node('s9', '5-resumed', '再点「继续」（状态：%s）' % st2.get('phase')))

        evs = loop_events_since(off9)
        reborn = [e for e in evs if '新循环' in e]
        rec9['events'].append('循环层面事件（按时间）：')
        for e in evs:
            rec9['events'].append('    ' + e)
        rec9['events'].append(
            '★ 判定：期间「新循环」出现 %d 次 —— 0 次 = 接回了原来那条循环（对）；'
            '≥1 次 = 重开了一轮，前面走过的历史全丢（bug）' % len(reborn))
        rec9['calls'] = {'before_pause': 0, 'after_resume': len(llm_calls(GOAL9))}
        rec9['delta'] = new_delta_since(off9)
        rec9['chat_after'] = chat_tail(700)
        rec9['paused_phase'] = st1.get('phase')
        rec9['resumed_phase'] = st2.get('phase')
        rec9['final_state'] = st2
        print('    · 期间新循环 %d 次 ｜ 状态 %s → %s ｜ 模型调用累计 %d'
              % (len(reborn), st1.get('phase'), st2.get('phase'), len(llm_calls(GOAL9))))
        for e in evs:
            print('      %s' % e)
        results.append(rec9)

    # ========== S10 暂停打在「动作执行到一半」的瞬间 ==========
    # 前面所有场景都是「等这一步落地了再暂停」（故意等 3 秒），那是**最温柔**的时机。
    # 真实用户不会挑时机 —— 很可能就在 AI 打字的那一瞬间按下去。
    # 要看的是：会不会留下半截内容？状态会不会坏？继续之后能不能自愈？
    if want('s10'):
        print('\n' + '#' * 78)
        print('# 场景 s10：不等它落地，就在 AI 打字的那一瞬间按「暂停」')
        print('#' * 78)
        CURKEY = AKEY
        ev('window.workbench.resetTask(); "ok"')
        time.sleep(1)
        gjs(AKEY, 'location.href = %s; "ok"' % json.dumps('%s/shop' % FAKE))
        time.sleep(3)
        rec10 = {'id': 's10', 'goal': '场景10-动作执行途中被暂停', 'nodes': [], 'events': []}
        rec10['nodes'].append(node('s10', '0-start', '开跑前：页面已就位'))
        GOAL10 = '场景10-搜索下单'
        start_lane(GOAL10, WCS[0])
        # 等第 3 步（填搜索词）**刚发出**就暂停 —— 不等它落地
        wait_steps(GOAL10, 3, timeout=90)
        time.sleep(1.0)          # ★ 故意只等 1 秒：type 这一步大约要 2.6s，必然打在半途
        rec10['nodes'].append(node('s10', '1-running', 'AI 正在打字（此时按下暂停）'))
        wc = WCS[0]
        eva('window.workbench.pauseTask(%d)' % wc)
        time.sleep(3.0)
        v_mid = gjs(AKEY, "(() => { const el = document.getElementById('q1');"
                          " return el ? el.value : '(无 q1)'; })()")
        st1 = prt.task_state(wc) or {}
        rec10['nodes'].append(node('s10', '2-paused', '暂停瞬间（输入框里：%r）' % v_mid))
        rec10['events'].append('★ 打断瞬间输入框里的内容 = %r（完整应为空或「无线鼠标」，'
                               '半截就说明动作被打断在半路）' % v_mid)
        time.sleep(3)
        off10 = log_offset()
        eva('window.workbench.resumeTask(%d)' % wc)
        time.sleep(16)
        v_end = gjs(AKEY, "(() => { const el = document.getElementById('q1');"
                          " return el ? el.value : '(无 q1)'; })()")
        st2 = prt.task_state(wc) or {}
        rec10['nodes'].append(node('s10', '3-resumed', '继续之后（输入框里：%r）' % v_end))
        rec10['events'].append('继续之后输入框 = %r，状态 %s → %s，delta=%s'
                               % (v_end, st1.get('phase'), st2.get('phase'), new_delta_since(off10)))
        rec10['events'].append('★ 关注点：不能卡死、不能 failed；半截内容要么被补完，'
                               '要么 AI 重新读页面后自己发现')
        rec10['calls'] = {'before_pause': 0, 'after_resume': len(llm_calls(GOAL10))}
        rec10['delta'] = new_delta_since(off10)
        rec10['chat_after'] = chat_tail(700)
        rec10['paused_phase'] = st1.get('phase')
        rec10['resumed_phase'] = st2.get('phase')
        rec10['final_state'] = st2
        print('    · 打断瞬间=%r → 继续后=%r ｜ 状态 %s → %s'
              % (v_mid, v_end, st1.get('phase'), st2.get('phase')))
        results.append(rec10)

    # ========== S11 任务已经跑完了，我又点了一下「继续」 ==========
    # 典型的「点在不该点的状态上」：看到「已完成」还手贱点一下继续，或者 AI 说做完了
    # 但你觉得没做完、想让它再接着干。这种误操作最容易把状态机打崩。
    if want('s11'):
        print('\n' + '#' * 78)
        print('# 场景 s11：任务已经跑完了，我又点了一下「继续」')
        print('#' * 78)
        CURKEY = AKEY
        ev('window.workbench.resetTask(); "ok"')
        time.sleep(1)
        gjs(AKEY, 'location.href = %s; "ok"' % json.dumps('%s/shop' % FAKE))
        time.sleep(3)
        rec11 = {'id': 's11', 'goal': '场景11-已完成状态下再点继续', 'nodes': [], 'events': []}
        rec11['nodes'].append(node('s11', '0-start', '开跑前：页面已就位'))
        GOAL11 = '场景11-搜索下单'
        start_lane(GOAL11, WCS[0])
        wc = WCS[0]
        # 一直等到它自己跑完（终态 done），最多等 90 秒
        done_phase = None
        for _ in range(90):
            st = prt.task_state(wc) or {}
            if st.get('phase') in ('done', 'failed', 'stopped'):
                done_phase = st.get('phase')
                break
            time.sleep(1.0)
        st1 = prt.task_state(wc) or {}
        rec11['nodes'].append(node('s11', '1-done', '任务跑完了（状态：%s）' % st1.get('phase')))
        rec11['events'].append('等到了终态：%s（模型调用 %d 次）'
                               % (done_phase or '(超时没跑完)', len(llm_calls(GOAL11))))

        off11 = log_offset()
        eva('window.workbench.resumeTask(%d)' % wc)
        time.sleep(14)
        st2 = prt.task_state(wc) or {}
        rec11['nodes'].append(node('s11', '2-resumed', '在「已完成」上又点了「继续」（状态：%s）'
                                   % st2.get('phase')))
        evs = loop_events_since(off11)
        rec11['events'].append('点完之后服务端循环事件：%s'
                               % (json.dumps(evs, ensure_ascii=False) if evs else '（无，说明压根没打到服务端）'))
        bad = st2.get('phase') in ('failed',)
        rec11['events'].append(
            '★ 判定：继续后状态=%s —— %s'
            % (st2.get('phase'),
               '❌ 被点成了失败/损坏' if bad else '✅ 没有崩（保持原状或优雅提示都算对）'))
        rec11['calls'] = {'before_pause': 0, 'after_resume': len(llm_calls(GOAL11))}
        rec11['delta'] = new_delta_since(off11)
        rec11['chat_after'] = chat_tail(700)
        rec11['paused_phase'] = st1.get('phase')
        rec11['resumed_phase'] = st2.get('phase')
        rec11['final_state'] = st2
        print('    · 已完成=%s → 点继续后=%s ｜ 循环事件 %d 条'
              % (st1.get('phase'), st2.get('phase'), len(evs)))
        for e in evs:
            print('      %s' % e)
        results.append(rec11)

    # ========== S12 暂停之后把应用整个关掉，再重新打开 ==========
    # 真实用户很可能这么干：「我先暂停、关掉，明天再接着弄」。
    # 要看的是：重开之后它记不记得自己停在「已暂停」？点「继续」还管用吗？
    # 会不会卡在一个「半死不活」的状态上（既不算暂停、也不算在跑）？
    if want('s12'):
        print('\n' + '#' * 78)
        print('# 场景 s12：暂停之后把应用整个关掉，再重新打开')
        print('#' * 78)
        CURKEY = AKEY
        ev('window.workbench.resetTask(); "ok"')
        time.sleep(1)
        gjs(AKEY, 'location.href = %s; "ok"' % json.dumps('%s/shop' % FAKE))
        time.sleep(3)
        rec12 = {'id': 's12', 'goal': '场景12-暂停后重启应用', 'nodes': [], 'events': []}
        rec12['nodes'].append(node('s12', '0-start', '开跑前：页面已就位'))
        GOAL12 = '场景12-搜索下单'
        start_lane(GOAL12, WCS[0])
        wait_steps(GOAL12, 3, timeout=90)
        time.sleep(3.0)
        rec12['nodes'].append(node('s12', '1-running', 'AI 正在干活（暂停前）'))
        wc0 = WCS[0]

        eva('window.workbench.pauseTask(%d)' % wc0)
        time.sleep(3.0)
        st_before = prt.task_state(wc0) or {}
        rec12['nodes'].append(node('s12', '2-paused', '已暂停（状态：%s）' % st_before.get('phase')))
        rec12['events'].append('关应用之前的状态：%s ｜ 模型调用 %d 次'
                               % (st_before.get('phase'), len(llm_calls(GOAL12))))

        # ---- 关掉应用 ----
        killed = 0
        for pid in sorted(electron_pids()):
            try:
                subprocess.run(['taskkill', '/F', '/T', '/PID', str(pid)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
                killed += 1
            except Exception:  # noqa: BLE001
                pass
        time.sleep(4)
        rec12['events'].append('已杀掉 %d 个 electron 进程（模拟用户关掉应用）' % killed)
        print('    · 已关掉应用（%d 个进程）' % killed)

        # ---- 重新打开 ----
        spawn('electron-restart', ['node', START_JS,
                                   '--user-data-dir=%s' % prt.PROFILE,
                                   '--remote-debugging-port=%d' % CDP_PORT], prt.DESKTOP,
              env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT},
              log=os.path.join(OUTDIR, 'scen-electron-restart.log'))
        ok, _, ms = wait_until(lambda: bool(P.page('localhost:%d' % VITE_PORT)), timeout=120)
        print('    · 重开后窗口出现：%s（%dms）' % (ok, ms))
        rec12['events'].append('重新打开应用：窗口出现=%s（%dms）' % (ok, ms))
        if not ok:
            rec12['events'].append('❌ 应用没起来，这一场的后半段没有数据')
            results.append(rec12)
        else:
            # 等 UI 就绪（登录态在 user-data-dir 里，应该还在）
            ok2, _, ms2 = wait_until(
                lambda: ('退出登录' in (ev('(document.body.innerText||"")') or ''))
                and (ev('Boolean(window.workbench && window.workbench.agentStart)') is True),
                timeout=90)
            rec12['events'].append('UI 就绪（登录态还在=%s，%dms）' % (ok2, ms2))
            time.sleep(3)
            # ★ 重启后**必须重新把浏览器打开**：重开的应用里一个 webview 都没有
            #   （实测 wcId=[]）。不补这一步的话，后面所有场景都会报
            #   「no guest for ...」，页面根本加载不到 —— 连跑 13 场时 s13 就是这样
            #   被 s12 带坏、整场数据作废的。
            ev('window.workbench.openBrowser(%s); "ok"' % json.dumps('%s/shop' % FAKE))
            time.sleep(4)
            ok3, _, _ = wait_until(
                lambda: len([w for w in webviews() if isinstance(w.get('wcId'), int)]) >= 1, timeout=60)
            wcs2 = [w['wcId'] for w in webviews() if isinstance(w.get('wcId'), int)]
            rec12['events'].append('重开后内嵌页 wcId=%s（之前是 %s）' % (wcs2, [wc0]))
            wc2 = wcs2[0] if wcs2 else wc0
            st_after = prt.task_state(wc2) or {}
            rec12['nodes'].append(node('s12', '3-reopened',
                                       '重新打开应用（状态：%s）' % st_after.get('phase')))
            rec12['events'].append('★ 重开之后状态=%s（关之前是 %s）—— 如果变成「空闲/没有任务」，'
                                   '就说明**暂停状态没跟着应用重启活下来**'
                                   % (st_after.get('phase'), st_before.get('phase')))

            off12 = log_offset()
            eva('window.workbench.resumeTask(%d)' % wc2)
            time.sleep(14)
            st_res = prt.task_state(wc2) or {}
            rec12['nodes'].append(node('s12', '4-resumed',
                                       '重开后点了「继续」（状态：%s）' % st_res.get('phase')))
            evs = loop_events_since(off12)
            rec12['events'].append('点「继续」之后的服务端循环事件：%s'
                                   % (json.dumps(evs, ensure_ascii=False) if evs else '（无）'))
            rec12['events'].append('★ 判定：重开后点继续=%s —— %s'
                                   % (st_res.get('phase'),
                                      '❌ 卡住/失败' if st_res.get('phase') == 'failed'
                                      else '✅ 没有崩'))
            rec12['calls'] = {'before_pause': 0, 'after_resume': len(llm_calls(GOAL12))}
            rec12['delta'] = new_delta_since(off12)
            rec12['chat_after'] = chat_tail(700)
            rec12['paused_phase'] = st_before.get('phase')
            rec12['resumed_phase'] = st_res.get('phase')
            rec12['final_state'] = st_res
            print('    · 关之前=%s → 重开后=%s → 点继续后=%s'
                  % (st_before.get('phase'), st_after.get('phase'), st_res.get('phase')))
        results.append(rec12)

    # ========== S13 真正的「人工介入」：AI 因验证码自己停下 → 我填 → 点继续 ==========
    # 场景 2 是「我先暂停、再填验证码」，走的是**暂停路径**。
    # 但现实里最该走通的是这条：AI 自己撞上敏感字段（验证码）停下来问你，
    # 你压根不用按暂停，自己填完、点「继续」—— 走的是 **waiting 路径**。
    # 第 4、5 个 bug 全在这条路上，它不通，前面修的就白修了。
    if want('s13'):
        print('\n' + '#' * 78)
        print('# 场景 s13：AI 撞上验证码自己停下来问，我自己填完，再点继续')
        print('#' * 78)
        CURKEY = AKEY
        ev('window.workbench.resetTask(); "ok"')
        time.sleep(1)
        gjs(AKEY, 'location.href = %s; "ok"' % json.dumps('%s/captcha' % FAKE))
        time.sleep(3)
        rec13 = {'id': 's13', 'goal': '场景13-登录验证', 'nodes': [], 'events': []}
        rec13['nodes'].append(node('s13', '0-start', '开跑前：页面已就位'))
        GOAL13 = '场景13-登录验证'
        start_lane(GOAL13, WCS[0])
        wc = WCS[0]

        # 等它自己停下来问（不点暂停）：看聊天里出现「验证码/帮你/需要你」之类
        asked = False
        for _ in range(60):
            st = prt.task_state(wc) or {}
            c = chat_tail(400)
            if st.get('phase') in ('paused', 'idle') or ('验证码' in c and ('填' in c or '输' in c or '需要' in c)):
                asked = True
                break
            time.sleep(1.0)
        st1 = prt.task_state(wc) or {}
        rec13['nodes'].append(node('s13', '1-asked', 'AI 自己停下来了（状态：%s）' % st1.get('phase')))
        rec13['events'].append('AI 自己停下来问（没点暂停）：%s ｜ 状态=%s ｜ 模型调用 %d 次'
                               % (asked, st1.get('phase'), len(llm_calls(GOAL13))))

        off13 = log_offset()
        # ---- 我自己把验证码填了并提交 ----
        note = None
        c = guest_cdp(AKEY)
        if c:
            try:
                c.js("(() => { const el = document.getElementById('otp1');"
                     " if (el) { el.focus(); el.scrollIntoView({block:'center'}); }"
                     " const r = el.getBoundingClientRect();"
                     " return {x: r.x + r.width/2, y: r.y + r.height/2}; })()")
                c.send('Input.insertText', text='123456')
                time.sleep(0.6)
                pos = c.js("(() => { const b = document.getElementById('submit1');"
                           " if (!b) return null; const r = b.getBoundingClientRect();"
                           " return {x: r.x + r.width/2, y: r.y + r.height/2}; })()")
                if pos:
                    for kind in ('mousePressed', 'mouseReleased'):
                        c.send('Input.dispatchMouseEvent', type=kind, x=pos['x'], y=pos['y'],
                               button='left', clickCount=1)
                time.sleep(2.5)
                msg = c.js("(() => { const b = document.getElementById('box');"
                           " return {box: b ? b.innerText.slice(0,120) : '', title: document.title}; })()")
                note = '自己填了验证码 123456 并点「提交验证」→ %s' % json.dumps(msg, ensure_ascii=False)
            finally:
                try:
                    c.ws.close()
                except Exception:  # noqa: BLE001
                    pass
        rec13['user_action'] = note or '（填验证码失败）'
        rec13['nodes'].append(node('s13', '2-filled', '我自己填完验证码并提交'))

        # ---- 点继续（走 waiting 路径）----
        eva('window.workbench.resumeTask(%d)' % wc)
        time.sleep(16)
        st2 = prt.task_state(wc) or {}
        rec13['nodes'].append(node('s13', '3-resumed', '点「继续」之后（状态：%s）' % st2.get('phase')))
        evs = loop_events_since(off13)
        reborn = [e for e in evs if '新循环' in e]
        rec13['events'].append('循环事件：')
        for e in evs:
            rec13['events'].append('    ' + e)
        rec13['events'].append('★ 判定①：期间「新循环」%d 次 —— 0 次才是接回原循环（不是重开一轮）'
                               % len(reborn))
        rec13['events'].append('★ 判定②：有没有「已恢复（delta=...）」—— 有才是真的重新感知了')
        rec13['calls'] = {'before_pause': 0, 'after_resume': len(llm_calls(GOAL13))}
        rec13['delta'] = new_delta_since(off13)
        rec13['chat_after'] = chat_tail(700)
        rec13['paused_phase'] = st1.get('phase')
        rec13['resumed_phase'] = st2.get('phase')
        rec13['final_state'] = st2
        print('    · AI 自停=%s → 填完继续后=%s ｜ 新循环 %d 次 ｜ delta=%s'
              % (st1.get('phase'), st2.get('phase'), len(reborn), rec13['delta']))
        for e in evs:
            print('      %s' % e)
        results.append(rec13)

    # ========== S14 页面自己会动（轮播 / 实时刷新），用户什么都没碰 ==========
    # 第 8 个 bug 修的是「AI 自己造成的变化被算到用户头上」。
    # 这一场是**同一类但没修到**的情况：**页面自己**在动（轮播广告、实时库存、倒计时），
    # 用户一根手指都没碰，delta 一样会判成 edited。真实网页里这种东西到处都是。
    if want('s14'):
        def s14_user():
            time.sleep(12)      # 让页面自己刷新 8 轮
            return ('我一根手指都没碰，就干等着 —— 但这张页上有个**轮播广告**和一块'
                    '**实时库存**，每 1.5 秒自己变一次（真实网页里到处都是这种东西：'
                    '轮播图、实时行情、倒计时、自动刷新）')

        r14 = scenario('s14', '场景14-自动刷新', '%s/auto' % FAKE, s14_user, resume_wait=14)
        r14['events'].append('★ 关注点：页面是自己变的，不是用户改的。'
                             '如果 AI 说「应该是你自己操作过」，那就是又把锅甩给用户了')
        results.append(r14)

    # ========== S15 暂停期间，AI 还能不能偷偷动我的页面？ ==========
    # 「暂停」最核心的安全保证不是"AI 不再往下想"，而是**它真的动不了我的页面**。
    # 这一场直接让 AI 在暂停期间去点一个按钮，看状态机拦不拦得住；
    # 再自己动手点一下，证明这张页确实归我了。
    if want('s15'):
        def s15_user():
            wc = WCS[0]
            # ① 让 AI 在暂停期间去点「搜索」—— 应该被状态机挡回来
            r1 = eva("window.workbench.drive({action:'click', target:'搜索'}, %d)" % wc)
            r2 = eva("window.workbench.drive({action:'type', target:'搜索商品', text:'偷偷改一下'}, %d)" % wc)
            note = ['暂停期间我让 AI 去点「搜索」→ 回执：%s'
                    % json.dumps(r1, ensure_ascii=False)[:220],
                    '暂停期间我让 AI 去改输入框 → 回执：%s'
                    % json.dumps(r2, ensure_ascii=False)[:220]]
            # ② 我自己动手点一下，证明这张页归我
            c = guest_cdp(AKEY)
            if c:
                try:
                    pos = c.js("(() => { const b = document.getElementById('btn1');"
                               " if (!b) return null; const r = b.getBoundingClientRect();"
                               " return {x: r.x + r.width/2, y: r.y + r.height/2}; })()")
                    if pos:
                        for kind in ('mousePressed', 'mouseReleased'):
                            c.send('Input.dispatchMouseEvent', type=kind, x=pos['x'], y=pos['y'],
                                   button='left', clickCount=1)
                    time.sleep(2.5)
                    res = c.js("(() => { const r = document.getElementById('result');"
                               " const q = document.getElementById('q1');"
                               " return {result: r ? r.innerText.slice(0, 70) : '(无)',"
                               " input: q ? q.value : '(无)'}; })()")
                    note.append('然后我自己点了「搜索」→ %s（说明这张页确实归我操作）'
                                % json.dumps(res, ensure_ascii=False))
                finally:
                    try:
                        c.ws.close()
                    except Exception:  # noqa: BLE001
                        pass
            return ' ｜ '.join(note)

        r15 = scenario('s15', '场景15-搜索下单', '%s/shop' % FAKE, s15_user, resume_wait=12)
        r15['events'].append('★ 关注点：暂停期间 AI 的 click / type 都必须被挡住（ok=false），'
                             '而用户自己的操作必须照常生效 —— 这是「暂停」两个字的最低要求')
        results.append(r15)

    # ========== S16 页面弹了个对话框（alert），AI 会不会被卡死 ==========
    # 真实网页里到处都是：Cookie 同意、登录提示、问卷、防爬验证。
    # 而 alert 会**阻塞页面 JS** —— AI 的「读页面」撞上它可能直接挂住。
    #
    # ⚠️ 这一场第一版把整个取证脚本都挂死了（跑了 7 分钟没出来）：
    #    页面弹着 alert 的时候，往这张页里执行任何 JS（包括脚本自己的读页面）都会一直阻塞。
    #    所以这一版改成：① **先暂停**、等弹窗出现、② 试探性地读一次（预期会卡）、
    #    ③ 用**提前握在手里的 CDP 连接**把弹窗点掉（模拟用户点「确定」）、④ 再继续。
    if want('s16'):
        print('\n' + '#' * 78)
        print('# 场景 s16：页面弹了一个对话框，AI 会不会被卡死')
        print('#' * 78)
        CURKEY = AKEY
        ev('window.workbench.resetTask(); "ok"')
        time.sleep(1)
        gjs(AKEY, 'location.href = %s; "ok"' % json.dumps('%s/dialog' % FAKE))
        time.sleep(2.5)
        rec16 = {'id': 's16', 'goal': '场景16-弹窗', 'nodes': [], 'events': []}
        rec16['nodes'].append(node('s16', '0-start', '开跑前：页面已就位（4 秒后会弹 alert）'))
        # ★ 趁弹窗还没出来，先握住这张页的 CDP 连接 —— 等会儿要靠它把弹窗点掉
        cdp_keep = guest_cdp(AKEY)
        rec16['events'].append('已提前握住内嵌页的 CDP 连接（弹窗后要靠它点「确定」）'
                               if cdp_keep else '⚠️ 没能提前握住 CDP 连接')
        GOAL16 = '场景16-弹窗'
        start_lane(GOAL16, WCS[0])
        wc = WCS[0]
        wait_steps(GOAL16, 2, timeout=60)
        time.sleep(1.0)
        rec16['nodes'].append(shot_node('s16', '1-running', 'AI 正在干活（此时按下暂停）'))
        eva('window.workbench.pauseTask(%d)' % wc)
        time.sleep(1.5)

        # 等 alert 弹出来（页面里设的是 4 秒）
        time.sleep(6)
        rec16['nodes'].append(shot_node('s16', '2-alert', '弹窗出来了（「请先同意 Cookie 协议」）'))

        # ① 试探：弹着窗的时候，让 AI 读一次页面 —— 预期卡住
        hung = False
        note = ''
        t0 = time.time()
        try:
            r = eva_t('window.workbench.drive({action: \'read_page\'}, %d)' % wc, timeout=25)
            note = '弹着窗时读页面 → 居然成功了：%s' % json.dumps(r, ensure_ascii=False)[:160]
        except Exception as e:  # noqa: BLE001
            hung = True
            note = '弹着窗时读页面 → **卡住了**（%.1f 秒没回来：%s）' % (time.time() - t0, str(e)[:120])
        d1 = time.time() - t0
        rec16['events'].append(note)
        print('    · %s' % note)

        # ② 用提前握住的 CDP 把弹窗点掉（模拟用户点「确定」）
        dismissed = False
        if cdp_keep:
            try:
                cdp_keep.send('Page.handleJavaScriptDialog', accept=True)
                dismissed = True
                time.sleep(2.0)
            except Exception as e:  # noqa: BLE001
                rec16['events'].append('点掉弹窗失败：%s' % str(e)[:120])
        rec16['events'].append('已模拟用户点掉弹窗：%s' % dismissed)

        # ③ 弹窗点掉之后再读一次 —— 应该就通了
        ok_after = False
        try:
            r2 = eva_t('window.workbench.drive({action: \'read_page\'}, %d)' % wc, timeout=25)
            ok_after = bool(r2 and r2.get('ok') is not False)
            rec16['events'].append('点掉弹窗后再读页面 → %s'
                                   % ('成功（%.1f 秒）' % (time.time() - t0)
                                      if ok_after else '仍然失败：%s' % json.dumps(r2, ensure_ascii=False)[:160]))
        except Exception as e:  # noqa: BLE001
            rec16['events'].append('点掉弹窗后再读页面 → 仍然卡住：%s' % str(e)[:120])
        rec16['nodes'].append(shot_node('s16', '3-dismissed', '我用 CDP 把弹窗点掉了'))

        # ④ 继续
        off16 = log_offset()
        eva('window.workbench.resumeTask(%d)' % wc)
        time.sleep(16)
        st = prt.task_state(wc) or {}
        rec16['nodes'].append(node('s16', '4-resumed', '点「继续」之后（状态：%s）' % st.get('phase')))
        rec16['events'].append(
            '★ 判定：① 弹窗期间读页面是否卡住=%s（%.1fs）② 点掉后是否恢复=%s ③ 继续后状态=%s'
            % (hung, d1, ok_after, st.get('phase')))
        rec16['calls'] = {'before_pause': 0, 'after_resume': len(llm_calls(GOAL16))}
        rec16['delta'] = new_delta_since(off16)
        rec16['chat_after'] = chat_tail(700)
        rec16['paused_phase'] = 'paused'
        rec16['resumed_phase'] = st.get('phase')
        rec16['final_state'] = st
        try:
            if cdp_keep:
                cdp_keep.ws.close()
        except Exception:  # noqa: BLE001
            pass
        print('    · 卡住=%s（%.1fs）｜点掉后恢复=%s ｜ 继续后=%s'
              % (hung, d1, ok_after, st.get('phase')))
        results.append(rec16)

    # ========== S17 暂停期间服务端重启了（循环在内存里，重启就没了）==========
    # 循环是**存在服务端内存里**的，一重启就没了。这时候用户点「继续」会怎样？
    # 代码里有一条兜底：「解挂失败 → 退回新建一轮」，但它**从来没被真正跑过**。
    # 兜底路径没验过，就等于没有。
    if want('s17'):
        print('\n' + '#' * 78)
        print('# 场景 s17：暂停期间我把服务端重启了，再点「继续」')
        print('#' * 78)
        CURKEY = AKEY
        ev('window.workbench.resetTask(); "ok"')
        time.sleep(1)
        gjs(AKEY, 'location.href = %s; "ok"' % json.dumps('%s/shop' % FAKE))
        time.sleep(3)
        rec17 = {'id': 's17', 'goal': '场景17-搜索下单', 'nodes': [], 'events': []}
        rec17['nodes'].append(node('s17', '0-start', '开跑前：页面已就位'))
        GOAL17 = '场景17-搜索下单'
        start_lane(GOAL17, WCS[0])
        wc = WCS[0]
        wait_steps(GOAL17, 3, timeout=90)
        time.sleep(3.0)
        rec17['nodes'].append(node('s17', '1-running', 'AI 正在干活（暂停前）'))
        eva('window.workbench.pauseTask(%d)' % wc)
        time.sleep(2.5)
        rec17['nodes'].append(node('s17', '2-paused', '已暂停（状态：%s）'
                                   % (prt.task_state(wc) or {}).get('phase')))

        # ---- 把服务端杀掉再拉起来（模拟服务端崩溃 / 重启 / 升级）----
        killed = 0
        for tag, p in list(prt.PROCS):
            if tag == 'server':
                try:
                    p.terminate()
                    killed += 1
                except Exception:  # noqa: BLE001
                    pass
        time.sleep(3)
        for tag, p in list(prt.PROCS):
            if tag == 'server' and p.poll() is None:
                try:
                    p.kill()
                except Exception:  # noqa: BLE001
                    pass
        prt.PROCS[:] = [x for x in prt.PROCS if x[0] != 'server']
        time.sleep(2)
        rec17['events'].append('已把服务端杀掉（%d 个进程）—— 内存里的循环全没了' % killed)
        print('    · 服务端已杀掉（%d 个）' % killed)

        spawn('server-restart', ['node', 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
              env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
                   'DEEPSEEK_API_KEY': 'fake-key-scen', 'DEEPSEEK_MODEL': 'fake-scen'},
              log=SERVER_LOG)
        hs = wait_health(API, timeout=90)
        rec17['events'].append('服务端重新起来了：%s' % (bool(hs),))
        print('    · 服务端已重启：%s' % bool(hs))

        off17 = log_offset()
        calls_before = len(llm_calls(GOAL17))
        eva('window.workbench.resumeTask(%d)' % wc)
        time.sleep(18)
        st = prt.task_state(wc) or {}
        rec17['nodes'].append(node('s17', '3-resumed', '点「继续」之后（状态：%s）' % st.get('phase')))
        evs = loop_events_since(off17)
        reborn = [e for e in evs if '新循环' in e]
        rec17['events'].append('点「继续」之后的循环事件：')
        for e in evs:
            rec17['events'].append('    ' + e)
        rec17['events'].append(
            '★ 判定：状态=%s ｜ 「新循环」%d 次 —— 这里**新建一轮是正确行为**'
            '（原来那条确实没了，不该硬接）；只要不是 failed / 卡死就算优雅降级'
            % (st.get('phase'), len(reborn)))
        rec17['calls'] = {'before_pause': calls_before, 'after_resume': len(llm_calls(GOAL17))}
        rec17['delta'] = new_delta_since(off17)
        rec17['chat_after'] = chat_tail(700)
        rec17['paused_phase'] = 'paused'
        rec17['resumed_phase'] = st.get('phase')
        rec17['final_state'] = st
        print('    · 重启后点继续：状态=%s ｜ 新循环 %d 次 ｜ 模型调用 %d→%d'
              % (st.get('phase'), len(reborn), calls_before, len(llm_calls(GOAL17))))
        results.append(rec17)

    # ========== S18 同一个任务，连续三轮「暂停 → 我改点东西 → 继续」==========
    # 前面所有场景都是**一轮**就收工。真人用起来更可能是来回好几趟：
    # 停一下、自己改点东西、让它接着干，再停、再改、再继续。
    # 要看的是：历史会不会串、会不会把做过的步骤再做一遍、步数上限到了怎么处理。
    if want('s18'):
        print('\n' + '#' * 78)
        print('# 场景 s18：同一个任务，连续三轮「暂停 → 我改点东西 → 继续」')
        print('#' * 78)
        CURKEY = AKEY
        ev('window.workbench.resetTask(); "ok"')
        time.sleep(1)
        gjs(AKEY, 'location.href = %s; "ok"' % json.dumps('%s/shop' % FAKE))
        time.sleep(3)
        rec18 = {'id': 's18', 'goal': '场景18-搜索下单', 'nodes': [], 'events': []}
        rec18['nodes'].append(node('s18', '0-start', '开跑前：页面已就位'))
        GOAL18 = '场景18-搜索下单'
        start_lane(GOAL18, WCS[0])
        wc = WCS[0]
        wait_steps(GOAL18, 3, timeout=90)
        time.sleep(3.0)
        rec18['nodes'].append(node('s18', '1-running', 'AI 正在干活（第 1 轮暂停前）'))

        def _guest_click(elem_id):
            c = guest_cdp(AKEY)
            if not c:
                return False
            try:
                pos = c.js("(() => { const b = document.getElementById('%s');"
                           " if (!b) return null; const r = b.getBoundingClientRect();"
                           " return {x: r.x + r.width/2, y: r.y + r.height/2}; })()" % elem_id)
                if not pos:
                    return False
                for kind in ('mousePressed', 'mouseReleased'):
                    c.send('Input.dispatchMouseEvent', type=kind, x=pos['x'], y=pos['y'],
                           button='left', clickCount=1)
                time.sleep(2.0)
                return True
            finally:
                try:
                    c.ws.close()
                except Exception:  # noqa: BLE001
                    pass

        def _guest_retype(text):
            c = guest_cdp(AKEY)
            if not c:
                return False
            try:
                c.js("(() => { const el = document.getElementById('q1');"
                     " if (!el) return null; el.focus();"
                     " el.scrollIntoView({block:'center'});"
                     " el.setSelectionRange(0, el.value.length);"
                     " return el.value; })()")
                time.sleep(0.3)
                c.send('Input.insertText', text=text)
                time.sleep(1.5)
                return True
            finally:
                try:
                    c.ws.close()
                except Exception:  # noqa: BLE001
                    pass

        # 三轮里我分别做什么
        plans = [
            ('把搜索词改成「机械键盘」', lambda: _guest_retype('机械键盘')),
            ('自己把「搜索」点了', lambda: _guest_click('btn1')),
            ('这轮我什么都不做，就干等 3 秒', lambda: (time.sleep(3), True)[1]),
        ]
        rounds = []
        for i, (what, act) in enumerate(plans):
            tag = str(i + 1)
            eva('window.workbench.pauseTask(%d)' % wc)
            time.sleep(2.5)
            st_p = prt.task_state(wc) or {}
            did = False
            try:
                did = bool(act())
            except Exception as e:  # noqa: BLE001
                rec18['events'].append('第 %s 轮我的操作失败：%s' % (tag, str(e)[:120]))
            rec18['nodes'].append(node('s18', '%sa-paused%s' % (tag, tag),
                                       '第 %s 轮：我%s（状态：%s）'
                                       % (tag, what, st_p.get('phase'))))
            off = log_offset()
            calls0 = len(llm_calls(GOAL18))
            eva('window.workbench.resumeTask(%d)' % wc)
            time.sleep(9)
            st_r = prt.task_state(wc) or {}
            rec18['nodes'].append(node('s18', '%sb-resumed%s' % (tag, tag),
                                       '第 %s 轮：点「继续」之后（状态：%s）' % (tag, st_r.get('phase'))))
            rounds.append({'round': i + 1, 'i_did': what, '操作成功': did,
                           'paused': st_p.get('phase'), 'resumed': st_r.get('phase'),
                           'delta': new_delta_since(off),
                           'calls': '%d→%d' % (calls0, len(llm_calls(GOAL18)))})
            if st_r.get('phase') in ('done', 'failed', 'stopped'):
                rec18['events'].append('第 %s 轮之后任务已经到终态（%s），后面的轮次不再继续'
                                       % (tag, st_r.get('phase')))
                break

        rec18['events'].append('三轮明细：%s' % json.dumps(rounds, ensure_ascii=False))
        rec18['events'].append('★ 关注点：三轮下来状态不能串、不能 failed；'
                               '我做过的事它不该再做一遍；走到步数上限要能自己收尾')
        st_f = prt.task_state(wc) or {}
        rec18['calls'] = {'before_pause': 0, 'after_resume': len(llm_calls(GOAL18))}
        rec18['delta'] = rounds[-1]['delta'] if rounds else None
        rec18['chat_after'] = chat_tail(900)
        rec18['paused_phase'] = rounds[0]['paused'] if rounds else None
        rec18['resumed_phase'] = st_f.get('phase')
        rec18['final_state'] = st_f
        print('    · 三轮：%s' % json.dumps(
            [(r['round'], r['paused'], '->', r['resumed'], r['delta']) for r in rounds],
            ensure_ascii=False))
        print('    · 末态=%s ｜ 模型调用累计 %d' % (st_f.get('phase'), len(llm_calls(GOAL18))))
        results.append(rec18)

    # ========== S19 暂停期间切到另一个智能体，再切回来 ==========
    # 真人会这么干：一个任务卡住了先晾着，去另一个智能体问两句，再切回来接着干。
    # 要看的是：切走再切回来，原来那个任务的状态**不能被串**（不能变成 running
    # 而实际没在跑、也不能把别的任务的历史混进来）。
    #
    # ⚠️ 这一场有两个**必须**的前置，少一个就会测出假证据：
    #   ① 新建的智能体**不会自己出现在侧边栏**，必须刷新页面。而刷新会换掉内嵌页
    #      的 guest 句柄 —— 所以刷新必须在**任务开始之前**做，不能放在暂停之后
    #      （放暂停后就等于亲手把要测的暂停状态毁了）。同时 guest_cdp 已经改成
    #      **按 webContentsId 找**，刷新瞬间 URL 变成 about:blank 也不会扑空。
    #   ② 点智能体时 aid 要用 %d 在 **Python 这一侧**插进选择器；
    #      写成 JS 里的 str(aid) 会静默点不中（浏览器里没有 str()），
    #      测出来的「没串位」就是假的。
    if want('s19'):
        print('\n' + '#' * 78)
        print('# 场景 s19：暂停期间切到另一个智能体，再切回来')
        print('#' * 78)
        CURKEY = AKEY
        # AGENT_ID / TOKEN 是 main() 里的局部变量，这里直接用即可
        # （之前误写成不存在的 LOGIN_AGENT，NameError）
        ev('window.workbench.resetTask(); "ok"')
        time.sleep(1)

        # ① 在**任务开始前**把第二个智能体建好并刷新进列表
        other = new_agent('切走测试-乙')
        rec19 = {'id': 's19', 'goal': '场景19-搜索下单', 'nodes': [], 'events': []}
        rec19['events'].append('当前智能体=%s，另一个=%s' % (AGENT_ID, other))
        print('    · 智能体：当前=%s 另一个=%s' % (AGENT_ID, other))
        _refr = reload_ui()
        rec19['events'].append('为了让新智能体出现在列表里，任务开始前刷新了一次页面'
                               '（UI 就绪=%s，%dms）；刷新后列表里有 %s 个智能体：%s'
                               % (_refr[0], _refr[2], len(_refr[3] or []), _refr[3]))
        print('    · 刷新后智能体列表：%s' % (_refr[3],))

        gjs(AKEY, 'location.href = %s; "ok"' % json.dumps('%s/shop' % FAKE))
        time.sleep(3)
        rec19['nodes'].append(node('s19', '0-start', '开跑前：页面已就位'))
        GOAL19 = '场景19-搜索下单'
        start_lane(GOAL19, WCS[0])
        wc = WCS[0]
        wait_steps(GOAL19, 3, timeout=90)
        time.sleep(2.0)
        rec19['nodes'].append(node('s19', '1-running', 'AI 正在干活（暂停前）'))

        eva('window.workbench.pauseTask(%d)' % wc)
        time.sleep(3.0)
        st_p = prt.task_state(wc) or {}
        rec19['nodes'].append(node('s19', '2-paused', '已暂停（状态：%s）' % st_p.get('phase')))

        # ② 切到另一个智能体
        diag = ev("(() => { const items = Array.from("
                  "document.querySelectorAll('.agentList [data-agent-id]'));"
                  " const list = document.querySelector('.agentList');"
                  " return {n: items.length,"
                  " ids: items.map(x => x.getAttribute('data-agent-id')),"
                  " listExists: !!list}; })()")
        print('    · 智能体列表诊断: %s' % json.dumps(diag, ensure_ascii=False)[:300])
        rec19['events'].append('智能体列表诊断：%s' % json.dumps(diag, ensure_ascii=False)[:300])
        clicked_other = _click_agent(other)
        time.sleep(4)
        st_o = prt.task_state(wc) or {}
        # ⚠️ 这两处必须用 node() 而不是 shot_node()：s19 里没有弹窗，
        #    shot_node 是给**弹窗场景**准备的（它故意不读页面，防止 JS 被对话框阻塞）。
        #    用错的话这两个节点的页面读数会变成一句写死的占位说明，
        #    看上去像"页面读不到"，其实页一直好好的 —— 属于自己造的假证据。
        rec19['nodes'].append(node('s19', '3-other-agent',
                                   '切到另一个智能体 %s（点了=%s）' % (other, clicked_other)))
        rec19['events'].append('切走之后（看的是原任务 wcId=%d）：状态=%s'
                               % (wc, st_o.get('phase')))
        print('    · 切走后状态=%s（点中=%s）' % (st_o.get('phase'), clicked_other))

        # ③ 切回来
        clicked_back = _click_agent(AGENT_ID)
        time.sleep(4)
        st_b = prt.task_state(wc) or {}
        rec19['nodes'].append(node('s19', '4-back', '切回原来的智能体 %s' % AGENT_ID))
        rec19['events'].append('切回来之后：状态=%s（点中=%s）' % (st_b.get('phase'), clicked_back))
        print('    · 切回后状态=%s（点中=%s）' % (st_b.get('phase'), clicked_back))

        # ④ 继续，看能不能接着干
        off19 = log_offset()
        calls0 = len(llm_calls(GOAL19))
        eva('window.workbench.resumeTask(%d)' % wc)
        time.sleep(10)
        st_r = prt.task_state(wc) or {}
        rec19['nodes'].append(node('s19', '5-resumed', '点「继续」之后（状态：%s）' % st_r.get('phase')))
        n19 = new_delta_since(off19)
        rec19['events'].append('★ 判定：切走/切回来全程状态必须是 paused 不被串；'
                               '继续之后要能真的接着跑（模型调用从 %d 往上涨），'
                               '页面不能被别的智能体的历史污染'
                               % calls0)
        print('    · %s → %s → %s → %s ｜ 继续后调用 %d→%d ｜ delta=%s'
              % (st_p.get('phase'), st_o.get('phase'), st_b.get('phase'),
                 st_r.get('phase'), calls0, len(llm_calls(GOAL19)), n19))
        rec19['calls'] = {'before_pause': calls0, 'after_resume': len(llm_calls(GOAL19))}
        rec19['delta'] = n19
        rec19['chat_after'] = chat_tail(900)
        rec19['paused_phase'] = st_p.get('phase')
        rec19['resumed_phase'] = st_r.get('phase')
        rec19['final_state'] = st_r
        results.append(rec19)

    # ========== S20 任务跑到步数上限（10 步）之后，还能不能接着做 ==========
    # 服务端到上限时会说：「一轮最多走 N 步，现在走满了还没做完，我先停下来。
    #   **要我接着做就点「继续」**」。
    # 这句话承诺了「点继续能接着做」。但如果步数计数器没重置，
    # 点继续后它马上又"走满了"、又问一遍 —— 就卡死在问答循环里了。这一场专验这个。
    if want('s20'):
        print('\n' + '#' * 78)
        print('# 场景 s20：任务跑到步数上限之后，点「继续」还能不能接着做')
        print('#' * 78)
        CURKEY = AKEY
        ev('window.workbench.resetTask(); "ok"')
        time.sleep(1)
        gjs(AKEY, 'location.href = %s; "ok"' % json.dumps('%s/shop' % FAKE))
        time.sleep(3)
        rec20 = {'id': 's20', 'goal': '场景20-长任务', 'nodes': [], 'events': []}
        rec20['nodes'].append(node('s20', '0-start', '开跑前：页面已就位'))
        GOAL20 = '场景20-长任务'
        start_lane(GOAL20, WCS[0])
        wc = WCS[0]

        # 等它跑到停下来（撞上限）
        capped = False
        for _ in range(60):
            n = len(llm_calls(GOAL20))
            stx = prt.task_state(wc) or {}
            if n >= 11 or stx.get('phase') in ('paused', 'idle', 'done', 'failed'):
                capped = True
                break
            time.sleep(1.0)
        calls_at_cap = len(llm_calls(GOAL20))
        st_cap = prt.task_state(wc) or {}
        chat_cap = chat_tail(600)
        rec20['nodes'].append(node('s20', '1-capped', '跑到步数上限了（状态：%s，已调用 %d 次）'
                                   % (st_cap.get('phase'), calls_at_cap)))
        rec20['events'].append('跑到上限：等到了=%s，模型调用 %d 次，状态=%s'
                               % (capped, calls_at_cap, st_cap.get('phase')))
        rec20['events'].append('有没有说出「走满/上限」这类话：%s'
                               % ('走满' in chat_cap or '上限' in chat_cap))
        print('    · 跑到上限：调用 %d 次，状态=%s，说了「走满/上限」=%s'
              % (calls_at_cap, st_cap.get('phase'), '走满' in chat_cap or '上限' in chat_cap))

        # 点「继续」—— 关键：看它是不是真的接着做，还是又"走满了"再问一遍
        off20 = log_offset()
        eva('window.workbench.resumeTask(%d)' % wc)
        time.sleep(16)
        calls_after = len(llm_calls(GOAL20))
        st_r = prt.task_state(wc) or {}
        chat_r = chat_tail(900)
        again = chat_r.count('走满')
        rec20['nodes'].append(node('s20', '2-resumed', '点「继续」之后（状态：%s，累计 %d 次）'
                                   % (st_r.get('phase'), calls_after)))
        rec20['events'].append(
            '★ 判定：继续后模型调用 %d → %d（新增 %d 次）；状态=%s；'
            '「走满」这句话出现了 %d 次 —— 只出现 1 次 = 真的接着做了（对）；'
            '出现 2 次以上 = 点继续后又撞上限再问一遍（卡死在问答循环）'
            % (calls_at_cap, calls_after, calls_after - calls_at_cap, st_r.get('phase'), again))
        rec20['calls'] = {'before_pause': calls_at_cap, 'after_resume': calls_after}
        rec20['delta'] = new_delta_since(off20)
        rec20['chat_after'] = chat_tail(900)
        rec20['paused_phase'] = st_cap.get('phase')
        rec20['resumed_phase'] = st_r.get('phase')
        rec20['final_state'] = st_r
        print('    · 继续后：%d → %d（新增 %d）｜ 状态=%s ｜ 「走满」出现 %d 次'
              % (calls_at_cap, calls_after, calls_after - calls_at_cap, st_r.get('phase'), again))
        results.append(rec20)

    # ---- 写报告 ----
    with open(os.path.join(OUTDIR, 'scen-results.json'), 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print('\n结果 JSON -> %s' % os.path.join(OUTDIR, 'scen-results.json'))
    print('截图目录 -> %s' % SHOTDIR)
    return 0


if __name__ == '__main__':
    code = 0
    try:
        code = main()
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        code = 1
    finally:
        for tag, p in prt.PROCS:
            try:
                p.terminate()
            except Exception:  # noqa: BLE001
                pass
        time.sleep(2)
        for tag, p in prt.PROCS:
            try:
                if p.poll() is None:
                    p.kill()
            except Exception:  # noqa: BLE001
                pass
        print('环境已收干净。')
    sys.exit(code)
