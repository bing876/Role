#!/usr/bin/env python3
"""批次 M-7'「其余 CSS + F2-③」反证：把关键代码改坏 → verify:shell / verify:logic 必须变红 → 立刻还原。
S1 是用户点名的回归：**F2-③ 两槽合一**（失败写回成功槽，成功/失败又分不开）；
S5 是 **M9' 零残留**的回归：styles.css 已删,谁让它复活谁当场红。

用法： python3 scripts/verify/css-revert-proof.py
原理： 每条"改坏"都对应验收里的一条断言（⑭-x 或 logic 的 F2-③）。
       注入后跑对应的 verify（真生产代码 + jsdom），
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
OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'app-shell')

FRAME = os.path.join(REPO, 'apps', 'desktop', 'src', 'design', '03-frame.css')
SURFACE = os.path.join(REPO, 'apps', 'desktop', 'src', 'design', '10-surface.css')
STYLES = os.path.join(REPO, 'apps', 'desktop', 'src', 'styles.css')
PROJECTS = os.path.join(REPO, 'apps', 'desktop', 'src', 'features', 'projects', 'useProjects.ts')

# 每条缺陷：名字 / 文件 / 原文 / 改坏后 / 期望变红的断言关键字 / 跑哪套 verify
DEFECTS = [
    {
        # 用户点名的回归:F2-③ 两槽合一（失败写回成功槽）,logic 的 F2-③ 断言必须变红。
        'name': 'S1 F2-③ 打回：切换失败写回成功槽（两槽合一）',
        'file': PROJECTS,
        'old': "      setProjectErr(`⚠ 切换项目没成：${(e as Error).message}`);\n",
        'new': "      setProjectNote(`⚠ 切换项目没成：${(e as Error).message}`);  // 反证注入\n",
        'expect': ['★ F2-③'],
        'run': 'logic',
    },
    {
        # .app 壳规则被从 03-frame.css 删掉（框架没跟组件走）,⑭-1 必须变红。
        'name': 'S2 03-frame.css 的 .app 规则被删',
        'file': FRAME,
        'old': (".app {\n"
                "  display: flex;\n"
                "  height: 100%;\n"
                "}"),
        'new': "/* 反证注入：.app 规则被删掉了 */",
        'expect': ['⑭-1'],
        'run': 'shell',
    },
    {
        # .demoOnly 规则被删（演示行会露出来）,⑭-3 必须变红。
        'name': 'S3 10-surface.css 的 .demoOnly 规则被删（演示行露出）',
        'file': SURFACE,
        'old': (".demoOnly {\n"
                "  display: none;\n"
                "}"),
        'new': "/* 反证注入：.demoOnly 规则被删掉了 */",
        'expect': ['⑭-3'],
        'run': 'shell',
    },
    {
        # 必查后代选择器 .taskResult .buttons-row 被删,⑭-2 必须变红。
        'name': 'S4 必查后代选择器 .taskResult .buttons-row 被删',
        'file': SURFACE,
        'old': (".taskResult .buttons-row {\n"
                "  margin-top: 4px;\n"
                "}"),
        'new': "/* 反证注入：.taskResult .buttons-row 被删掉了 */",
        'expect': ['⑭-2'],
        'run': 'shell',
    },
    {
        # M9' 收口 打回:styles.css 已整体删除,有人把它**复活**并写回旧 .app 规则 → ⑭-1 必须变红。
        # 'create' 模式 = 注入前文件**不存在**（基线就是"已删"）,注入 = 创建,还原 = 删除。
        'name': 'S5 styles.css 被复活且写回旧 .app 规则（M9\' 零残留打回）',
        'file': STYLES,
        'mode': 'create',
        'content': ("/* 反证注入：styles.css 被复活,旧 .app 规则写回来了 */\n"
                    ".app {\n"
                    "  display: flex;\n"
                    "  height: 100%;\n"
                    "}\n"),
        'expect': ['⑭-1'],
        'run': 'shell',
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


def run_verify(which):
    """跑 verify:shell 或 verify:logic，返回 (退出码, 变红的断言名列表, PASS 数, 日志路径)。"""
    script = 'scripts/verify/app-shell-smoke.mts' if which == 'shell' else 'scripts/verify/app-logic-smoke.mts'
    log = os.path.join(OUTDIR, 'css-revert-last-%s.log' % which)
    with open(log, 'w', encoding='utf-8', errors='replace') as f:
        r = subprocess.run(['npx', 'tsx', script],
                           cwd=REPO, stdout=f, stderr=subprocess.STDOUT, timeout=900)
    txt = read_raw(log)
    fails = [x.strip() for x in re.findall(r'^\s*✗\s*(.+)$', txt, re.M)]
    npass = len(re.findall(r'^\s*✓', txt, re.M))
    return r.returncode, fails, npass, log


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    print('=' * 78)
    print("反证：把「其余 CSS + F2-③」的关键代码改坏 → verify 必须变红 → 立刻还原")
    print('=' * 78)

    # ---- 指纹自检：先确认源码就是"正确的那一版"，否则后面的结论全错 ----
    print('\n[0] 源码指纹自检（防止把上一次中断留下的"已注入"状态当基线）')
    ok_all = True
    for d in DEFECTS:
        if d.get('mode') == 'create':
            hit = not os.path.exists(d['file'])
            print('  [%s] 基线在场（文件已删）：%s' % ('PASS' if hit else 'FAIL', d['name']))
        else:
            txt = read_raw(d['file'])
            hit = d['old'] in txt.replace('\r\n', '\n')
            print('  [%s] 注入锚点在位：%s' % ('PASS' if hit else 'FAIL', d['name']))
        if not hit:
            ok_all = False
    if not ok_all:
        print('  ✗ 锚点不全 —— 源码不是预期状态，先手工检查再跑反证')
        return 2

    orig = {}
    for d in DEFECTS:
        if d.get('mode') == 'create':
            orig[d['file']] = None   # 基线 = 文件不存在
        else:
            orig[d['file']] = read_raw(d['file'])
    orig_sha = {p: sha256(p) for p in orig if os.path.exists(p)}

    results = []
    try:
        for i, d in enumerate(DEFECTS, 1):
            print('\n' + '-' * 78)
            print('[反证 %d/%d] %s' % (i, len(DEFECTS), d['name']))
            print('  注入文件：%s' % os.path.relpath(d['file'], REPO))
            if d.get('mode') == 'create':
                write_raw(d['file'], d['content'])
            elif not inject(d['file'], d['old'], d['new']):
                print('  ✗ 锚点未命中，跳过')
                results.append((d['name'], False, 'anchor miss'))
                continue
            print('  已注入。跑 verify:%s …' % d['run'])
            try:
                rc, fails, npass, log = run_verify(d['run'])
            finally:
                # ★ 无论跑成什么样，先把文件还原（create 模式 = 删回不存在）
                if orig[d['file']] is None:
                    if os.path.exists(d['file']):
                        os.remove(d['file'])
                    restored = not os.path.exists(d['file'])
                    print('  已还原（文件已删回）：%s' % ('一致 ✔' if restored else '不一致 ✗'))
                else:
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
            if t is None:
                if os.path.exists(p):
                    os.remove(p)
            else:
                write_raw(p, t)
        for p, t in orig.items():
            if t is None:
                if os.path.exists(p):
                    print('  ✗ 终检：文件未删回，必须人工介入：%s' % p)
                    return 2
            elif sha256(p) != orig_sha[p]:
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
