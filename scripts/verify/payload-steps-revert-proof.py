#!/usr/bin/env python3
"""QA-27 的反证:把"脱敏闸"摘掉,验收必须当场红。

  变异:routes/agent.ts /agent/task/step 的 summary 不再过 scrubStepSummary ——
        敏感值(卡号/身份证/密码)就搭摘要的车明文进 tasks.payload.steps。
  咬住位置(两道都得咬):
    1) payload-steps-audit.mjs  [A2] —— 静态:summary 赋值里没脱敏调用 → 红;
    2) task-encryption-pglite.mts ⑤-B —— 动态:真打 /agent/task/step,
       库里 payload.steps 出现明文 → 红(这道才是最终防线)。

跑法:python3 scripts/verify/payload-steps-revert-proof.py
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

AGENT = REPO / 'apps' / 'server' / 'src' / 'routes' / 'agent.ts'

ANCHOR = "    const summary = typeof b?.summary === 'string' ? scrubStepSummary(b.summary).slice(0, 300) : '';"
MUTATED = "    const summary = typeof b?.summary === 'string' ? String(b.summary).slice(0, 300) : '';"


def run(cmd: list[str], timeout: int = 900) -> tuple[int, str]:
    proc = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=timeout)
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    original_bytes = AGENT.read_bytes()
    original = original_bytes.decode('utf8').replace('\r\n', '\n')
    before = hashlib.md5(original.encode('utf8')).hexdigest()
    print('')
    print('=== QA-27 · 反证:摘掉 task/step 脱敏闸,验收必须红 ===')

    if original.count(ANCHOR) != 1:
        print(f"★★ 锚点出现 {original.count(ANCHOR)} 次(应为 1),反证脚本失效")
        return 1

    AGENT.write_text(original.replace(ANCHOR, MUTATED, 1), encoding='utf8')
    problems: list[str] = []
    try:
        code1, out1 = run(['node', 'scripts/verify/payload-steps-audit.mjs'])
        hit1 = '[A2]' in out1 and '✗' in out1
        print('')
        print(f'--- 静态审计(摘闸后):退出码={code1}(应 1)')
        for ln in out1.splitlines():
            if '✗' in ln or '[A2]' in ln:
                print(f'    {ln}')
        if code1 == 1 and hit1:
            print('  ✓ 审计 [A2] 变红')
        else:
            problems.append(f'静态审计没咬住(code={code1}, hit={hit1})')
            print(f'  ★★ 审计没咬住')

        code2, out2 = run([NODE, TSX_CLI, 'scripts/verify/task-encryption-pglite.mts'], timeout=1200)
        # ⑤-B 六条应红:找含 ⑤-B 的 FAIL 行
        hit2 = '⑤-B' in out2 and ('✗' in out2 or 'FAIL' in out2)
        print('')
        print(f'--- 动态 pglite(摘闸后):退出码={code2}(应非 0)')
        for ln in out2.splitlines():
            if ('⑤-B' in ln or '✗' in ln) and ('FAIL' in ln or '✗' in ln or '⑤-B' in ln):
                print(f'    {ln.strip()[:160]}')
        if code2 != 0 and hit2:
            print('  ✓ ⑤-B 变红(敏感值真的明文进库了,验收当场抓住)')
        else:
            problems.append(f'动态 pglite 没咬住(code={code2}, hit={hit2})')
            print(f'  ★★ 动态 pglite 没咬住')
    finally:
        AGENT.write_bytes(original_bytes)

    after = hashlib.md5(AGENT.read_text(encoding='utf8').encode('utf8')).hexdigest()
    print('')
    print(f'  源码已还原,md5 {"逐字节一致" if after == before else "★ 不一致 " + after}')
    if after != before:
        problems.append('源码没还原干净')

    code1b, _ = run(['node', 'scripts/verify/payload-steps-audit.mjs'])
    code2b, _ = run([NODE, TSX_CLI, 'scripts/verify/task-encryption-pglite.mts'], timeout=1200)
    print(f'  还原后:audit 退出码={code1b}(应 0),pglite 退出码={code2b}(应 0)')
    if code1b != 0 or code2b != 0:
        problems.append('还原后仍红 —— 没还原干净')

    print('')
    print('=== 结论 ===')
    for p in problems:
        print(f'  ★ {p}')
    print(f'  反证失败项:{len(problems)}')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
