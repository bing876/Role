"""给**已安装**的桌面应用拍一张「暂停/继续临时测试条在哪」的标注截图。

为什么单独写、且所有子进程都在这个脚本里自己起自己收：
  * 已安装应用的 exe 叫「AI 工作台.exe」（不是 electron.exe），渲染层加载的是
    app.asar 里的 file:// 页面，跟 dev 模式（vite）不是一回事；
  * GUI 进程放到 bash 后台会被回收，所以必须在脚本内起、在脚本内 kill。

截图为什么不用 CDP 的 Page.captureScreenshot：本机实测它会**永久挂住**
（窗口不是前台时 Chromium 不给合成表面）。改用「置顶 + 从桌面 DC BitBlt」，
拿到的是屏幕上真实显示的像素。

标注坐标不靠肉眼估：先用像素扫描在截图里找到测试条那块**琥珀色背景**的包围盒，
再用「DOM 里的 rect → 截图里的 rect」的偏移量换算两个按钮的位置。

用法：
  C:/Users/bing/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe \
      scripts/verify/installed-ui-shot.py
"""
import json
import os
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(REPO, 'docs', 'acceptance', 'pause-resume')
os.makedirs(OUT, exist_ok=True)

EXE = r'C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\AI 工作台.exe'
PORT = 9399

os.environ['WB20_PORT'] = str(PORT)
os.environ['WB20_MATCH'] = 'app.asar'

import importlib.util  # noqa: E402

spec = importlib.util.spec_from_file_location('cdp_probe', os.path.join(HERE, 'cdp-probe.py'))
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)

import ctypes  # noqa: E402

import win32con  # noqa: E402
import win32gui  # noqa: E402
import win32ui  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

ctypes.windll.shcore.SetProcessDpiAwareness(2)


def find_window(pids):
    """按属主 PID 找应用的顶层窗口（数进程没用：一个 Electron 有 5~8 个进程）。"""
    import win32process

    rows = []

    def cb(hwnd, _):
        try:
            pid = win32process.GetWindowThreadProcessId(hwnd)[1]
        except Exception:  # noqa: BLE001
            return
        if pid not in pids:
            return
        l, t, r, b = win32gui.GetWindowRect(hwnd)
        title = win32gui.GetWindowText(hwnd)
        if win32gui.IsWindowVisible(hwnd) and title and (r - l) > 400 and (b - t) > 300:
            rows.append((hwnd, title, (l, t, r, b)))

    win32gui.EnumWindows(cb, None)
    return rows


def grab(hwnd):
    """置顶后从桌面 DC BitBlt —— 真值，且不需要 CDP。"""
    win32gui.SetWindowPos(hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0,
                          win32con.SWP_NOMOVE | win32con.SWP_NOSIZE | win32con.SWP_SHOWWINDOW)
    time.sleep(1.8)  # 给合成器留时间，0.5s 不够
    l, t, r, b = win32gui.GetWindowRect(hwnd)
    w, h = r - l, b - t
    dc = win32gui.GetWindowDC(0)
    mfc = win32ui.CreateDCFromHandle(dc)
    sdc = mfc.CreateCompatibleDC()
    bmp = win32ui.CreateBitmap()
    bmp.CreateCompatibleBitmap(mfc, w, h)
    sdc.SelectObject(bmp)
    sdc.BitBlt((0, 0), (w, h), mfc, (l, t), win32con.SRCCOPY)
    info = bmp.GetInfo()
    bits = bmp.GetBitmapBits(True)
    img = Image.frombuffer('RGB', (info['bmWidth'], info['bmHeight']), bits, 'raw', 'BGRX', 0, 1).copy()
    win32gui.DeleteObject(bmp.GetHandle())
    sdc.DeleteDC()
    mfc.DeleteDC()
    win32gui.ReleaseDC(hwnd, dc)
    win32gui.SetWindowPos(hwnd, win32con.HWND_NOTOPMOST, 0, 0, 0, 0,
                          win32con.SWP_NOMOVE | win32con.SWP_NOSIZE)
    return img


