#!/usr/bin/env python3
"""2026-09-25 G1（管家专权创建）· 反证：把修好的机制**分别**拆掉，验收必须当场红。

  R1  chat 建人分支退回「有小助就建」（忽略发言人 → 非小助也能建）
  R2  拆掉转发记录写库（非小助「创建」只回话、不转发进小助会话）
  R3  转发话术改回别的（「这个由管家来建,我转给它」丢失）
  R4  POST /agents 权限退回 canCreateAgents（母鸡当调用者也能建）
  R5  拆掉 auth 首进空项目的搭团队提议（小助不再主动提议）

跑法：python3 scripts/verify/xiaozhu-creation-revert-proof.py
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

CHAT = REPO / 'apps' / 'server' / 'src' / 'routes' / 'chat.ts'
AGENTS = REPO / 'apps' / 'server' / 'src' / 'routes' / 'agents.ts'
AUTH = REPO / 'apps' / 'server' / 'src' / 'routes' / 'auth.ts'

MUTATIONS = [
    {
        'id': 'R1',
        'name': 'chat 建人分支退回「有小助就建」（忽略发言人,非小助也能建）',
        'file': CHAT,
        'repls': [
            (
                """            if (xiaozhuId !== null && speakerIsXiaozhu) {
              // ④ 小助说「建一个XXX」→ 立刻建好（creator = 小助）
""",
                """            if (xiaozhuId !== null) {  // 反证注入：忽略发言人,有小助就建
              // ④ 小助说「建一个XXX」→ 立刻建好（creator = 小助）
""",
            ),
        ],
        'expect': '智能体数量变了',
    },
    {
        'id': 'R2',
        'name': '拆掉转发记录写库（非小助「创建」只回话、不转发进小助会话）',
        'file': CHAT,
        'repls': [
            (
                """                  const fwdMsg = `（转发）请创建「${buildIntent.name}」：${buildIntent.duty}。`;
                  await pool.query(
                    "INSERT INTO messages (conversation_id, role, content_enc, speaker_agent_id) VALUES ($1, 'assistant', $2, $3)",
                    [xzConv, cipher.encryptText(fwdMsg), xiaozhuId],
                  );
""",
                """                  const fwdMsg = `（转发）请创建「${buildIntent.name}」：${buildIntent.duty}。`;
                  void fwdMsg; // 反证注入：不写转发记录
""",
            ),
        ],
        'expect': '没有转发记录',
    },
    {
        'id': 'R3',
        'name': '转发话术改回别的（「这个由管家来建,我转给它」丢失）',
        'file': CHAT,
        'repls': [
            (
                "              replyMsg = '这个由管家来建，我转给它。';\n",
                "              replyMsg = '好的，我来建。'; // 反证注入：话术被改\n",
            ),
        ],
        'expect': '回话不含转发话术',
    },
    {
        'id': 'R4',
        'name': 'POST /agents 权限退回 canCreateAgents（母鸡当调用者也能建）',
        'file': AGENTS,
        'repls': [
            (
                "      if (caller.kind !== 'assistant' || !caller.canCreateAgents) {\n",
                "      if (!caller.canCreateAgents) { // 反证注入：退回旧闸（母鸡放行）\n",
            ),
        ],
        'expect': '母鸡建人应 403',
    },
    {
        'id': 'R5',
        'name': '拆掉 auth 首进空项目的搭团队提议（小助不再主动提议）',
        'file': AUTH,
        'repls': [
            (
                """            const { seedColleagueProposal } = await import('../orchestrator/agentBuilder');
            await seedColleagueProposal(
              pool,
              cipher,
              Number(created.userId),
              Number(created.createdProject.id),
              String(created.createdProject.name ?? '默认项目'),
              Number(created.createdAgent.id),
            );
""",
                """            void 0; // 反证注入：首进空项目不提议
""",
            ),
        ],
        'expect': '小助会话里没有消息',
    },
]


def main() -> int:
    ok = 0
    for mut in MUTATIONS:
        target: Path = mut['file']
        original_bytes = target.read_bytes()
        original = original_bytes.decode('utf8').replace('\r\n', '\n')
        mutated = original
        for anchor, repl in mut['repls']:
            assert mutated.count(anchor) == 1, f"{mut['id']} 锚点不唯一: {anchor[:60]}"
            mutated = mutated.replace(anchor, repl, 1)
        target.write_text(mutated, encoding='utf8', newline='')
        try:
            proc = subprocess.run(
                [NODE, TSX_CLI, 'scripts/verify/xiaozhu-creation.mts'],
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
        print(f"  注入后：退出码={proc.returncode}  命中期望断言={'是' if hit_ok else '否'}")
        for h in hit[:6]:
            print(f"    {h}")
        print(f"  {'✓' if good else '✗'} 反证{'成立' if good else '失败（网漏了！）'}\n")
    print(f'=== 反证结论：{ok}/{len(MUTATIONS)} 处拆掉都红 ===')
    return 0 if ok == len(MUTATIONS) else 1


if __name__ == '__main__':
    raise SystemExit(main())
