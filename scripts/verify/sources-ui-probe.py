# -*- coding: utf-8 -*-
"""第 26 步 · 「搜索来源标注」的**界面层真机验收**（真 Electron 窗口 + 真模型 + 真 Tavily）。

为什么必须有这一层：
    服务端那几层（HTTP 端到端）只证明了 `done.sources` 发得出来、落得了库，
    **证明不了界面上真的画出来了** —— 而"来源标注"这个功能的价值 100% 在界面上。
    所以从渲染进程的 DOM 再打一层：真的问答一轮，真的去读 `.sources`。

本探针证明什么（机器可验的部分）：
    ① 走搜索的那条回复，气泡下方**真的渲染出了来源块**（`.sources` 存在且非空）；
    ② 每一条都是**可点的外链**：`<a href="https://…" target="_blank" rel="…">`，
       且标题/域名都渲染出来了（不是空壳）；
    ③ 没搜过的那条回复（凭常识）**没有**来源块 —— 不能给常识问答也挂一排"参考资料"；
    ④ 截图留档，人眼可看。

本探针连「点下去之后系统浏览器有没有真的弹出来」也验了（第 5 节）：
    把某条来源的 href 临时改写到**本机一个一次性 HTTP 服务**（`target`/`rel` 一律不动，
    走的仍是真实那条路），再用**完整鼠标序列**真的点它；那个服务**真收到请求**
    ⇒ 证明「点击 → 主进程 setWindowOpenHandler → shell.openExternal → 系统默认浏览器
    真的取到了这个 url」整条链路是通的，而不只是"DOM 里长得像链接"。
    ⚠️ 副作用：这一步会**真的弹出一个系统浏览器标签页**（指向本机临时服务，页面写了"可以关掉"）。

剩下判不了的只有**好不好看**（来源块的密度 / 层次 / 标题截断）—— 见报告 §七。

端口：验收专用 8799 / 5273 / 9333，**不动用户的 8787 / 5173**。
收尾：kill 掉自己起的全部进程 + 删掉本次的测试账号（users 级联）。
"""
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
DESKTOP = os.path.join(REPO, 'apps', 'desktop')
OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'tavily')
TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wbsources')
# ★ 每次跑用一个**全新**的 profile：复用旧目录会把上一轮（账号已被删）的 token 留在
#   localStorage 里，Electron 启动时先拿它去换会话 ⇒ 401 ⇒ 页面停在登录/错误态，
#   连"注入新 token + reload"的时序都会被搅乱（第一版复用 profile，第二轮就卡死在这）。
PROFILE = os.path.join(TMP, 'profile-%d' % int(time.time()))

API_PORT = int(os.environ.get('API_PORT', '8799'))
VITE_PORT = int(os.environ.get('VITE_PORT', '5273'))
CDP_PORT = int(os.environ.get('CDP_PORT', '9333'))
# 第 5 节用的一次性「接球」服务端口：接住「系统默认浏览器真的来取这个 url」那一刻。
# （8901 被 douyin_tray.exe 占着，所以从 8911 起找空位）
CLICK_PORT = int(os.environ.get('CLICK_PORT', '8911'))
API = 'http://127.0.0.1:%d' % API_PORT
SERVER_LOG = os.path.join(OUTDIR, 'sources-ui-server-%d.log' % API_PORT)
SHOT = os.path.join(OUTDIR, 'sources-ui-20260920.png')

# 每次跑换一个号（服务端同号 60 秒只能发一条验证码，反复跑会一路撞 429）
TEST_PHONE = os.environ.get('SRC_PHONE') or ('186%08d' % ((int(time.time()) + 7) % 100000000))

_NODE_CAND = [r'C:\Users\bing\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe']
NODE = next((p for p in _NODE_CAND if os.path.exists(p)), None) or shutil.which('node') or 'node'

# cdp-probe.py 是现成的 CDP 客户端（eval / 真点击 / 真输入 / 截图）
os.environ['WB20_PORT'] = str(CDP_PORT)
os.environ['WB20_MATCH'] = 'localhost:%d' % VITE_PORT
_spec = importlib.util.spec_from_file_location('cdp_probe', os.path.join(HERE, 'cdp-probe.py'))
P = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(P)

procs = {}
results = []
evidence = {'startedAt': time.strftime('%Y-%m-%d %H:%M:%S'), 'testPhone': TEST_PHONE}


# ------------------------------------------------------------------ 小工具
def check(name, ok, detail=''):
    results.append({'name': name, 'ok': bool(ok), 'detail': str(detail)[:800]})
    print('%s  %s%s' % ('PASS' if ok else 'FAIL', name, (' :: ' + str(detail)) if detail else ''))
    return bool(ok)


def section(title):
    print('\n----- %s -----' % title)


