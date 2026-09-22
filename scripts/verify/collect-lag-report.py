# -*- coding: utf-8 -*-
r"""
**一键采集"卡顿现场"报告** —— 只读，不改任何东西，不需要登录、不起环境。

给谁用
  在**出问题的那台机器**上跑。跑的时候**让应用处于你觉得卡的状态**
  （开 1 个浏览器、不做操作，或者你觉得卡的那个场景），采集 60 秒。

它采什么
  ① **系统**：可用内存、硬换页（Pages Input/sec）、缺页、页面文件占用、
     磁盘忙、磁盘队列、整机 CPU、处理器队列 —— 每秒一点
  ② **我们的应用**：AI 工作台 / electron 各进程的 CPU 与内存（tasklist）
  ③ **本机其它大户**：内存占用 TOP 10 进程（看是不是被别的软件挤的）
  ④ **应用自身日志**：有没有 GPU 进程崩溃、有没有报错
  ⑤ 结束时给一段**结论**：这些窗口里有没有硬换页 / 磁盘抖动 / 我们的应用占了多少

怎么跑（Windows + Python 即可，不需要仓库依赖）
  python collect-lag-report.py
  python collect-lag-report.py --secs 120          # 采久一点
  python collect-lag-report.py --out D:\lag.txt    # 指定输出文件

输出
  终端里直接看，同时写一份 `lag-report-<时间戳>.txt`，**把那个文件发回来**就行。
"""

import argparse
import csv
import ctypes
import io
import os
import re
import statistics
import subprocess
import sys
import time
from ctypes import wintypes

CTRS = [
    (r'\Memory\Available MBytes', '可用内存MB'),
    (r'\Memory\Pages Input/sec', '硬换页次每秒'),
    (r'\Memory\Page Faults/sec', '缺页次每秒'),
    (r'\Paging File(_Total)\% Usage', '页面文件占用%'),
    (r'\PhysicalDisk(_Total)\% Disk Time', '磁盘忙%'),
    (r'\PhysicalDisk(_Total)\Avg. Disk Queue Length', '磁盘队列'),
    (r'\Processor(_Total)\% Processor Time', '整机CPU%'),
    (r'\System\Processor Queue Length', '处理器队列'),
]
APP_NAMES = ['AI 工作台.exe', 'electron.exe', 'node.exe', 'postgres.exe']
OUT = []


def log(*a):
    s = ' '.join(str(x) for x in a)
    OUT.append(s)
    print(s, flush=True)


def section(t):
    log('')
    log('=' * 78)
    log(t)
    log('=' * 78)


class _MS(ctypes.Structure):
    _fields_ = [('dwLength', ctypes.c_ulong), ('dwMemoryLoad', ctypes.c_ulong),
                ('ullTotalPhys', ctypes.c_ulonglong), ('ullAvailPhys', ctypes.c_ulonglong),
                ('ullTotalPageFile', ctypes.c_ulonglong), ('ullAvailPageFile', ctypes.c_ulonglong),
                ('ullTotalVirtual', ctypes.c_ulonglong), ('ullAvailVirtual', ctypes.c_ulonglong),
                ('ullAvailExtendedVirtual', ctypes.c_ulonglong)]


def sys_mem():
    m = _MS()
    m.dwLength = ctypes.sizeof(_MS)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return {'freeMB': round(m.ullAvailPhys / 1048576),
            'totalMB': round(m.ullTotalPhys / 1048576),
            'loadPct': int(m.dwMemoryLoad)}


def tasklist_rows():
    """返回 [(name, pid, memMB)]；tasklist 输出是 GBK。"""
    try:
        out = subprocess.run(['tasklist', '/FO', 'CSV', '/NH'],
                             capture_output=True).stdout.decode('gbk', 'replace')
    except Exception:
        return []
    rows = []
    for line in out.splitlines():
        try:
            cells = next(csv.reader(io.StringIO(line)))
        except Exception:
            continue
        if len(cells) < 5:
            continue
        try:
            kb = int(cells[4].replace(',', '').replace('K', '').strip())
        except Exception:
            continue
        rows.append((cells[0], cells[1], kb / 1024))
    return rows


