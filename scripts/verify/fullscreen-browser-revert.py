#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
第 25 步 · 反证：证明 fullscreen-browser-tests.py 不是摆设。

做法：**临时**把 browser 展示层的关键代码改坏 → 跑验收 → 期望对应断言变红 →
**立刻还原**（用 sha256 校验还原成功）→ 再跑一次确认恢复绿。

★ 为什么可以改真实源码：验收跑的是 vite dev server，读的就是源码本身，
  所以反证必须在真实文件上做（改副本没意义）。因此还原是**强制**的：
  try/finally + sha256 双重保险，任何异常路径都会把文件写回原样。

用法： python scripts/verify/fullscreen-browser-revert.py
"""
import hashlib
import os
import re
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
TESTS = os.path.join(HERE, 'fullscreen-browser-tests.py')
OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'fullscreen-browser')
PY = sys.executable

STYLES = os.path.join(REPO, 'apps', 'desktop', 'src', 'design', '14-browser-column.css')  # M9'：第四列规则从 styles.css 逐字节搬进 14
WS = os.path.join(REPO, 'apps', 'desktop', 'src', 'browser', 'useBrowserWorkspace.ts')
PANEL = os.path.join(REPO, 'apps', 'desktop', 'src', 'browser', 'BrowserPanel.tsx')

# 每个缺陷：名字 / 文件 / 原文 / 改坏后 / 期望变红的断言关键字
DEFECTS = [
    {
        'name': '① 隐藏态改用 display:none（webview 尺寸归零 → 驾驶坐标失效）（批次 M-2:--bg → --hidden）',
        'file': STYLES,
        'old': '.browserLayer--hidden {\n  transform: translateX(calc(100% + 16px));\n  pointer-events: none;\n  z-index: 0;\n  border-left: none;\n}',
        'new': '.browserLayer--hidden {\n  display: none;\n  transform: translateX(calc(100% + 16px));\n  pointer-events: none;\n  z-index: 0;\n  border-left: none;\n}',
        'expect': ['退出后 webview 尺寸', '仍非零尺寸'],
    },
    {
        'name': '② 退出全屏顺手把任务停掉（后台不再继续跑）',
        'file': WS,
        'old': "  const exitFullscreen = (): void => setView('background');",
        'new': ("  const exitFullscreen = (): void => {\n"
                "    setView('background');\n"
                "    void window.workbench?.agentStop?.();  // 反证注入：退出全屏就把任务停了\n"
                "  };"),
        'expect': ['退出全屏后，模型仍被继续提问', '退出全屏后提问次数比退出前多',
                   '任务继续完成了后续真点击'],
    },
    {
        'name': '③ 「启用」点了回不去（重新展开失效）（批次 M-2:小图标 → 启用钮）',
        'file': WS,
        'old': "  const showFullscreen = (): void => setView('fullscreen');",
        'new': ("  const showFullscreen = (): void => {\n"
                "    /* 反证注入：故意不切回全屏 */\n"
                "  };"),
        'expect': ['重新展开后小图标消失', '已回到全屏'],
    },
    {
        # 2026-09-20 加：决定1（「AI 自己开新页不打扰用户」）的反证。
        # 把 setView('fullscreen') 加回 openFromPage = 破坏决定1 ⇒ ㉕㉖ 必须变红。
        'name': '④ AI 自己开新页又把用户拽回全屏（决定1 被破坏）',
        'file': WS,
        'old': ("     *    新页照常有真实尺寸、照样能被驾驶；用户想看自己点右下角小图标。\n"
                "     */\n"
                "  };"),
        'new': ("     *    新页照常有真实尺寸、照样能被驾驶；用户想看自己点右下角小图标。\n"
                "     */\n"
                "    setView('fullscreen');  // 反证注入：又把用户拽回全屏（决定1 被破坏）\n"
                "  };"),
        'expect': ['AI 自己开新页', '小图标仍在'],
    },
    {
        # 2026-09-20 加：决定1 的**另一半** —— 需要用户亲自处理时必须拉回全屏。
        # 把 activate() 里的 setView 拿掉 = 敏感字段等待时用户看不到那张页（连小图标都没得点回去）。
        'name': '⑤ 需要用户亲自处理时也不拉回全屏（敏感等待看不到页面）',
        'file': WS,
        'old': ("     * 三种都属于「需要用户亲自处理」——所以这里继续拉回全屏是对的。\n"
                "     */\n"
                "    setView('fullscreen');"),
        'new': ("     * 三种都属于「需要用户亲自处理」——所以这里继续拉回全屏是对的。\n"
                "     */\n"
                "    /* 反证注入：需要用户亲自处理时也不再拉回全屏 */"),
        'expect': ['敏感字段等待那条通道'],
    },
    {
        # 2026-09-20 加：第 23 步「页里点开链接 → 真开一条 tab」的回归重现。
        # 裸布尔会被 React 18 丢掉 → Chromium 挡掉弹窗 → 主进程 handler 进不去 → 开不出 tab。
        'name': '⑥ allowpopups 改回裸布尔（React 丢属性 → 新开 tab 失效）',
        'file': PANEL,
        'old': "allowpopups={'true' as unknown as boolean}",
        'new': "allowpopups",
        'expect': ['真的新开了一条 tab'],
    },
]


def sha256(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def read_raw(path):
    """★ 必须按**原始字节**读（newline=''）—— 这些源码是 CRLF，
    用默认的通用换行会把 \\r\\n 读成 \\n，写回时就变成 LF 了（踩过：
    还原后 sha256 对不上，git 里整个文件像被重写）。"""
    with open(path, encoding='utf-8', newline='') as f:
        return f.read()


def write_raw(path, text):
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def inject(path, old, new):
    """在保持原行尾的前提下把 old 换成 new。命中返回 True。"""
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


def run_tests(log_name, observe=25):
    env = dict(os.environ, FB_OBSERVE_SECS=str(observe))
    log = os.path.join(OUTDIR, log_name)
    with open(log, 'w', encoding='utf-8', errors='replace') as f:
        r = subprocess.run([PY, '-u', TESTS], cwd=REPO, stdout=f,
                           stderr=subprocess.STDOUT, timeout=1800, env=env)
    txt = read_raw(log)
    fails = [x.strip() for x in re.findall(r'^\s*\[FAIL\]\s*(.+)$', txt, re.M)]
    npass = len(re.findall(r'^\s*\[PASS\]', txt, re.M))
    return r.returncode, fails, npass, log


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    print('=' * 78)
    print('反证：把「后台运行」的关键代码改坏 → 验收必须变红 → 立刻还原')
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
            print('  已注入。跑验收（观察窗口 25 秒）…')
            try:
                rc, fails, npass, log = run_tests('revert-%d.log' % i, observe=25)
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
        # 双保险：再按原始字节还原一次并校验
        for p, t in orig.items():
            if read_raw(p) != t:
                write_raw(p, t)
        for p, s in orig_sha.items():
            assert sha256(p) == s, '源码未还原：%s' % p
        print('\n[还原校验] 全部源文件 sha256 与开工前一致 ✔')

    print('\n' + '=' * 78)
    allok = all(r[1] for r in results)
    for name, passed, info in results:
        print('  %s %s' % ('✔' if passed else '✗', name))
    print('反证结论：' + ('全部缺陷都被抓到 —— 断言有效' if allok else '存在抓不到的缺陷 —— 需补强断言'))
    print('=' * 78)
    return 0 if allok else 1


if __name__ == '__main__':
    sys.exit(main())
