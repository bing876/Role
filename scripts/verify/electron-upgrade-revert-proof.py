#!/usr/bin/env python3
"""2026-09-26 阶段 3 · Electron 升级 · 反证(每片把回退目标改成上一片装后版本):
把「升级真的发生了/声明真的改了」分别拆掉,验收必须当场红。

当前片:第二片(34→37,35–37 合并),回退目标 = 第一片装后版本 34.5.8。
  M1  装后版本回退(node_modules/electron 实际版本改回 34.x,声明仍是 ^37)
      → 红在「装后版本核对」—— 证明验收查的是**装上的版本**,不是声明。
  M2  声明回退(apps/desktop/package.json 改回 ^34.5.8)
      → 红在「声明核对」—— 证明验收查的是 package.json 声明,没被 lock/缓存绕过。

  (webview 红线本身的反证由既有 app-shell-smoke-revert.py R1–R4 承担,不重复造。)

跑法:python3 scripts/verify/electron-upgrade-revert-proof.py
"""
from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
INSTALLED = REPO / 'node_modules' / 'electron' / 'package.json'
DECLARED = REPO / 'apps' / 'desktop' / 'package.json'

MUTATIONS = [
    {
        'id': 'M1',
        'name': '装后版本回退(node_modules/electron 改回上一片 34.x,声明仍 ^37)',
        'target': INSTALLED,
        'mutate': lambda pj: (pj.update(version='34.5.8'), pj)[1],
        'expect': '装后版本核对',
    },
    {
        'id': 'M2',
        'name': '声明回退(apps/desktop/package.json 改回 ^34.5.8)',
        'target': DECLARED,
        'mutate': lambda pj: (pj['devDependencies'].update(electron='^34.5.8'), pj)[1],
        'expect': '声明核对',
    },
]


def main() -> int:
    ok = 0
    for mut in MUTATIONS:
        target: Path = mut['target']
        original = target.read_text(encoding='utf8')
        pj = json.loads(original)
        mut['mutate'](pj)
        target.write_text(json.dumps(pj, indent=2, ensure_ascii=False) + '\n', encoding='utf8')
        try:
            proc = subprocess.run(
                ['npx', 'tsx', 'scripts/verify/electron-upgrade.mts'],
                cwd=REPO, capture_output=True, text=True, timeout=600,
            )
        finally:
            target.write_text(original, encoding='utf8')
            assert hashlib.md5(target.read_bytes()).hexdigest() == hashlib.md5(original.encode()).hexdigest(), f"{mut['id']} 还原失败"

        lines = (proc.stdout + proc.stderr).splitlines()
        hit = []
        for i, ln in enumerate(lines):
            if ln.strip().startswith('✗'):
                hit.append(ln.strip())
                for nxt in lines[i + 1:i + 4]:
                    if nxt.strip().startswith('✗') or not nxt.strip():
                        break
                    hit.append(nxt.strip())
        red_ok = proc.returncode != 0
        hit_ok = any(mut['expect'] in h for h in hit)
        good = red_ok and hit_ok
        ok += 1 if good else 0
        print(f"--- {mut['id']} {mut['name']}")
        print(f"  注入后:退出码={proc.returncode}  命中期望断言={'是' if hit_ok else '否'}")
        for h in hit[:6]:
            print(f"    {h}")
        print(f"  {'✓' if good else '✗'} 反证{'成立' if good else '失败(网漏了!)'}\n")
    print(f'=== 反证结论:{ok}/{len(MUTATIONS)} 处拆掉都红 ===')
    return 0 if ok == len(MUTATIONS) else 1


if __name__ == '__main__':
    raise SystemExit(main())
