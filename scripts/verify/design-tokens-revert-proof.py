#!/usr/bin/env python3
"""批次 M-2 · M1' 的反证:把「零视觉改动」拆回旧病,验收必须当场红。

  R1  99-theme 的 .sidebar 规则去掉 .frame 前缀(迁移期直接打中旧白底 sidebar)
      → 红在「列规则全部 scoped 在 .frame 下」。
  R2  main.tsx 重新加回 styles.css 的 import(M9' 收口后旧表已删)→ 红在「零残留」检查。
  R3  design/index.css 删掉 01-tokens 的 @import(令牌层悄悄缺失)→ 红在「严格按序」检查。
  R4  01-tokens 里 --sb-w 250px → 260px(与设计基准偷改一个值)→ 红在「逐字节一致」检查。

跑法:python3 scripts/verify/design-tokens-revert-proof.py
"""
from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
THEME = REPO / 'apps' / 'desktop' / 'src' / 'design' / '99-theme.css'
MAIN = REPO / 'apps' / 'desktop' / 'src' / 'main.tsx'
INDEX = REPO / 'apps' / 'desktop' / 'src' / 'design' / 'index.css'
TOKENS = REPO / 'apps' / 'desktop' / 'src' / 'design' / '01-tokens.css'

MUTATIONS = [
    {
        'id': 'R1',
        'file': THEME,
        'name': '99-theme 的 .sidebar 去掉 .frame 前缀(旧白底 sidebar 被 !important 改色)',
        'anchor': '.frame .sidebar{\n  background:var(--sidebar-bg) !important;',
        'replace': '.sidebar{\n  background:var(--sidebar-bg) !important;',
        'expect': 'scoped 在 .frame 下',
    },
    {
        'id': 'R2',
        'file': MAIN,
        'name': "main.tsx 重新加回 styles.css 的 import(M9' 收口:旧表已整体删除)",
        'anchor': "import './design/index.css';\n",
        'replace': "import './styles.css';\nimport './design/index.css';\n",
        'expect': '还在 import styles.css',
    },
    {
        'id': 'R3',
        'file': INDEX,
        'name': "design/index.css 删掉 01-tokens 的 @import(令牌层悄悄缺失)",
        'anchor': "@import './01-tokens.css';\n",
        'replace': '',
        'expect': '01-tokens',
    },
    {
        'id': 'R4',
        'file': TOKENS,
        'name': '01-tokens 与设计基准偷改一个值(--sb-w 250→260)',
        'anchor': '--sb-w:   250px;',
        'replace': '--sb-w:   260px;',
        'expect': '逐字节一致',
    },
]


def run_tokens() -> tuple[int, str]:
    proc = subprocess.run(
        ['npx', 'tsx', 'scripts/verify/design-tokens.mts'],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=300,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    originals = {m['file']: m['file'].read_text(encoding='utf8') for m in MUTATIONS}
    md5s = {f: hashlib.md5(t.encode('utf8')).hexdigest() for f, t in originals.items()}
    print('')
    print("=== M1' · 反证:「零视觉改动」拆回旧病,验收必须红 ===")

    caught = 0
    problems: list[str] = []
    for m in MUTATIONS:
        src = m['file'].read_text(encoding='utf8')
        if src.count(m['anchor']) != 1:
            problems.append(f"{m['id']} 锚点出现 {src.count(m['anchor'])} 次(应为 1)—— 反证脚本失效")
            continue
        m['file'].write_text(src.replace(m['anchor'], m['replace'], 1), encoding='utf8')
        try:
            code, out = run_tokens()
        finally:
            m['file'].write_text(src, encoding='utf8')
        hit = m['expect'] in out and '✗' in out
        print('')
        print(f"--- {m['id']} {m['name']}")
        print(f"  注入后验收退出码={code}(应非 0)")
        for ln in out.splitlines():
            if ln.strip().startswith('✗'):
                print(f'    {ln.strip()[:150]}')
        if code != 0 and hit:
            caught += 1
            print(f"  ✓ 变红,且命中「{m['expect']}」")
        else:
            problems.append(f"{m['id']} 没被咬住(退出码={code},命中={hit})")
            print(f"  ★★ 没咬住:退出码={code},期望命中「{m['expect']}」")
        after = hashlib.md5(m['file'].read_text(encoding='utf8').encode('utf8')).hexdigest()
        print(f"  ✓ 已还原,md5 {'逐字节一致' if after == md5s[m['file']] else '★ 不一致 ' + after}")

    code, out = run_tokens()
    print('')
    print(f'  还原后验收退出码={code}(应 0)')
    if code != 0:
        problems.append('还原后验收仍红 —— 源码没还原干净')
        for ln in out.splitlines():
            if ln.strip().startswith('✗'):
                print(f'    {ln.strip()}')

    print('')
    print('=== 结论 ===')
    print(f'  注入 {len(MUTATIONS)} 个缺陷,被验收抓到 {caught} 个')
    for p in problems:
        print(f'  ★ {p}')
    print(f'  反证失败项:{len(problems)}')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
