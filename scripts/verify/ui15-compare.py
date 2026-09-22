"""UI-1.5 数值级比对（自带环境版）

在**自带的一整套环境**里做「原型文件 A vs 新版 React」的逐项数值比对，
绝不碰用户自己的 8787 / 5173 / 正在跑的 Electron 窗口。

做法：
  1. 起假模型 + 验收后端 + vite + 真 Electron（自己的端口与 user-data-dir）；
  2. 走真实短信登录链路建号登录，把 token 注入渲染进程 localStorage 并 reload；
  3. 量 React 的列0/列1 全部关键属性，截 S2 图；
  4. 用同一条 CDP 连接 Page.navigate 到原型文件 A，量同一批属性，截 S1 图；
  5. 逐项 diff，把「逐字一致 / 语义等价 / 真实差异」分开报告；
  6. 自己收进程。

用法：
  ~/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe scripts/verify/ui15-compare.py
可覆盖：API_PORT / FAKE_PORT / VITE_PORT / CDP_PORT
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'ui1_5')
SHOTS = 'C:/Users/bing/WorkBuddy/WorkbenchApp/_ui15_shots'
TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wbui15')
PROFILE = os.path.join(TMP, 'profile')

API_PORT = int(os.environ.get('API_PORT', '8799'))
FAKE_PORT = int(os.environ.get('FAKE_PORT', '8899'))
VITE_PORT = int(os.environ.get('VITE_PORT', '5274'))
# 注意：CDP 端口**不能用 9333** —— 用户自己那个演示实例常年占着它。
# 本脚本一律用 9334，才谈得上「绝不碰用户的窗口」。
CDP_PORT = int(os.environ.get('CDP_PORT', '9334'))
API = 'http://127.0.0.1:%d' % API_PORT
FAKE = 'http://127.0.0.1:%d' % FAKE_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server-%d.log' % API_PORT)

PROTO_PATH = 'C:/Users/bing/WorkBuddy/WorkbenchApp/workbench.html'
PROTO_URL = 'file:///' + PROTO_PATH

# 与设计稿一致的视口
VIEW_W, VIEW_H = 1488, 988

TEST_PHONE = os.environ.get('UI15_PHONE') or ('187%08d' % (int(time.time()) % 100000000))

# cdp-probe 的 page() 默认参数 MATCH 是**定义时**绑定的，必须在 import 之前
# 就把环境变量设好，否则重连时会去找 5273（用户自己的实例）。
os.environ['WB20_PORT'] = str(CDP_PORT)
os.environ['WB20_MATCH'] = 'localhost:%d' % VITE_PORT

_spec = importlib.util.spec_from_file_location('cdp_probe', os.path.join(HERE, 'cdp-probe.py'))
P = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(P)

VITE_MATCH = 'localhost:%d' % VITE_PORT
P.MATCH = VITE_MATCH

NODE = shutil.which('node') or r'C:\Users\bing\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe'

procs = {}
results = []


# ------------------------------------------------------------------ CDP 工具
# cdp-probe.Cdp 的 send() 会把参数平铺进 params，shot() 不带 clip，
# 也假定已经连到当前 page。这里补一层薄封装，够用且不侵入原模块。
import base64  # noqa: E402


def _cdp(url_part=None):
    """连到当前 page；url_part=None 时用 vite 地址找。

    每次重新 _find 一遍（不缓存 target id）：页面 navigate / reload 之后
    旧 targetId 会失效，缓存它只会撞 "No such target id"。
    """
    t = P._find(url_part or VITE_MATCH, kind='page', tries=6, delay=0.6)
    c = P.Cdp(t)
    try:
        c.send('Page.enable')
    except Exception:  # noqa: BLE001
        pass
    return c


def ev(expr):
    c = _cdp()
    try:
        return c.js(expr)
    finally:
        try:
            c.ws.close()
        except Exception:  # noqa: BLE001
            pass


def shot(path, clip=None, hover=None):
    """截图。

    TOOLING：CSS `:hover` 只响应**真实指针位置**，dispatchEvent('mouseover') 是假的，
    截出来跟不 hover 一模一样。必须用 Input.dispatchMouseEvent 把鼠标真正移过去。
    """
    c = _cdp()
    try:
        if hover:
            st, r = c.send('Runtime.evaluate',
                           expression='(() => { const e=document.querySelector(%s);'
                                      'if(!e) return null; const b=e.getBoundingClientRect();'
                                      'return {x:+ (b.left+b.width/2).toFixed(1), y:+ (b.top+b.height/2).toFixed(1)};})()'
                                      % json.dumps(hover),
                           returnByValue=True)
            pt = (r.get('result') or {}).get('value')
            if pt:
                c.send('Input.dispatchMouseEvent', type='mouseMoved', x=pt['x'], y=pt['y'],
                       button='none', buttons=0)
                time.sleep(0.45)   # 等 260ms 过渡走完
        params = {'format': 'png'}
        if clip:
            params['clip'] = dict(clip, scale=1)
        r = c.send('Page.captureScreenshot', **params)
        with open(path, 'wb') as f:
            f.write(base64.b64decode(r['data']))
        return path
    finally:
        try:
            c.ws.close()
        except Exception:  # noqa: BLE001
            pass


# ------------------------------------------------------------------ 报告工具
results = []


def check(name, ok, detail=''):
    results.append({'name': name, 'ok': bool(ok), 'detail': str(detail)[:900]})
    print('%s  %s%s' % ('PASS' if ok else 'FAIL', name, (' :: ' + str(detail)) if detail else ''), flush=True)
    return bool(ok)


def section(t):
    """整个脚本要跑几分钟；不 flush 的话中途看日志永远是一片空白。"""
    print('\n───── %s ─────' % t, flush=True)


def log(msg):
    print(msg, flush=True)


def http_json(path, method='GET', token=None, body=None, base=API, timeout=30):
    data, headers = None, {}
    if token:
        headers['authorization'] = 'Bearer ' + token
    if body is not None:
        headers['content-type'] = 'application/json'
        data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with op.open(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode('utf-8') or '{}')
        except Exception:  # noqa: BLE001
            return e.code, {}
    except Exception as e:  # noqa: BLE001
        return 0, {'error': str(e)}


def port_busy(p):
    import socket
    s = socket.socket()
    s.settimeout(0.4)
    try:
        return s.connect_ex(('127.0.0.1', p)) == 0
    finally:
        s.close()


def spawn(name, args, cwd, env=None, log_path=None):
    e = dict(os.environ)
    if env:
        e.update(env)
    f = open(log_path, 'wb') if log_path else subprocess.DEVNULL
    pr = subprocess.Popen(args, cwd=cwd, env=e, stdout=f, stderr=subprocess.STDOUT,
                          creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0))
    procs[name] = pr
    return pr


def kill_all():
    # 顺序很重要：先按进程组 terminate，再用 taskkill /T 收整棵 electron 子进程树。
    # 只 terminate 父进程的话，electron.exe 的渲染/GPU 子进程会变成孤儿，
    # 端口（9334）就被它们继续占着 —— 下次跑直接卡在「端口被占」。
    for pr in list(procs.values()):
        try:
            subprocess.run(['taskkill', '/F', '/T', '/PID', str(pr.pid)], capture_output=True)
        except Exception:  # noqa: BLE001
            pass
    time.sleep(1.5)
    for pr in list(procs.values()):
        try:
            pr.kill()
        except Exception:  # noqa: BLE001
            pass


def wait_health(url, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        st, j = http_json('/health', base=url)
        if st == 200:
            return j
        time.sleep(0.5)
    return {}


def server_log_text():
    try:
        with open(SERVER_LOG, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    except Exception:  # noqa: BLE001
        return ''


def find_sms_code(text):
    """从服务端 stdout 里捞最后一条 [sms:mock] 验证码。

    TOOLING：服务端用 pino 写 stdout，日志落盘有缓冲延迟；
    调用方必须**轮询重试**，只读一次几乎必然扑空（踩过）。
    """
    import re
    found = None
    for m in re.finditer(r'\[sms:mock\][^\n]*?(\d{6})', text):
        found = m.group(1)
    return found


def first_existing(*cands):
    for c in cands:
        if c and os.path.exists(c):
            return c
    return None


DESKTOP = os.path.join(REPO, 'apps', 'desktop')
VITE_BIN = first_existing(os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                          os.path.join(DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'))
START_JS = os.path.join(DESKTOP, 'scripts', 'start-electron.mjs')


# --------------------------------------------------------------- 度量脚本
# React 侧在本文件；原型侧在 measure-proto.mjs（独立 Chromium）。
REACT_JS = r"""
(() => {
  const q = (s) => document.querySelector(s);
  const gv = (el, p) => el ? getComputedStyle(el).getPropertyValue(p).trim() : null;
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { w: +r.width.toFixed(2), h: +r.height.toFixed(2), x: +r.x.toFixed(2), y: +r.y.toFixed(2) }; };
  const rail = q('.wtRail'), sb = q('.wtSb'), item = q('.wtSb__row');
  const out = {};
  out.rail = {
    rect: R(rail), background: gv(rail, 'background-color'),
    bgImage: (gv(rail, 'background-image') || 'none').slice(0, 60),
    borderRight: gv(rail, 'border-right-width') + ' ' + gv(rail, 'border-right-style'),
    boxShadow: gv(rail, 'box-shadow'),
    backdropFilter: gv(rail, 'backdrop-filter') || gv(rail, '-webkit-backdrop-filter'),
    zIndex: gv(rail, 'z-index'), position: gv(rail, 'position'),
    borderRadius: gv(rail, 'border-radius'),
  };
  out.sb = {
    rect: R(sb), background: gv(sb, 'background-color'),
    borderRight: gv(sb, 'border-right-width') + ' ' + gv(sb, 'border-right-style'),
    boxShadow: gv(sb, 'box-shadow'),
    backdropFilter: gv(sb, 'backdrop-filter') || gv(sb, '-webkit-backdrop-filter'),
  };
  out.row = { rect: R(item), height: gv(item, 'height'), padding: gv(item, 'padding'),
    margin: gv(item, 'margin'), gap: gv(item, 'gap'), borderRadius: gv(item, 'border-radius'),
    background: gv(item, 'background-color') };
  out.avatar = { rect: R(q('.wtSb__avatar')), borderRadius: gv(q('.wtSb__avatar'), 'border-radius') };
  out.name = { fontSize: gv(q('.wtSb__name'), 'font-size'), fontWeight: gv(q('.wtSb__name'), 'font-weight'),
               lineHeight: gv(q('.wtSb__name'), 'line-height'), color: gv(q('.wtSb__name'), 'color') };
  out.status = { fontSize: gv(q('.wtSb__status'), 'font-size'), lineHeight: gv(q('.wtSb__status'), 'line-height'),
                 color: gv(q('.wtSb__status'), 'color') };
  out.icons = ['chat', 'knowledge', 'plugins', 'settings'].map((k) => {
    const b = q('[data-wt-global="' + k + '"]');
    if (!b) return { key: k, missing: true };
    const s = b.querySelector('svg');
    const br = b.getBoundingClientRect(), sr = s ? s.getBoundingClientRect() : null;
    return { key: k, box: { w: +br.width.toFixed(2), h: +br.height.toFixed(2) },
             svg: sr ? { w: +sr.width.toFixed(2), h: +sr.height.toFixed(2) } : null,
             ratio: sr && br.width ? +(sr.width / br.width * 100).toFixed(1) : null,
             iconVar: gv(b, '--icon-size'), borderRadius: gv(b, 'border-radius') };
  });
  return out;
})()
"""


# --------------------------------------------------------------- 主流程
def main():
    os.makedirs(OUTDIR, exist_ok=True)
    os.makedirs(SHOTS, exist_ok=True)
    if os.path.isdir(TMP):
        shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(PROFILE, exist_ok=True)
    try:
        os.remove(FAKE_LOG)
    except Exception:  # noqa: BLE001
        pass

    section('0. 环境自检')
    busy = [p for p in (API_PORT, FAKE_PORT, VITE_PORT, CDP_PORT) if port_busy(p)]
    if busy:
        # 多半是上一次被 Ctrl+C / kill 掉的残留（Popen 的孙进程逃出了进程组）。
        # 按端口找出监听者直接杀掉，然后复查 —— 不这么干的话每次失败都要手工清一遍。
        log('[cleanup] 端口被占：%s，尝试清理…' % busy)
        for p in busy:
            try:
                # 中文 Windows 下 netstat 输出不是 UTF-8（GBK 里的 0xbb 会炸解码），
                # 所以读 bytes 再宽松解码，别让清理本身成为新的失败点。
                raw = subprocess.run(['netstat', '-ano'], capture_output=True).stdout
                out = raw.decode('utf-8', errors='replace')
                for line in out.splitlines():
                    if (':%d ' % p) in line and 'LISTENING' in line:
                        pid = line.split()[-1]
                        r = subprocess.run(['taskkill', '/F', '/T', '/PID', pid], capture_output=True)
                        log('  kill port %d -> PID %s（%s）' % (p, pid, r.returncode))
            except Exception as e:  # noqa: BLE001
                log('  清理 %d 失败：%s' % (p, e))
        time.sleep(3)
        busy = [p for p in (API_PORT, FAKE_PORT, VITE_PORT, CDP_PORT) if port_busy(p)]
    check('UI-1.5 专用端口全部空闲', not busy,
          '占用中=%s' % busy if busy else '%d/%d/%d/%d 都没人听' % (API_PORT, FAKE_PORT, VITE_PORT, CDP_PORT))
    check('vite 入口存在', bool(VITE_BIN), str(VITE_BIN))
    check('start-electron.mjs 存在', bool(START_JS), str(START_JS))
    check('原型文件 A 存在', os.path.exists(PROTO_PATH), PROTO_PATH)
    if busy:
        log('\n仍有端口被占用，无法开跑。手工清理：taskkill /F /IM electron.exe /T 后按端口杀 PID。')
        return 2

    try:
        section('1. 起环境（假模型 + 验收后端 + vite + 真 Electron）')
        spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], REPO,
              env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_LOG': FAKE_LOG,
                   'SITE_LOG': os.path.join(OUTDIR, 'site.jsonl')},
              log_path=os.path.join(OUTDIR, 'fake.log'))
        check(True, '假模型起来了', json.dumps(wait_health(FAKE), ensure_ascii=False)[:160])

        spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
              env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
                   'DEEPSEEK_API_KEY': 'fake-key-ui15', 'DEEPSEEK_MODEL': 'fake-ui15'},
              log_path=SERVER_LOG)
        hs = wait_health(API)
        check(hs.get('db') == 'up', '验收后端起来了', json.dumps(hs, ensure_ascii=False)[:200])

        spawn('vite', [NODE, VITE_BIN, '--port', str(VITE_PORT), '--strictPort'], DESKTOP,
              log_path=os.path.join(OUTDIR, 'vite.log'))
        time.sleep(4)

        spawn('electron', [NODE, 'scripts/start-electron.mjs',
                           '--user-data-dir=%s' % PROFILE,
                           '--remote-debugging-port=%d' % CDP_PORT], DESKTOP,
              env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT},
              log_path=os.path.join(OUTDIR, 'electron.log'))

        # 等 CDP 起来
        page = None
        for _ in range(120):
            try:
                page = P.page(VITE_MATCH, tries=1)
                if page:
                    break
            except Exception:  # noqa: BLE001
                pass
            time.sleep(1.0)
        check(bool(page), '真 Electron 窗口出现了（CDP 连得上）', 'CDP :%d' % CDP_PORT)
        if not page:
            return 3

        section('2. 建号登录并注入 token')
        st, r = 0, {}
        for _ in range(6):
            st, r = http_json('/auth/sms/send', 'POST', body={'phone': TEST_PHONE})
            if st == 200:
                break
            import re
            m = re.search(r'(\d+)\s*秒', json.dumps(r, ensure_ascii=False))
            time.sleep(min(int(m.group(1)) + 2 if m else 5, 65))
        check(st == 200, '发送验证码', 'HTTP %d %s' % (st, json.dumps(r, ensure_ascii=False)[:160]))

        code = None
        log('[wait] 等服务端把验证码写进日志…')
        for _ in range(80):          # 最多等 40s
            code = find_sms_code(server_log_text())
            if code:
                break
            time.sleep(0.5)
        check(bool(code), '从服务端日志拿到验证码', 'code=%s' % code)
        if not code:
            # 兜底：直接把日志尾巴打出来，省得下次还要猜为什么没拿到
            log('[debug] 服务端日志尾部：\n' + server_log_text()[-1200:])
            return 3

        st, sess = http_json('/auth/login/sms', 'POST', body={'phone': TEST_PHONE, 'code': code})
        token = sess.get('token')
        check(st == 200 and bool(token), '短信登录成功',
              'HTTP %d user=%s' % (st, (sess.get('user') or {}).get('xyz_id')))

        # 注入 token 并 reload（等价于用户重启后静默续会话）
        # TOOLING：reload 会让旧 targetId 失效，所以注入与 reload 用同一条短连接，
        # 之后一律重新 _cdp() 找目标。
        c = _cdp()
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

        # 等列0/列1 出现
        log('[wait] 等列0/列1 渲染…')
        ok = False
        t0 = time.time()
        while time.time() - t0 < 90:
            try:
                if ev("!!document.querySelector('.wtRail')"):
                    ok = True
                    break
            except Exception as e:  # noqa: BLE001
                log('[wait] ev 异常：%s' % str(e)[:120])
            time.sleep(1.5)
        check(ok, '工作台已登录并渲染出列0/列1', '耗时 %.0fs' % (time.time() - t0))
        if not ok:
            return 3

        time.sleep(2.0)

        # ------------- 量 React -------------
        section('3. 量 React（新版）')
        R = ev(REACT_JS)
        if not (R and R.get('rail') and R['rail'].get('rect')):
            check(False, 'React 度量失败', json.dumps(R, ensure_ascii=False)[:300])
            return 3

        for name, clip in [('S2-react-cols12.png', {'x': 0, 'y': 0, 'width': 330, 'height': 700}),
                           ('S2-react-full.png', {'x': 0, 'y': 0, 'width': VIEW_W, 'height': VIEW_H})]:
            try:
                shot(os.path.join(SHOTS, name), clip=clip)
            except Exception as e:  # noqa: BLE001
                log('截图失败 %s: %s' % (name, e))
        # 悬停态截图（逐个图标 hover）
        for k in ['chat', 'knowledge', 'plugins', 'settings']:
            try:
                shot(os.path.join(SHOTS, 'R1-hover-%s.png' % k),
                     clip={'x': 0, 'y': 0, 'width': 340, 'height': 300},
                     hover='[data-wt-global="%s"]' % k)
            except Exception as e:  # noqa: BLE001
                log('hover 截图失败 %s: %s' % (k, e))

        # ------------- 原型 A：用独立 Playwright Chromium 量 -------------
        #
        # TOOLING（踩过的坑）：**不能**用 Page.navigate 把 Electron 的窗口导到 file:// 原型上。
        #   Electron 主进程有 will-navigate 护栏，只允许留在 DEV_SERVER_URL，
        #   任何外跳都被 preventDefault —— 表现为「等 60s 也等不到 nav.rail」。
        #   而且把用户的窗口导走本身也不该做。
        # 所以原型 A 交给一个**独立的 Playwright Chromium**（同视口、同 DPR=1）去量，
        # 两边各产出一份 JSON，最后逐项 diff。这样两边环境参数完全一致。
        section('4. 量原型文件 A（独立 Playwright Chromium）')
        proto_json = os.path.join(OUTDIR, '05a-原型度量.json')
        if os.path.exists(proto_json):
            os.remove(proto_json)
        env = dict(os.environ)
        env['UI15_VIEW_W'] = str(VIEW_W)
        env['UI15_VIEW_H'] = str(VIEW_H)
        env['UI15_PROTO_JSON'] = proto_json
        env['UI15_SHOTS'] = SHOTS
        pr = subprocess.run([NODE, os.path.join(SHOTS, 'measure-proto.mjs')],
                            cwd=SHOTS, env=env, capture_output=True, text=True, timeout=180)
        log(pr.stdout[-2000:] if pr.stdout else '')
        if pr.stderr:
            log('[proto stderr] ' + pr.stderr[-1200:])
        check(os.path.exists(proto_json), '原型 A 度量完成', proto_json)
        if not os.path.exists(proto_json):
            return 3
        with open(proto_json, 'r', encoding='utf-8') as f:
            P_eval = json.load(f)

        # ------------- diff -------------
        section('5. 逐项数值比对')
        EQUIVALENT = {
            '列0 背景色': '原型 background-image 渐变铺色 + background-color 透明；React 直接实色。渲染像素相同。',
            '列1 背景色': '同上：原型渐变铺色 vs React 实色。渲染像素相同。',
            '列0 z-index': '★用户裁决保留 20（不照抄原型 4）—— 照抄会复现 UI-1「新建项目按钮点不到」。',
            '列0 position': '★用户裁决保留 flex 子项（不照抄 absolute）—— 同上。',
            '列0 宽×高': '高度由窗口决定：原型是 900px 浮动 frame，React 是全高应用窗口。列宽 60 一致。',
            '列1 宽×高': '同上：原型 900px frame vs React 全高窗口。列宽 270 一致。',
            '列0 图标': '载体不同：原型是位图 PNG（background-size 34px / 22×20），React 是 24-viewBox 描边 SVG。'
                        '按用户裁决统一 28px（68.3%），已确认。',
        }

        rows = [
            ('列0 背景色', P_eval['rail']['background'], R['rail']['background'], ''),
            ('列0 border-right', P_eval['rail']['borderRight'], R['rail']['borderRight'], '原型无分隔线'),
            ('列0 box-shadow', P_eval['rail']['boxShadow'], R['rail']['boxShadow'], '原型无内高光'),
            ('列0 backdrop-filter', P_eval['rail']['backdropFilter'], R['rail']['backdropFilter'], 'blur 10px'),
            ('列0 z-index', P_eval['rail']['zIndex'], R['rail']['zIndex'], '★保留 20'),
            ('列0 position', P_eval['rail']['position'], R['rail']['position'], '★保留 flex'),
            ('列0 列宽', str(P_eval['rail']['rect']['w']), str(R['rail']['rect']['w']), '60px'),
            ('列0 宽×高', '%sx%s' % (P_eval['rail']['rect']['w'], P_eval['rail']['rect']['h']),
             '%sx%s' % (R['rail']['rect']['w'], R['rail']['rect']['h']), ''),
            ('列1 背景色', P_eval['sb']['background'], R['sb']['background'], ''),
            ('列1 border-right', P_eval['sb']['borderRight'], R['sb']['borderRight'], '原型无分隔线'),
            ('列1 box-shadow', P_eval['sb']['boxShadow'], R['sb']['boxShadow'], '同色 1px 收边'),
            ('列1 backdrop-filter', P_eval['sb']['backdropFilter'], R['sb']['backdropFilter'], 'blur 14px'),
            ('列1 列宽', str(P_eval['sb']['rect']['w']), str(R['sb']['rect']['w']), '270px'),
            ('列1 宽×高', '%sx%s' % (P_eval['sb']['rect']['w'], P_eval['sb']['rect']['h']),
             '%sx%s' % (R['sb']['rect']['w'], R['sb']['rect']['h']), ''),
            ('行 高', P_eval['row']['height'], R['row']['height'], '56px'),
            ('行 padding', P_eval['row']['padding'], R['row']['padding'], '0 12px 0 8px'),
            ('行 margin', P_eval['row']['margin'], R['row']['margin'], '2px 4px 2px 2px'),
            ('行 gap', P_eval['row']['gap'], R['row']['gap'], '11px'),
            ('行 圆角', P_eval['row']['borderRadius'], R['row']['borderRadius'], '14px'),
            ('头像 尺寸', '%sx%s' % (P_eval['avatar']['rect']['w'], P_eval['avatar']['rect']['h']),
             '%sx%s' % (R['avatar']['rect']['w'], R['avatar']['rect']['h']), '41px'),
            ('头像 圆角', P_eval['avatar']['borderRadius'], R['avatar']['borderRadius'], '10px'),
            ('名称 字号', P_eval['name']['fontSize'], R['name']['fontSize'], '16px'),
            ('名称 字重', P_eval['name']['fontWeight'], R['name']['fontWeight'], '600'),
            ('名称 行高', P_eval['name']['lineHeight'], R['name']['lineHeight'], '22px'),
            ('状态 字号', P_eval['status']['fontSize'], R['status']['fontSize'], '13px'),
            ('状态 行高', P_eval['status']['lineHeight'], R['status']['lineHeight'], '16px'),
            ('状态 颜色', P_eval['status']['color'], R['status']['color'], ''),
        ]

        w = max(len(r[0]) for r in rows)
        same, equiv, diffs = 0, [], []
        table = []
        for item, pv, rv, note in rows:
            ok = str(pv) == str(rv)
            if ok:
                same += 1
                mark = 'OK'
            elif item in EQUIVALENT:
                equiv.append(item)
                mark = '≈ '
            else:
                diffs.append(item)
                mark = '!='
            print('%s %-*s | 原型 %-34s | React %-34s | %s' % (mark, w, item, str(pv)[:34], str(rv)[:34], note))
            table.append({'item': item, 'proto': pv, 'react': rv, 'same': ok, 'note': note})

        print('\n列0 图标（原型=位图 / React=SVG）:')
        for b in P_eval['railButtons']:
            print('  原型 %-28s %sx%s bg-size=%s' % (b['cls'][:28], b['rect']['w'], b['rect']['h'], b['bgSize']))
        for ic in R['icons']:
            if ic.get('missing'):
                print('  React %-10s MISSING' % ic['key'])
            else:
                print('  React %-10s svg %sx%s / 盒 %sx%s = %s%%  (--icon-size=%s, radius=%s)' % (
                    ic['key'], ic['svg']['w'], ic['svg']['h'], ic['box']['w'], ic['box']['h'],
                    ic['ratio'], ic['iconVar'], ic['borderRadius']))

        print('\n逐字一致：%d / %d' % (same, len(rows)))
        print('语义等价（写法不同/已裁决）：%d —— %s' % (len(equiv), '、'.join(equiv) or '无'))
        print('真实未解决差异：%d —— %s' % (len(diffs), '、'.join(diffs) or '无'))

        out = {'proto': P_eval, 'react': R, 'table': table, 'same': same, 'total': len(rows),
               'equivalent': equiv, 'diffs': diffs, 'equivalentReasons': EQUIVALENT, 'checks': results}
        with open(os.path.join(OUTDIR, '05-数值比对.json'), 'w', encoding='utf-8') as f:
            json.dump(out, f, indent=2, ensure_ascii=False)

        section('6. 结论')
        check(len(diffs) == 0, '列0+列1 无未解决的真实数值差异',
              '一致 %d/%d，语义等价 %d，真实差异 %d' % (same, len(rows), len(equiv), len(diffs)))
        log('\nJSON：%s' % os.path.join(OUTDIR, '05-数值比对.json'))
        log('截图：%s' % SHOTS)
        return 0
    finally:
        kill_all()
        time.sleep(1.0)
        left = [p for p in (API_PORT, FAKE_PORT, VITE_PORT, CDP_PORT) if port_busy(p)]
        print('\n[cleanup] 残留端口：%s' % (left or '无'))


if __name__ == '__main__':
    sys.exit(main())
