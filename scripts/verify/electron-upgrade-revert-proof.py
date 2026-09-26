#!/usr/bin/env python3
"""2026-09-26 阶段 3 · Electron 升级 · 反证(每片把回退目标改成上一片装后版本):
把「升级真的发生了/声明真的改了」分别拆掉,验收必须当场红。

当前片:第六片(42→44,43–44 合并到最新稳定),回退目标 = 第五片装后版本 42.11.8。
  M1  装后版本回退(node_modules/electron 实际版本改回 42.x,声明仍是 ^44)
      → 红在「装后版本核对」—— 证明验收查的是**装上的版本**,不是声明。
  M2  声明回退(apps/desktop/package.json 改回 ^42.11.8)
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

# ★ Windows 修（2026-09-26）：CreateProcess 只按 `.exe` 补后缀，**不解析 `.cmd`**，
# 而 PATH 上只有 npx.cmd ⇒ `['npx', ...]` 必 FileNotFoundError: [WinError 2]。
# 改成「当前 node + 本地 tsx CLI」，跨平台且不依赖 npx / PATH。
import os as _os
import shutil as _shutil
from pathlib import Path as _Path

_REPO_PATH = _Path(str(REPO))
NODE = _shutil.which('node') or 'node'
TSX_CLI = str(_REPO_PATH / 'node_modules' / 'tsx' / 'dist' / 'cli.mjs')

INSTALLED = REPO / 'node_modules' / 'electron' / 'package.json'
DECLARED = REPO / 'apps' / 'desktop' / 'package.json'

MUTATIONS = [
    {
        'id': 'M1',
        'name': '装后版本回退(node_modules/electron 改回上一片 42.x,声明仍 ^44)',
        'target': INSTALLED,
        'mutate': lambda pj: (pj.update(version='42.11.8'), pj)[1],
        'expect': '装后版本核对',
    },
    {
        'id': 'M2',
        'name': '声明回退(apps/desktop/package.json 改回 ^42.11.8)',
        'target': DECLARED,
        'mutate': lambda pj: (pj['devDependencies'].update(electron='^42.11.8'), pj)[1],
        'expect': '声明核对',
    },
]


def main() -> int:
    ok = 0
    for mut in MUTATIONS:
        target: Path = mut['target']
        original_bytes = target.read_bytes()
        original = original_bytes.decode('utf8').replace('\r\n', '\n')
        pj = json.loads(original)
        mut['mutate'](pj)
        target.write_text(json.dumps(pj, indent=2, ensure_ascii=False) + '\n', encoding='utf8')
        try:
            proc = subprocess.run(
                [NODE, TSX_CLI, 'scripts/verify/electron-upgrade.mts'],
                cwd=REPO, capture_output=True, text=True, timeout=600,
            )
        finally:
            target.write_bytes(original_bytes)
            assert hashlib.md5(target.read_bytes()).hexdigest() == hashlib.md5(original_bytes).hexdigest(), f"{mut['id']} 还原失败"

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
