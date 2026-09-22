"""P0 止血 —— **真机端到端**验收（真 Electron + 真服务端 + 真 PG + 真驾驶循环 + 真 CDP）

## 它要证明的四件事（对应简报的 S1–S3，外加一条"算了"要收干净）
  S1  暂停 → 等的比 TTL 还久 → 点继续
      a. 出现**明确提示**（"这一轮的上下文已经不在了…要重新开始吗？"）
      b. **不发生自动重跑**（点完继续，模型一次都没被问）
      c. 状态机没有偷偷回到 running
      d. 只有用户点了「重新开始」之后，才真的新建一轮（且是**新开**，不是"恢复"）
  S1b 同样造出"上下文已不在"，这次点「算了」
      e. 确认条消失、界面回到"已停止"、不再有任何模型调用（不留半死不活的状态）
  S2  正常暂停 → 立刻点继续 → 行为与现在一致：**正常恢复**、且**不**弹那条确认
  S3  步数打断 → 说"继续" → 行为一致：正常恢复、**不**弹那条确认

★ S3 有个必须先说清楚的前提：用户 2026-09-20 拍板「默认不再按步数打断任务」
  （`AGENT_LOOP_MAX_STEPS` 默认 0 = 不限步数），所以**当前默认配置下步数打断根本不会触发**。
  为了仍能验这条路径，本脚本把服务端配成 `AGENT_LOOP_MAX_STEPS=6` 复现旧的步数打断，
  再走「继续」。这是**配置复现**，不等于"默认配置下会走到" —— 报告里会分开说。

## 为什么 TTL 要临时调小、又必须改回来
S1 要的是"等超过 TTL"。生产值是 6 小时，真机等 6 小时不现实。
所以本脚本**临时**把它压到 `P0_WAIT_TTL_SEC`（默认 45 秒），跑完在 `finally` 里恢复
并**重新构建 dist + grep 复查**（改动关键常量必须复查，这是踩过的坑）。

## 页面用**真实公开只读站**，不是本地自建的假页面（用户 2026-09-21 拍板）
以前这套验收开的是 `127.0.0.1:8895/page-a` 那种自造页面 —— 页面是我们写的，
等于在自己造的地形上证明自己会走路。现在换成真实站点：真实网络、真实 TLS、
真实 DOM、真实加载耗时（默认 https://example.com，可用 `P0_PAGE` 换）。

★ 但**模型仍是脚本假模型**，并且**绝对禁止不可逆动作**（用户 2026-09-21 拍板）：
在别人的真实站点上跑验收时，绝不能让 AI 真的去点「提交 / 发送 / 下单」——
那正是这个 P0 修复要防的事，拿它去制造真实后果是本末倒置。两道闸：
  ① 前置闸 `check_no_plan_match()`：目标不含任何假模型剧本关键词 ⇒ 模型只会出 read_page；
  ② 运行时闸 `check_still_on_real_page()`：每个场景收尾回读地址，域名变了就判失败。

## 用法（★ 必须同一次调用：先起 PG 再跑本脚本；且必须是装了 websocket 的那个 Python）
    python scripts/verify/help-card/_start-pg.py && python scripts/verify/p0-loop-ttl/p0-e2e.py
"""
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
VERIFY = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(VERIFY))
DESKTOP = os.path.join(REPO, 'apps', 'desktop')

# 端口另起，绝不动用户自己的 8787 / 5173 / 8901
os.environ.setdefault('API_PORT', '8795')
os.environ.setdefault('FAKE_PORT', '8895')
os.environ.setdefault('FAKE2_PORT', '8896')
os.environ.setdefault('FAKE3_PORT', '8897')
os.environ.setdefault('VITE_PORT', '5182')
os.environ.setdefault('CDP_PORT', '9345')

# 复用「暂停/继续」那套已验证的基建（起环境 / CDP / 等条件 / 断言 / 收尾）
_spec = importlib.util.spec_from_file_location('pr', os.path.join(VERIFY, 'pause-resume-tests.py'))
PR = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(PR)

PR.OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'p0-loop-ttl')
PR.TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wbp0ttl')
PR.PROFILE = os.path.join(PR.TMP, 'profile')
PR.FAKE_LOG = os.path.join(PR.OUTDIR, 'llm.jsonl')
PR.SERVER_LOG = os.path.join(PR.OUTDIR, 'server-%d.log' % PR.API_PORT)

