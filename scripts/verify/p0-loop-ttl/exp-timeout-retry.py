"""阶段2 两个实验（**只验证，不改产品代码**）

## 为什么要做这两个实验
阶段1 修的是"循环没了不许静默重开"。但重复执行还有**另一半**：

    工具报「没完成」≠ 动作没发生。

用户 2026-09-21 明确要求量这半边的现状：
  实验A 造"点击后 30 秒才响应"的页面 → 观察 20 秒超时后，那次点击**是否真生效**
  实验B 让 AI 在"点了页面毫无变化"的页面连点 → 统计是否真按话术「我再试一次」重试、
        重复几次、有没有触发提问

★ 这两个页面是**故意造的**，和阶段1 真机验收用的真实站（example.com）是两回事：
  真机验收要真实地形；这两个实验要的是**把时序钉死成常量**——
  "点了要等 30 秒"和"点了永远没反应"在真实网站上没法按需复现。

## 产品侧的关键常量（先记下来，读数才有意义）
  apps/desktop/electron/agent.ts
    EXEC_TIMEOUT_MS  = 20_000   ← 任何一次工具执行超过它就报「这一步 20 秒没有完成」
    FAILS_BEFORE_ASK = 2        ← 连败 2 次 / staleClicks==2 → 出「我再试一次」提示
    STALE_BEFORE_ASK = 3        ← staleClicks>=3 → 出 ask + phase('paused') 停手

## 判据怎么选（踩过的坑：判据必须选"唯一真相"）
  · "点击到底发生没有" —— 不看 AI 说了什么，看**页面上报给服务端的计数**（GET /__clicks）。
  · "结果到底出来没有" —— 看**内嵌页自己的标题**（"已受理"），不看 AI 的汇报。
  · "有没有提问" —— 看 **task_state().phase**（产品确实会 phase('paused')），不看文案。

## 用法（★ 必须同一次调用：先起 PG 再跑本脚本）
    python scripts/verify/help-card/_start-pg.py && \
    python scripts/verify/p0-loop-ttl/exp-timeout-retry.py

  轮数：EXP_ROUNDS=3（默认）；慢响应延迟：SLOW_MS=30000（默认）
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
VERIFY = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(VERIFY))
DESKTOP = os.path.join(REPO, 'apps', 'desktop')

os.environ.setdefault('API_PORT', '8795')
os.environ.setdefault('FAKE_PORT', '8895')
os.environ.setdefault('FAKE2_PORT', '8896')
os.environ.setdefault('FAKE3_PORT', '8897')
os.environ.setdefault('VITE_PORT', '5182')
os.environ.setdefault('CDP_PORT', '9345')

import importlib.util

_spec = importlib.util.spec_from_file_location('pr', os.path.join(VERIFY, 'pause-resume-tests.py'))
PR = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(PR)

PR.OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'p0-loop-ttl')
PR.TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wbexp')
PR.PROFILE = os.path.join(PR.TMP, 'profile')
PR.FAKE_LOG = os.path.join(PR.OUTDIR, 'exp-llm.jsonl')
PR.SERVER_LOG = os.path.join(PR.OUTDIR, 'exp-server-%d.log' % PR.API_PORT)

section, check, expect = PR.section, PR.check, PR.expect
ev, guest_js, webviews, task_state, wait_until = (
    PR.ev, PR.guest_js, PR.webviews, PR.task_state, PR.wait_until,
)
spawn, http_json, wait_health, server_log, port_busy, finish = (
    PR.spawn, PR.http_json, PR.wait_health, PR.server_log, PR.port_busy, PR.finish,
)
P = PR.P

ROUNDS = int(os.environ.get('EXP_ROUNDS', '3'))
SLOW_MS = int(os.environ.get('SLOW_MS', '30000'))
PAGE_SLOW = '%s/slowclick' % PR.FAKE
PAGE_NOCHANGE = '%s/nochange' % PR.FAKE
# ★ 目标里必须含剧本关键词，假模型才会走出 click（关键词见 fake-llm.mjs 的 PLANS）
# ★★ 每一轮的 goal 必须**不一样**：假模型用 `LASTSTEP`（按 goal 记忆）记着已经走到第几步，
#    同一个 goal 跑第二轮时剧本已经走完，模型就只会 read_page —— 第一轮有点击、后面全是 0。
#    （第一次跑就栽在这：A 的第 2/3 轮点击数都是 0，白白浪费两轮。）
GOAL_A = lambda rnd: 'EXPA%d 慢响应：把这张申请单提交上去' % rnd
GOAL_B1 = lambda rnd: 'EXPB1-%d 没反应：把控制台的数据刷新出来' % rnd
GOAL_B2 = lambda rnd: 'EXPB2-%d 连点无缝：把控制台的数据刷新出来' % rnd

TIMEOUT_TEXT = '20 秒没有完成'
RETRY_TEXT = '我再试一次'

RESULTS = []


def db_steps_for(goal_prefix, limit=2):
    """按目标前缀直读库里的**步骤摘要**（产品自己写的那本原始账）。

    为什么不用界面文字当判据：界面是渲染结果，可能被折叠/截断；
    而 `tasks.payload.steps` 是 `POST /agent/task/step` append 进去的
    `${summary}${ok===false ? '（失败）' : ''}` —— 工具有没有报超时、
    这一步到底被记成成功还是失败，这里才是唯一真相。
    """
    sql = ("SELECT id, payload->'steps' AS steps FROM tasks "
           "WHERE payload->>'goal' LIKE $1 ORDER BY id DESC LIMIT %d" % limit)
    try:
        p = subprocess.run(
            [PR.NODE, os.path.join(VERIFY, 'dbq.mjs'), sql,
             json.dumps(['%s%%' % goal_prefix])],
            cwd=REPO, capture_output=True, text=True, encoding='utf-8', errors='replace',
        )
        return (p.stdout or '') + (p.stderr or '')
    except Exception as e:
        return '(读库失败：%s)' % e


def failed_step_lines(txt, limit=4):
    """把库里那些被记成「（失败）」的步骤原样抠出来（报告要引用原文）。"""
    out = []
    for m in re.finditer(r'"([^"]*（失败）[^"]*)"', txt):
        out.append(m.group(1))
        if len(out) >= limit:
            break
    return out


def clicks():
    """页面上报给服务端的点击计数 —— 「这一下到底点没点上」的唯一真相。"""
    try:
        with urllib.request.urlopen('%s/__clicks' % PR.FAKE, timeout=5) as r:
            return json.loads(r.read().decode('utf-8')).get('clicks') or {}
    except Exception:
        return {}


def chat_text():
    return ev('(document.body.innerText||"")') or ''


def seen_anywhere(s):
    """在聊天区 / 服务端日志 / 桌面端日志里找一句话。"""
    try:
        pool = chat_text() + '\n' + (server_log() or '')
    except Exception:
        pool = chat_text()
    try:
        pool += '\n' + electron_log()
    except Exception:
        pass
    return s in pool


def electron_log():
    p = os.path.join(PR.OUTDIR, 'exp-electron.log')
    try:
        return open(p, 'r', encoding='utf-8', errors='replace').read()
    except Exception:
        return ''


def guest_title(host):
    v = guest_js(host, 'document.title') if host else None
    return v if isinstance(v, str) else '(读不到)'


def drop(wc):
    try:
        ev('window.workbench.agentDrop(%d); "ok"' % wc)
    except Exception:
        pass
    time.sleep(1.0)


def row(exp, rnd, **kw):
    kw.update(exp=exp, rnd=rnd)
    RESULTS.append(kw)
    return kw


# ---------------------------------------------------------------- 实验 A
def exp_a(wc, agent_id, token, rnd):
    section('实验A · 第 %d 轮：点了要等 %d 秒才有结果的按钮' % (rnd, SLOW_MS // 1000))
    goal = GOAL_A(rnd)
    base = clicks().get('slowclick', 0)
    ev('window.workbench.openBrowser(%s); "ok"' % json.dumps(PAGE_SLOW))
    ok, _, _ = wait_until(lambda: '申请单' in guest_title('127.0.0.1'), timeout=60, interval=1.0)
    if not ok:
        print('  · 页面还没到申请单，再等一等（标题=%s）' % guest_title('127.0.0.1'))

    t0 = time.time()
    ev('window.workbench.agentStart(%s, %s, %s, %d, {agentId: %d}); "ok"'
       % (json.dumps(goal), json.dumps(PR.API), json.dumps(token), wc, agent_id))

    # ① 等那次点击真的发生（页面上报）
    ok_click, _, ms_click = wait_until(
        lambda: clicks().get('slowclick', 0) > base, timeout=90, interval=1.0)
    print('  · 点击已上报：%s（%dms）' % (ok_click, ms_click))

    # ② 等工具报超时（20 秒），给它 40 秒窗口
    ok_to, _, ms_to = wait_until(lambda: seen_anywhere(TIMEOUT_TEXT), timeout=50, interval=1.0)
    print('  · 出现「%s」：%s（%dms）' % (TIMEOUT_TEXT, ok_to, ms_to))

    # ③ 结果页到底出来没有（30 秒延迟之后）—— 这是"动作生效了没"的唯一真相
    ok_done, _, ms_done = wait_until(
        lambda: '已受理' in guest_title('127.0.0.1'), timeout=60, interval=1.0)
    print('  · 结果页（已受理）出现：%s（%dms）' % (ok_done, ms_done))

    # ④ 之后 AI 有没有再点第二次（重复执行？）
    time.sleep(8)
    n_after = clicks().get('slowclick', 0) - base
    print('  · 这一轮页面侧共收到 %d 次点击' % n_after)

    # ⑤ 从库里直读产品自己记的那本账：这一步到底记成"失败"了吗、失败原因原话是什么
    steps_txt = db_steps_for(goal)
    db_timeout = TIMEOUT_TEXT in steps_txt
    bad = failed_step_lines(steps_txt)
    db_failed = bool(bad)
    print('  · 库里的步骤摘要含「%s」= %s；被记成「（失败）」的步骤 %d 条'
          % (TIMEOUT_TEXT, db_timeout, len(bad)))
    for line in bad:
        print('     └ %s' % line[:300])

    drop(wc)
    row('A', rnd,
        点击已上报=ok_click, 工具报20秒超时=ok_to,
        库里记到超时=db_timeout, 库里记成失败=db_failed,
        结果页真的出来了=ok_done, 页面侧点击次数=n_after,
        总耗时秒=round(time.time() - t0, 1))
    return {'click': ok_click, 'timeout': ok_to or db_timeout, 'failed': db_failed,
            'done': ok_done, 'n': n_after}


# ---------------------------------------------------------------- 实验 B
def exp_b(wc, agent_id, token, rnd, variant='B1'):
    """variant='B1' 两次点击之间夹 read_page（像真模型那样点一下看一眼）；
       variant='B2' 连续 click、中间不夹任何动作（真·连点）。"""
    section('实验B%s · 第 %d 轮：点了永远没变化的按钮（%s）'
            % (variant, rnd, '夹 read_page' if variant == 'B1' else '连续点，中间不夹'))
    goal = (GOAL_B1 if variant == 'B1' else GOAL_B2)(rnd)
    base = clicks().get('nochange', 0)
    ev('window.workbench.openBrowser(%s); "ok"' % json.dumps(PAGE_NOCHANGE))
    wait_until(lambda: '控制台' in guest_title('127.0.0.1'), timeout=60, interval=1.0)

    t0 = time.time()
    ev('window.workbench.agentStart(%s, %s, %s, %d, {agentId: %d}); "ok"'
       % (json.dumps(goal), json.dumps(PR.API), json.dumps(token), wc, agent_id))

    # 一路盯到它停手（phase=paused = 触发了提问）
    paused_at = None
    retry_seen = False
    deadline = time.time() + 150
    while time.time() < deadline:
        st = task_state(wc) or {}
        if st.get('phase') == 'paused':
            paused_at = clicks().get('nochange', 0) - base
            break
        if not retry_seen and RETRY_TEXT in chat_text():
            retry_seen = True
        time.sleep(1.0)
    if paused_at is None:
        paused_at = clicks().get('nochange', 0) - base

    n = clicks().get('nochange', 0) - base
    txt = chat_text()
    if not retry_seen:
        retry_seen = RETRY_TEXT in txt
    # 提问文案（产品侧：`连着 ${STALE_BEFORE_ASK} 次点了页面都没动静`）
    asked = ('都没动静' in txt) or ('我不再盲点了' in txt)
    print('  · 点击次数 = %d；出现「%s」= %s；停手（phase=paused）= %s'
          % (n, RETRY_TEXT, retry_seen, paused_at is not None and paused_at > 0 or '未停手'))
    print('  · 停手时已点次数 = %s' % paused_at)

    drop(wc)
    row('B%s' % variant, rnd,
        点击次数=n, 出现我再试一次=retry_seen, 提问文案出现=asked,
        触发提问=(paused_at if paused_at else None),
        停手时已点次数=paused_at,
        总耗时秒=round(time.time() - t0, 1))
    return {'n': n, 'retry': retry_seen, 'asked': asked, 'paused_at': paused_at}


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

    section('0. 环境自检')
    for label, path in [('vite 入口', VITE_BIN), ('electron 二进制', ELECTRON_EXE),
                        ('start-electron.mjs', START_JS)]:
        expect(bool(path), '构建产物存在：%s' % label, str(path))
    for port in (PR.API_PORT, PR.FAKE_PORT, PR.FAKE2_PORT, PR.FAKE3_PORT, PR.VITE_PORT, PR.CDP_PORT):
        expect(not port_busy(port), '端口 %d 空闲' % port)

    try:
        section('1. 起环境')
        spawn('fake', [PR.NODE, os.path.join(VERIFY, 'fake-llm.mjs')], REPO,
              env={'FAKE_PORT': str(PR.FAKE_PORT), 'FAKE_DELAY_MS': '800',
                   'FAKE_STEPS': '40', 'FAKE_LOG': PR.FAKE_LOG, 'FAKE_DUMP': '1',
                   'SLOW_MS': str(SLOW_MS),
                   'SITE_LOG': os.path.join(PR.OUTDIR, 'exp-site.jsonl')},
              log=os.path.join(PR.OUTDIR, 'exp-fake.log'))
        expect(wait_health(PR.FAKE).get('ok') is True, '假模型起来了')

        spawn('server', [PR.NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
              env={'PORT': str(PR.API_PORT), 'DEEPSEEK_BASE_URL': PR.FAKE,
                   'DEEPSEEK_API_KEY': 'fake-key-exp', 'DEEPSEEK_MODEL': 'fake-exp',
                   'AGENT_LOOP_MAX_STEPS': '0'},
              log=PR.SERVER_LOG)
        hs = {}
        for _ in range(30):
            hs = wait_health(PR.API, timeout=10)
            if hs.get('db') == 'up':
                time.sleep(3)
                if wait_health(PR.API, timeout=10).get('db') == 'up':
                    break
            time.sleep(2)
        expect(hs.get('db') == 'up', '验收后端起来了（db=up，连续两次确认）',
               json.dumps(hs, ensure_ascii=False)[:160])

        spawn('vite', [PR.NODE, VITE_BIN, '--port', str(PR.VITE_PORT), '--strictPort'], DESKTOP,
              log=os.path.join(PR.OUTDIR, 'exp-vite.log'))
        time.sleep(4)
        spawn('electron', [PR.NODE, 'scripts/start-electron.mjs',
                           '--user-data-dir=%s' % PR.PROFILE,
                           '--remote-debugging-port=%d' % PR.CDP_PORT], DESKTOP,
              env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % PR.VITE_PORT},
              log=os.path.join(PR.OUTDIR, 'exp-electron.log'))
        ok, _, ms = wait_until(lambda: bool(P.page('localhost:%d' % PR.VITE_PORT)), timeout=90)
        expect(ok, '真 Electron 窗口出现', '耗时 %dms' % ms)

        section('2. 建号登录')
        phone = '13900000001'
        st, _r = http_json('/auth/sms/send', 'POST', body={'phone': phone})
        expect(st == 200, '发送验证码', 'HTTP %d' % st)
        code = None
        for _ in range(40):
            for m in re.finditer(r'(\d{6})', server_log()):
                code = m.group(1)
            if code:
                break
            time.sleep(0.5)
        expect(bool(code), '从服务端日志拿到验证码')
        st, sess = http_json('/auth/login/sms', 'POST', body={'phone': phone, 'code': code})
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
            lambda: ('退出登录' in chat_text())
            and (ev('Boolean(window.workbench && window.workbench.agentStart)') is True),
            timeout=60)
        expect(ok, '登录后进到工作台', '耗时 %dms' % ms)

        # 建一个内嵌页
        ev('window.workbench.openBrowser(%s); "ok"' % json.dumps(PAGE_SLOW))
        ok, _, _ = wait_until(lambda: len([w for w in webviews()
                                           if isinstance(w.get('wcId'), int)]) >= 1, timeout=90)
        wvs = [w for w in webviews() if isinstance(w.get('wcId'), int)]
        expect(ok, '内嵌页建起来了', json.dumps([w.get('wcId') for w in wvs]))
        wc = [w['wcId'] for w in wvs][0]

        section('3. 实验A ×%d 轮' % ROUNDS)
        a_runs = [exp_a(wc, agent_id, token, i + 1) for i in range(ROUNDS)]

        section('4. 实验B1 ×%d 轮（两次点击之间夹 read_page）' % ROUNDS)
        b1_runs = [exp_b(wc, agent_id, token, i + 1, 'B1') for i in range(ROUNDS)]

        section('5. 实验B2 ×%d 轮（连续点，中间不夹任何动作）' % ROUNDS)
        b2_runs = [exp_b(wc, agent_id, token, i + 1, 'B2') for i in range(ROUNDS)]

        section('6. 数据表')
        print('实验A（点了要等 %d 秒才响应的按钮；产品侧 EXEC_TIMEOUT_MS=20s）' % (SLOW_MS // 1000))
        print('  轮次 | 点击已发生 | 报「20秒没有完成」 | 被记成失败 | 结果页真出来了 | 页面侧点击次数')
        for i, r in enumerate(a_runs, 1):
            print('   %d   |    %-5s    |        %-5s        |    %-5s    |      %-5s       |     %s'
                  % (i, r['click'], r['timeout'], r.get('failed'), r['done'], r['n']))
        print()
        print('实验B（点了毫无变化的按钮；产品侧 FAILS_BEFORE_ASK=2 / STALE_BEFORE_ASK=3）')
        print('  变体 | 轮次 | 点击次数 | 出现「我再试一次」 | 提问文案 | 停手时已点几次')
        for tag, runs in (('B1 夹read', b1_runs), ('B2 连点', b2_runs)):
            for i, r in enumerate(runs, 1):
                print('  %s |  %d   |    %-2s    |        %-5s        |   %-5s   |      %s'
                      % (tag, i, r['n'], r['retry'], r['asked'], r['paused_at']))

        out = os.path.join(PR.OUTDIR, 'exp-results.json')
        with open(out, 'w', encoding='utf-8') as f:
            json.dump({'rounds': ROUNDS, 'slowMs': SLOW_MS, 'rows': RESULTS}, f,
                      ensure_ascii=False, indent=2)
        print('\n明细已写入 %s' % out)
    finally:
        finish()

    print('\n完成。')


if __name__ == '__main__':
    main()
