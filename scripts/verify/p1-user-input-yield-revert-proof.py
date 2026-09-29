#!/usr/bin/env python3
"""P1 反证：禁用真实新闸为 if (false && ...)，验收必须红，finally 原字节恢复。

只改本轮的临时让路 IF，不碰既有 paused 门。不运行 git clean/reset/checkout。
若沙箱被 SIGKILL，先人工核 SHA 与 git diff，绝不在变异源码上提交。
"""
from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DRIVER = ROOT / 'apps/desktop/electron/driver.ts'
BEFORE = b'if (userInputRemainingMs(wcId) > 0 && PAUSED_BLOCKED.has(actionName))'
AFTER = b'if (false && userInputRemainingMs(wcId) > 0 && PAUSED_BLOCKED.has(actionName))'


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    original = DRIVER.read_bytes()
    assert original.count(BEFORE) == 1, '拒绝变异：新闸必须恰好有一处，不能误改旧暂停门'
    expected_hash = digest(original)
    try:
        DRIVER.write_bytes(original.replace(BEFORE, AFTER, 1))
        run = subprocess.run(
            ['node', 'node_modules/tsx/dist/cli.mjs', 'scripts/verify/p1-user-input-yield.mts'],
            cwd=ROOT, capture_output=True, text=True, timeout=90, check=False,
        )
        output = run.stdout + run.stderr
        assert run.returncode != 0 and 'GATE_NOT_REACHABLE' in output, (
            'if (false && ...) 后验收没在 if ( 锚点变红：\n' + output[-3_000:]
        )
        print('  PASS 反证：新闸改成 if (false && ...) 后验收确实红（GATE_NOT_REACHABLE）')
    finally:
        DRIVER.write_bytes(original)
        assert digest(DRIVER.read_bytes()) == expected_hash, '反证后源码原字节没有还原！'
        print(f'  PASS 源码还原：driver.ts SHA-256 {expected_hash[:16]}…（原字节一致）')


if __name__ == '__main__':
    main()
