#!/usr/bin/env python3
"""批次 L 片 2 的反证:把"真建"的四个关键机制**分别**拆掉,验收必须当场红。

  C1  名字解析改成"永远拿名册第一个"(偷偷挑别人)→ 名单外的「小王」被建成 routine。
  C2  去重 SQL 的 user 条件改成永远不命中 → 同句发两次建出**两条**。
  C3  成功回话换成「好的。」(不含节奏/任务)→ 回话不再带"设成了什么"。
  C4  解析调用改成永远返回 null → 一句都不建(整条链路死掉)。

跑法:python3 scripts/verify/routine-create-revert-proof.py
"""
from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# ★ Windows 修（2026-09-26）：CreateProcess 只按 `.exe` 补后缀，**不解析 `.cmd`**，
# 而 PATH 上只有 npx.cmd ⇒ `['npx', ...]` 必 FileNotFoundError: [WinError 2]。
# 改成「当前 node + 本地 tsx CLI」，跨平台且不依赖 npx / PATH。
import os as _os
import shutil as _shutil
from pathlib import Path as _Path

_REPO_PATH = _Path(str(REPO))
NODE = _shutil.which('node') or 'node'
TSX_CLI = str(_REPO_PATH / 'node_modules' / 'tsx' / 'dist' / 'cli.mjs')

CORE = REPO / 'apps' / 'server' / 'src' / 'orchestrator' / 'routineCreate.ts'

MUTATIONS = [
    {
        'id': 'C1',
        'name': '名字解析改成"永远拿名册第一个"(偷偷挑别人建)',
        'anchor': '    const hit = roster.find((r) => r.name === intent.agentName);',
        'replace': '    const hit = roster[0];',
        'expect': '没找到叫『小王』的智能体',
    },
    {
        'id': 'C2',
        # ★ 改**值**不改**占位符个数**(`user_id=-1` 会让 $1 错位、参数个数对不上直接炸 ——
        #   那是 SQL 报错的红,不是"去重失效"的红。agent_id=-1 永远查不到,占位符原样保留。)
        'name': '去重 SQL 永远查不到(同句发两次建出两条)',
        'anchor': '      WHERE user_id=$1 AND agent_id=$2 AND trigger_type=$3 AND trigger_config=$4::jsonb',
        'replace': '      WHERE user_id=$1 AND agent_id=$2 AND user_id=-1 AND trigger_type=$3 AND trigger_config=$4::jsonb',
        'expect': '第二遍 = duplicate',
    },
    {
        'id': 'C3',
        'name': '成功回话换成「好的。」(不含节奏/任务)',
        'anchor': "    reply: `已设成:${agentName} ${intent.scheduleLabel} ${intent.taskTemplate},${where}`,",
        'replace': "    reply: '好的。',",
        'expect': '回话带设成了什么',
    },
    {
        'id': 'C4',
        'name': '解析永远返回 null(整条链路死掉,一句都不建)',
        'anchor': '  const intent = parseRoutineIntent(opts.message);',
        'replace': '  const intent = null as ReturnType<typeof parseRoutineIntent>;',
        'expect': '解析成 created',
    },
]


def run_acceptance() -> tuple[int, str]:
    proc = subprocess.run(
        [NODE, TSX_CLI, 'scripts/verify/routine-create.mts'],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=600,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    original_bytes = CORE.read_bytes()
    original = original_bytes.decode('utf8').replace('\r\n', '\n')
    before = hashlib.md5(original.encode('utf8')).hexdigest()
    print('')
    print('=== 批次 L 片 2 · 反证:真建的四个机制,拆一个就得红 ===')

    caught = 0
    problems: list[str] = []
    for m in MUTATIONS:
        src = CORE.read_text(encoding='utf8')
        if src.count(m['anchor']) != 1:
            problems.append(f"{m['id']} 锚点在源码里出现 {src.count(m['anchor'])} 次(应为 1)—— 反证脚本失效")
            continue
        CORE.write_text(src.replace(m['anchor'], m['replace'], 1), encoding='utf8')
        try:
            code, out = run_acceptance()
        finally:
            CORE.write_text(src, encoding='utf8')
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
        after = hashlib.md5(CORE.read_text(encoding='utf8').encode('utf8')).hexdigest()
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
