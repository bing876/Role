"""Prototype vs app: side-by-side + per-column pixel diff heatmap + region stats.

The point is NOT a single "89% similar" number — it's to show, region by region,
which bands already line up and which are still off, so the remaining work is obvious.
"""
from PIL import Image, ImageDraw, ImageFont
import numpy as np
import os

PROTO = r"C:\Users\bing\workbuddy-ai\work123\docs\acceptance\ui1_5\proto-1to1.png"
APP = r"C:\Users\bing\workbuddy-ai\work123\docs\acceptance\ui1_5\app-ui16.png"
OUT = r"C:\Users\bing\workbuddy-ai\work123\docs\acceptance\ui1_5"

a = Image.open(PROTO).convert("RGB")
b = Image.open(APP).convert("RGB")
W, H = a.size
print("尺寸", a.size, b.size)

na = np.asarray(a).astype(np.int16)
nb = np.asarray(b).astype(np.int16)
d = np.abs(na - nb).max(axis=2)          # per-pixel max channel delta
HOT = d > 32                             # "visibly different" threshold

print("整体: 平均色差 %.1f  明显不同像素占比 %.2f%%" % (d.mean(), HOT.mean() * 100))

# ---------- region breakdown -------------------------------------------------
REGIONS = [
    ("列0 轨道 rail",        0,   0,   60, 900),
    ("列1 侧栏 sidebar",    60,   0,  340, 900),
    ("列2 主区 上带(0-40)", 340,   0, 1400,  40),
    ("列2 消息区",          340,  40, 1400, 820),
    ("列2 输入胶囊",        340, 820, 1400, 900),
    ("右上 窗口按钮区",    1250,   0, 1400,  40),
    ("底部 左(轨道下沿)",     0, 840,   60, 900),
]
print("\n%-22s %10s %12s" % ("区域", "平均色差", "明显不同占比"))
for name, x0, y0, x1, y1 in REGIONS:
    sub = d[y0:y1, x0:x1]
    subh = HOT[y0:y1, x0:x1]
    print("%-22s %10.1f %11.2f%%" % (name, sub.mean(), subh.mean() * 100))

# ---------- paint ------------------------------------------------------------------
heat = np.zeros((H, W, 3), dtype=np.uint8)
heat[..., 0] = np.clip(d * 3, 0, 255)
heat[..., 1] = np.clip(255 - d * 3, 0, 255) // 2
heat[..., 2] = 40
heat_img = Image.fromarray(heat)

gap = 14
PAD = 46
canvas = Image.new("RGB", (W * 3 + gap * 2, H + PAD), (24, 24, 26))
canvas.paste(a, (0, PAD))
canvas.paste(b, (W + gap, PAD))
canvas.paste(heat_img, ((W + gap) * 2, PAD))

dr = ImageDraw.Draw(canvas)
try:
    f = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 22)
except Exception:
    f = ImageFont.load_default()
labels = ["① 原型 workbench.work.html", "② 桌面端（照原型重写后）", "③ 逐像素差异热力图"]
for i, t in enumerate(labels):
    dr.text((i * (W + gap) + 8, 12), t, fill=(235, 235, 240), font=f)
# 红线标出未对齐的横向带
for i in range(3):
    x = i * (W + gap)
    dr.rectangle([x, PAD, x + W - 1, PAD + H - 1], outline=(90, 90, 96))

fp = os.path.join(OUT, "UI16-COMPARE.png")
canvas.save(fp)
print("\n对比图 ->", fp, os.path.getsize(fp), "B", canvas.size)
