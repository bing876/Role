#!/usr/bin/env python3
"""片3 反证：拔掉四个原生连接器工具的注册，真协议验收必须红，且原字节还原。"""
import hashlib
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / 'apps/server/src/orchestrator/tools.ts'
ANCHOR = '  registerConnectorTools(next.pool, next.cipher);\n'
NODE = shutil.which('node') or 'node'
TSX = str(ROOT / 'node_modules/tsx/dist/cli.mjs')


def run():
    r = subprocess.run([NODE, TSX, 'scripts/verify/connectors.mts'], cwd=ROOT,
                       text=True, capture_output=True, timeout=180)
    return r.returncode, r.stdout + r.stderr


def main():
    rc, out = run()
    assert rc == 0 and 'PASS 11 / FAIL 0' in out, f'基线不绿：{out[-700:]}'
    before = TOOLS.read_bytes()
    assert before.count(ANCHOR.encode()) == 1, '注册锚点漂移/不唯一'
    try:
        TOOLS.write_bytes(before.replace(ANCHOR.encode(), b'  // revert-proof: connectors disconnected\n', 1))
        red_rc, red_out = run()
    finally:
        TOOLS.write_bytes(before)
    assert hashlib.sha256(before).digest() == hashlib.sha256(TOOLS.read_bytes()).digest(), '未按字节还原'
    summary = re.search(r'PASS \d+ / FAIL \d+', red_out)
    assert red_rc != 0 and summary and not summary.group(0).endswith('FAIL 0'), f'拔掉注册后仍绿：{red_out[-700:]}'
    assert '主循环工具名含 GitHub' in red_out or '没注册进引擎' in red_out, '没有命中生产注册断言'
    print(f'片3 反证通过：基线 PASS 11 / FAIL 0 → 拔注册 {summary.group(0)}（EXIT {red_rc}），原字节还原')


if __name__ == '__main__':
    main()
