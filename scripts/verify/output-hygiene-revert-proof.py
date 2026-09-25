#!/usr/bin/env python3
"""2026-09-25 输出纪律 + 占位符清扫 · 反证：把修好的机制**分别**拆掉，验收必须当场红。

  R1  路由卡改回「system 套路由」旧式 → 正文里嵌套【协同·路由】模板（占位符残留）。
  R2  被拒卡的 fromName 改回 `#${id}` → 卡片里裸 id 当名字。
  R3  例行卡改回「system 套例行」旧式 → 嵌套【协同·例行】模板。
  R4  删掉基座提示词的「输出纪律」段 → system prompt 里没有先结论/过程进卡/没事不说话。
  R5  进展卡改回每步 INSERT 一张 → 3 步委派甩出 3 张同类进展卡（不收敛）。

跑法：python3 scripts/verify/output-hygiene-revert-proof.py
"""
from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CHIEF = REPO / 'apps' / 'server' / 'src' / 'orchestrator' / 'chiefOfStaff.ts'
DELEG = REPO / 'apps' / 'server' / 'src' / 'orchestrator' / 'delegation.ts'
ROUTINES = REPO / 'apps' / 'server' / 'src' / 'orchestrator' / 'routines.ts'
PROMPT = REPO / 'apps' / 'server' / 'src' / 'promptPolicy.ts'

DISCIPLINE_SECTION = """  '输出纪律（简洁、先结论、没事不说话）：',
  '- **先结论**：第一句给结论或结果。做成了说结果，卡住了说「卡在哪 + 需要用户做什么」，',
  '  不先铺垫背景、不先复述用户的话。',
  '- **短句**：默认一轮 1-3 句，每句短。用户要细节会追问，问了再展开；不要一次性铺陈全篇。',
  '- **过程信息不进正文**：走了哪几步、路由给了哪个智能体、派单派给了谁、中间查到什么，',
  '  这些进协同卡/过程记录（系统会自动生成协同卡）；正文只说与用户有关的结论。',
  '  派单之后正文一句「已交给 XX，有结果我告诉你」即可，不要复述任务书、不要预告它要怎么干。',
  '- **一次只报该报的**：不重列已完成步骤、不堆叠上一轮说过的结论、不预告还没发生的事。',
  '- **没事不说话**：本轮没有新结果、没有问题要用户拍板时，最多一句当前状态',
  '  （例如「还在等 XX 的结果」）；不要寒暄、不要重复旧话、不要为了显得在干活而凑字数。',
  '',
"""

MUTATIONS = [
    {
        'id': 'R1',
        'name': '路由卡改回「system 套路由」旧式（嵌套【】模板）',
        'file': CHIEF,
        'repls': [
            ("      kind: 'route',", "      kind: 'system',"),
            (
                "      detail: `${ROUTE_METHOD_LABEL[decision.method] ?? decision.method} → ${decision.toAgentName}：${decision.reason} | 任务：${task.slice(0, 100)}${decision.warning ? ` | 警告：${decision.warning}` : ''}`,",
                "      detail: `【协同·路由】${decision.method} → ${decision.toAgentName}：${decision.reason} | 任务：${task.slice(0, 100)}${decision.warning ? ` | 警告：${decision.warning}` : ''}`,",
            ),
        ],
        'expect': '路由卡应有 1 张',
    },
    {
        'id': 'R2',
        'name': '被拒卡的 fromName 改回 `#${id}`（裸 id 当名字）',
        'file': DELEG,
        'repls': [
            ("      const fromName = nameRow.rows[0]?.name ?? `智能体 ${fromId}`;",
             "      const fromName = `#${fromId}`;"),
        ],
        'expect': '被拒卡应有发起方真名字',
    },
    {
        'id': 'R3',
        'name': '例行卡改回「system 套例行」旧式（嵌套【】模板）',
        'file': ROUTINES,
        'repls': [
            ("      kind: 'routine',", "      kind: 'system',"),
            ("      detail: `${name}：${task.slice(0, 200)}`,",
             "      detail: `【协同·例行】${name} 触发：${task.slice(0, 200)}`,"),
        ],
        'expect': '例行卡前缀不对',
    },
    {
        'id': 'R4',
        'name': '删掉基座提示词的「输出纪律」段（先结论/过程进卡/没事不说话全部失效）',
        'file': PROMPT,
        'repls': [(DISCIPLINE_SECTION, '')],
        'expect': '缺纪律',
    },
    {
        'id': 'R5',
        'name': '进展卡合并路径拆掉（每次都 INSERT 新行 → 同一委派同类卡连发）',
        'file': REPO / 'apps' / 'server' / 'src' / 'orchestrator' / 'collabChat.ts',
        'repls': [
            ("    const prev = progressCardMsgId.get(key);\n    if (prev !== undefined) {",
             "    const prev = progressCardMsgId.get(key);\n    if (false && prev !== undefined) {  // 反证注入：合并路径失效，每次 INSERT 新行"),
        ],
        'expect': '库里应只 1 行（新进展覆盖旧卡）',
    },
]


def main() -> int:
    ok = 0
    for mut in MUTATIONS:
        target: Path = mut['file']
        original = target.read_text(encoding='utf8')
        mutated = original
        for anchor, repl in mut['repls']:
            assert mutated.count(anchor) == 1, f"{mut['id']} 锚点不唯一: {anchor[:60]}"
            mutated = mutated.replace(anchor, repl, 1)
        target.write_text(mutated, encoding='utf8')
        try:
            proc = subprocess.run(
                ['npx', 'tsx', 'scripts/verify/output-hygiene.mts'],
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
