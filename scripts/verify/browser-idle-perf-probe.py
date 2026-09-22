# -*- coding: utf-8 -*-
"""
闲置浏览器性能**根因探针** —— 只诊断，不改产品代码。

要回答的问题
  只开 1 个浏览器、不做任何操作，应用整体就卡。到底卡在哪一环？

三段对照（同一进程、同一轮，唯一变量是"有没有那张页"）
  Phase 0  0 张页       —— 应用自身基线
  Phase 1  1 张页 · 全屏 —— 用户报的场景（默认就是全屏）
  Phase 2  1 张页 · 后台（opacity:0）—— 证明"隐藏"到底有没有省到东西

采集口径
  · 数据源 = 主进程 `app.getAppMetrics()`（与代码里 resource-guard 同源、同口径：
    每个进程的 cpuPct 已是"占整机"百分比，100% = 所有逻辑核跑满）。
  · **把内置资源哨兵的采样间隔从默认 5s 调到 1s**（`SETTINGS_RANGE` 允许的合法值，
    只写临时 profile 的 settings，不动仓库代码）——因为 `percentCPUUsage` 是
    "距上一次调用之间的平均"，只有把间隔压到 1s 才看得见周期尖峰。
    5s 的粗采样会把 1.2s 的尖峰平均掉。
  · 打开 `WB_RESOURCE_GUARD_RAW=1`，哨兵会把**每一点、含按进程明细**写进
    `raw-YYYY-MM-DD.jsonl`；探针最后读这个文件切片，不额外轮询（避免采样干扰）。
  · 另外在渲染层给两个关键 IPC 套计数器，直接数"闲置时它们被调了多少次"。

用法
  C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe \
      -u scripts/verify/browser-idle-perf-probe.py
"""

import importlib.util
import json
import os
import re
import statistics
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

# ★ 必须在 import 助手之前设好：它按这些环境变量算端口
os.environ['FB_CDP_PORT'] = os.environ.get('IP_CDP_PORT', '9343')
os.environ['FB_API_PORT'] = os.environ.get('IP_API_PORT', '8793')
os.environ['FB_FAKE_PORT'] = os.environ.get('IP_FAKE_PORT', '8894')
os.environ['FB_VITE_PORT'] = os.environ.get('IP_VITE_PORT', '5179')

_spec = importlib.util.spec_from_file_location(
    'fbt', os.path.join(HERE, 'fullscreen-browser-tests.py'))
F = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(F)

OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'browser-idle-perf')
F.OUTDIR = OUTDIR
F.TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wb-idleperf')
F.PROFILE = os.path.join(F.TMP, 'profile')
os.makedirs(OUTDIR, exist_ok=True)

P = F.P
NODE = F.NODE
API, FAKE = F.API, F.FAKE
FAKE_PORT = F.FAKE_PORT
API_PORT, VITE_PORT, CDP_PORT = F.API_PORT, F.VITE_PORT, F.CDP_PORT
FAKE_LOG = os.path.join(OUTDIR, 'llm.jsonl')
SERVER_LOG = os.path.join(OUTDIR, 'server.log')
VITE_LOG = os.path.join(OUTDIR, 'vite.log')
ELECTRON_LOG = os.path.join(OUTDIR, 'electron.log')
FAKE_LOG_OLD = F.FAKE_LOG
F.FAKE_LOG = FAKE_LOG
F.SERVER_LOG = SERVER_LOG

# 各段时长（秒）
SECS_BASE = int(os.environ.get('IP_SECS_BASE', '40'))
SECS_TAB = int(os.environ.get('IP_SECS_TAB', '75'))
SECS_BG = int(os.environ.get('IP_SECS_BG', '40'))
PROFILE_SECS = int(os.environ.get('IP_SECS_PROFILE', '30'))

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


# ---------------------------------------------------------------- 进程工具

def electron_pids():
    """当前 electron.exe 的 pid 集合（用于"只杀本次新起的"）。"""
    try:
        out = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq electron.exe', '/FO', 'CSV', '/NH'],
                             capture_output=True).stdout.decode('gbk', 'replace')
    except Exception:
        return set()
    pids = set()
    for line in out.splitlines():
        m = re.match(r'"electron\.exe","(\d+)"', line.strip())
        if m:
            pids.add(int(m.group(1)))
    return pids


