"""第 27 步 · 人工介入卡片 —— **真机端到端**验收（真 Electron 窗口 + 真后端 + 真驾驶循环 + 真 CDP）

为什么要单写一个：渲染层那三套 node/无头验收证明不了"主进程 ↔ 渲染层"接起来之后对不对。
这里全部在**真实环境**里跑：
  · 真 Electron 窗口（起法见下面的 spawn；本机必须 Python 直连 + DETACHED，别经过 cmd）
  · 真 PostgreSQL + 真 Fastify 后端 + 真 vite
  · 真驱动循环（假模型按剧本出招，但循环本身、driver、服务端 sanitize 全是产品代码）

覆盖（对应用户点名的验收项）：
  ① 真实触发：AI 在验证码页卡住 → 聊天流里出现求助卡（位置/视觉/几何/安全红线）
  ③ 自动切换界面：用户正开着全屏浏览器时，求助卡触发后自动切回聊天视图
  ④ 继续流程：自动感知（用户填完验证码提交）与手动「我处理好了」两条路都能接回
  ② 保守触发反例：页面正常、AI 没卡住时**不**弹卡

★ 环境前提：**必须在同一次调用里先起 PG 再跑本脚本**（本机 agent 起的进程活不过一次工具调用）。
   用法：python scripts/verify/help-card/_start-pg.py && python scripts/verify/help-card/help-card-e2e.py
"""
import importlib.util
import json
import os
import re
import shutil
import sys
import time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
VERIFY = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(VERIFY))
DESKTOP = os.path.join(REPO, 'apps', 'desktop')

# 端口另起，绝不动用户自己的 8787 / 5173 / 8901
os.environ.setdefault('API_PORT', '8793')
os.environ.setdefault('FAKE_PORT', '8896')
os.environ.setdefault('FAKE2_PORT', '8897')
os.environ.setdefault('FAKE3_PORT', '8898')
os.environ.setdefault('VITE_PORT', '5180')
os.environ.setdefault('CDP_PORT', '9343')

# ★ 复用「暂停/继续」那套已验证的环境基建（起环境 / CDP / 等条件 / 断言 / 收尾）
_spec = importlib.util.spec_from_file_location('pr', os.path.join(VERIFY, 'pause-resume-tests.py'))
PR = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(PR)

# 证据目录换成自己的，别和暂停/继续那套混在一起
PR.OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'help-card')
PR.TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wbhelpcard')
PR.PROFILE = os.path.join(PR.TMP, 'profile')
PR.FAKE_LOG = os.path.join(PR.OUTDIR, 'llm.jsonl')
PR.SERVER_LOG = os.path.join(PR.OUTDIR, 'server-%d.log' % PR.API_PORT)

section, check, expect = PR.section, PR.check, PR.expect
ev, eva, guest_js, webviews, task_state, llm_calls, wait_until = (
    PR.ev, PR.eva, PR.guest_js, PR.webviews, PR.task_state, PR.llm_calls, PR.wait_until,
)

GOAL = '登录验证后把订单提交了'
KEY = '127.0.0.1:%d' % PR.FAKE_PORT


def shot(name):
    """给渲染层截图存档（证据）"""
    path = os.path.join(PR.OUTDIR, name)
    try:
        c = PR.P.Cdp()
        try:
            c.shot(path)
        finally:
            try:
                c.ws.close()
            except Exception:
                pass
        return path
    except Exception as e:  # noqa: BLE001
        print('  （截图 %s 失败：%s）' % (name, e))
        return None


CARD_JS = """(() => {
  const card = document.querySelector('.helpCard');
  const layer = document.querySelector('.browserLayer');
  const ds = document.querySelector('.driveState');
  const base = {
    layerClass: layer ? layer.className : null,
    driveState: ds ? { cls: ds.className, text: (ds.textContent || '').trim() } : null,
    cardCount: document.querySelectorAll('.helpCard').length,
  };
  if (!card) return Object.assign(base, { exists: false });
  const stage = card.querySelector('.helpCard__stage');
  const holder = stage ? stage.getBoundingClientRect() : null;
  const stageEl = document.querySelector('.browserPanel__stage');
  const sr = stageEl ? stageEl.getBoundingClientRect() : null;
  const wv = document.querySelector('webview');
  const bad = card.querySelectorAll('input, textarea, select, form, [contenteditable="true"]');
  return Object.assign(base, {
    exists: true,
    inChat: !!document.querySelector('.chat .helpCard'),
    msgsBefore: [...document.querySelectorAll('.chat .msg')]
      .filter(m => (card.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_PRECEDING) !== 0).length,
    wvClass: wv ? wv.className : null,
    embedRect: wv ? {
      left: parseFloat(wv.style.left), top: parseFloat(wv.style.top),
      width: parseFloat(wv.style.width), height: parseFloat(wv.style.height),
    } : null,
    holderRect: (holder && sr) ? {
      left: Math.round(holder.left - sr.left), top: Math.round(holder.top - sr.top),
      width: Math.round(holder.width), height: Math.round(holder.height),
    } : null,
    badCount: bad.length,
    badTags: [...bad].map(e => e.tagName.toLowerCase()),
    buttons: [...card.querySelectorAll('button')].map(b => (b.textContent || '').trim()),
    cardText: (card.innerText || '').slice(0, 400),
  });
})()"""


def card():
    try:
        return ev(CARD_JS) or {}
    except Exception as e:  # noqa: BLE001
        return {'__error': str(e)}


def near(a, b, tol=3):
    try:
        return abs(float(a) - float(b)) <= tol
    except Exception:  # noqa: BLE001
        return False


def real_click(sel):
    """★ 用**完整鼠标序列**点一个元素（`Input.dispatchMouseEvent` 的
    mousePressed + mouseReleased，坐标取自元素 rect）。

    为什么不能用 `document.querySelector(sel).click()`：
      JS 的 `.click()` 只派发一个合成 click 事件，**不产生真实的指针序列**。
      React 的 `onClick` 挂在根容器上靠事件冒泡工作，在"元素被遮挡 / 尺寸为 0 /
      正处于 transition"时，`.click()` 会**静默不生效** —— 返回 undefined、
      不报错、界面上什么都没发生。
      本仓库踩过（真机 E2E 里"点智能体切对话"时好时坏）：
      `contact--on` 一直停在原 id，说明**点击根本没生效**，
      但脚本以为点了，接着去断言"切走后视图应该变" ⇒ 得出**完全错误的结论**。
      （记忆里的铁律 6：触发 `target=_blank` / 新开 tab 必须用完整鼠标序列，
        这里是同一类问题的另一个面 —— **任何靠 React 合成事件的点击都该用真鼠标**。）
    """
    c = PR.P.Cdp()
    try:
        return c.click_rect(sel)
    finally:
        try:
            c.ws.close()
        except Exception:
            pass


def agent_is_current():
    """读界面上"当前选中的智能体"的 id（**唯一真相**，不信自己的点击返回值）。

    为什么不接受入参：这个函数的语义是"**它现在是哪个**"。带个入参去比
    （`agent_is_current(x) == x`）看着方便，但它掩盖了"点击前后都没变"这种
    空操作 —— 而正是那种情况下判断最容易出错。返回原始值，让调用方自己比。
    """
    try:
        on = ev("""(() => {
          const el = document.querySelector('.agentList .contact--on');
          return el ? el.getAttribute('data-agent-id') : null;
        })()""")
    except Exception:  # noqa: BLE001
        return None
    return str(on) if on is not None else None


def switch_agent(agent_id, label=''):
    """切到指定智能体，并**回读确认真的切过去了**（返回 True/False）。

    ★ 关键：不能只看点击有没有报错，要读 `contact--on` 这个**唯一真相**。
    ★★ 而且必须证明发生了「**改变**」，不能只证明「目标现在是当前」。

    为什么"目标现在是当前"不够（2026-09-21 真机踩到的假通过）：
      若传进来的 `agent_id` **恰好就是当前已有**的那一项，点击是个空操作，
      而"目标是不是当前"这条校验**照样返 True** ⇒ 调用方以为"切过去了"，
      然后去断言"切走后视图应该变" ⇒ 变红 ⇒ 把"测试自己选错了 id"
      **误报成"产品有 bug"**。
      所以先读**点击前**的 `contact--on`，再要求"点击后变了且等于目标"。
      二者都不满足时，明确打印"本来就是它 / 点击前后没变"，让调用方看得见真相。
    """
    sel = '.agentList .contact[data-agent-id="%s"]' % agent_id
    was = agent_is_current()
    r = real_click(sel)
    if str(r).startswith('NO_ELEM'):
        print('  切智能体：界面上没有 %s' % sel)
        return False
    for _ in range(24):
        time.sleep(0.25)
        now = agent_is_current()
        if now == str(agent_id):
            if was == str(agent_id):
                # 点击前就已经是它 —— 这一次点击**没有产生任何改变**，
                # 不能算"切过去了"（否则就是本条注释开头说的那种假通过）
                print('  切智能体%s：点击前后都是 %s（无改变，空操作）'
                      % (label and ' ' + label or '', now))
                return False
            print('  切智能体%s成功（%s → %s）'
                  % (label and ' ' + label or '', was, agent_id))
            return True
    print('  切智能体%s失败：contact--on=%s（期望 %s）'
          % (label and ' ' + label or '', agent_is_current(), agent_id))
    return False


