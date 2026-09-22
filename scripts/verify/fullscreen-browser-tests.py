#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
第 25 步 · 「全屏浏览器 + 后台运行」真机验收。

它自己起一整套环境（假模型 + 假站点 + 验收后端 + vite + 真 Electron 窗口），跑完自己收干净。
端口一律另起（8793 / 8894 / 5179 / 9343）—— 用户自己的 8787 / 5173 / 8901 一律不动。

覆盖四条：
  A. 全屏浏览器能正常显示、能正常操作（真点真输入）
  B. 给一个**真实任务**（搜索下单：9 步，含 2 次真点击）→ **退出全屏** →
     用时间戳 + 页内 DOM 变化证明任务在后台**照常往下跑**（不是"没报错"，是"步骤真的完成了"）
  C. 点右下角小图标重新展开 → 能看到最新状态、画面没卡死
  D. 全程断言 webview **尺寸与挂载不变**（这条是硬约束：尺寸归零会让驾驶坐标全失效）

用法： python scripts/verify/fullscreen-browser-tests.py
反证： 先改坏 browser 展示层的关键代码再跑本脚本，必须变红（见 fullscreen-browser-revert.py）
"""
import importlib.util
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'fullscreen-browser')
TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wbfull')
PROFILE = os.path.join(TMP, 'profile')
DESKTOP = os.path.join(REPO, 'apps', 'desktop')

API_PORT = int(os.environ.get('FB_API_PORT', '8793'))
FAKE_PORT = int(os.environ.get('FB_FAKE_PORT', '8894'))
VITE_PORT = int(os.environ.get('FB_VITE_PORT', '5179'))
CDP_PORT = int(os.environ.get('FB_CDP_PORT', '9343'))
API = 'http://127.0.0.1:%d' % API_PORT
FAKE = 'http://127.0.0.1:%d' % FAKE_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server.log')
FAKE_DELAY_MS = int(os.environ.get('FB_FAKE_DELAY_MS', '2500'))
# 退出全屏后观察多久（反证时调小，加快循环）
OBSERVE_SECS = int(os.environ.get('FB_OBSERVE_SECS', '40'))
# 目标里必须含「搜索下单」—— 假模型据此走 9 步真动作剧本
GOAL = os.environ.get('FB_GOAL') or '搜索下单：帮我在商城买一个无线鼠标'
TEST_PHONE = os.environ.get('FB_PHONE') or ('186%08d' % (int(time.time()) % 100000000))

os.environ['WB20_PORT'] = str(CDP_PORT)
os.environ['WB20_MATCH'] = 'localhost:%d' % VITE_PORT

_spec = importlib.util.spec_from_file_location('cdp_probe', os.path.join(HERE, 'cdp-probe.py'))
P = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(P)

# 复用**已经验证过**的 PG 启动逻辑（本机 PG 会周期性崩溃重启，不先弄好整套环境起不来）
_spec2 = importlib.util.spec_from_file_location('rpr', os.path.join(HERE, 'run-pause-resume.py'))
RPR = importlib.util.module_from_spec(_spec2)
_spec2.loader.exec_module(RPR)

NODE = 'node'
FAILS = []
PROCS = []


# ---------------------------------------------------------------- 基础设施
def section(t):
    print('\n' + '=' * 78)
    print(t)
    print('=' * 78)


def check(name, ok, note=''):
    print('  [%s] %s%s' % ('PASS' if ok else 'FAIL', name, ('  —— ' + str(note)) if note else ''))
    if not ok:
        FAILS.append(name)
    return ok


def expect(cond, name, note=''):
    ok = check(name, bool(cond), note)
    if not ok:
        print('  ！！！ 关键步骤失败，后续断言失去意义，提前收尾')
        finish()
    return ok


def port_busy(port, host='127.0.0.1', timeout=1.2):
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


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
    c = P.Cdp()
    try:
        return c.js(expr)
    finally:
        try:
            c.ws.close()
        except Exception:
            pass


def eva(expr):
    c = P.Cdp()
    try:
        return c.js(expr, await_promise=True)
    finally:
        try:
            c.ws.close()
        except Exception:
            pass


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


def webviews():
    try:
        return ev(P.WEBVIEWS_JS)['list']
    except Exception:
        return []


def guest_cdp(url_part):
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


def llm_calls(goal=None):
    """假模型每次**提问**的毫秒时间戳（按目标过滤，见 pause-resume-tests.py 的同类注释）。"""
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
                if c.get('ev') != 'req':
                    continue
                if goal is not None and c.get('goal') != goal:
                    continue
                out.append(c)
    except Exception:
        pass
    return out


def dbq(sql, params='[]'):
    r = subprocess.run([NODE, os.path.join(HERE, 'dbq.mjs'), sql, params], cwd=REPO,
                       capture_output=True, text=True, encoding='utf-8',
                       errors='replace', timeout=60, env=dict(os.environ))
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


# 一屏读全：层 / 面板 / 小图标 / webview 尺寸 —— 所有断言都基于它
LAYER_JS = r"""
(() => {
  const layer = document.querySelector('.browserLayer');
  const float = document.querySelector('.browserFloating');
  const panel = document.querySelector('.browserPanel');
  const toggle = document.querySelector('.browserPanel__toggle');
  const middle = document.querySelector('.middle');
  const wv = document.querySelector('webview');
  const rect = (e) => { if (!e) return null; const b = e.getBoundingClientRect();
    return {x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height)}; };
  let wc = null;
  try { wc = wv ? wv.getWebContentsId() : null; } catch (e) { wc = 'ERR'; }
  const cs = (e, k) => e ? getComputedStyle(e)[k] : null;
  return {
    hasLayer: !!layer, layerCls: layer ? layer.className : null,
    layerOpacity: cs(layer, 'opacity'), layerDisplay: cs(layer, 'display'),
    layerZ: cs(layer, 'zIndex'), layerRect: rect(layer), middleRect: rect(middle),
    hasFloating: !!float, floatingText: float ? (float.textContent || '').trim() : null,
    hasPanel: !!panel, hasToggle: !!toggle,
    toggleText: toggle ? (toggle.textContent || '').trim() : null,
    wvRect: rect(wv), wvWc: wc, wvDisplay: cs(wv, 'display'), wvVisibility: cs(wv, 'visibility'),
  };
})()
"""


def layer():
    try:
        return ev(LAYER_JS) or {}
    except Exception as e:
        return {'__error': str(e)}


# 「此刻真正显示给用户的那张页」——用 --on 认，不按 URL 认
# （D 段要判断的是"拉回全屏后用户看到的那张页还是不是活的、有没有被压扁"）
ACTIVE_WV_JS = r"""
(() => {
  const v = document.querySelector('.browserPanel__view--on')
         || document.querySelector('.browserPanel__view');
  // ★ 注意：`browserPanel__view--on` 这个类就挂在 <webview> **元素本身**上
  //   （BrowserPanel 里 <webview className={...}> 直接返回，没有外层 div）——
  //   所以在它"里面"再找 webview 永远是 null。先看元素自己是不是 webview。
  const wv = v ? (v.tagName === 'WEBVIEW' ? v : v.querySelector('webview')) : null;
  const rect = wv ? wv.getBoundingClientRect() : null;
  let wc = null;
  try { wc = wv ? wv.getWebContentsId() : null; } catch (e) { wc = 'ERR'; }
  return {
    hasView: !!v, viewCls: v ? v.className : null, wcId: wc,
    rect: rect ? {x: Math.round(rect.x), y: Math.round(rect.y),
                  w: Math.round(rect.width), h: Math.round(rect.height)} : null,
  };
})()
"""


def exit_fullscreen():
    """真点击「退出全屏」按钮（CDP 鼠标事件，不是 el.click()）。"""
    c = P.Cdp()
    try:
        return c.click_rect('.browserPanel__toggle')
    finally:
        try:
            c.ws.close()
        except Exception:
            pass


def click_floating():
    c = P.Cdp()
    try:
        return c.click_rect('.browserFloating')
    finally:
        try:
            c.ws.close()
        except Exception:
            pass


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
    for label, path in [('vite 入口', VITE_BIN), ('electron 二进制', ELECTRON_EXE),
                        ('start-electron.mjs', START_JS)]:
        expect(bool(path), '构建产物存在：%s' % label, str(path))
    busy = [p for p in (API_PORT, FAKE_PORT, VITE_PORT, CDP_PORT) if port_busy(p)]
    expect(not busy, '端口空闲（EADDRINUSE 会伪装成「服务起不来」）', '被占：%s' % busy)

    section('1. 确保数据库可用（复用已验收的 PG 启动逻辑）')
    expect(RPR.ensure_pg(), '数据库可查询')

    section('2. 起环境（假模型 + 假站点 + 验收后端 + vite + 真 Electron）')
    spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], REPO,
          env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_DELAY_MS': str(FAKE_DELAY_MS),
               'FAKE_STEPS': '30', 'FAKE_LOG': FAKE_LOG},
          log=os.path.join(OUTDIR, 'fake.log'))
    expect(wait_health(FAKE).get('ok') is True, '假模型/假站点起来了')

    spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
          env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
               'DEEPSEEK_API_KEY': 'fake-key-fullscreen-verify', 'DEEPSEEK_MODEL': 'fake-fullscreen'},
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

    section('3. 建号登录（走真实短信登录链路）')
    st, _ = http_json('/auth/sms/send', 'POST', body={'phone': TEST_PHONE})
    expect(st == 200, '发送验证码', 'HTTP %d' % st)
    code = None
    for _ in range(40):
        try:
            log = open(SERVER_LOG, encoding='utf-8', errors='replace').read()
        except Exception:
            log = ''
        for m in re.finditer(r'(\d{6})', log):
            code = m.group(1)
        if code:
            break
        time.sleep(0.5)
    expect(bool(code), '从服务端日志拿到验证码')
    st, sess = http_json('/auth/login/sms', 'POST', body={'phone': TEST_PHONE, 'code': code})
    expect(st == 200 and sess.get('token'), '短信登录成功')
    token = sess['token']
    st, al = http_json('/agents', token=token)
    agents = (al or {}).get('agents') or []
    agent_id = int(next(a['id'] for a in agents if a.get('id')))
    expect(bool(agent_id), '账号有自带智能体', 'agent_id=%d' % agent_id)

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
        lambda: ('退出登录' in (ev('(document.body.innerText||"")') or ''))
        and (ev('Boolean(window.workbench && window.workbench.agentStart)') is True), timeout=60)
    expect(ok, '登录后进到工作台（登录态锚点 + 驾驶桥就绪）', '耗时 %dms' % ms)

    # ---------------------------------------------------------------- A
    section('A. 打开浏览器 → 应占满中栏会话区（左栏照旧）')
    ev('window.workbench.openBrowser(%s); "ok"' % json.dumps(FAKE + '/shop'))
    ok, _, ms = wait_until(lambda: len([w for w in webviews() if isinstance(w.get('wcId'), int)]) >= 1, timeout=90)
    expect(ok, '内嵌页建起来了', '耗时 %dms' % ms)

    L = layer()
    print('  层状态：%s' % json.dumps(L, ensure_ascii=False))
    expect(L.get('hasLayer') is True, '浏览器层已挂载')
    check('① 默认就是全屏（层没有 --bg 类）', '--bg' not in (L.get('layerCls') or ''), L.get('layerCls'))
    check('② 层是可见的（opacity=1、display 不是 none）',
          L.get('layerOpacity') == '1' and L.get('layerDisplay') != 'none',
          'opacity=%s display=%s' % (L.get('layerOpacity'), L.get('layerDisplay')))
    mr, lr = L.get('middleRect') or {}, L.get('layerRect') or {}
    check('③ 层铺满中栏会话区（宽高与 .middle 一致）',
          mr.get('w') == lr.get('w') and mr.get('h') == lr.get('h'),
          'middle=%s layer=%s' % (mr, lr))
    check('④ 全屏时没有「后台运行」小图标', L.get('hasFloating') is False)
    check('⑤ 退出按钮文案是「退出全屏」', L.get('toggleText') == '退出全屏', L.get('toggleText'))
    w0 = L.get('wvRect') or {}
    check('⑥ webview 有真实尺寸（宽高都 > 100）',
          w0.get('w', 0) > 100 and w0.get('h', 0) > 100, 'wvRect=%s' % w0)
    wc_id = L.get('wvWc')
    expect(isinstance(wc_id, int), '拿到 webview 的 webContentsId', 'wcId=%s' % wc_id)

    # 真点真输入：直接在页面上操作（证明「能正常操作」）
    ok, _, ms = wait_until(lambda: (guest_js('127.0.0.1:%d' % FAKE_PORT,
                                             "!!document.getElementById('q1')") is True), timeout=40)
    expect(ok, '内嵌页已就绪（#q1 出现）', '耗时 %dms' % ms)
    gc = guest_cdp('127.0.0.1:%d' % FAKE_PORT)
    try:
        gc.js("(() => { window.__clicks = 0;"
              " document.getElementById('btn1').addEventListener('click', () => { window.__clicks += 1; });"
              " return 'hooked'; })()")
        gc.type_text('人工输入测试', sel='#q1')
        gc.click_rect('#btn1')
    finally:
        try:
            gc.ws.close()
        except Exception:
            pass
    time.sleep(1.2)
    manual = guest_js('127.0.0.1:%d' % FAKE_PORT,
                      "({q: (document.getElementById('q1')||{}).value,"
                      " clicks: window.__clicks, result: (document.getElementById('result')||{}).textContent})")
    check('⑦ 全屏下能真输入（输入框里出现人工敲的字）',
          '人工输入测试' in str((manual or {}).get('q')), 'q=%r' % (manual or {}).get('q'))
    check('⑧ 全屏下能真点击（页面真的收到了点击）',
          (manual or {}).get('clicks', 0) >= 1, 'clicks=%s' % (manual or {}).get('clicks'))

    # ---------------------------------------------------------------- B
    section('B. 发一个真实任务 → 退出全屏 → 任务必须继续跑')
    # 把页面复位到干净状态，让任务从零开始跑剧本
    # （带一个 query 让它与当前地址不同 —— 同站会被复用，只有地址变了才真的重新加载）
    ev('window.workbench.openBrowser(%s); "ok"'
       % json.dumps(FAKE + '/shop?reset=%d' % int(time.time())))
    time.sleep(3)
    ev('window.workbench.agentStart(%s, %s, %s, %d, {agentId: %d}); "ok"'
       % (json.dumps(GOAL), json.dumps(API), json.dumps(token), wc_id, agent_id))
    ok, _, ms = wait_until(lambda: len(llm_calls(GOAL)) >= 1, timeout=60)
    expect(ok, '任务已发车（模型开始被提问）', '耗时 %dms' % ms)
    # 等第 3 步（在搜索框里打字）落下来 —— 证明全屏下驾驶是真能操作的
    ok, _, ms = wait_until(
        lambda: '无线鼠标' in str(guest_js('127.0.0.1:%d' % FAKE_PORT,
                                          "(document.getElementById('q1')||{}).value")), timeout=90)
    expect(ok, '任务第 3 步已落地：搜索框被真填上「无线鼠标」（全屏下驾驶正常）', '耗时 %dms' % ms)

    before_exit = layer()
    before_calls = len(llm_calls(GOAL))
    cart_before = bool(guest_js('127.0.0.1:%d' % FAKE_PORT,
                                "!!document.getElementById('cartmsg')"))
    print('  退出前：层=%s / 模型提问 %d 次 / 购物车痕迹=%s'
          % (before_exit.get('layerCls'), before_calls, cart_before))
    check('⑨ 退出前任务还没跑完（后面才有「退出之后又推进了」可言）', cart_before is False,
          'cartmsg 已存在=%s' % cart_before)

    t_exit = int(time.time() * 1000)
    clicked = exit_fullscreen()
    print('  已点「退出全屏」：%s' % clicked)
    ok, _, ms = wait_until(lambda: '--bg' in (layer().get('layerCls') or ''), timeout=15)
    expect(ok, '已进入后台态（层带上 --bg）', '耗时 %dms' % ms)

    after_exit = layer()
    print('  退出后：%s' % json.dumps(after_exit, ensure_ascii=False))
    check('⑩ 退出后出现「后台运行」小图标', after_exit.get('hasFloating') is True,
          after_exit.get('floatingText'))
    check('⑪ 退出后面板**仍在挂载**（不是卸载）', after_exit.get('hasPanel') is True)
    check('⑫ 退出后 webview 的 webContentsId **没变**（还是同一个实例）',
          after_exit.get('wvWc') == wc_id, '%s → %s' % (wc_id, after_exit.get('wvWc')))
    check('⑬ 退出后 webview 尺寸**一点没变**（不是 0、不是 display:none）',
          (after_exit.get('wvRect') or {}) == (before_exit.get('wvRect') or {})
          and after_exit.get('wvDisplay') != 'none',
          '退出前 %s → 退出后 %s' % (before_exit.get('wvRect'), after_exit.get('wvRect')))
    check('⑭ 退出后 webview 仍非零尺寸（驾驶坐标才有意义）',
          (after_exit.get('wvRect') or {}).get('w', 0) > 100
          and (after_exit.get('wvRect') or {}).get('h', 0) > 100,
          after_exit.get('wvRect'))
    check('⑮ 退出后层是「不可见但仍在渲染」（opacity=0，display 仍不是 none）',
          after_exit.get('layerOpacity') == '0' and after_exit.get('layerDisplay') != 'none',
          'opacity=%s display=%s' % (after_exit.get('layerOpacity'), after_exit.get('layerDisplay')))

    # 等后台把剩下的步骤跑完 —— 关键证据：**退出之后**页面 DOM 又被改变了
    print('  退出全屏后观察最多 %d 秒，等任务在后台继续推进…' % OBSERVE_SECS)
    ok, _, ms = wait_until(
        lambda: bool(guest_js('127.0.0.1:%d' % FAKE_PORT,
                              "!!document.getElementById('cartmsg')")), timeout=OBSERVE_SECS)
    cart_after = bool(guest_js('127.0.0.1:%d' % FAKE_PORT,
                               "!!document.getElementById('cartmsg')"))
    body_txt = guest_js('127.0.0.1:%d' % FAKE_PORT,
                        "(document.body.innerText||'').replace(/\\n+/g,' | ').slice(0,300)")
    check('⑯ ★退出全屏后，任务**继续完成了后续真点击**（页面出现「已加入购物车」痕迹）',
          cart_after, '耗时 %dms / 页面：%s' % (ms, body_txt))

    calls_after = llm_calls(GOAL)
    after_exit_calls = [x for x in calls_after if int(x.get('at', 0)) > t_exit]
    check('⑰ ★退出全屏后，模型仍被继续提问（时间戳在退出之后）',
          len(after_exit_calls) >= 1,
          '退出后提问 %d 次：%s' % (len(after_exit_calls),
                                    [x.get('step') for x in after_exit_calls]))
    check('⑱ 退出全屏后提问次数比退出前多（任务真的在往前走）',
          len(calls_after) > before_calls, '%d → %d' % (before_calls, len(calls_after)))
    # 后台态下页面 JS 仍活着（没被冻结/节流到停摆）
    hb1 = guest_js('127.0.0.1:%d' % FAKE_PORT, "window.__hb ? window.__hb.n : null")
    time.sleep(2.5)
    hb2 = guest_js('127.0.0.1:%d' % FAKE_PORT, "window.__hb ? window.__hb.n : null")
    if hb1 is None:
        # 这个页面没有心跳计数器（只有 pause-resume 那套才装），跳过即可
        check('⑲ 后台态页面 JS 仍在跑（心跳计数器增长）', True, '本页无心跳计数器，跳过')
    else:
        check('⑲ 后台态页面 JS 仍在跑（心跳计数器增长）', hb2 > hb1, '%s → %s' % (hb1, hb2))

    # ---------------------------------------------------------------- C
    section('C. 点右下角小图标 → 重新展开，看到最新状态')
    before_re = layer()
    click_floating()
    ok, _, ms = wait_until(lambda: '--bg' not in (layer().get('layerCls') or ''), timeout=15)
    expect(ok, '已回到全屏（层不再带 --bg）', '耗时 %dms' % ms)
    re_open = layer()
    print('  重新展开后：%s' % json.dumps(re_open, ensure_ascii=False))
    check('⑳ 重新展开后小图标消失', re_open.get('hasFloating') is False)
    check('㉑ 重新展开后 webview 还是同一个实例（wcId 未变）',
          re_open.get('wvWc') == wc_id, '%s → %s' % (wc_id, re_open.get('wvWc')))
    check('㉒ 重新展开后 webview 尺寸与退出前一致（没被压扁）',
          (re_open.get('wvRect') or {}).get('w', 0) > 100
          and (re_open.get('wvRect') or {}).get('h', 0) > 100, re_open.get('wvRect'))
    live = guest_js('127.0.0.1:%d' % FAKE_PORT,
                    "({title: document.title, href: location.href,"
                    " cart: (document.getElementById('cartmsg')||{}).textContent || null,"
                    " q: (document.getElementById('q1')||{}).value})")
    check('㉓ ★重新展开后看到的是**最新状态**（后台跑出来的痕迹还在，不是白屏/旧快照）',
          bool((live or {}).get('cart')) and (live or {}).get('href', '').find('/shop') >= 0,
          json.dumps(live, ensure_ascii=False)[:220])

    # 任务最终状态（phase 取值见 App.tsx 的 DRIVE_PHASE_LABEL：idle/running/paused/done/failed）
    ok, _, ms = wait_until(
        lambda: (eva('window.workbench.getTaskState(%d)' % wc_id) or {}).get('phase') in
        ('done', 'idle'), timeout=90)
    tstate = eva('window.workbench.getTaskState(%d)' % wc_id)
    print('  任务最终状态：%s' % json.dumps(tstate, ensure_ascii=False))
    check('㉔ 任务最终正常收尾（不是卡在退出那一刻，也不是 failed）',
          (tstate or {}).get('phase') in ('done', 'idle'),
          (tstate or {}).get('phase'))

    # ---------------------------------------------------------------- D
    section('D. 决定1：AI 自己开新页不打扰用户；只有「需要用户亲自处理」才拉回全屏')
    # C 段最后把用户带回了全屏，D 段从后台态起步
    exit_fullscreen()
    ok, _, ms = wait_until(lambda: '--bg' in (layer().get('layerCls') or ''), timeout=15)
    expect(ok, 'D 段前置：已回到后台态', '耗时 %dms' % ms)

    # ---- D1：页面里点开 target=_blank 链接 —— 这就是「AI 自己开新网页」----
    # 链路：主进程 setWindowOpenHandler 命中 http → 推 opentab → 渲染层 openFromPage 真开一条 tab。
    # ★ 必须用**真点击**（CDP 鼠标事件）：不带用户手势的 `window.open` 会被 Chromium 的弹窗拦截
    #   挡掉，连 setWindowOpenHandler 都不会被调到 —— 第一版就是这么做然后假红的
    #   （tab 数 1→1，日志里只看到等满 25 秒）。AI 驾驶点链接用的也是真输入事件，这条更贴近真实。
    tabs_before = len([w for w in webviews() if isinstance(w.get('wcId'), int)])
    # 诊断用：webview 有没有 allowpopups（没有的话弹窗会被直接挡掉，连 handler 都不进）
    print('  webview allowpopups = %s'
          % ev("(document.querySelector('webview')||{hasAttribute:()=>null}).hasAttribute('allowpopups')"))
    gc1 = guest_cdp('127.0.0.1:%d' % FAKE_PORT)
    clicked = None
    try:
        gc1.js("(() => {"
               "  const old = document.getElementById('__d1'); if (old) old.remove();"
               "  const a = document.createElement('a');"
               "  a.id = '__d1'; a.target = '_blank'; a.rel = 'noopener';"
               "  a.href = 'http://127.0.0.1:%d/other?t=%d';"
               "  a.textContent = 'D1';"
               "  a.style.cssText = 'position:fixed;left:4px;top:4px;width:120px;height:32px;"
               "z-index:2147483647;background:#0f0;color:#000;font:14px sans-serif';"
               "  document.body.appendChild(a); return 'injected'; })()"
               % (FAKE_PORT, int(time.time())))
        # ★ 必须发完整的鼠标序列：mouseMoved → mousePressed(buttons=1) → mouseReleased(buttons=0)。
        #   只发 pressed/released（cdp-probe 的 click_rect 就是那样，点普通按钮够用）时，
        #   `target=_blank` 的默认动作**不会**被触发 —— 主进程的 setWindowOpenHandler 一次都没进
        #   （实测：electron.log 里连一行 "[webview] target=_blank" 都没有，tab 数 1→1）。
        #   这套序列是从已验收的 scripts/verify/newtab-fix-tests.mjs 抄来的。
        r = gc1.js("(() => { const e=document.querySelector('#__d1'); if(!e) return null;"
                   " e.scrollIntoView({block:'center'}); const b=e.getBoundingClientRect();"
                   " return {x: Math.round(b.left+b.width/2), y: Math.round(b.top+b.height/2),"
                   "         w: Math.round(b.width), h: Math.round(b.height)}; })()")
        if not r:
            clicked = 'NO_ELEM #__d1'
        else:
            gc1.send('Input.dispatchMouseEvent', type='mouseMoved', x=r['x'], y=r['y'])
            gc1.send('Input.dispatchMouseEvent', type='mousePressed', x=r['x'], y=r['y'],
                     button='left', buttons=1, clickCount=1)
            gc1.send('Input.dispatchMouseEvent', type='mouseReleased', x=r['x'], y=r['y'],
                     button='left', buttons=0, clickCount=1)
            clicked = 'clicked #__d1 at (%s,%s) rect=%sx%s' % (r['x'], r['y'], r['w'], r['h'])
    finally:
        try:
            gc1.ws.close()
        except Exception:
            pass
    print('  真点击 target=_blank 链接：%s' % clicked)
    ok, _, ms = wait_until(
        lambda: len([w for w in webviews() if isinstance(w.get('wcId'), int)]) > tabs_before,
        timeout=25)
    tabs_after = len([w for w in webviews() if isinstance(w.get('wcId'), int)])
    expect(ok, 'AI 自己开新网页 → 真的新开了一条 tab', '耗时 %dms（%d → %d）' % (ms, tabs_before, tabs_after))
    time.sleep(1.2)
    d1 = layer()
    print('  新开页后：%s' % json.dumps(d1, ensure_ascii=False))
    check('㉕ ★AI 自己开新页**不把用户拽回全屏**（层仍带 --bg）',
          '--bg' in (d1.get('layerCls') or ''), d1.get('layerCls'))
    check('㉖ 后台态下小图标仍在（用户随时能自己回去看）',
          d1.get('hasFloating') is True, d1.get('floatingText'))
    act1 = ev(ACTIVE_WV_JS) or {}
    check('㉗ 后台态下这张页照样是活的、有真实尺寸（不是 0 尺寸，驾驶坐标才有意义）',
          isinstance(act1.get('wcId'), int) and (act1.get('rect') or {}).get('w', 0) > 100
          and (act1.get('rect') or {}).get('h', 0) > 100,
          json.dumps(act1, ensure_ascii=False))

    # ---- D2：主进程说「把视线给这张页」→ 敏感字段等待走的就是这条通道 ----
    # 渲染层两个分支（带 wcId → focusByWebContents；不带 → focusActive）最终都落到
    # activate() → setView('fullscreen')，所以这条断言覆盖「敏感等待会把人拉回来」。
    ev('window.workbench.focusBrowser(); "ok"')
    ok, _, ms = wait_until(lambda: '--bg' not in (layer().get('layerCls') or ''), timeout=15)
    expect(ok, '主进程「把视线给这张页」（敏感字段等待那条通道）→ 已拉回全屏', '耗时 %dms' % ms)
    d2 = layer()
    print('  拉回全屏后：%s' % json.dumps(d2, ensure_ascii=False))
    check('㉘ ★需要用户亲自处理时**会**拉回全屏（层不再带 --bg）',
          '--bg' not in (d2.get('layerCls') or ''), d2.get('layerCls'))
    check('㉙ 拉回全屏后小图标消失（用户已经看到浏览器了）',
          d2.get('hasFloating') is False, d2.get('floatingText'))
    act2 = ev(ACTIVE_WV_JS) or {}
    check('㉚ 拉回全屏后当前页仍是活的、尺寸没被压扁',
          isinstance(act2.get('wcId'), int) and (act2.get('rect') or {}).get('w', 0) > 100
          and (act2.get('rect') or {}).get('h', 0) > 100,
          json.dumps(act2, ensure_ascii=False))

    finish()


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
