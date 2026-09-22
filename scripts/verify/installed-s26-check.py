#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
第 26 步换装后的「安装版启动确认」—— 证明用户双击桌面快捷方式时，加载的真的是新包。

为什么还要这一层（前面已经读过了 asar 的字节）：
  读 asar 只能证明"文件里是新的"，**证明不了这个包能启动、页面真的吃到新 CSS**。
  本机踩过一次手搓 asar 导致 `Failed to parse header`、应用启动即退 ——
  那种情况下"文件里的 token 是对的"，但用户双击什么也看不到。

本脚本一次做完（★ 不能拆成多次调用：进程挂在调用里，跨调用就被回收）：
  启动安装版（--no-sandbox，本机必加）→ 连 CDP → 读页面实际加载的样式 → 截图 → 自己关掉。

用法：python scripts/verify/installed-s26-check.py
"""
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'tavily')
SHOT = os.path.join(OUTDIR, 'installed-s26.png')

EXE = os.path.join(os.environ.get('LOCALAPPDATA', ''),
                   'Programs', '@ai-workbenchdesktop', 'AI 工作台.exe')
PORT = 9556

# ★ 每次用全新 user-data-dir：绕开单实例锁，也不会污染用户的登录态
UD = os.path.join(tempfile.gettempdir(), 'wb-installed-s26-%d' % int(time.time()))
LOG = os.path.join(OUTDIR, 'installed-s26-electron.log')

# 127.0.0.1 必须绕过系统代理，否则 urllib 会被打成 502
os.environ['NO_PROXY'] = '127.0.0.1,localhost'
os.environ['WB20_PORT'] = str(PORT)
os.environ['WB20_MATCH'] = 'app.asar'

_spec = importlib.util.spec_from_file_location('cdp_probe', os.path.join(HERE, 'cdp-probe.py'))
P = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(P)

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print('%s  %s%s' % ('PASS' if ok else 'FAIL', name, (' :: ' + str(detail)) if detail else ''))


def port_open():
    import socket
    s = socket.socket()
    s.settimeout(0.5)
    try:
        s.connect(('127.0.0.1', PORT))
        return True
    except Exception:  # noqa: BLE001
        return False
    finally:
        s.close()


def main():
    check('安装版 exe 存在', os.path.exists(EXE), EXE)
    if not os.path.exists(EXE):
        return 2

    f = open(LOG, 'wb')
    proc = subprocess.Popen(
        [EXE, '--no-sandbox', '--remote-debugging-port=%d' % PORT, '--user-data-dir=%s' % UD],
        stdout=f, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)

    t0 = time.time()
    while time.time() - t0 < 60 and not port_open():
        time.sleep(0.5)
    up = port_open()
    check('安装版启动了且 CDP 端口开着的（没撞上"Failed to parse header"）', up,
          '耗时 %dms' % int((time.time() - t0) * 1000))
    if not up:
        f.close()
        proc.kill()
        return 2

    try:
        tgt = P.page('app.asar', tries=30)
        check('找到渲染进程页面（页面真的加载了 index.html）', tgt is not None,
              (tgt or {}).get('url'))
        c = P.Cdp(tgt)
        try:
            info = c.js(r"""
(() => {
  const sels = [];
  for (const s of document.styleSheets) {
    try { for (const r of s.cssRules) sels.push(String(r.selectorText || '')); }
    catch (e) { /* 跨域样式表读不到规则，跳过 */ }
  }
  return {
    url: location.href,
    title: document.title,
    hrefs: [...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.href.split('/').pop()),
    hasSourcesItem: sels.some(x => x.includes('sources__item')),
    hasSourcesLabel: sels.some(x => x.includes('sources__label')),
    root: !!document.getElementById('root') || !!document.querySelector('.wtApp, .authWrap'),
  };
})()
""")
            print('    页面读数：%s' % (info,))
            check('页面是从 app.asar 里加载的（file://…/app.asar/dist/index.html）',
                  'app.asar' in str((info or {}).get('url')), (info or {}).get('url'))
            check('渲染层真的挂上了（root / 登录页根节点在）', bool((info or {}).get('root')))
            check('★ 页面加载的 CSS 里有 .sources__item（第 26 步的新样式真的生效了）',
                  bool((info or {}).get('hasSourcesItem')), (info or {}).get('hrefs'))
            check('★ 页面加载的 CSS 里有 .sources__label',
                  bool((info or {}).get('hasSourcesLabel')))
            try:
                c.shot(SHOT)
            except Exception as e:  # noqa: BLE001
                print('      截图失败：%r' % e)
            check('截图已保存', os.path.exists(SHOT), SHOT)
        finally:
            try:
                c.ws.close()
            except Exception:  # noqa: BLE001
                pass
    except Exception as e:  # noqa: BLE001
        check('连 CDP 并读到页面', False, repr(e))
    finally:
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
        try:
            f.close()
        except Exception:  # noqa: BLE001
            pass
        shutil.rmtree(UD, ignore_errors=True)
    return 0


if __name__ == '__main__':
    rc = 2
    try:
        rc = main()
    finally:
        passed = sum(1 for _, ok in results if ok)
        failed = len(results) - passed
        print('\n===== 汇总：%d PASS / %d FAIL =====' % (passed, failed))
        for name, ok in results:
            if not ok:
                print('  FAIL %s' % name)
        print('日志：%s' % LOG)
    sys.exit(0 if rc == 0 and failed == 0 else 1)
