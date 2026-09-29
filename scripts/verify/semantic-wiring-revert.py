#!/usr/bin/env python3
"""抗改版片 · 反证：拆任意一条模型→桌面 mapper，真两版 HTML 行为测试必须红。

与 ADR-0004 的 core 拆级反证互补：旧反证只证明解析器抗改版，本脚本
证明模型提供的 semantic **真的穿过桌面边界**，不是写在纸上的可选类型。
"""
import hashlib
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MAPPER = ROOT / 'apps/desktop/electron/toolExecutors.ts'
NODE = shutil.which('node') or 'node'
CLI = str(ROOT / 'node_modules/tsx/dist/cli.mjs')


def run():
    r = subprocess.run([NODE, CLI, 'scripts/verify/semantic-wiring.mts'], cwd=ROOT,
                       text=True, capture_output=True, timeout=90)
    return r.returncode, r.stdout + r.stderr


def main():
    original = MAPPER.read_bytes()
    rc, out = run()
    assert rc == 0 and 'PASS 12 / FAIL 0' in out, f'基线不绿：{out[-700:]}'
    for name, expected in [('click_semantic', '② click_semantic'), ('type_semantic', '③ type_semantic')]:
        anchor = f"['{name}', (a) =>".encode()
        assert original.count(anchor) == 1, f'{name} mapper 锚点漂移或不唯一'
        try:
            MAPPER.write_bytes(original.replace(anchor, f"['removed_{name}', (a) =>".encode(), 1))
            red_code, red_out = run()
        finally:
            MAPPER.write_bytes(original)
        assert hashlib.sha256(MAPPER.read_bytes()).digest() == hashlib.sha256(original).digest(), '生产源码未按字节还原'
        summary = re.search(r'PASS \d+ / FAIL [1-9]\d*', red_out)
        assert red_code != 0 and summary and f'✗ {expected}' in red_out, f'{name} 拆掉没变红：{red_out[-750:]}'
        print(f'{name} 拔掉 → {summary.group()}，命中 {expected}，原字节还原')
    print('抗改版片反证通过：click/type 映射任意拔一条，真实 HTML 验收立刻红')


if __name__ == '__main__':
    main()
