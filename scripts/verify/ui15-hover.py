"""UI-1.5：hover / active / focus 反馈取证

验证三处裁决是否真的落地：
  1. 头像 hover 从「上浮 + 投影」改为「底色块」—— 读 computed style，
     必须能看到 background 变成 --wt-icon-hover，且 transform 保持 none（不再位移）。
  2. 四个全局图标（含新增的「设置」）hover 都是同一种底色块，暂定态一致。
  3. 全部键盘 :focus-visible 焦点环仍在（包括设置图标）。

TOOLING：CSS `:hover` 只认**真实指针**。dispatchEvent('mouseover') 无效。
必须用 Input.dispatchMouseEvent 把鼠标真的移上去，再读 computed style。

用法：
  python scripts/verify/ui15-hover.py     # 需要 UI-1.5 环境已在跑（CDP_PORT 默认 9334）
"""
import base64
import importlib.util
import json
import os
import sys
import time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SHOTS = 'C:/Users/bing/WorkBuddy/WorkbenchApp/_ui15_shots'
OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'ui1_5')

CDP_PORT = int(os.environ.get('CDP_PORT', '9334'))
VITE_PORT = int(os.environ.get('VITE_PORT', '5274'))
MATCH = 'localhost:%d' % VITE_PORT

os.environ['WB20_PORT'] = str(CDP_PORT)
os.environ['WB20_MATCH'] = MATCH

_spec = importlib.util.spec_from_file_location('cdp_probe', os.path.join(HERE, 'cdp-probe.py'))
P = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(P)
P.MATCH = MATCH

TARGETS = {
    'avatar': '.wtRail__me',
    'chat': '[data-wt-global="chat"]',
    'knowledge': '[data-wt-global="knowledge"]',
    'plugins': '[data-wt-global="plugins"]',
    'settings': '[data-wt-global="settings"]',
    'back': '.wtRail__back',
    'row': '.wtSb__row',
}

READ_JS = r"""
(() => {
  const el = document.querySelector(%s);
  if (!el) return null;
  const cs = getComputedStyle(el);
  return {
    background: cs.backgroundColor,
    color: cs.color,
    transform: cs.transform,
    boxShadow: cs.boxShadow,
    transitionProperty: cs.transitionProperty,
    transitionDuration: cs.transitionDuration,
    outlineStyle: cs.outlineStyle,
    outlineWidth: cs.outlineWidth,
  };
})()
"""


def cdp():
    t = P._find(MATCH, kind='page', tries=8, delay=0.5)
    c = P.Cdp(t)
    try:
        c.send('Page.enable')
        c.send('Runtime.enable')
    except Exception:  # noqa: BLE001
        pass
    return c


def read(c, sel):
    r = c.send('Runtime.evaluate', expression=READ_JS % json.dumps(sel),
               returnByValue=True)
    if 'exceptionDetails' in r:
        raise RuntimeError(json.dumps(r['exceptionDetails'], ensure_ascii=False)[:400])
    return r['result'].get('value')


def center(c, sel):
    r = c.send('Runtime.evaluate',
               expression='(() => { const e=document.querySelector(%s); if(!e) return null;'
                          'const b=e.getBoundingClientRect();'
                          'return {x:+(b.left+b.width/2).toFixed(1), y:+(b.top+b.height/2).toFixed(1),'
                          'w:+b.width.toFixed(1), h:+b.height.toFixed(1)};})()' % json.dumps(sel),
               returnByValue=True)
    return r['result'].get('value')


def move(c, x, y):
    c.send('Input.dispatchMouseEvent', type='mouseMoved', x=x, y=y, button='none', buttons=0)
    time.sleep(0.5)   # 260ms 过渡 + 余量


def shot(c, path, clip):
    r = c.send('Page.captureScreenshot', format='png', clip=dict(clip, scale=1))
    with open(path, 'wb') as f:
        f.write(base64.b64decode(r['data']))


HOVER_BG = 'rgba(255, 255, 255, 0.16)'


def is_full_ring(shadow):
    """Chromium 把 `0 0 0 2px X` 序列化成 `X 0px 0px 0px 2px`（颜色在前、带 px）。
    这里归一化再比，免得断言被序列化格式绊倒。"""
    return '0 0 0 2px' in (shadow or '').replace('0px', '0')


