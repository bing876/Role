"""侦查探针：**步数上限（step_budget）自动停止后，用户在对话里说「继续」——AI 还动不动手？**

只做**侦查取证**，不改任何产品代码。

复现路径（全程真机、走真实用户入口，不直接调内部 API 走捷径）：
  1. 起一整套独立环境（假模型 + 假电商站 + 验收后端 + vite + 真 Electron），端口全部另起；
  2. 走真实短信登录链路进工作台；
  3. 用**真实聊天输入框**打字发一条「长任务」指令
     （假模型内建的『长任务』剧本 14 步 > 服务端上限 10 步，专门用来撞 step_budget）；
  4. 等它自己撞上步数上限停下来 —— 判据是界面上出现服务端那句原文「一轮最多走 …」；
  5. 再用**真实聊天输入框**输入「继续」并点发送；
  6. 之后连续采样 90 秒，回答三个问题：
       Q1 AI 有没有真的调用浏览器动作？（内嵌页客观指标：滚动位置 / 输入框值 / 点击数）
       Q2 「继续」这句话进了哪套逻辑？（假模型请求转储里 goal 是「任务目标」还是「(无目标)」）
       Q3 是接回原循环还是新建了一轮？（服务端日志里有没有第二个 loopId）

★ 决定性判据（Q2）：
   假模型用「提示词里有没有 `任务目标：` 这一行」来给每次请求打 goal 标签。
     - 工具循环（toolLoop）的第一条用户消息里必有「任务目标：…」→ goal = 任务原文；
     - 普通聊天（/chat/stream 非 taskMode）的提示词里没有这一行 → goal = '(无目标)'。
   所以「继续」发出后新增的请求：
     goal = 任务原文  → 这句话真的把驾驶接回去了（走的是 loop，手还在动）；
     goal = (无目标)  → 它被当成了一句普通闲聊（走的是 chat，只有嘴没有手）。

用法：
  python scripts/verify/step-budget-continue-probe.py
可覆盖：API_PORT / FAKE_PORT / VITE_PORT / CDP_PORT / FAKE_DELAY_MS / WATCH_SEC
"""
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'step-budget')
TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wbstepbudget')
PROFILE = os.path.join(TMP, 'profile')
DESKTOP = os.path.join(REPO, 'apps', 'desktop')

# 端口一律另起，绝不碰用户自己的 8787 / 5173 / 8901
API_PORT = int(os.environ.get('API_PORT', '8793'))
FAKE_PORT = int(os.environ.get('FAKE_PORT', '8895'))
VITE_PORT = int(os.environ.get('VITE_PORT', '5181'))
CDP_PORT = int(os.environ.get('CDP_PORT', '9343'))
API = 'http://127.0.0.1:%d' % API_PORT
FAKE = 'http://127.0.0.1:%d' % FAKE_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server-%d.log' % API_PORT)
# 每步模型思考耗时：太短会让任务在脚本采样前就跑完，太长则等待过久。
FAKE_DELAY_MS = int(os.environ.get('FAKE_DELAY_MS', '700'))
# 发「继续」之后的观测窗口
WATCH_SEC = int(os.environ.get('WATCH_SEC', '90'))
SHOP_URL = '%s/shop' % FAKE
SHOP_KEY = '127.0.0.1:%d' % FAKE_PORT
# ★ 关键词『长任务』是假模型内建的 14 步剧本（> 服务端上限 10 步）
#
# ⚠️ 必须带**绝对网址**，不能写「在商城里…」：桌面端会把「在 X 上/里」当成
# 「打开 X 这个网站」的指令去查内置站点表，「商城」不在表里 → 直接回
# 「我认不出「商城」是哪个网站」，**压根不会发车**（第一版探针就栽在这里）。
# 默认走假模型内建的 14 步「长任务」剧本（> 旧上限 10）。
# 想验更长的环节就覆盖它：目标里**不带**剧本关键词时，假模型会 read_page 到 FAKE_STEPS(30) 步才收尾，
# 正好用来验证「30 步的整个环节也能一口气跑完」（旧行为会在 10/20/30 步各掐断一次）。
GOAL = os.environ.get('PROBE_GOAL') or (
    '打开 http://127.0.0.1:%d/shop，长任务：搜索无线鼠标并加入购物车' % FAKE_PORT)
