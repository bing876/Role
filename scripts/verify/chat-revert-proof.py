#!/usr/bin/env python3
"""批次 M-5'「聊天区」反证：把关键代码改坏 → verify:shell 必须变红 → 立刻还原。
C1 是用户点名的反证：**屏幕上显示真实数据而非写死假数据**（消息列表写死假气泡）。

用法： python3 scripts/verify/chat-revert-proof.py
原理： 每条"改坏"都对应验收里的一条断言（⑫-x）。
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

STYLES = os.path.join(REPO, 'apps', 'desktop', 'src', 'design', '11-chat-bubbles.css')
APP = os.path.join(REPO, 'apps', 'desktop', 'src', 'App.tsx')

# 每条缺陷：名字 / 文件 / 原文 / 改坏后 / 期望变红的断言关键字
DEFECTS = [
    {
        # 用户点名的反证:消息列表必须接真 history —— 换成写死的假气泡,⑫-1 必须变红。
        'name': 'C1 消息列表换成写死假气泡（不再接 /chat/history）',
        'file': APP,
        'old': "          {messages.map((m, idx) => (",
        'new': ("          {([{ id: -1, role: 'assistant', text: '假气泡甲' }, "
                "{ id: -2, role: 'assistant', text: '假气泡乙' }] as typeof messages).map((m, idx) => (  // 反证注入"),
        'expect': ['⑫-1'],
    },
    {
        # 来源标注换成写死假来源 = 真数据接线被摘,⑫-1 必须变红。
        'name': 'C2 来源标注换成写死假数据',
        'file': APP,
        'old': "                    {m.sources.map((src, si) => (",
        'new': ("                    {([{ title: '假来源甲', url: 'https://fake.example/a', "
                "domain: 'fake.example' }] as ChatSource[]).map((src, si) => (  // 反证注入"),
        'expect': ['⑫-1'],
    },
    {
        # chatNote 的 × 变成假关闭（真 handler 被摘）,⑫-2 必须变红。
        'name': 'C3 chatNote × 变成假关闭',
        'file': APP,
        'old': '<button type="button" className="chatNote__x" aria-label="关闭提示" onClick={() => setChatNote(\'\')}>',
        'new': '<button type="button" className="chatNote__x" aria-label="关闭提示" onClick={() => { /* 反证注入:假关闭 */ }}>',
        'expect': ['⑫-1'],
    },
    {
        # 搜索提示文案写死 = 不再跟 SSE 帧走,⑫-2 必须变红。
        'name': 'C4 搜索提示写死假文案（不跟 SSE 帧）',
        'file': APP,
        'old': ('            <div className="searchHint" role="status" aria-live="polite">\n'
                "              {searchHint}\n"
                "            </div>"),
        'new': ('            <div className="searchHint" role="status" aria-live="polite">\n'
                "              {'假提示：什么都没搜'}  // 反证注入\n"
                "            </div>"),
        'expect': ['⑫-2'],
    },
    {
        # 再制造一次基准里那种 .msg 双定义,⑫-4 的"定义处数=1"必须变红。
        'name': 'C5 .msg 双定义回归（基准 59/139 行那种重定义）',
        'file': STYLES,
        'old': ('.welcomeCard__btn--primary:hover {\n'
                "  background: #1d4ed8;\n"
                "  border-color: #1d4ed8;\n"
                "  color: #ffffff;\n"
                "}"),
        'new': ('.welcomeCard__btn--primary:hover {\n'
                "  background: #1d4ed8;\n"
                "  border-color: #1d4ed8;\n"
                "  color: #ffffff;\n"
                "}\n\n"
                "/* 反证注入：.msg 基础规则第二次定义（双定义回归） */\n"
                ".msg {\n"
                "  background: #cccccc;\n"
                "}"),
        'expect': ['⑫-4'],
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
    log = os.path.join(OUTDIR, 'chat-revert-last.log')
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
    print("反证：把「聊天区」的关键代码改坏 → verify:shell 必须变红 → 立刻还原")
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
