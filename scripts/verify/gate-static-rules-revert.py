#!/usr/bin/env python3
"""`gate-static-rules.py` 的**反证**：证明那几条门禁真的拦得住东西。

门禁本身也会假绿（写错正则、白名单写太宽），所以照其它反证脚本的规矩：
往真实文件里注入**真的违规写法** → 门禁必须变红 → 立刻还原 → md5 逐字节一致。

  R1' 往 `scripts/verify/app-logic-smoke.run.tsx` 末尾塞一条 `assert.equal(q("…"), null)`
  R2' 给 `useBrowserGlue` 加第二处生产调用点
  R3' 把某一片的 `visible` 标记全部改成 False

用法：python3 scripts/verify/gate-static-rules-revert.py
"""
from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GATE = REPO / 'scripts' / 'verify' / 'gate-static-rules.py'
LOGIC_NET = REPO / 'scripts' / 'verify' / 'app-logic-smoke.run.tsx'
APP = REPO / 'apps' / 'desktop' / 'src' / 'App.tsx'
REVERT = REPO / 'scripts' / 'verify' / 'app-logic-smoke-revert.py'


def md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def run_gate() -> tuple[int, str]:
    r = subprocess.run([sys.executable, str(GATE)], capture_output=True, text=True, cwd=REPO)
    return r.returncode, r.stdout + r.stderr


FAILURES = [
    {
        'id': "R1'",
        'name': '验收网里把 DOM 元素交给 assert.equal',
        'file': LOGIC_NET,
        'apply': lambda s: s + '\n// gate-revert-selftest\nassert.equal(q(".helpCard"), null);\n',
        'undo': None,  # 追加式 → 用原文件还原
        'expect': 'R1',
    },
    {
        'id': "R2'",
        'name': '给 useBrowserGlue 加第二处生产调用点（状态分裂）',
        'file': APP,
        'apply': lambda s: s.replace(
            '  } = useBrowserGlue({ browser, curAgentId, onNote: setChatNote });',
            '  } = useBrowserGlue({ browser, curAgentId, onNote: setChatNote });\n'
            '  var _secondGlue = useBrowserGlue({ browser, curAgentId, onNote: setChatNote });',
        ),
        'expect': 'R2',
    },
    {
        'id': "R3'",
        'name': '把 G 那一片的 visible 标记全改成 False',
        'file': REVERT,
        'apply': lambda s: s.replace("'visible': True,", "'visible': False,").replace(
            "'id': 'K1',", "'id': 'K1',"
        ) if False else s.replace(
            "'id': 'G1',\n        'visible': True,", "'id': 'G1',\n        'visible': False,"
        ).replace(
            "'id': 'G2',\n        'visible': True,", "'id': 'G2',\n        'visible': False,"
        ).replace(
            "'id': 'G4',\n        'visible': True,", "'id': 'G4',\n        'visible': False,"
        ).replace(
            "'id': 'G5',\n        'visible': True,", "'id': 'G5',\n        'visible': False,"
        ),
        'expect': 'user-visible',
    },
]


def main() -> int:
    print('=== 门禁的反证：往真实文件里注入违规，看它拦不拦得住 ===')
    caught = 0
    for m in FAILURES:
        f: Path = m['file']
        before = f.read_text(encoding='utf8')
        try:
            f.write_text(m['apply'](before), encoding='utf8')
            code, out = run_gate()
            if code != 0 and m['expect'] in out:
                hit = next((l.strip() for l in out.splitlines() if m['expect'] in l), '')
                print(f'--- {m["id"]} {m["name"]}')
                print(f'  ✓ 门禁变红，且命中「{m["expect"]}」：{hit[:110]}')
                caught += 1
            else:
                print(f'--- {m["id"]} {m["name"]}')
                print(f'  ★ 门禁没拦住（退出码={code}，找「{m["expect"]}」）—— 这条门禁是空的')
        finally:
            f.write_text(before, encoding='utf8')
            if md5(f) != hashlib.md5(before.encode('utf8')).hexdigest():
                print(f'  ★★ 还原失败，{f.name} 的 md5 对不上！')
    print()
    print('=== 结论 ===')
    if caught == len(FAILURES):
        print(f'  {caught}/{len(FAILURES)} 条门禁都咬得住（注入 → 变红 → 还原一致）')
        return 0
    print(f'  {caught}/{len(FAILURES)} 条门禁有效，{len(FAILURES) - caught} 条是空的')
    return 1


if __name__ == '__main__':
    sys.exit(main())
