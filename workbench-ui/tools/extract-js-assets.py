# -*- coding: utf-8 -*-
"""提取设计基准 JS 里内联的 base64 图片（头像池等），外提到 src/assets/avatars/。
原文件只读。"""
import re, os, base64, io

SRC = r"C:\Users\bing\Desktop\workbench.work.html"
OUT = r"C:\Users\bing\workbuddy-ai\work123\workbench-ui\src\assets\avatars"
os.makedirs(OUT, exist_ok=True)

with io.open(SRC, "r", encoding="utf-8") as f:
    text = f.read()

# 只取 <script> 区（HTML/CSS 里的已由 split.py 处理）
bodies = re.findall(r"<script[^>]*>(.*?)</script>", text, re.S)
js = "\n".join(bodies)

# 'data:image/png;base64,XXXX'  出现在 JS 字符串里
pat = re.compile(r"data:image/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]{200,})")
seen = {}
n = 0
for m in pat.finditer(js):
    payload = m.group(2)
    key = payload[:64]
    if key in seen:
        continue
    seen[key] = True
    n += 1
    raw = base64.b64decode(payload)
    name = "avatar-%02d.%s" % (n, m.group(1))
    with open(os.path.join(OUT, name), "wb") as w:
        w.write(raw)
    print("  %-16s %7d B" % (name, len(raw)))

print("\n共提取头像/图片 %d 个 -> %s" % (n, OUT))