# ---------------------------------------------------------------- 采集

def read_raw(path):
    rows = []
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except Exception:
                    pass
    except Exception:
        pass
    return rows


def slice_rows(rows, t0, t1):
    return [r for r in rows if t0 <= (r.get('at') or 0) <= t1]


def summarize(rows, label):
    """把一段采样汇总成"按进程"的均值/峰值。"""
    if not rows:
        log('  %s：无采样点' % label)
        return {}
    per = {}
    for r in rows:
        for p in r.get('procs') or []:
            key = (p.get('type'), p.get('name') or '')
            per.setdefault(key, []).append(p.get('cpuPct') or 0.0)
    log('  %s：%d 点（%.1fs）' % (label, len(rows),
                                 (rows[-1]['at'] - rows[0]['at']) / 1000.0))
    log('    总 CPU：均值 %.2f%%  峰值 %.2f%%   |   总内存：均值 %.0f MB  峰值 %.0f MB'
        % (statistics.mean([r.get('cpuPct') or 0 for r in rows]),
           max(r.get('cpuPct') or 0 for r in rows),
           statistics.mean([r.get('memMB') or 0 for r in rows]),
           max(r.get('memMB') or 0 for r in rows)))
    log('    %-10s %-26s %8s %8s %8s' % ('类型', '进程', 'CPU均', 'CPU峰', '内存均'))
    for (typ, name), vals in sorted(per.items(), key=lambda kv: -statistics.mean(kv[1])):
        log('    %-10s %-26s %8.2f %8.2f %8.0f'
            % (typ, name or '-', statistics.mean(vals), max(vals),
               statistics.mean([p.get('memMB') or 0
                                for r in rows for p in (r.get('procs') or [])
                                if (p.get('type'), p.get('name') or '') == (typ, name)])))
    return {'n': len(rows),
            'cpuMean': round(statistics.mean([r.get('cpuPct') or 0 for r in rows]), 3),
            'cpuMax': round(max(r.get('cpuPct') or 0 for r in rows), 3),
            'memMean': round(statistics.mean([r.get('memMB') or 0 for r in rows]), 1),
            'perProc': {('%s|%s' % k): {'cpuMean': round(statistics.mean(v), 3),
                                        'cpuMax': round(max(v), 3)}
                        for k, v in per.items()}}


def cpu_series(rows):
    return [round(r.get('cpuPct') or 0, 2) for r in rows]