def port_busy(port):
    out = subprocess.run(['netstat', '-ano'], capture_output=True, text=True,
                         encoding='utf-8', errors='replace').stdout
    return any((':%d ' % port) in line and 'LISTENING' in line for line in out.splitlines())


# ------------------------------------------------------------------ 一次性「接球」服务
HITS = []          # [(ts, path)] —— 系统默认浏览器真来取的时候，落在这里
SRV = {'obj': None}


class _ClickHandler(BaseHTTPRequestHandler):
    """只做一件事：把「系统默认浏览器真的来取这个 url」那一刻记下来。"""

    def do_GET(self):  # noqa: N802
        HITS.append((time.time(), self.path))
        body = ('<!doctype html><meta charset="utf-8"><title>验收探针</title>'
                '<p style="font:16px system-ui;padding:8px">'
                '这是 AI 工作台验收探针的临时页面，可以关掉。').encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:  # noqa: BLE001
            pass

    def log_message(self, *a):
        pass


def pick_free_port(start, tries=10):
    for p in range(start, start + tries):
        if not port_busy(p):
            return p
    return None


def start_click_server(port):
    srv = ThreadingHTTPServer(('127.0.0.1', port), _ClickHandler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    SRV['obj'] = srv
    return srv


def stop_click_server():
    srv = SRV.get('obj')
    if srv:
        try:
            srv.shutdown()
            srv.server_close()
        except Exception:  # noqa: BLE001
            pass
        SRV['obj'] = None


def wait_for_hit(token, timeout=25.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        for ts, path in HITS:
            if token in path:
                return (ts, path), int((time.time() - t0) * 1000)
        time.sleep(0.3)
    return None, int(timeout * 1000)


def click_xy(x, y):
    """
    ★ 必须用**完整鼠标序列**：`mouseMoved → mousePressed(buttons=1) → mouseReleased(buttons=0)`。
      只发 press/release 两下打不开 `target=_blank`（这是踩过的坑），
      现象是"点了没反应" —— 会误导成"主进程没接住"。
    """
    c = P.Cdp()
    try:
        c.send('Input.dispatchMouseEvent', type='mouseMoved', x=x, y=y, buttons=0)
        c.send('Input.dispatchMouseEvent', type='mousePressed', x=x, y=y,
               button='left', buttons=1, clickCount=1)
        c.send('Input.dispatchMouseEvent', type='mouseReleased', x=x, y=y,
               button='left', buttons=0, clickCount=1)
        return 'clicked at (%s,%s)' % (x, y)
    except Exception as e:  # noqa: BLE001
        return '点击失败：%r' % e
    finally:
        try:
            c.ws.close()
        except Exception:  # noqa: BLE001
            pass


def spawn(name, cmd, cwd, env=None, log=None):
    e = dict(os.environ)
    e.pop('ELECTRON_RUN_AS_NODE', None)   # 带着它 Electron 会当 Node 跑，0 秒崩
    if env:
        e.update(env)
    f = open(log, 'wb') if log else subprocess.DEVNULL
    p = subprocess.Popen(cmd, cwd=cwd, env=e, stdout=f,
                         stderr=(subprocess.STDOUT if log else subprocess.DEVNULL))
    procs[name] = {'p': p, 'f': f if log else None}
    print('[spawn] %-8s pid=%d' % (name, p.pid))
    return p


def kill_all():
    for name, rec in list(procs.items()):
        p = rec['p']
        if p.poll() is None:
            subprocess.run(['taskkill', '/F', '/T', '/PID', str(p.pid)], capture_output=True)
        if rec['f']:
            try:
                rec['f'].close()
            except Exception:  # noqa: BLE001
                pass
        procs.pop(name, None)


def http_json(path, method='GET', token=None, body=None, timeout=30):
    data = None
    headers = {}
    if token:
        headers['authorization'] = 'Bearer ' + token
    if body is not None:
        headers['content-type'] = 'application/json'
        data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with op.open(req, timeout=timeout) as r:
            raw = r.read().decode('utf-8', 'replace')
            return r.status, (json.loads(raw) if raw[:1] in ('{', '[') else raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        try:
            return e.code, json.loads(raw)
        except Exception:  # noqa: BLE001
            return e.code, raw


def server_log_text():
    try:
        with open(SERVER_LOG, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    except Exception:  # noqa: BLE001
        return ''


def find_sms_code(text):
    m = None
    for mm in re.finditer(r'\[sms:mock\].*?(\d{6})', text):
        m = mm.group(1)
    return m


def wait_health(timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            st, j = http_json('/health', timeout=5)
            if st == 200:
                return j
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.5)
    return None


def wait_until(fn, timeout=30.0, interval=0.5):
    t0 = time.time()
    last = None
    while (time.time() - t0) < timeout:
        try:
            last = fn()
            if last:
                return True, last, int((time.time() - t0) * 1000)
        except Exception as e:  # noqa: BLE001
            last = {'__error': str(e)}
        time.sleep(interval)
    return False, last, int((time.time() - t0) * 1000)


def _stable(fn, times=3, gap=1.0):
    """连续 times 次为真才算真 —— 防"第一次轮询就撞上瞬时状态"""""
    state = {'n': 0}

    def probe():
        if fn():
            state['n'] += 1
        else:
            state['n'] = 0
        if state['n'] >= times:
            return True
        time.sleep(gap)
        return False

    return probe


def ev(expr):
    """每次新开一条 CDP 连接（复用旧连接会在 Page.reload 后拿到 No such target id）"""
    c = P.Cdp()
    try:
        return c.js(expr)
    finally:
        try:
            c.ws.close()
        except Exception:  # noqa: BLE001
            pass


# ------------------------------------------------------------------ DOM 读取
SOURCES_JS = r"""
(() => {
  /**
   * ★ hit-test：从条目**中心点**反查 DOM，看那里到底是谁。
   *   「有 href + 是 <a>」只证明"长得像链接"；`elementFromPoint` 命中自己
   *   才证明**点得动**（没被别的元素盖住、没在屏幕外）。
   *   这是"点了有没有反应"最接近的机器判据。
   */
  const hit = (a) => {
    const r = a.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return { ok: false, at: null, inView: false };
    const x = Math.round(r.left + Math.min(r.width / 2, 40));
    const y = Math.round(r.top + r.height / 2);
    const inView = x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
    const el = inView ? document.elementFromPoint(x, y) : null;
    return {
      ok: !!el && (el === a || a.contains(el)),
      at: el ? (el.tagName + (el.className ? '.' + String(el.className).split(' ').filter(Boolean)[0] : '')) : null,
      inView,
    };
  };
  const blocks = [...document.querySelectorAll('.sources')].map((n) => ({
    label: (n.querySelector('.sources__label') || {}).textContent || '',
    items: [...n.querySelectorAll('.sources__item')].map((a) => {
      const hp = hit(a);
      return {
        tag: a.tagName,
        href: a.getAttribute('href'),
        target: a.getAttribute('target'),
        rel: a.getAttribute('rel'),
        title: (a.querySelector('.sources__title') || {}).textContent || '',
        domain: (a.querySelector('.sources__domain') || {}).textContent || '',
        cursor: getComputedStyle(a).cursor,
        color: getComputedStyle(a).color,
        w: Math.round(a.getBoundingClientRect().width),
        h: Math.round(a.getBoundingClientRect().height),
        hitOk: hp.ok,
        hitAt: hp.at,
        inView: hp.inView,
      };
    }),
  }));
  const msgs = [...document.querySelectorAll('.msg')].map((m) => ({
    role: m.className.includes('assistant') ? 'assistant' : 'user',
    head: m.textContent.slice(0, 30),
  }));
  return {
    blockCount: blocks.length,
    blocks,
    msgCount: msgs.length,
    assistantCount: msgs.filter((m) => m.role === 'assistant').length,
    lastIsAssistant: msgs.length ? msgs[msgs.length - 1].role === 'assistant' : false,
    hint: (document.querySelector('.searchHint') || {}).textContent || null,
  };
})()
"""


def send_and_wait(text, timeout=200):
    """在输入框里打一句话发出去，等这一轮**真的落定**再返回。

    ⚠️ 判据为什么不是"助手消息数 +1"（第一版就是这么写的，结果 1ms 就"通过"了）：
       流式期间的**占位气泡本身就是** `<div className="msg assistant">`（里面是
       "正在想…" 或半截正文 + 一个 `.caret` 光标）—— 拿条数当判据，会在
       发送后**立刻**满足，读到的是一句"正在想…"，而不是回答。
       正确判据：**用户消息落进列表**（这一轮开始了）+ **`.caret` 与 `.searchHint`
       都消失且连续 3 次稳定**（这一轮结束了）。
    """
    c = P.Cdp()
    try:
        # 上一轮若还在跑，先等它收干净（避免把上一轮的气泡算进来）
        wait_until(lambda: not c.js("Boolean(document.querySelector('.caret'))"),
                   timeout=30, interval=0.5)
        before_msgs = c.js("document.querySelectorAll('.msg').length")
        before_asst = c.js("document.querySelectorAll('.msg.assistant').length")

        c.click_rect('.inputBar input')
        time.sleep(0.3)
        if c.js("document.activeElement ? document.activeElement.tagName : ''") != 'INPUT':
            c.js("document.querySelector('.inputBar input').focus()")
            time.sleep(0.2)
        c.type_text(text)
        val = c.js("document.querySelector('.inputBar input').value")
        if val != text:
            return {'ok': False, 'why': '输入框内容不是期望文本：%r' % val}
        c.js("document.querySelector('.inputBar button').click()")

        # ① 这一轮开始了：列表里多了一条（用户那句）
        ok1, _, ms1 = wait_until(
            lambda: c.js("document.querySelectorAll('.msg').length") > before_msgs,
            timeout=25, interval=0.3)

        # ② 这一轮结束了：没有打字光标、没有"正在搜索"、助手消息 >= 1，且连续 3 次稳定
        def settled():
            return (not c.js("Boolean(document.querySelector('.caret'))")
                    and not c.js("Boolean(document.querySelector('.searchHint'))")
                    and c.js("document.querySelectorAll('.msg.assistant').length") >= 1)

        ok2, _, ms2 = wait_until(_stable(settled, times=3, gap=1.0), timeout=timeout, interval=1.0)

        try:
            after_asst = c.js("document.querySelectorAll('.msg.assistant').length")
        except Exception:  # noqa: BLE001
            after_asst = None
        return {'ok': bool(ok1 and ok2), 'sent': bool(ok1), 'settled': bool(ok2),
                'ms': ms1 + ms2, 'before': before_asst, 'after': after_asst}
    finally:
        try:
            c.ws.close()
        except Exception:  # noqa: BLE001
            pass


def cleanup_db():
    """删掉本次的测试账号（users 级联到项目/会话/消息）"""
    js = r'''
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/node_modules/');
const { Client } = require('pg');
const env = {};
for (const line of readFileSync('apps/server/.env', 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const c = new Client({ connectionString: env.DATABASE_URL });
await c.connect();
const pepper = env.PHONE_PEPPER || env.DATA_KEY;
const h = createHmac('sha256', pepper).update(process.argv[1], 'utf8').digest('hex');
const r = await c.query('SELECT id FROM users WHERE phone_hash = $1', [h]);
let removed = 0;
for (const row of r.rows) {
  const d = await c.query('DELETE FROM users WHERE id = $1', [row.id]);
  removed += d.rowCount;
}
await c.query('DELETE FROM sms_codes WHERE phone_hash = $1', [h]);
const t = await c.query('SELECT count(*)::int AS n FROM users');
console.log(JSON.stringify({ removed, usersTotal: t.rows[0].n }));
await c.end();
'''
    r = subprocess.run([NODE, '--input-type=module', '-e', js, TEST_PHONE],
                       cwd=REPO, capture_output=True, text=True, encoding='utf-8', errors='replace')
    out = (r.stdout or '').strip().splitlines()
    return out[-1] if out else (r.stderr or '')[-300:]


# ------------------------------------------------------------------ 主流程
def main():
    os.makedirs(OUTDIR, exist_ok=True)
    os.makedirs(TMP, exist_ok=True)

    section('0. 环境自检')
    busy = [p for p in (API_PORT, VITE_PORT, CDP_PORT) if port_busy(p)]
    check('验收专用端口空闲（8799/5273/9333，不动用户的 8787/5173）',
          not busy, ('占用中=%s' % busy) if busy else '三个端口都没人听')
    if busy:
        return 2
    vite_bin = next((p for p in [os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                                 os.path.join(DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js')]
                     if os.path.exists(p)), None)
    check('vite 入口存在', bool(vite_bin), str(vite_bin))
    check('start-electron.mjs 存在', os.path.exists(os.path.join(DESKTOP, 'scripts', 'start-electron.mjs')))
    with open(os.path.join(REPO, 'apps', 'server', 'dist', 'routes', 'chat.js'),
              encoding='utf-8') as _f:
        _dist_has_sources = 'sources' in _f.read()
    check('dist 里有本次改过的服务端（含 sources 列写入）', _dist_has_sources,
          'grep sources in dist/routes/chat.js')
    if not vite_bin:
        return 2

    # -------------------------------------------------------------- 1. 起环境
    section('1. 起环境（真后端 + 真模型 + 真 Tavily + vite + 真 Electron）')
    spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
          env={'PORT': str(API_PORT)}, log=SERVER_LOG)
    hs = wait_health()
    check('后端起来了且 db=up', bool(hs) and hs.get('db') == 'up',
          json.dumps(hs, ensure_ascii=False)[:300] if hs else '90 秒没起来')
    check('后端已配模型（真机验收必须真调模型）', bool(hs) and hs.get('llm') == 'configured',
          'llm=%s' % (hs or {}).get('llm'))
    if not hs or hs.get('db') != 'up':
        return 2
    # ★ 起 Electron 之前必须**连续两次** db=up —— 否则 Electron 的 pg-supervisor
    #   会自己再拉一个 PG，两个 postmaster 抢同一个 data 目录，登录链路直接挂。
    time.sleep(3)
    hs2 = wait_health()
    check('★ 连续两次 /health 都是 db=up（起 Electron 前的硬前提）',
          bool(hs2) and hs2.get('db') == 'up', 'db=%s' % (hs2 or {}).get('db'))

    spawn('vite', [NODE, vite_bin, '--port', str(VITE_PORT), '--strictPort'], DESKTOP,
          log=os.path.join(OUTDIR, 'sources-ui-vite.log'))
    time.sleep(5)

    """
    ★ `--no-sandbox` 必须显式传（本机已知坑）：
      `start-electron.mjs` 自带一个回退 —— 但**只在"启动 15 秒内崩且退出码是
      0x80000003"** 时才补 `--no-sandbox`。实测遇到过"跑起来之后中途 GPU FATAL"
      （日志：`GPU process isn't usable. Goodbye.`），那时回退**不会触发**，
      现象是登录后 CDP 握手 `Connection timed out`，**极易误判成"探针坏了"**。
      验收脚本自己起环境，显式带上最稳。
    """
    spawn('electron', [NODE, 'scripts/start-electron.mjs',
                       '--user-data-dir=%s' % PROFILE,
                       '--remote-debugging-port=%d' % CDP_PORT,
                       '--no-sandbox'], DESKTOP,
          env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT},
          log=os.path.join(OUTDIR, 'sources-ui-electron.log'))
    ok, last, ms = wait_until(lambda: _page_present(), timeout=120, interval=1.0)
    check('真 Electron 窗口出现且 CDP 连得上渲染进程', ok, '耗时 %dms' % ms)
    if not ok:
        return 2

    # -------------------------------------------------------------- 2. 登录
    section('2. 建测试账号并登录（真实短信登录链路）')
    st, r = 0, {}
    for _ in range(6):
        st, r = http_json('/auth/sms/send', 'POST', body={'phone': TEST_PHONE})
        if st == 200:
            break
        m = re.search(r'(\d+)\s*秒', json.dumps(r, ensure_ascii=False))
        time.sleep(int(m.group(1)) + 1 if m else 3)
    check('发送验证码', st == 200, 'HTTP %d %s' % (st, json.dumps(r, ensure_ascii=False)[:200]))
    code = None
    for _ in range(40):
        code = find_sms_code(server_log_text())
        if code:
            break
        time.sleep(0.5)
    check('从服务端日志里拿到 6 位验证码（mock 只进日志，响应体里没有）', bool(code), 'code=%s' % code)
    if not code:
        return 2
    st, sess = http_json('/auth/login/sms', 'POST', body={'phone': TEST_PHONE, 'code': code})
    token = (sess or {}).get('token')
    check('短信登录成功并拿到 JWT', st == 200 and bool(token),
          'HTTP %d user=%s' % (st, ((sess or {}).get('user') or {}).get('xyz_id')))
    if not token:
        return 2

    # 注入 token + apiBase 再刷新（等价于用户重启应用后静默续会话）
    c = P.Cdp()
    try:
        c.js("localStorage.setItem('workbench.token', %s);"
             "localStorage.setItem('workbench.apiBase', %s); 'set'"
             % (json.dumps(token), json.dumps(API)))
        c.send('Page.reload')
    finally:
        try:
            c.ws.close()
        except Exception:  # noqa: BLE001
            pass
    # 等页面**加载完**再注入（不然注入可能落在尚未挂载的 window/localStorage 上）
    wait_until(lambda: ev('document.readyState') == 'complete', timeout=60, interval=0.5)
    time.sleep(2)
    ok, last, ms = wait_until(lambda: bool(ev("Boolean(document.querySelector('.inputBar input'))")),
                              timeout=90, interval=1.0)
    if not ok:
        # 失败时把"卡在哪"打出来：URL + 可见文字 + 有没有报错提示
        diag = ev('({url: location.href, head: document.body.innerText.slice(0,300),'
                   ' hasNote: Boolean(document.querySelector(".chatNote")),'
                   ' note: (document.querySelector(".chatNote")||{}).textContent || null})')
        print('    [诊断] %s' % json.dumps(diag, ensure_ascii=False)[:700])
    check('登录后进到工作台（聊天输入框出现）', ok, '耗时 %dms' % ms)
    if not ok:
        return 2

    # -------------------------------------------------------------- 3. 搜索轮
    section('3. 走搜索的一轮：来源标注必须真的画出来')
    res = send_and_wait('今天有什么新闻', timeout=180)
    check('消息发出去了且助手回复落进 DOM', res.get('ok'),
          'assistant %s → %s（%sms）' % (res.get('before'), res.get('after'), res.get('ms')))
    # 先把来源块滚进视口，再做 hit-test
    # （否则"点不到"可能只是它在屏幕外，那是**假红**）
    ev("(() => { const n = document.querySelector('.sources');"
       " if (n) n.scrollIntoView({ block: 'center' }); return true; })()")
    time.sleep(0.6)
    dom = ev(SOURCES_JS) or {}
    evidence['afterSearch'] = dom
    print('    DOM: 消息数=%s（助手 %s）来源块=%s'
          % (dom.get('msgCount'), dom.get('assistantCount'), dom.get('blockCount')))
    for b in (dom.get('blocks') or []):
        for it in (b.get('items') or [])[:3]:
            print('      · %s  [%s]  %s' % ((it.get('title') or '')[:34], it.get('domain'), it.get('href')))

    check('★ 气泡下方真的渲染出了来源块（.sources 存在）',
          (dom.get('blockCount') or 0) >= 1, 'blockCount=%s' % dom.get('blockCount'))
    items = (dom.get('blocks') or [{}])[0].get('items') or []
    check('★ 来源块里有可点的条目（.sources__item 非空）', len(items) >= 1, '%d 条' % len(items))
    check('★ 每一条都是真外链 <a href="http(s)://…">',
          bool(items) and all(it.get('tag') == 'A' and re.match(r'^https?://', it.get('href') or '')
                              for it in items),
          '样例：%s' % (items[0].get('href') if items else '（空）'))
    check('★ 每一条都带 target="_blank"（点击才会走主进程的 setWindowOpenHandler → 系统浏览器）',
          bool(items) and all(it.get('target') == '_blank' for it in items),
          'target=%s' % sorted({it.get('target') for it in items}))
    check('★ 每一条都带 rel="noreferrer noopener"（外链安全）',
          bool(items) and all(it.get('rel') == 'noreferrer noopener' for it in items),
          'rel=%s' % sorted({it.get('rel') for it in items}))
    check('来源条目真的渲染了标题和域名（不是空壳）',
          bool(items) and all((it.get('title') or '').strip() and (it.get('domain') or '').strip()
                              for it in items),
          '首条：%r @ %r' % ((items[0].get('title') if items else ''), (items[0].get('domain') if items else '')))
    check('来源条目有实际可见尺寸（不是 display:none / 0×0）',
          bool(items) and all((it.get('w') or 0) > 0 and (it.get('h') or 0) > 0 for it in items),
          '首条 %sx%s' % ((items[0].get('w') if items else '?'), (items[0].get('h') if items else '?')))
    check('来源条目的鼠标指针是 pointer（看得出来能点）',
          bool(items) and all(it.get('cursor') == 'pointer' for it in items),
          'cursor=%s' % sorted({it.get('cursor') for it in items}))
    check('来源块的标签是「来源」', bool(dom.get('blocks')) and (dom['blocks'][0].get('label') or '') == '来源',
          repr((dom.get('blocks') or [{}])[0].get('label')))
    check('★ 每条来源的中心点真的点得到（hit-test 命中自己，不是被别的元素盖住）',
          bool(items) and all(it.get('hitOk') for it in items),
          '命中样例：%s / 未命中 %d 条'
          % ((items[0].get('hitAt') if items else '（空）'),
             sum(1 for it in items if not it.get('hitOk'))))
    check('★ 每条来源都在视口内（不是滚出屏幕所以点不到）',
          bool(items) and all(it.get('inView') for it in items),
          '视口内 %d/%d 条' % (sum(1 for it in items if it.get('inView')), len(items)))

    # ---------------------------------------------------------- 3.2 截图留档
    section('3.2 截图留档（人眼看来源标注长什么样）')
    """
    ★ 截图必须放在 **reload 之前**（这是踩过的坑）：
      `location.reload()` 会让 CDP 的 page target 换血，之后
      `Page.captureScreenshot` 稳定 `WebSocketTimeoutException(Connection timed out)`。
      现象是「功能断言全绿、只有截图红」，**极易误判成「来源渲染有问题」**。
      截的是「刚答完那一下」的界面，正是人最想看的状态，放这里也更好看。
    """
    shot_ok = False
    for attempt in range(3):
        try:
            c = P.Cdp()
            try:
                c.shot(SHOT)
            finally:
                try:
                    c.ws.close()
                except Exception:  # noqa: BLE001
                    pass
            shot_ok = os.path.exists(SHOT)
        except Exception as e:  # noqa: BLE001
            print('      第 %d 次截图失败：%r' % (attempt + 1, e))
            time.sleep(2)
        if shot_ok:
            break
    check('截图已保存（人眼可看来源标注长什么样）', shot_ok, SHOT)

    # ---------------------------------------------------------- 3.5 刷新后来源仍在
    section('3.5 刷新后来源仍在（真实 UI 层验证「落库 → 读回 → 渲染」）')
    """
    为什么必须测这一条：
      桌面流式结束后是**本地追加消息**（不重拉 history），切会话/刷新才走 `/chat/history`。
      来源如果只下发不落库，那么"刚答完能看到、一切走会话就没了"。
      HTTP 层已经断言过落库（`search-chat-e2e.mjs` 3.4/3.5），这里补**真实界面**那一半。
    """
    hrefs_before = [it.get('href') for it in items]
    ev('location.reload()')
    okr, _, msr = wait_until(
        lambda: bool(ev("Boolean(document.querySelector('.inputBar input'))")),
        timeout=90, interval=1.0)
    check('刷新后应用重新起来（输入框回来了）', okr, '耗时 %dms' % msr)
    if okr:
        okh, _, msh = wait_until(
            lambda: (ev("document.querySelectorAll('.msg').length") or 0) > 0,
            timeout=90, interval=1.0)
        check('刷新后自动恢复了历史消息（走 /chat/history）', okh, '耗时 %dms' % msh)
        dom3 = ev(SOURCES_JS) or {}
        evidence['afterReload'] = dom3
        items3 = (dom3.get('blocks') or [{}])[0].get('items') or []
        hrefs_after = [it.get('href') for it in items3]
        print('    刷新后：消息数=%s 来源块=%s 首条=%s'
              % (dom3.get('msgCount'), dom3.get('blockCount'), (hrefs_after[0] if hrefs_after else '（空）')))
        check('★ 刷新后来源块仍在（证明来源真的落了库，不是只在内存里过了一下）',
              (dom3.get('blockCount') or 0) >= 1, 'blockCount=%s' % dom3.get('blockCount'))
        check('★ 刷新后来源与刷新前逐条一致（同 url 同序）',
              hrefs_after == hrefs_before,
              '前 %d 条 / 后 %d 条，首条 %s'
              % (len(hrefs_before), len(hrefs_after),
                 '一致' if (hrefs_before[:1] == hrefs_after[:1]) else '★ 不一致'))
    else:
        check('刷新后自动恢复了历史消息（走 /chat/history）', False, '应用没起来，跳过')
        check('★ 刷新后来源块仍在（证明来源真的落了库）', False, '应用没起来，跳过')
        check('★ 刷新后来源与刷新前逐条一致（同 url 同序）', False, '应用没起来，跳过')

    # -------------------------------------------------------------- 4. 常识轮
    section('4. 凭常识的一轮：不许冒出"参考资料"')
    res2 = send_and_wait('1加1等于几', timeout=120)
    check('第二轮也拿到了回复', res2.get('ok'),
          'assistant %s → %s' % (res2.get('before'), res2.get('after')))
    dom2 = ev(SOURCES_JS) or {}
    evidence['afterNeither'] = dom2
    print('    DOM: 消息数=%s（助手 %s）来源块=%s'
          % (dom2.get('msgCount'), dom2.get('assistantCount'), dom2.get('blockCount')))
    check('★ 常识轮的回复**没有**来源块（来源块总数仍是 1，没跟着涨）',
          (dom2.get('blockCount') or 0) == (dom.get('blockCount') or 0),
          '搜索轮后=%s → 常识轮后=%s' % (dom.get('blockCount'), dom2.get('blockCount')))
    check('助手消息数确实涨了（证明这一轮真的答了，不是"没搜就没回复"）',
          (dom2.get('assistantCount') or 0) > (dom.get('assistantCount') or 0),
          '%s → %s' % (dom.get('assistantCount'), dom2.get('assistantCount')))

    # -------------------------------------------------------------- 5. 真点击 → 系统浏览器
    section('5. 真点一条来源：系统默认浏览器有没有真的把那个 url 取走')
    """
    上一版这里被我判成"机器验不了、请你自己点一下"。回头看其实**能验到底**：

      把某条来源的 href **临时改写到本机一个一次性 HTTP 服务**（`target`/`rel` 一律不动，
      走的仍是真实那条路），再用**完整鼠标序列**真的点它
      （★ 只发 press/release 打不开 `target=_blank`，这是踩过的坑）。

      那个一次性服务**真收到请求** ⇒ 整条链路是通的：
          点击 → 主进程 setWindowOpenHandler → shell.openExternal → 系统默认浏览器真的取了这个 url
      而不只是"DOM 里长得像链接"。这是"点了有没有反应"最强的机器判据。

    ⚠️ 副作用：这一步会真的弹出一个系统浏览器标签页（指向本机临时服务）。
    """
    srv_port = pick_free_port(CLICK_PORT)
    check('本机一次性探针服务已起（用来接住"系统浏览器真的来取 url"那一刻）',
          srv_port is not None, 'port=%s' % srv_port)
    if not srv_port:
        check('★ 点击来源后，系统默认浏览器**真的取走了这个 url**', False, '没抢到端口，跳过')
        check('★ 点完之后应用没被顶掉（说明 will-navigate / deny 生效）', False, '没抢到端口，跳过')
    else:
        start_click_server(srv_port)
        token = 'srcclick%d' % int(time.time())
        url = 'http://127.0.0.1:%d/%s' % (srv_port, token)
        check('点击之前探针服务没收到过请求（下面那条是这次点击带来的，不是残留）',
              len(HITS) == 0, '点击前命中数=%d' % len(HITS))

        # ① 定位 + **只改 href**（target/rel 一律不动 ⇒ 走的还是真实那条路）
        info = ev(
            "(() => {"
            "  const a = document.querySelector('.sources__item');"
            "  if (!a) return null;"
            "  a.scrollIntoView({block:'center'});"
            "  const r = a.getBoundingClientRect();"
            "  a.setAttribute('data-orig-href', a.getAttribute('href') || '');"
            "  a.setAttribute('href', " + json.dumps(url) + ");"
            "  return {x: Math.round(r.left + Math.min(r.width / 2, 40)),"
            "          y: Math.round(r.top + r.height / 2),"
            "          w: Math.round(r.width), h: Math.round(r.height),"
            "          target: a.getAttribute('target'), rel: a.getAttribute('rel'),"
            "          href: a.getAttribute('href'), orig: a.getAttribute('data-orig-href')};"
            "})()")
        print('    待点元素：%s' % (info,))
        check('★ 点击前 href 已改写到本机探针服务，但 target/rel 原样没动',
              bool(info) and info.get('href') == url and info.get('target') == '_blank',
              'href=%s target=%s rel=%s' % (info.get('href') if info else None,
                                            info.get('target') if info else None,
                                            info.get('rel') if info else None))

        # ② 真的点（完整鼠标序列）
        click_note = click_xy(info['x'], info['y']) if info else '没有可点的元素'
        check('真点了一下（完整鼠标序列 mouseMoved→Pressed→Released）',
              str(click_note).startswith('clicked'), str(click_note))

        # ③ 等系统浏览器来取
        hit, ms = wait_for_hit(token, timeout=25)
        check('★ 点击来源后，系统默认浏览器**真的取走了这个 url**（本机探针服务收到请求）',
              hit is not None,
              ('收到 %s（%dms）' % (hit[1], ms)) if hit else ('25s 内没等到请求 ⇒ 那一跳没走通'))

        # ④ 应用内不许被顶掉（will-navigate / deny 生效）
        after = ev("({href: location.href,"
                   "  input: Boolean(document.querySelector('.inputBar input')),"
                   "  msgs: document.querySelectorAll('.msg').length})") or {}
        stayed = bool(after.get('input')) and ('localhost:%d' % VITE_PORT) in str(after.get('href'))
        check('★ 点完之后应用没被顶掉（仍在应用里，说明 will-navigate / deny 生效）',
              stayed, 'href=%s input=%s msgs=%s' % (after.get('href'), after.get('input'),
                                                    after.get('msgs')))

        # ⑤ 还原 href（免得后面读到的 DOM 是改写过的）
        if info and info.get('orig'):
            ev("(() => { const a = document.querySelector('.sources__item');"
               "  if (a && a.getAttribute('data-orig-href'))"
               "    a.setAttribute('href', a.getAttribute('data-orig-href'));"
               "  return a && a.getAttribute('href'); })()")
        stop_click_server()
        evidence['clickProbe'] = {'port': srv_port, 'url': url, 'hits': HITS,
                                 'info': info, 'after': after}

    # -------------------------------------------------------------- 6. 收尾
    section('6. 收尾（不许留残留）')
    return 0


def _page_present():
    try:
        P.page('localhost:%d' % VITE_PORT, tries=1)
        return True
    except Exception:  # noqa: BLE001
        return False


if __name__ == '__main__':
    rc = 2
    db_note = ''
    try:
        rc = main()
    except Exception as e:  # noqa: BLE001
        check('主流程没抛异常', False, repr(e))
        rc = 2
    finally:
        # ★ 收尾必须无条件跑（探针里中途 return 会跳过收尾 = 进程泄漏 + 脏账号）
        stop_click_server()
        kill_all()
        try:
            db_note = cleanup_db()
        except Exception as e:  # noqa: BLE001
            db_note = '清理失败：%r' % e
        passed = sum(1 for r in results if r['ok'])
        failed = len(results) - passed
        print('\n===== 汇总：%d PASS / %d FAIL =====' % (passed, failed))
        for r in results:
            if not r['ok']:
                print('  FAIL %s :: %s' % (r['name'], r['detail']))
        print('收尾：测试账号已删=%s' % db_note)
        if os.path.exists(SHOT):
            print('截图：%s' % SHOT)
        evidence['results'] = results
        evidence['summary'] = {'pass': passed, 'fail': failed}
        with open(os.path.join(OUTDIR, 'sources-ui.json'), 'w', encoding='utf-8') as f:
            json.dump(evidence, f, ensure_ascii=False, indent=2)
    sys.exit(0 if rc == 0 and failed == 0 else 1)
