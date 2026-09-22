# -*- coding: utf-8 -*-
"""
从设计基准 workbench.work.html 复制样式到新前端项目（原文件只读，绝不修改）。

用途：把整块 <style> 按「原顺序」机械切分为多个 CSS 文件。
保真关键：切分严格保持原有行序 —— 导入顺序即层叠顺序，禁止重排。

同时做三件事：
  1. 剔除「桌面模拟器外壳」专用样式（.toolbar / .stage / .frame-drag-area / V3 拖动架构）
  2. base64 内联资源外提为独立文件（PNG / woff2）
  3. 画布硬编码尺寸 1200x770 变量化 —— 改两个变量即可切回设计稿尺寸做 1:1 比对
"""
import re, os, base64, io

SRC = r"C:\Users\bing\Desktop\workbench.work.html"
OUT = r"C:\Users\bing\workbuddy-ai\work123\workbench-ui"
CSS_DIR = os.path.join(OUT, "src", "styles")
IMG_DIR = os.path.join(OUT, "src", "assets", "images")
FONT_DIR = os.path.join(OUT, "src", "assets", "fonts")

for d in (CSS_DIR, IMG_DIR, FONT_DIR):
    os.makedirs(d, exist_ok=True)

with io.open(SRC, "r", encoding="utf-8") as f:
    lines = f.read().split("\n")

def seg(a, b):
    """取绝对行号 a..b（含），1-based"""
    return "\n".join(lines[a - 1:b])

# ---------------------------------------------------------------- 保留区间
# 说明：仅剔除模拟器外壳；其余（含会话流、设置、弹层）全部保留，做完整复刻。
FILES = [
    ("tokens",       [(22, 79)]),                 # @font-face / :root / reset
    ("base",         [(80, 92)]),                 # body.viewport
    ("frame",        [(120, 174)]),               # .frame / .main-glass / .sidebar / .main-area
    ("inputbar",     [(175, 523)]),               # 输入栏 + attach 弹层 + token 环 + model 弹层
    ("chat",         [(524, 973)]),               # 第三列 AI 对话流
    ("sidebar",      [(974, 1242)]),              # 第二列联系人列表 + 分隔条
    ("rail",         [(1243, 1404)]),             # 第一列玻璃栏 / 头像 / tabs / 汉堡 / agent-list
    ("search",       [(1405, 1498)]),             # 搜索组件 + ＋按钮 + ＋弹层
    ("modal",        [(1499, 1684)]),             # 创建智能体 / 设置 / 壁纸层 / workbench-mat / V3 Drag（跨边界注释延伸到这里）
    ("surface",      [(1685, 2067)]),             # V9-V17 覆盖层
    ("chat-bubbles", [(2068, 2295)]),             # V19/V20 消息气泡
    ("rail-agent",   [(2296, 2441)]),             # 头像态布局 + 动画
    ("settings-theme", [(2444, 2491)]),           # 第二个 <style> 块（设置界面主题）
]

# ---------------------------------------------------------------- 资源外提
img_seq = 0
font_seq = 0

def extract_assets(css_text):
    global img_seq, font_seq
    stats = {"png": 0, "font": 0}

    def repl(m):
        global img_seq, font_seq
        mime, payload = m.group(1), m.group(2)
        raw = base64.b64decode(payload)
        if mime.startswith("font/"):
            font_seq += 1
            name = "inter-latin.woff2" if font_seq == 1 else "font-%02d.%s" % (font_seq, mime.split("/")[-1])
            with open(os.path.join(FONT_DIR, name), "wb") as w:
                w.write(raw)
            stats["font"] += 1
            return "url('../assets/fonts/%s')" % name
        img_seq += 1
        name = "img-%02d.%s" % (img_seq, mime.split("/")[-1])
        with open(os.path.join(IMG_DIR, name), "wb") as w:
            w.write(raw)
        stats["png"] += 1
        return "url('../assets/images/%s')" % name

    # 注意：源文件里单引号、双引号两种写法都有，必须都覆盖
    pat = re.compile(r"""url\(['"]?data:([a-z0-9\-]+/[a-z0-9\-+]+);base64,([A-Za-z0-9+/=]+)['"]?\)""")
    return pat.sub(repl, css_text), stats

def variablize(t):
    return t.replace("1200px", "var(--frame-w)").replace("770px", "var(--frame-h)")

# ---------------------------------------------------------------- 执行
total = {"png": 0, "font": 0}
manifest = []
for name, ranges in FILES:
    text = "\n".join(seg(a, b) for (a, b) in ranges)
    text, st = extract_assets(text)
    text = variablize(text)
    total["png"] += st["png"]; total["font"] += st["font"]
    fname = "%02d-%s.css" % (len(manifest) + 1, name)
    with io.open(os.path.join(CSS_DIR, fname), "w", encoding="utf-8") as w:
        w.write("/* %s —— 源自设计基准 workbench.work.html 第 %s 行（原序切分，勿重排） */\n"
                % (name, ", ".join("%d-%d" % r for r in ranges)))
        w.write(text + "\n")
    manifest.append((fname, text.count("\n") + 1))

for f, n in manifest:
    print("  %-24s %5d 行" % (f, n))
print("\n外提资源：PNG %d 个 / 字体 %d 个" % (total["png"], total["font"]))

with io.open(os.path.join(CSS_DIR, "index.css"), "w", encoding="utf-8") as w:
    w.write("""/* 样式入口 —— 导入顺序 = 层叠顺序，与设计基准完全一致，禁止重排。
   项目级覆盖统一放在 99-theme.css（始终最后导入）。 */
%s
@import './99-theme.css';
""" % "\n".join("@import './%s';" % f for f, _ in manifest))
