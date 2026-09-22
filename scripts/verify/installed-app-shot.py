"""
启动「已安装的」AI 工作台，截图取证，然后收干净（一条脚本管全生命周期）。

为什么要一条脚本管到底（不是分两步）：
    本机 agent 工具会话回收后台任务时，会**连带杀掉该任务派生的所有子进程**
    （见 electron-ui-verify 技能第十六节）。所以「先起应用、再另起脚本截图」
    第二步一定连不上 —— 应用已经被回收了。
    正确做法是**一个进程里 spawn → 等 → 截图 → 结束**。

为什么打真靶（跑安装目录的 exe）：
    用户双击的是 app.asar 那一份。跑 `npx electron` 走源码是开发路径，
    证明不了「用户能点开用」。

跑法：
    C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe \
        scripts/verify/installed-app-shot.py
"""
import ctypes
import os
import subprocess
import sys
import time

import win32con
import win32gui
import win32ui
from PIL import Image

ctypes.windll.shcore.SetProcessDpiAwareness(2)  # 必须先设，否则坐标/尺寸会按缩放虚报

EXE = r"C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\AI 工作台.exe"
OUT = r"C:\Users\bing\workbuddy-ai\work123\docs\acceptance\root-cause"
os.makedirs(OUT, exist_ok=True)

results = []


def log(*a):
    s = " ".join(str(x) for x in a)
    results.append(s)
    print(s, flush=True)


def grab(hwnd):
    """置顶后从桌面 DC BitBlt —— 拿到的是「屏幕上真实显示」的像素（技能里最稳的一条）。"""
    win32gui.SetWindowPos(
        hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0,
        win32con.SWP_NOMOVE | win32con.SWP_NOSIZE,
    )
    time.sleep(1.8)  # 给合成器留时间；0.5s 不够
    l, t, r, b = win32gui.GetWindowRect(hwnd)
    w, h = r - l, b - t
    dc = win32gui.GetWindowDC(0)  # 0 = 整个桌面
    mfc = win32ui.CreateDCFromHandle(dc)
    sdc = mfc.CreateCompatibleDC()
    bmp = win32ui.CreateBitmap()
    bmp.CreateCompatibleBitmap(mfc, w, h)
    sdc.SelectObject(bmp)
    sdc.BitBlt((0, 0), (w, h), mfc, (l, t), win32con.SRCCOPY)
    info = bmp.GetInfo()
    bits = bmp.GetBitmapBits(True)
    img = Image.frombuffer(
        "RGB", (info["bmWidth"], info["bmHeight"]), bits, "raw", "BGRX", 0, 1
    ).copy()
    win32gui.DeleteObject(bmp.GetHandle())
    sdc.DeleteDC()
    mfc.DeleteDC()
    win32gui.ReleaseDC(0, dc)
    win32gui.SetWindowPos(
        hwnd, win32con.HWND_NOTOPMOST, 0, 0, 0, 0,
        win32con.SWP_NOMOVE | win32con.SWP_NOSIZE,
    )
    return img


def find_app_window(pids, timeout=45):
    """按属主 PID 找「真的算一个应用窗口」的那个（可见 + 有标题 + 尺寸像窗口）。"""
    deadline = time.time() + timeout
    seen = []
    while time.time() < deadline:
        found = []

        def cb(hwnd, _):
            import win32process

            pid = win32process.GetWindowThreadProcessId(hwnd)[1]
            if pid not in pids:
                return
            if not win32gui.IsWindowVisible(hwnd):
                return
            title = win32gui.GetWindowText(hwnd)
            l, t, r, b = win32gui.GetWindowRect(hwnd)
            w, h = r - l, b - t
            if title and w > 300 and h > 200:
                found.append((hwnd, pid, title, w, h))

        win32gui.EnumWindows(cb, None)
        seen = found
        if found:
            return found
        time.sleep(1.0)
    return seen


def pids_named(needle):
    """拿「映像名含 needle」的进程 PID 列表。

    ★ 不用 tasklist：本机会把非 ASCII 进程名弄丢（实测 394 行里 0 行含非 ASCII）。
      改用 PowerShell 的 Get-Process（它走的是 API，不是控制台文本），能正确拿到。
    """
    ps = (
        "Get-Process | Where-Object { $_.ProcessName -like '*"
        + needle
        + "*' } | Select-Object -ExpandProperty Id"
    )
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True, text=True, timeout=25,
        ).stdout
    except Exception as e:  # noqa: BLE001
        log("  (列进程失败: %s)" % e)
        return []
    return [int(x) for x in out.split() if x.strip().isdigit()]


log("启动:", os.path.basename(EXE), "--no-sandbox")
proc = subprocess.Popen([EXE, "--no-sandbox"])

ok = False
try:
    # 等窗口出现（最多 45 秒）
    pids = {proc.pid}
    pids |= set(pids_named("工作台"))
    wins = find_app_window(pids, timeout=45)

    log("")
    log("找到的候选窗口：%d 个" % len(wins))
    for hwnd, pid, title, w, h in wins:
        log("  hwnd=%s pid=%s size=%sx%s title=%r" % (hwnd, pid, w, h, title))

    if not wins:
        log("★ 没等到可见窗口 —— 应用没起来")
    else:
        hwnd, pid, title, w, h = wins[0]
        img = grab(hwnd)
        shot = os.path.join(OUT, "installed-app-after-sleep-r4.png")
        img.save(shot)
        log("")
        log("截图 -> %s  (%dx%d)" % (shot, img.width, img.height))

        # 白屏判定：统计非白像素占比（全白 = 没渲染出来）
        px = list(img.convert("L").getdata())
        nonwhite = sum(1 for v in px if v < 245)
        ratio = nonwhite / max(1, len(px))
        log("非白像素占比 = %.1f%%" % (ratio * 100))
        ok = ratio > 0.02
        log("")
        log("判定：%s" % ("PASS 界面真的渲染出来了" if ok else "★FAIL 看起来是白屏"))
finally:
    log("")
    log("收尾：结束应用进程")
    try:
        proc.terminate()
    except Exception:  # noqa: BLE001
        pass
    time.sleep(1.0)
    # Electron 是多进程；按 PID 树收，别用 /IM（会带走别的项目的 electron）
    for extra in pids_named("工作台"):
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(extra)],
            capture_output=True, text=True,
        )
    time.sleep(0.8)
    left = pids_named("工作台")
    log("  收尾后残留进程：%s" % (left if left else "0 个（干净）"))

with open(os.path.join(OUT, "installed-app-shot.log"), "w", encoding="utf-8") as f:
    f.write("\n".join(results) + "\n")

sys.exit(0 if ok else 1)
