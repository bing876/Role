#!/usr/bin/env python3
"""收尾 8 的反证：把 `handoff.ts` 里那三处脱敏**分别**拆掉，验收必须当场红。

  H1 委派文件不再脱敏（`buildHandoffMarkdown` 里的 `safe(...)` 拆掉）
  H2 board 那一行不再脱敏（`appendBoardWithLock` 里的 `safeEntry` 拆回 `entry`）
  H3 追加的进度/结论不再脱敏（`updateHandoffStatus` 里的 `safe(extra)` 拆回 `extra`）

为什么三条都要：它们是三个**独立的落盘口**（委派文件 / board / 追加段落），
任何一个漏了，磁盘上都会留原文 —— 只测一处等于只堵一个洞。

跑法：python3 scripts/verify/handoff-redact-revert-proof.py
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HANDOFF = REPO / 'apps' / 'server' / 'src' / 'orchestrator' / 'handoff.ts'

MUTATIONS = [
    {
        'id': 'H1',
        'name': '委派文件的内容不再脱敏（目标/输入/产出要求/审批边界/名字里带敏感值就原文落盘）',
        'anchor': '${safe(data.goal)}',
        'replace': '${data.goal}',
        'expect': '磁盘上是原文',
    },
    {
        'id': 'H2',
        'name': 'board.md 那一行不再脱敏（用户原话的摘要原文落盘）',
        'anchor': "(current || boardHeader(projectId)) + safeEntry + '\\n'",
        'replace': "(current || boardHeader(projectId)) + entry + '\\n'",
        'expect': 'board.md 里是原文',
    },
    {
        'id': 'H3',
        'name': '追加的进度/结论不再脱敏（子循环报上来的原文落盘）',
        'anchor': '\\n${safe(extra)}\\n',
        'replace': '\\n${extra}\\n',
        'expect': '追加内容里是原文',
    },
]


def run_acceptance() -> tuple[int, str]:
    # ★ 不能用 ['npx', 'tsx', ...]（2026-09-25 修）：Windows 的 CreateProcess 只按 `.exe`
    #   补后缀，**不会**经 PATHEXT 找到 `npx.cmd` ⇒ FileNotFoundError: [WinError 2]，
    #   反证脚本在真跑验收前就崩了（Linux/macOS 一直正常，所以从没暴露）。
    #   改成「node + 本地 tsx CLI」，跨平台且不依赖 PATH 里的 npx。
    tsx_cli = os.path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    node = shutil.which('node') or 'node'
    proc = subprocess.run(
        [node, tsx_cli, 'scripts/verify/handoff-redact.mts'],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=600,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    original = HANDOFF.read_text(encoding='utf8')
    before = hashlib.md5(original.encode('utf8')).hexdigest()
    print('')
    print('=== 收尾 8 · 反证：交接文件脱敏的三道闸，拆一道就得红 ===')
    print(f'（被注入的文件：{HANDOFF.relative_to(REPO)}，注入前 md5 {before[:12]}）')

    caught = 0
    problems: list[str] = []
    for m in MUTATIONS:
        src = HANDOFF.read_text(encoding='utf8')
        if src.count(m['anchor']) != 1:
            problems.append(f"{m['id']} 锚点在源码里出现 {src.count(m['anchor'])} 次（应为 1）—— 反证脚本失效")
            continue
        HANDOFF.write_text(src.replace(m['anchor'], m['replace'], 1), encoding='utf8')
        try:
            code, out = run_acceptance()
        finally:
            HANDOFF.write_text(src, encoding='utf8')
        tail = [ln for ln in out.splitlines() if ln.strip().startswith('✗') or '   ' in ln[:4]]
        hit = m['expect'] in out
        log_hit = hit or any(m['expect'] in ln for ln in tail)
        print('')
        print(f"--- {m['id']} {m['name']}")
        print(f"  注入后：退出码={code}")
        for ln in out.splitlines():
            if ln.strip().startswith('✗'):
                print(f'    {ln.strip()}')
        if code != 0 and hit:
            caught += 1
            print(f"  ✓ 变红，且命中「{m['expect']}」")
        else:
            problems.append(f"{m['id']} 没被咬住（退出码={code}，命中={hit}）")
            print(f"  ★★ 没咬住：退出码={code}，期望命中「{m['expect']}」")
        # 注入必须逐字节还原
        after = hashlib.md5(HANDOFF.read_text(encoding='utf8').encode('utf8')).hexdigest()
        print(f"  ✓ 已还原，md5 {'逐字节一致' if after == before else '★ 不一致 ' + after}")

    print('')
    print('=== 结论 ===')
    print(f'  注入 {len(MUTATIONS)} 个缺陷，被验收抓到 {caught} 个')
    for p in problems:
        print(f'  ★ {p}')
    print(f'  反证失败项：{len(problems)}')
    print('')
    code, out = run_acceptance()
    print(f'  还原后：退出码={code}（应 0）')
    if code != 0:
        problems.append('还原后验收仍然红 —— 源码没还原干净')
        for ln in out.splitlines():
            if ln.strip().startswith('✗'):
                print(f'    {ln.strip()}')
    print(f'  最终反证失败项：{len(problems)}')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
