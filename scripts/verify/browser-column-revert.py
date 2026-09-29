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

STYLES = os.path.join(REPO, 'apps', 'desktop', 'src', 'design', '14-browser-column.css')  # M9'：第四列规则从 styles.css 逐字节搬进 14
APP = os.path.join(REPO, 'apps', 'desktop', 'src', 'App.tsx')
HOOK = os.path.join(REPO, 'apps', 'desktop', 'src', 'app', 'useBrowserColumn.ts')
# 2026-09-26：「真卸载标志」的复位点在 BrowserPanel（页宿主生命周期）
PANEL = os.path.join(REPO, 'apps', 'desktop', 'src', 'browser', 'BrowserPanel.tsx')
# 2026-09-26：create 回执晚于关页的竞态点在 workspace 的 hostMounted（孤儿原生视图）
WORKSPACE = os.path.join(REPO, 'apps', 'desktop', 'src', 'browser', 'useBrowserWorkspace.ts')

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
        # ★ 2026-09-26 加强：C2 原来的注入（只摘 `col.openColumn()`）在 ADR-0005 之后**不再算缺陷**
        # ——「启用」里的 `showFullscreen()` 会把 view 置为 fullscreen，那条 effect 照样把列打开。
        # 所以把注入加强成「启用按钮整体失效（既不切视图也不开列）」，这才对应一条真缺陷。
        'name': 'C2 「🌐 启用」整体失效（触发② 失效：既不切视图也不开列）',
        'file': APP,
        'old': ("            browser.showFullscreen();\n"
                "            col.openColumn();\n"
                "          }}\n"
                '          aria-label="启用浏览器"\n'
                '          title="🌐 启用内嵌浏览器工作台（没有标签页时自动打开主页）"\n'),
        'new': ("            /* 反证注入：启用按钮整体失效（既不切视图也不开列） */\n"
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
    {
        # ADR-0005（2026-09-26，用户报的「浏览器空白」）：摘掉「view→fullscreen ⇒ 列必开」的同步 effect。
        # 期望咬住的正是 ⑧-4b：收起列之后一次「开页」必须把列自动弹回来。
        'name': 'C6 摘掉 ADR-0005 的 view→列同步（页会建好加载，却因层被移出视野而看不见）',
        'file': APP,
        'old': ("  useEffect(() => {\n"
                "    if (browser.view === 'fullscreen') col.openColumn();\n"
                "    // col.openColumn 是稳定引用(useCallback + setState),不参与依赖\n"
                "    // eslint-disable-next-line react-hooks/exhaustive-deps\n"
                "  }, [browser.view]);\n"),
        'new': ("  useEffect(() => {\n"
                "    /* 反证注入：不再把 view→fullscreen 同步到列（ADR-0005 被摘掉） */\n"
                "  }, [browser.view]);\n"),
        'expect': ['⑧-4b'],
    },
    {
        # 2026-09-26：把「依赖变化绝不销毁视图」这条改回去（= 旧 sticky-flag 的实际行为）。
        # 期望咬住 ⑰② 与 ⑥-2：allTabs 一变就把已存在的原生视图销毁 → 页重建、驾驶目标作废。
        'name': 'C7 宿主效果加回 cleanup（allTabs 一变就销毁所有原生视图 —— 真机「指定的内嵌页已不存在」）',
        'file': PANEL,
        'old': ("    hostKeysRef.current = now;\n"
                "    /*\n"
                "     * ★ 这里**故意没有 cleanup**：依赖变化（开页/关页/drivingIds 变）绝不能销毁视图 ——\n"
                "     *   「真卸载才销毁」由上一条「代次 + 微任务」的 effect 独家负责。\n"
                "     */\n"
                "  }, [ws.allTabs, ws.drivingIds]);\n"),
        'new': ("    hostKeysRef.current = now;\n"
                "    /* 反证注入：依赖变化就销毁所有宿主（旧 sticky-flag 的行为） */\n"
                "    return () => {\n"
                "      for (const id of hostKeysRef.current ?? []) ws.hostGone(id);\n"
                "      hostKeysRef.current = new Set<number>();\n"
                "    };\n"
                "  }, [ws.allTabs, ws.drivingIds]);\n"),
        'expect': ['⑰'],
    },
    {
        # 2026-09-26：摘掉「假卸载」判断 → StrictMode 的 setup→cleanup→setup 会把刚建的视图销毁一次。
        # 期望咬住 ⑰①（挂载之后一张视图都不许被销毁）。
        'name': 'C8 摘掉「假卸载」判断（StrictMode 的假卸载也销毁刚建的视图）',
        'file': PANEL,
        'old': "        if (mountGenerationRef.current !== generation) return; // 被重挂取代 = 假卸载\n",
        'new': "        /* 反证注入：不再判断假卸载 */\n",
        'expect': ['⑰'],
    },
    {
        # 2026-09-26：摘掉「回执落地时确认这张页还在」→ create 晚于关页时留下孤儿原生视图。
        # 期望咬住 ⑱。
        'name': 'C9 摘掉「create 回执落地先确认页还在」（晚到的视图不销毁 = 孤儿原生视图）',
        'file': WORKSPACE,
        'old': ("        if (!findTab(t.id)) {\n"
                "          void window.workbench?.browserViewClose?.(t.id);\n"
                "          return;\n"
                "        }\n"),
        'new': "        /* 反证注入：不再确认页还在（晚到的视图不销毁） */\n",
        'expect': ['⑱'],
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
        r = subprocess.run([NODE, TSX_CLI, 'scripts/verify/app-shell-smoke.mts'],
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
