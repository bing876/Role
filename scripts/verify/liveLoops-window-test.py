#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
验证 `liveLoops` 的记账口径：从「状态是 running 的循环数」改成
「**最近 N 毫秒内有推进**的 running 循环数」。

背景（浏览器多实例融合报告 §5.8）：循环只在 `advance()` 被调用时才离开 `running`，
所以「建了循环但没人驱动」的那几路会以 `running` 一直挂到 10 分钟 TTL 到期。
它们不烧模型也不吃 CPU，但**指标是歪的** —— 拿它当「现在有几路在跑」就会得出错误结论。

★ 本脚本的核心断言：

    建一个循环，**不驱动它**，等过了判据窗口：
        liveLoops    应为 0   ← 新口径：没在推进就不算活着
        runningLoops 应为 1   ← 旧口径：状态确实还是 running

    **旧代码这两个值都会是 1**，所以这条断言本身就是在证明修复真的生效了。

    然后调一次 /agent/loop/next 推进一步：
        liveLoops    应回到 1  ← 证明没把「真在跑」的循环误杀

用法：python scripts/verify/liveLoops-window-test.py
自带端口 8801/8901，不碰开发用的 8787/5173。
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SERVER_DIR = os.path.join(REPO, 'apps', 'server')
OUT = os.path.join(REPO, '.workbuddy-ai', 'liveLoops-test')
os.makedirs(OUT, exist_ok=True)

# ★ 端口别写死 8801/8901：8901 在本机会被第三方托盘进程（douyin_tray.exe）占住，
#   一撞就是 EADDRINUSE，看起来像"假模型起不来"，其实是端口被别人抢了。
API_PORT = int(os.environ.get('LL_API_PORT', '8811'))
FAKE_PORT = int(os.environ.get('LL_FAKE_PORT', '8911'))
# 判据窗口取 5 秒（配置项允许的最小值），好让验证不用等 60 秒
WINDOW_MS = 5000

API = 'http://127.0.0.1:%d' % API_PORT
FAKE = 'http://127.0.0.1:%d' % FAKE_PORT
NODE = shutil.which('node') or r'C:\Users\bing\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe'
TEST_PHONE = '186%08d' % (int(time.time()) % 100000000)

SERVER_LOG = os.path.join(OUT, 'server.log')
FAKE_LOG = os.path.join(OUT, 'fake.log')

procs = []
results = []


def log(msg):
    print(msg, flush=True)


def check(name, ok, detail=''):
    results.append((bool(ok), name, detail))
    log('%s  %s :: %s' % ('PASS' if ok else 'FAIL', name, detail))
    return bool(ok)


def spawn(label, cmd, cwd, env=None, logfile=None):
    e = dict(os.environ)
    if env:
        e.update({k: str(v) for k, v in env.items()})
    f = open(logfile, 'wb') if logfile else subprocess.DEVNULL
    p = subprocess.Popen(cmd, cwd=cwd, env=e, stdout=f, stderr=subprocess.STDOUT)
    procs.append((label, p))
    log('[spawn] %-8s pid=%d' % (label, p.pid))
    return p


def http_json(path, method='GET', token=None, body=None, base=API, timeout=30):
    data = None
    headers = {}
    if token:
        headers['authorization'] = 'Bearer ' + token
    if body is not None:
        headers['content-type'] = 'application/json'
        data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with op.open(req, timeout=timeout) as r:
            raw = r.read().decode('utf-8', 'replace')
            return r.status, (json.loads(raw) if raw[:1] in ('{', '[') else raw)
    except urllib.error.HTTPError as ex:
        raw = ex.read().decode('utf-8', 'replace')
        try:
            return ex.code, json.loads(raw)
        except Exception:  # noqa: BLE001
            return ex.code, raw
    except Exception as ex:  # noqa: BLE001
        return 0, str(ex)


def wait_health(base, timeout=60):
    t0 = time.time()
    last = {}
    while time.time() - t0 < timeout:
        st, j = http_json('/health', base=base, timeout=5)
        if st == 200 and isinstance(j, dict) and j.get('ok'):
            return j
        last = j
        time.sleep(0.5)
    return last


def server_log_text():
    try:
        with open(SERVER_LOG, 'rb') as f:
            return f.read().decode('utf-8', 'replace')
    except Exception:  # noqa: BLE001
        return ''


def find_sms_code(text):
    m = None
    for mm in re.finditer(r'\[sms:mock\].*?(\d{6})', text):
        m = mm.group(1)
    return m


def health():
    st, j = http_json('/health', timeout=5)
    return j if st == 200 and isinstance(j, dict) else {}