def find_period(series, lo=2, hi=40):
    """
    在 1 秒序列里找主周期（简单的周期图）。
    返回 [(周期秒, 强度)] 前 3 —— 强度是该周期上的能量占比。
    用来判"持续偏高"还是"每隔 N 秒跳一下"。
    """
    n = len(series)
    if n < lo * 3:
        return []
    mean = statistics.mean(series)
    x = [v - mean for v in series]
    energy = sum(v * v for v in x) or 1e-9
    out = []
    for k in range(lo, min(hi, n // 3) + 1):
        re_ = sum(x[i] * (__import__('math').cos(2 * 3.141592653589793 * i / k))
                  for i in range(n))
        im_ = sum(x[i] * (__import__('math').sin(2 * 3.141592653589793 * i / k))
                  for i in range(n))
        out.append((k, (re_ * re_ + im_ * im_) / (n * energy)))
    out.sort(key=lambda kv: -kv[1])
    return [(k, round(v, 3)) for k, v in out[:3]]


# ---------------------------------------------------------------- 主流程

def main():
    section('0. 环境自检')
    for label, path in [('vite 入口', F.first_existing(
                            os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                            os.path.join(F.DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'))),
                        ('electron 二进制', F.first_existing(
                            os.path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'),
                            os.path.join(F.DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe'))),
                        ('start-electron.mjs', os.path.join(F.DESKTOP, 'scripts', 'start-electron.mjs'))]:
        log('  %s：%s' % (label, path or '★缺失★'))
        if not path:
            log('  构建产物缺失，先 npm run build -w @ai-workbench/desktop')
            return 2
    busy = [p for p in (API_PORT, FAKE_PORT, VITE_PORT, CDP_PORT) if F.port_busy(p)]
    log('  端口占用：%s' % (busy or '无（干净）'))
    if busy:
        log('  端口被占，先收干净上一轮')
        return 2

    e_pids_before = electron_pids()
    log('  起跑前 electron.exe：%s' % (sorted(e_pids_before) or '无'))

    section('1. 确保数据库可用')
    if not F.RPR.ensure_pg():
        log('  ★ 数据库起不来，中止')
        return 2
    log('  数据库可查询')

    section('2. 起环境（假模型 + 假站点 + 验收后端 + vite + 真 Electron）')
    # 临时 profile：把内置资源哨兵调成 1 秒采样（合法区间 1000~60000）
    import shutil
    shutil.rmtree(F.TMP, ignore_errors=True)
    os.makedirs(F.PROFILE, exist_ok=True)
    with open(os.path.join(F.PROFILE, 'workbench-settings.json'), 'w', encoding='utf-8') as f:
        json.dump({'resourceGuardEnabled': 1, 'resourceSampleMs': 1000}, f)
    log('  临时 profile 写入：resourceSampleMs=1000（1 秒分辨率，其余默认）')

    VITE_BIN = F.first_existing(os.path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'),
                                os.path.join(F.DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'))

    F.spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], REPO,
            env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_DELAY_MS': '2500',
                 'FAKE_STEPS': '30', 'FAKE_LOG': FAKE_LOG},
            log=os.path.join(OUTDIR, 'fake.log'))
    if F.wait_health(FAKE).get('ok') is not True:
        log('  ★ 假模型没起来')
        return 2
    log('  假模型/假站点就绪 %s' % FAKE)

    F.spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
            env={'PORT': str(API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
                 'DEEPSEEK_API_KEY': 'fake-key-idleperf', 'DEEPSEEK_MODEL': 'fake-idleperf'},
            log=SERVER_LOG)
    hs = F.wait_health(API)
    log('  验收后端 /health：%s' % json.dumps(hs, ensure_ascii=False)[:180])
    if hs.get('db') != 'up':
        log('  ★ 后端没起来（db 不是 up）')
        return 2

    F.spawn('vite', [NODE, VITE_BIN, '--port', str(VITE_PORT), '--strictPort'], F.DESKTOP,
            log=VITE_LOG)
    time.sleep(4)

    # ★ 打开 RAW：哨兵把每一点（含按进程明细）写盘，探针只读文件、不额外轮询
    F.spawn('electron', [NODE, 'scripts/start-electron.mjs',
                         '--user-data-dir=%s' % F.PROFILE,
                         '--remote-debugging-port=%d' % CDP_PORT], F.DESKTOP,
            env={'VITE_DEV_SERVER_URL': 'http://localhost:%d' % VITE_PORT,
                 'WB_RESOURCE_GUARD_RAW': '1'},
            log=ELECTRON_LOG)
    ok, _, ms = F.wait_until(lambda: bool(P.page('localhost:%d' % VITE_PORT)), timeout=90)
    log('  Electron 窗口出现（CDP 连上渲染进程）：%s（%dms）' % (ok, ms))
    if not ok:
        log('  ★ 窗口没起来')
        return 2

    section('3. 登录（走真实短信链路）')
    st, _ = F.http_json('/auth/sms/send', 'POST', body={'phone': F.TEST_PHONE})
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
    if not code:
        log('  ★ 拿不到验证码')
        return 2
    st, sess = F.http_json('/auth/login/sms', 'POST', body={'phone': F.TEST_PHONE, 'code': code})
    token = (sess or {}).get('token')
    log('  登录：HTTP %d，token %s' % (st, '有' if token else '★没有★'))
    if not token:
        return 2

    c = P.Cdp()
    try:
        c.js("localStorage.setItem('workbench.token', %s);"
             "localStorage.setItem('workbench.apiBase', %s); 'set'"
             % (json.dumps(token), json.dumps(API)))
        c.send('Page.reload')
    finally:
        pass
    time.sleep(6)
    ok, _, ms = F.wait_until(
        lambda: ('退出登录' in (c.js('(document.body.innerText||"")') or ''))
        and (c.js('Boolean(window.workbench && window.workbench.openBrowser)') is True),
        timeout=60)
    log('  进到工作台：%s（%dms）' % (ok, ms))
    if not ok:
        return 2

    # ★ 给两个关键 IPC 套计数器：直接数"闲置时它们被调了多少次"
    c.js("(() => {"
         "  if (window.__ipCount) return 'already';"
         "  window.__ipCount = {getTaskState: 0, browserThrottle: 0, resourceInstances: 0, t0: Date.now()};"
         "  for (const k of ['getTaskState', 'browserThrottle', 'resourceInstances']) {"
         "    const orig = window.workbench[k];"
         "    if (typeof orig !== 'function') continue;"
         "    window.workbench[k] = function (...a) { window.__ipCount[k] += 1; return orig.apply(this, a); };"
         "  }"
         "  return 'wrapped';"
         "})()")

    # 找 raw 目录
    guard_dir = os.path.join(F.PROFILE, 'resource-guard')
    ok, _, _ = F.wait_until(lambda: os.path.isdir(guard_dir), timeout=30)
    log('  资源哨兵落盘目录：%s（存在=%s）' % (guard_dir, ok))

    marks = {}

    # ---------------------------------------------------------- Phase 0
    section('4. Phase 0 —— 0 张页（应用自身基线）')
    log('  现在没有打开任何浏览器页。等待 %d 秒…' % SECS_BASE)
    t0 = time.time()
    time.sleep(SECS_BASE)
    marks['p0'] = (t0, time.time())
    log('  计数：%s' % json.dumps(c.js('window.__ipCount') or {}, ensure_ascii=False))

    # ---------------------------------------------------------- Phase 1
    section('5. Phase 1 —— 开 1 张页（全屏）后**不做任何操作**')
    log('  调 openBrowser(%s/shop) —— 只开页，不起任何任务' % FAKE)
    c.js('window.workbench.openBrowser(%s); "ok"' % json.dumps(FAKE + '/shop'))
    ok, _, ms = F.wait_until(
        lambda: len([w for w in F.webviews() if isinstance(w.get('wcId'), int)]) >= 1, timeout=90)
    log('  内嵌页建起来：%s（%dms）' % (ok, ms))
    if not ok:
        return 2
    time.sleep(8)  # 等页面加载稳定
    L = F.layer()
    log('  层状态：%s' % json.dumps(L, ensure_ascii=False))
    wv = L.get('wvRect') or {}
    log('  webview 尺寸：%sx%s，wcId=%s' % (wv.get('w'), wv.get('h'), L.get('wvWc')))

    # 主窗口渲染进程 profile（只在这 30 秒）
    prof_main = None
    if PROFILE_SECS > 0:
        try:
            c.send('Profiler.enable')
            c.send('Profiler.setSamplingInterval', interval=2000)
            c.send('Profiler.start')
            log('  [已开始主窗口渲染进程的 CPU Profile，%d 秒]' % PROFILE_SECS)
        except Exception as e:
            log('  ★ Profiler 起不来：%s' % e)

    t1 = time.time()
    time.sleep(SECS_TAB)
    marks['p1'] = (t1, time.time())

    if PROFILE_SECS > 0:
        try:
            r = c.send('Profiler.stop')
            prof_main = r.get('profile')
            log('  主窗口 profile 已收（节点 %d）' % len(prof_main.get('nodes') or []))
        except Exception as e:
            log('  ★ Profiler 收不回来：%s' % e)
    log('  计数：%s' % json.dumps(c.js('window.__ipCount') or {}, ensure_ascii=False))

    # ---------------------------------------------------------- Phase 2
    section('6. Phase 2 —— 同一张页，切到「后台运行」（opacity:0）')
    try:
        F.exit_fullscreen()
        time.sleep(2)
        L2 = F.layer()
        log('  层状态：%s' % json.dumps(L2, ensure_ascii=False))
        log('  webview 尺寸：%sx%s（应与 Phase 1 一致）'
            % ((L2.get('wvRect') or {}).get('w'), (L2.get('wvRect') or {}).get('h')))
    except Exception as e:
        log('  ★ 切后台失败：%s' % e)
    t2 = time.time()
    time.sleep(SECS_BG)
    marks['p2'] = (t2, time.time())
    counts_final = c.js('window.__ipCount') or {}
    log('  计数：%s' % json.dumps(counts_final, ensure_ascii=False))

    # ---------------------------------------------------------- 读盘 + 汇总
    section('7. 读哨兵落盘的原始明细并按段汇总')
    raw_files = []
    if os.path.isdir(guard_dir):
        raw_files = [os.path.join(guard_dir, n) for n in os.listdir(guard_dir)
                     if n.startswith('raw-') and n.endswith('.jsonl')]
    log('  原始文件：%s' % [os.path.basename(p) for p in raw_files])
    rows = []
    for p in raw_files:
        rows.extend(read_raw(p))
    rows.sort(key=lambda r: r.get('at') or 0)
    log('  原始采样点合计：%d' % len(rows))

    res = {}
    for name, key in [('Phase 0（0 张页）', 'p0'), ('Phase 1（1 张页·全屏）', 'p1'),
                      ('Phase 2（1 张页·后台）', 'p2')]:
        a, b = marks[key]
        seg = slice_rows(rows, int(a * 1000), int(b * 1000))
        log('')
        log('  ── %s ──' % name)
        res[key] = summarize(seg, name)
        s = cpu_series(seg)
        if s:
            log('    CPU 序列（每秒，%%）：%s' % s[:60])
            if len(s) > 60:
                log('    …（共 %d 点）' % len(s))
            log('    主周期（秒, 强度）：%s' % find_period(s))

    # ---------------------------------------------------------- profile 汇总
    section('8. 主窗口渲染进程：函数级自耗时 Top（Phase 1 那 30 秒）')
    if prof_main:
        agg = {}
        for n in prof_main.get('nodes') or []:
            hits = n.get('hitCount') or 0
            if hits <= 0:
                continue
            cf = n.get('callFrame') or {}
            url = (cf.get('url') or '').split('/')[-1]
            key = '%s  @%s:%s' % (cf.get('functionName') or '(anonymous)', url[:38],
                                  cf.get('lineNumber'))
            agg[key] = agg.get(key, 0) + hits
        total = sum(agg.values()) or 1
        log('  样本总数 %d（%.1f 秒 ≈ 每秒 %.0f 个样本）'
            % (total, PROFILE_SECS, total / max(1, PROFILE_SECS)))
        for k, v in sorted(agg.items(), key=lambda kv: -kv[1])[:18]:
            log('    %6.2f%%  %6d  %s' % (100.0 * v / total, v, k))
    else:
        log('  （没有 profile 数据）')

    # ---------------------------------------------------------- IPC 计数
    section('9. 闲置期间关键 IPC 的调用次数')
    c0 = c.js('window.__ipCount') or {}
    span = (marks['p2'][1] - marks['p0'][0])
    for k in ('getTaskState', 'browserThrottle', 'resourceInstances'):
        n = c0.get(k, 0)
        log('  %-18s 共 %4d 次   平均 %.2f 次/秒   周期约 %.2f 秒'
            % (k, n, n / span if span else 0, (span / n) if n else 0))

    # 落盘
    out = {'phases': {k: [round(v[0], 3), round(v[1], 3)] for k, v in marks.items()},
           'summary': res, 'ipcCounts': c0, 'spanSec': round(span, 1)}
    with open(os.path.join(OUTDIR, 'probe-result.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    with open(os.path.join(OUTDIR, 'probe-report.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(REPORT))

    section('10. 收尾')
    cleanup(e_pids_before)
    log('  证据目录：%s' % OUTDIR)
    return 0


def cleanup(e_pids_before):
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
    # 只杀"本次新起的" electron.exe（start-electron.mjs 的子进程，父进程被 kill 后可能还在）
    try:
        now = electron_pids()
        new = sorted(now - e_pids_before)
        if new:
            subprocess.run(['taskkill', '/F'] + sum([['/PID', str(x)] for x in new], []),
                           capture_output=True)
            print('  已结束本次新起的 electron.exe：%s' % new)
        else:
            print('  没有遗留的 electron.exe')
    except Exception as e:
        print('  收 electron 时出错：%s' % e)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('\n被中断，收尾…')
        cleanup(set())
        sys.exit(130)
