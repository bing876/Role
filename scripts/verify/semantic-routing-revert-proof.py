#!/usr/bin/env python3
"""2026-09-26 G3（语义路由）· 反证：把修好的机制**分别**拆掉，验收必须当场红。

  M1  关掉语义层（routeTask 不再调 routeBySemantic）
      → 「我爱喝拿铁」回落字面(0 分)→ 兜底给小助,路由错,红在「method 应为 semantic」。
  M2  高置信阈值抬到 1.01（字面永远不算「高置信」）
      → 强字面句也会去问 LLM,红在「高置信不该问 LLM」（不花钱被破坏）。

跑法：python3 scripts/verify/semantic-routing-revert-proof.py
"""
from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CHIEF = REPO / 'apps' / 'server' / 'src' / 'orchestrator' / 'chiefOfStaff.ts'

MUTATIONS = [
    {
        'id': 'M1',
        'name': '关掉语义层（routeTask 不再调 routeBySemantic）',
        'repls': [
            (
                "    const semantic = await routeBySemantic(task, roster, opts.env);\n",
                "    const semantic = null as RouteDecision | null; // 反证注入：语义层关闭\n",
            ),
        ],
        'expect': 'method 应为 semantic',
    },
    {
        'id': 'M2',
        'name': '高置信阈值抬到 1.01（字面永远不算高置信 → 强字面也问 LLM）',
        'repls': [
            (
                "  if (bestLiteral && literalConfidence >= SEMANTIC_ROUTE_CONFIDENCE) {\n",
                "  if (bestLiteral && literalConfidence >= 1.01) { // 反证注入：阈值抬到不可能\n",
            ),
        ],
        'expect': '高置信不该问 LLM',
    },
]


def main() -> int:
    ok = 0
    for mut in MUTATIONS:
        target = CHIEF
        original = target.read_text(encoding='utf8')
        mutated = original
        for anchor, repl in mut['repls']:
            assert mutated.count(anchor) == 1, f"{mut['id']} 锚点不唯一: {anchor[:60]}"
            mutated = mutated.replace(anchor, repl, 1)
        target.write_text(mutated, encoding='utf8')
        try:
            proc = subprocess.run(
                ['npx', 'tsx', 'scripts/verify/semantic-routing.mts'],
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
