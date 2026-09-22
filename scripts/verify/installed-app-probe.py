#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
换装后的「正式安装版」功能确认 —— 证明第 25 步的核心行为在**已安装的 app.asar** 里真的生效。

为什么不直接用 fullscreen-browser-tests.py：
  那个脚本跑的是 `vite dev server + 源码`（改源码立刻生效），**证明不了安装包里的代码**。
  这里跑的是 `%LOCALAPPDATA%\\Programs\\@ai-workbenchdesktop\\AI 工作台.exe` 里那份 app.asar。

只确认 4 件事（按用户要求：不重跑 70 条回归，确认核心功能生效即可）：
  ① 安装版默认全屏（层不带 --bg）、webview 有真实尺寸
  ② 点「退出全屏」→ 进后台态 + 出现右下角小图标，webview 尺寸不变
  ③ ★决定1：AI 自己开新网页（真点击 target=_blank）**不再**把用户拽回全屏
  ④ ★决定1：主进程「把视线给这张页」（敏感字段等待那条通道）**仍然**拉回全屏

用法： python scripts/verify/installed-app-probe.py
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

# ★ 必须在 import 验收脚本**之前**设好：它按这些环境变量算端口，并写死 CDP 的页面匹配串
os.environ['FB_CDP_PORT'] = os.environ.get('IA_CDP_PORT', '9345')
os.environ['FB_API_PORT'] = os.environ.get('IA_API_PORT', '8795')
os.environ['FB_FAKE_PORT'] = os.environ.get('IA_FAKE_PORT', '8896')
os.environ['FB_VITE_PORT'] = os.environ.get('IA_VITE_PORT', '5181')
os.environ['FB_OBSERVE_SECS'] = '25'

_spec = importlib.util.spec_from_file_location(
    'fbt', os.path.join(HERE, 'fullscreen-browser-tests.py'))
F = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(F)

# 复用已验证的助手；只把「跑哪个 app / 证据放哪」换成安装版
F.OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'installed-app')
F.TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'wb-installed')
F.PROFILE = os.path.join(F.TMP, 'profile')
os.makedirs(F.OUTDIR, exist_ok=True)

# F 把 CDP 的页面匹配串写死成 vite 地址（'localhost:5181'），安装版的渲染进程是 file:// 下的
# app.asar —— 这里直接把 `page()` 的默认参数换掉（1 行，比复制一整套助手安全）。
F.P.page.__defaults__ = (os.environ.get('IA_MATCH', 'app.asar'), 8)

PROG = r'C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\AI 工作台.exe'
ASAR = r'C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop\resources\app.asar'

NODE = F.NODE
API = F.API
FAKE = F.FAKE
FAKE_PORT = F.FAKE_PORT


def installed_running():
    out = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq AI 工作台.exe', '/FO', 'CSV', '/NH'],
                         capture_output=True).stdout.decode('gbk', 'replace')
    return 'AI 工作台.exe' in out


