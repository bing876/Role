#!/usr/bin/env python3
"""批次 M · 前端结构重构 —— 结构普查工具（**侦查用，不是验收闸**）。

它只做一件事：把 App.tsx / styles.css 的现状数字**可复跑地**打出来，
让《docs/批次M-前端结构重构-侦查报告.md》里的每个数字都能被独立重算。

为什么不写成断言式验收：这些数字（行数、类名数、死规则数）在重构过程中
**本来就应该变**，把它们钉成闸只会在每一片都误报。真正的闸在 M0 的
scripts/verify/app-shell-smoke.mts（webview 宿主与三列）。

用法：
    python3 scripts/verify/frontend-inventory.py
    python3 scripts/verify/frontend-inventory.py --json     # 给别的脚本消费
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / 'apps' / 'desktop' / 'src'
APP = SRC / 'App.tsx'
STYLES = SRC / 'styles.css'
BROWSER_STYLES = SRC / 'browser' / 'styles.css'
CHANNELS_STYLES = SRC / 'channels' / 'styles.css'

# 会被 Tailwind preflight 重置默认样式的元素（App.tsx 里若出现就要逐个看）
PREFLIGHT_SENSITIVE = [
    'p', 'ul', 'ol', 'li', 'img', 'svg', 'a', 'hr', 'textarea', 'code', 'pre',
    'small', 'b', 'strong', 'em', 'sub', 'sup', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'th', 'td', 'button', 'input', 'select',
]


def read(p: Path) -> str:
    return p.read_text(encoding='utf8')


def lines_of(p: Path) -> int:
    return read(p).count('\n') + 1


def strip_comments(css: str) -> str:
    return re.sub(r'/\*.*?\*/', '', css, flags=re.S)


def rules(css_path: Path) -> list[tuple[str, str]]:
    """返回 [(选择器, 声明块原文)]，跳过 @ 规则。"""
    out = []
    for m in re.finditer(r'(?m)^([^@\n{}][^{}]*?)\{([^}]*)\}', strip_comments(read(css_path))):
        out.append((' '.join(m.group(1).split()), ' '.join(m.group(2).split())))
    return out


def tags(src: str, name: str) -> list[tuple[int, str]]:
    """多行感知地抓 <name ...> 标签（含花括号属性），返回 (行号, 标签原文)。"""
    out = []
    for m in re.finditer(r'<' + name + r'\b', src):
        i = m.end()
        depth = 0
        j = i
        while j < len(src):
            c = src[j]
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
            elif c == '>' and depth == 0:
                break
            j += 1
        out.append((src[:m.start()].count('\n') + 1, src[m.start():j + 1]))
    return out


def css_classes(selector: str) -> list[str]:
    return re.findall(r'\.([A-Za-z][\w-]*)', selector)


def main() -> int:
    app = read(APP)
    all_src = '\n'.join(
        read(p) for p in SRC.rglob('*.ts*') if 'node_modules' not in str(p)
    )

    data: dict = {'files': {}, 'hooks': {}, 'elements': {}, 'classes': {}, 'css': {}}

    for label, p in [
        ('App.tsx', APP), ('styles.css', STYLES),
        ('browser/styles.css', BROWSER_STYLES), ('channels/styles.css', CHANNELS_STYLES),
    ]:
        data['files'][label] = lines_of(p)

    # ---- hook 普查（按组件分段；M8' 后 AuthScreen/AgentGuide 已搬进 features/）----
    def fn_span(text: str, head: str) -> tuple[int, int]:
        """顶格 `function <head>(` 起到第一个顶格 `}`，返回 (起, 止) 1-based 行号。"""
        ln_ = text.split('\n')
        a = next(i for i, l in enumerate(ln_) if l.startswith(head))
        b = next(i for i in range(a + 1, len(ln_)) if ln_[i] == '}')
        return a + 1, b + 1

    auth_ln = read(SRC / 'features' / 'auth' / 'AuthScreen.tsx').split('\n')
    guide_ln = read(SRC / 'features' / 'chat' / 'AgentGuide.tsx').split('\n')
    a_a, a_b = fn_span('\n'.join(auth_ln), 'export function AuthScreen(')
    g_a, g_b = fn_span('\n'.join(guide_ln), 'export function AgentGuide(')
    app_a, app_b = fn_span(app, 'export default function App()')
    regions = {
        'AuthScreen': ('features/auth/AuthScreen.tsx', a_a, a_b),
        'AgentGuide': ('features/chat/AgentGuide.tsx', g_a, g_b),
        'App': ('App.tsx', app_a, app_b),
    }
    for name, (fname, a, b) in regions.items():
        seg = '\n'.join(read(SRC / fname if fname != 'App.tsx' else APP).split('\n')[a - 1:b])
        data['hooks'][name] = {
            'file': fname,
            'useState': len(re.findall(r'useState[<(]', seg)),
            'useRef': len(re.findall(r'useRef[<(]', seg)),
            'useEffect': len(re.findall(r'useEffect\(', seg)),
            'useCallback': len(re.findall(r'useCallback\(', seg)),
            'useMemo': len(re.findall(r'useMemo\(', seg)),
        }
    # App 的 JSX 占比：从 App 段里第一个缩进两格的 `  return (` 开始
    jsx_from = next(
        i + 1 for i in range(app_a - 1, app_b) if app.split('\n')[i].startswith('  return (')
    )
    data['hooks']['App']['logic_lines'] = jsx_from - app_a
    data['hooks']['App']['jsx_lines'] = app_b - jsx_from + 1

    # ---- 元素普查（含裸元素 = 没有 className 也没有内联 style）----
    for name in PREFLIGHT_SENSITIVE:
        found = tags(app, name)
        if not found:
            data['elements'][name] = 0
            continue
        naked = [line for line, t in found if 'className' not in t and 'style=' not in t]
        data['elements'][name] = {'total': len(found), 'naked': len(naked), 'naked_lines': naked}

    # ---- className ↔ styles.css ----
    static = sorted(set(re.findall(r'className="([^"]+)"', app)))
    exprs = re.findall(r'className=\{([^}]*)\}', app)
    tokens: set[str] = set()
    for s in static:
        tokens.update(s.split())
    for e in exprs:
        for lit in re.findall(r"'([^']+)'", e) + re.findall(r'"([^"]+)"', e):
            tokens.update(x for x in lit.split() if re.match(r'^[a-zA-Z][\w-]*$', x))
    defined = set(css_classes(' '.join(r[0] for r in rules(STYLES))))
    data['classes'] = {
        'className_attrs': len(re.findall(r'className\s*=', app)),
        'static_strings': len(static),
        'expr_attrs': len(exprs),
        'distinct_tokens': len(tokens),
        'tokens_with_css': len(tokens & defined),
        'hook_only_tokens': sorted(tokens - defined),
    }

    # ---- CSS 结构 + 死规则 ----
    each = {}
    for label, p in [('styles.css', STYLES), ('browser/styles.css', BROWSER_STYLES),
                     ('channels/styles.css', CHANNELS_STYLES)]:
        rs = rules(p)
        each[label] = {
            'lines': lines_of(p),
            'rules': len(rs),
            'media': len(re.findall(r'@media', read(p))),
            'keyframes': len(re.findall(r'@keyframes', read(p))),
            'important': len(re.findall(r'!important', read(p))),
            'custom_props': sorted(set(re.findall(r'(--[\w-]+)\s*:', read(p)))),
        }
    dead = []
    for sel, _body in rules(STYLES):
        cls = css_classes(sel)
        if cls and not any(re.search(r'\b' + re.escape(c) + r'\b', all_src) for c in cls):
            dead.append(sel)
    each['styles.css']['dead_selectors'] = dead
    each['styles.css']['dead_count'] = len(dead)

    def sel_set(p: Path) -> set[str]:
        return {s for s, _ in rules(p) if s.startswith('.')}

    each['overlap'] = {
        'styles.css ∩ browser/styles.css': sorted(sel_set(STYLES) & sel_set(BROWSER_STYLES)),
        'styles.css ∩ channels/styles.css': sorted(sel_set(STYLES) & sel_set(CHANNELS_STYLES)),
        'browser ∩ channels': sorted(sel_set(BROWSER_STYLES) & sel_set(CHANNELS_STYLES)),
    }
    data['css'] = each

    # ---- webview 宿主的祖先链锚点（M0 的 golden 会钉这个）----
    chain = []
    for line_no in (2873, 3204, 3310, 3357):
        if line_no <= lines_of(APP):
            txt = ln[line_no - 1].strip()
            chain.append({'line': line_no, 'text': txt[:80]})
    data['webview_host_anchors'] = {
        'app_chain': chain,
        'browserpanel_inner': [
            {'file': 'browser/BrowserPanel.tsx', 'line': n, 'text': t}
            for n, t in [(139, 'div.browserPanel'), (278, 'div.browserPanel__stage'),
                         (335, '<webview>')]
        ],
    }

    if '--json' in sys.argv:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0

    print(f"文件行数: " + '  '.join(f"{k}={v}" for k, v in data['files'].items()))
    print("\n== hooks ==")
    for k, v in data['hooks'].items():
        print(f"  {k}: " + '  '.join(f"{a}={b}" for a, b in v.items()))
    print("\n== 元素（preflight 敏感）==")
    for k, v in data['elements'].items():
        if v == 0:
            continue
        print(f"  <{k}>: {v['total']}"
              + (f"  ★裸 {v['naked']} 个 {v['naked_lines']}" if v['naked'] else ''))
    missing = [k for k, v in data['elements'].items() if v == 0]
    print(f"  完全没有的元素（preflight 打不到）: {', '.join(missing)}")
    print("\n== className ==")
    for k, v in data['classes'].items():
        print(f"  {k}: {v}")
    print("\n== CSS ==")
    for k, v in data['css'].items():
        if k == 'overlap':
            for kk, vv in v.items():
                print(f"  {kk}: {vv if vv else '（无重叠）'}")
        else:
            print(f"  {k}: rules={v['rules']} media={v['media']} keyframes={v['keyframes']} "
                  f"important={v['important']} dead={v.get('dead_count', 0)}")
            if v.get('dead_count'):
                print(f"     死规则: {', '.join(v['dead_selectors'])}")
    print("\n== webview 宿主锚点 ==")
    for a in data['webview_host_anchors']['app_chain']:
        print(f"  App.tsx:{a['line']}  {a['text']}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
