#!/usr/bin/env python3
"""P1 双反证：禁用让路闸、禁用 CDP 回声标记都必须红，finally 原字节恢复。

只改指定 IF/回声标记，不碰既有 paused 门。不运行 git clean/reset/checkout。
若沙箱被 SIGKILL，先人工核 SHA 与 git diff，绝不在变异源码上提交。
"""
from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DRIVER = ROOT / 'apps/desktop/electron/driver.ts'
MUTATIONS = [
    (
        b'if (userInputRemainingMs(wcId) > 0 && PAUSED_BLOCKED.has(actionName))',
        b'if (false && userInputRemainingMs(wcId) > 0 && PAUSED_BLOCKED.has(actionName))',
        'GATE_NOT_REACHABLE',
        '新闸改成 if (false && ...) 后验收确实红',
    ),
    (
        b'noteAutomatedCdpInput(wc.id, method, commandParams);',
        b'if (false) noteAutomatedCdpInput(wc.id, method, commandParams);',
        'SELF_BLOCKED',
        '禁用 CDP 回声标记后 Q1/Q2 条件性自阻断验收确实红',
    ),
]


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    original = DRIVER.read_bytes()
    expected_hash = digest(original)
    try:
        for before, after, marker, label in MUTATIONS:
            assert original.count(before) == 1, f'拒绝变异：锚点必须恰好有一处：{before[:70]!r}'
            DRIVER.write_bytes(original.replace(before, after, 1))
            run = subprocess.run(
                ['node', 'node_modules/tsx/dist/cli.mjs', 'scripts/verify/p1-user-input-yield.mts'],
                cwd=ROOT, capture_output=True, text=True, timeout=90, check=False,
            )
            output = run.stdout + run.stderr
            assert run.returncode != 0 and marker in output, (
                f'变异后验收没有按 {marker} 变红：\n' + output[-3_000:]
            )
            print(f'  PASS 反证：{label}（{marker}）')
            DRIVER.write_bytes(original)
            assert digest(DRIVER.read_bytes()) == expected_hash, f'{marker} 反证后源码未还原'
    finally:
        DRIVER.write_bytes(original)
        assert digest(DRIVER.read_bytes()) == expected_hash, '反证后源码原字节没有还原！'
        print(f'  PASS 源码还原：driver.ts SHA-256 {expected_hash[:16]}…（原字节一致）')


if __name__ == '__main__':
    main()
