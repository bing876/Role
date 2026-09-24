#!/usr/bin/env python3
"""
阶段 1 · **静态门禁**（把「记得住的规矩」变成「跑不过的门禁」）。

背景：下面这些坑我们都真踩过，而"下次记住"已经失败过一次 —— 所以写死在这里，
由 `npm run verify:gates` 跑（挂在 `npm run verify` 链首），红就是红。

规则
----
R1  `scripts/verify/**` 里**禁止**把 DOM 元素交给断言库
    （`assert.equal` / `deepEqual` / `notEqual` / `strictEqual` / `notStrictEqual` / `notDeepEqual`）。
    失败时 Node 会去 inspect jsdom 的环形巨图 → OOM（退出码 137，连哪条红了都看不到）。
    要比节点请用 `scripts/verify/lib/dom-assert.mts` 的 `sameNode(a, b, msg)`。

R2  **抽出去的 hook 只许有一处生产调用点**（`apps/desktop/src/**`，排除它自己的定义文件）。
    hook 每多一个调用点就多一份独立 state —— 用户在别处点一下，这边不刷新，就是"状态分裂"。
    这一条正是阶段 2 要把胶水翻 Provider 的原因；现在用门禁先把数字钉住。

R3  反证脚本必须**每条缺陷都有 `expect`**（能证明"咬住了"而不是"红了但不知道为什么红"），
    并且**每一片至少有一条 user-visible 断言**（`visible: True`）——
    只让内部函数调用计数变红不算反证（片 3 的假绿就是这么来的）。

用法
----
    python3 scripts/verify/gate-static-rules.py            # 跑全部规则
    python3 scripts/verify/gate-static-rules.py --self-test  # 证明检测器本身有效
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
VERIFY_DIR = REPO / 'scripts' / 'verify'
DESKTOP_SRC = REPO / 'apps' / 'desktop' / 'src'

fails: list[str] = []
checks = 0


def ok(msg: str) -> None:
    global checks
    checks += 1
    print(f'PASS {msg}')


def fail(msg: str) -> None:
    global checks
    checks += 1
    fails.append(msg)
    print(f'FAIL {msg}')


# ---------------------------------------------------------------------------
# 通用：从 `assert.xxx(` 开始按括号配对切出整条调用（可跨行）
# ---------------------------------------------------------------------------
ASSERT_CALL = re.compile(r'assert\s*\.\s*(equal|deepEqual|notEqual|notDeepEqual|strictEqual|notStrictEqual)\s*\(')
DOMISH = [
    (re.compile(r'\bq\s*\('), 'q(...)'),
    (re.compile(r'\bqa\s*\('), 'qa(...)'),
    (re.compile(r'querySelector'), 'querySelector'),
    (re.compile(r'getElementById'), 'getElementById'),
    (re.compile(r'\.documentElement'), '.documentElement'),
    (re.compile(r'createElement'), 'createElement'),
    (re.compile(r'\bdocument\s*\.'), 'document.xxx'),
]
"""
★ 「取值的访问器」白名单：DOM 查询后面跟了这些，说明交出去的是**值**（数字/字符串/布尔），
  不是节点本身 —— 那就不该报（否则 `assert.equal(qa('.x').length, 2)` 这种正常断言会被误伤）。
  例：`.length` / `.textContent` / `.map(…)` / `.getAttribute(…)`。
