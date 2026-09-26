#!/usr/bin/env python3
"""批次 M · M0 冒烟网的**反证**：往真实源码里注入「重构时最可能犯的四种错」，
冒烟网必须每次都变红（退出码非 0 且命中对应断言）。

为什么必须有这一层：
  `verify:shell` 全绿只能证明「现在的结构是那样」，**证明不了它咬得住**。
  如果 golden 被自动重写、或断言写成 `querySelector('webview')` 那种松口径，
  注入错误也会照样绿 —— 那就是假网。这里每种错都对着一条断言：

  R1 `在 BrowserPanel 外面套一层 <div>`            → 祖先链 golden（多一层）
  R2 `把浏览器层挂到 browser.view === 'fullscreen' 上` → 节点身份（切到后台就卸载）
  R3 `给 BrowserPanel 加 key={browser.view}`        → 节点身份（切视图即重建）
  R4 `.browserLayer { display: none }`              → 样式红线（而不是靠 opacity）

每种错的流程：备份 → 断言锚点唯一 → 写入 → 跑 verify:shell → **必须非 0** →
按期望命中断言 → 还原 → md5 逐字节校验。

用法：python3 scripts/verify/app-shell-smoke-revert.py
"""
from __future__ import annotations

import hashlib
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# ★ Windows 修（2026-09-26）：CreateProcess 只按 `.exe` 补后缀，**不解析 `.cmd`**，
# 而 PATH 上只有 npx.cmd ⇒ `['npx', ...]` 必 FileNotFoundError: [WinError 2]。
# 改成「当前 node + 本地 tsx CLI」，跨平台且不依赖 npx / PATH。
import os as _os
import shutil as _shutil
from pathlib import Path as _Path

_REPO_PATH = _Path(str(REPO))
NODE = _shutil.which('node') or 'node'
TSX_CLI = str(_REPO_PATH / 'node_modules' / 'tsx' / 'dist' / 'cli.mjs')

APP = REPO / 'apps' / 'desktop' / 'src' / 'App.tsx'
CSS = REPO / 'apps' / 'desktop' / 'src' / 'design' / '14-browser-column.css'  # M9'：.browserLayer 三态规则从 styles.css 逐字节搬进 14
GOLDEN = REPO / 'docs' / 'acceptance' / 'app-shell' / 'webview-ancestor-chain.golden.json'

BROWSER_PANEL_JSX = """            <BrowserPanel
              ws={browser}
              agentLabel={agents.find((a) => a.id === curAgentId)?.name}
              /*
               * 第 27 步：求助卡模式下的几何（wcId + 那块"窗口"的位置）。
               * 非 embed 态时 wcId 为 null，面板会完全按老逻辑渲染 —— 零影响。
               */
              embed={{ wcId: browser.embedWcId, rect: embedRect }}
            />"""

MUTATIONS = [
    {
        'id': 'R1',
        'name': '在 BrowserPanel 外面套一层 <div>（"顺手加个布局容器"）',
        'file': APP,
        'anchor': BROWSER_PANEL_JSX,
        'replace': '            <div className="mutationWrapper">\n' + BROWSER_PANEL_JSX + '\n            </div>',
        'expect': '祖先链与 golden 一致',
    },
    {
        'id': 'R2',
        'name': '把浏览器层挂到 browser.view === \'fullscreen\' 上（切到后台就卸载）',
        'file': APP,
        'anchor': '      {browser.allTabs.length > 0 && (',
        'replace': "      {browser.allTabs.length > 0 && browser.view === 'fullscreen' && (",
        'expect': '不换 webview 元素',
    },
    {
        'id': 'R3',
        'name': '给 BrowserPanel 加 key={browser.view}（切视图即卸载重建）',
        'file': APP,
        'anchor': BROWSER_PANEL_JSX,
        'replace': BROWSER_PANEL_JSX.replace('            <BrowserPanel\n', '            <BrowserPanel\n              key={browser.view}\n'),
        'expect': '不换 webview 元素',
    },
    {
        'id': 'R4',
        'name': '.browserLayer { display: none }（用 display 而不是 opacity 藏起来）',
        'file': CSS,
        'anchor': '.browserLayer {\n  position: absolute;',
        'replace': '.browserLayer {\n  display: none;\n  position: absolute;',
        'expect': '没有 display:none',
    },
    {
        'id': 'R5',
        'name': '抽掉 06-sidebar.css 里在用的 .agentList__note 规则（搬家时把在用类弄丢）',
        'file': REPO / 'apps' / 'desktop' / 'src' / 'design' / '06-sidebar.css',
        'anchor': '.agentList__note {\n  margin-top: 2px;\n  line-height: 1.45;\n  color: #b45309;\n  word-break: break-word;\n}',
        'replace': '',
        'expect': '零残留审计',
    },
    {
        'id': 'R6',
        'name': "复活 styles.css（M9' 已删,文件级红线）",
        'file': REPO / 'apps' / 'desktop' / 'src' / 'styles.css',
        'materialize_git': 'ac75d63:apps/desktop/src/styles.css',
        'expect': '零残留：styles.css 文件不在场',
    },
]


