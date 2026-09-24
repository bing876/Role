#!/usr/bin/env python3
"""批次 K 的反证：把跟进扫的三个机制**分别**拆掉，验收必须当场红。

  K1  委派那一半不扫了（status 条件改成永远不命中）→ "超期未回的交接"无人问津。
  K2  挂起那一半不扫了（resumed_at 条件反掉）→ "长期未恢复的挂起"无人问津。
  K3  幂等条件拆掉（不再看 last_followed_at）→ 同一时刻扫两次就喊两遍（刷屏）。

跑法：python3 scripts/verify/followup-sweep-revert-proof.py
"""
from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FOLLOWUP = REPO / 'apps' / 'server' / 'src' / 'orchestrator' / 'followup.ts'

MUTATIONS = [
    {
        'id': 'K1',
        'name': '委派那一半不扫（超期未回的交接无人问津）',
        'anchor': "        WHERE d.status = 'running'",
        'replace': "        WHERE d.status = 'never-such-status'",
        'expect': '超期未回',
    },
    {
        'id': 'K2',
        'name': '挂起那一半不扫（长期未恢复的挂起无人问津）',
        'anchor': '        WHERE p.resumed_at IS NULL',
        'replace': '        WHERE p.resumed_at IS NOT NULL',
        'expect': '长期未恢复',
    },
    {
        # ★ 把幂等条件改成**恒真**（而不是删行）：删行的话 $2 占位符没了、
        #   参数个数对不上会直接报错 —— 红是红了，但红的不是"幂等"本身。
        #   恒真才真正把"30 分钟内只喊一次"这条拆掉。
        'id': 'K3',
        'name': '幂等条件变成恒真（不再看 last_followed_at → 同一时刻扫两次喊两遍）',
        'anchor': '          AND (d.last_followed_at IS NULL OR d.last_followed_at < $2::timestamptz)\n',
        'replace': '          AND ($2::timestamptz IS NOT NULL OR d.last_followed_at IS NOT NULL)\n',
        'expect': '重复扫不产生任何新提醒',
    },
]


def run_acceptance() -> tuple[int, str]:
    proc = subprocess.run(
        ['npx', 'tsx', 'scripts/verify/followup-sweep.mts'],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=600,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    original = FOLLOWUP.read_text(encoding='utf8')
    before = hashlib.md5(original.encode('utf8')).hexdigest()
    print('')
    print('=== 批次 K · 反证：跟进扫的三个机制，拆一个就得红 ===')

    caught = 0
    problems: list[str] = []
    for m in MUTATIONS:
        src = FOLLOWUP.read_text(encoding='utf8')
        if src.count(m['anchor']) != 1:
            problems.append(f"{m['id']} 锚点在源码里出现 {src.count(m['anchor'])} 次（应为 1）—— 反证脚本失效")
            continue
        FOLLOWUP.write_text(src.replace(m['anchor'], m['replace'], 1), encoding='utf8')
        try:
            code, out = run_acceptance()
        finally:
            FOLLOWUP.write_text(src, encoding='utf8')
        hit = m['expect'] in out
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
        after = hashlib.md5(FOLLOWUP.read_text(encoding='utf8').encode('utf8')).hexdigest()
        print(f"  ✓ 已还原，md5 {'逐字节一致' if after == before else '★ 不一致 ' + after}")

    print('')
    print('=== 结论 ===')
    print(f'  注入 {len(MUTATIONS)} 个缺陷，被验收抓到 {caught} 个')
    for p in problems:
        print(f'  ★ {p}')
    print(f'  反证失败项：{len(problems)}')

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