# 兜底句式（第一条没发车时用走「当前这张页」的那条路）
GOAL_FALLBACK = '在这个页面上，长任务：搜索无线鼠标并加入购物车'
CONTINUE_TEXT = '继续'
TEST_PHONE = os.environ.get('PR_PHONE') or ('186%08d' % (int(time.time()) % 100000000))
# 反证模式 A：把步数闸配回 10（旧行为），脚本必须**反过来**判失败。
# 用环境变量注入而不是改产品代码 —— 反证不该碰源码，改回来也更干净。
REVERT = os.environ.get('REVERT') == '1'
# 反证模式 B（超限）：让任务步数**超过硬兜底**，验证兜底真的会拦住它。
# 硬兜底改成 50 之后，这条反证就是「50 步到底拦不拦得住」的唯一证明。
OVERRUN = os.environ.get('OVERRUN') == '1'
# 假模型一个剧本最多走几步（目标不命中剧本关键词时会 read_page 到这么多步才收尾）
FAKE_STEPS = int(os.environ.get('FAKE_STEPS', '30'))
HARD_CAP = int(os.environ.get('HARD_CAP', '50'))
if OVERRUN:
    # 必须严格大于硬兜底，否则根本测不到「被拦住」
    FAKE_STEPS = max(FAKE_STEPS, HARD_CAP + 10)
    # 目标里**不带**任何剧本关键词 → 假模型会一路 read_page 到 FAKE_STEPS 步才收尾，
    # 正好用来撞硬兜底（用 14 步剧本的话压根走不到 50 步，测不出来）
    GOAL = '打开 http://127.0.0.1:%d/shop，把这个页面完整看一遍并把看到的东西整理出来' % FAKE_PORT

os.environ['WB20_PORT'] = str(CDP_PORT)
os.environ['WB20_MATCH'] = 'localhost:%d' % VITE_PORT

_spec = importlib.util.spec_from_file_location('cdp_probe', os.path.join(HERE, 'cdp-probe.py'))
P = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(P)

NODE = 'node'
LINES = []
PROCS = []


def section(t):
    print('\n' + '=' * 78)
    print(t)
    print('=' * 78)


def say(*a):
    s = ' '.join(str(x) for x in a)
    print(s)
    LINES.append(s)


FAILS = []
CHECKS = 0


def check(name, ok, note=''):
    """记一条断言。**条数必须真数出来** —— 写死成「3 条」这种常量会骗人
    （本脚本三种模式断言数不同，写死必然报错数）。"""
    global CHECKS
    CHECKS += 1
    tag = 'PASS' if ok else 'FAIL'
    say('  [%s] %s%s' % (tag, name, ('  —— ' + str(note)) if note else ''))
    if not ok:
        FAILS.append(name)
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
    try:
        P._http('/json/list', tries=1)
        return True
    except Exception:
        return False


def wait_until(fn, timeout=60, interval=0.5):
    t0, last = time.time(), None
    while time.time() - t0 < timeout:
        if not alive():
            return False, '__window_gone__', int((time.time() - t0) * 1000)
        try:
            last = fn()
        except Exception:
            last = None
        if last:
            return True, last, int((time.time() - t0) * 1000)
        time.sleep(interval)
    return False, last, int((time.time() - t0) * 1000)


def spawn(tag, cmd, cwd, env=None, log=None):
    e = dict(os.environ)
    if env:
        e.update({k: str(v) for k, v in env.items()})
    f = open(log, 'wb') if log else subprocess.DEVNULL
    p = subprocess.Popen(cmd, cwd=cwd, env=e, stdout=f, stderr=subprocess.STDOUT)
    PROCS.append((tag, p))
    say('  · 起 %s（pid=%d）' % (tag, p.pid))
    return p


