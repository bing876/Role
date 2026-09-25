#!/usr/bin/env python3
"""批次 L 片 1 的反证:把 routineParser 的三个关键机制**分别**拆掉,验收必须当场红。

  L1a  祈使动词拆掉(DIRECTIVE 换成永不命中的字)→ F1 族整族失效,"让X每天9点做Y"不再建。
  L1b  F2 的任务前缀放宽成任意字(提醒我|帮我|替我|给我 → .{0,3})→ 句首"每天"的闲聊误建
       ("每天早上喝咖啡"会被建成 routine —— 反证②钉的就是这条防线)。
  L1c  问句守卫停用(QUESTION_RE 换成永不命中)→ "怎么让运营助手每天9点检查数据"被建成 routine
       (反证①钉的就是这条防线)。

跑法:python3 scripts/verify/routine-parser-revert-proof.py
"""
from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PARSER = REPO / 'apps' / 'server' / 'src' / 'orchestrator' / 'routineParser.ts'

MUTATIONS = [
    {
        'id': 'L1a',
        'name': '祈使动词拆掉(F1 族失效:"让X每天9点做Y"不再建)',
        'anchor': "const DIRECTIVE = '(?:让|请|叫|安排)';",
        'replace': "const DIRECTIVE = '(?:永|无|此|句)';",
        'expect': '让运营助手每天9点检查店铺数据',
    },
    {
        'id': 'L1b',
        # ★ 用**非捕获**的 (?:.{0,3}) 而不是 (.{0,3}):捕获组会把后面任务组的组号顶掉,
        #   红的就变成"组号错位"而不是"闲聊误建"本身(同一课,见 K3/收尾 9 报告)。
        'name': 'F2 任务前缀放宽成任意字(句首"每天"的闲聊会误建)',
        'anchor': "const F2_PREFIX = '(?:提醒我|帮我|替我|给我)';",
        'replace': "const F2_PREFIX = '(?:.{0,3})';",
        'expect': '每天早上喝咖啡',
    },
    {
        'id': 'L1c',
        # ★ 注意:句子里的问题词必须在祈使锚**之后**("让…可以吗?")——
        #   "怎么让X每天9点…"那种句首问题词本来就被 F1 的句首锚挡掉,拆守卫也不会红。
        'name': '问句守卫停用("让X每天9点检查数据可以吗?"会被建成 routine)',
        'anchor': 'const QUESTION_RE = /(怎么|如何|怎样|为什么|是什么|什么意思|哪些|哪个|能不能|可不可以|行不行|吗)/;',
        'replace': 'const QUESTION_RE = /(永不存在此串)/;',
        'expect': '让运营助手每天9点检查数据可以吗?',
    },
]


def run_acceptance() -> tuple[int, str]:
    proc = subprocess.run(
        ['npx', 'tsx', 'scripts/verify/routine-parser.mts'],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=600,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    original = PARSER.read_text(encoding='utf8')
    before = hashlib.md5(original.encode('utf8')).hexdigest()
    print('')
    print('=== 批次 L 片 1 · 反证:routineParser 的三个机制,拆一个就得红 ===')

    caught = 0
    problems: list[str] = []
    for m in MUTATIONS:
        src = PARSER.read_text(encoding='utf8')
        if src.count(m['anchor']) != 1:
            problems.append(f"{m['id']} 锚点在源码里出现 {src.count(m['anchor'])} 次(应为 1)—— 反证脚本失效")
            continue
        PARSER.write_text(src.replace(m['anchor'], m['replace'], 1), encoding='utf8')
        try:
            code, out = run_acceptance()
        finally:
            PARSER.write_text(src, encoding='utf8')
        hit = m['expect'] in out
        print('')
        print(f"--- {m['id']} {m['name']}")
        print(f"  注入后:退出码={code}")
        for ln in out.splitlines():
            if ln.strip().startswith('✗'):
                print(f'    {ln.strip()}')
        if code != 0 and hit:
            caught += 1
            print(f"  ✓ 变红,且命中「{m['expect']}」")
        else:
            problems.append(f"{m['id']} 没被咬住(退出码={code},命中={hit})")
            print(f"  ★★ 没咬住:退出码={code},期望命中「{m['expect']}」")
        after = hashlib.md5(PARSER.read_text(encoding='utf8').encode('utf8')).hexdigest()
        print(f"  ✓ 已还原,md5 {'逐字节一致' if after == before else '★ 不一致 ' + after}")

    print('')
    print('=== 结论 ===')
    print(f'  注入 {len(MUTATIONS)} 个缺陷,被验收抓到 {caught} 个')
    for p in problems:
        print(f'  ★ {p}')
    print(f'  反证失败项:{len(problems)}')

    code, out = run_acceptance()
    print(f'  还原后:退出码={code}(应 0)')
    if code != 0:
        problems.append('还原后验收仍然红 —— 源码没还原干净')
        for ln in out.splitlines():
            if ln.strip().startswith('✗'):
                print(f'    {ln.strip()}')
    print(f'  最终反证失败项:{len(problems)}')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
