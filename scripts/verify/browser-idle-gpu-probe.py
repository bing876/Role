# -*- coding: utf-8 -*-
r"""
闲置浏览器 **GPU 占用** 探针 —— 只诊断，不改产品代码。

为什么要单独做
  `app.getAppMetrics()`（代码里资源哨兵用的那个接口）**只给每个进程的 CPU / 内存**，
  拿不到真正的 GPU 引擎利用率。要回答"GPU 占多少"必须走 Windows 的性能计数器
  `\\GPU Engine(pid_...)\Utilization Percentage`，按 pid 归因。

做法
  起应用 → 开 1 张页 → 往内嵌页注入持续动画 → 分别在
  「全屏」与「后台(opacity:0)」两段里，每秒采一次 GPU 引擎计数器并按 pid 汇总。

用法
  C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe \
      -u scripts/verify/browser-idle-gpu-probe.py
"""

import csv
import importlib.util
import io
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

os.environ['FB_CDP_PORT'] = os.environ.get('IG_CDP_PORT', '9349')
os.environ['FB_API_PORT'] = os.environ.get('IG_API_PORT', '8799')
os.environ['FB_FAKE_PORT'] = os.environ.get('IG_FAKE_PORT', '8900')
os.environ['FB_VITE_PORT'] = os.environ.get('IG_VITE_PORT', '5185')

_spec = importlib.util.spec_from_file_location(
    'fbt', os.path.join(HERE, 'fullscreen-browser-tests.py'))
F = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(F)

OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'browser-idle-perf')
F.OUTDIR = OUTDIR
F.TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wb-idlegpu')
F.PROFILE = os.path.join(F.TMP, 'profile')
os.makedirs(OUTDIR, exist_ok=True)

P = F.P
NODE = F.NODE
API, FAKE = F.API, F.FAKE
FAKE_PORT = F.FAKE_PORT
API_PORT, VITE_PORT, CDP_PORT = F.API_PORT, F.VITE_PORT, F.CDP_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm-gpu.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server-gpu.log')

WIN = int(os.environ.get('IG_WINDOW_SECS', '14'))
REPORT = []


def log(*a):
    s = ' '.join(str(x) for x in a)
    REPORT.append(s)
    print(s, flush=True)


def section(t):
    log('')
    log('=' * 78)
    log(t)
    log('=' * 78)


def electron_pids():
    try:
        out = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq electron.exe', '/FO', 'CSV', '/NH'],
                             capture_output=True).stdout.decode('gbk', 'replace')
    except Exception:
        return set()
    return set(int(m.group(1)) for m in
               (re.match(r'"electron\.exe","(\d+)"', l.strip()) for l in out.splitlines()) if m)


# ----------------------------------------------------------------- GPU 计数器

_GPU_CTR = {}


def gpu_counters():
    """枚举 GPU 引擎计数器，建 pid → 计数器路径列表 的映射。"""
    global _GPU_CTR
    if _GPU_CTR:
        return _GPU_CTR
    try:
        out = subprocess.run(['typeperf', '-qx', 'GPU Engine'], capture_output=True,
                             timeout=60).stdout.decode('gbk', 'replace')
    except Exception as e:
        log('  ★ typeperf 枚举失败：%s' % e)
        return {}
    m = {}
    for line in out.splitlines():
        line = line.strip()
        if not line.startswith('\\GPU Engine('):
            continue
        mm = re.search(r'pid_(\d+)_', line)
        if mm:
            m.setdefault(int(mm.group(1)), []).append(line)
    _GPU_CTR = m
    return m