def md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def judge(rc: int, out: str, mut: dict) -> bool:
    hit = [ln.strip() for ln in out.splitlines() if ln.strip().startswith('✗')]
    stats = re.search(r'(\d+) PASS / (\d+) FAIL', out)
    print(f'  注入后：退出码={rc}  {stats.group(0) if stats else ""}')
    for h in hit[:4]:
        print(f'    {h}')
    if rc == 0:
        print('  ★★ 假绿：注入错误之后冒烟网仍然全绿！')
        return False
    if not any(mut['expect'] in h for h in hit):
        print(f"  ★ 变红了，但不是期望的断言（期望命中「{mut['expect']}」）")
        return False
    print(f"  ✓ 变红，且命中的是「{mut['expect']}」")
    return True


def run_smoke() -> tuple[int, str]:
    proc = subprocess.run(
        [NODE, TSX_CLI, 'scripts/verify/app-shell-smoke.mts'],
        cwd=REPO, capture_output=True, text=True, timeout=600,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    if not GOLDEN.exists():
        print(f'★ golden 不存在（{GOLDEN}）—— 反证会失去意义。先跑 npm run verify:shell -- --update-golden 生成它。')
        return 2

    print('=== 先确认基线是绿的（否则反证无意义）===')
    rc, out = run_smoke()
    m = re.search(r'(\d+) PASS / (\d+) FAIL', out)
    print(f'  基线退出码={rc}  {m.group(0) if m else "（没解析到统计）"}')
    if rc != 0:
        print('★ 基线就是红的，先修基线再来做反证。')
        print(out[-2000:])
        return 2
    golden_before = md5(GOLDEN)

    failures = 0
    for mut in MUTATIONS:
        target: Path = mut['file']
        rel = target.relative_to(REPO)
        print('')
        print(f"--- {mut['id']} {mut['name']}")
        if 'materialize_git' in mut:
            if target.exists():
                print(f'  ★ 目标文件已在场（{rel}）—— 文件级红线只删态才有靶子。')
                failures += 1
                continue
            git_proc = subprocess.run(['git', 'show', mut['materialize_git']],
                                      cwd=REPO, capture_output=True, text=True)
            if git_proc.returncode != 0:
                print(f'  ★ 从 git 物化失败（{mut["materialize_git"]}），反证脚本自身要跟着改。')
                failures += 1
                continue
            try:
                target.write_text(git_proc.stdout, encoding='utf8')
                rc, out = run_smoke()
                if not judge(rc, out, mut):
                    failures += 1
            finally:
                if target.exists():
                    target.unlink()
                if target.exists():
                    print(f'  ★★ 还原失败，{rel} 还在场！')
                    failures += 1
                else:
                    print(f'  ✓ 已还原（文件删除），{rel} 不在场')
            continue
        original_bytes = target.read_bytes()
        original = original_bytes.decode('utf8').replace('\r\n', '\n')
        count = original.count(mut['anchor'])
        if count != 1:
            print(f'  ★ 锚点不唯一（{count} 处），反证脚本自身要跟着改：{rel}')
            failures += 1
            continue
        before = md5(target)
        backup = original
        try:
            target.write_text(original.replace(mut['anchor'], mut['replace']), encoding='utf8', newline='')
            rc, out = run_smoke()
            if not judge(rc, out, mut):
                failures += 1
        finally:
            target.write_text(backup, encoding='utf8')
            if md5(target) != before:
                print(f'  ★★ 还原失败，{rel} 的 md5 对不上！')
                failures += 1
            else:
                print(f'  ✓ 已还原，{rel} md5 逐字节一致')

    print('')
    print('=== 结论 ===')
    print(f'  {len(MUTATIONS) - failures}/{len(MUTATIONS)} 处缺陷被冒烟网咬住')
    if md5(GOLDEN) != golden_before:
        print('  ★★ golden 被反证过程改动了（不该发生）')
        failures += 1
    if failures:
        print(f'  ★ {failures} 项未通过')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