section, check, expect = PR.section, PR.check, PR.expect

class ScenarioAbort(Exception):
    """场景的前置条件不满足 —— 只中止这一个场景，不杀整套环境。"""


def need(cond, name, note=''):
    """场景内部版的 expect：失败只中止本场景。

    为什么不能用 PR.expect：它失败会调 finish()，把 fake/服务端/vite/Electron
    全杀掉 —— 真机一套环境要几分钟才起来，一个场景的前置没过不该把后面几个一起赔进去。
    """
    ok = check(name, bool(cond), note)
    if not ok:
        raise ScenarioAbort(name)
    return ok
ev, eva, guest_js, webviews, task_state, llm_calls, wait_until = (
    PR.ev, PR.eva, PR.guest_js, PR.webviews, PR.task_state, PR.llm_calls, PR.wait_until,
)
spawn, http_json, wait_health, server_log, port_busy, finish = (
    PR.spawn, PR.http_json, PR.wait_health, PR.server_log, PR.port_busy, PR.finish,
)
P = PR.P

# ★ 目标必须是**中性只读**的：假模型 `planFor()` 按 `goal.includes(key)` 命中剧本，
#   剧本里有「type 验证码 → click 提交验证 → click 去下单」这种不可逆序列。
#   在**真实网站**上跑验收时绝不能让模型走出那些招 —— 所以目标里不能出现任何关键词，
#   让它只走 `read_page` 那条支路。（下面 check_no_plan_match() 会把这条闸变成硬断言。）
GOAL_S1 = 'P0S1读一下这张页面主要讲了什么'
GOAL_S1B = 'P0S1B读一下这张页面主要讲了什么'
GOAL_S2 = 'P0S2读一下这张页面主要讲了什么'
GOAL_S3 = 'P0S3读一下这张页面主要讲了什么'

# ★ 真实验收用的是**公开只读站**，不是本地自建的假页面（用户 2026-09-21 拍板）。
#   页面是真的：真实网络、真实 TLS、真实 DOM、真实加载耗时。
#   模型仍是脚本假模型 —— 保证可重复，也保证不会在别人站上真的点出不可逆动作。
REAL_PAGE = os.environ.get('P0_PAGE', 'https://example.com')
PAGE_HOST = re.sub(r'^https?://', '', REAL_PAGE).split('/')[0]
TEST_PHONE = os.environ.get('PR_PHONE') or ('186%08d' % (int(time.time()) % 100000000))

WAIT_TTL_SEC = int(os.environ.get('P0_WAIT_TTL_SEC', '45'))
STEP_LIMIT = int(os.environ.get('P0_STEP_LIMIT', '6'))

TOOL_TS = os.path.join(REPO, 'apps', 'server', 'src', 'toolLoop.ts')
TTL_LINE = 'const WAITING_TTL_MS = 6 * 60 * 60 * 1000;'


def build_server():
    p = subprocess.run(['npm', 'run', 'build', '-w', '@ai-workbench/server'],
                       cwd=REPO, capture_output=True, text=True,
                       encoding='utf-8', errors='replace', shell=True)
    return p.returncode == 0, (p.stdout or '') + (p.stderr or '')


def set_ttl(sec):
    src = open(TOOL_TS, 'r', encoding='utf-8').read()
    if TTL_LINE not in src:
        raise SystemExit('FAIL 找不到 TTL 常量行（源码指纹不符）')
    open(TOOL_TS, 'w', encoding='utf-8').write(
        src.replace(TTL_LINE, 'const WAITING_TTL_MS = %d * 1000;' % sec, 1))
    ok, log = build_server()
    if not ok:
        raise SystemExit('FAIL 构建失败：\n' + log[-1500:])
    after = open(TOOL_TS, 'r', encoding='utf-8').read()
    print('  · TTL 已改为 %d 秒，复查：%s'
          % (sec, [l.strip() for l in after.splitlines() if 'WAITING_TTL_MS =' in l]))


def restore_ttl():
    src = open(TOOL_TS, 'r', encoding='utf-8').read()
    src2 = re.sub(r'const WAITING_TTL_MS = \d+ \* 1000;', TTL_LINE, src, count=1)
    open(TOOL_TS, 'w', encoding='utf-8').write(src2)
    build_server()
    after = open(TOOL_TS, 'r', encoding='utf-8').read()
    ok = TTL_LINE in after and not re.search(r'const WAITING_TTL_MS = \d+ \* 1000;', after)
    print('\n[收尾] TTL 已恢复为 6 小时（grep 复查 %s）' % ('通过' if ok else '★失败★'))
    return ok