def ev(expr):
    """在宿主页（工作台 UI）里执行 JS。用 c.js 不用 c.jsf（jsf 没有 return，单表达式会求值为 undefined）。"""
    c = P.Cdp()
    try:
        return c.js(expr)
    finally:
        try:
            c.ws.close()
        except Exception:
            pass


def eva(expr):
    """求值并 await Promise（window.workbench.* 都是 ipcRenderer.invoke，返回 Promise）。"""
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


def webviews():
    try:
        return ev(P.WEBVIEWS_JS)['list']
    except Exception:
        return []


def guest_cdp(url_part):
    """找内嵌页（webview）的 CDP 目标：先按 webContentsId 精确命中，再退回按 URL。"""
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


# ---------------------------------------------------------------- 取证读数

# 内嵌页探针：装一次，之后只读。
#   心跳 hb 证明「页面本身活着」；scrollMax / inputs / clicks / values 证明「AI 真的动了手」。
#   三者分开记，是为了把「页面自己活着」和「AI 在动作」区分开 —— 只测前者会把假动作当成真动作。
PROBE_JS = r"""
(() => {
  if (!window.__probe) {
    window.__probe = { hb: 0, scrollMax: 0, inputs: 0, clicks: 0, t0: Date.now() };
    window.addEventListener('scroll', () => {
      window.__probe.scrollMax = Math.max(window.__probe.scrollMax, Math.round(window.scrollY));
    }, true);
    window.addEventListener('input', () => { window.__probe.inputs += 1; }, true);
    window.addEventListener('click', () => { window.__probe.clicks += 1; }, true);
    setInterval(() => {
      window.__probe.hb += 1;
      window.__probe.scrollMax = Math.max(window.__probe.scrollMax, Math.round(window.scrollY));
    }, 200);
  }
  const els = Array.from(document.querySelectorAll('input,textarea'));
  return {
    hb: window.__probe.hb,
    scrollMax: window.__probe.scrollMax,
    scrollY: Math.round(window.scrollY),
    inputs: window.__probe.inputs,
    clicks: window.__probe.clicks,
    url: location.href,
    title: document.title,
    values: els.map(e => (e.value || '')).join('|').slice(0, 160),
    docH: document.documentElement.scrollHeight,
  };
})()
"""


def page_probe():
    return guest_js(SHOP_KEY, PROBE_JS)


def chat_text():
    try:
        return ev('(document.body.innerText||"")') or ''
    except Exception:
        return ''


def chat_tail(n=500):
    return chat_text().replace('\n', ' ⏎ ')[-n:]


def llm_calls(ev_name='req'):
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
                if c.get('ev') != ev_name:
                    continue
                out.append(c)
    except Exception:
        pass
    return out


def classify_calls():
    """把每次模型请求按**来源**分类（靠提示词原文分辨，不猜）。

      · 提示词里有「任务目标：…」→ 工具循环（toolLoop）在问下一步 —— **手**那条路；
      · 提示词里有「记录如下：…」→ 记忆抽取（memories.ts）在抽档案 —— 噪声，两条路都不是；
      · 其余 → 普通聊天（/chat/stream 非 taskMode）—— **只有嘴**那条路。

    ★ 为什么必须分出「记忆抽取」：它每轮都可能跑一次，而且同样不带「任务目标：」，
      混进「聊天」计数会让「继续走了纯聊天」这条结论失去意义（第一版就踩了这个）。
    """
    out = {'loop': 0, 'chat': 0, 'memory': 0}
    for c in llm_calls('reqdump'):
        msg = c.get('msg') or ''
        if '记录如下：' in msg:
            out['memory'] += 1
        elif '任务目标：' in msg:
            out['loop'] += 1
        else:
            out['chat'] += 1
    return out


def loop_ids():
    """服务端日志里出现过的所有 loopId（按顺序去重）"""
    txt = server_log()
    seen = []
    for m in re.finditer(r'(loop_[A-Za-z0-9_]+)', txt):
        if m.group(1) not in seen:
            seen.append(m.group(1))
    return seen


