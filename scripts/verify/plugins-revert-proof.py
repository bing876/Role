#!/usr/bin/env python3
"""能力与连接（2026-09-27）· 反证：拔插件必红。

「生成图片接进循环引擎」的承重墙是 **generate_image 注册进服务端工具表**：
注册了 → 主循环的工具名表里有它、执行器在册、模型能调 → 图能落盘并进对话流。

往 `orchestrator/tools.ts` 里注入「拔插件」—— 把 generate_image 的注册拆掉 —— 那么：
  · `serverToolRegistry.get('generate_image')` = undefined（循环调不到它）；
  · 主循环工具名表里也没了它（browserToolNamesFor 查不到就不挂）。
行为验收网 `plugins.mts` 必须当场变红、且命中「generate_image 没注册进服务端工具表」。

用法：python3 scripts/verify/plugins-revert-proof.py
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
TOOLS = REPO / 'apps' / 'server' / 'src' / 'orchestrator' / 'tools.ts'

# generate_image 注册块的原文锚点 —— 必须唯一
ANCHOR = (
    "  registerServerTool(GENERATE_IMAGE_TOOL, {\n"
    "    execute: async (args, ctx) => executeGenerateImageTool(next, ctx, args),\n"
    "  });\n"
)
REPLACE = "  // 反证注入：拔插件 —— generate_image 不再注册（循环调不到它）\n"
EXPECT = 'generate_image 没注册进服务端工具表'


def md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def run_plugins() -> tuple[int, str]:
    proc = subprocess.run(
        [NODE, TSX_CLI, 'scripts/verify/plugins.mts'],
        cwd=REPO, capture_output=True, text=True, timeout=900,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    print('=== 先确认基线是绿的（否则反证无意义）===')
    rc, out = run_plugins()
    m = re.search(r'(\d+) PASS / (\d+) FAIL', out)
    print(f'  基线退出码={rc}  {m.group(0) if m else "（没解析到统计）"}')
    if rc != 0:
        print('  ✗ 基线不是绿的，反证无意义')
        return 1

    original = TOOLS.read_text()
    h0 = md5(TOOLS)
    if ANCHOR not in original:
        print('  ✗ 找不到 generate_image 注册锚点（代码可能已改，需更新本脚本）')
        return 1
    assert original.count(ANCHOR) == 1, f'锚点不唯一（{original.count(ANCHOR)} 处）'

    mutated = original.replace(ANCHOR, REPLACE, 1)
    TOOLS.write_text(mutated)
    print('\n--- 拔插件：generate_image 不再注册（循环调不到它）---')
    rc2, out2 = run_plugins()
    m2 = re.search(r'(\d+) PASS / (\d+) FAIL', out2)
    print(f'  注入后：退出码={rc2}  {m2.group(0) if m2 else "（没解析到统计）"}')
    hit = EXPECT in out2
    if hit:
        for line in out2.splitlines():
            if EXPECT in line:
                print(f'    {line}')
    TOOLS.write_text(original)
    h1 = md5(TOOLS)
    restored = h0 == h1
    print(f'  还原 md5 一致={restored}')
    if not restored:
        print('  ✗ 还原失败！')
        return 1

    red = rc2 != 0
    if red and hit and restored:
        print('\n=== 结论 ===')
        print('  ✓ 变红，且命中期望断言')
        print('  反证通过：拔插件必红')
        return 0
    print('\n=== 结论 ===')
    print(f'  ✗ 反证失败：red={red} hit={hit} restored={restored}')
    return 1


if __name__ == '__main__':
    sys.exit(main())
