#!/usr/bin/env python3
"""收尾 9 的反证：把修 3 的三个机制**分别**拆掉，真 kill -9 验收必须当场红。

  M1  下发前不再落库（`advance` 里「修 3：下发前先落库 pending_call_id」那一段删掉）
      → kill 之后 checkpoint 里 pending_call_id 是空的 → 恢复时"还欠一个回执"这件事丢了。
  M2  恢复时不读回 pendingCallId（`checkpointToSession` 里那行改成恒 null）
      → 喂回结果时落一条 `call_<step>` 兜底的**孤儿**回执（assistant.tool_calls 对不上）。
  M3  executed_tool_ids 列重新被工具名污染（两处一起打回去：`startLoop` 不再初始化空数组
      + `saveCheckpoint` 恢复 `?? usedTools` 兜底）→ 列里存 'open_url' 而不是 call id，
      重启后 `executed.includes(callId)` 永远比不中（跨重启去重形同虚设）。

为什么 M3 要两处一起拆：收尾 9 的修复本身是双保险（startLoop 初始化 + saveCheckpoint 不再兜底，
两个单独都在时列都是干净的）—— 只拆一处测不出缺陷，这不是测试写错了，是修复的防御深度
本来就是两层；反证必须把这一层**整体**打回去才打得红。

跑法：python3 scripts/verify/loop-kill9-revert-proof.py
"""
from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOLLOOP = REPO / 'apps' / 'server' / 'src' / 'toolLoop.ts'
CHECKPOINT = REPO / 'apps' / 'server' / 'src' / 'orchestrator' / 'checkpoint.ts'

MUTATIONS = [
    {
        'id': 'M1',
        'name': '下发前不再落库 pending_call_id（kill 后"还欠一个回执"这件事丢了）',
        'patches': [
            (
                TOOLLOOP,
                """    // 修 3：下发前先落库 pending_call_id，kill 后重启可去重
    if (checkpointPool && checkpointSave) {
      try {
        void (checkpointSave as any)(checkpointPool, session, checkpointCipher);
      } catch {}
    }
""",
                "    // M1 打回去：下发前不落库\n",
            ),
        ],
        'expect': 'pending_call_id 已落库',
    },
    {
        'id': 'M2',
        'name': '恢复时不读回 pendingCallId（喂回结果落成孤儿回执，tool_call_id 对不上）',
        'patches': [
            (
                CHECKPOINT,
                '    pendingCallId: row.pending_call_id ?? null,',
                '    pendingCallId: null, // M2 打回去：恢复时不读 pending',
            ),
        ],
        'expect': 'receipt-mismatch',
    },
    {
        'id': 'M3',
        'name': 'executed_tool_ids 列重新被工具名污染（两处一起打回去 → 重启后去重比不中）',
        'patches': [
            (
                TOOLLOOP,
                """    /**
     * ★ 收尾 9（2026-09-25 验收抓到的修 3 缺陷）：这里**必须**初始化成空数组。
     *   原来没有这一行 → 第一次「下发前落库」时 `executedToolIds` 是 undefined，
     *   `saveCheckpoint` 就走了 `?? usedTools` 的兜底，把**工具名**（open_url…）写进了
     *   `executed_tool_ids` 列 —— 而重启后的去重比对的是 **call id**，名字永远比不中，
     *   去重在"跨重启"这条路上形同虚设（本进程的内存里是对的，一重启就废）。
     */
    executedToolIds: [],
""",
                "",
            ),
            (
                CHECKPOINT,
                "    const executedIds = Array.isArray((session as any).executedToolIds) ? (session as any).executedToolIds : [];",
                "    const executedIds = (session as any).executedToolIds ?? (session as any).usedTools ?? [];",
            ),
        ],
        'expect': 'call id',
    },
]


def run_acceptance() -> tuple[int, str]:
    proc = subprocess.run(
        ['node', 'scripts/verify/loop-kill9-db.mjs'],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=600,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    originals = {p: p.read_text(encoding='utf8') for p in (TOOLLOOP, CHECKPOINT)}
    mds = {p.name: hashlib.md5(v.encode('utf8')).hexdigest() for p, v in originals.items()}
    print('')
    print('=== 收尾 9 · 反证：修 3 的三个机制，拆一个就得红 ===')

    caught = 0
    problems: list[str] = []
    for m in MUTATIONS:
        # 应用全部 patch（每个锚点必须唯一）
        applied = []
        ok = True
        for f, anchor, replace in m['patches']:
            src = f.read_text(encoding='utf8')
            if src.count(anchor) != 1:
                problems.append(f"{m['id']} 锚点在 {f.name} 出现 {src.count(anchor)} 次（应为 1）—— 反证脚本失效")
                ok = False
                break
            f.write_text(src.replace(anchor, replace, 1), encoding='utf8')
            applied.append(f)
        if not ok:
            continue
        try:
            code, out = run_acceptance()
        finally:
            for f in applied:
                f.write_text(originals[f], encoding='utf8')
        fail_lines = [ln for ln in out.splitlines() if ln.startswith('FAIL')]
        hit = m['expect'] in out
        print('')
        print(f"--- {m['id']} {m['name']}")
        print(f"  注入后：退出码={code}")
        for ln in fail_lines[:4]:
            print(f'    {ln}')
        if code != 0 and hit:
            caught += 1
            print(f"  ✓ 变红，且命中「{m['expect']}」")
        else:
            problems.append(f"{m['id']} 没被咬住（退出码={code}，命中={hit}）")
            print(f"  ★★ 没咬住：退出码={code}，期望命中「{m['expect']}」")
        for p in applied:
            after = hashlib.md5(p.read_text(encoding='utf8').encode('utf8')).hexdigest()
            print(f"  ✓ 已还原 {p.name}，md5 {'逐字节一致' if after == mds[p.name] else '★ 不一致'}")

    print('')
    print('=== 结论 ===')
    print(f'  注入 {len(MUTATIONS)} 个缺陷，被验收抓到 {caught} 个')
    for p in problems:
        print(f'  ★ {p}')
    print(f'  反证失败项：{len(problems)}')

    code, out = run_acceptance()
    print(f'  还原后：退出码={code}（应 0）')
    if code != 0:
        problems.append('还原后验收仍然红 —— 源码没还原干净')
        for ln in out.splitlines():
            if ln.startswith('FAIL'):
                print(f'    {ln}')
    print(f'  最终反证失败项：{len(problems)}')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