def amber_bbox(img):
    """像素扫描找测试条那块琥珀底（#fff8e1）的包围盒 —— 不靠肉眼估坐标。"""
    w, h = img.size
    px = img.load()
    xs, ys = [], []
    # 只扫顶部窄带（测试条在上面）+ 横向只取中间栏位置（避开左栏/右栏）
    for y in range(30, min(110, h)):
        for x in range(150, min(w - 40, 1150)):
            r, g, b = px[x, y][:3]
            if r > 245 and 235 <= g <= 252 and 200 <= b <= 232:
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def main():
    logf = open(os.path.join(OUT, 'installed-app.log'), 'wb')
    # 本机必须 --no-sandbox，否则 GPU 进程致命崩溃（退出码 0x80000003）
    proc = subprocess.Popen(
        [EXE, '--no-sandbox', '--remote-debugging-port=%d' % PORT, '--remote-allow-origins=*'],
        stdout=logf, stderr=subprocess.STDOUT,
    )
    print('已启动已安装应用 pid=%d' % proc.pid)
    c = None
    try:
        t0 = time.time()
        while time.time() - t0 < 60:
            try:
                P._http('/json/list', tries=1)
                break
            except Exception:  # noqa: BLE001
                time.sleep(1)
        else:
            print('❌ 60 秒内 CDP 没起来')
            return 1
        time.sleep(6)  # 等登录态恢复 + 首屏渲染

        c = P.Cdp()
        state = c.js("({loggedIn: !!document.querySelector('.app'),"
                     " login: !!document.querySelector('.authWrap'),"
                     " tabs: (document.querySelectorAll('webview')||[]).length,"
                     " bar: !!document.querySelector('.driveBar'),"
                     " text: (document.body.innerText||'').slice(0,200)})")
        print('首屏:', json.dumps(state, ensure_ascii=False))
        if not state.get('loggedIn'):
            print('❌ 停在了登录页（Local Storage 里没有可用会话），没法继续。')
            return 2

        # 没有打开的网页时测试条不渲染（它挂在工作区上方）——先开一张
        if state.get('tabs', 0) == 0:
            print('没有打开的网页，先开一张…')
            c.js("(async () => { await window.workbench.openBrowser('https://example.com');"
                 " return 'ok'; })()", await_promise=True)
            time.sleep(6)

        t0 = time.time()
        while time.time() - t0 < 30:
            if c.js('!!document.querySelector(".driveBar")'):
                break
            time.sleep(1)
        else:
            print('❌ 30 秒内没等到 .driveBar（网页没开起来？）')
            return 3

        dom = c.js("(() => {"
                   " const bar = document.querySelector('.driveBar');"
                   " const br = bar.getBoundingClientRect();"
                   " const btns = [...bar.querySelectorAll('button')].map(b => {"
                   "   const r = b.getBoundingClientRect();"
                   "   return {text: (b.innerText||'').trim(),"
                   "           x: r.x, y: r.y, w: r.width, h: r.height};"
                   " });"
                   " return {bar: {x: br.x, y: br.y, w: br.width, h: br.height},"
                   "         btns: btns,"
                   "         outer: {w: window.outerWidth, h: window.outerHeight},"
                   "         inner: {w: window.innerWidth, h: window.innerHeight}}; })()")
        print('测试条 DOM:', json.dumps(dom, ensure_ascii=False, indent=2))

        # 找窗口并截图
        pids = {proc.pid}
        try:
            out = subprocess.check_output(
                ['tasklist', '/FO', 'CSV', '/NH'], stderr=subprocess.DEVNULL)
            txt = out.decode('gbk', errors='replace')
            for line in txt.splitlines():
                if '工作台' in line or 'electron.exe' in line.lower():
                    parts = [x.strip('"') for x in line.split('","')]
                    if len(parts) >= 2 and parts[1].isdigit():
                        pids.add(int(parts[1]))
        except Exception as e:  # noqa: BLE001
            print('枚举进程失败:', e)

        wins = []
        t0 = time.time()
        while time.time() - t0 < 20 and not wins:
            wins = find_window(pids)
            if not wins:
                time.sleep(1)
        if not wins:
            print('❌ 没找到应用窗口')
            return 4
        hwnd, title, rect = wins[0]
        print('窗口: %r  rect=%s' % (title, rect))

        img = grab(hwnd)
        raw = os.path.join(OUT, 'installed-ui-raw.png')
        img.save(raw)
        print('原图 ->', raw)

        bb = amber_bbox(img)
        print('像素扫描到测试条包围盒:', bb)
        if not bb:
            print('⚠️ 没在截图里扫到琥珀底，改用 DOM 坐标 + 估算偏移标注')
            offx = (dom['outer']['w'] - dom['inner']['w']) // 2
            offy = dom['outer']['h'] - dom['inner']['h']
            bx0 = rect[0] + offx + int(dom['bar']['x'])
            by0 = rect[1] + offy + int(dom['bar']['y'])
            bb = (bx0, by0, bx0 + int(dom['bar']['w']), by0 + int(dom['bar']['h']))

        # 用「DOM rect → 截图 rect」的偏移量换算按钮位置（比肉眼估可靠）
        offx = bb[0] - int(dom['bar']['x'])
        offy = bb[1] - int(dom['bar']['y'])

        draw = ImageDraw.Draw(img)
        draw.rectangle([bb[0] - 4, bb[1] - 4, bb[2] + 4, bb[3] + 4], outline=(220, 38, 38), width=3)

        font = None
        for fp in (r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\simhei.ttf'):
            if os.path.exists(fp):
                try:
                    font = ImageFont.truetype(fp, 18)
                    break
                except Exception:  # noqa: BLE001
                    pass

        def label(text, xy, color=(220, 38, 38)):
            if font:
                draw.text(xy, text, font=font, fill=color)
            else:
                draw.text(xy, text, fill=color)

        btn_boxes = []
        for b in dom['btns']:
            x0 = offx + int(b['x'])
            y0 = offy + int(b['y'])
            x1 = x0 + int(b['w'])
            y1 = y0 + int(b['h'])
            btn_boxes.append((b['text'], (x0, y0, x1, y1)))
            draw.rectangle([x0 - 2, y0 - 2, x1 + 2, y1 + 2], outline=(220, 38, 38), width=2)

        label('② 暂停 / 继续 —— 临时测试条在这里',
              (bb[0] - 4, max(0, bb[1] - 34)))
        for i, (t, box) in enumerate(btn_boxes):
            label('%s ←' % t, (box[2] + 8, box[1] - 2))
        label('① 中栏：浏览器工作区在这条下面（先开一张网页，测试条才出现）',
              (bb[0] - 4, bb[3] + 12), color=(30, 90, 200))

        ann = os.path.join(OUT, 'installed-ui-annotated.png')
        img.save(ann)
        print('标注图 ->', ann)
        print('按钮位置（截图内像素坐标）:')
        for t, box in btn_boxes:
            print('   %-4s %s' % (t, box))
        return 0
    finally:
        if c is not None:
            try:
                c.ws.close()
            except Exception:  # noqa: BLE001
                pass
        try:
            subprocess.run(
                ['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                capture_output=True, timeout=20,
                env={**os.environ, 'MSYS_NO_PATHCONV': '1'},
            )
        except Exception as e:  # noqa: BLE001
            print('收尾 kill 失败:', e)
        print('已关闭应用')


if __name__ == '__main__':
    sys.exit(main())
