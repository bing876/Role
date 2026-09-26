#!/usr/bin/env python3
"""形态⑤ 主动汇报（2026-09-27）· 反证：拆主动汇报必红。

「主动汇报」的承重墙是**任务 done 时往项目主会话写一句话**：
任务结束 → 项目主会话多一条「✅ 任务完成：…」→ 用户看到结果。

往 `routes/agent.ts` 里注入「拆掉主动汇报」—— 任务 done 时**不再写消息** —— 那么：
  · 项目主会话没有新消息（汇报没写进去）；
  · 用户看不到任务结果。
行为验收网 `report-once.mts` 必须当场变红、且命中「项目主会话没有新消息」这条断言。

用法：python3 scripts/verify/report-revert-proof.py
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
AGENT = REPO / 'apps' / 'server' / 'src' / 'routes' / 'agent.ts'

# 主动汇报（任务 done → 项目主会话写一句话）的原文锚点 —— 必须唯一
ANCHOR = (
    "        // 形态⑤ 主动汇报（2026-09-27）：任务结束 → 一句话报结果进对话流（不弹通知、不打扰，写进项目主会话）。\n"
    "        void writeCollabToProjectChat(pool, cipher, Number(t.project_id), {\n"
    "          kind: 'system',\n"
    "          fromId: 0,\n"
    "          fromName: '系统',\n"
    "          toId: 0,\n"
    "          toName: '你',\n"
    "          detail: `✅ 任务完成：${taskGoalFromRow(t, cipher).slice(0, 60)}`,\n"
    "        }).catch((err) => console.warn('[agent] 形态⑤ 主动汇报失败（忽略）：', (err as Error).message));\n"
)
REPLACE = "        // 反证注入：拆掉主动汇报（任务 done 不再写消息）\n"
EXPECT = '项目主会话没有新消息'


def md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def run_report_once() -> tuple[int, str]:
    proc = subprocess.run(
        [NODE, TSX_CLI, 'scripts/verify/report-once.mts'],
        cwd=REPO, capture_output=True, text=True, timeout=900,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    print('=== 先确认基线是绿的（否则反证无意义）===')
    rc, out = run_report_once()
    m = re.search(r'(\d+) PASS / (\d+) FAIL', out)
    print(f'  基线退出码={rc}  {m.group(0) if m else "（没解析到统计）"}')
    if rc != 0:
        print('  ✗ 基线不是绿的，反证无意义')
        return 1

    original = AGENT.read_text()
    h0 = md5(AGENT)
    if ANCHOR not in original:
        print('  ✗ 找不到主动汇报锚点（代码可能已改，需更新本脚本）')
        return 1
    assert original.count(ANCHOR) == 1, f'锚点不唯一（{original.count(ANCHOR)} 处）'

    mutated = original.replace(ANCHOR, REPLACE, 1)
    AGENT.write_text(mutated)
    print('\n--- 拆掉主动汇报：任务 done 不再写消息（⑤ 反证核心）---')
    rc2, out2 = run_report_once()
    m2 = re.search(r'(\d+) PASS / (\d+) FAIL', out2)
    print(f'  注入后：退出码={rc2}  {m2.group(0) if m2 else "（没解析到统计）"}')
    hit = EXPECT in out2
    if hit:
        for line in out2.splitlines():
            if EXPECT in line:
                print(f'    {line}')
    AGENT.write_text(original)
    h1 = md5(AGENT)
    restored = h0 == h1
    print(f'  还原 md5 一致={restored}')
    if not restored:
        print('  ✗ 还原失败！')
        return 1

    red = rc2 != 0
    if red and hit and restored:
        print('\n=== 结论 ===')
        print('  ✓ 变红，且命中期望断言')
        print('  反证通过：拆主动汇报必红')
        return 0
    print('\n=== 结论 ===')
    print(f'  ✗ 反证失败：red={red} hit={hit} restored={restored}')
    return 1


if __name__ == '__main__':
    sys.exit(main())
