#!/usr/bin/env python3
"""2026-09-25 主动发现 P-1/P-2/P-3 的反证:把三处修复**分别**拆掉,验收必须当场红。

  L1  池包装 rowCount 改回旧公式(res.rows?length:affectedRows)→ 写语句 rowCount 恒 0,
      删/开关/忘白板全误 404。(P-3,根因)
  L2  空 body 宽容解析改回「拒绝」→ 带 JSON 头的 DELETE 又变 400/500,删不掉定时任务。(P-2)
  L3  /memories/confirm 的 changed 改回 ids.length → 重复确认也谎报「变了 1 条」。(P-1)

跑法:python3 scripts/verify/routines-lifecycle-revert-proof.py
"""
from __future__ import annotations

import hashlib
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

DB = REPO / 'apps' / 'server' / 'src' / 'db.ts'
INDEX = REPO / 'apps' / 'server' / 'src' / 'index.ts'
MEM = REPO / 'apps' / 'server' / 'src' / 'routes' / 'memories.ts'

MUTATIONS = [
    {
        'id': 'L1',
        'file': DB,
        'name': 'pglite 池包装 rowCount 改回旧公式(写语句恒 0 → 删/开关/忘全部误 404)',
        'anchor': '          rowCount: res.rowCount ?? res.affectedRows ?? (res.rows?.length ?? 0),',
        'replace': '          rowCount: res.rows ? res.rows.length : (res.affectedRows ?? 0),',
        'expect': 'setRoutineEnabled(false)',
    },
    {
        'id': 'L2',
        'file': INDEX,
        'name': '空 body 宽容解析改回「拒绝」(带 JSON 头的 DELETE 删不掉)',
        'anchor': '      done(null, undefined);',
        'replace': "      done(new Error('FST_ERR_CTP_EMPTY_JSON_BODY'), undefined); // 反证注入:空 body 拒绝",
        'expect': 'P-2:DELETE 带 content-type',
    },
    {
        'id': 'L3',
        'file': MEM,
        'name': '/memories/confirm 的 changed 改回 ids.length(重复确认谎报 1 条)',
        'anchor': '      return { ok: true, changed, target };',
        'replace': '      return { ok: true, changed: ids.length, target };',
        'expect': '重复确认应 changed=0',
    },
]


def md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def main() -> int:
    ok = 0
    for mut in MUTATIONS:
        target = mut['file']
        original_bytes = target.read_bytes()
        original = original_bytes.decode('utf8').replace('\r\n', '\n')
        assert original.count(mut['anchor']) == 1, f"{mut['id']} 锚点不唯一: {mut['anchor'][:50]}"
        mut_name = mut['name']
        target.write_text(original.replace(mut['anchor'], mut['replace'], 1), encoding='utf8', newline='')
        try:
            proc = subprocess.run(
                [NODE, TSX_CLI, 'scripts/verify/routines-lifecycle.mts'],
                cwd=REPO, capture_output=True, text=True, timeout=600,
            )
        finally:
            target.write_bytes(original_bytes)
            # ★ 2026-09-26 修：这里的判据必须是「**还原后的字节 == 原始字节**」。
            #   原来比的是 `md5(original.encode())`，而 original 是 `decode().replace('\r\n','\n')`
            #   —— 在 CRLF 文件（本仓 *.ts 都是 CRLF）上这个 md5 永远对不上，
            #   于是文件**其实已按字节还原**、脚本却自己报「L1 还原失败」并 rc=1（假红）。
            assert md5(target) == hashlib.md5(original_bytes).hexdigest(), f"{mut['id']} 还原失败"

        lines = (proc.stdout + proc.stderr).splitlines()
        hit = []
        for i, ln in enumerate(lines):
            if ln.strip().startswith('✗'):
                hit.append(ln.strip())
                for nxt in lines[i + 1:i + 4]:
                    if nxt.strip().startswith('✗') or not nxt.strip():
                        break
                    hit.append(nxt.strip())
        hit_ok = any(mut['expect'] in h for h in hit)
        red_ok = proc.returncode != 0
        good = red_ok and hit_ok
        ok += 1 if good else 0
        print(f"--- {mut['id']} {mut_name}")
        print(f"  注入后:退出码={proc.returncode}  命中期望断言={'是' if hit_ok else '否'}")
        for h in hit[:6]:
            print(f"    {h}")
        print(f"  {'✓' if good else '✗'} 反证{'成立' if good else '失败(网漏了!)'}\n")
    print(f'=== 反证结论: {ok}/{len(MUTATIONS)} 处拆掉都红 ===')
    return 0 if ok == len(MUTATIONS) else 1


if __name__ == '__main__':
    raise SystemExit(main())