def plan_keys():
    """假模型里所有剧本的关键词（命中了就会走出 type/click 序列）。"""
    src = open(os.path.join(VERIFY, 'fake-llm.mjs'), 'r', encoding='utf-8').read()
    return re.findall('^[ ]*key:[ ]*\'([^\']+)\'', src, flags=re.M)


def check_no_plan_match():
    """★ 禁止不可逆动作 · 第一道闸（前置，最硬的一道）。

    在**真实网站**上跑验收时，绝不能让模型走出「填验证码 → 点提交 → 去下单」这类招。
    假模型只有命中剧本才会出那些招，而命中条件是 `goal.includes(key)` ——
    所以只要保证目标里不含任何关键词，模型就只会出 `read_page` / `stop`。
    把这件事写成断言，而不是"我心里有数"，下个人换目标时才会被拦住。
    """
    keys = plan_keys()
    hits = [k for k in keys if any(k in g for g in (GOAL_S1, GOAL_S1B, GOAL_S2, GOAL_S3))]
    return check('前置闸：本轮目标不命中任何假模型剧本（模型只会出 read_page，不会出 type/click/提交）',
                 not hits and bool(keys),
                 '剧本关键词=%s，命中=%s' % (keys, hits or '无'))


def fake_log():
    try:
        return open(os.path.join(PR.OUTDIR, 'fake.log'), 'r',
                    encoding='utf-8', errors='replace').read()
    except Exception:
        return ''


# ★ 判据选「模型实际出了什么招」，而不是「页面域名变没变」：
#   实测（2026-09-21）页面在**暂停期间**被应用自己导航到了另一个地址，
#   那时 AI 已经停手了 —— 拿域名当判据会把"应用自己的行为"误判成"AI 干了不可逆的事"。
#   唯一真相是假模型日志里每条 `"kind":"xxx"`。
ALLOWED_KINDS = {'read_page', 'stop'}


def check_no_irreversible(tag, since_len):
    """★ 禁止不可逆动作 · 第二道闸（运行时，收尾时扫全部出招）。"""
    kinds = set(re.findall(r'"kind":"([a-z_]+)"', fake_log()[since_len:]))
    bad = sorted(kinds - ALLOWED_KINDS)
    ok = check('%s 期间模型只出了只读招（read_page/stop），没有 click/type/提交类动作' % tag,
               not bad, '出招=%s%s' % (sorted(kinds) or '无',
                                       ('，★越界=%s' % bad) if bad else ''))
    # 页面地址只作**记录**：它会被应用自己的导航影响，不能当判据
    try:
        href = str(guest_js(PAGE_HOST, 'location.href') or '')
    except Exception as e:
        href = '(读不到：%s)' % e
    print('  · %s 收尾时页面地址（只记录，不作判据）：%s' % (tag, href))
    return ok


def loopgone_text():
    return ev('(() => { const e = document.querySelector(".loopGone__q");'
              ' return e ? (e.textContent || "").trim() : null; })()')


def full_click(sel):
    """★ 点 React 合成事件的按钮必须用**完整鼠标序列**。

    `element.click()`（JS）对 React 合成事件会静默不生效且时好时坏；
    CDP 只发 pressed/released 也缺 hover 前的 mouseMoved。这里三连补齐。
    """
    c = P.Cdp()
    try:
        r = c.js('(() => { const e = document.querySelector(%s); if (!e) return null;'
                 ' e.scrollIntoView({block:"center"}); const b = e.getBoundingClientRect();'
                 ' return {x: b.x + b.width/2, y: b.y + b.height/2}; })()' % json.dumps(sel))
        if not r:
            return False
        x, y = r['x'], r['y']
        c.send('Input.dispatchMouseEvent', type='mouseMoved', x=x, y=y, button='none', buttons=1)
        c.send('Input.dispatchMouseEvent', type='mousePressed', x=x, y=y,
               button='left', clickCount=1, buttons=1)
        c.send('Input.dispatchMouseEvent', type='mouseReleased', x=x, y=y,
               button='left', clickCount=1, buttons=0)
        return True
    finally:
        try:
            c.ws.close()
        except Exception:
            pass


