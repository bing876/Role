#!/usr/bin/env python3
"""真模型反证：拔当前用户配置 / 拔坏密文硬闸，真库+真 llmFetch 上游验收必须红。"""
import hashlib
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LLM = ROOT / 'apps/server/src/llm.ts'
NODE = shutil.which('node') or 'node'
TSX = str(ROOT / 'node_modules/tsx/dist/cli.mjs')
ANCHORS = [
    ("const chosen = setting.kind === 'configured' ? setting.config : null;",
     'const chosen = null; // revert-proof: per-user setting disconnected',
     ('A 与 B 密钥/模型严格隔离', '当前用户配置')),
    ("if (setting.kind === 'invalid') throw new Error('模型配置解密或校验失败，请在设置里重配');",
     "if (setting.kind === 'invalid') { /* revert-proof: corrupt config falls through to env */ }",
     ('坏密文',)),
]


def run():
    r = subprocess.run([NODE, TSX, 'scripts/verify/model-settings.mts'], cwd=ROOT,
                       text=True, capture_output=True, timeout=180)
    return r.returncode, r.stdout + r.stderr


def main():
    baseline, out = run()
    assert baseline == 0 and 'PASS 10 / FAIL 0' in out, f'基线不绿：{out[-1500:]}'
    original = LLM.read_bytes()
    for n, (anchor, replacement, expected) in enumerate(ANCHORS, 1):
        assert original.count(anchor.encode()) == 1, f'第 {n} 个生产锚点漂移/不唯一'
        try:
            LLM.write_bytes(original.replace(anchor.encode(), replacement.encode(), 1))
            red, trace = run()
        finally:
            LLM.write_bytes(original)
        summary = re.search(r'PASS \d+ / FAIL \d+', trace)
        assert red != 0 and summary and not summary.group(0).endswith('FAIL 0'), f'变异 {n} 后仍绿：{trace[-1200:]}'
        assert any(x in trace for x in expected), f'变异 {n} 没命中预期的身份/坏密文断言：{trace[-1200:]}'
        assert hashlib.sha256(original).digest() == hashlib.sha256(LLM.read_bytes()).digest(), '没有原字节还原'
        print(f'模型反证 {n}：基线 10/0 → {summary.group(0)}（EXIT {red}），命中生产断言，原字节还原')
    print('模型接入反证通过：用户模型覆盖或坏密文硬闸任一拔除，验收立即红。')


if __name__ == '__main__':
    main()
