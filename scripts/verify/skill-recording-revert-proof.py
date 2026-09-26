#!/usr/bin/env python3
"""2026-09-26 G4（技能录制）· 反证：把修好的机制**分别**拆掉，验收必须当场红。

  M1  拆掉录制环（recordTaskAsPendingSkill 一进门就 return null，两个入口都断）
      → 完成的任务库里没有任何技能行、对话流没有确认卡，红在「等 5s 库里没有 pending 技能行」。
  M2  拆掉确认环（录制直接落 active,跳过 pending → confirm）
      → 不确认也进了 active 列表（静默生效,同 memories 口径被破坏），红在「pending 不该出现在列表」。

跑法：python3 scripts/verify/skill-recording-revert-proof.py
"""
from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SKILLS = REPO / 'apps' / 'server' / 'src' / 'orchestrator' / 'skills.ts'

MUTATIONS = [
    {
        'id': 'M1',
        'name': '拆掉录制环（recordTaskAsPendingSkill 一进门就 return null）',
        'repls': [
            (
                "    if (toolStepCount === 0) return null;\n",
                "    return null; // 反证注入：录制环拆掉\n    if (toolStepCount === 0) return null;\n",
            ),
        ],
        'expect': '等 5s 库里没有 pending 技能行',
    },
    {
        'id': 'M2',
        'name': '拆掉确认环（录制直接落 active,不经过 pending → confirm）',
        'repls': [
            (
                "      outputRequirements: input.docTitle,\n      status: 'pending',\n",
                "      outputRequirements: input.docTitle,\n      status: 'active', // 反证注入：跳过确认\n",
            ),
        ],
        'expect': 'pending 不该出现在列表',
    },
]


def main() -> int:
    ok = 0
    for mut in MUTATIONS:
        target = SKILLS
        original = target.read_text(encoding='utf8')
        mutated = original
        for anchor, repl in mut['repls']:
            assert mutated.count(anchor) == 1, f"{mut['id']} 锚点不唯一: {anchor[:60]}"
            mutated = mutated.replace(anchor, repl, 1)
        target.write_text(mutated, encoding='utf8')
        try:
            proc = subprocess.run(
                ['npx', 'tsx', 'scripts/verify/skill-recording.mts'],
                cwd=REPO, capture_output=True, text=True, timeout=600,
            )
        finally:
            target.write_text(original, encoding='utf8')
            assert hashlib.md5(target.read_bytes()).hexdigest() == hashlib.md5(original.encode()).hexdigest(), f"{mut['id']} 还原失败"

        lines = (proc.stdout + proc.stderr).splitlines()
        hit = []
        for i, ln in enumerate(lines):
            if ln.strip().startswith('✗'):
                hit.append(ln.strip())
                for nxt in lines[i + 1:i + 4]:
                    if nxt.strip().startswith('✗') or not nxt.strip():
                        break
                    hit.append(nxt.strip())
        red_ok = proc.returncode != 0
        hit_ok = any(mut['expect'] in h for h in hit)
        good = red_ok and hit_ok
        ok += 1 if good else 0
        print(f"--- {mut['id']} {mut['name']}")
        print(f"  注入后：退出码={proc.returncode}  命中期望断言={'是' if hit_ok else '否'}")
        for h in hit[:6]:
            print(f"    {h}")
        print(f"  {'✓' if good else '✗'} 反证{'成立' if good else '失败（网漏了！）'}\n")
    print(f'=== 反证结论：{ok}/{len(MUTATIONS)} 处拆掉都红 ===')
    return 0 if ok == len(MUTATIONS) else 1


if __name__ == '__main__':
    raise SystemExit(main())
