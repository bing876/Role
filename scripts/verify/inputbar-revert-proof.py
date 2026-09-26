#!/usr/bin/env python3
"""批次 M-4'「输入栏」反证：把关键代码改坏 → verify:shell 必须变红 → 立刻还原。
I1 是用户点名的反证：**屏幕上显示真实数据而非写死假数据**（placeholder 写死假名）。

用法： python3 scripts/verify/inputbar-revert-proof.py
原理： 每条"改坏"都对应验收里的一条断言（⑪-x）。
       注入后跑 scripts/verify/app-shell-smoke.mts（verify:shell），
       期望**恰好**那条断言变红 —— 证明断言不是摆设；跑完按原始字节还原。
       任何一条"没变红" = 对应断言是摆设，必须修验收而不是放过。
"""

import hashlib
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

# ★ Windows 修（2026-09-26）：CreateProcess 只按 `.exe` 补后缀，**不解析 `.cmd`**，
# 而 PATH 上只有 npx.cmd ⇒ `['npx', ...]` 必 FileNotFoundError: [WinError 2]。
# 改成「当前 node + 本地 tsx CLI」，跨平台且不依赖 npx / PATH。
import os as _os
import shutil as _shutil
from pathlib import Path as _Path

_REPO_PATH = _Path(str(REPO))
NODE = _shutil.which('node') or 'node'
TSX_CLI = str(_REPO_PATH / 'node_modules' / 'tsx' / 'dist' / 'cli.mjs')
_NPM = _shutil.which('npm') or 'npm'

OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'app-shell')
PY = sys.executable

STYLES = os.path.join(REPO, 'apps', 'desktop', 'src', 'design', '04-inputbar.css')
APP = os.path.join(REPO, 'apps', 'desktop', 'src', 'App.tsx')

# 每条缺陷：名字 / 文件 / 原文 / 改坏后 / 期望变红的断言关键字
DEFECTS = [
    {
        # 用户点名的反证:placeholder 必须从真会话推导 —— 换成写死的假名,⑪-1 必须变红。
        'name': 'I1 placeholder 换成写死假数据（不再跟当前智能体走）',
        'file': APP,
        'old': (
            "            placeholder={\n"
            "              runningLoopId && streaming\n"
            "                ? '任务进行中：输入补充指令/追问注入上下文，或输入「停」暂停任务…'\n"
            "                : streaming\n"
            "                  ? '正在打字…'\n"
            "                  : awaitHere\n"
            "                    ? '回复小助的提问即可，发出后自动继续…'\n"
            "                    : `和${curAgent ? `「${curAgent.name}」` : '小助'}聊聊（说“建一个销售助手”立刻建好，不挡你）`\n"
            "            }"
        ),
        'new': "            placeholder={'和「小助」聊聊（写死占位）'}  // 反证注入",
        'expect': ['⑪-1'],
    },
    {
        # data-state 写死 = 输入状态是假的,⑪-1 的 typing 迁移必须变红。
        'name': 'I2 data-state 写死 empty（输入状态假了）',
        'file': APP,
        'old': "          data-state={streaming ? 'thinking' : input ? 'typing' : 'empty'}",
        'new': "          data-state={'empty'}  // 反证注入:状态写死",
        'expect': ['⑪-1'],
    },
    {
        # Enter 不发送 = 假发送(真 onSend 接线被摘),⑪-2 必须变红。
        'name': 'I3 Enter 不再调 onSend（发送是假的）',
        'file': APP,
        'old': "onKeyDown={(e) => e.key === 'Enter' && onSend()}",
        'new': "onKeyDown={() => { /* 反证注入:Enter 不发送 */ }}",
        'expect': ['⑪-2'],
    },
    {
        # 结束钮换回假占位 = 真 tidy 没了,⑪-3 必须变红。
        'name': 'I4 结束钮换回假占位（不真 POST tidy）',
        'file': APP,
        'old': "            onClick={() => void tidyCurrentAgent()}",
        'new': "            onClick={() => { alert('整理记忆（占位）'); }}  // 反证注入",
        'expect': ['⑪-3'],
    },
    {
        'name': 'I5 .inputbar 加 display:none（输入栏被藏掉）',
        'file': STYLES,
        'old': ".inputbar {\n  display: flex; align-items: center;\n",
        'new': ".inputbar {\n  display: none;\n  display: flex; align-items: center;\n",
        'expect': ['⑪-4'],
    },
]


