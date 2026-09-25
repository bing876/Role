#!/usr/bin/env python3
"""`App.tsx` 的**行数预算表**：把每一行都归到一个桶里，各桶之和必须 == 总行数。

为什么要有它：收尾验收要报"逻辑还剩多少行"，如果口径混着来（总行 / 有内容行），
数字之间对不上账，就没人能判断这活儿到底干到什么程度了。
所以这里**逐行分类**并当场对账（对不上直接非零退出）。

口径（两套同时给，各自内部一致）：
  · 总行（`splitlines()` 后的行数）
  · 有内容行（去掉空行、去掉 `//` 与 `/* */` 注释行）

分桶：
  imports          模块级 import / export 语句
  module_types     模块级的 type / interface / const / function 的**正文与文档注释**
  other_top        其它模块级块的**声明行**（`App` 之前的顶层 const / function 等）
  app_logic        `export default function App()` 起、到它的 `return (` 之前（含这一行）
  app_jsx          `App` 的 `return (` 起，到 App 结尾
  tail             文件末尾落单的收尾行（`}` 等）

★ 批次 M-8'：`AuthScreen` / `AgentGuide`（带 JSX 的组件）已从 App.tsx 逐字搬进
  `features/auth` / `features/chat`，本脚本**断言它们不再出现在 App.tsx**
  （回归 = 非零退出）。
★ 留在 App 的顶层块都是**纯展示派生**（driveStateView / agentGlyph 等）——
  按用户拍板「跨 feature 协调与纯展示派生留 App」，它们有留因，不算漏抽。

用法：python3 scripts/verify/app-tsx-line-budget.py [--json]
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
APP = REPO / 'apps' / 'desktop' / 'src' / 'App.tsx'
lines = APP.read_text(encoding='utf8').splitlines()

# ---- 先找锚点行号 ----
def find_line(pred, start=0):
    for i in range(start, len(lines)):
        if pred(lines[i]):
            return i
    return -1

app_i = find_line(lambda l: l.startswith('export default function App()'))
assert app_i > 0, app_i

# M8'：带 JSX 的组件不许再住回 App.tsx（回归哨兵）
assert not any(l.startswith('function AuthScreen(') for l in lines), \
    'AuthScreen 又回到 App.tsx 了（M8\' 已把它搬进 features/auth）'
assert not any(l.startswith('function AgentGuide(') for l in lines), \
    'AgentGuide 又回到 App.tsx 了（M8\' 已把它搬进 features/chat）'
assert not any(l.startswith('const SETTINGS_FALLBACK') for l in lines), \
    'SETTINGS_FALLBACK 又回到 App.tsx 了（M8\' 已把它搬进 shared/settings.ts）'

# App 的 return（App 体内，缩进两格的 `  return (`）
app_return_i = find_line(lambda l: l == '  return (', app_i + 1)
# App 函数体结束：从文件末尾往上找第一个顶格的 `}`
app_end_i = len(lines) - 1 - next(i for i, l in enumerate(reversed(lines)) if l == '}')

buckets: dict[str, list[int]] = {
    'imports': [],
    'module_types': [],
    'other_top': [],
    'app_logic': list(range(app_i, min(app_return_i, app_end_i))),  # 到 `return (` 之前（不含）
    'app_jsx': list(range(app_return_i, app_end_i + 1)),
    'tail': list(range(app_end_i + 1, len(lines))),
}

taken = set(buckets['app_logic']) | set(buckets['app_jsx']) | set(buckets['tail'])
for i in range(len(lines)):
    if i in taken:
        continue
    l = lines[i]
    if re.match(r'^(import|export)\b', l) or re.match(r'^(import|export)\s+\{', l) or l.startswith('import ') or l.startswith('} from'):
        buckets['imports'].append(i)
    elif re.match(r'^(type|interface|const|function|async function|class)\b', l):
        buckets['other_top'].append(i)
    else:
        buckets['module_types'].append(i)

def content_counts() -> dict[str, int]:
    """有内容行：非空、且不是 `//` / `/* */` 注释。**单趟扫全文件**（块注释可能跨桶）"""
    out = {k: 0 for k in buckets}
    owner = {}
    for k, idx in buckets.items():
        for i in idx:
            owner[i] = k
    in_block = False
    for i, l in enumerate(lines):
        s = l.strip()
        if not s:
            continue
        if in_block:
            if '*/' in s:
                in_block = False
            continue
        if s.startswith('/*'):
            if '*/' not in s:
                in_block = True
            continue
        if s.startswith('//') or s.startswith('*'):
            continue
        out[owner[i]] += 1
    return out


# 对账：所有行必须**恰好**属于一个桶
all_idx = sorted(i for v in buckets.values() for i in v)
assert all_idx == list(range(len(lines))), (
    '分类没覆盖全部行或重复分类：缺失 '
    + str(sorted(set(range(len(lines))) - set(all_idx))[:10])
    + ' 重复 '
    + str([x for x in set(all_idx) if all_idx.count(x) > 1][:10])
)

cc = content_counts()
rows = []
for k in ['imports', 'module_types', 'other_top', 'app_logic', 'app_jsx', 'tail']:
    idx = buckets[k]
    rows.append({'bucket': k, 'total': len(idx), 'content': cc[k]})

total_sum = sum(r['total'] for r in rows)
content_sum = sum(r['content'] for r in rows)
assert total_sum == len(lines), (total_sum, len(lines))
# 有内容行之和 == 全文有内容行数（同一趟扫描出来的，必然相等；这里只是把不变量写死）
assert content_sum == sum(cc.values())

if '--json' in sys.argv:
    print(json.dumps({'file': str(APP.relative_to(REPO)), 'lines': len(lines), 'rows': rows}, ensure_ascii=False, indent=2))
    sys.exit(0)

w = max(len(r['bucket']) for r in rows)
print(f'=== {APP.relative_to(REPO)} 行数预算（总行 = {len(lines)}）===')
print(f'{"桶".ljust(w)}  {"总行":>6}  {"有内容行":>8}')
for r in rows:
    print(f'{r["bucket"].ljust(w)}  {r["total"]:>6}  {r["content"]:>8}')
print('-' * (w + 18))
print(f'{"合计".ljust(w)}  {total_sum:>6}  {content_sum:>8}')
assert total_sum == len(lines)
print(f'✓ 对账通过：各桶总行之和 {total_sum} == 文件总行 {len(lines)}')