def main():
    log('=' * 78)
    log('验证 liveLoops 记账口径（判据窗口 %d ms）' % WINDOW_MS)
    log('=' * 78)

    # ---------------------------------------------------------------- 端口自检
    import socket

    def port_busy(p):
        s = socket.socket()
        s.settimeout(0.4)
        try:
            return s.connect_ex(('127.0.0.1', p)) == 0
        finally:
            s.close()

    busy = [p for p in (API_PORT, FAKE_PORT) if port_busy(p)]
    if busy:
        log('端口被占用：%s —— 换两个：LL_API_PORT=xxxx LL_FAKE_PORT=xxxx' % busy)
        return 2

    # ---------------------------------------------------------------- 起环境
    spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], REPO,
          env={'FAKE_PORT': FAKE_PORT, 'FAKE_DELAY_MS': '500', 'FAKE_STEPS': '9',
               'FAKE_LOG': os.path.join(OUT, 'llm.jsonl')},
          logfile=FAKE_LOG)
    j = wait_health(FAKE)
    if not check('假模型起来了', isinstance(j, dict) and bool(j.get('ok')),
                 str(j)[:150]):
        return 2

    spawn('server', [NODE, 'dist/index.js'], SERVER_DIR,
          env={'PORT': API_PORT, 'DEEPSEEK_BASE_URL': FAKE,
               'DEEPSEEK_API_KEY': 'fake-key-liveloops', 'DEEPSEEK_MODEL': 'fake-liveloops',
               'AGENT_LOOP_ACTIVE_WINDOW_MS': WINDOW_MS},
          logfile=SERVER_LOG)
    hs = wait_health(API)
    if not check('验收后端起来了（db=up）', hs.get('db') == 'up',
                 json.dumps(hs, ensure_ascii=False)[:250]):
        return 2

    check('判据窗口已被服务端采纳', hs.get('liveLoopsWindowMs') == WINDOW_MS,
          'liveLoopsWindowMs=%s' % hs.get('liveLoopsWindowMs'))

    # ---------------------------------------------------------------- 登录
    st, r = 0, {}
    for _ in range(6):
        st, r = http_json('/auth/sms/send', 'POST', body={'phone': TEST_PHONE})
        if st == 200:
            break
        time.sleep(3)
    if not check('发送验证码', st == 200, 'HTTP %d %s' % (st, json.dumps(r, ensure_ascii=False)[:150])):
        return 2

    code = None
    for _ in range(40):
        code = find_sms_code(server_log_text())
        if code:
            break
        time.sleep(0.5)
    if not check('从服务端日志拿到验证码', bool(code), 'code=%s' % code):
        return 2

    st, sess = http_json('/auth/login/sms', 'POST', body={'phone': TEST_PHONE, 'code': code})
    if not check('短信登录成功', st == 200 and sess.get('token'),
                 'HTTP %d user=%s' % (st, (sess.get('user') or {}).get('xyz_id'))):
        return 2
    token = sess['token']

    # ------------------------------------------------- 1) 建一个循环，但不驱动它
    st, lr = http_json('/agent/loop/start', 'POST', token=token,
                       body={'goal': '验证 liveLoops 记账口径用的循环（建了就不驱动）'})
    if not check('建起一个测试循环', st == 200 and lr.get('loopId'),
                 'HTTP %d %s' % (st, json.dumps(lr, ensure_ascii=False)[:200])):
        return 2
    loop_id = lr['loopId']
    log('        loopId=%s' % loop_id)

    h = health()
    check('刚建好时：两种口径都算它活着',
          h.get('liveLoops') == 1 and h.get('runningLoops') == 1,
          'liveLoops=%s runningLoops=%s' % (h.get('liveLoops'), h.get('runningLoops')))

    # --------------------------------- 2) 核心断言：不驱动，等过了窗口它要掉出 live
    log('        —— 现在**不驱动**它，等判据窗口（%d ms）过去 ——' % WINDOW_MS)
    t0 = time.time()
    dropped_at = None
    snap = {}
    while time.time() - t0 < 25:
        snap = health()
        if snap.get('liveLoops') == 0:
            dropped_at = int((time.time() - t0) * 1000)
            break
        time.sleep(0.4)

    check('★ 挂着不驱动的循环不再算「活着」（liveLoops 归零）',
          snap.get('liveLoops') == 0,
          'liveLoops=%s（%s ms 后归零）' % (snap.get('liveLoops'),
                                       dropped_at if dropped_at is not None else '超时未'))
    check('★ 但旧口径仍记着它是 running（runningLoops=1，两个值的差就是排错信号）',
          snap.get('runningLoops') == 1,
          'runningLoops=%s' % snap.get('runningLoops'))
    check('★ 归零发生在窗口附近而不是 10 分钟 TTL 后',
          dropped_at is not None and WINDOW_MS <= dropped_at <= WINDOW_MS + 8000,
          '实测 %s ms（窗口 %d ms）' % (dropped_at, WINDOW_MS))

    # --------------------------------- 3) 反证：真推进一步，它要重新算活着
    st, nr = http_json('/agent/loop/next', 'POST', token=token, body={'loopId': loop_id})
    log('        推进一步：HTTP %d %s' % (st, json.dumps(nr, ensure_ascii=False)[:200]))
    h2 = health()
    check('★ 真推进一步后重新算「活着」（没把真在跑的误杀）',
          h2.get('liveLoops') == 1,
          'liveLoops=%s runningLoops=%s' % (h2.get('liveLoops'), h2.get('runningLoops')))

    # --------------------------------- 4) 收尾：停掉后两种口径都应归零
    http_json('/agent/loop/stop', 'POST', token=token, body={'loopId': loop_id})
    h3 = health()
    check('停掉之后两种口径都归零',
          h3.get('liveLoops') == 0 and h3.get('runningLoops') == 0,
          'liveLoops=%s runningLoops=%s' % (h3.get('liveLoops'), h3.get('runningLoops')))

    # ---------------------------------------------------------------- 汇总
    ok_n = sum(1 for ok, _, _ in results if ok)
    log('')
    log('=' * 78)
    log('结果：%d / %d 通过' % (ok_n, len(results)))
    for ok, name, detail in results:
        if not ok:
            log('   FAIL  %s :: %s' % (name, detail))
    log('=' * 78)
    return 0 if ok_n == len(results) else 1


if __name__ == '__main__':
    rc = 2
    try:
        rc = main()
    finally:
        for label, p in procs:
            try:
                p.terminate()
            except Exception:  # noqa: BLE001
                pass
        time.sleep(1)
        for label, p in procs:
            if p.poll() is None:
                try:
                    p.kill()
                except Exception:  # noqa: BLE001
                    pass
        log('[cleanup] 子进程已收')
    sys.exit(rc)