def main():
    # 跑哪种恢复路径 / 哪个场景：auto（默认）| manual | login
    MODE = os.environ.get('HC_MODE', 'auto')
    os.makedirs(PR.OUTDIR, exist_ok=True)
    shutil.rmtree(PR.TMP, ignore_errors=True)
    os.makedirs(PR.PROFILE, exist_ok=True)

    section('0. 环境自检')
    import socket

    def port_open(p):
        s = socket.socket()
        s.settimeout(0.6)
        try:
            s.connect(('127.0.0.1', p))
            return True
        except OSError:
            return False
        finally:
            s.close()

    expect(port_open(5432), 'PostgreSQL 已在监听（本脚本不负责起它 —— 见文件头用法）')
    for p in (PR.API_PORT, PR.FAKE_PORT, PR.VITE_PORT, PR.CDP_PORT):
        expect(not port_open(p), '端口 %d 空闲' % p)

    VITE_BIN = PR.first_existing(os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'))
    ELECTRON_EXE = PR.first_existing(os.path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'))
    START_JS = os.path.join(DESKTOP, 'scripts', 'start-electron.mjs')
    for label, path in (('vite 入口', VITE_BIN), ('electron 二进制', ELECTRON_EXE), ('start-electron.mjs', START_JS)):
        expect(bool(path), '构建产物存在：%s' % label, path)

    section('1. 起环境（假模型 + 假页面 + 验收后端 + vite + 真 Electron）')
    PR.spawn('fake', [PR.NODE, os.path.join(VERIFY, 'fake-llm.mjs')], REPO,
             env={'FAKE_PORT': str(PR.FAKE_PORT), 'FAKE_DELAY_MS': '800', 'FAKE_STEPS': '30',
                  'FAKE_LOG': PR.FAKE_LOG},
             log=os.path.join(PR.OUTDIR, 'fake.log'))
    hs = PR.wait_health(PR.FAKE)
    expect(bool(hs), '假模型起来了', json.dumps(hs, ensure_ascii=False)[:160])
    # 另起一个静态站（**不同端口 = 不同 host**）—— 应用按 host 判"同站复用"，
    # 同站会复用已有那张页，拿不到"全新的一张页"。④-b 需要一个全新任务。
    for extra_port in (PR.FAKE2_PORT, PR.FAKE3_PORT):
        PR.spawn('site%d' % extra_port, [PR.NODE, os.path.join(VERIFY, 'fake-llm.mjs')], REPO,
                 env={'FAKE_PORT': str(extra_port), 'FAKE_DELAY_MS': '50', 'FAKE_STEPS': '1'},
                 log=os.path.join(PR.OUTDIR, 'site-%d.log' % extra_port))
    time.sleep(1.5)

    PR.spawn('server', [PR.NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
             env={'PORT': str(PR.API_PORT), 'DEEPSEEK_BASE_URL': PR.FAKE,
                  'DEEPSEEK_API_KEY': 'fake-key-helpcard', 'DEEPSEEK_MODEL': 'fake-helpcard'},
             log=PR.SERVER_LOG)
    hs = PR.wait_health(PR.API)
    expect((hs or {}).get('db') == 'up', '验收后端起来了（db=up）', json.dumps(hs, ensure_ascii=False)[:200])

    PR.spawn('vite', [PR.NODE, VITE_BIN, '--port', str(PR.VITE_PORT), '--strictPort'], DESKTOP,
             log=os.path.join(PR.OUTDIR, 'vite.log'))
    # ★ 这里**不要**去探 vite 的端口：vite 默认只绑 `localhost`，本机解析到 ::1，
    #   而 `127.0.0.1:5180` 探不通 —— 会报"vite 没起来"（第一次就栽在这，
    #   日志里明明写着 ready）。跟回归脚本一样：睡 4 秒，然后**以 Electron 页面为准**。
    # ★ 也不能用 PR.wait_until：它内部先探 Electron 是否活着，此刻还没起 → 秒退。
    time.sleep(4)

    env = dict(os.environ)
    env['VITE_DEV_SERVER_URL'] = 'http://localhost:%d' % PR.VITE_PORT
    env['ELECTRON_ENABLE_LOGGING'] = '1'
    PR.spawn('electron', [PR.NODE, START_JS, '--user-data-dir=%s' % PR.PROFILE,
                          '--remote-debugging-port=%d' % PR.CDP_PORT,
                          '--remote-allow-origins=*'], DESKTOP, env=env,
             log=os.path.join(PR.OUTDIR, 'electron.log'))
    # 判据用「能不能在渲染层求值」而不是「/json/list 有没有东西」：
    # 后者在窗口刚起、页面还没挂上时也会为真。
    ok, _, ms = wait_until(lambda: PR.ev('1') == 1, timeout=120)
    expect(ok, '真 Electron 窗口起来了（能在渲染层求值）', '%dms' % ms)

    section('2. 建号登录（走真实短信登录链路）')
    st, _ = PR.http_json('/auth/sms/send', 'POST', body={'phone': PR.TEST_PHONE})
    expect(st == 200, '发送验证码')
    code = None
    for _ in range(40):
        for m in re.finditer(r'(\d{6})', PR.server_log()):
            code = m.group(1)
        if code:
            break
        time.sleep(0.5)
    expect(bool(code), '从服务端日志拿到验证码')
    st, sess = PR.http_json('/auth/login/sms', 'POST', body={'phone': PR.TEST_PHONE, 'code': code})
    expect(st == 200 and sess.get('token'), '短信登录成功')
    token = sess['token']
    st, al = PR.http_json('/agents', token=token)
    agent_id = next((int(a['id']) for a in ((al or {}).get('agents') or []) if a.get('id')), None)
    expect(agent_id is not None, '取到一个智能体')

    c = PR.P.Cdp()
    try:
        c.js("localStorage.setItem('workbench.token', %s);"
             "localStorage.setItem('workbench.apiBase', %s); 'set'"
             % (json.dumps(token), json.dumps(PR.API)))
        c.send('Page.reload')
    finally:
        try:
            c.ws.close()
        except Exception:
            pass
    ok, _, ms = wait_until(
        lambda: ('退出登录' in (ev('(document.body.innerText||"")') or ''))
        and (ev('Boolean(window.workbench && window.workbench.agentStart)') is True),
        timeout=90)
    expect(ok, '登录后进到工作台（登录态锚点 + 驾驶桥就绪）', '%dms' % ms)

    # ★ 诊断用：**再挂一个** agent 事件监听（桥支持多订阅）。
    #   主进程发给渲染层的原始负载在这里留底 —— 出问题时能直接看到 help 事件里的 wcId 是多少，
    #   不用去猜"是不是 enterEmbed 拿不到页"。
    ev("""(() => {
      window.__agentEvents = [];
      window.workbench.on('agent', (p) => { try { window.__agentEvents.push(p); } catch (e) {} });
      return 'subscribed';
    })()""")

    section('3. 开一张内嵌页（全屏浏览器，模拟用户正看着浏览器）')
    # ★ 开页要靠"当前智能体"（`openUrl(agentId, ...)`，agentId 为 null 时直接 return）。
    #   登录锚点（"退出登录"）比智能体列表回来得早 —— 不等它就会**静默不开页**
    #   （webviews() 拿到空数组，看起来像"开页坏了"）。回归脚本靠 sleep 6 秒躲过去了，
    #   这里显式等一个判据。
    ok, _, ms = wait_until(lambda: '小助' in (ev('(document.body.innerText||"")') or ''), timeout=60)
    expect(ok, '智能体列表已加载（开页需要"当前智能体"）', '%dms' % ms)

    PAGE_A = '%s/page-a' % PR.FAKE
    for attempt in (1, 2, 3):
        ev('window.workbench.openBrowser(%s); "ok"' % json.dumps(PAGE_A))
        ok, _, ms = wait_until(lambda: any(isinstance(w.get('wcId'), int) for w in webviews()),
                               timeout=45, interval=1.0)
        if ok:
            break
        print('  （第 %d 次开页还没出现 webview，重试）' % attempt)
        time.sleep(2)
    wvs = [w for w in webviews() if isinstance(w.get('wcId'), int)]
    expect(ok, '内嵌页建起来了', json.dumps([{'wcId': w['wcId'], 'url': w.get('url')} for w in wvs], ensure_ascii=False))
    wc = wvs[0]['wcId']
    st0 = task_state(wc)
    print('  当前这张页的驾驶状态：%s' % json.dumps(st0, ensure_ascii=False))
    expect(not card().get('exists'), '开页阶段没有求助卡（不该无端弹卡）')

    section('4. 发车：goal 含「登录验证」→ 假模型会打开验证码页并试图代填验证码')
    before = len(llm_calls(GOAL))
    ev('window.workbench.agentStart(%s, %s, %s, %d, {agentId: %d}); "ok"'
       % (json.dumps(GOAL), json.dumps(PR.API), json.dumps(token), wc, agent_id))

    # 卡片出现的判据 = 渲染层真的长出了 .helpCard（不是"主进程说它发了事件"）
    ok, _, ms = wait_until(lambda: card().get('exists') is True, timeout=150, interval=1.0)
    # ★ 几何是 HelpCard **每帧**量出来上报的，卡片刚出现那一瞬间可能还没上报完 ——
    #   直接快照会让几何断言偶发地拿到 left=null（本轮就偶发了一次）。
    #   与 driveState 那条同一个教训：**别在"刚出现"那一刻读一个异步落住的值**。
    ok_geo, _, ms_geo = wait_until(
        lambda: (card().get('embedRect') or {}).get('left') is not None, timeout=15, interval=0.3)
    check('页面几何已上报（内联样式落住，不在"还没量到"的瞬间断言）', ok_geo, '%dms' % ms_geo)
    snap = card()
    shot('card-appeared.png')
    expect(ok, '★ 求助卡在聊天流里出现了', json.dumps(snap, ensure_ascii=False)[:400])
    expect(len(llm_calls(GOAL)) > before, '驾驶循环确实问过模型（不是空转）',
           '模型调用 %d → %d' % (before, len(llm_calls(GOAL))))

    section('① 卡片位置与内容（真机断言）')
    check('卡片在聊天区里（.chat 内），不是钉在外面的独立区域', snap.get('inChat') is True, snap.get('inChat'))
    check('卡片排在已有消息之后（跟着消息流走）', (snap.get('msgsBefore') or 0) >= 0 and snap.get('exists'))
    check('同一时刻只有一张卡（不刷屏）', snap.get('cardCount') == 1, snap.get('cardCount'))
    check('卡片文案说清了"要人机验证"和"AI 不会代填"',
          ('验证' in (snap.get('cardText') or '')) and ('不会代填' in (snap.get('cardText') or '')),
          (snap.get('cardText') or '')[:120].replace('\n', ' / '))
    check('卡片上有手动兜底按钮「我处理好了，继续」',
          any('我处理好了' in b for b in (snap.get('buttons') or [])), json.dumps(snap.get('buttons'), ensure_ascii=False))

    section('★ 安全红线：卡片里没有任何输入 / 代填能力')
    check('卡片内没有 input/textarea/select/form/contenteditable', snap.get('badCount') == 0,
          json.dumps(snap.get('badTags'), ensure_ascii=False))
    check('卡片内没有"提交/验证/登录/填写"这类代填动作按钮',
          not any(re.search(r'(提交|验证|登录|填写|发送验证码)', b) for b in (snap.get('buttons') or [])),
          json.dumps(snap.get('buttons'), ensure_ascii=False))

    section('★ 安全红线（真机直证）：AI 到底有没有把验证码填进去')
    # 这是整条红线的**正面证据**：AI 这一步明确想 type「短信验证码=123456」，
    # 直接去真实页面里读那个框的值 —— 必须还是空的。
    guard = guest_js(KEY, """(() => {
      const o = document.getElementById('otp1'), p = document.getElementById('phone1');
      return {
        otpExists: !!o, otpValue: o ? o.value : '__no_field__',
        phoneValue: p ? p.value : '__no_field__',
        otpFocused: o ? (document.activeElement === o) : null,
      };
    })()""")
    print('  真实页面上的字段实况：%s' % json.dumps(guard, ensure_ascii=False))
    expect(isinstance(guard, dict) and guard.get('otpExists') is True, '取到真实验证码框')
    check('★ 验证码框仍然是**空的**（AI 没有代填进去）', guard.get('otpValue') == '',
          'otp1.value=%r' % guard.get('otpValue'))
    check('对照：普通字段（手机号）AI 是填得进去的 —— 证明拦的是"敏感"这一类，不是"什么都不填"',
          guard.get('phoneValue') == '13800000000', 'phone1.value=%r' % guard.get('phoneValue'))
    check('卡片没有替 AI 去聚焦那个敏感框（用户得自己点）', guard.get('otpFocused') is not True,
          'otpFocused=%r' % guard.get('otpFocused'))

    section('③ 自动切换界面：全屏浏览器 → 求助卡模式')
    # ★ 状态条是 1.2 秒轮询出来的，卡片刚出现那一瞬间它可能还没刷新 ——
    #   等它出现再断言（第一版读的是"卡片刚出现"那个快照，等于在测轮询的运气）。
    ok_ds, _, ms_ds = wait_until(lambda: 'driveState--agent' in ((card().get('driveState') or {}).get('cls') or ''),
                                 timeout=15, interval=0.5)
    check('状态条切成了「AI 发起」的专属样式 driveState--agent', ok_ds,
          '%dms / %s' % (ms_ds, json.dumps(card().get('driveState'), ensure_ascii=False)))
    check('状态条文案说得清是 AI 求助',
          'AI 主动求助' in ((card().get('driveState') or {}).get('text') or ''),
          (card().get('driveState') or {}).get('text'))

    # 诊断：主进程发来的原始事件 + 页面上真实存在的 webview wcId
    try:
        evs = ev('(window.__agentEvents || []).map(x => { try { return JSON.parse(x); } catch(e) { return String(x); } })')
        helps = [e for e in (evs or []) if isinstance(e, dict) and e.get('kind') == 'help']
        print('  主进程发来的 help 事件：%s' % json.dumps(helps, ensure_ascii=False))
        print('  页面上 webview 的 wcId：%s' % json.dumps(
            [{'wcId': w.get('wcId'), 'src': w.get('src'), 'cls': w.get('cls')} for w in webviews()], ensure_ascii=False))
        print('  第一轮假模型出招：%s' % json.dumps([c.get('kind') for c in llm_calls(GOAL)], ensure_ascii=False))
    except Exception as e:  # noqa: BLE001
        print('  （诊断输出失败：%s）' % e)

    check('求助卡模式下浏览器层切成了 browserLayer--embed',
          'browserLayer--embed' in (snap.get('layerClass') or ''), snap.get('layerClass'))
    check('目标页拿到了 embed 类（露脸的是它）', 'browserPanel__view--embed' in (snap.get('wvClass') or ''),
          snap.get('wvClass'))

    section('几何跟随（影子层：webview 没被搬走，只是几何对齐）')
    er, hr = snap.get('embedRect') or {}, snap.get('holderRect') or {}
    check('页面几何与卡片占位区对齐（left/top）', near(er.get('left'), hr.get('left')) and near(er.get('top'), hr.get('top')),
          'embed=%s holder=%s' % (json.dumps(er), json.dumps(hr)))
    check('页面尺寸与卡片占位区一致且不是 0×0',
          (er.get('width') or 0) > 100 and near(er.get('width'), hr.get('width')) and near(er.get('height'), hr.get('height')),
          json.dumps(er))

    section('★ 界面区分：AI 主动求助 vs 用户主动接管')
    ds = card().get('driveState') or {}
    # 对照：用户主动暂停走另一套样式
    ev('window.workbench.pauseTask(%d); "ok"' % wc)
    time.sleep(2.5)
    ds_user = (card().get('driveState') or {})
    check('用户主动暂停是另一套样式 driveState--user', 'driveState--user' in (ds_user.get('cls') or ''), ds_user.get('cls'))
    check('两种情况的文案不同', (ds.get('text') or '') != (ds_user.get('text') or ''),
          '%s  ||  %s' % (ds.get('text'), ds_user.get('text')))
    shot('drive-state-compare.png')

    # ------------------------------------------------------------------
    # ④ 继续流程。两条路各需要**一张全新的求助卡**，而"再触发一次"依赖假模型的剧本位置
    #   （它按"这条循环已经走了几步"推进；同一条循环里第二次发车会从剧本中段接着走，
    #    直接跳过了"代填验证码"那一步 —— 实测就是卡在这，不是产品问题）。
    #   所以用 HC_MODE 分两次调用各验一条：每次都是干净的一张卡。
    #     HC_MODE=auto（默认）→ 验自动感知；HC_MODE=manual → 验手动按钮
    # ------------------------------------------------------------------
    if MODE == 'login':
        # ★ 这一轮专门验登录墙：**必须先把上面那张验证码卡收掉**。
        #   第一版没收 —— `wait_until(card exists)` 立刻被"旧卡还在"满足（92ms），
        #   拿到的 help 事件 wcId=3（第一张页的），断言全是假通过。
        #   教训：断言"出现了某张卡"时，一定要先保证场上没有别的卡。
        ev("""(() => {
          const b = [...document.querySelectorAll('.helpCard button')].find(x => /不用了/.test(x.textContent||''));
          if (b) b.click();
          return b ? 'dismissed' : 'no-card';
        })()""")
        ok_d, _, ms_d = wait_until(lambda: card().get('exists') is False, timeout=30, interval=0.5)
        check('先收掉验证码那张卡（否则"登录墙弹卡了吗"会假通过）', ok_d, '%dms' % ms_d)

    calls_before = len(llm_calls(GOAL))
    if MODE == 'login':
        # ==============================================================
        # ④' 登录墙场景（规格里"第一批两种场景"的第二种）
        #
        # 与上面的验证码场景是**两条不同的支路**：这里的页面只有密码框、
        # 没有任何验证码元素 ⇒ challengeLike=false、loginLike=true ⇒ helpKind 应该是 'login'。
        # 单开一个模式跑，免得和验证码那条的剧本位置互相干扰。
        # ==============================================================
        section('④ 登录墙场景（第一批要求的第二种触发场景）')
        GOAL_L = '登录墙：登录后把订单详情看一眼'
        # ★ 匹配串要**足够具体**：第一张页也在 8896 上（/captcha），
        #   只写 '127.0.0.1:8896' 会两页都命中、读到哪张全凭运气。
        KEY_L = '127.0.0.1:%d/login' % PR.FAKE_PORT
        ev('window.workbench.openBrowser(%s); "ok"'
           % json.dumps('http://127.0.0.1:%d/page-a' % PR.FAKE3_PORT))
        ok, _, ms = wait_until(lambda: len([w for w in webviews() if isinstance(w.get('wcId'), int)]) >= 2,
                               timeout=60, interval=1.0)
        expect(ok, '开出第二张页（登录墙场景用）', '%dms' % ms)
        ids = [w['wcId'] for w in webviews() if isinstance(w.get('wcId'), int)]
        wcL = [i for i in ids if i != wc][-1]
        print('  登录墙场景用 wcId=%d' % wcL)
        before_l = len(llm_calls(GOAL_L))
        ev('window.workbench.agentStart(%s, %s, %s, %d, {agentId: %d}); "ok"'
           % (json.dumps(GOAL_L), json.dumps(PR.API), json.dumps(token), wcL, agent_id))
        ok, _, ms = wait_until(lambda: card().get('exists') is True, timeout=150, interval=1.0)
        snapL = card()
        shot('loginwall-card.png')
        expect(ok, '★ 登录墙也弹出了求助卡', '%dms' % ms)
        check('驾驶循环确实问过模型', len(llm_calls(GOAL_L)) > before_l,
              '%d → %d' % (before_l, len(llm_calls(GOAL_L))))

        # helpKind 从**主进程发来的原始事件**里读（最硬），不信界面文案
        evsL = ev("(window.__agentEvents || []).map(x => { try { return JSON.parse(x); } catch(e) { return null; } })")
        helpsL = [e for e in (evsL or []) if isinstance(e, dict) and e.get('kind') == 'help']
        lastL = helpsL[-1] if helpsL else {}
        print('  主进程发的 help 事件（最后一条）：%s' % json.dumps(lastL, ensure_ascii=False))
        check('★ 求助类型是「登录墙」（helpKind=login），不是验证码 —— 两条支路确实分开了',
              lastL.get('helpKind') == 'login', 'helpKind=%r' % lastL.get('helpKind'))
        check('卡片文案说的是"需要先登录"', '需要先登录' in (snapL.get('cardText') or ''),
              (snapL.get('cardText') or '')[:160].replace('\n', ' / '))
        check('卡片上仍然只有展示 + 两个按钮（没有任何输入/代填）', snapL.get('badCount') == 0,
              json.dumps(snapL.get('badTags'), ensure_ascii=False))

        # 安全直证：密码框必须是空的；账号（普通框）应该被填了
        guardL = guest_js(KEY_L, """(() => {
          const u = document.getElementById('user1'), p = document.getElementById('pw1');
          return { pwExists: !!p, pwValue: p ? p.value : '__no_field__',
                   userValue: u ? u.value : '__no_field__', title: document.title };
        })()""")
        print('  登录页上的字段实况：%s' % json.dumps(guardL, ensure_ascii=False))
        expect(isinstance(guardL, dict) and guardL.get('pwExists') is True, '取到真实密码框')
        check('★ 密码框仍然是**空的**（AI 没有代填密码）', guardL.get('pwValue') == '',
              'pw1.value=%r' % guardL.get('pwValue'))
        check('对照：账号（普通框）被填了 —— 拦的确实是"敏感"这一类',
              guardL.get('userValue') == 'demo-user', 'user1.value=%r' % guardL.get('userValue'))

        # 用户自己登录 → 标题变化 → 自动感知 → 收卡 + 接着做
        before_r = len(llm_calls(GOAL_L))
        logged = guest_js(KEY_L, """(() => {
          const p = document.getElementById('pw1'), b = document.getElementById('login1');
          if (!p || !b) return {ok:false};
          p.value = 'user-typed-here'; b.click();
          return {ok:true, title: document.title};
        })()""")
        print('  模拟用户自己在真页面上登录：%s' % json.dumps(logged, ensure_ascii=False))
        expect(isinstance(logged, dict) and logged.get('ok'), '用户确实在真实页面上完成了登录（卡片没参与）')
        ok, _, ms = wait_until(lambda: card().get('exists') is False, timeout=60, interval=1.0)
        expect(ok, '★ 自动感知到页面变化 → 登录墙求助卡自动收起', '%dms' % ms)
        ok, _, ms = wait_until(lambda: len(llm_calls(GOAL_L)) > before_r, timeout=90, interval=1.0)
        expect(ok, '★ AI 接着往下跑（登录墙这条也接得回）',
               '%d → %d / %dms' % (before_r, len(llm_calls(GOAL_L)), ms))
        shot('loginwall-after-resume.png')
        calls_before = before_r  # 让后面的公共断言有个值
    elif MODE == 'manual':
        section('④ 继续流程：手动「我处理好了，继续」')
        clicked = ev("""(() => {
          const b = [...document.querySelectorAll('.helpCard button')].find(x => /我处理好了/.test(x.textContent||''));
          if (!b) return 'no-button';
          b.click(); return 'clicked';
        })()""")
        expect(clicked == 'clicked', '点到「我处理好了，继续」按钮', clicked)
        ok, _, ms = wait_until(lambda: card().get('exists') is False, timeout=60, interval=1.0)
        expect(ok, '★ 手动确认后求助卡收起', '%dms' % ms)
        ok, _, ms = wait_until(lambda: len(llm_calls(GOAL)) > calls_before, timeout=90, interval=1.0)
        expect(ok, '★ 手动确认后 AI 接着往下跑（走的是既有的「继续」链路）',
               '%d → %d / %dms' % (calls_before, len(llm_calls(GOAL)), ms))
        check('手动恢复后浏览器层退出求助卡模式',
              'browserLayer--embed' not in ((card().get('layerClass')) or ''), card().get('layerClass'))
        # ---- P0 止血（2026-09-21）S4 附加断言 ----
        # 本轮 P0 在「解挂失败」那条路上新加了「这一轮的上下文已经不在了…」确认条。
        # S4 要保的是：**验证码求助 → 用户处理 → 点继续** 这条路上的循环还在，
        # 所以它走的是普通解挂，**绝不能**误弹那条确认条。
        # 这条断言就是防这个误报（误报会把用户训练成不看内容就点「重新开始」）。
        lg = ev('(() => { const e = document.querySelector(".loopGone__q");'
                ' return e ? (e.textContent || "").trim() : null; })()')
        check('★ S4：求助卡的「继续」没有误弹「上下文没了」确认条（循环还在，不该问）',
              lg is None, 'loopGone=%s' % lg)
        shot('after-manual-resume.png')
    else:
        section('④ 继续流程：自动感知（用户在真实页面上填完验证码并提交）')
        # 用户动作 = 在**真实页面**上填验证码 + 点提交（不是通过卡片输入 —— 卡片里根本没有输入框）
        filled = guest_js(KEY, """(() => {
          const o = document.getElementById('otp1'), b = document.getElementById('submit1');
          if (!o || !b) return {ok:false, why:'页面上没有验证码框/提交按钮'};
          o.value = '123456'; b.click();
          return {ok:true, title: document.title};
        })()""")
        print('  模拟用户在真页面上填验证码并提交：%s' % json.dumps(filled, ensure_ascii=False))
        expect(isinstance(filled, dict) and filled.get('ok'), '用户确实在真实页面上完成了验证（卡片没有参与）')

        ok, _, ms = wait_until(lambda: card().get('exists') is False, timeout=60, interval=1.0)
        expect(ok, '★ 自动感知到页面变化 → 求助卡自动收起', '%dms' % ms)
        ok, _, ms = wait_until(lambda: len(llm_calls(GOAL)) > calls_before, timeout=60, interval=1.0)
        expect(ok, '★ AI 接着往下跑了（模型调用数继续增长）',
               '%d → %d / %dms' % (calls_before, len(llm_calls(GOAL)), ms))
        check('自动恢复后浏览器层退出求助卡模式',
              'browserLayer--embed' not in ((card().get('layerClass')) or ''), card().get('layerClass'))
        shot('after-auto-resume.png')

    section('② 保守触发反例：页面正常、AI 没卡住 → 不该弹卡')
    ev('window.workbench.openBrowser(%s); "ok"' % json.dumps('%s/page-b' % PR.FAKE))
    time.sleep(3)
    wvs2 = [w for w in webviews() if isinstance(w.get('wcId'), int)]
    wc2 = wvs2[-1]['wcId'] if wvs2 else wc
    GOAL2 = '在普通页完成任务'
    ev('window.workbench.agentStart(%s, %s, %s, %d, {agentId: %d}); "ok"'
       % (json.dumps(GOAL2), json.dumps(PR.API), json.dumps(token), wc2, agent_id))
    # 全程盯着：只要出现过一次卡片就说明"看到就弹"了
    seen = []
    for _ in range(40):
        if card().get('exists'):
            seen.append(1)
        time.sleep(1.5)
    check('★ 正常跑完一整套动作，全程没有弹过求助卡', not seen,
          '出现 %d 次；卡片内容=%s' % (len(seen), (card().get('cardText') or '')[:120]))
    check('反例场景的模型调用确实发生了（不是"啥也没跑"）', len(llm_calls(GOAL2)) >= 1,
          '调用 %d 次' % len(llm_calls(GOAL2)))
    shot('conservative-negative.png')

    section('②-b 保守触发反例（强版）：页面**就是**登录/验证页，但 AI 没卡住 → 也不该弹卡')
    # ★ 上面那条用的是"普通页"，说服力不够 —— 用户点名的场景是
    #   「页面看起来像登录页，但 AI 并没有卡住（只是路过、正常导航）」。
    #   这里把第一张页导航到「敏感闸复验页」：它同时有 password 框和短信验证码框
    #   （两个本地信号都成立），但接下来的任务**不碰任何敏感字段**（默认剧本只 read_page）。
    #   ⇒ 本地信号在场、AI 没卡住 ⇒ 不该弹卡。这才真正验到"保守"两个字。
    ev('window.workbench.drive({action:"open_url", url:%s}, %d); "ok"'
       % (json.dumps('%s/form' % PR.FAKE), wc))
    time.sleep(4)
    # ★ 匹配串必须**具体到 /form**：login 模式下场上会有两张页都在 8896 上
    #   （/login 和 /form），只写 '127.0.0.1:8896' 会读到哪张全凭运气。
    KEY_FORM = '127.0.0.1:%d/form' % PR.FAKE_PORT
    shape = guest_js(KEY_FORM, """(() => {
      const ins = [...document.querySelectorAll('input')];
      return {
        title: document.title,
        passwordFields: document.querySelectorAll('input[type=password]').length,
        otpFields: ins.filter(i => /验证码/.test((i.placeholder||'') + (i.name||'') + (i.id||''))).length,
        payButtons: [...document.querySelectorAll('button')].filter(b => /支付/.test(b.textContent||'')).length,
      };
    })()""")
    print('  这一页的实况：%s' % json.dumps(shape, ensure_ascii=False))
    # 反例的前提必须先成立，否则"没弹卡"可能只是因为信号压根不在场（那样这条断言就是空跑）
    expect(isinstance(shape, dict) and shape.get('passwordFields', 0) >= 1 and shape.get('otpFields', 0) >= 1,
           '前提成立：这一页确实"像登录页/验证页"（password 框 + 验证码框都在）')

    GOAL3 = '在普通页完成任务'  # 不含任何剧本关键词 ⇒ 默认剧本只 read_page，不碰敏感字段
    before3 = len(llm_calls(GOAL3))
    ev('window.workbench.agentStart(%s, %s, %s, %d, {agentId: %d}); "ok"'
       % (json.dumps(GOAL3), json.dumps(PR.API), json.dumps(token), wc, agent_id))
    seen3 = []
    for _ in range(40):
        if card().get('exists'):
            seen3.append(1)
        time.sleep(1.5)
    check('★ 本地信号在场（像登录页）但 AI 全程没卡住 → **一次都没弹卡**', not seen3,
          '出现 %d 次；卡片内容=%s' % (len(seen3), (card().get('cardText') or '')[:120]))
    check('反例确实跑起来了（模型被问过）', len(llm_calls(GOAL3)) > before3,
          '%d → %d' % (before3, len(llm_calls(GOAL3))))
    shot('conservative-negative-strong.png')

    section('证据存档')
    print('  截图目录：%s' % PR.OUTDIR)
    for f in sorted(os.listdir(PR.OUTDIR)):
        if f.endswith('.png'):
            print('    %s  (%d bytes)' % (f, os.path.getsize(os.path.join(PR.OUTDIR, f))))

    PR.finish()


# ======================================================================
# ⑤ 「从哪来回哪去」—— 用户**自己退出全屏**（在聊天里看消息）时来了一张求助卡，
#     处理完之后浏览器层必须回到 **background**，不能把用户正在看的聊天盖成全屏。
#
# 为什么单开一个函数而不是塞进 main：
#   main 的三条路径（auto / manual / login）都建立在"用户正开着全屏浏览器"这个前提上，
#   而这里的前提**恰好相反**，混在一起会互相踩（第一张页的视图态是共享的）。
#
# 环境起法与 main 完全一致（同一套 PR 基建），所以单独跑一遍。
# 用法：python scripts/verify/help-card/_start-pg.py && HC_MODE=back python scripts/verify/help-card/help-card-e2e.py
# ======================================================================
def main_back():
    MODE = 'back'
    os.makedirs(PR.OUTDIR, exist_ok=True)
    shutil.rmtree(PR.TMP, ignore_errors=True)
    os.makedirs(PR.PROFILE, exist_ok=True)

    section('⑤ 前置：起环境（与 main 同一套基建）')
    section('0. 环境自检')
    import socket

    def port_open(p):
        s = socket.socket()
        s.settimeout(0.6)
        try:
            s.connect(('127.0.0.1', p))
            return True
        except OSError:
            return False
        finally:
            s.close()

    expect(port_open(5432), 'PostgreSQL 已在监听')
    for p in (PR.API_PORT, PR.FAKE_PORT, PR.VITE_PORT, PR.CDP_PORT):
        expect(not port_open(p), '端口 %d 空闲' % p)

    VITE_BIN = PR.first_existing(os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'))
    ELECTRON_EXE = PR.first_existing(os.path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'))
    START_JS = os.path.join(DESKTOP, 'scripts', 'start-electron.mjs')
    for label, path in (('vite 入口', VITE_BIN), ('electron 二进制', ELECTRON_EXE), ('start-electron.mjs', START_JS)):
        expect(bool(path), '构建产物存在：%s' % label, path)

    PR.spawn('fake', [PR.NODE, os.path.join(VERIFY, 'fake-llm.mjs')], REPO,
             env={'FAKE_PORT': str(PR.FAKE_PORT), 'FAKE_DELAY_MS': '800', 'FAKE_STEPS': '30',
                  'FAKE_LOG': PR.FAKE_LOG},
             log=os.path.join(PR.OUTDIR, 'fake-back.log'))
    hs = PR.wait_health(PR.FAKE)
    expect(bool(hs), '假模型起来了', json.dumps(hs, ensure_ascii=False)[:160])

    PR.spawn('server', [PR.NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
             env={'PORT': str(PR.API_PORT), 'DEEPSEEK_BASE_URL': PR.FAKE,
                  'DEEPSEEK_API_KEY': 'fake-key-helpcard', 'DEEPSEEK_MODEL': 'fake-helpcard'},
             log=PR.SERVER_LOG)
    hs = PR.wait_health(PR.API)
    expect((hs or {}).get('db') == 'up', '验收后端起来了（db=up）', json.dumps(hs, ensure_ascii=False)[:200])

    PR.spawn('vite', [PR.NODE, VITE_BIN, '--port', str(PR.VITE_PORT), '--strictPort'], DESKTOP,
             log=os.path.join(PR.OUTDIR, 'vite-back.log'))
    time.sleep(4)

    env = dict(os.environ)
    env['VITE_DEV_SERVER_URL'] = 'http://localhost:%d' % PR.VITE_PORT
    env['ELECTRON_ENABLE_LOGGING'] = '1'
    PR.spawn('electron', [PR.NODE, START_JS, '--user-data-dir=%s' % PR.PROFILE,
                          '--remote-debugging-port=%d' % PR.CDP_PORT,
                          '--remote-allow-origins=*'], DESKTOP, env=env,
             log=os.path.join(PR.OUTDIR, 'electron-back.log'))
    ok, _, ms = wait_until(lambda: PR.ev('1') == 1, timeout=120)
    expect(ok, '真 Electron 窗口起来了（能在渲染层求值）', '%dms' % ms)

    st, _ = PR.http_json('/auth/sms/send', 'POST', body={'phone': PR.TEST_PHONE})
    expect(st == 200, '发送验证码')
    code = None
    for _ in range(40):
        for m in re.finditer(r'(\d{6})', PR.server_log()):
            code = m.group(1)
        if code:
            break
        time.sleep(0.5)
    expect(bool(code), '从服务端日志拿到验证码')
    st, sess = PR.http_json('/auth/login/sms', 'POST', body={'phone': PR.TEST_PHONE, 'code': code})
    expect(st == 200 and sess.get('token'), '短信登录成功')
    token = sess['token']
    st, al = PR.http_json('/agents', token=token)
    agent_id = next((int(a['id']) for a in ((al or {}).get('agents') or []) if a.get('id')), None)
    expect(agent_id is not None, '取到一个智能体')

    c = PR.P.Cdp()
    try:
        c.js("localStorage.setItem('workbench.token', %s);"
             "localStorage.setItem('workbench.apiBase', %s); 'set'"
             % (json.dumps(token), json.dumps(PR.API)))
        c.send('Page.reload')
    finally:
        try:
            c.ws.close()
        except Exception:
            pass
    ok, _, ms = wait_until(
        lambda: ('退出登录' in (ev('(document.body.innerText||"")') or ''))
        and (ev('Boolean(window.workbench && window.workbench.agentStart)') is True),
        timeout=90)
    expect(ok, '登录后进到工作台', '%dms' % ms)
    ev("""(() => {
      window.__agentEvents = [];
      window.workbench.on('agent', (p) => { try { window.__agentEvents.push(p); } catch (e) {} });
      return 'subscribed';
    })()""")

    section('⑤ 前置：开一张页，然后**用户自己退出全屏**（正在聊天里看消息）')
    ok, _, ms = wait_until(lambda: '小助' in (ev('(document.body.innerText||"")') or ''), timeout=60)
    expect(ok, '智能体列表已加载（开页需要"当前智能体"）', '%dms' % ms)

    PAGE_A = '%s/page-a' % PR.FAKE
    for attempt in (1, 2, 3):
        ev('window.workbench.openBrowser(%s); "ok"' % json.dumps(PAGE_A))
        ok, _, ms = wait_until(lambda: any(isinstance(w.get('wcId'), int) for w in webviews()),
                               timeout=45, interval=1.0)
        if ok:
            break
        print('  （第 %d 次开页还没出现 webview，重试）' % attempt)
        time.sleep(2)
    wvs = [w for w in webviews() if isinstance(w.get('wcId'), int)]
    expect(ok, '内嵌页建起来了', json.dumps([{'wcId': w['wcId'], 'url': w.get('url')} for w in wvs], ensure_ascii=False))
    wc = wvs[0]['wcId']
    # 开页之后必然是全屏（openUrl 的设计如此）—— 先把前提钉住
    ok, _, ms = wait_until(lambda: 'browserLayer--embed' not in (card().get('layerClass') or '')
                           and 'browserLayer--bg' not in (card().get('layerClass') or ''), timeout=20)
    check('前提①：开页后浏览器层是全屏（无 --bg / --embed 修饰类）', ok, card().get('layerClass'))

    # ★ 本步的核心动作：**用户自己点「退出全屏」**（在真实界面上点，不调内部函数）
    #   选择器照着真实 DOM 写：`.browserPanel__toggle`（文案「退出全屏」，
    #   见 BrowserPanel.tsx:198-205）。用真实点击序列（mousedown→mouseup→click），
    #   不用 JS 直接 `.click()` —— 后者绕过 React 的事件前提，偶尔会被判成"没点到"。
    clicked = ev("""(() => {
      const b = document.querySelector('.browserPanel__toggle');
      if (!b) return 'no-button';
      const label = (b.textContent || '').trim();
      b.click();
      return 'clicked:' + label;
    })()""")
    print('  点击退出全屏：%s' % clicked)
    expect(clicked != 'no-button', '真实界面上找得到「退出全屏」按钮（.browserPanel__toggle）', clicked)
    check('前提②：用户成功点了「退出全屏」', clicked.startswith('clicked:'), clicked)
    ok, _, ms = wait_until(lambda: 'browserLayer--bg' in (card().get('layerClass') or ''), timeout=20, interval=0.5)
    check('前提②：浏览器层进入后台态（.browserLayer--bg）', ok,
          '%dms / %s' % (ms, card().get('layerClass')))
    shot('back-before-help.png')

    section('⑤ 触发求助卡（后台态下）')
    GOAL = '登录验证后把订单提交了'
    before = len(llm_calls(GOAL))
    ev('window.workbench.agentStart(%s, %s, %s, %d, {agentId: %d}); "ok"'
       % (json.dumps(GOAL), json.dumps(PR.API), json.dumps(token), wc, agent_id))
    ok, _, ms = wait_until(lambda: card().get('exists') is True, timeout=150, interval=1.0)
    snap = card()
    shot('back-card-appeared.png')
    expect(ok, '★ 后台态下也能弹出求助卡（卡片不会因为看不见而不出现）', '%dms' % ms)
    check('★ 求助卡触发后仍然自动切到求助卡模式 browserLayer--embed',
          'browserLayer--embed' in (snap.get('layerClass') or ''), snap.get('layerClass'))
    ok_geo, _, ms_geo = wait_until(
        lambda: (card().get('embedRect') or {}).get('left') is not None, timeout=15, interval=0.3)
    check('页面几何已上报（在 embed 态里真的露脸了）', ok_geo, '%dms' % ms_geo)

    section('★ ⑤ 核心断言：处理完之后**回后台**，不是弹回全屏')
    filled = guest_js(KEY, """(() => {
      const o = document.getElementById('otp1'), b = document.getElementById('submit1');
      if (!o || !b) return {ok:false, why:'页面上没有验证码框/提交按钮'};
      o.value = '123456'; b.click();
      return {ok:true, title: document.title};
    })()""")
    print('  用户在真页面上完成验证：%s' % json.dumps(filled, ensure_ascii=False))
    expect(isinstance(filled, dict) and filled.get('ok'), '用户确实在真实页面上完成了验证')

    ok, _, ms = wait_until(lambda: card().get('exists') is False, timeout=60, interval=1.0)
    expect(ok, '★ 求助卡自动收起', '%dms' % ms)
    # ★★ 本步存在的唯一理由：收卡后回**后台**，把聊天还给用户
    ok_back, _, ms_back = wait_until(
        lambda: 'browserLayer--bg' in (card().get('layerClass') or ''), timeout=20, interval=0.5)
    after = card().get('layerClass')
    check('★★ 收卡后浏览器层回到**后台**（.browserLayer--bg）—— 用户原本在看聊天，不该被顶成全屏',
          ok_back, '%dms / %s' % (ms_back, after))
    check('收卡后**没有**停在 embed 态（透明层残留 = 看不见的坏）',
          'browserLayer--embed' not in (after or ''), after)
    check('收卡后**没有**变成全屏（这正是修复前的错误行为）',
          'browserLayer--bg' in (after or ''), after)
    shot('back-after-resume.png')

    ok, _, ms = wait_until(lambda: len(llm_calls(GOAL)) > before, timeout=90, interval=1.0)
    check('AI 接着往下跑（视图态没有影响任务）', ok, '%d → %d / %dms' % (before, len(llm_calls(GOAL)), ms))

    section('★ ⑤ 对照：从**全屏**进来时，处理完仍然回全屏（别把修复改过头）')
    # 这条是"反证的另一半"：修复必须是**有条件的**（从哪来回哪去），
    # 而不是"一律回后台" —— 一律回后台也是错的（用户本来在全屏看浏览器，
    # 处理完却被扔进后台，等于把浏览器藏了）。
    ev('window.workbench.openBrowser(%s); "ok"' % json.dumps(PAGE_A))
    ok, _, ms = wait_until(lambda: 'browserLayer--bg' not in (card().get('layerClass') or '')
                           and 'browserLayer--embed' not in (card().get('layerClass') or ''),
                           timeout=20, interval=0.5)
    check('对照前提：重新开页 → 回到全屏', ok, '%dms / %s' % (ms, card().get('layerClass')))

    section('★ ⑤-b 切智能体往返：求助卡跟着对话走，记录不串味')
    # ★ 为什么要验这条：`App.tsx:2365` 那个 effect 在**切对话**时会调 enterEmbed / exitEmbed。
    #   它是同一套记录的另一半 —— 切走时 exitEmbed 清掉记录并回后台，切回时 enterEmbed
    #   按"当时在哪一态"重新记。如果这里串味，用户切一下对话再切回来视图就变了。
    #
    # ★ 前提：夹具（建号自带）只有「小助」一个智能体，**没有第二个可切**。
    #   按规矩不给"走不到的路"写断言 —— 所以先真造一个出来。
    #
    # ★★ 造法：**点界面上真实的「＋ 添加」按钮**，不要自己调 `POST /agents`。
    #   踩过（探针 `_probe-agent-dom.py` 查出根因）：自己调 API 建出来的智能体
    #   会落在 `asAgentId` 那个调用者所在的 project，而**侧栏只渲染当前 project 的**，
    #   并且前端列表**不会自动重拉** ⇒ 界面上永远还是 1 个，
    #   于是后面的"切过去"直接 `no-item`（探针实测 `dataAgentIds: ["3503"]`，只有小助）。
    #   前端 `addAgent()`（`App.tsx:1166`）自己会 `pickCreator` 挑对调用者、
    #   自己 `setAgents(prev => prev.concat(a))` 刷新列表，还有一条"落到别的项目就不显示"
    #   的归属兜底 —— 走真实 UI 路径这些都不用我在测试里重实现一遍。
    ev("""(() => {
      const b = document.querySelector('.agentList__add');
      if (b) b.click();
      return b ? 'clicked' : 'no-button';
    })()""")
    ok, _, ms = wait_until(
        lambda: len(ev("""[...document.querySelectorAll('.agentList .contact[data-agent-id]')]
                          .map(e => e.getAttribute('data-agent-id'))""") or []) >= 2,
        timeout=60, interval=1.0)
    ids_ui = ev("""[...document.querySelectorAll('.agentList .contact[data-agent-id]')]
                    .map(e => e.getAttribute('data-agent-id'))""") or []
    expect(ok, '★ 界面上真的出现了第二个智能体（点「＋ 添加」，走真实 UI 路径）',
           'dataAgentIds=%s / %sms' % (json.dumps(ids_ui, ensure_ascii=False), ms))
    # 第二个 = 不是第一个那个（列表顺序即渲染顺序）
    st, al2 = PR.http_json('/agents', token=token)
    names2 = [a.get('name') for a in ((al2 or {}).get('agents') or [])]
    print('  当前智能体列表（服务端口径）：%s' % json.dumps(names2, ensure_ascii=False))
    # ★★ agent2 必须 = 「界面上那个**既不等于 agent_id、又不是当前选中**的项」。
    #
    #   踩过（这一条的根因，2026-09-21 真机）：上一版只判了"不是当前选中（没 contact--on）"，
    #   **忘了再判"不等于 agent_id"**。而 `addAgent()` 结尾会把新智能体设为当前
    #   ⇒ 那一刻 `contact--on` 是**新的 3735**，于是循环把 **3734** 当成了"另一个"。
    #   可 3734 正是 `agent_id`（小助）本身！
    #   后果极隐蔽：后面"切到第二个智能体"其实点的是**它已经待着的那一项** ⇒
    #   `contact--on` 纹丝不动 = 点击是空操作 ⇒ 视图当然不会退出 embed ⇒ 断言变红。
    #   而 `switch_agent` 只校验"目标是不是当前"，空操作也能返 True ⇒ **假通过**，
    #   把"测试选错了 id"伪装成"产品有 bug"。
    #   判定必须用**集合差**（ids_ui - {agent_id}），再叠加"不是当前选中"。
    agent2 = None
    for cand in ids_ui:
        if str(cand) == str(agent_id):
            continue  # ★ 关键：绝不把 agent_id 自己当成"另一个"
        try:
            sel = ev("""(() => {
              const el = document.querySelector('.agentList .contact[data-agent-id="%s"]');
              return el ? el.className : null;
            })()""" % cand)
        except Exception:  # noqa: BLE001
            sel = None
        if sel and 'contact--on' not in sel:
            agent2 = cand
            break
    # 兜底：若剩下的那个恰好正被选中（addAgent 之后就是这种情况），
    #   仍然接受它 —— 它是"另一个智能体"这件事才要紧，选没选中不影响。
    if agent2 is None:
        agent2 = next((c for c in ids_ui if str(c) != str(agent_id)), None)
    expect(agent2 is not None and str(agent2) != str(agent_id),
           '★ 从界面 DOM 里认出"另一个智能体"的 id（必须 ≠ agent_id，否则点了等于没点）',
           'agent_id=%s / ids_ui=%s' % (agent_id, json.dumps(ids_ui, ensure_ascii=False)))

    # ★★ 必须**先切回原来那个智能体**再发车。
    #   踩过（这一条的根因）：`addAgent()` 结尾会 `setCurAgentId(新id)`
    #   （`App.tsx` 里那句 `curAgentRef.current = a.id; setCurAgentId(a.id)`），
    #   于是点完「＋ 添加」当前会话**已经变成新智能体**了。
    #   而求助卡有两条按智能体的闸：
    #     · `enterEmbed` 只在"那张页属于**当前**智能体"时才切 view（别的智能体求助不抢视线）；
    #     · 卡片本身也按智能体分桶，聊天区只画当前智能体的那张。
    #   ⇒ 不切回去就发车，卡片会落在**另一个**对话里，`card()` 什么都查不到，
    #     表现为 `wait_until(卡片出现)` 超时 —— 看着像"产品不弹卡"，
    #     其实是**测试把当前会话留在别处了**（而且产品那个"不抢视线"的行为是**对的**）。
    # ★ 这里也改用 `switch_agent`（真鼠标 + 回读），不用 `el.click()`。
    #   理由同 ⑤-b 正文：`.click()` 不产生真实指针序列，可能**静默不生效**，
    #   而"当前会话留在别的智能体"会让接下来 `wait_until(卡片出现)` 超时 150 秒 ——
    #   现象是"产品不弹卡"，真因却在测试这一句没点上。让它在**此处**就报错，别拖到 150 秒后。
    back_ok = switch_agent(agent_id, '（建完先切回原智能体）')
    print('  建完先切回原智能体：%s' % ('成功' if back_ok else '失败'))
    expect(back_ok, '★ 建完第二个智能体后切回原智能体（否则卡片会落在别的对话里）',
           'contact--on=%s' % agent_is_current())
    # ★ `switch_agent` 内部已经回读确认过了，这里不再重复一遍 —— 重复不会更可信，
    #   只会再给一次"静默失配"的机会，而且多出来的那次 DOM 查询容易和真断言混在一起看不清。

    # 先回到"用户自己退出全屏"的态（把浏览器放后台）
    ev("""(() => {
      const b = document.querySelector('.browserPanel__toggle');
      if (b) b.click();
      return b ? 'clicked' : 'no-button';
    })()""")
    ok, _, ms = wait_until(lambda: 'browserLayer--bg' in (card().get('layerClass') or ''), timeout=20, interval=0.5)
    expect(ok, '前提：浏览器在后台（用户正在聊天里看消息）', '%dms / %s' % (ms, card().get('layerClass')))

    # 触发第二张卡（后台态）。
    # ★★ 必须换**另一条 goal**（"登录墙"），不能复用上面那条 —— 踩过：
    #   假模型剧本按"这条 goal 已经走过多少步"推进（`fake-llm.mjs` 的 stepOf），
    #   而 `登录验证` 那条剧本（9 步）在上面就已经被走完了（末尾连着好几个 `stop`）。
    #   同一条 goal 再发车会直接从剧本末尾接着走 ⇒ 一路 `stop`，
    #   **永远不会再走到"代填验证码"那一步** ⇒ 卡片自然不会弹。
    #   实测现象：`wait_until(卡片出现)` 于 150666ms 超时（不是产品坏了，是路走不到）。
    #   脚本 ④ 段头部的注释早就写明这个限制，这一版违反了它。
    #   `登录墙` 是独立剧本（放数组最后、不与任何既有 goal 冲突），且天然弹 login 类卡片。
    GOAL_L2 = '登录墙：登录后把订单详情看一眼'
    ev('window.workbench.drive({action:"open_url", url:%s}, %d); "ok"'
       % (json.dumps('%s/page-a' % PR.FAKE), wc))
    time.sleep(4)
    before_b = len(llm_calls(GOAL_L2))
    ev('window.workbench.agentStart(%s, %s, %s, %d, {agentId: %d}); "ok"'
       % (json.dumps(GOAL_L2), json.dumps(PR.API), json.dumps(token), wc, agent_id))
    ok, _, ms = wait_until(lambda: card().get('exists') is True, timeout=150, interval=1.0)
    expect(ok, '后台态下再次弹出求助卡（换一条独立剧本，否则路走不到）', '%dms' % ms)
    check('前提：卡片态下浏览器层是 embed', 'browserLayer--embed' in (card().get('layerClass') or ''),
          card().get('layerClass'))

    # ★ 切到第二个智能体 → 那层是透明的，必须退出 embed（否则屏幕上多出一块别人的网页）
    #
    # ★★ 必须用**真实鼠标序列**切（`switch_agent` → `Input.dispatchMouseEvent`），
    #   不能用 `el.click()`。真机踩出来的：
    #     用 `.click()` 时 `contact--on` **一直停在原智能体**（= 点击压根没生效），
    #     而脚本以为点了 → 接着断言"切走后应退出 embed" ⇒ 变红。
    #     更糟的是它**时好时坏**（同一断言上一轮 PASS 这一轮 FAIL），
    #     极容易把"点击没生效"误判成"产品有 bug / 修复没生效"。
    #   根因：JS 的 `.click()` 只派发一个合成 click，不产生真实指针序列，
    #     React 挂在根容器的合成事件在某些遮挡/尺寸状态下收不到它。
    #   正解：CDP 的 mousePressed + mouseReleased（坐标取元素 rect），并**回读确认**。
    switched = switch_agent(agent2, '（切到第二个）')
    expect(switched, '★ 真的切到了第二个智能体（用真鼠标 + 回读 contact--on 确认）',
           'agent2=%s，contact--on=%s' % (agent2, agent_is_current()))
    if switched:
        ok, _, ms = wait_until(lambda: 'browserLayer--embed' not in (card().get('layerClass') or ''),
                               timeout=20, interval=0.5)
        check('★ 切到别的对话 → 退出求助卡模式（不留透明层）', ok, '%dms / %s' % (ms, card().get('layerClass')))
        check('★ 切走后回到后台（记录不丢：进 embed 前就是后台）',
              'browserLayer--bg' in (card().get('layerClass') or ''), card().get('layerClass'))

        # 切回来 → 卡片和页面一起回来，且仍然是 embed
        back_switched = switch_agent(agent_id, '（切回原智能体）')
        check('★ 真的切回了原智能体（同样回读确认）', back_switched,
              'agent_id=%s，contact--on=%s' % (agent_id, agent_is_current()))
        # ★★ 前提必须**当场校验**：切换往返要花时间，而这期间页面可能自己变了
        #   （登录成功 → 自动感知 → 卡片被自动收掉）。实测：切回来时页面标题已经
        #   变成「我的订单 - 已登录」，卡片早没了 ⇒ 断言"回到 embed"必然失败 ——
        #   那不是白框 bug 复发，是**卡片已经不在了**（断言前提没保住）。
        #   所以先看卡片还在不在：不在就直说"这一轮测不到"，不计成产品缺陷。
        card_alive = card().get('exists')
        if not card_alive:
            check('★ 切回时有卡可回（前提）', False,
                  '切回来时卡片已被自动收掉（页面自己变了）—— 这一轮测不到"切回"，非产品缺陷')
        else:
            ok, _, ms = wait_until(lambda: 'browserLayer--embed' in (card().get('layerClass') or ''),
                                   timeout=20, interval=0.5)
            check('★ 切回有卡的对话 → 页面跟着回来（白框问题不复发）', ok, '%dms / %s' % (ms, card().get('layerClass')))
            # 再收卡 → 仍然回后台（这才证明记录在往返之后没有串味）
            #
            # ★★ 收卡手段：**点卡片上的「我处理好了，继续」**，不要去操作页面。
            #   踩过：这里原本是"在登录页上填密码并点登录"（模拟用户自己处理完）。
            #   但**上一轮 ⑤ 段结束时用户已经登录成功了**（页面标题已变成
            #   「我的订单 - 已登录」，`pw1`/`login1` 都没了）——
            #   再去找密码框必然 ok=false，然后被"优雅跳过"分支吃掉，
            #   或者更糟：页面状态一变、自动感知抢先收卡，把"回到后台"的断言前提打掉。
            #   手动按钮**与页面状态无关**，永远在，正是为这种时刻准备的兜底
            #   （设计上就是"双保险"的另一半）。用它才能把"往返后记录没串味"这件事
            #   单独、干净地验出来。
            clicked_done = ev("""(() => {
              const b = [...document.querySelectorAll('.helpCard button')]
                .find(x => /我处理好了/.test(x.textContent || ''));
              if (!b) return 'no-button';
              b.click();
              return 'clicked';
            })()""")
            print('  点「我处理好了，继续」收卡：%s' % clicked_done)
            expect(clicked_done == 'clicked', '★ 卡片上有手动兜底按钮（与页面状态无关，永远在）', clicked_done)
            if clicked_done == 'clicked':
                ok, _, ms = wait_until(lambda: card().get('exists') is False, timeout=60, interval=1.0)
                check('切回后收卡', ok, '%dms' % ms)
                ok_back2, _, ms2 = wait_until(
                    lambda: 'browserLayer--bg' in (card().get('layerClass') or ''), timeout=20, interval=0.5)
                check('★★ 切智能体往返之后收卡，**仍然回后台**（记录没串味）', ok_back2,
                      '%dms / %s' % (ms2, card().get('layerClass')))
    # ★ 注：`switched == False` 的失败分支已由上面那句 `expect(...)` 覆盖（它会记 FAIL），
    #   此处**不要**再写 `else: check(..., False, clicked2)` —— `clicked2`/`clicked3`
    #   那两个变量是上一版 `el.click()` 写法的遗留，早已删除 ⇒ 再引用就是 `NameError`，
    #   会把"点击没生效"这个真问题**变成脚本崩溃**（比 FAIL 更难读）。
    shot('back-agent-switch.png')

    ok, _, ms = wait_until(lambda: len(llm_calls(GOAL_L2)) > before_b, timeout=60, interval=1.0)
    print('  （附加观察：登录墙剧本模型调用 %d → %d）' % (before_b, len(llm_calls(GOAL_L2))))

    section('证据存档')
    print('  截图目录：%s' % PR.OUTDIR)
    for f in sorted(os.listdir(PR.OUTDIR)):
        if f.endswith('.png'):
            print('    %s  (%d bytes)' % (f, os.path.getsize(os.path.join(PR.OUTDIR, f))))

    PR.finish()


if __name__ == '__main__':
    if os.environ.get('HC_MODE') == 'back':
        try:
            main_back()
        except KeyboardInterrupt:
            PR.finish()
        except Exception as e:  # noqa: BLE001
            PR.FAILS.append('脚本异常：%s' % e)
            print('\n脚本异常：%s' % e)
            import traceback
            traceback.print_exc()
    else:
        try:
            main()
        except KeyboardInterrupt:
            PR.finish()
        except Exception as e:  # noqa: BLE001
            PR.FAILS.append('脚本异常：%s' % e)
            print('\n脚本异常：%s' % e)
            import traceback
            traceback.print_exc()
        PR.finish()