def sha256(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def read_raw(path):
    """按**原始字节**读（newline=''），还原时才能逐字节对上。"""
    with open(path, encoding='utf-8', newline='') as f:
        return f.read()


def write_raw(path, text):
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def inject(path, old, new):
    """把 old 换成 new。命中返回 True。"""
    raw = read_raw(path)
    nl = '\r\n' if '\r\n' in raw else '\n'
    norm = raw.replace('\r\n', '\n')
    if old not in norm:
        return False
    patched = norm.replace(old, new, 1)
    if nl != '\n':
        patched = patched.replace('\n', nl)
    write_raw(path, patched)
    return True


def run_shell():
    """跑 verify:shell（真生产代码 + jsdom），返回 (退出码, 变红的断言名列表, PASS 数, 日志路径)。"""
    log = os.path.join(OUTDIR, 'inputbar-revert-last.log')
    with open(log, 'w', encoding='utf-8', errors='replace') as f:
        r = subprocess.run([NODE, TSX_CLI, 'scripts/verify/app-shell-smoke.mts'],
                           cwd=REPO, stdout=f, stderr=subprocess.STDOUT, timeout=900)
    txt = read_raw(log)
    fails = [x.strip() for x in re.findall(r'^\s*✗\s*(.+)$', txt, re.M)]
    npass = len(re.findall(r'^\s*✓', txt, re.M))
    return r.returncode, fails, npass, log


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    print('=' * 78)
    print("反证：把「输入栏」的关键代码改坏 → verify:shell 必须变红 → 立刻还原")
    print('=' * 78)

    # ---- 指纹自检：先确认源码就是"正确的那一版"，否则后面的结论全错 ----
    print('\n[0] 源码指纹自检（防止把上一次中断留下的"已注入"状态当基线）')
    ok_all = True
    for d in DEFECTS:
        txt = read_raw(d['file'])
        hit = d['old'] in txt.replace('\r\n', '\n')
        print('  [%s] 注入锚点在位：%s' % ('PASS' if hit else 'FAIL', d['name']))
        if not hit:
            ok_all = False
    if not ok_all:
        print('  ✗ 锚点不全 —— 源码不是预期状态，先手工检查再跑反证')
        return 2

    orig = {d['file']: read_raw(d['file']) for d in DEFECTS}
    orig_sha = {p: sha256(p) for p in orig}

    results = []
    try:
        for i, d in enumerate(DEFECTS, 1):
            print('\n' + '-' * 78)
            print('[反证 %d/%d] %s' % (i, len(DEFECTS), d['name']))
            print('  注入文件：%s' % os.path.relpath(d['file'], REPO))
            if not inject(d['file'], d['old'], d['new']):
                print('  ✗ 锚点未命中，跳过')
                results.append((d['name'], False, 'anchor miss'))
                continue
            print('  已注入。跑 verify:shell …')
            try:
                rc, fails, npass, log = run_shell()
            finally:
                # ★ 无论跑成什么样，先把文件按**原始字节**还原
                write_raw(d['file'], orig[d['file']])
                back = sha256(d['file'])
                restored = (back == orig_sha[d['file']])
                print('  已还原（sha256 %s）：%s' % (back[:12], '一致 ✔' if restored else '不一致 ✗'))
                if not restored:
                    raise RuntimeError('还原失败，必须人工介入：%s' % d['file'])
            hit = [f for f in fails if any(k in f for k in d['expect'])]
            passed = (rc != 0) and bool(hit)
            print('  退出码 %d / PASS %d / FAIL %d' % (rc, npass, len(fails)))
            print('  期望变红：%s' % d['expect'])
            print('  实际变红：%s' % (fails or '无（仍全绿）'))
            print('  [%s] %s' % ('PASS' if passed else 'FAIL',
                                 '探针成功变红 —— 该断言有效' if passed else '没变红 —— 断言是摆设'))
            print('  日志：%s' % log)
            results.append((d['name'], passed, fails))
    finally:
        for p, t in orig.items():
            write_raw(p, t)
        for p in orig:
            if sha256(p) != orig_sha[p]:
                print('  ✗ 终检：文件未还原，必须人工介入：%s' % p)
                return 2

    print('\n' + '=' * 78)
    bad = [r for r in results if not r[1]]
    if bad:
        print('反证结果：%d/%d 有效 ✗' % (len(results) - len(bad), len(results)))
        for name, _, fails in bad:
            print('  ✗ %s（变红：%s）' % (name, fails or '无'))
        return 1
    print('反证结果：全部 %d 条探针成功变红 ✔ —— 验收断言都是真的' % len(results))
    return 0


if __name__ == '__main__':
    sys.exit(main())
