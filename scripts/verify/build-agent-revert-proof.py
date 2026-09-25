#!/usr/bin/env python3
"""QA-02 的反证:把"立刻建好"拆回旧病,验收必须当场红。

  B1  建的动作被掏空(回话照说"已建好",库里没有)→ 红在"库里真的多了销售助手"。
      —— 说建了没建,比问确认更坏(用户以为建好了,其实没有)。
  B2  回话换回旧的"确认就建?"话术(二次确认死灰复燃)→ 红在"全程不出现确认就建"。

跑法:python3 scripts/verify/build-agent-revert-proof.py
"""
from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CHAT = REPO / 'apps' / 'server' / 'src' / 'routes' / 'chat.ts'

BUILD_LINE = '              const built = await abMod.buildAgentImmediately(pool, cipher, claims.sub, projForBuild, finalCreatorId, buildIntent);'
REPLY_LINE = '              const builtMsg = `已建好「${built.name}」：${buildIntent.duty}。直接和TA聊就行，对话里说"建一个XXX"就能继续建同事，不挡你。`;'

MUTATIONS = [
    {
        'id': 'B1',
        'name': '建的动作被掏空(回话说建好,库里没有)',
        'anchor': BUILD_LINE,
        'replace': '              const built = { agentId: -1, name: buildIntent.name, conversationId: null };',
        'expect': '库里真的多了',
    },
    {
        'id': 'B2',
        'name': '回话换回旧的"确认就建?"话术(二次确认死灰复燃)',
        'anchor': REPLY_LINE,
        'replace': '              const builtMsg = `要建一个「${built.name}」，职责：${buildIntent.duty}，确认就建？（回"确认/可以/建吧"）`;',
        'expect': '确认就建',
    },
]


def run_e2e() -> tuple[int, str]:
    proc = subprocess.run(
        ['node', 'scripts/verify/build-agent-e2e.mjs'],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=600,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    original = CHAT.read_text(encoding='utf8')
    before = hashlib.md5(original.encode('utf8')).hexdigest()
    print('')
    print('=== QA-02 · 反证:"立刻建好"拆回旧病,验收必须红 ===')

    caught = 0
    problems: list[str] = []
    for m in MUTATIONS:
        src = CHAT.read_text(encoding='utf8')
        if src.count(m['anchor']) != 1:
            problems.append(f"{m['id']} 锚点在源码里出现 {src.count(m['anchor'])} 次(应为 1)—— 反证脚本失效")
            continue
        CHAT.write_text(src.replace(m['anchor'], m['replace'], 1), encoding='utf8')
        try:
            # 变异动的是 src,得重新 build 再打 e2e(e2e 打的是 dist)
            build = subprocess.run(['npm', 'run', 'build', '-w', '@ai-workbench/server'],
                                   cwd=REPO, capture_output=True, text=True, timeout=600)
            if build.returncode != 0:
                code, out = 0, build.stdout + build.stderr + '\n(build 失败,见上)'
            else:
                code, out = run_e2e()
        finally:
            CHAT.write_text(src, encoding='utf8')
        hit = m['expect'] in out
        print('')
        print(f"--- {m['id']} {m['name']}")
        print(f"  注入后 e2e 退出码={code}(应非 0)")
        for ln in out.splitlines():
            if ln.strip().startswith('[FAIL]'):
                print(f'    {ln.strip()}')
        if code != 0 and hit:
            caught += 1
            print(f"  ✓ 变红,且命中「{m['expect']}」")
        else:
            problems.append(f"{m['id']} 没被咬住(退出码={code},命中={hit})")
            print(f"  ★★ 没咬住:退出码={code},期望命中「{m['expect']}」")
        after = hashlib.md5(CHAT.read_text(encoding='utf8').encode('utf8')).hexdigest()
        print(f"  ✓ 已还原,md5 {'逐字节一致' if after == before else '★ 不一致 ' + after}")

    print('')
    print('=== 结论 ===')
    print(f'  注入 {len(MUTATIONS)} 个缺陷,被验收抓到 {caught} 个')
    for p in problems:
        print(f'  ★ {p}')
    print(f'  反证失败项:{len(problems)}')

    # 还原后再 build 一次,把 dist 恢复成本次代码
    build = subprocess.run(['npm', 'run', 'build', '-w', '@ai-workbench/server'],
                           cwd=REPO, capture_output=True, text=True, timeout=600)
    code, out = run_e2e()
    print(f'  还原后 e2e 退出码={code}(应 0)')
    if code != 0:
        problems.append('还原后 e2e 仍然红 —— 源码没还原干净')
        for ln in out.splitlines():
            if ln.strip().startswith('[FAIL]'):
                print(f'    {ln.strip()}')
    print(f'  最终反证失败项:{len(problems)}')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