def shot(name):
    """截图 = **证据留存**，不是断言。

    CDP 的 captureScreenshot 在窗口忙碌/被遮挡时会超时（实测 30 秒不回）。
    那种超时只说明"这张图没存下来"，**不说明产品行为不对** ——
    所以失败只提示、不记 FAIL，别让取证手段把结论带偏
    （本脚本第一版就是让截图把 S2 整段拖成 FAIL，其实三条实质断言全过）。
    """
    path = os.path.join(PR.OUTDIR, name)
    try:
        c = P.Cdp()
        try:
            c.shot(path)
        finally:
            try:
                c.ws.close()
            except Exception:
                pass
        return path
    except Exception as e:
        print('  · 截图没存下来（不影响断言）：%s' % e)
        return None


def electron_log():
    """桌面端主进程日志。

    ★ 「这次到底是 loop_gone，还是网络抖动被笼统 catch 了」的**唯一真相**在这里：
    服务端只在**响应体**里带 `code`，它自己的日志不打印；桌面端那句 warn 才点名了分支。
    判这条必须读桌面端日志 —— 读服务端日志等于没验。
    """
    try:
        return open(os.path.join(PR.OUTDIR, 'electron.log'), 'r',
                    encoding='utf-8', errors='replace').read()
    except Exception:
        return ''