def sample_gpu(pids, secs, interval=1.0):
    """
    用**一个长驻 typeperf 进程**连续采 secs 秒（每秒一个样本）。

    ★ 两个坑（都实测过）：
      1. 一次查询**全部** GPU 计数器（本机 866 条）会让 PDH 返回垃圾值
         （见过 7.4e19%）。所以这里只查**本应用那几个 pid** 的计数器。
      2. 速率计数器需要预热；且 CSV 是「表头一行 + 时间戳数据行」，
         不能按 `startswith('\\GPU Engine(')` 去找数据行 —— 那个形状只属于表头。
    """
    ctr = gpu_counters()
    want = []
    for p in pids:
        want.extend(ctr.get(p, []))
    if not want:
        return []
    os.makedirs(F.TMP, exist_ok=True)
    cf = os.path.join(F.TMP, 'gpu-counters.txt')
    with open(cf, 'w', encoding='utf-8') as f:
        f.write('\n'.join(want) + '\n')
    log('    计数器 %d 条（覆盖 %d 个 pid），采 %d 秒…'
        % (len(want), len(set(pids) & set(ctr)), secs))
    try:
        proc = subprocess.Popen(
            ['typeperf', '-cf', cf, '-si', str(int(interval)), '-sc', str(int(secs))],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        txt = proc.communicate(timeout=secs * 4 + 90)[0].decode('gbk', 'replace')
    except Exception as e:
        log('    ★ typeperf 失败：%s' % e)
        return []
    rows = [r for r in csv.reader(io.StringIO(txt)) if r and any(c.strip() for c in r)]
    hdr = None
    data = []
    for r in rows:
        if r[0].strip().startswith('(PDH-CSV'):
            hdr = [c.strip() for c in r]
            continue
        if hdr and len(r) == len(hdr):
            data.append(r)
    if not hdr:
        log('    ★ 没解析到表头')
        return []
    out = []
    for row in data:
        per = {}
        for c, v in zip(hdr[1:], row[1:]):
            mm = re.search(r'pid_(\d+)_', c)
            if not mm:
                continue
            try:
                fv = float(v)
            except Exception:
                continue
            if fv > 1000:          # 垃圾值保护（见上面第 1 条）
                continue
            per[int(mm.group(1))] = per.get(int(mm.group(1)), 0.0) + fv
        out.append(per)
    log('    解析到 %d 个样本' % len(out))
    return out


def report_gpu(samples, label):
    if not samples:
        log('  %-16s 没有 GPU 计数器数据' % label)
        return None
    pids = sorted({p for s in samples for p in s})
    total = [sum(s.values()) for s in samples]
    log('  %-16s GPU 总利用率：均 %.3f%%  峰 %.3f%%   （%d 个样本）'
        % (label, statistics.mean(total), max(total), len(total)))
    per_pid = {}
    for pid in pids:
        vals = [s.get(pid, 0.0) for s in samples]
        per_pid[pid] = (statistics.mean(vals), max(vals))
        log('      pid %-7s 均 %6.3f%%  峰 %6.3f%%' % (pid, per_pid[pid][0], per_pid[pid][1]))
    return {'totalMean': round(statistics.mean(total), 3), 'totalMax': round(max(total), 3),
            'perPid': {str(k): [round(v[0], 3), round(v[1], 3)] for k, v in per_pid.items()}}


INSTALL_JS = r"""
(() => {
  if (window.__gpuAnim) return 'already';
  window.__gpuAnim = 1;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px;'
    + 'background:linear-gradient(45deg,#f0f,#0ff);opacity:.5;z-index:2147483647;'
    + 'pointer-events:none;will-change:transform';
  document.documentElement.appendChild(box);
  let a = 0;
  const spin = () => { a = (a + 4) % 360;
    box.style.transform = 'translate(' + (300 + 250 * Math.sin(a * Math.PI / 180)).toFixed(1)
      + 'px,' + (300 + 250 * Math.cos(a * Math.PI / 180)).toFixed(1) + 'px) rotate(' + a + 'deg)';
    requestAnimationFrame(spin); };
  requestAnimationFrame(spin);
  return 'installed';
})()
"""


def main():
    section('0. 环境自检')
    for label, path in [('vite 入口', F.first_existing(
                            os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                            os.path.join(F.DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'))),
                        ('electron 二进制', F.first_existing(
                            os.path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'),
                            os.path.join(F.DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe')))]:
        if not path:
            log('  ★ 缺 %s' % label)
            return 2
    busy = [p for p in (API_PORT, FAKE_PORT, VITE_PORT, CDP_PORT) if F.port_busy(p)]
    log('  端口占用：%s' % (busy or '无（干净）'))
    if busy:
        return 2
    e_before = electron_pids()
    ctr = gpu_counters()
    log('  GPU 引擎计数器：%d 个 pid，共 %d 条' % (len(ctr), sum(len(v) for v in ctr.values())))
    if not ctr:
        log('  ★ 本机拿不到 GPU Engine 计数器，无法测 GPU 利用率')
        return 2

    section('1. 数据库')
    if not F.RPR.ensure_pg():
        log('  ★ 数据库起不来')
        return 2
    log('  数据库可查询')

    section('2. 起环境')
    shutil.rmtree(F.TMP, ignore_errors=True)
    os.makedirs(F.PROFILE, exist_ok=True)
    with open(os.path.join(F.PROFILE, 'workbench-settings.json'), 'w', encoding='utf-8') as f:
        json.dump({'resourceGuardEnabled': 1, 'resourceSampleMs': 1000}, f)
    VITE_BIN = F.first_existing(os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                                os.path.join(F.DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'))
    F.spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], REPO,
            env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_DELAY_MS': '2500',
                 'FAKE_STEPS': '30', 'FAKE_LOG': FAKE_LOG},
            log=os.path.join(OUTDIR, 'fake-gpu.log'))
    if F.wait_health(FAKE).get('ok') is not True:
        log('  ★ 假模型没起来')
        return 2
    F.spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
            env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
                 'DEEPSEEK_API_KEY': 'fake-key-idlegpu', 'DEEPSEEK_MODEL': 'fake-idlegpu'},
            log=SERVER_LOG)
    if F.wait_health(API).get('db') != 'up':
        log('  ★ 后端没起来')
        return 2
    log('  后端就绪（db=up）')
    F.spawn('vite', [NODE, VITE_BIN, '--port', str(VITE_PORT), '--strictPort'], F.DESKTOP,
            log=os.path.join(OUTDIR, 'vite-gpu.log'))
    time.sleep(4)
    F.spawn('electron', [NODE, 'scripts/start-electron.mjs',
                         '--user-data-dir=%s' % F.PROFILE,
                         '--remote-debugging-port=%d' % CDP_PORT], F.DESKTOP,
            env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT,
                 'WB_RESOURCE_GUARD_RAW': '1'},
            log=os.path.join(OUTDIR, 'electron-gpu.log'))
    ok, _, ms = F.wait_until(lambda: bool(P.page('localhost:%d' % VITE_PORT)), timeout=90)
    log('  窗口出现：%s（%dms）' % (ok, ms))
    if not ok:
        return 2

    section('3. 登录')
    F.http_json('/auth/sms/send', 'POST', body={'phone': F.TEST_PHONE})
    code = None
    for _ in range(40):
        try:
            txt = open(SERVER_LOG, encoding='utf-8', errors='replace').read()
        except Exception:
            txt = ''
        m = re.findall(r'(\d{6})', txt)
        if m:
            code = m[-1]
            break
        time.sleep(0.5)
    st, sess = F.http_json('/auth/login/sms', 'POST',
                           body={'phone': F.TEST_PHONE, 'code': code or ''})
    token = (sess or {}).get('token')
    if not token:
        log('  ★ 登录失败 HTTP %s' % st)
        return 2
    c = P.Cdp()
    c.js("localStorage.setItem('workbench.token', %s);"
         "localStorage.setItem('workbench.apiBase', %s); 'set'"
         % (json.dumps(token), json.dumps(API)))
    c.send('Page.reload')
    time.sleep(6)
    ok, _, _ = F.wait_until(
        lambda: ('退出登录' in (c.js('(document.body.innerText||"")') or '')), timeout=60)
    log('  进到工作台：%s' % ok)
    if not ok:
        return 2

    section('4. 开 1 张页 + 注入持续动画')
    c.js('window.workbench.openBrowser(%s); "ok"' % json.dumps(FAKE + '/shop'))
    ok, _, ms = F.wait_until(
        lambda: len([w for w in F.webviews() if isinstance(w.get('wcId'), int)]) >= 1, timeout=90)
    log('  内嵌页建起来：%s（%dms）' % (ok, ms))
    if not ok:
        return 2
    time.sleep(6)
    gc = F.guest_cdp('127.0.0.1:%d' % FAKE_PORT)
    if not gc:
        log('  ★ 连不上内嵌页')
        return 2
    log('  注入动画：%s' % gc.js(INSTALL_JS))
    time.sleep(2)

    pids = sorted(electron_pids())
    log('  应用进程：%s' % pids)
    log('  这些 pid 里有 GPU 计数器的：%s'
        % sorted(set(pids) & set(gpu_counters().keys())))

    res = {}
    section('5. 全屏态 · GPU')
    res['fullscreen'] = report_gpu(sample_gpu(pids, WIN), '全屏 + 动画')

    section('6. 后台态（opacity:0）· GPU')
    try:
        F.exit_fullscreen()
    except Exception as e:
        log('  ★ 切后台失败：%s' % e)
    time.sleep(3)
    log('  层状态：%s' % json.dumps(F.layer(), ensure_ascii=False))
    res['background'] = report_gpu(sample_gpu(pids, WIN), '后台 + 动画')

    section('7. 结论')
    a, b = res.get('fullscreen') or {}, res.get('background') or {}
    if a and b:
        log('  GPU 总利用率：全屏 %.2f%% → 后台 %.2f%%' % (a['totalMean'], b['totalMean']))
        log('  本应用 GPU 进程（electron.exe）明细：')
        for k, v in (a.get('perPid') or {}).items():
            log('    pid %-7s 全屏 %.2f%%   后台 %.2f%%' % (k, v, (b.get('perPid') or {}).get(k, 0)))

    with open(os.path.join(OUTDIR, 'gpu-result.json'), 'w', encoding='utf-8') as fp:
        json.dump(res, fp, ensure_ascii=False, indent=2)
    with open(os.path.join(OUTDIR, 'gpu-report.txt'), 'w', encoding='utf-8') as fp:
        fp.write('\n'.join(REPORT))

    section('8. 收尾')
    for tag, p in F.PROCS:
        try:
            p.terminate()
        except Exception:
            pass
    time.sleep(2)
    for tag, p in F.PROCS:
        try:
            if p.poll() is None:
                p.kill()
        except Exception:
            pass
    try:
        new = sorted(electron_pids() - e_before)
        if new:
            subprocess.run(['taskkill', '/F'] + sum([['/PID', str(x)] for x in new], []),
                           capture_output=True)
            log('  已结束新起的 electron.exe：%s' % new)
    except Exception as e:
        log('  收尾出错：%s' % e)
    log('  证据目录：%s' % OUTDIR)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
