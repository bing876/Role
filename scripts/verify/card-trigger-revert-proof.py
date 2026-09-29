#!/usr/bin/env python3
"""收尾片 ④ · 折叠卡/确认卡「服务端触发口」· 反证。

把两个触发口**分别**拆掉，`card-trigger.mts` 必须当场红（证明验收网不是空过）：

  M1  拆掉折叠卡触发口：`logRouteDecision` 不再把【协同·路由】写进对方会话
      → 「触发口真的写进对方会话：…/chat/history 里出现【协同·路由】」红。
  M2  掏空确认卡触发口：GET /memories 的 pending 槽恒为空
      → 「刷新（GET /memories）：pending 槽里就是那条记忆」红。

跑法：python3 scripts/verify/card-trigger-revert-proof.py
"""
from __future__ import annotations

import hashlib
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
NODE = shutil.which('node') or 'node'
TSX_CLI = str(REPO / 'node_modules' / 'tsx' / 'dist' / 'cli.mjs')

CHIEF = REPO / 'apps' / 'server' / 'src' / 'orchestrator' / 'chiefOfStaff.ts'
MEM = REPO / 'apps' / 'server' / 'src' / 'routes' / 'memories.ts'

MUTATIONS = [
    {
        'id': 'M1',
        'file': CHIEF,
        'name': '拆掉折叠卡触发口：logRouteDecision 不再把【协同·路由】写进对方会话',
        'anchor': (
            "  try {\n"
            "    // kind='route' 自带【协同·路由】前缀；detail 里**不再**重复写前缀（嵌套【】= 占位符残留）\n"
            "    await writeCollabToAgentChat(pool, cipher, decision.toAgentId, {\n"
        ),
        'replace': (
            "  return; // 反证注入：路由触发口被拆掉（不再写【协同·路由】）\n"
            "  try {\n"
            "    // kind='route' 自带【协同·路由】前缀；detail 里**不再**重复写前缀（嵌套【】= 占位符残留）\n"
            "    await writeCollabToAgentChat(pool, cipher, decision.toAgentId, {\n"
        ),
        'expect': '【协同·路由】',
    },
    {
        'id': 'M2',
        'file': MEM,
        'name': '掏空确认卡触发口：GET /memories 的 pending 槽恒为空（刷新后确认卡无料）',
        'anchor': "      const result: MemoryListResult = { active: await fetch('active'), pending: await fetch('pending') };\n",
        'replace': "      const result: MemoryListResult = { active: await fetch('active'), pending: [] }; // 反证注入：pending 槽被掏空\n",
        'expect': 'pending 槽是空的',
    },
]


def main() -> int:
    ok = 0
    for mut in MUTATIONS:
        target: Path = mut['file']
        original_bytes = target.read_bytes()
        original = original_bytes.decode('utf8').replace('\r\n', '\n')
        assert original.count(mut['anchor']) == 1, f"{mut['id']} 锚点不唯一: {mut['anchor'][:60]}"
        target.write_text(original.replace(mut['anchor'], mut['replace'], 1), encoding='utf8', newline='')
        try:
            proc = subprocess.run(
                [NODE, TSX_CLI, 'scripts/verify/card-trigger.mts'],
                cwd=REPO, capture_output=True, text=True, timeout=600,
            )
        finally:
            target.write_bytes(original_bytes)
            assert hashlib.md5(target.read_bytes()).hexdigest() == hashlib.md5(original_bytes).hexdigest(), f"{mut['id']} 还原失败"

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
