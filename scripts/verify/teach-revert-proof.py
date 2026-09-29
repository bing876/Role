#!/usr/bin/env python3
"""形态② 教一遍（2026-09-27）· 反证：拆录制闸必红。

「教一遍」的承重墙是**录制**：用户在页上操作一遍 → 动作序列 → 落成一枚枚可回放的
步骤（steps）→ 技能卡 → 之后一句话命中触发条件回放。

往 `recordTeaching` 里注入「拆掉录制闸」—— 动作序列**不再落成 steps** —— 那么：
  · 技能卡没有步骤（录不到东西）；
  · 之后一句话回放，块里没有任何步骤。
行为验收网 `teach-once.mts` 必须当场变红、且命中「动作序列没有落成步骤」这条断言。

用法：python3 scripts/verify/teach-revert-proof.py
"""
from __future__ import annotations

import hashlib
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
NODE = shutil.which('node') or 'node'
TSX_CLI = str(REPO / 'node_modules' / 'tsx' / 'dist' / 'cli.mjs')
SKILLS = REPO / 'apps' / 'server' / 'src' / 'orchestrator' / 'skills.ts'

# 录制闸（动作序列 → 步骤）的原文锚点 —— 必须唯一
ANCHOR = (
    "  // \u2605 \u5f55\u5236\u95f8\uff1a\u52a8\u4f5c\u5e8f\u5217 \u2192 \u6b65\u9aa4\uff08\u4eba\u8bdd\uff09\u3002\u8fd9\u4e00\u6b65\u62c6\u6389 = \u6280\u80fd\u5361\u6ca1\u6709\u6b65\u9aa4 = \u56de\u653e\u4e0d\u51fa\u4e1c\u897f\u3002\n"
    "  const steps = (input.actions ?? [])\n"
    "    .map((a) => {\n"
    "      const detail = a && typeof a.detail === 'string' ? a.detail.trim() : '';\n"
    "      const type = a && typeof a.type === 'string' ? a.type.trim() : '';\n"
    "      if (!detail) return '';\n"
    "      return type ? `${type}\uff1a${detail}` : detail;\n"
    "    })\n"
    "    .filter(Boolean);\n"
)
REPLACE = "  const steps: string[] = []; // \u53cd\u8bc1\u6ce8\u5165\uff1a\u62c6\u6389\u5f55\u5236\u95f8\uff08\u52a8\u4f5c\u5e8f\u5217\u4e0d\u843d\u6210\u6b65\u9aa4\uff09\n"
EXPECT = '动作序列没有落成步骤'


def md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def run_teach_once() -> tuple[int, str]:
    proc = subprocess.run(
        [NODE, TSX_CLI, 'scripts/verify/teach-once.mts'],
        cwd=REPO, capture_output=True, text=True, timeout=900,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    print('=== 先确认基线是绿的（否则反证无意义）===')
    rc, out = run_teach_once()
    m = re.search(r'(\d+) PASS / (\d+) FAIL', out)
    print(f'  基线退出码={rc}  {m.group(0) if m else "（没解析到统计）"}')
    if rc != 0:
        print('★ 基线就是红的，先修基线。')
        print(out[-2000:])
        return 2

    original_bytes = SKILLS.read_bytes()
    original = original_bytes.decode('utf8').replace('\r\n', '\n')
    count = original.count(ANCHOR)
    if count != 1:
        print(f'  ★ 锚点不唯一（{count} 处），反证脚本要跟着改：{SKILLS.name}')
        return 1

    failures = 0
    print('')
    print('--- TK-TEACH 拆掉录制闸：动作序列不再落成 steps（教一遍的反证核心）')
    before = md5(SKILLS)
    try:
        SKILLS.write_text(original.replace(ANCHOR, REPLACE), encoding='utf8', newline='')
        rc, out = run_teach_once()
        stats = re.search(r'(\d+) PASS / (\d+) FAIL', out)
        print(f'  注入后：退出码={rc}  {stats.group(0) if stats else ""}')
        lines = out.splitlines()
        for i, ln in enumerate(lines):
            if ln.strip().startswith('✗'):
                print(f'    {ln.strip()}')
                for nxt in lines[i + 1:i + 3]:
                    if nxt.strip().startswith('✗') or not nxt.strip():
                        break
                    print(f'    {nxt.strip()}')
        if rc == 0:
            print('  ★★ 假绿：拆掉录制闸之后验收网仍然全绿！')
            failures += 1
        elif EXPECT not in out:
            print(f'  ★ 变红了，但没命中期望的断言（期望「{EXPECT}」）')
            failures += 1
        else:
            print(f'  ✓ 变红，且命中「{EXPECT}」')
    finally:
        SKILLS.write_bytes(original_bytes)
        if md5(SKILLS) != before:
            print(f'  ★★ 还原失败，{SKILLS.name} 的 md5 对不上！')
            failures += 1
        else:
            print('  ✓ 已还原，md5 逐字节一致')

    print('')
    print('=== 结论 ===')
    print('  反证通过：拆录制闸必红' if failures == 0 else f'  ★ {failures} 项未通过')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
