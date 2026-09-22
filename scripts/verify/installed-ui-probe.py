"""给**已安装**的桌面应用拍一张当前界面（用来确认暂停/继续按钮到底在不在、放在哪）。

为什么单独写一个：已安装应用的 exe 名字是「AI 工作台.exe」（不是 electron.exe），
渲染层加载的是 app.asar 里的 file:// 页面，跟开发模式（vite）不是一回事。
GUI 进程必须在这个脚本里自己起、自己收 —— 放到 bash 后台会被回收。
"""
import importlib.util
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

spec = importlib.util.spec_from_file_location('cdp_probe', os.path.join(HERE, 'cdp-probe.py'))
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


def alive():
    try:
        P._http('/json/list', tries=1)
        return True
    except Exception:
        return False


# ★ 本机必须带 --no-sandbox：默认参数下 Electron 启动 1~2 秒后
#   "GPU process isn't usable. Goodbye." 直接崩（退出码 0x80000003）。
#   开发模式的 start-electron.mjs 会自动重试加上它，直接跑安装版就得自己带。
logf = open(os.path.join(OUT, 'installed-app.log'), 'wb')
p = subprocess.Popen([EXE, '--no-sandbox', '--remote-debugging-port=%d' % PORT],
                     stdout=logf, stderr=subprocess.STDOUT)
print('已启动已安装应用（pid=%d，--no-sandbox）' % p.pid)
try:
    t0 = time.time()
    while time.time() - t0 < 60:
        if alive():
            break
        time.sleep(1)
    else:
        print('❌ 60 秒内 CDP 没起来')
        sys.exit(1)
    time.sleep(6)  # 等登录态恢复 + 首屏渲染

    print('--- CDP 目标 ---')
    for t in P._http('/json/list'):
        print('  [%s] %s' % (t.get('type'), (t.get('url') or '')[:110]))

    c = P.Cdp()
    try:
        info = c.js('({url: location.href, title: document.title,'
                    ' bodyLen: (document.body.innerText||"").length,'
                    ' text: (document.body.innerText||"").slice(0,600)})')
        print('--- 页面 ---')
        print(json.dumps(info, ensure_ascii=False, indent=2))

        # 找所有可点的按钮/带「暂停」「继续」字样的元素
        found = c.js("(() => {"
                     " const hit = [];"
                     " const els = document.querySelectorAll('button, [role=button], a, [class*=btn]');"
                     " for (const e of els) {"
                     "   const t = (e.innerText||'').trim();"
                     "   if (t && t.length <= 12) {"
                     "     const r = e.getBoundingClientRect();"
                     "     hit.push({text: t, cls: (e.className||'').toString().slice(0,60),"
                     "               x: Math.round(r.x), y: Math.round(r.y),"
                     "               w: Math.round(r.width), h: Math.round(r.height)});"
                     "   }"
                     " }"
                     " return hit.slice(0, 60); })()")
        print('--- 界面上的按钮（文本 ≤12 字） ---')
        for b in (found or []):
            print('  %-14s  cls=%-40s  @(%d,%d) %dx%d'
                  % (b.get('text'), b.get('cls'), b.get('x'), b.get('y'), b.get('w'), b.get('h')))
        has = [b for b in (found or []) if '暂停' in (b.get('text') or '') or '继续' in (b.get('text') or '')]
        print('--- 含「暂停」或「继续」的元素 ---')
        print('  ' + json.dumps(has, ensure_ascii=False))

        shot = os.path.join(OUT, 'installed-ui.png')
        c.shot(shot)
        print('截图 -> %s' % shot)
    finally:
        try:
            c.ws.close()
        except Exception:
            pass
finally:
    try:
        p.terminate()
    except Exception:
        pass
    time.sleep(2)
    try:
        if p.poll() is None:
            p.kill()
    except Exception:
        pass
    print('已关闭应用')
