#!/usr/bin/env python3
"""批次 M-6'「模态（登录页/人设引导/人设编辑）」反证：把关键代码改坏 → verify:logic 必须变红 → 立刻还原。
M1 是用户点名的反证：**屏幕上显示真实数据而非写死假数据**（引导确认送写死的假 persona）。

用法： python3 scripts/verify/modal-revert-proof.py
原理： 每条"改坏"都对应验收里的一条断言（⑬-x 或既有的 F5/登录断言）。
       注入后跑 scripts/verify/app-logic-smoke.mts（verify:logic），
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

STYLES = os.path.join(REPO, 'apps', 'desktop', 'src', 'design', '09-modal.css')
APP = os.path.join(REPO, 'apps', 'desktop', 'src', 'App.tsx')
# M8'：引导确认 / 登录按钮随组件外迁（锚点跟组件走）
GUIDE = os.path.join(REPO, 'apps', 'desktop', 'src', 'features', 'chat', 'AgentGuide.tsx')
AUTH = os.path.join(REPO, 'apps', 'desktop', 'src', 'features', 'auth', 'AuthScreen.tsx')

# 每条缺陷：名字 / 文件 / 原文 / 改坏后 / 期望变红的断言关键字
DEFECTS = [
    {
        # 用户点名的反证:引导确认必须把**用户真填的** persona 送服务端 —— 换成写死假值,⑬-2 必须变红。
        'name': 'M1 引导确认送写死的假 persona（不再是用户真填的）',
        'file': GUIDE,
        'old': "onSave({ name: name.trim(), who: who.trim(), tone: tone.trim(), duty: duty.trim() });",
        'new': "onSave({ name: '写死甲', who: '写死乙', tone: '写死丙', duty: '写死丁' } as AgentPersona);  // 反证注入",
        'expect': ['⑬-2'],
    },
    {
        # F4 打回:占位页退回裸 .authWrap（一名两义回归）,⑬-1 必须变红。
        'name': 'M2 F4 打回：占位页退回裸 .authWrap（--checking 没了）',
        'file': APP,
        'old': '<div className="authWrap authWrap--checking">',
        'new': '<div className="authWrap">  // 反证注入:一名两义回归',
        'expect': ['⑬-1'],
    },
    {
        # 编辑浮层 draft 换成写死假值（不再是该智能体的真 persona）,⑬-3 必须变红。
        'name': 'M3 编辑浮层 draft 写死假 persona',
        'file': APP,
        'old': "      who: agent.persona?.who || '',",
        'new': "      who: '假人设（写死）',  // 反证注入",
        'expect': ['⑬-3'],
    },
    {
        # 登录按钮变假（不真发 /auth/login/sms）—— 既有的 F5 重新登录断言必须变红。
        'name': 'M4 登录按钮变假登录（不真发请求）',
        'file': AUTH,
        'old': "onClick={() => void login('/auth/login/sms', { phone: phone.trim(), code })}>",
        'new': "onClick={() => { /* 反证注入:假登录,不发请求 */ }}>",
        'expect': ['F5'],
    },
    {
        # 把 .guide__table th 规则从设计文件里删掉（后代选择器没跟组件走）,⑬-4 必须变红。
        'name': 'M5 .guide__table th 规则被删（后代选择器没跟组件走）',
        'file': STYLES,
        'old': (".guide__table th {\n"
                "  width: 84px;\n"
                "  padding: 4px 8px 4px 0;\n"
                "  text-align: left;\n"
                "  vertical-align: middle;\n"
                "  font-weight: 500;\n"
                "  font-size: 13px;\n"
                "  color: var(--text-weak);\n"
                "}"),
        'new': "/* 反证注入：.guide__table th 规则被删掉了 */",
        'expect': ['⑬-4'],
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


def run_logic():
    """跑 verify:logic（真生产代码 + jsdom），返回 (退出码, 变红的断言名列表, PASS 数, 日志路径)。"""
    log = os.path.join(OUTDIR, 'modal-revert-last.log')
    with open(log, 'w', encoding='utf-8', errors='replace') as f:
        r = subprocess.run(['npx', 'tsx', 'scripts/verify/app-logic-smoke.mts'],
                           cwd=REPO, stdout=f, stderr=subprocess.STDOUT, timeout=900)
    txt = read_raw(log)
    fails = [x.strip() for x in re.findall(r'^\s*✗\s*(.+)$', txt, re.M)]
    npass = len(re.findall(r'^\s*✓', txt, re.M))
    return r.returncode, fails, npass, log


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    print('=' * 78)
    print("反证：把「模态（登录/引导/人设编辑）」的关键代码改坏 → verify:logic 必须变红 → 立刻还原")
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
            print('  已注入。跑 verify:logic …')
            try:
                rc, fails, npass, log = run_logic()
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
