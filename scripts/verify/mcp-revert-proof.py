#!/usr/bin/env python3
"""能力与连接 · 片2 · MCP 通用桥 · 反证：拆桥必红。

「MCP 工具接进循环引擎」的承重墙是 **主循环建循环时把该用户的 MCP 工具名拼进工具表**
（`plugins/mcpLoop.ts` 的 `mainLoopToolNamesWithMcp`，被 chat.ts / loop.ts 在建循环前调）。

往 `mcpLoop.ts` 注入「拆桥」—— 让 `mainLoopToolNamesWithMcp` 恒回 `undefined`（循环工具表
不再拼任何 MCP 工具）—— 那么：
  · 该用户明明挂了 server，这一轮工具表里却没有它的 MCP 工具；
  · 行为验收网 `mcp.mts` 的 ④「拼进循环工具表」必须当场变红。

用法：python3 scripts/verify/mcp-revert-proof.py
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
MCPL = REPO / 'apps' / 'server' / 'src' / 'plugins' / 'mcpLoop.ts'

# mcpLoop.ts 里「返回全量工具名」的原文锚点 —— 必须唯一
ANCHOR = "  return mcpNames.length > 0 ? [...browserToolNamesFor(env), ...mcpNames] : undefined;\n"
REPLACE = "  return undefined; // 反证注入：拆桥 —— 循环工具表不再拼任何 MCP 工具\n"
EXPECT = '拼进循环工具表'


def md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def run_mcp() -> tuple[int, str]:
    proc = subprocess.run(
        [NODE, TSX_CLI, 'scripts/verify/mcp.mts'],
        cwd=REPO, capture_output=True, text=True, timeout=900,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    print('=== 先确认基线是绿的（否则反证无意义）===')
    rc, out = run_mcp()
    m = re.search(r'PASS (\d+) / FAIL (\d+)', out)
    print(f'  基线退出码={rc}  {m.group(0) if m else "（没解析到统计）"}')
    if rc != 0:
        print('  ✗ 基线不是绿的，反证无意义')
        return 1

    original = MCPL.read_text()
    h0 = md5(MCPL)
    if ANCHOR not in original:
        print('  ✗ 找不到 mcpLoop 返回值锚点（代码可能已改，需更新本脚本）')
        return 1
    assert original.count(ANCHOR) == 1, f'锚点不唯一（{original.count(ANCHOR)} 处）'

    mutated = original.replace(ANCHOR, REPLACE, 1)
    MCPL.write_text(mutated)
    print('\n--- 拆桥：循环工具表不再拼 MCP 工具（用户挂了 server 也调不到）---')
    try:
        rc2, out2 = run_mcp()
    finally:
        MCPL.write_text(original)
    m2 = re.search(r'PASS (\d+) / FAIL (\d+)', out2)
    print(f'  注入后：退出码={rc2}  {m2.group(0) if m2 else "（没解析到统计）"}')
    hit = EXPECT in out2 and ('✗' in out2)
    if hit:
        for line in out2.splitlines():
            if EXPECT in line and '✗' in line:
                print(f'    {line}')
    h1 = md5(MCPL)
    restored = h0 == h1
    print(f'  还原 md5 一致={restored}')
    if not restored:
        print('  ✗ 还原失败！')
        return 1

    red = rc2 != 0
    if red and hit and restored:
        print('\n=== 结论 ===')
        print('  ✓ 变红，且命中期望断言（④ 拼进循环工具表）')
        print('  反证通过：拆桥必红')
        return 0
    print('\n=== 结论 ===')
    print(f'  ✗ 反证失败：red={red} hit={hit} restored={restored}')
    return 1


if __name__ == '__main__':
    sys.exit(main())