def main():
    F.section('0. 自检（安装版存在 + 端口空闲）')
    F.expect(os.path.exists(PROG), '安装版可执行文件存在', PROG)
    F.expect(os.path.exists(ASAR), '安装版 app.asar 存在',
             '%s（%d B，%s）' % (ASAR, os.path.getsize(ASAR),
                                time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(os.path.getmtime(ASAR)))))
    if installed_running():
        print('  ! 已有「AI 工作台」在跑 —— 先关掉它再跑本探针（单实例锁会让新实例直接退出）')
    busy = [p for p in (F.API_PORT, FAKE_PORT, F.CDP_PORT) if F.port_busy(p)]
    F.expect(not busy, '端口空闲', '被占：%s' % busy)

    F.section('1. 确保数据库可用（复用已验收的 PG 启动逻辑）')
    F.expect(F.RPR.ensure_pg(), '数据库可查询')

    F.section('2. 起假模型/假站点 + 验收后端（给安装版登录用）')
    F.spawn('fake', [NODE, os.path.join(HERE, 'fake-llm.mjs')], REPO,
            env={'FAKE_PORT': str(FAKE_PORT), 'FAKE_DELAY_MS': str(F.FAKE_DELAY_MS),
                 'FAKE_STEPS': '30', 'FAKE_LOG': os.path.join(F.OUTDIR, 'llm.jsonl')},
            log=os.path.join(F.OUTDIR, 'fake.log'))
    F.expect(F.wait_health(FAKE).get('ok') is True, '假模型/假站点起来了')

    F.spawn('server', [NODE, 'dist/index.js'], os.path.join(REPO, 'apps', 'server'),
            env={'PORT': str(F.API_PORT), 'DEEPSEEK_BASE_URL': FAKE,
                 'DEEPSEEK_API_KEY': 'fake-key-installed-probe', 'DEEPSEEK_MODEL': 'fake-installed'},
            log=os.path.join(F.OUTDIR, 'server.log'))
    hs = F.wait_health(API)
    F.expect(hs.get('db') == 'up', '验收后端起来了', json.dumps(hs, ensure_ascii=False)[:160])

    F.section('3. 起**已安装**的正式版（独立临时 profile，不动你的真实数据目录）')
    logpath = os.path.join(F.OUTDIR, 'installed-app.log')
    log = open(logpath, 'w', encoding='utf-8', errors='replace')
    # ★ 必须加 --no-sandbox：本机（虚拟机/受限环境）Chromium 的 GPU 进程沙箱起不来，
    #   现象是启动 1 秒后反复 "GPU process exited unexpectedly" 然后
    #   "FATAL:gpu_data_manager_impl_private.cc GPU process isn't usable. Goodbye."
    #   进程直接没了 —— 而探针只会看到"端口没人监听"，非常容易误判成"包坏了"。
    #   验收脚本那边的启动器（apps/desktop/scripts/start-electron.mjs）也是同样的回退。
    p = subprocess.Popen([PROG,
                          '--no-sandbox',
                          '--remote-debugging-port=%d' % F.CDP_PORT,
                          '--user-data-dir=%s' % F.PROFILE],
                         cwd=os.path.dirname(PROG), stdout=log, stderr=subprocess.STDOUT)
    F.PROCS.append(('installed-app', p))

    def up():
        return F.alive()

    ok, _, ms = F.wait_until(up, timeout=90)
    if not ok:
        # 进程早退 / 起不来：把日志尾巴打出来，别让人对着"端口不通"猜
        try:
            tail = open(logpath, encoding='utf-8', errors='replace').read()[-1200:]
        except Exception as e:
            tail = '(读日志失败：%s)' % e
        print('  ! 安装版没起来（退出码 %s）。它的日志尾巴：\n%s' % (p.poll(), tail))
    F.expect(ok, '安装版窗口出现（CDP 连上它的渲染进程）', '耗时 %dms' % ms)
    print('  渲染进程地址：%s' % (F.ev('location.href') or '')[:120])

    F.section('4. 建号登录（走真实短信登录链路）')
    st, _ = F.http_json('/auth/sms/send', 'POST', body={'phone': F.TEST_PHONE})
    F.expect(st == 200, '发送验证码', 'HTTP %d' % st)
    code = None
    slog = os.path.join(F.OUTDIR, 'server.log')
    for _ in range(40):
        try:
            txt = open(slog, encoding='utf-8', errors='replace').read()
        except Exception:
            txt = ''
        import re as _re
        for m in _re.finditer(r'(\d{6})', txt):
            code = m.group(1)
        if code:
            break
        time.sleep(0.5)
    F.expect(bool(code), '从服务端日志拿到验证码')
    st, sess = F.http_json('/auth/login/sms', 'POST', body={'phone': F.TEST_PHONE, 'code': code})
    F.expect(st == 200 and sess.get('token'), '短信登录成功')
    token = sess['token']

    c = F.P.Cdp()
    try:
        c.js("localStorage.setItem('workbench.token', %s);"
             "localStorage.setItem('workbench.apiBase', %s); 'set'"
             % (json.dumps(token), json.dumps(API)))
        c.send('Page.reload')
    finally:
        try:
            c.ws.close()
        except Exception:
            pass
    time.sleep(6)
    ok, _, ms = F.wait_until(
        lambda: ('退出登录' in (F.ev('(document.body.innerText||"")') or ''))
        and (F.ev('Boolean(window.workbench && window.workbench.agentStart)') is True), timeout=60)
    F.expect(ok, '安装版进到工作台（登录态锚点 + 驾驶桥就绪）', '耗时 %dms' % ms)

    F.section('5. 第 25 步核心行为在安装版里的确认')
    F.ev('window.workbench.openBrowser(%s); "ok"' % json.dumps(FAKE + '/shop'))
    ok, _, ms = F.wait_until(
        lambda: len([w for w in F.webviews() if isinstance(w.get('wcId'), int)]) >= 1, timeout=90)
    F.expect(ok, '内嵌页建起来了', '耗时 %dms' % ms)

    L = F.layer()
    print('  层状态：%s' % json.dumps(L, ensure_ascii=False))
    F.expect(L.get('hasLayer') is True, '浏览器层已挂载（说明新渲染层代码确实在包里）')
    F.check('① 安装版默认就是全屏（层不带 --bg）', '--bg' not in (L.get('layerCls') or ''), L.get('layerCls'))
    mr, lr = L.get('middleRect') or {}, L.get('layerRect') or {}
    F.check('② 层铺满中栏会话区（宽高与 .middle 一致）',
            mr.get('w') == lr.get('w') and mr.get('h') == lr.get('h'),
            'middle=%s layer=%s' % (mr, lr))
    F.check('③ 退出按钮文案是「退出全屏」', L.get('toggleText') == '退出全屏', L.get('toggleText'))
    w0 = L.get('wvRect') or {}
    F.check('④ webview 有真实尺寸（宽高都 > 100）',
            w0.get('w', 0) > 100 and w0.get('h', 0) > 100, 'wvRect=%s' % w0)
    F.check('⑤ 全屏时没有「后台运行」小图标', L.get('hasFloating') is False)

    F.exit_fullscreen()
    ok, _, ms = F.wait_until(lambda: '--bg' in (F.layer().get('layerCls') or ''), timeout=15)
    F.expect(ok, '点「退出全屏」→ 进入后台态', '耗时 %dms' % ms)
    B = F.layer()
    print('  后台态：%s' % json.dumps(B, ensure_ascii=False))
    F.check('⑥ 退出后出现「后台运行」小图标', B.get('hasFloating') is True, B.get('floatingText'))
    F.check('⑦ 退出后层是「不可见但仍在渲染」（opacity=0、display 不是 none）',
            B.get('layerOpacity') == '0' and B.get('layerDisplay') != 'none',
            'opacity=%s display=%s' % (B.get('layerOpacity'), B.get('layerDisplay')))
    F.check('⑧ 退出后 webview 尺寸一点没变（不是 0 尺寸）',
            (B.get('wvRect') or {}) == w0, '退出前 %s → 退出后 %s' % (w0, B.get('wvRect')))

    # ---- ★决定1 上半：AI 自己开新网页 → 不许打扰 ----
    tabs_before = len([w for w in F.webviews() if isinstance(w.get('wcId'), int)])
    gc = F.guest_cdp('127.0.0.1:%d' % FAKE_PORT)
    if gc is None:
        print('  ! guest_cdp 没找到内嵌页的调试目标。诊断：')
        print('    webviews() = %s' % json.dumps(F.webviews(), ensure_ascii=False)[:400])
        try:
            for t in F.P._http('/json/list'):
                print('    target type=%s id=%s wcId=%s url=%s'
                      % (t.get('type'), t.get('id'), t.get('webContentsId'), (t.get('url') or '')[:60]))
        except Exception as e:
            print('    /json/list 读失败：%s' % e)
    F.expect(gc is not None, '找到内嵌页的 CDP 目标（下面要真点击）')
    clicked = None
    try:
        gc.js("(() => { const old=document.getElementById('__d1'); if(old) old.remove();"
              " const a=document.createElement('a'); a.id='__d1'; a.target='_blank'; a.rel='noopener';"
              " a.href='http://127.0.0.1:%d/other?t=%d'; a.textContent='D1';"
              " a.style.cssText='position:fixed;left:4px;top:4px;width:120px;height:32px;"
              "z-index:2147483647;background:#0f0'; document.body.appendChild(a); return 'injected'; })()"
              % (FAKE_PORT, int(time.time())))
        r = gc.js("(() => { const e=document.querySelector('#__d1'); if(!e) return null;"
                  " e.scrollIntoView({block:'center'}); const b=e.getBoundingClientRect();"
                  " return {x:Math.round(b.left+b.width/2), y:Math.round(b.top+b.height/2)}; })()")
        if r:
            gc.send('Input.dispatchMouseEvent', type='mouseMoved', x=r['x'], y=r['y'])
            gc.send('Input.dispatchMouseEvent', type='mousePressed', x=r['x'], y=r['y'],
                    button='left', buttons=1, clickCount=1)
            gc.send('Input.dispatchMouseEvent', type='mouseReleased', x=r['x'], y=r['y'],
                    button='left', buttons=0, clickCount=1)
            clicked = '(%s,%s)' % (r['x'], r['y'])
    finally:
        try:
            gc.ws.close()
        except Exception:
            pass
    print('  真点击 target=_blank 链接：%s' % clicked)
    ok, _, ms = F.wait_until(
        lambda: len([w for w in F.webviews() if isinstance(w.get('wcId'), int)]) > tabs_before,
        timeout=25)
    tabs_after = len([w for w in F.webviews() if isinstance(w.get('wcId'), int)])
    F.expect(ok, 'AI 自己开新网页 → 真的新开了一条 tab', '耗时 %dms（%d → %d）' % (ms, tabs_before, tabs_after))
    time.sleep(1.2)
    D1 = F.layer()
    print('  新开页后：%s' % json.dumps(D1, ensure_ascii=False))
    F.check('⑨ ★安装版里：AI 自己开新页**不把用户拽回全屏**（层仍带 --bg）',
            '--bg' in (D1.get('layerCls') or ''), D1.get('layerCls'))
    F.check('⑩ 后台态下小图标仍在（用户随时能自己回去看）',
            D1.get('hasFloating') is True, D1.get('floatingText'))

    # ---- ★决定1 下半：需要用户亲自处理 → 必须拉回 ----
    F.ev('window.workbench.focusBrowser(); "ok"')
    ok, _, ms = F.wait_until(lambda: '--bg' not in (F.layer().get('layerCls') or ''), timeout=15)
    F.expect(ok, '主进程「把视线给这张页」（敏感字段等待那条通道）→ 拉回全屏', '耗时 %dms' % ms)
    D2 = F.layer()
    F.check('⑪ ★安装版里：需要用户亲自处理时**会**拉回全屏（层不再带 --bg）',
            '--bg' not in (D2.get('layerCls') or ''), D2.get('layerCls'))
    F.check('⑫ 拉回全屏后小图标消失', D2.get('hasFloating') is False, D2.get('floatingText'))

    F.finish()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        F.finish()
