#!/usr/bin/env python3
"""批次 M · 从已入库的构建产物里恢复 / 校验 `workbench-ui/src/data/contacts.ts`。

为什么需要它：
  根 `.gitignore` 第 2 行的 `data/` 是**全局通配**，把 `workbench-ui/src/data/` 整个吞了，
  `contacts.ts` 因此一直加不进版本库（在作者本机存在，但仓库里的 workbench-ui **编译不起来**：
  App.tsx / Sidebar / Rail / InputBar / lib/storage.ts 共 5 处 import 全断）。
  数据本身没丢 —— 它被构建进了 `workbench-ui/dist-single/index.html`（单文件产物，已入库）。

它做两件事：
  1. `extract`：从产物里把 CONTACTS 数组逐字段抽出来打印（JSON）。
  2. `verify`（默认）：把抽出来的字段与 `src/data/contacts.ts` 里的值**逐字段比对**，
     任何一处对不上就退出码 1。

用法：
    python3 scripts/verify/workbench-ui-recover-contacts.py            # 校验
    python3 scripts/verify/workbench-ui-recover-contacts.py --extract  # 只看提取结果
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BUNDLE = REPO / 'workbench-ui' / 'dist-single' / 'index.html'
CONTACTS_TS = REPO / 'workbench-ui' / 'src' / 'data' / 'contacts.ts'

# 产物里的字段顺序/拼写以此为准
FIELDS = ['id', 'name', 'c1', 'c2', 'time', 'preview', 'bindOpenclaw', 'av']


def extract_from_bundle() -> list[dict]:
    html = BUNDLE.read_text(encoding='utf8', errors='ignore')
    i = html.index('{id:"contact-0"')
    start = html.rindex('[', 0, i)
    depth = 0
    end = None
    for j in range(start, len(html)):
        c = html[j]
        if c == '[':
            depth += 1
        elif c == ']':
            depth -= 1
            if depth == 0:
                end = j
                break
    if end is None:
        raise SystemExit('★ 产物里找不到 CONTACTS 数组的结尾括号')
    arr = html[start:end + 1]

    items: list[dict] = []
    for chunk in re.findall(r'\{(.*?)\}(?=,|\])', arr):
        item: dict = {}
        # 字符串字段
        for k in ('id', 'name', 'c1', 'c2', 'time', 'preview'):
            m = re.search(k + r':"([^"]*)"', chunk)
            if m:
                item[k] = m.group(1)
        if 'bindOpenclaw:!0' in chunk:
            item['bindOpenclaw'] = True
        if 'av:' in chunk:
            # 产物里 av 是 Object.keys(...).sort().map(...)[0]，等价于「排序后第一张头像」
            if 'Object.keys(Lo).sort()' in chunk:
                item['av'] = '<FIRST_AVATAR>'
            else:
                item['av'] = '<?>'
        items.append(item)
    return items


def extract_models_from_bundle() -> tuple[list[str], dict[str, str]]:
    """产物里紧跟在 CONTACTS 后面的 `eA=[...]` 与 `tA={...}` 就是 MODELS / MODEL_LABEL。"""
    html = BUNDLE.read_text(encoding='utf8', errors='ignore')
    anchor = html.index('preview:"\u9700\u6c42\u6587\u6863\u6211\u653e\u5230\u5171\u4eab\u76d8\u4e86"')
    seg = html[anchor:anchor + 1200]
    m_models = re.search(r'=\[((?:"[^"]*",?)+)\]', seg)
    if not m_models:
        raise SystemExit('★ 产物里找不到 MODELS 数组')
    models = re.findall(r'"([^"]*)"', m_models.group(1))
    m_label = re.search(r'=\{((?:[a-z]+:"[^"]*",?)+)\}', seg)
    if not m_label:
        raise SystemExit('★ 产物里找不到 MODEL_LABEL 表')
    labels = dict(re.findall(r'([a-z]+):"([^"]*)"', m_label.group(1)))
    return models, labels


def parse_models_ts() -> tuple[list[str], dict[str, str]]:
    src = CONTACTS_TS.read_text(encoding='utf8')
    blk = src[src.index('export const MODELS'):src.index('export const CONTACTS')]
    m_models = re.search(r'MODELS\s*=\s*\[([^\]]*)\]', blk, flags=re.S)
    models = re.findall(r"'([^']*)'", m_models.group(1)) if m_models else []
    m_label = re.search(r'MODEL_LABEL[^=]*=\s*\{([^}]*)\}', blk, flags=re.S)
    labels = dict(re.findall(r"([a-z]+):\s*'([^']*)'", m_label.group(1))) if m_label else {}
    return models, labels


def parse_contacts_ts() -> list[dict]:
    src = CONTACTS_TS.read_text(encoding='utf8')
    body = src[src.index('export const CONTACTS'):]
    items: list[dict] = []
    for chunk in re.findall(r'\{(.*?)\}(?=,|\s*\])', body, flags=re.S):
        item: dict = {}
        for k in ('id', 'name', 'c1', 'c2', 'time', 'preview'):
            m = re.search(k + r":\s*'([^']*)'", chunk)
            if m:
                item[k] = m.group(1)
        if re.search(r'bindOpenclaw:\s*true', chunk):
            item['bindOpenclaw'] = True
        if re.search(r'av:\s*firstAvatar', chunk):
            item['av'] = '<FIRST_AVATAR>'
        items.append(item)
    return items


def main() -> int:
    if not BUNDLE.exists():
        print(f'★ 找不到产物 {BUNDLE}（它是恢复数据的唯一来源）')
        return 2
    if not CONTACTS_TS.exists():
        print(f'★ 找不到 {CONTACTS_TS}')
        return 2

    bundled = extract_from_bundle()
    local = parse_contacts_ts()

    if '--extract' in sys.argv:
        models, labels = extract_models_from_bundle()
        print(json.dumps({'CONTACTS': bundled, 'MODELS': models, 'MODEL_LABEL': labels},
                         ensure_ascii=False, indent=2))
        return 0

    bundle_models, bundle_labels = extract_models_from_bundle()
    local_models, local_labels = parse_models_ts()

    print(f'产物里 {len(bundled)} 条联系人，contacts.ts 里 {len(local)} 条')
    bad = 0
    if len(bundled) != len(local):
        print(f'★ 条数不一致：{len(bundled)} vs {len(local)}')
        bad += 1
    for a, b in zip(bundled, local):
        for f in FIELDS:
            if a.get(f) != b.get(f):
                print(f"★ {a.get('id', '?')} 字段 {f} 不一致：产物={a.get(f)!r} 文件={b.get(f)!r}")
                bad += 1
    if bundle_models != local_models:
        print(f'★ MODELS 不一致：产物={bundle_models} 文件={local_models}')
        bad += 1
    if bundle_labels != local_labels:
        diff = {k: (bundle_labels.get(k), local_labels.get(k))
                for k in set(bundle_labels) | set(local_labels)
                if bundle_labels.get(k) != local_labels.get(k)}
        print(f'★ MODEL_LABEL 不一致：{diff}')
        bad += 1
    print(f'MODELS {len(local_models)} 个、MODEL_LABEL {len(local_labels)} 条已比对')

    if bad:
        print(f'\n★ 共 {bad} 处不一致（若你本机已迭代到更新的一轮，覆盖 contacts.ts 属正常）')
        return 1
    print('\n✓ 逐字段一致：contacts.ts 与已入库产物完全对得上')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