"""
VALUE_ACCESSOR = re.compile(
    r'^\s*\.\s*(length|textContent|className|tagName|value|checked|id|size|childElementCount|'
    r'getAttribute|hasAttribute|closest|contains|map|join|filter|some|every|find|slice)\b'
)


def statement_at(text: str, start: int) -> str:
    """从 start 处的 '(' 起做括号配对，返回整条调用（含后续到行尾的部分）"""
    depth = 0
    i = start
    while i < len(text):
        c = text[i]
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
            if depth == 0:
                j = text.find('\n', i)
                return text[start : (len(text) if j == -1 else j)]
        i += 1
    j = text.find('\n', start)
    return text[start : (len(text) if j == -1 else j)]


def split_args(stmt: str) -> list[str]:
    """把 `(a, b, msg)` 里的顶层参数按逗号切开（括号与引号都算）"""
    body = stmt.strip()
    if body.startswith('('):
        body = body[1:]
    if body.endswith(')'):
        body = body[:-1]
    args: list[str] = []
    depth = 0
    quote: str | None = None
    cur = ''
    i = 0
    while i < len(body):
        c = body[i]
        if quote:
            cur += c
            if c == '\\':
                cur += body[i + 1] if i + 1 < len(body) else ''
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in '"\'`':
            quote = c
            cur += c
        elif c in '([{':
            depth += 1
            cur += c
        elif c in ')]}':
            depth -= 1
            cur += c
        elif c == ',' and depth == 0:
            args.append(cur)
            cur = ''
        else:
            cur += c
        i += 1
    if cur.strip():
        args.append(cur)
    # 最后一段是消息文本，不属于被比较的值 —— 但为了稳，全部扫一遍也不误伤（消息里的 q( 很少见）
    return args


def domish_in_arg(arg: str) -> str | None:
    """这个参数里有没有"把节点本身交出去"的写法"""
    for rx, label in DOMISH:
        m = rx.search(arg)
        if not m:
            continue
        # 先跨过这次 DOM 查询自己的括号（`qa('.del')`），再看后面跟的是不是"取值"
        rest = arg[m.end() - 1 :]  # 停在 '(' 上
        if rest.startswith('('):
            depth = 0
            i = 0
            while i < len(rest):
                if rest[i] == '(':
                    depth += 1
                elif rest[i] == ')':
                    depth -= 1
                    if depth == 0:
                        rest = rest[i + 1 :]
                        break
                i += 1
        if VALUE_ACCESSOR.search(rest):
            continue  # 取的是值（数字/字符串/数组），不是节点
        return label
    return None


def scan_dom_in_asserts() -> None:
    bad: list[str] = []
    for f in sorted(VERIFY_DIR.rglob('*')):
        if f.suffix not in ('.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx'):
            continue
        text = f.read_text(encoding='utf8')
        # 允许显式豁免：行尾注释 `// dom-assert-exempt: 原因`
        for m in ASSERT_CALL.finditer(text):
            stmt = statement_at(text, m.end() - 1)
            line_no = text[: m.start()].count('\n') + 1
            if 'dom-assert-exempt' in stmt:
                continue
            for arg in split_args(stmt):
                # 跳过消息文案那一段（最后一个参数常常是字符串）
                if arg.strip().startswith(("'", '"', '`')) and 'q(' not in arg:
                    continue
                label = domish_in_arg(arg)
                if label:
                    bad.append(f'{f.relative_to(REPO)}:{line_no} → assert.{m.group(1)}(…{label}…)')
                    break
    if bad:
        for b in bad:
            print(f'  ★ {b}')
        fail(f'R1 {len(bad)} 处把 DOM 元素交给了断言库（要用 lib/dom-assert.mts 的 sameNode）')
    else:
        ok('R1 scripts/verify/** 里没有把 DOM 元素交给断言库')


def scan_single_call_site() -> None:
    hooks = [
        'useBrowserGlue',
        'useKnowledge',
        'useMemory',
        'useProjects',
        'useAuth',
        'useTasks',
        'useChat',
    ]
    problems: list[str] = []
    for hook in hooks:
        call = re.compile(rf'\b{hook}\s*\(')
        hits: list[str] = []
        for f in sorted(DESKTOP_SRC.rglob('*')):
            if f.suffix not in ('.ts', '.tsx'):
                continue
            # 定义文件本身不算调用点
            if f.name.lower().startswith(hook.lower()):
                continue
            text = f.read_text(encoding='utf8')
            for m in call.finditer(text):
                # 跳过 import 语句与纯注释里的提及
                line_start = text.rfind('\n', 0, m.start()) + 1
                line = text[line_start : text.find('\n', m.start())]
                if re.match(r'\s*(//|\*|/\*)', line):
                    continue
                if 'import' in line:
                    continue
                # 定义处不算调用点：`export function useBrowserGlue(...): BrowserGlueApi {`
                if re.search(rf'(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+{hook}\b', line):
                    continue
                hits.append(f'{f.relative_to(REPO)}:{text[: m.start()].count(chr(10)) + 1}')
        if len(hits) > 1:
            problems.append(f'{hook} 有 {len(hits)} 处生产调用点：{", ".join(hits)}')
    if problems:
        for p in problems:
            print(f'  ★ {p}')
        fail('R2 抽出去的 hook 出现了多处生产调用点（会把状态撕成多份）')
    else:
        ok(f'R2 抽出去的 hook（{len(hooks)} 个）在生产代码里都只有 ≤1 处调用点')


def scan_revert_expectations() -> None:
    """直接 import 反证脚本读它的注入表（比正则稳：锚点里本来就有花括号与引号）"""
    import importlib.util

    f = VERIFY_DIR / 'app-logic-smoke-revert.py'
    spec = importlib.util.spec_from_file_location('_revert_mutations', f)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # 有 if __name__ 守卫，exec 不会真跑反证
    entries = list(getattr(mod, 'MUTATIONS', []))
    if not entries:
        fail('R3 反证脚本里读不到注入项（结构变了？）')
        return

    missing = [e.get('id', '?') for e in entries if not e.get('expect')]
    if missing:
        fail(f'R3 有 {len(missing)} 条注入没有 expect（红了也说不清咬住没有）：{missing}')
    else:
        ok(f'R3 反证脚本 {len(entries)} 条注入全部带 expect（能证明"咬住了"）')

    by_slice: dict[str, list[bool]] = {}
    for e in entries:
        m_id = re.match(r'([A-Z]+)\d+$', str(e.get('id', '')))
        if not m_id:
            continue
        by_slice.setdefault(m_id.group(1), []).append(bool(e.get('visible')))
    naked = [k for k, vis in by_slice.items() if not any(vis)]
    if naked:
        fail(f'R3 这些片没有任何 user-visible 注入（只测内部调用计数 = 假绿风险）：{sorted(naked)}')
    else:
        ok(f'R3 每一片都有至少一条 user-visible 注入：{sorted(by_slice)}')


# ---------------------------------------------------------------------------
# 自检：证明检测器真的抓得住（不然它自己就是假绿）
# ---------------------------------------------------------------------------
SELFTEST_SAMPLES = [
    ("assert.equal(q('.helpCard'), null, '人话');", True),
    ("assert.deepEqual(qa('.row'), expected, '人话');", True),
    ("assert.notStrictEqual(doc.getElementById('root'), null);", True),
    ("assert.equal(q('.a'), q('.b'), '人话');", True),
    ("assert.equal(requests.length, 2, '人话');", False),
    ("assert.equal(qa('.del').length, 2, '删除按钮数量不对');", False),
    ("assert.equal(doc.statusCode, 200, 'Fastify inject 的响应');", False),
    ("assert.equal(body.name, '我的新项目', '人话');", False),
    ("assert.match(qa('.x').map((n) => n.textContent).join(','), /a/, '人话');", False),
    ("assert.ok(q('.helpCard') === null, '人话');", False),
    ("sameNode(layer, heldLayer, '人话');", False),
]


def self_test() -> None:
    print('=== 自检：R1 的检测器 ===')
    bad = 0
    for src, should_flag in SELFTEST_SAMPLES:
        m = ASSERT_CALL.search(src)
        got = False
        if m:
            stmt = statement_at(src, m.end() - 1)
            got = any(domish_in_arg(a) for a in split_args(stmt))
        if got != should_flag:
            bad += 1
            print(f'  ✗ 判错：{src} → 期望 {should_flag}，实得 {got}')
    if bad:
        print(f'  ✗ 检测器有 {bad} 条判错 —— 那它守不住任何东西')
        sys.exit(1)
    should = sum(1 for _, s2 in SELFTEST_SAMPLES if s2)
    print(f'  ✓ {len(SELFTEST_SAMPLES)} 条样本全部判对（含 {should} 条该抓、{len(SELFTEST_SAMPLES) - should} 条不该抓）')


def main() -> int:
    if '--self-test' in sys.argv:
        self_test()
        return 0

    print('=== 阶段 1 · 静态门禁（把规矩写成跑得起来的东西）===')
    scan_dom_in_asserts()
    scan_single_call_site()
    scan_revert_expectations()
    print()
    if fails:
        print(f'=== 结论：失败 {len(fails)} 项（共 {checks} 条）===')
        return 1
    print(f'=== 结论：{checks} 条门禁全过 ===')
    return 0


if __name__ == '__main__':
    sys.exit(main())
