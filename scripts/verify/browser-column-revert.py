#!/usr/bin/env python3
"""批次 M-2「第四列」反证：把关键代码改坏 → verify:shell 必须变红 → 立刻还原。

用法： python3 scripts/verify/browser-column-revert.py
原理： 每条"改坏"都对应验收里的一条断言（④ golden 或 ⑧-x）。
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
OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'app-shell')
PY = sys.executable

STYLES = os.path.join(REPO, 'apps', 'desktop', 'src', 'design', '14-browser-column.css')  # M9'：第四列规则从 styles.css 逐字节搬进 14
APP = os.path.join(REPO, 'apps', 'desktop', 'src', 'App.tsx')
HOOK = os.path.join(REPO, 'apps', 'desktop', 'src', 'app', 'useBrowserColumn.ts')

# 每条缺陷：名字 / 文件 / 原文 / 改坏后 / 期望变红的断言关键字
DEFECTS = [
    {
        'name': 'C1 隐藏态改用 display:none（webview 尺寸归零 → 驾驶坐标失效）',
        'file': STYLES,
        'old': (".browserLayer--hidden {\n"
                "  transform: translateX(calc(100% + 16px));\n"),
        'new': (".browserLayer--hidden {\n"
                "  display: none;\n"
                "  transform: translateX(calc(100% + 16px));\n"),
        'expect': ['transform 移出视野'],
    },
    {
        'name': 'C2 「🌐 启用」不再弹列（触发② 失效）',
        'file': APP,
        'old': ("            browser.showFullscreen();\n"
                "            col.openColumn();\n"
                "          }}\n"
                '          aria-label="启用浏览器"\n'
                '          title="🌐 启用内嵌浏览器工作台（没有标签页时自动打开主页）"\n'),
        'new': ("            browser.showFullscreen();\n"
                "            /* 反证注入：不再 openColumn —— 点了启用列也不弹 */\n"
                "          }}\n"
                '          aria-label="启用浏览器"\n'
                '          title="🌐 启用内嵌浏览器工作台（没有标签页时自动打开主页）"\n'),
        'expect': ['「💬 对话」→ 隐藏形态'],
    },
    {
        'name': 'C3 覆盖阈值改 Infinity（拖再宽也进不了覆盖形态）',
        'file': HOOK,
        'old': ("export function overlayThresholdPx(frameWidth: number): number {\n"
                "  return Math.max(480, Math.round(frameWidth * 0.6));\n"
                "}"),
        'new': ("export function overlayThresholdPx(frameWidth: number): number {\n"
                "  void frameWidth; // 反证注入：阈值改死，永远进不了覆盖形态\n"
                "  return Infinity;\n"
                "}"),
        'expect': ['过阈值 → 覆盖形态'],
    },
    {
        'name': 'C4 宽度不再写 localStorage（记忆上次宽度失效）',
        'file': HOOK,
        'old': "      localStorage.setItem(BROWSER_COL_STORAGE_KEY, String(colWidth));\n",
        'new': "      /* 反证注入：不再记忆宽度 */\n",
        'expect': ['workbench.browserCol'],
    },
    {
        'name': 'C5 层里给 BrowserPanel 多包一层 div（webview 祖先链被破坏 → golden 必须咬住）',
        'file': APP,
        'old': ("            <BrowserPanel\n"
                "              ws={browser}\n"
                "              agentLabel={agents.find((a) => a.id === curAgentId)?.name}\n"
                "              /*\n"
                "               * 第 27 步：求助卡模式下的几何（wcId + 那块\"窗口\"的位置）。\n"
                "               * 非 embed 态时 wcId 为 null，面板会完全按老逻辑渲染 —— 零影响。\n"
                "               */\n"
                "              embed={{ wcId: browser.embedWcId, rect: embedRect }}\n"
                "            />        </div>\n"),
        'new': ("            <div data-column-revert-mutation>\n"
                "            <BrowserPanel\n"
                "              ws={browser}\n"
                "              agentLabel={agents.find((a) => a.id === curAgentId)?.name}\n"
                "              /*\n"
                "               * 第 27 步：求助卡模式下的几何（wcId + 那块\"窗口\"的位置）。\n"
                "               * 非 embed 态时 wcId 为 null，面板会完全按老逻辑渲染 —— 零影响。\n"
                "               */\n"
                "              embed={{ wcId: browser.embedWcId, rect: embedRect }}\n"
                "            />\n"
                "            </div>\n"
                "        </div>\n"),
        'expect': ['祖先链与 golden 一致'],
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
    log = os.path.join(OUTDIR, 'browser-column-revert-last.log')
    with open(log, 'w', encoding='utf-8', errors='replace') as f:
        r = subprocess.run(['npx', 'tsx', 'scripts/verify/app-shell-smoke.mts'],
                           cwd=REPO, stdout=f, stderr=subprocess.STDOUT, timeout=900)
    txt = read_raw(log)
    fails = [x.strip() for x in re.findall(r'^\s*✗\s*(.+)$', txt, re.M)]
    npass = len(re.findall(r'^\s*✓', txt, re.M))
    return r.returncode, fails, npass, log


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    print('=' * 78)
    print('反证：把「第四列」的关键代码改坏 → verify:shell 必须变红 → 立刻还原')
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