# ────────────────────────────────────────────────────────────── 主流程
def main():
    os.makedirs(PR.OUTDIR, exist_ok=True)
    shutil.rmtree(PR.TMP, ignore_errors=True)
    os.makedirs(PR.PROFILE, exist_ok=True)

    VITE_BIN = PR.first_existing(
        os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
        os.path.join(DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'))
    ELECTRON_EXE = PR.first_existing(
        os.path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'),
        os.path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe'))
    START_JS = os.path.join(DESKTOP, 'scripts', 'start-electron.mjs')

    section('0. 环境自检 + 临时把 TTL 调小（跑完一定改回来）')
    for label, path in [('vite 入口', VITE_BIN), ('electron 二进制', ELECTRON_EXE),
                        ('start-electron.mjs', START_JS)]:
        expect(bool(path), '构建产物存在：%s' % label, str(path))
    for port in (PR.API_PORT, PR.FAKE_PORT, PR.FAKE2_PORT, PR.FAKE3_PORT, PR.VITE_PORT, PR.CDP_PORT):
        expect(not port_busy(port), '端口 %d 空闲' % port)
    set_ttl(WAIT_TTL_SEC)

    try:
        section('1. 起环境（假模型 + 验收后端 + vite + 真 Electron）')
        spawn('fake', [PR.NODE, os.path.join(VERIFY, 'fake-llm.mjs')], REPO,
              env={'FAKE_PORT': str(PR.FAKE_PORT), 'FAKE_DELAY_MS': '1500',
                   'FAKE_STEPS': '30', 'FAKE_LOG': PR.FAKE_LOG,
                   'FAKE_DUMP': '1',
                   'SITE_LOG': os.path.join(PR.OUTDIR, 'site.jsonl')},
              log=os.path.join(PR.OUTDIR, 'fake.log'))
        expect(wait_health(PR.FAKE).get('ok') is True, '假模型起来了')

        spawn('server', [PR.NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
              env={'PORT': str(PR.API_PORT), 'DEEPSEEK_BASE_URL': PR.FAKE,
                   'DEEPSEEK_API_KEY': 'fake-key-p0-verify', 'DEEPSEEK_MODEL': 'fake-p0',
                   'AGENT_LOOP_MAX_STEPS': str(STEP_LIMIT)},
              log=PR.SERVER_LOG)
        # ★ 端口通 ≠ 数据库可查：PG 恢复期端口先监听、真正能查要几十秒。
        #   只探一次会撞上"假就绪"（反证那次就是这么挂的：db=down，整套环境白起）。
        #   所以连续两次 db=up、中间隔 3 秒才算就绪。
        hs = {}
        for _round in range(30):
            hs = wait_health(PR.API, timeout=10)
            if hs.get('db') == 'up':
                time.sleep(3)
                if wait_health(PR.API, timeout=10).get('db') == 'up':
                    break
            time.sleep(2)
        expect(hs.get('db') == 'up', '验收后端起来了（db=up，连续两次确认）',
               json.dumps(hs, ensure_ascii=False)[:200])

        spawn('vite', [PR.NODE, VITE_BIN, '--port', str(PR.VITE_PORT), '--strictPort'], DESKTOP,
              log=os.path.join(PR.OUTDIR, 'vite.log'))
        time.sleep(4)
        spawn('electron', [PR.NODE, 'scripts/start-electron.mjs',
                           '--user-data-dir=%s' % PR.PROFILE,
                           '--remote-debugging-port=%d' % PR.CDP_PORT], DESKTOP,
              env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % PR.VITE_PORT},
              log=os.path.join(PR.OUTDIR, 'electron.log'))
        ok, _, ms = wait_until(lambda: bool(P.page('localhost:%d' % PR.VITE_PORT)), timeout=90)
        expect(ok, '真 Electron 窗口出现（CDP 连上渲染进程）', '耗时 %dms' % ms)

        section('2. 建号登录（走真实短信登录链路）')
        st, _r = http_json('/auth/sms/send', 'POST', body={'phone': TEST_PHONE})
        expect(st == 200, '发送验证码', 'HTTP %d' % st)
        code = None
        for _ in range(40):
            for m in re.finditer(r'(\d{6})', server_log()):
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
        agent_id = int(agents[0]['id']) if agents else None
        expect(agent_id is not None, '取到一个智能体', 'agentId=%s' % agent_id)

        c = P.Cdp()
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
        time.sleep(6)
        ok, _, ms = wait_until(
            lambda: ('退出登录' in (ev('(document.body.innerText||"")') or ''))
            and (ev('Boolean(window.workbench && window.workbench.agentStart)') is True),
            timeout=60)
        expect(ok, '登录后进到工作台（登录态锚点 + 驾驶桥就绪）', '耗时 %dms' % ms)

        section('3. 打开**真实公开只读站**（%s）' % REAL_PAGE)
        check_no_plan_match()
        ev('window.workbench.openBrowser(%s); "ok"' % json.dumps(REAL_PAGE))
        ok, _, ms = wait_until(lambda: len([w for w in webviews() if isinstance(w.get('wcId'), int)]) >= 1,
                               timeout=90)
        wvs = [w for w in webviews() if isinstance(w.get('wcId'), int)]
        expect(ok, '内嵌页建起来了', json.dumps([w.get('wcId') for w in wvs]))
        wcA = [w['wcId'] for w in wvs][0]

        def start_task(goal):
            ev('window.workbench.agentStart(%s, %s, %s, %d, {agentId: %d}); "ok"'
               % (json.dumps(goal), json.dumps(PR.API), json.dumps(token), wcA, agent_id))
            time.sleep(1.2)

        def wait_driving(goal, min_calls=2, timeout=90):
            ok1, _, _m = wait_until(lambda: len(llm_calls(goal)) >= min_calls, timeout=timeout)
            ok2, _, _m2 = wait_until(lambda: (task_state(wcA) or {}).get('phase') == 'running', timeout=60)
            return ok1 and ok2

        # ★ 每个场景单独装进函数、各自兜住异常：一次真机要十几分钟，
        #   一个断言写错不该把后面几个场景一起赔进去。
        #   （本脚本第一版就因为在 S3 里把 wait_until 的布尔返回值当成状态字典用，
        #    整轮跑到 S3 就结束了，核心的 S1 根本没验到。）
        def guard(label, fn):
            try:
                fn()
            except ScenarioAbort as e:
                print('  · 场景 %s 提前中止（前置没过：%s），后面的场景照跑' % (label, e))
            except Exception as e:
                import traceback
                check('%s 场景脚本自身异常（这条要当失败看，不是环境问题）' % label,
                      False, '%s: %s' % (type(e).__name__, e))
                traceback.print_exc()

        def fn_s2():
            mark_f2 = len(fake_log())
            # ══════════════════════════════════════════════════════ S2
            section('S2 正常暂停 → 立刻点继续（必须和现在完全一致，不能弄坏已验证的路径）')
            start_task(GOAL_S2)
            need(wait_driving(GOAL_S2), 'S2 前置：这路正在驾驶')
            ev('window.workbench.pauseTask(%d); "ok"' % wcA)
            ok, _, ms = wait_until(lambda: (task_state(wcA) or {}).get('phase') == 'paused', timeout=30)
            need(ok, 'S2 已暂停（phase=paused）', '耗时 %dms' % ms)
            calls_s2 = len(llm_calls(GOAL_S2))
            ev('window.workbench.resumeTask(%d); "ok"' % wcA)
            ok, _, ms = wait_until(lambda: len(llm_calls(GOAL_S2)) > calls_s2, timeout=60)
            check('S2-a 继续后 AI 正常接着做（模型被再次提问）', ok,
                  '提问 %d → %d 次 / 耗时 %dms' % (calls_s2, len(llm_calls(GOAL_S2)), ms))
            check('S2-b 没有误弹「上下文没了」确认条', loopgone_text() is None,
                  'loopGone=%r' % loopgone_text())
            check('S2-c 服务端打出了 delta 判定（走的是恢复，不是新开）',
                  'delta=' in server_log()[-4000:], '服务端日志尾部见 delta=')
            shot('s2-resumed.png')
            # 收尾这一路，别影响后面的场景
            ev('window.workbench.agentDrop(%d); "ok"' % wcA)
            time.sleep(2)
            check_no_irreversible('S2', mark_f2)

        def fn_s3():
            mark_f3 = len(fake_log())
            # ══════════════════════════════════════════════════════ S3
            section('S3 步数打断 → 说"继续"（AGENT_LOOP_MAX_STEPS=%d 复现旧的步数打断）' % STEP_LIMIT)
            start_task(GOAL_S3)
            need(wait_driving(GOAL_S3), 'S3 前置：这路正在驾驶')
            # 跑到步数上限：phase 离开 running（= AI 停下来等用户说"继续"）
            ok, _, ms = wait_until(lambda: (task_state(wcA) or {}).get('phase') != 'running', timeout=120)
            check('S3 前置：跑满 %d 步后 AI 停下来等用户' % STEP_LIMIT, ok,
                  'phase=%s / 耗时 %dms' % ((task_state(wcA) or {}).get('phase'), ms))
            calls_s3 = len(llm_calls(GOAL_S3))
            ev('window.workbench.resumeTask(%d); "ok"' % wcA)
            ok, _, ms = wait_until(lambda: len(llm_calls(GOAL_S3)) > calls_s3, timeout=60)
            check('S3-a 说"继续"后 AI 正常接着做', ok,
                  '提问 %d → %d 次 / 耗时 %dms' % (calls_s3, len(llm_calls(GOAL_S3)), ms))
            check('S3-b 没有误弹「上下文没了」确认条', loopgone_text() is None,
                  'loopGone=%r' % loopgone_text())
            ev('window.workbench.agentDrop(%d); "ok"' % wcA)
            time.sleep(2)
            check_no_irreversible('S3', mark_f3)

        def fn_s1():
            mark_f1 = len(fake_log())
            # ══════════════════════════════════════════════════════ S1
            section('S1 暂停 → 等超过 TTL（本次 TTL=%ds）→ 点继续' % WAIT_TTL_SEC)
            start_task(GOAL_S1)
            need(wait_driving(GOAL_S1), 'S1 前置：这路正在驾驶')
            ev('window.workbench.pauseTask(%d); "ok"' % wcA)
            ok, _, ms = wait_until(lambda: (task_state(wcA) or {}).get('phase') == 'paused', timeout=30)
            need(ok, 'S1 已暂停（phase=paused）')
            calls_s1 = len(llm_calls(GOAL_S1))
            mark = len(server_log())
            mark_e = len(electron_log())
            print('  现在等 %d 秒，让这一路超过 TTL…' % (WAIT_TTL_SEC + 20))
            time.sleep(WAIT_TTL_SEC + 20)

            ev('window.workbench.resumeTask(%d); "ok"' % wcA)
            ok, txt, ms = wait_until(loopgone_text, timeout=40)
            check('S1-a 点继续后出现**明确提示**（不是静默重开）', ok, '耗时 %dms' % ms)
            check('S1-a2 提示文案就是简报指定的那句',
                  bool(txt) and '这一轮的上下文已经不在了' in txt and '要重新开始吗' in txt,
                  '文案=%r' % (txt or ''))
            shot('s1-loop-gone.png')

            time.sleep(12)
            calls_after = len(llm_calls(GOAL_S1))
            check('S1-b 点继续后**没有**自动重跑（模型一次都没被问）',
                  calls_after == calls_s1, '提问 %d → %d 次' % (calls_s1, calls_after))
            check('S1-c 状态机没有偷偷回到 running',
                  (task_state(wcA) or {}).get('phase') != 'running',
                  'phase=%s' % (task_state(wcA) or {}).get('phase'))
            # ★ 判据选**桌面端**日志：要证明的是"这次走的是 loop_gone 分支"，
            #   不是"某个错误被笼统 catch 了"。服务端只在响应体里带 code、日志不打印，
            #   读服务端日志等于没验（本脚本第一版就栽在这里，白白挂了一条 FAIL）。
            elog = electron_log()[mark_e:]
            check('S1-d 桌面端日志点明是"上下文已不在"（证明走的是 loop_gone 分支，不是笼统 catch）',
                  'loop_gone' in elog,
                  '桌面端日志尾部：' + (elog[-300:].strip() or '(空)'))

            # 用户确认「重新开始」
            clicked = full_click('.loopGone__warn')
            check('S1-e 「重新开始」按钮点得到（完整鼠标序列）', clicked)
            ok, _, ms = wait_until(lambda: len(llm_calls(GOAL_S1)) > calls_after, timeout=90)
            check('S1-f 用户确认之后才真的新建一轮', ok,
                  '提问 %d → %d 次 / 耗时 %dms' % (calls_after, len(llm_calls(GOAL_S1)), ms))
            try:
                dumps = PR.req_dumps(GOAL_S1)
                newest = (dumps[-1].get('msg') or '') if dumps else ''
                check('S1-g 新建的是**新的一轮**（提示词里没有"你刚刚被用户暂停，现在已恢复"）',
                      bool(dumps) and '你刚刚被用户暂停，现在已恢复' not in newest,
                      '最新提示词片段：%s' % (newest[:120].replace('\n', ' / ') or '(没拿到 dump)'))
            except Exception as e:
                print('  · S1-g 跳过（拿不到提示词 dump：%s）' % e)
            check('S1-h 确认条在用户点完之后消失', loopgone_text() is None)
            ev('window.workbench.agentDrop(%d); "ok"' % wcA)
            time.sleep(2)
            check_no_irreversible('S1', mark_f1)

        def fn_s1b():
            mark_f1b = len(fake_log())
            # ══════════════════════════════════════════════════════ S1b
            section('S1b 同样的"上下文已不在"，这次点「算了」（必须收干净，不留半死不活）')
            start_task(GOAL_S1B)
            need(wait_driving(GOAL_S1B), 'S1b 前置：这路正在驾驶')
            ev('window.workbench.pauseTask(%d); "ok"' % wcA)
            ok, _, ms = wait_until(lambda: (task_state(wcA) or {}).get('phase') == 'paused', timeout=30)
            need(ok, 'S1b 已暂停（phase=paused）')
            calls_s1b = len(llm_calls(GOAL_S1B))
            print('  现在等 %d 秒，让这一路超过 TTL…' % (WAIT_TTL_SEC + 20))
            time.sleep(WAIT_TTL_SEC + 20)
            ev('window.workbench.resumeTask(%d); "ok"' % wcA)
            ok, txt, ms = wait_until(loopgone_text, timeout=40)
            need(ok, 'S1b 前置：确认条出现（loop_gone）')
            shot('s1b-loop-gone.png')

            clicked = full_click('.loopGone__giveup')
            check('S1b-a 「算了」按钮点得到', clicked)
            ok, _, ms = wait_until(lambda: loopgone_text() is None, timeout=20)
            check('S1b-b 点完「算了」确认条消失', ok, '耗时 %dms' % ms)
            st_after = task_state(wcA) or {}
            check('S1b-c 界面回到"已停止"（phase 不是 running/paused）',
                  st_after.get('phase') not in ('running', 'paused'),
                  'phase=%s / %s' % (st_after.get('phase'), json.dumps(st_after, ensure_ascii=False)[:200]))
            time.sleep(12)
            check('S1b-d 收尾之后不再有任何模型调用（lane 真的清掉了）',
                  len(llm_calls(GOAL_S1B)) == calls_s1b,
                  '提问 %d → %d 次' % (calls_s1b, len(llm_calls(GOAL_S1B))))
            shot('s1b-giveup.png')
            check_no_irreversible('S1b', mark_f1b)

        guard('S2', fn_s2)
        guard('S3', fn_s3)
        guard('S1', fn_s1)
        guard('S1b', fn_s1b)

    finally:
        ttl_ok = restore_ttl()
        if not ttl_ok:
            PR.FAILS.append('★ TTL 没恢复成 6 小时，必须手工检查 apps/server/src/toolLoop.ts')
        finish()


if __name__ == '__main__':
    main()
