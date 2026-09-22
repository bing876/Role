"""
UI-1.5：量当前 React 应用（运行在 9333/5273）里列0 图标与列1 的真实渲染尺寸。
只读，不改任何文件。

用法：
  python scripts/verify/ui15-probe-icons.py
"""
import json
import os
import sys
import urllib.request

PORT = os.environ.get('WB20_PORT', '9333')
MATCH = os.environ.get('WB20_MATCH', 'localhost:5273')


def http(path, tries=4):
    last = None
    for _ in range(tries):
        try:
            op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            return json.load(op.open('http://127.0.0.1:%s%s' % (PORT, path), timeout=15))
        except Exception as e:  # noqa: BLE001
            last = e
    raise RuntimeError('CDP HTTP %s 失败：%s' % (path, last))


def find_page():
    lst = http('/json/list')
    for t in lst:
        if t.get('type') == 'page' and MATCH in (t.get('url') or ''):
            return t
    raise RuntimeError('NO_PAGE; saw=%s' % [(t.get('type'), t.get('url')) for t in lst])


JS = r"""
(() => {
  const out = {};
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const svg = el.querySelector('svg');
    const sr = svg ? svg.getBoundingClientRect() : null;
    return {
      sel,
      rect: { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
      width: cs.width, height: cs.height,
      borderRadius: cs.borderRadius,
      background: cs.backgroundColor,
      backgroundImage: cs.backgroundImage === 'none' ? 'none' : 'has-image',
      backgroundSize: cs.backgroundSize,
      padding: cs.padding,
      gap: cs.gap,
      color: cs.color,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      borderRight: cs.borderRight,
      boxShadow: cs.boxShadow,
      backdropFilter: cs.backdropFilter,
      zIndex: cs.zIndex,
      iconVar: cs.getPropertyValue('--icon-size').trim(),
      svgRect: sr ? { w: +sr.width.toFixed(2), h: +sr.height.toFixed(2) } : null,
      text: (el.textContent || '').trim().slice(0, 20),
    };
  };
  out.app = pick('.wtApp');
  out.rail = pick('.wtRail');
  out.railMe = pick('.wtRail__me');
  out.railNav = pick('.wtRail__nav');
  out.itemChat = pick('[data-wt-global="chat"]');
  out.itemKb = pick('[data-wt-global="knowledge"]');
  out.itemPlugins = pick('[data-wt-global="plugins"]');
  out.itemSettings = pick('[data-wt-global="settings"]');
  out.sb = pick('.wtSb');
  out.sbHead = pick('.wtSb__head');
  out.sbRow = pick('.wtSb__row');
  out.sbAvatar = pick('.wtSb__avatar');
  out.sbName = pick('.wtSb__name');
  out.sbStatus = pick('.wtSb__status');
  // 所有 rail svg 的真实尺寸
  out.railSvgs = [...document.querySelectorAll('.wtRail svg')].map((s) => {
    const r = s.getBoundingClientRect();
    return { w: +r.width.toFixed(2), h: +r.height.toFixed(2), cls: s.parentElement.className };
  });
  return out;
})()
"""


def main():
    t = find_page()
    ws_url = t['webSocketDebuggerUrl']
    try:
        import websocket  # noqa: F401
    except ImportError:
        print('NEED websocket-client', file=sys.stderr)
        return 2
    import websocket as _ws

    conn = _ws.create_connection(ws_url, timeout=20, suppress_origin=True)
    try:
        conn.send(json.dumps({'id': 1, 'method': 'Runtime.evaluate',
                              'params': {'expression': JS, 'returnByValue': True, 'awaitPromise': True}}))
        while True:
            msg = json.loads(conn.recv())
            if msg.get('id') == 1:
                res = msg.get('result', {})
                if 'exceptionDetails' in res:
                    print('JS ERROR:', json.dumps(res['exceptionDetails'], ensure_ascii=False)[:800])
                    return 1
                print(json.dumps(res['result'].get('value'), indent=2, ensure_ascii=False))
                return 0
    finally:
        conn.close()


if __name__ == '__main__':
    sys.exit(main())
