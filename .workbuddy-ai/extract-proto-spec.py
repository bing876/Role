"""Extract the prototype's authoritative structure + CSS for the React rewrite.

Outputs a single readable spec file: docs/acceptance/rewrite/proto-spec.md
Covers: :root tokens, .frame, .rail, .sidebar/.contact-list, .main-area,
.composer/.inputbar, and the JS-rendered rows (contact item, rail icon).
"""
import io, re, os

SRC = r'J:\xwechat_files\wxid_yulc5z94mh2i22_84cf\msg\file\2026-09\workbench.work.html'
OUTDIR = r'C:\Users\bing\workbuddy-ai\work123\docs\acceptance\rewrite'
os.makedirs(OUTDIR, exist_ok=True)

s = io.open(SRC, encoding='utf-8', errors='replace').read()
out = []
W = out.append

W('# 原型 结构 + 样式 权威规格（自动提取）\n')
W('来源：`%s`  \n大小：%d 字节  \n' % (os.path.basename(SRC), len(s)))
W('> 本文件由 `extract-proto-spec.py` 从原型自动抽取，是 React 重写的**唯一权威依据**。\n')
W('> 凡是要"照原型实现"，都以此处抄出的结构与 CSS 为准，不要凭记忆。\n')


def css_rules(selector_pat, limit=40):
    """Grab CSS rules whose selector matches a regex (handles nesting via brace match)."""
    res = []
    for m in re.finditer(r'([^{}]*?)\{([^{}]*)\}', s):
        sel, body = m.group(1), m.group(2)
        # strip leading at-rule context noise
        sel_clean = sel.strip().split('\n')[-1].strip()
        if re.search(selector_pat, sel_clean):
            res.append((sel_clean, body.strip()))
            if len(res) >= limit:
                break
    return res


def dump_rules(title, pat, limit=40):
    W('\n### %s\n' % title)
    rs = css_rules(pat, limit)
    if not rs:
        W('_(未匹配到规则)_\n')
        return
    for sel, body in rs:
        W('```css')
        W('%s {' % sel)
        for decl in body.split(';'):
            d = decl.strip()
            if d:
                W('  %s;' % d)
        W('}')
        W('```')
    W('')


def dump_html(title, start_marker, length, note=''):
    i = s.find(start_marker)
    W('\n### %s\n' % title)
    if note:
        W('%s\n' % note)
    if i < 0:
        W('_(未找到标记 `%s`)_\n' % start_marker)
        return
    W('```html')
    W(s[i:i + length].strip())
    W('```\n')


# ============ 1. 设计令牌 ============
W('\n---\n\n## 1. 设计令牌 :root\n')
i = s.find(':root{')
j = s.find('}', i)
# :root may contain nested comments only; find matching brace properly
depth = 0
k = i
while k < len(s):
    if s[k] == '{':
        depth += 1
    elif s[k] == '}':
        depth -= 1
        if depth == 0:
            break
    k += 1
root = s[i:k + 1]
W('```css')
# strip comments to keep it compact but keep var lines
clean = re.sub(r'/\*.*?\*/', '', root, flags=re.S)
for line in clean.splitlines():
    if line.strip():
        W(line.rstrip())
W('```\n')

# ============ 2. 结构 ============
W('\n---\n\n## 2. 关键结构\n')
dump_html('2.1 工作台外框 .frame（含窗口控件、分割线）',
          '<div class="frame" role="application"', 2600)
dump_html('2.2 列1 侧栏 .sidebar + .contact-list',
          '<aside class="sidebar"', 400)
dump_html('2.3 列0 导航 .rail', '<nav class="rail"', 200,
          '注意：原型里这个 `<nav>` 是**空的**，图标由 JS 注入（见第 4 节）。')
dump_html('2.4 主区 .main-area + .top-area', '<div class="main-area"', 300)
dump_html('2.5 输入栏 .inputbar（attach 按钮 + 弹层开头）',
          '<div class="inputbar"', 700)
dump_html('2.6 富输入 .composer + 语音/发送按钮',
          '<div class="composer" id="composer"', 2000)

# ============ 3. CSS ============
W('\n---\n\n## 3. 关键 CSS 规则\n')
dump_rules('3.1 .frame（工作台窗口：尺寸/圆角/玻璃/描边）', r'^\.frame\b')
dump_rules('3.2 .rail（列0 导航：60px）', r'\.rail\b')
dump_rules('3.3 .sidebar（列1：280px）', r'^\.sidebar\b')
dump_rules('3.4 .contact-list / .contact-item（联系人卡）', r'\.contact-(list|item|name|avatar|status|memory)\b', 60)
dump_rules('3.5 .main-area / .top-area', r'\.(main-area|top-area)\b')
dump_rules('3.6 .inputbar / .composer（输入区）', r'\.(inputbar|composer)\b', 60)
dump_rules('3.7 .attach-popup（＋弹层）', r'\.attach-popup\b', 30)
dump_rules('3.8 .splitter', r'\.splitter\b', 20)
dump_rules('3.9 .col-divider', r'\.col-divider\b', 20)
dump_rules('3.10 .win-controls / .win-btn', r'\.win-(controls|btn)\b', 20)

# ============ 4. JS 渲染的行模板 ============
W('\n---\n\n## 4. JS 注入的 DOM 模板（图标与联系人行）\n')
for name, pat in [
    ('4.1 rail 图标注入（含每个图标的 SVG 与 data-tip）',
     r'rail\.innerHTML|railHTML|function\s+buildRail|nav-rail'),
    ('4.2 联系人行 contact-item 模板',
     r'function\s+contactRow|contactItemHTML|\.contact-item.*innerHTML|renderContacts'),
]:
    W('\n### %s\n' % name)
    ms = list(re.finditer(pat, s))
    if not ms:
        W('_(未匹配到)_\n')
        continue
    for m in ms[:3]:
        W('```javascript')
        W(s[max(0, m.start() - 200): m.start() + 2200])
        W('```\n')

io.open(os.path.join(OUTDIR, 'proto-spec.md'), 'w', encoding='utf-8').write('\n'.join(out))
print('written:', os.path.join(OUTDIR, 'proto-spec.md'))
print('bytes:', os.path.getsize(os.path.join(OUTDIR, 'proto-spec.md')))
