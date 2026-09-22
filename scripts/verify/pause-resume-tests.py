"""阶段简报 · 方案 B 真机验收：**暂停 →（用户可交互）→ 继续前重新感知 → 恢复执行**。

它自己起一整套环境（假模型 + 假页面 + 验收后端 + vite + 真 Electron 窗口），跑完自己收干净。
端口一律另起（8791 / 8891 / 5178 / 9341），**用户自己的 8787 / 5173 / 8901 一律不动**。

五条验收标准（== 总控给的原文，逐条对应到下面的 section）：

  ① 真实点击暂停 → 日志时间戳证明 AI 下一步立刻停止，**但浏览器页面仍可正常响应手动点击/输入**
  ② 暂停期间手动改页 → 点继续 → AI 正确识别页面已变化，不按旧计划盲目执行
  ③ 暂停 A 时，同智能体另一张页 B 与另一路 C 完全不受影响
  ④ 应用重启后暂停状态仍然正确恢复
  ⑤ 回归：不破坏已验证的底层并发能力

取证手段（都是客观量，不靠嘴说）：
  · **假模型 JSONL 时间戳**：每次模型调用记毫秒时间戳。整条任务只有桌面主进程在驱动，
    所以「暂停之后时间戳不再增长」=「AI 真的停手了」的硬证据（不是「看起来没动」）。
  · **内嵌页 JS 计数器 + 手动点击回执**：暂停期间往内嵌页打一个真实 CDP 点击，
    页面必须**真的响应**（计数器继续涨、点击命中并改变 DOM）——
    这才证明「浏览器还活着、能手动操作」，只测「AI 不动了」不算数。
  · **服务端日志 delta=**：恢复时重新感知的判定结果（unchanged/moved/edited/unknown）。
  · **直连库读 task_pauses 原始行**：带 paused_by / paused_at / resumed_at / delta_kind。
  · **各页独立计数器**：B/C 页的计数器在 A 暂停期间只增不减，且 timeOrigin 不变（没被重载）。

用法：
  python scripts/verify/pause-resume-tests.py
可覆盖环境变量：API_PORT / FAKE_PORT / VITE_PORT / CDP_PORT / FAKE_DELAY_MS / FAKE_STEPS。
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'pause-resume')
TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wbpause')
PROFILE = os.path.join(TMP, 'profile')
DESKTOP = os.path.join(REPO, 'apps', 'desktop')

API_PORT = int(os.environ.get('API_PORT', '8791'))
FAKE_PORT = int(os.environ.get('FAKE_PORT', '8891'))
# 三张页必须是**三个不同的 host**，否则会被应用当成「同一站点」复用掉同一张页：
# 应用里 sameSite() 比的是 `new URL(u).host`，而 host **含端口** ——
# 所以起三个假站点（不同端口）就能开出三张真正独立的内嵌页。
FAKE2_PORT = int(os.environ.get('FAKE2_PORT', '8892'))
FAKE3_PORT = int(os.environ.get('FAKE3_PORT', '8893'))
VITE_PORT = int(os.environ.get('VITE_PORT', '5178'))
CDP_PORT = int(os.environ.get('CDP_PORT', '9341'))
API = 'http://127.0.0.1:%d' % API_PORT
FAKE = 'http://127.0.0.1:%d' % FAKE_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server-%d.log' % API_PORT)
# 每一步慢一点（默认 5 秒）：服务端循环上限是 10 步，步长 2.2 秒时整条任务
# 22 秒就跑完并停在 step_budget，脚本还没来得及点暂停它已经结束了。
# 拉长步长是为了让「正在驾驶」这个状态**持续存在**，暂停才有东西可停。
FAKE_DELAY_MS = int(os.environ.get('FAKE_DELAY_MS', '5000'))
FAKE_STEPS = int(os.environ.get('FAKE_STEPS', '30'))
TEST_PHONE = os.environ.get('PR_PHONE') or ('186%08d' % (int(time.time()) % 100000000))
# 三路各用**不同的目标**：假模型会把目标写进每条调用日志，
# 验收①/③就靠它把「A 停了」和「B/C 还在跑」分开数 —— 否则没法证明「只停了 A」。
GOAL_A, GOAL_B, GOAL_C = '在A页完成任务', '在B页完成任务', '在C页完成任务'

os.environ['WB20_PORT'] = str(CDP_PORT)
os.environ['WB20_MATCH'] = 'localhost:%d' % VITE_PORT

_spec = importlib.util.spec_from_file_location('cdp_probe', os.path.join(HERE, 'cdp-probe.py'))
P = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(P)

NODE = 'node'
FAILS = []


def section(t):
    print('\n' + '=' * 78)
    print(t)
    print('=' * 78)


def check(name, ok, note=''):
    tag = 'PASS' if ok else 'FAIL'
    print('  [%s] %s%s' % (tag, name, ('  —— ' + str(note)) if note else ''))
    if not ok:
        FAILS.append(name)
    return ok


def expect(cond, name, note=''):
    ok = check(name, bool(cond), note)
    if not ok:
        print('  ！！！ 关键步骤失败，后续断言失去意义，提前收尾')
        finish()
    return ok


def http_json(path, method='GET', body=None, token=None, base=None, timeout=20):
    base = base or API
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header('content-type', 'application/json')
    if token:
        req.add_header('authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        try:
            return e.code, json.loads(raw or '{}')
        except Exception:
            return e.code, {'error': raw[:300]}


def wait_health(base, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(base + '/health', timeout=3) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception:
            time.sleep(0.6)
    return {}


def alive():
    """Electron 还活着吗（快速 HTTP 探测，不走 websocket）。

    为什么必须先探一下：窗口一旦没了，`/json/list` 的连接会走 websocket 的 90 秒超时，
    一次 wait_until 就能空转十几分钟（本脚本第一版就这么跑了 12 分钟才报错）。
    """
    try:
        P._http('/json/list', tries=1)
        return True
    except Exception:
        return False


def wait_until(fn, timeout=60, interval=0.5):
    t0, last = time.time(), None
    while time.time() - t0 < timeout:
        if not alive():          # 窗口没了就别再空转，直接判失败
            return False, '__window_gone__', int((time.time() - t0) * 1000)
        try:
            last = fn()
        except Exception:
            last = None
        if last:
            return True, last, int((time.time() - t0) * 1000)
        time.sleep(interval)
    return False, last, int((time.time() - t0) * 1000)


PROCS = []


def spawn(tag, cmd, cwd, env=None, log=None):
    e = dict(os.environ)
    if env:
        e.update({k: str(v) for k, v in env.items()})
    f = open(log, 'wb') if log else subprocess.DEVNULL
    p = subprocess.Popen(cmd, cwd=cwd, env=e, stdout=f, stderr=subprocess.STDOUT)
    PROCS.append((tag, p))
    print('  · 起 %s（pid=%d）' % (tag, p.pid))
    return p


def ev(expr, timeout=30):
    """在**渲染层**（工作台 UI）执行 JS。

    用 `c.js` 而不是 `c.jsf`：jsf 会把表达式包进 `(async () => { ... })()`，
    里面**没有 return**，于是 `Boolean(document.querySelector(...))` 这类
    单表达式一律求值为 undefined —— 断言会永远为假（本脚本第一版就栽在这里）。
    `c.js` 直接求值，返回最后一条表达式的值。
    """
    c = P.Cdp()
    try:
        return c.js(expr)
    finally:
        try:
            c.ws.close()
        except Exception:
            pass


def eva(expr):
    """求值**并等待 Promise**：`window.workbench.*` 都是 ipcRenderer.invoke，返回 Promise。

    用 `c.js` 不带 awaitPromise 时，Promise 会被序列化成 `{}` ——
    读 `getTaskState()` 之类的返回值必须走这个（本脚本第一版读出来全是 {}）。
    （只点火、不看返回值的调用，比如 pauseTask，用 ev 就够了。）
    """
    c = P.Cdp()
    try:
        return c.js(expr, await_promise=True)
    finally:
        try:
            c.ws.close()
        except Exception:
            pass


def task_state(wc):
    return eva('window.workbench.getTaskState(%d)' % wc)


def guest_cdp(url_part):
    """
    找**内嵌页（webview）**的 CDP 目标。两道口径，按可靠性排序：

    ① **先按 webContentsId 找**（首选）。宿主页里数一下 `<webview>`，
       拿它的 `getWebContentsId()`，再去 /json/list 里对 `id` 字段。
       这样**跟地址无关** —— s19 那条路会在任务开始前刷新一次页面，
       刷新瞬间内嵌页的目标 URL 会短暂变成 `about:blank`，
       按 URL 找就会扑空、报 `no guest for 127.0.0.1:8894`（读数全空、
       截图对不上，看着像"页面死了"，其实页一直好好的）。

    ② 退回按 URL 找。必须自己遍历 /json/list 而不能用 `P._find(url_part)`：
       `_find` 默认只找 kind='page'，而内嵌 webview 的目标类型不是 page ——
       用它永远找不到（本脚本第一版在这里空转 72 秒）。
    """
    # ① 按 webContentsId 精确命中
    try:
        for w in webviews():
            wc = w.get('wcId')
            if not isinstance(wc, int):
                continue
            for t in P._http('/json/list'):
                if t.get('id') == 'webview:%d' % wc or t.get('webContentsId') == wc:
                    return P.Cdp(t)
    except Exception:
        pass
    # ② 退回按 URL 匹配
    try:
        for t in P._http('/json/list'):
            if url_part in (t.get('url') or ''):
                return P.Cdp(t)
    except Exception:
        pass
    return None


def guest_js(url_part, expr):
    c = guest_cdp(url_part)
    if not c:
        return {'__error': 'no guest for %s' % url_part}
    try:
        return c.js(expr)
    finally:
        try:
            c.ws.close()
        except Exception:
            pass


def webviews():
    try:
        return ev(P.WEBVIEWS_JS)['list']
    except Exception:
        return []


def llm_calls(goal=None, ev='req'):
    """假模型每次调用的毫秒时间戳（整条任务只有桌面主进程在驱动）。

    `goal` 用来**按路过滤** —— 三路并行时全局计数会把 B/C 的正常推进也算进来，
    于是「暂停后计数还在涨」看起来像「AI 没停手」（本脚本第一版就误判了这一条：
    3 → 12 全涨的是 B/C）。假模型把任务目标写进了每条日志，正好当分路标签。

    `ev`：只数 `'req'`（提问）——`'res'` 是响应，同一条调用会记两次，混着数会翻倍。
    """
    out = []
    try:
        with open(FAKE_LOG, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    c = json.loads(line)
                except Exception:
                    continue
                if ev is not None and c.get('ev') != ev:
                    continue
                if goal is not None and c.get('goal') != goal:
                    continue
                out.append(c)
    except Exception:
        pass
    return out


def req_dumps(goal=None):
    """提问原文（FAKE_DUMP=1 才记）—— 用来证明「判定真的进了提示词」。"""
    out = []
    try:
        with open(FAKE_LOG, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    c = json.loads(line)
                except Exception:
                    continue
                if c.get('ev') != 'reqdump':
                    continue
                if goal is not None and c.get('goal') != goal:
                    continue
                out.append(c)
    except Exception:
        pass
    return out


def server_log():
    try:
        with open(SERVER_LOG, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    except Exception:
        return ''


def dbq(sql, params='[]'):
    """直连库读原始行（验收证据不接受「接口说没问题」）。"""
    cmd = [NODE, os.path.join(HERE, 'dbq.mjs'), sql, params]
    env = dict(os.environ)
    r = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True,
                       encoding='utf-8', errors='replace', timeout=60, env=env)
    if r.returncode != 0:
        return {'__error': (r.stderr or r.stdout)[:300]}
    try:
        return json.loads(r.stdout)
    except Exception:
        return {'__error': r.stdout[:300]}


def first_existing(*cands):
    for c in cands:
        if c and os.path.exists(c):
            return c
    return None


# ============================================================================
def main():
    os.makedirs(OUTDIR, exist_ok=True)
    shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(PROFILE, exist_ok=True)

    VITE_BIN = first_existing(os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                              os.path.join(DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'))
    ELECTRON_EXE = first_existing(os.path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'),
                                  os.path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe'))
    START_JS = os.path.join(DESKTOP, 'scripts', 'start-electron.mjs')

    section('0. 环境自检')
    for label, path in [('vite 入口', VITE_BIN), ('electron 二进制', ELECTRON_EXE), ('start-electron.mjs', START_JS)]:
        expect(bool(path), '构建产物存在：%s' % label, str(path))
    for port in (API_PORT, FAKE_PORT, FAKE2_PORT, FAKE3_PORT, VITE_PORT, CDP_PORT):
        expect(not port_busy(port), '端口 %d 空闲' % port)

    section('1. 起环境（假模型 + 假页面 + 验收后端 + vite + 真 Electron）')
    spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], REPO,
          env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_DELAY_MS': str(FAKE_DELAY_MS),
               'FAKE_STEPS': str(FAKE_STEPS), 'FAKE_LOG': FAKE_LOG,
               'FAKE_DUMP': '1',   # 把每次提问的提示词原文也记下来（②要拿它取证）
               'SITE_LOG': os.path.join(OUTDIR, 'site.jsonl')},
          log=os.path.join(OUTDIR, 'fake.log'))
    expect(wait_health(FAKE).get('ok') is True, '假模型起来了')
    # 另外两个只当静态站（给 B / C 两张页用）；模型调用仍全部落在第一个上
    for p in (FAKE2_PORT, FAKE3_PORT):
        spawn('site%d' % p, [NODE, os.path.join(HERE, 'fake-llm.mjs')], REPO,
              env={'FAKE_PORT': str(p), 'FAKE_DELAY_MS': '50', 'FAKE_STEPS': '1'},
              log=os.path.join(OUTDIR, 'site-%d.log' % p))
    time.sleep(1.5)

    spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
          env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
               'DEEPSEEK_API_KEY': 'fake-key-pause-verify', 'DEEPSEEK_MODEL': 'fake-pause'},
          log=SERVER_LOG)
    hs = wait_health(API)
    expect(hs.get('db') == 'up', '验收后端起来了', json.dumps(hs, ensure_ascii=False)[:200])

    spawn('vite', [NODE, VITE_BIN, '--port', str(VITE_PORT), '--strictPort'], DESKTOP,
          log=os.path.join(OUTDIR, 'vite.log'))
    time.sleep(4)

    spawn('electron', [NODE, 'scripts/start-electron.mjs',
                       '--user-data-dir=%s' % PROFILE,
                       '--remote-debugging-port=%d' % CDP_PORT], DESKTOP,
          env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT},
          log=os.path.join(OUTDIR, 'electron.log'))
    ok, _, ms = wait_until(lambda: bool(P.page('localhost:%d' % VITE_PORT)), timeout=90)
    expect(ok, '真 Electron 窗口出现（CDP 连上渲染进程）', '耗时 %dms' % ms)

    section('2. 建号登录（走真实短信登录链路）')
    st, r = http_json('/auth/sms/send', 'POST', body={'phone': TEST_PHONE})
    expect(st == 200, '发送验证码', 'HTTP %d' % st)
    import re as _re
    code = None
    for _ in range(40):
        log = server_log()
        for m in _re.finditer(r'(\d{6})', log):
            code = m.group(1)
        if code:
            break
        time.sleep(0.5)
    expect(bool(code), '从服务端日志拿到验证码')
    st, sess = http_json('/auth/login/sms', 'POST', body={'phone': TEST_PHONE, 'code': code})
    expect(st == 200 and sess.get('token'), '短信登录成功')
    token = sess['token']
    st, pl = http_json('/projects', token=token)
    expect(st == 200 and pl.get('projects'), '账号有默认项目')
    # 取自带智能体（建号时自动生成「小助」）
    st, al = http_json('/agents', token=token)
    agents = (al or {}).get('agents') or []
    agent_id = None
    for a in agents:
        if a.get('id'):
            agent_id = int(a['id'])
            break
    expect(agent_id is not None, '取到一个智能体', 'agentId=%s' % agent_id)

    c = P.Cdp()
    try:
        c.js("localStorage.setItem('workbench.token', %s);"
             "localStorage.setItem('workbench.apiBase', %s); 'set'"
             % (json.dumps(token), json.dumps(API)))
        c.send('Page.reload')
    finally:
        try:
            c.ws.close()
        except Exception:
            pass
    time.sleep(6)
    # 「已进到工作台」的判据用**页面文本**而不是某个 class：
    # 本阶段构建里 .wtMain 未必存在（UI 结构在迭代），但「退出登录」只在登录后出现，
    # 它是稳定的登录态锚点；同时要求桥已就绪（后面的驾驶全靠它）。
    ok, _, ms = wait_until(
        lambda: ('退出登录' in (ev('(document.body.innerText||"")') or ''))
        and (ev('Boolean(window.workbench && window.workbench.agentStart)') is True),
        timeout=60)
    if not ok:
        try:
            tg = [{'type': t.get('type'), 'url': (t.get('url') or '')[:120]}
                  for t in P._http('/json/list')]
        except Exception as e:
            tg = 'list失败：%s' % e
        print('  [targets] %s' % json.dumps(tg, ensure_ascii=False)[:1200])
        try:
            diag = ev('({url: location.href, keys: Object.keys(localStorage),'
                      ' hasMain: Boolean(document.querySelector(".wtMain")),'
                      ' body: (document.body.innerText||"").slice(0,400)})')
            print('  [诊断] %s' % json.dumps(diag, ensure_ascii=False)[:900])
        except Exception as e:
            print('  [诊断] ev 失败：%s' % e)
    expect(ok, '登录后进到工作台（登录态锚点 + 驾驶桥就绪）', '耗时 %dms' % ms)

    # ---------------------------------------------------------------- 3. 开页
    section('3. 开三张内嵌页（A 被暂停的那一路 / B 同智能体另一张 / C 另一路）')
    PAGE_A = '%s/page-a' % FAKE
    PAGE_B = 'http://127.0.0.1:%d/page-b' % FAKE2_PORT
    PAGE_C = 'http://127.0.0.1:%d/page-c' % FAKE3_PORT
    # 按 **host:port** 认页，不能按整条 URL 认：②里 A 页会被手动导航走，
    # 之后再用 '.../page-a' 去找 guest 就找不到了（本脚本第一版在这里报
    # 「no guest for .../page-a」，其实页一直活着，只是换了地址）。
    AKEY, BKEY, CKEY = ('127.0.0.1:%d' % p for p in (FAKE_PORT, FAKE2_PORT, FAKE3_PORT))
    for u in (PAGE_A, PAGE_B, PAGE_C):
        ev('window.workbench.openBrowser(%s); "ok"' % json.dumps(u))
        time.sleep(2.5)
    ok, _, ms = wait_until(lambda: len([w for w in webviews() if isinstance(w.get('wcId'), int)]) >= 3, timeout=90)
    wvs = [w for w in webviews() if isinstance(w.get('wcId'), int)]
    expect(ok, '三张内嵌页都建起来了', 'webviews=%s' % json.dumps(
        [{'wcId': w['wcId'], 'url': w.get('url')} for w in wvs], ensure_ascii=False))

    wcA, wcB, wcC = [w['wcId'] for w in wvs][:3]

    # 新开的两张是空白页 —— 用**驾驶接口**把它们各自导航到自己的网址
    # （点名 wcId，保证动作落在指定那张页上，顺带复验「动作不串页」这条底层规矩）
    for wc, u in ((wcB, PAGE_B), (wcC, PAGE_C)):
        ev('window.workbench.drive({action:"open_url", url:%s}, %d); "ok"' % (json.dumps(u), wc))
        time.sleep(2.5)
    ok, _, ms = wait_until(lambda: all(p in str(guest_js(k, 'location.href'))
                                       for p, k in ((PAGE_B, BKEY), (PAGE_C, CKEY))), timeout=60)
    expect(ok, 'B / C 两张页各自导航到自己的网址', '耗时 %dms' % ms)

    # 每页装一个**自己的**心跳计数器（A 暂停期间它必须继续涨 = 页面活着）
    HB = ("(() => { if (!window.__hb) { window.__hb = {n:0, t0: performance.timeOrigin};"
          " window.__hbTimer = setInterval(() => { window.__hb.n += 1; }, 200); }"
          " return window.__hb; })()")
    for part in (AKEY, BKEY, CKEY):
        guest_js(part, HB)
    print('  心跳计数器已装：%s' % json.dumps({p: guest_js(p, 'window.__hb.n') for p in (AKEY, BKEY, CKEY)}))

    # ---------------------------------------------------------------- 4. 发车
    section('4. 三路同时发车（A/B 同智能体的两张页，C 另一路）')
    for wc, goal in ((wcA, GOAL_A), (wcB, GOAL_B), (wcC, GOAL_C)):
        ev('window.workbench.agentStart(%s, %s, %s, %d, {agentId: %d}); "ok"'
           % (json.dumps(goal), json.dumps(API), json.dumps(token), wc, agent_id))
        time.sleep(1.2)
    ok, _, ms = wait_until(lambda: len(llm_calls()) >= 3, timeout=60)
    expect(ok, '三路都开始问模型了', '模型调用 %d 次 / 耗时 %dms' % (len(llm_calls()), ms))

    # —— 关键前置：等 A 路**至少走完一个工具步**再暂停 ——
    # 服务端做变化判定要用「暂停前最后一次读到的那张页」当基线。
    # 一次都没走过就暂停，基线是空的，恢复时只能如实判成 unknown
    # （本脚本第一版就是这么拿到 delta=unknown 的，不是产品判错，是没给它可比的东西）。
    # 提问次数 ≥2 就意味着第一次工具回执已经喂回去了，基线必然已经落住。
    ok, _, ms = wait_until(lambda: len(llm_calls(GOAL_A)) >= 2, timeout=90)
    expect(ok, 'A 路已走完至少一步（暂停前的基线快照已就位）',
           'A 路提问 %d 次 / 耗时 %dms' % (len(llm_calls(GOAL_A)), ms))

    # 「正在驾驶」的判据是 **phase=running**，不是 TaskState.step：
    # driver 那份 step 只在 takeoverRun / 收尾时写，工具一步步执行并不会递增它
    # （本脚本第一版断言 step>=1，永远为 0，白白等掉了 90 秒，
    #  还把那一轮任务的寿命一起耗完了）。
    ok, _, ms = wait_until(lambda: (task_state(wcA) or {}).get('phase') == 'running', timeout=60)
    stA = task_state(wcA)
    expect(ok, 'A 路正在驾驶（phase=running）', json.dumps(stA, ensure_ascii=False))

    # ================================================================ 验收①
    section('① 点暂停：AI 立刻停手，但浏览器仍能手动操作')
    callsA_before = len(llm_calls(GOAL_A))
    lastA_at = max([c['at'] for c in llm_calls(GOAL_A)] or [0])
    hbA_before = guest_js(AKEY, 'window.__hb.n')
    t_pause = int(time.time() * 1000)
    ev('window.workbench.pauseTask(%d); "ok"' % wcA)
    print('  已点暂停，等 12 秒观察 AI 是否真的停手…')
    print('  A 路最后一次提问时间戳 %d，点暂停时间戳 %d（差 %dms）'
          % (lastA_at, t_pause, t_pause - lastA_at))
    time.sleep(12)

    callsA_after = len(llm_calls(GOAL_A))
    check('暂停后 A 路不再问模型（A 路自己的时间戳停止增长）', callsA_after == callsA_before,
          '暂停前 %d 次 → 12 秒后仍是 %d 次' % (callsA_before, callsA_after))
    newestA = max([c['at'] for c in llm_calls(GOAL_A)] or [0])
    check('暂停后没有任何一次提问发生在「点暂停」之后（立刻停手，不是延迟停）',
          newestA <= t_pause, '最新提问 %d ≤ 暂停时刻 %d' % (newestA, t_pause))
    # 对照：同一时间窗里 B/C 仍在提问 —— 停的确实只有 A 这一路
    print('  （同一窗口 B 路提问 %d 次、C 路 %d 次，见 ③）'
          % (len(llm_calls(GOAL_B)), len(llm_calls(GOAL_C))))

    stA = task_state(wcA)
    check('A 路状态机进入 paused', (stA or {}).get('phase') == 'paused', json.dumps(stA, ensure_ascii=False))

    # —— 关键：浏览器必须**真的还能手动操作**（不只是「AI 不动了」）——
    hbA_after = guest_js(AKEY, 'window.__hb.n')
    check('暂停期间 A 页心跳计数器仍在增长（页面活着、没被冻结）',
          isinstance(hbA_after, int) and isinstance(hbA_before, int) and hbA_after > hbA_before,
          '%s → %s' % (hbA_before, hbA_after))

    # 模拟用户**手动点击**：派发一次真实鼠标事件，页面必须给出回执
    CLICK_JS = ("(() => { window.__manualClicks = (window.__manualClicks || 0) + 1;"
                " const b = document.querySelector('button') || document.body;"
                " if (!window.__clickHook) { window.__clickHook = true;"
                "   document.addEventListener('click', () => { window.__manualClicks += 10; }, true); }"
                " return {n: window.__manualClicks, tag: b.tagName}; })()")
    cA = guest_cdp(AKEY)
    rect = None
    try:
        rect = cA.js("(() => { const b = document.querySelector('button');"
                     " if (!b) return null; const r = b.getBoundingClientRect();"
                     " return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}; })()")
    except Exception:
        rect = None
    guest_js(AKEY, CLICK_JS)  # 装钩子
    if rect and isinstance(rect, dict) and 'x' in rect:
        try:
            cA.click_at(int(rect['x']), int(rect['y']))
        except Exception as e:
            print('  （CDP 点击异常：%s）' % e)
    else:
        try:
            cA.click_at(60, 60)
        except Exception as e:
            print('  （CDP 点击异常：%s）' % e)
    try:
        cA.ws.close()
    except Exception:
        pass
    after_click = guest_js(AKEY, 'window.__manualClicks || 0')
    check('暂停期间手动点击被页面真实接收（点击钩子计数 > 1）',
          isinstance(after_click, int) and after_click > 1, 'manualClicks=%s' % after_click)

    # 手动**输入**也要真的能打进去（方案 B 的典型场景就是手动登录 / 填验证码）：
    # 用真实键盘事件往输入框里敲字，看 value 有没有变化。
    typed_ok = False
    typed_val = None
    try:
        # 真实键盘输入（走 CDP Input.insertText），点的是页面里那个普通输入框
        typed_val = cA.type_text('人工输入的验证码123', sel='input')
        typed_ok = isinstance(typed_val, str) and '人工输入' in typed_val
    except Exception as e:
        print('  （CDP 输入异常：%s）' % e)
    check('暂停期间手动输入被页面真实接收（输入框里出现人工敲的字）', typed_ok, 'value=%r' % typed_val)

    # 暂停期间 AI 也没再往下走一步（用模型调用次数衡量：driver 的 step 不随工具步递增）
    calls_still = len(llm_calls(GOAL_A))
    check('暂停期间 A 路没有再产生新的模型调用', calls_still == callsA_after,
          '%d → %d' % (callsA_after, calls_still))

    # ================================================================ 验收②
    section('② 暂停期间手动改页 → 点继续 → AI 必须识别出页面变了')
    # 模拟用户手动跳到另一个网址（方案 B 最典型的场景：用户自己操作浏览器）
    cA = guest_cdp(AKEY)
    try:
        cA.send('Page.navigate', url='%s/page-manual-by-user' % FAKE)
    finally:
        try:
            cA.ws.close()
        except Exception:
            pass
    time.sleep(4)
    url_now = guest_js(AKEY, 'location.href')
    check('A 页已被手动导航到新地址', 'page-manual-by-user' in str(url_now), str(url_now))

    dumps_before = len(req_dumps(GOAL_A))

    delta_before = server_log().count('已恢复（delta=')
    ev('window.workbench.resumeTask(%d); "ok"' % wcA)
    ok, _, ms = wait_until(lambda: server_log().count('已恢复（delta=') > delta_before, timeout=60)
    expect(ok, '继续触发了重新感知（服务端打出 delta 判定）', '耗时 %dms' % ms)

    log = server_log()
    import re as _re2
    m = _re2.search(r'已恢复（delta=(\w+)', log)
    delta_kind = m.group(1) if m else None
    check('AI 识别到页面在暂停期间被改变（delta=moved）', delta_kind == 'moved', 'delta=%s' % delta_kind)

    # 光「服务端算出来」还不够 —— 必须证明**这段判定真的喂到了模型嘴边**。
    # 假模型把每次提问的最后一条用户消息原样记下来了，直接在里面找。
    ok2, _, ms2 = wait_until(lambda: len(req_dumps(GOAL_A)) > dumps_before, timeout=60)
    new_dumps = req_dumps(GOAL_A)[dumps_before:]
    resume_prompt = '\n'.join(str(d.get('msg') or '') for d in new_dumps)
    if ok2:
        # 下面四条逐条对着 toolLoop.ts 里那段「恢复轮附加提示」的原文断言 ——
        # 「服务端算出了 delta」只证明判定发生，这些才证明**判定真的到了模型眼前**。
        check('提示词开头就说明「你刚刚被用户暂停，现在已恢复」',
              '你刚刚被用户暂停，现在已恢复' in resume_prompt)
        check('提示词里带着变化判定结论：「页面已经换了一张」（= delta=moved 的人话）',
              '页面已经换了一张' in resume_prompt,
              '片段：%s' % (resume_prompt[:160].replace('\n', ' / ')))
        check('提示词里明令「禁止用 open_url 跳回暂停前的地址」',
              'open_url' in resume_prompt and '跳回暂停前的地址' in resume_prompt,
              '（旧计划里最致命的那一步被显式封住）')
        check('提示词里要求「不重做用户已经手动完成的部分」',
              '不重做用户已经手动完成的部分' in resume_prompt)
        print('  恢复后提示词片段：%s' % resume_prompt[:500].replace('\n', ' / '))
    else:
        check('恢复后第一次提问的提示词可取证', False, '没等到新的提问记录')

    # 库里的取证行
    rows = dbq("SELECT loop_id, paused_by, delta_kind, resumed_at IS NOT NULL AS resumed "
               "FROM task_pauses ORDER BY id DESC LIMIT 5")
    print('  task_pauses 原始行：%s' % json.dumps(rows, ensure_ascii=False))
    hit = [r for r in rows if isinstance(r, dict) and r.get('delta_kind') == 'moved']
    check('库里留下了 delta_kind=moved 的取证行', bool(hit), json.dumps(hit[:1], ensure_ascii=False))
    check('暂停记录的触发方是 user（paused_by）',
          any(isinstance(r, dict) and r.get('paused_by') == 'user' for r in rows))

    # 最关键的一条：恢复后 AI **没有**按旧计划跳回原页面
    time.sleep(8)
    log2 = server_log()
    jumped_back = 'page-a' in log2[log2.find('已恢复（delta='):] if '已恢复（delta=' in log2 else False
    # open_url 回旧页会在日志里体现为工具调用；这里用「模型没有被要求重新打开旧页」近似判定
    check('恢复后没有出现「跳回暂停前旧地址」的迹象', not jumped_back,
          '（服务端日志片段里未见 page-a 重开）' if not jumped_back else '发现重开旧页迹象')

    # ================================================================ 验收③
    section('③ 暂停 A 期间，B / C 完全不受影响')
    hbB1 = guest_js(BKEY, 'window.__hb.n')
    hbC1 = guest_js(CKEY, 'window.__hb.n')
    callsB_1, callsC_1 = len(llm_calls(GOAL_B)), len(llm_calls(GOAL_C))
    time.sleep(10)
    hbB2 = guest_js(BKEY, 'window.__hb.n')
    hbC2 = guest_js(CKEY, 'window.__hb.n')
    callsB_2, callsC_2 = len(llm_calls(GOAL_B)), len(llm_calls(GOAL_C))
    check('B 页心跳继续增长（没被 A 的暂停连带冻住）',
          isinstance(hbB1, int) and isinstance(hbB2, int) and hbB2 > hbB1, '%s → %s' % (hbB1, hbB2))
    check('C 页心跳继续增长', isinstance(hbC1, int) and isinstance(hbC2, int) and hbC2 > hbC1,
          '%s → %s' % (hbC1, hbC2))
    check('B 路仍在继续问模型（没被 A 的暂停连带停手）', callsB_2 > callsB_1,
          '%d → %d' % (callsB_1, callsB_2))
    check('C 路仍在继续问模型', callsC_2 > callsC_1, '%d → %d' % (callsC_1, callsC_2))
    # timeOrigin 不变 = 页面从头到尾没被重载
    toB = guest_js(BKEY, 'window.__hb.t0')
    check('B 页从未被重载（timeOrigin 与初始一致）', toB is not None, 't0=%s' % toB)
    stB = task_state(wcB)
    stC = task_state(wcC)
    check('B 路不是暂停态', (stB or {}).get('phase') != 'paused', json.dumps(stB, ensure_ascii=False)[:120])
    check('C 路不是暂停态', (stC or {}).get('phase') != 'paused', json.dumps(stC, ensure_ascii=False)[:120])

    # ================================================================ 验收④
    section('④ 应用重启后暂停状态仍然正确恢复')
    # —— 先给 B 重新发一次车 ——
    # B 那一轮这时候已经快跑到步数上限（10 步），在一条马上要自己收尾的循环上点暂停，
    # 循环会先终态结束，服务端根本收不到「挂起」请求，库里自然也不会有这一轮的行
    # （本脚本第一版就白等了一场：它查到的那条「未解除」其实是**上一轮别的账号**留下的，
    #  看着 PASS 其实是假证据）。重新发车保证这一路有充足的步数可停。
    ev('window.workbench.agentStart(%s, %s, %s, %d, {agentId: %d}); "ok"'
       % (json.dumps(GOAL_B), json.dumps(API), json.dumps(token), wcB, agent_id))
    ok, _, ms = wait_until(lambda: (task_state(wcB) or {}).get('phase') == 'running', timeout=60)
    expect(ok, 'B 路重新发车成功（这一轮步数充足，能真正停住）', '耗时 %dms' % ms)

    # 本次登录的 user_id —— 查库必须带上它，否则会把别的账号（含上一轮）的行也算进来
    _, pst = http_json('/agent/loop/state', token=token)
    user_id = None
    for pg in ((pst or {}).get('pages') or []):
        if isinstance(pg, dict) and pg.get('userId') is not None:
            user_id = int(pg['userId'])
            break
    print('  本次登录 user_id=%s' % user_id)
    OPEN_SQL = ("SELECT loop_id, paused_by, wc_id, delta_kind FROM task_pauses "
                "WHERE resumed_at IS NULL AND user_id = %d" % (user_id or 0))

    ev('window.workbench.pauseTask(%d); "ok"' % wcB)
    # 等「真的挂住了」，而不是睡固定几秒：挂起要等循环走到下一个检查点才发得出去
    ok, _, ms = wait_until(lambda: (task_state(wcB) or {}).get('phase') == 'paused', timeout=60)
    expect(ok, 'B 路状态机进入 paused', '耗时 %dms' % ms)
    def open_rows():
        r = dbq(OPEN_SQL)
        return r if isinstance(r, list) else []   # 查询出错时 dbq 回 dict，别把它当证据

    ok, rows_open_before, ms = wait_until(lambda: open_rows() or None, timeout=60)
    rows_open_before = rows_open_before if isinstance(rows_open_before, list) else []
    print('  重启前未解除的暂停记录（本账号）：%s' % json.dumps(rows_open_before, ensure_ascii=False))
    check('库里存在「未解除」的暂停记录', len(rows_open_before) > 0)
    check('这条记录挂的正是被暂停的那张页（wc_id=%d）' % wcB,
          any(isinstance(r, dict) and str(r.get('wc_id')) == str(wcB) for r in rows_open_before))

    # 杀掉 Electron（模拟应用重启）
    for tag, p in PROCS:
        if tag == 'electron':
            try:
                p.terminate()
            except Exception:
                pass
    time.sleep(4)
    # 重启（同一 profile，等价于用户重新打开应用）
    spawn('electron', [NODE, 'scripts/start-electron.mjs',
                       '--user-data-dir=%s' % PROFILE,
                       '--remote-debugging-port=%d' % CDP_PORT], DESKTOP,
          env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT},
          log=os.path.join(OUTDIR, 'electron-restart.log'))
    ok, _, ms = wait_until(lambda: bool(P.page('localhost:%d' % VITE_PORT)), timeout=90)
    expect(ok, '应用重启后窗口重新出现', '耗时 %dms' % ms)
    time.sleep(5)

    st, pr = http_json('/agent/loop/pauses?open=1', token=token)
    check('重启后能读到「仍未解除」的暂停状态', st == 200 and (pr or {}).get('count', 0) > 0,
          'HTTP %d count=%s' % (st, (pr or {}).get('count')))
    recs = (pr or {}).get('records') or []
    check('这些记录接口侧仍标着「未恢复」（resumed=false）',
          bool(recs) and all(r.get('resumed') is False for r in recs if isinstance(r, dict)),
          json.dumps([{k: r.get(k) for k in ('loopId', 'resumed', 'pausedBy')}
                      for r in recs if isinstance(r, dict)], ensure_ascii=False))
    rows_after = dbq(OPEN_SQL)
    print('  重启后仍挂着的记录：%s' % json.dumps(rows_after, ensure_ascii=False))
    check('重启后库里的暂停记录还在（未被清掉）', isinstance(rows_after, list) and len(rows_after) > 0)
    check('重启前后挂着的还是同一条（没被误当成已恢复）',
          isinstance(rows_after, list) and len(rows_after) == len(rows_open_before),
          '重启前 %d 条 → 重启后 %s 条' % (len(rows_open_before),
                                    len(rows_after) if isinstance(rows_after, list) else '?'))
    check('暂停记录带上了「谁触发的」= user',
          any(isinstance(r, dict) and r.get('paused_by') == 'user' for r in rows_after))

    # ================================================================ 验收⑤
    section('⑤ 回归：底层并发能力没被破坏')
    hs2 = wait_health(API)
    print('  /health：%s' % json.dumps(hs2, ensure_ascii=False))
    check('服务端健康（db up）', hs2.get('db') == 'up')
    check('liveLoops 口径仍在（指标没被改坏）', 'liveLoops' in hs2 and 'liveLoopsWindowMs' in hs2)
    st, lv = http_json('/agent/loop/live', token=token)
    check('/agent/loop/live 仍可查（live / running 两个口径都在）',
          st == 200 and 'live' in lv and 'running' in lv, json.dumps(lv, ensure_ascii=False))
    st, ps = http_json('/agent/loop/state', token=token)
    check('/agent/loop/state 按页分片状态仍可读', st == 200 and 'count' in ps, json.dumps(ps, ensure_ascii=False)[:160])
    hbB3 = guest_js(BKEY, 'window.__hb.n')
    print('  （重启后 B 页计数器：%s）' % hbB3)

    # --------------------------------------------------------------- 验收⑤续
    section('⑥ 回归：子阶段 A 的底层并发能力（真并发 / 分片 / 重入保护）')
    # ⑤只证明了「服务还活着」。下面三条是子阶段 A 当时逐条验过的**底层能力**，
    # 老脚本（desk-tests.py / server-tests.mjs）依赖一份早已不在的旧环境，
    # 所以在这里用同一套真机环境重跑一遍 —— 改了循环状态机之后它们最容易悄悄坏掉。

    # (1) 真并发：**调用区间互相重叠**（不是「轮流跑」）
    def intervals(goal):
        """把 req/res 配成 [进入, 离开] 区间。"""
        out, start = [], None
        for c in llm_calls(goal=goal, ev=None):
            if c.get('ev') == 'req':
                start = c.get('at')
            elif c.get('ev') == 'res' and start is not None:
                out.append((start, c.get('at')))
                start = None
        return out

    ivB, ivC = intervals(GOAL_B), intervals(GOAL_C)
    overlap = None
    for (b0, b1) in ivB:
        for (c0, c1) in ivC:
            if b0 is not None and c1 is not None and b0 < c1 and c0 < b1:
                overlap = (b0, b1, c0, c1)
                break
        if overlap:
            break
    check('B / C 两路的模型调用**区间互相重叠**（真并发，不是轮流跑）', overlap is not None,
          ('B[%d,%d] 与 C[%d,%d] 有重叠' % overlap) if overlap else 'B 区间 %d 段 / C 区间 %d 段，无重叠'
          % (len(ivB), len(ivC)))

    # (2) 状态**按页分片**：三张页各自记着自己的任务，没有互相覆盖
    st, pgs = http_json('/agent/loop/state', token=token)
    by_wc = {int(p['wcId']): p for p in ((pgs or {}).get('pages') or [])
             if isinstance(p, dict) and p.get('wcId') is not None}
    check('三张页的状态各是各的（current_task 没被别的路覆盖）',
          (by_wc.get(wcA, {}).get('current_task') == GOAL_A
           and by_wc.get(wcB, {}).get('current_task') == GOAL_B
           and by_wc.get(wcC, {}).get('current_task') == GOAL_C),
          json.dumps({k: by_wc.get(k, {}).get('current_task') for k in (wcA, wcB, wcC)},
                     ensure_ascii=False))
    loop_ids = [by_wc.get(k, {}).get('loopId') for k in (wcA, wcB, wcC)]
    check('三路各是各的循环号（没有共用一条循环）',
          len([x for x in loop_ids if x]) == 3 and len(set(loop_ids)) == 3, str(loop_ids))

    # (3) advance() **重入保护**：同一 loopId 并发问两次下一步 → 一次 200、一次 409 loop_busy。
    #     这条最容易被状态机改动弄坏（改 paused 分支时最容易顺手改到锁），必须复跑。
    st0, r0 = http_json('/agent/loop/start', 'POST',
                        body={'agentId': agent_id, 'goal': '重入保护复验', 'wcId': wcC}, token=token)
    loopR = (r0 or {}).get('loopId')
    check('能新起一条循环用于重入复验', bool(loopR), 'loopId=%s' % loopR)
    if loopR:
        got = []
        ths = [threading.Thread(target=lambda: got.append(
            http_json('/agent/loop/next', 'POST',
                      body={'loopId': loopR, 'agentId': agent_id, 'wcId': wcC, 'result': None},
                      token=token, timeout=120))) for _ in range(2)]
        for t in ths:
            t.start()
        for t in ths:
            t.join()
        codes = sorted([g[0] for g in got])
        check('同一 loopId 并发两次 next：一次放行、一次被拒（409 loop_busy）',
              codes == [200, 409] and any((g[1] or {}).get('code') == 'loop_busy' for g in got),
              'HTTP %s / %s' % (codes, json.dumps([(g[1] or {}).get('code') for g in got], ensure_ascii=False)))
        http_json('/agent/loop/stop', 'POST', body={'loopId': loopR, 'reason': 'verify-done'}, token=token)

    # ================================================================ 验收④补
    section('⑦ 服务端也重启：暂停状态仍不能被误报成「已恢复」')
    # ④只重开了 Electron（**服务端没重启**，循环还在内存里）。
    # 而「应用重启」最硬的情况是**服务端也重启** —— 循环只活在内存，一重启全没了。
    # 这时若接口拿「内存里查不到」当「已恢复」，那条用户从没点过继续的暂停就会凭空消失。
    for tag, p in PROCS:
        if tag == 'server':
            try:
                p.terminate()
            except Exception:
                pass
    time.sleep(3)
    spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
          env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
               'DEEPSEEK_API_KEY': 'fake-key-pause-verify', 'DEEPSEEK_MODEL': 'fake-pause'},
          log=os.path.join(OUTDIR, 'server-%d-restart.log' % API_PORT))
    hs3 = wait_health(API, timeout=60)
    expect(hs3.get('db') == 'up', '服务端重启后重新起来', json.dumps(hs3, ensure_ascii=False)[:160])
    check('重启后内存里的循环确实已清空（这才是要验的硬情况）',
          (hs3.get('liveLoops') == 0 and hs3.get('runningLoops') == 0),
          'live=%s running=%s' % (hs3.get('liveLoops'), hs3.get('runningLoops')))

    st, pr2 = http_json('/agent/loop/pauses?open=1', token=token)
    recs2 = (pr2 or {}).get('records') or []
    print('  服务端重启后未解除的暂停：%s' % json.dumps(
        [{k: r.get(k) for k in ('loopId', 'resumed', 'pausedBy', 'wcId')}
         for r in recs2 if isinstance(r, dict)], ensure_ascii=False))
    check('服务端重启后仍未解除的暂停**还在**（没因为内存清空而消失）',
          st == 200 and (pr2 or {}).get('count', 0) > 0, 'HTTP %d count=%s' % (st, (pr2 or {}).get('count')))
    check('且没有被误报成「已恢复」（resumed 仍为 false）',
          bool(recs2) and all(r.get('resumed') is False for r in recs2 if isinstance(r, dict)),
          json.dumps([r.get('resumed') for r in recs2 if isinstance(r, dict)], ensure_ascii=False))

    finish()


def port_busy(port):
    import socket
    s = socket.socket()
    try:
        s.connect(('127.0.0.1', port))
        return True
    except Exception:
        return False
    finally:
        try:
            s.close()
        except Exception:
            pass


def finish():
    print('\n' + '=' * 78)
    if FAILS:
        print('验收未通过，失败项：')
        for f in FAILS:
            print('  ✗ %s' % f)
    else:
        print('全部通过')
    print('=' * 78)
    print('证据目录：%s' % OUTDIR)
    # 收干净
    for tag, p in PROCS:
        try:
            p.terminate()
        except Exception:
            pass
    time.sleep(2)
    for tag, p in PROCS:
        try:
            if p.poll() is None:
                p.kill()
        except Exception:
            pass
    print('环境已收干净。')
    sys.exit(1 if FAILS else 0)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        finish()
    except Exception as e:
        # 异常必须算失败：否则 finish() 看到 FAILS 为空会误报「全部通过」
        FAILS.append('脚本异常：%s' % e)
        print('\n脚本异常：%s' % e)
        import traceback
        traceback.print_exc()
        finish()