def sample_system(secs):
    tmp = os.path.join(os.environ.get('TEMP', '.'), 'lag-ctr.txt')
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write('\n'.join(c[0] for c in CTRS) + '\n')
    try:
        p = subprocess.Popen(['typeperf', '-cf', tmp, '-si', '1', '-sc', str(int(secs))],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        o, e = p.communicate(timeout=secs * 4 + 90)
    except Exception as ex:
        log('  ★ typeperf 失败：%s' % ex)
        return {}
    txt = o.decode('gbk', 'replace')
    err = e.decode('gbk', 'replace').strip()
    if err:
        log('  typeperf stderr：%s' % err[:200])
    rows = [r for r in csv.reader(io.StringIO(txt)) if r and any(c.strip() for c in r)]
    hdr, data = None, []
    for r in rows:
        if r[0].strip().startswith('(PDH-CSV'):
            hdr = [c.strip() for c in r]
            continue
        if hdr and len(r) == len(hdr):
            data.append(r)
    out = {}
    for i, (_, lab) in enumerate(CTRS):
        vals = []
        for row in data:
            try:
                v = float(row[i + 1])
            except Exception:
                continue
            if abs(v) > 1e9:      # 垃圾值保护
                continue
            vals.append(v)
        out[lab] = vals
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--secs', type=int, default=60, help='采集秒数（默认 60）')
    ap.add_argument('--out', default='', help='输出文件路径')
    args = ap.parse_args()

    section('一键采集「卡顿现场」报告')
    log('  时间：%s' % time.strftime('%Y-%m-%d %H:%M:%S'))
    log('  采集时长：%d 秒（**请让应用处于你觉得卡的状态**）' % args.secs)
    log('  说明：本脚本**只读**——不启动、不修改、不删除任何东西。')

    section('1. 采前快照')
    m = sys_mem()
    log('  物理内存：可用 %d MB / 共 %d MB（占用 %d%%）' % (m['freeMB'], m['totalMB'], m['loadPct']))
    rows = tasklist_rows()
    for name in APP_NAMES:
        pids = [(p, mem) for n, p, mem in rows if n.lower() == name.lower()]
        if pids:
            log('  %-18s 进程数 %-3d 合计内存 %.0f MB'
                % (name, len(pids), sum(x[1] for x in pids)))
        else:
            log('  %-18s 未运行' % name)
    agg = {}
    for n, p, mem in rows:
        agg[n] = agg.get(n, 0) + mem
    log('')
    log('  本机内存 TOP 10 进程：')
    for n, mem in sorted(agg.items(), key=lambda kv: -kv[1])[:10]:
        log('    %-34s %8.0f MB' % (n, mem))
    log('  （共 %d 个进程，合计 %.1f GB）' % (len(rows), sum(agg.values()) / 1024))

    section('2. 采集 %d 秒（每秒一点）' % args.secs)
    log('  正在采集…（这期间请保持应用在你觉得卡的状态）')
    s = sample_system(args.secs)
    rows2 = tasklist_rows()
    agg2 = {}
    for n, p, mem in rows2:
        agg2[n] = agg2.get(n, 0) + mem

    section('3. 系统指标统计')
    if not s:
        log('  ★ 没采到数据（typeperf 不可用？）')
    else:
        log('  %-18s %10s %10s %10s %8s' % ('指标', '最小', '均值', '最大', '>均值×3'))
        for _, lab in CTRS:
            v = s.get(lab) or []
            if not v:
                continue
            mean = statistics.mean(v)
            spikes = sum(1 for x in v if mean > 0 and x > mean * 3)
            log('  %-18s %10.2f %10.2f %10.2f %8d' % (lab, min(v), mean, max(v), spikes))

    section('4. 我们应用在采集期间的内存')
    for name in APP_NAMES:
        pids = [(p, mem) for n, p, mem in rows2 if n.lower() == name.lower()]
        if pids:
            log('  %-18s 进程数 %-3d 合计内存 %.0f MB' % (name, len(pids), sum(x[1] for x in pids)))

    section('5. 结论')
    if s:
        hard = s.get('硬换页次每秒') or []
        diskq = s.get('磁盘队列') or []
        diskb = s.get('磁盘忙%') or []
        free = s.get('可用内存MB') or []
        cpu = s.get('整机CPU%') or []
        if free:
            log('  可用内存：最小 %d MB / 均值 %d MB' % (min(free), statistics.mean(free)))
        if hard:
            log('  硬换页：均值 %.1f / 峰值 %.1f 次每秒' % (statistics.mean(hard), max(hard)))
            if max(hard) > 1000:
                log('    ⚠️ 出现过 >1000 次/秒 的硬换页 —— 系统在被内存压力推着换页')
            else:
                log('    ✅ 没有持续的高硬换页')
        if diskb:
            log('  磁盘忙：均值 %.2f%% / 峰值 %.2f%%' % (statistics.mean(diskb), max(diskb)))
        if diskq:
            log('  磁盘队列：均值 %.3f / 峰值 %.3f' % (statistics.mean(diskq), max(diskq)))
            if max(diskq) > 2:
                log('    ⚠️ 磁盘队列峰值 > 2 —— 磁盘确实在排队（会拖慢一切）')
            else:
                log('    ✅ 磁盘没有明显排队')
        if cpu:
            log('  整机 CPU：均值 %.1f%% / 峰值 %.1f%%' % (statistics.mean(cpu), max(cpu)))
        log('')
        log('  ★ 判读口径：')
        log('    · 若"磁盘队列"和"硬换页"都很低 ⇒ 系统层没有抖动，问题更可能在应用/交互层')
        log('    · 若磁盘队列或硬换页很高 ⇒ 是**系统级资源压力**在拖慢一切（与我们的浏览器代码无关）')
        log('    · 请把本文件连同"当时什么感觉、开的什么网站、任务管理器里 AI 工作台 那行多少"一起发回')

    out = args.out or ('lag-report-%s.txt' % time.strftime('%Y%m%d-%H%M%S'))
    with open(out, 'w', encoding='utf-8') as f:
        f.write('\n'.join(OUT))
    section('报告已写出')
    log('  %s' % os.path.abspath(out))
    log('  **把这个文件发回来即可。**')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('\n被中断')
        sys.exit(130)