def main():
    os.makedirs(SHOTS, exist_ok=True)
    os.makedirs(OUTDIR, exist_ok=True)
    c = cdp()
    res, fails = {}, []

    try:
        # 先把鼠标挪开，取干净的「静止态」
        move(c, 5, 5)
        base = {}
        for k, sel in TARGETS.items():
            base[k] = read(c, sel)
        res['base'] = base

        print('===== 静止态 =====')
        for k, v in base.items():
            print('  %-10s bg=%s transform=%s' % (k, v and v['background'], v and v['transform']))

        print('\n===== hover 态 =====')
        # 先把焦点清干净 —— 之前那一轮 focus() 留下的焦点环会挂在 boxShadow 上，
        # 不清的话读到的「hover 态阴影」其实是上一个断言的残留（第一版就栽在这）。
        c.send('Runtime.evaluate',
               expression='document.activeElement && document.activeElement.blur(), "blurred"',
               returnByValue=True)
        for k, sel in TARGETS.items():
            pt = center(c, sel)
            if not pt:
                print('  %-10s 元素不存在，跳过' % k)
                continue
            move(c, pt['x'], pt['y'])
            hv = read(c, sel)
            res.setdefault('hover', {})[k] = hv
            print('  %-10s bg=%s transform=%s shadow=%s' % (
                k, hv['background'], hv['transform'], hv['boxShadow'][:60]))
            shot(c, os.path.join(SHOTS, 'H1-hover-%s.png' % k),
                 {'x': 0, 'y': 0, 'width': 340, 'height': 300})

        # ---- 断言 1：头像 hover 必须是底色块、且不再位移 ----
        av_b, av_h = base.get('avatar'), res.get('hover', {}).get('avatar')
        if av_h:
            cond_bg = av_h['background'] == HOVER_BG
            cond_no_move = av_h['transform'] in ('none', 'matrix(1, 0, 0, 1, 0, 0)')
            msg = 'bg=%s（期望 %s）transform=%s（期望 none）' % (
                av_h['background'], HOVER_BG, av_h['transform'])
            if cond_bg and cond_no_move:
                print('PASS  头像 hover = 底色块、无位移 :: ' + msg)
            else:
                fails.append('头像 hover: ' + msg)
                print('FAIL  头像 hover :: ' + msg)
            # 旧的「上浮 + 投影」痕迹：静止/hover 都不该有位移，hover 不该有投影
            if 'translate' in av_h['transform'] or 'matrix(1, 0, 0, 1, 0, -1' in av_h['transform']:
                fails.append('头像 hover 仍有位移痕迹：%s' % av_h['transform'])
                print('FAIL  头像 hover 仍有 translateY（旧写法未删干净）')

        # ---- 断言 2：全局图标 hover 底色一致 ----
        #
        # 注意：**当前选中**的那个图标（.wtRail__item--on）hover 时故意保持品牌渐变，
        # 不铺 --wt-icon-hover —— 这是设计稿的选中态规则，不是 bug。
        # 所以一致性只在「未选中」的图标之间比。
        print('\n===== 四个全局图标 hover 一致性 =====')
        on_key = None
        for k in ['chat', 'knowledge', 'plugins', 'settings']:
            r = c.send('Runtime.evaluate',
                       expression='(() => { const e=document.querySelector(%s);'
                                  'return e ? e.className.includes("--on") : null;})()'
                                  % json.dumps('[data-wt-global="%s"]' % k),
                       returnByValue=True)
            if r['result'].get('value'):
                on_key = k
                break
        res['selectedIcon'] = on_key
        if on_key:
            print('  当前选中：%s（选中态 hover 保持品牌渐变，不参与底色一致性比较）' % on_key)

        off = [k for k in ['chat', 'knowledge', 'plugins', 'settings'] if k != on_key]
        bgs = {k: (res.get('hover', {}).get(k) or {}).get('background') for k in off}
        uniq = set(bgs.values())
        print('  未选中图标 hover 底色：%s' % json.dumps(bgs, ensure_ascii=False))
        if len(uniq) == 1 and list(uniq)[0] == HOVER_BG:
            print('PASS  未选中图标（含设置）hover 底色完全一致 = %s' % HOVER_BG)
        else:
            fails.append('图标 hover 底色不一致：%s' % bgs)
            print('FAIL  图标 hover 底色不一致（期望都为 %s）' % HOVER_BG)

        # ---- 断言 3：:focus-visible 焦点环仍在 ----
        print('\n===== 键盘 :focus-visible 焦点环 =====')
        focus_rows = []
        for k, sel in TARGETS.items():
            # 用键盘 Tab 之外的可靠办法：先 blur，再用 CDP 让它 focus 并标记键盘来源。
            # 直接 el.focus() 会命中 :focus-visible（Chromium 对非指针 focus 视为键盘）
            r = c.send('Runtime.evaluate',
                       expression='(() => { const e=document.querySelector(%s); if(!e) return null;'
                                  'e.blur(); e.focus(); const cs=getComputedStyle(e);'
                                  'return {matched: e.matches(":focus-visible"), boxShadow: cs.boxShadow};})()'
                                  % json.dumps(sel),
                       returnByValue=True, userGesture=True)
            v = r['result'].get('value')
            focus_rows.append((k, v))
            print('  %-10s :focus-visible=%-5s boxShadow=%s' % (
                k, v and v['matched'], (v or {}).get('boxShadow', '')[:60]))
        res['focus'] = {k: v for k, v in focus_rows}

        ring_missing = []
        for k, v in focus_rows:
            # back 按钮只在项目切换模式存在，默认态缺席不算失败
            if v is None:
                if k == 'back':
                    print('  注：%s 在当前模式不存在（项目切换模式才有），跳过' % k)
                    continue
                ring_missing.append(k)
                continue
            if not (v.get('matched') and is_full_ring(v.get('boxShadow'))):
                ring_missing.append(k)
        if ring_missing:
            fails.append(':focus-visible 焦点环缺失：%s' % ring_missing)
            print('FAIL  以下元素没有 2px 焦点环：%s' % ring_missing)
        else:
            print('PASS  全部 :focus-visible 焦点环都在（0 0 0 2px）')

        with open(os.path.join(OUTDIR, '06-hover-focus.json'), 'w', encoding='utf-8') as f:
            json.dump(res, f, indent=2, ensure_ascii=False)

        print('\n结论：%s' % ('全部通过' if not fails else '失败项：%s' % fails))
        return 1 if fails else 0
    finally:
        try:
            c.ws.close()
        except Exception:  # noqa: BLE001
            pass


if __name__ == '__main__':
    sys.exit(main())