def server_log():
    try:
        with open(SERVER_LOG, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    except Exception:
        return ''


def budget_hit():
    """步数上限有没有撞上：界面上出现服务端那句原文。

    ⚠️ 判据要跟着**话术**走：上限提示的文案改成「已经走了 N 步还没做完（这是防空转的
    兜底上限），我先停下来」之后，只认旧的「一轮最多走」就永远匹配不上 ——
    于是反证会假 FAIL（步数闸明明生效了，脚本却说没生效）。两种文案都认。
    """
    t = chat_text()
    return '一轮最多走' in t or ('还没做完' in t and '我先停下来' in t)


def snapshot(label):
    """一次全量取证"""
    calls = llm_calls('req')
    k = classify_calls()
    return {
        'label': label,
        'at': time.strftime('%H:%M:%S'),
        'llm_req_total': len(calls),
        'llm_req_loop': k['loop'],
        'llm_req_chat': k['chat'],
        'llm_req_memory': k['memory'],
        'loops': loop_ids(),
        'page': page_probe(),
        'chat_tail': chat_tail(320),
    }


def type_and_send(text):
    """★ 真实用户输入：focus 输入框 → 清空 React 受控值 → 真打字 → 点「发送」按钮。

    不直接调 window.workbench.*，因为本探针要复现的就是「用户在对话里打一句话」这条路径。
    """
    c = P.Cdp()
    try:
        c.js("document.querySelector('.inputBar input').focus()")
        c.js("""
(()=>{const el=document.querySelector('.inputBar input');
 if(!el) return 'NO_INPUT';
 const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
 s.call(el,''); el.dispatchEvent(new Event('input',{bubbles:true})); return 'OK';})()
""")
        time.sleep(0.3)
        c.send('Input.insertText', text=text)
        c.js("document.querySelector('.inputBar input').dispatchEvent(new Event('input',{bubbles:true}))")
        time.sleep(0.4)
        dom_value = c.js("document.querySelector('.inputBar input').value")
        r = c.js("""
(()=>{const bs=Array.from(document.querySelectorAll('.inputBar button'));
 const b=bs.find(x=>/发送/.test(x.innerText||''));
 if(!b) return 'NO_BTN';
 if(b.disabled) return 'DISABLED';
 b.click(); return 'CLICKED';})()
""")
        return {'dom_value': dom_value, 'click': r}
    finally:
        try:
            c.ws.close()
        except Exception:
            pass


def click_continue_button():
    """★ 对照组：点界面上那个「继续」按钮（已验收的「暂停/继续」那条路的入口）。

    用它和「在对话里说继续」做 A/B —— 同一个卡住的任务、同一个等待态，
    两条入口分别试一次，谁真的把驾驶接回去一目了然。
    """
    c = P.Cdp()
    try:
        return c.js("""
(()=>{const bs=Array.from(document.querySelectorAll('button'));
 const b=bs.find(x=>(x.innerText||'').trim()==='继续' && !x.disabled);
 if(!b) return 'NO_BTN';
 const cls=b.className||''; b.click(); return 'CLICKED:'+cls;})()
""")
    finally:
        try:
            c.ws.close()
        except Exception:
            pass


def shot(name):
    try:
        c = P.Cdp()
        try:
            c.shot(os.path.join(OUTDIR, name))
            return name
        finally:
            try:
                c.ws.close()
            except Exception:
                pass
    except Exception as e:
        return '截图失败：%s' % e


def first_existing(*cands):
    for p in cands:
        if p and os.path.exists(p):
            return p
    return None


def port_busy(port):
    import socket
    s = socket.socket()
    s.settimeout(0.4)
    try:
        return s.connect_ex(('127.0.0.1', port)) == 0
    finally:
        s.close()


# ---------------------------------------------------------------- 收尾

def cleanup_all():
    for tag, p in PROCS:
        try:
            p.terminate()
        except Exception:
            pass
    time.sleep(1.5)
    for tag, p in PROCS:
        try:
            if p.poll() is None:
                p.kill()
        except Exception:
            pass
    # 验收脚本自己起的环境，自己收干净（不留孤儿进程占着端口）
    for exe in ('electron.exe', 'node.exe'):
        pass
    say('\n  · 已停掉本轮起的 %d 个子进程' % len(PROCS))


def finish(code=0):
    cleanup_all()
    os.makedirs(OUTDIR, exist_ok=True)
    with open(os.path.join(OUTDIR, 'step-budget-continue-probe.log'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(LINES) + '\n')
    say('\n日志：docs/acceptance/step-budget/step-budget-continue-probe.log')
    sys.exit(code)


# ---------------------------------------------------------------- 主流程

def main():
    os.makedirs(OUTDIR, exist_ok=True)
    shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(PROFILE, exist_ok=True)
    # 上一轮的假模型日志必须清掉，否则 goal 计数会把旧轮算进来
    if os.path.exists(FAKE_LOG):
        os.remove(FAKE_LOG)

    VITE_BIN = first_existing(os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                              os.path.join(DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'))
    ELECTRON_EXE = first_existing(os.path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'),
                                  os.path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe'))
    START_JS = os.path.join(DESKTOP, 'scripts', 'start-electron.mjs')

    section('0. 环境自检')
    for label, path in [('vite 入口', VITE_BIN), ('electron 二进制', ELECTRON_EXE), ('start-electron.mjs', START_JS)]:
        say('  [%s] %s —— %s' % ('OK' if path else 'MISS', label, path))
    for port in (API_PORT, FAKE_PORT, VITE_PORT, CDP_PORT):
        if port_busy(port):
            say('  [MISS] 端口 %d 已被占用' % port)
            finish(1)
    say('  [OK] 端口 %s 全部空闲' % [API_PORT, FAKE_PORT, VITE_PORT, CDP_PORT])

    section('1. 起环境（假模型 + 验收后端 + vite + 真 Electron）')
    spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], REPO,
          env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_DELAY_MS': str(FAKE_DELAY_MS),
               'FAKE_STEPS': str(FAKE_STEPS), 'FAKE_LOG': FAKE_LOG, 'FAKE_DUMP': '1',
               'SITE_LOG': os.path.join(OUTDIR, 'site.jsonl')},
          log=os.path.join(OUTDIR, 'fake.log'))
    if wait_health(FAKE).get('ok') is not True:
        say('  [MISS] 假模型没起来')
        finish(1)
    say('  [OK] 假模型起来了（%s）' % FAKE)

    spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
          env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
               'DEEPSEEK_API_KEY': 'fake-key-stepbudget', 'DEEPSEEK_MODEL': 'fake-stepbudget',
               # 反证模式：把步数上限配回 10，让旧行为重现
               **({'AGENT_LOOP_MAX_STEPS': '10'} if REVERT else {})},
          log=SERVER_LOG)
    hs = wait_health(API)
    if hs.get('db') != 'up':
        say('  [MISS] 验收后端没起来：%s' % json.dumps(hs, ensure_ascii=False)[:200])
        finish(1)
    say('  [OK] 验收后端起来了 db=%s loopMaxSteps=%s' % (hs.get('db'), hs.get('loopMaxSteps')))

    spawn('vite', [NODE, VITE_BIN, '--port', str(VITE_PORT), '--strictPort'], DESKTOP,
          log=os.path.join(OUTDIR, 'vite.log'))
    time.sleep(4)

    spawn('electron', [NODE, 'scripts/start-electron.mjs',
                       '--user-data-dir=%s' % PROFILE,
                       '--remote-debugging-port=%d' % CDP_PORT], DESKTOP,
          env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT},
          log=os.path.join(OUTDIR, 'electron.log'))
    ok, _, ms = wait_until(lambda: bool(P.page('localhost:%d' % VITE_PORT)), timeout=90)
    if not ok:
        say('  [MISS] Electron 窗口没起来')
        finish(1)
    say('  [OK] 真 Electron 窗口出现（%dms）' % ms)

    section('2. 建号登录（真实短信登录链路）')
    st, r = http_json('/auth/sms/send', 'POST', body={'phone': TEST_PHONE})
    say('  [%s] 发送验证码 HTTP %d' % ('OK' if st == 200 else 'MISS', st))
    code = None
    for _ in range(40):
        ms_ = re.findall(r'(\d{6})', server_log())
        if ms_:
            code = ms_[-1]
            break
        time.sleep(0.5)
    if not code:
        say('  [MISS] 没拿到验证码')
        finish(1)
    st, sess = http_json('/auth/login/sms', 'POST', body={'phone': TEST_PHONE, 'code': code})
    if st != 200 or not sess.get('token'):
        say('  [MISS] 登录失败')
        finish(1)
    token = sess['token']
    st, al = http_json('/agents', token=token)
    agents = (al or {}).get('agents') or []
    agent_id = int(agents[0]['id']) if agents and agents[0].get('id') else None
    say('  [OK] 登录成功 agentId=%s' % agent_id)

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
    ok, _, ms = wait_until(
        lambda: ('退出登录' in chat_text())
        and (ev('Boolean(window.workbench && window.workbench.agentStart)') is True),
        timeout=60)
    if not ok:
        say('  [MISS] 没进到工作台')
        finish(1)
    say('  [OK] 已进工作台（%dms）' % ms)

    section('3. 打开商城页（真实 openBrowser）')
    ev('window.workbench.openBrowser(%s); "ok"' % json.dumps(SHOP_URL))
    ok, _, ms = wait_until(lambda: len([w for w in webviews() if isinstance(w.get('wcId'), int)]) >= 1, timeout=90)
    if not ok:
        say('  [MISS] 内嵌页没建起来')
        finish(1)
    wvs = [w for w in webviews() if isinstance(w.get('wcId'), int)]
    wc = wvs[0]['wcId']
    say('  [OK] 内嵌页 wcId=%d url=%s' % (wc, wvs[0].get('url')))
    time.sleep(2)
    page_probe()  # 装探针
    say('  探针已装：%s' % json.dumps(page_probe(), ensure_ascii=False))

    section('3b. 反向断言：没有任务在等的时候，说「继续」不能乱发车')
    b0 = classify_calls()
    type_and_send(CONTINUE_TEXT)
    time.sleep(18)
    b1 = classify_calls()
    check('⑤ 空闲时说「继续」不会凭空发车（loop 请求 0 新增）',
          b1['loop'] - b0['loop'] == 0,
          'loop %d→%d' % (b0['loop'], b1['loop']))
    check('⑥ 空闲时说「继续」照旧走普通聊天（chat 请求有新增）',
          b1['chat'] - b0['chat'] >= 1,
          'chat %d→%d' % (b0['chat'], b1['chat']))

    section('4. 用真实聊天输入框发「长任务」指令（14 步 > 上限 10 步）')
    say('  指令原文：%s' % GOAL)
    r0 = type_and_send(GOAL)
    say('  输入/发送：%s' % json.dumps(r0, ensure_ascii=False))

    # 判据必须是「**工具循环**在问模型」，不能只看「有模型请求」：
    # 记忆抽取、普通聊天也都会产生请求，那样会假阳性地说成「发车了」。
    ok, _, ms = wait_until(lambda: classify_calls()['loop'] >= 1, timeout=45)
    say('  [%s] 工具循环是否开始问模型：%s（%dms）' % ('OK' if ok else 'MISS', ok, ms))
    if not ok:
        say('  · 第一条没发车，换兜底句式重发：%s' % GOAL_FALLBACK)
        say('  输入/发送：%s' % json.dumps(type_and_send(GOAL_FALLBACK), ensure_ascii=False))
        ok, _, ms = wait_until(lambda: classify_calls()['loop'] >= 1, timeout=45)
        say('  [%s] 兜底句式是否发车：%s（%dms）' % ('OK' if ok else 'MISS', ok, ms))
    if not ok:
        say('  诊断 · 聊天尾部：%s' % chat_tail(400))
        finish(1)
    time.sleep(2)
    s_start = snapshot('发车后')
    say('  %s' % json.dumps(s_start, ensure_ascii=False))

    if OVERRUN:
        # ------------------------------------------------------------ 反证 B（超限）
        section('5. [反证 B] 任务步数超过硬兜底 %d 步：必须被拦住' % HARD_CAP)
        ok, _, ms = wait_until(budget_hit, timeout=300)
        check('反证B① 走到硬兜底（%d 步）时任务被拦住' % HARD_CAP, ok, '耗时 %dms' % ms)
        check('反证B② 这次任务没有跑完（停在半路）', '任务完成' not in chat_text())
        s_cap = snapshot('被兜底拦住时')
        check('反证B③ 拦住时确实已经走了不少步（真跑到了兜底，不是提前误报）',
              (s_cap['llm_req_loop'] or 0) >= HARD_CAP - 5,
              'loop 请求 %d 次 / 兜底 %d' % (s_cap['llm_req_loop'], HARD_CAP))
        say('  聊天尾部：%s' % chat_tail(200))
        if not ok:
            say('  诊断 · 聊天尾部：%s' % chat_tail(600))
            finish(1)
        # 下面第 7 步要以「被拦住那一刻」为基线算增量，所以这里必须自己备好 s_budget
        #（三个分支互斥，不能指望落到别的分支里去赋值）
        s_budget = s_cap
        # 继续往下走第 6/7/8 步：被拦住之后再说一次「继续」，验证保留的兜底能接回

    elif not REVERT:
        # ---------------------------------------------------------------- 正常模式
        section('5. 等它一口气跑完（不再有步数闸打断）')
        ok, _, ms = wait_until(lambda: '任务完成' in chat_text(), timeout=240)
        s_done = snapshot('跑完时')
        say('  %s' % json.dumps(s_done, ensure_ascii=False))
        shot('01-run-to-done.png')
        check('① 长任务（14 步）一口气跑到 done，中途没有被掐断', ok, '耗时 %dms' % ms)
        check('② 全程没有出现任何步数提示', not budget_hit(),
              '聊天尾部：%s' % chat_tail(160))
        check('③ 循环步数确实越过了原来那道 10 步闸', s_done['llm_req_loop'] >= 12,
              'loop 请求 %d 次' % s_done['llm_req_loop'])
        if not ok:
            say('  诊断 · 聊天尾部：%s' % chat_tail(600))
        section('服务端日志尾部')
        say(server_log()[-2000:])
        section('验收结果')
        if FAILS:
            say('验收未通过，失败项：')
            for f in FAILS:
                say('  ✗ %s' % f)
        else:
            say('全部通过（%d 条断言）' % CHECKS)
        finish(1 if FAILS else 0)

    # -------------------------------------------------------------------- 反证模式 A
    elif REVERT:
        section('5. [反证] 步数上限配回 10：任务必须**重新被打断**')
        ok, _, ms = wait_until(budget_hit, timeout=180)
        say('  [%s] 界面重新出现步数提示（%dms）' % ('OK' if ok else 'MISS', ms))
        check('反证① 把上限配回 10 后，步数闸重新生效（任务被打断）', ok, '%dms' % ms)
        check('反证② 这次任务没有跑完（停在半路，等用户说继续）', '任务完成' not in chat_text())
        if not ok:
            say('  诊断 · 聊天尾部：%s' % chat_tail(600))
            say('  诊断 · 模型请求：%d 次' % len(llm_calls('req')))
            finish(1)
        time.sleep(2)
        s_budget = snapshot('撞上步数上限时')
        say('  %s' % json.dumps(s_budget, ensure_ascii=False))
        shot('01-step-budget.png')
        say('  截图：01-step-budget.png')
        say('  ★ 此刻服务端日志里的 loopId：%s' % json.dumps(s_budget['loops'], ensure_ascii=False))
        say('  ★ 此刻模型请求：loop=%d chat=%d' % (s_budget['llm_req_loop'], s_budget['llm_req_chat']))

    section('6. 在对话里真实输入「继续」并点发送')
    say('  输入原文：「%s」' % CONTINUE_TEXT)
    r1 = type_and_send(CONTINUE_TEXT)
    say('  输入/发送：%s' % json.dumps(r1, ensure_ascii=False))
    shot('02-continue-sent.png')

    section('7. 观测 %d 秒：AI 到底动没动手' % WATCH_SEC)
    base_loop = s_budget['llm_req_loop']
    base_chat = s_budget['llm_req_chat']
    base_scroll = s_budget['page'].get('scrollMax') or 0
    base_inputs = s_budget['page'].get('inputs') or 0
    base_clicks = s_budget['page'].get('clicks') or 0
    base_loops = list(s_budget['loops'])
    samples = []
    t0 = time.time()
    while time.time() - t0 < WATCH_SEC:
        time.sleep(10)
        s = snapshot('+%ds' % int(time.time() - t0))
        samples.append(s)
        say('  %s' % json.dumps(s, ensure_ascii=False))
    last = samples[-1] if samples else s_budget

    shot('03-after-continue.png')

    section('8. 断言')
    d_loop = last['llm_req_loop'] - base_loop
    d_chat = last['llm_req_chat'] - base_chat
    d_scroll = (last['page'].get('scrollMax') or 0) - base_scroll
    d_inputs = (last['page'].get('inputs') or 0) - base_inputs
    d_clicks = (last['page'].get('clicks') or 0) - base_clicks
    hb_grew = (last['page'].get('hb') or 0) > (s_budget['page'].get('hb') or 0)
    resumed = 'resumed=true' in server_log()

    say('  客观量：loop 请求 +%d；chat 请求 +%d；滚动 +%dpx；输入 +%d；点击 +%d；心跳在涨=%s'
        % (d_loop, d_chat, d_scroll, d_inputs, d_clicks, hb_grew))
    say('')

    # ★ 主判据一律是「**工具循环有没有继续被推进**」（loop 请求 + 服务端 resumed 日志），
    #   不能拿「页面有没有可见动作」当主判据 —— 剧本里剩下的可能全是 read_page，
    #   接回去了但页面一个像素都不动（探针第二版就是这样把 B 组误判成「没接回」的）。
    check('① 服务端真的解挂了（日志出现 [loop] … resumed=true）', resumed,
          '服务端日志尾部：%s' % server_log()[-260:].replace('\n', ' | '))
    check('② 工具循环继续被推进（loop 模型请求 > 0）', d_loop > 0, '+%d 次' % d_loop)
    check('③ 「继续」没有被当成普通闲聊（chat 请求 0 新增）', d_chat == 0, '+%d 次' % d_chat)
    check('④ 内嵌页心跳仍在增长（排除「页面死了才没动作」这种假阴性）', hb_grew)
    # 页面动作只当**辅助证据**：为正说明不止接回、还真的动了手；为 0 不代表没接回
    if d_scroll or d_inputs or d_clicks:
        say('  [辅助] 页面确实发生了可见动作：滚动 +%dpx / 输入 +%d / 点击 +%d' % (d_scroll, d_inputs, d_clicks))
    else:
        say('  [辅助] 页面没有可见动作（剩余步可能全是 read_page，不代表没接回）')
    say('  聊天区尾部原文：%s' % last['chat_tail'])

    section('9. 服务端日志尾部（看「继续」到底打了哪个接口）')
    say(server_log()[-2500:])

    section('验收结果')
    if FAILS:
        say('验收未通过，失败项：')
        for f in FAILS:
            say('  ✗ %s' % f)
    else:
        say('全部通过（%d 条断言）' % CHECKS)
    finish(1 if FAILS else 0)


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        import traceback
        say('  ★ 探针异常：%s' % e)
        say(traceback.format_exc())
        finish(2)
