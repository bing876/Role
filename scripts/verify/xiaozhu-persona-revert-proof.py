#!/usr/bin/env python3
"""2026-09-25 G2（小助默认身份 + anti-jobs + 整份人设）· 反证：把修好的机制**分别**拆掉，验收必须当场红。

  R1  parsePersona 不读回 antiJobs/description（读回路径拆掉）
  R2  buildIdentityBlock 小助块不注入「不干什么」+「整份人设」
  R3  auth 建号小助不再写默认人设（建号 seed 拆掉 → 读回是 null）
  R4  db 启动迁移不再回填 NULL 小助（存量回填拆掉）
  R5  validatePersonaInput 不收 antiJobs/description（校验链路拆掉）

跑法：python3 scripts/verify/xiaozhu-persona-revert-proof.py
"""
from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
AGENTS = REPO / 'apps' / 'server' / 'src' / 'routes' / 'agents.ts'
IDENT = REPO / 'apps' / 'server' / 'src' / 'identityBlock.ts'
AUTH = REPO / 'apps' / 'server' / 'src' / 'routes' / 'auth.ts'
DB = REPO / 'apps' / 'server' / 'src' / 'db.ts'

MUTATIONS = [
    {
        'id': 'R1',
        'name': 'parsePersona 不读回 antiJobs/description（读回路径拆掉）',
        'file': AGENTS,
        'repls': [
            (
                """  const p: AgentPersona = {
    name,
    who: oneLine(o.who, PERSONA_FIELD_MAX),
    tone: oneLine(o.tone, PERSONA_FIELD_MAX),
    duty: oneLine(o.duty, PERSONA_FIELD_MAX),
  };
  // G2：不干什么（anti-jobs）+ 整份人设（description）也要读回（左栏/人设接口/读回验收）
  const antiJobs = oneLine(o.antiJobs, 240);
  if (antiJobs) p.antiJobs = antiJobs;
  const description = oneLine(o.description, 600);
  if (description) p.description = description;
  return p;
""",
                """  return {
    name,
    who: oneLine(o.who, PERSONA_FIELD_MAX),
    tone: oneLine(o.tone, PERSONA_FIELD_MAX),
    duty: oneLine(o.duty, PERSONA_FIELD_MAX),
  };
""",
            ),
        ],
        'expect': '与整份人设不一致',
    },
    {
        'id': 'R2',
        'name': 'personaLines 不注入「不干什么」+「整份人设」（提示词注入路径拆掉）',
        'file': IDENT,
        'repls': [
            (
                """    p.duty ? `干什么：${p.duty}` : '',
    p.antiJobs ? `不干什么：${p.antiJobs}` : '',
    p.description ? `整份人设：${p.description}` : '',
  ].filter(Boolean);
""",
                """    p.duty ? `干什么：${p.duty}` : '',
  ].filter(Boolean);
""",
            ),
        ],
        'expect': '身份块缺「不干什么」行',
    },
    {
        'id': 'R3',
        'name': 'auth 建号小助不再写默认人设（建号 seed 拆掉）',
        'file': AUTH,
        'repls': [
            (
                """              "INSERT INTO agents (project_id, name, kind, persona, persona_status, can_create_agents) VALUES ($1, '小助', 'assistant', $2, 'ready', true) RETURNING id, name",
              [p.rows[0].id, JSON.stringify(XIAOZHU_PERSONA)],
""",
                """              "INSERT INTO agents (project_id, name, kind, can_create_agents) VALUES ($1, '小助', 'assistant', true) RETURNING id, name",
              [p.rows[0].id],
""",
            ),
        ],
        'expect': '读回是 null',
    },
    {
        'id': 'R4',
        'name': 'db 启动迁移不再回填 NULL 小助（存量回填拆掉）',
        'file': DB,
        'repls': [
            (
                """    const xz = await pool.query(
      "UPDATE agents SET persona = $1::jsonb, persona_status = 'ready' WHERE kind = 'assistant' AND (persona IS NULL OR persona = 'null'::jsonb)",
      [JSON.stringify(XIAOZHU_PERSONA)],
    );
""",
                """    const xz = await pool.query('SELECT 1');
""",
            ),
        ],
        'expect': '没回填成默认',
    },
    {
        'id': 'R5',
        'name': 'validatePersonaInput 不收 antiJobs/description（校验链路拆掉）',
        'file': IDENT,
        'repls': [
            (
                """  const antiJobs = oneLine(raw.antiJobs, 240);
  if (antiJobs) persona.antiJobs = antiJobs;
  const description = oneLine(raw.description, 600);
  if (description) persona.description = description;
  return { ok: true, persona };
""",
                """  return { ok: true, persona };
""",
            ),
        ],
        'expect': '丢了 antiJobs',
    },
]


def main() -> int:
    ok = 0
    for mut in MUTATIONS:
        target: Path = mut['file']
        original = target.read_text(encoding='utf8')
        mutated = original
        for anchor, repl in mut['repls']:
            assert mutated.count(anchor) == 1, f"{mut['id']} 锚点不唯一: {anchor[:60]}"
            mutated = mutated.replace(anchor, repl, 1)
        target.write_text(mutated, encoding='utf8')
        try:
            proc = subprocess.run(
                ['npx', 'tsx', 'scripts/verify/xiaozhu-persona.mts'],
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
        print(f"  注入后：退出码={proc.returncode}  命中期望断言={'是' if hit_ok else '否'}")
        for h in hit[:6]:
            print(f"    {h}")
        print(f"  {'✓' if good else '✗'} 反证{'成立' if good else '失败（网漏了！）'}\n")
    print(f'=== 反证结论：{ok}/{len(MUTATIONS)} 处拆掉都红 ===')
    return 0 if ok == len(MUTATIONS) else 1


if __name__ == '__main__':
    raise SystemExit(main())
