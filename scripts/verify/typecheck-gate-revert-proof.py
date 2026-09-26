#!/usr/bin/env python3
"""QA-01 的反证:把 chat.ts 的 turnSpeakerId 判空守卫拆掉(还原成把 number|null 直接塞进去),
`verify:typecheck` 必须当场红 —— 且红在 **tsc 编译错误**上,不是接线检查上。

QA 原话:"验收全绿却编译不过,说明这格没盖住,补上。" 这条反证就是钉"这格"。

跑法:python3 scripts/verify/typecheck-gate-revert-proof.py
"""
from __future__ import annotations

import hashlib
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
_NPM = _shutil.which('npm') or 'npm'

CHAT = REPO / 'apps' / 'server' / 'src' / 'routes' / 'chat.ts'

MUTATION = {
    'id': 'T1',
    'name': '拆掉 turnSpeakerId 判空守卫(还原 number|null 直接传)',
    'anchor': '        if (rcProjId !== null && turnSpeakerId !== null) {',
    'replace': '        if (rcProjId !== null) {',
    # tsc 的 TS2322 报错不带属性名(只说 number|null 塞不进 number),
    # 命中条件 = 文件 + 错误码 + 类型串,三样对上才算"红在编译上"。
    'expect_err': "error TS2322: Type 'number | null' is not assignable to type 'number'",
}


def run_gate() -> tuple[int, str]:
    proc = subprocess.run(
        [_NPM, 'run', 'verify:typecheck'],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=600,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    original_bytes = CHAT.read_bytes()
    original = original_bytes.decode('utf8').replace('\r\n', '\n')
    before = hashlib.md5(original.encode('utf8')).hexdigest()
    print('')
    print('=== QA-01 · 反证:拆掉判空守卫,门禁必须红 ===')

    problems: list[str] = []
    m = MUTATION
    src = CHAT.read_text(encoding='utf8')
    if src.count(m['anchor']) != 1:
        problems.append(f"{m['id']} 锚点在源码里出现 {src.count(m['anchor'])} 次(应为 1)—— 反证脚本失效")
    else:
        CHAT.write_text(src.replace(m['anchor'], m['replace'], 1), encoding='utf8')
        try:
            code, out = run_gate()
        finally:
            CHAT.write_text(src, encoding='utf8')
        hit = m['expect_err'] in out and 'routes/chat.ts' in out
        print(f"--- {m['id']} {m['name']}")
        print(f"  注入后 verify:typecheck 退出码={code}(应非 0)")
        for ln in out.splitlines():
            if 'error TS' in ln or '✗' in ln:
                print(f'    {ln.strip()}')
        if code != 0 and hit:
            print(f"  ✓ 变红,且红在编译错误「{m['expect_err']}」上")
        else:
            problems.append(f"{m['id']} 没被咬住(退出码={code},命中编译错误={hit})")
            print(f"  ★★ 没咬住:退出码={code},期望红在「{m['expect_err']}」的 TS2322 上")
        after = hashlib.md5(CHAT.read_text(encoding='utf8').encode('utf8')).hexdigest()
        print(f"  ✓ 已还原,md5 {'逐字节一致' if after == before else '★ 不一致 ' + after}")

    print('')
    print('=== 结论 ===')
    print(f'  反证失败项:{len(problems)}')
    for p in problems:
        print(f'  ★ {p}')

    code, out = run_gate()
    print(f'  还原后 verify:typecheck 退出码={code}(应 0)')
    if code != 0:
        problems.append('还原后门禁仍然红 —— 源码没还原干净')
        for ln in out.splitlines():
            if 'error TS' in ln or '✗' in ln:
                print(f'    {ln.strip()}')
    print(f'  最终反证失败项:{len(problems)}')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
