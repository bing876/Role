#!/usr/bin/env python3
"""阶段 1① · 逻辑抽离第 1 片（knowledge）的反证。

往**抽出去的 feature 源码**里注入「把代码搬出 App.tsx 时最可能犯的错」，
行为验收网 `verify:logic` 必须每次都变红、且命中对应断言：

  K1 丢守卫：`load` 里删掉「切号后晚到的响应不许覆盖列表」
  K2 放宽校验：扩展名白名单里塞进 .exe
  K3 图省事：`remove` 不再本地过滤，改成「等服务端重拉」
  K4 丢 body：DELETE 不送 `'{}'`（Fastify 会判 400 —— 仓库里踩过的老坑）

为什么要往 feature 里注入（而不是往 App.tsx 里）：这一片的价值就在于
**"搬出去之后行为一字未变"**，所以最该被证明的就是 feature 内部那几条守卫还在。

用法：python3 scripts/verify/app-logic-smoke-revert.py
"""
from __future__ import annotations

import hashlib
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FEATURES = REPO / 'apps' / 'desktop' / 'src' / 'features'
KNOWLEDGE = FEATURES / 'knowledge' / 'useKnowledge.ts'
MEMORY = FEATURES / 'memory' / 'useMemory.ts'
GLUE = FEATURES.parent / 'app' / 'browserGlue.ts'
PROJECTS = FEATURES / 'projects' / 'useProjects.ts'

MUTATIONS = [
    {
        'file': KNOWLEDGE,
        'id': 'K1',
        'visible': True,   # 红了之后用户能直接看见的输出变了？
        'name': 'load 里删掉「切号后晚到的响应不许覆盖列表」这条守卫',
        'anchor': "      // 切号期间晚到的 A 号响应不能覆盖 B 号列表。\n      if (sessionRef.current?.token !== sess.token) return;\n",
        'replace': "",
        'expect': 'A 号请求晚到时不许覆盖 B 号列表',
    },
    {
        'file': KNOWLEDGE,
        'id': 'K2',
        'visible': True,   # 红了之后用户能直接看见的输出变了？
        'name': '扩展名白名单放宽（把 .exe 也放进来）',
        'anchor': r"const supported = /\.(txt|md|pdf)$/i.test(file.name);",
        'replace': r"const supported = /\.(txt|md|pdf|exe)$/i.test(file.name);",
        'expect': '不支持的扩展名被挡下',
    },
    {
        'file': KNOWLEDGE,
        'id': 'K3',
        'visible': True,   # 红了之后用户能直接看见的输出变了？
        'name': 'remove 不再本地过滤（等服务端重拉 —— 借机验证"列表立刻少一条"不是空话）',
        'anchor': "      setDocuments((prev) => prev.filter((d) => d.id !== doc.id));\n",
        'replace': "",
        'expect': 'DELETE /knowledge/11',
    },
    {
        'file': KNOWLEDGE,
        'id': 'K4',
        'visible': False,   # 红了之后用户能直接看见的输出变了？
        'name': "DELETE 不送 body（空 body 会被 Fastify 判 400）",
        'anchor': "        // 空 body 会被 fastify 判 400，这里明确送一个 JSON 空对象。\n        body: '{}',\n",
        'replace': "",
        'expect': "DELETE 的 body",
    },
    # ---- 片 2：features/memory ----
    {
        'file': MEMORY,
        'id': 'M1',
        'visible': True,   # 红了之后用户能直接看见的输出变了？
        'name': 'loadProject 里删掉「切走后晚到的响应不许覆盖」这条守卫',
        'anchor': "      // 切走之后晚到的响应不能覆盖当前智能体的那份\n      if (curAgentRef.current !== agentId) return;\n",
        'replace': "",
        'expect': '切走智能体后',
    },
    {
        'file': MEMORY,
        'id': 'M2',
        'visible': True,   # 红了之后用户能直接看见的输出变了？
        'name': 'confirm 去掉本地过滤（等服务端重拉 —— 界面会闪一下）',
        'anchor': "      setPending((prev) => prev.filter((m) => m.id !== id));\n      void loadUser();",
        'replace': "      void loadUser();",
        'expect': '待确认：点「确认」',
    },
    {
        'file': MEMORY,
        'id': 'M3',
        'visible': False,   # 红了之后用户能直接看见的输出变了？
        'name': 'forget 的 body 少送 id（服务端就不知道该忘哪条）',
        'anchor': "        body: JSON.stringify({ layer, id }),",
        'replace': "        body: JSON.stringify({ layer }),",
        'expect': '忘掉',
    },
    # ---- 片 3：app/browserGlue ----
    {
        'file': GLUE,
        'id': 'G1',
        'visible': True,   # 红了之后用户能直接看见的输出变了？
        'name': 'clearHelp 收不掉卡片（AI 求助解除后卡还在）',
        'anchor': "      if (!(agentId in prev)) return prev; // ★ 没有就别造新对象（引用稳定，少一次无谓渲染）\n      const next = { ...prev };\n      delete next[agentId];\n      return next;",
        'replace': "      return prev;",
        'expect': '卡片收起',
    },
    {
        'file': GLUE,
        'id': 'G2',
        'visible': True,   # 红了之后用户能直接看见的输出变了？
        'name': 'answerLoopGone 点完不清卡（留一张点不动的卡）',
        'anchor': "    const cur = loopGone;\n    setLoopGone(null);",
        'replace': "    const cur = loopGone;",
        'expect': '点完还留着卡',
    },
    {
        'file': GLUE,
        'id': 'G3',
        'visible': False,   # 红了之后用户能直接看见的输出变了？
        'name': '切智能体时不再恒调 exitEmbed（就是那条真机时序破口）',
        'anchor': "    browser.exitEmbed();\n    // browser 的方法是稳定引用",
        'replace': "    // browser 的方法是稳定引用",
        'expect': '恒调 exitEmbed',
    },
    {
        'file': GLUE,
        'id': 'G4',
        'visible': True,   # 红了之后用户能直接看见的输出变了？
        'name': '求助卡不按智能体分桶（挂到当前对话上）',
        'anchor': "    setHelpCards((prev) => ({ ...prev, [card.agentId]: card }));",
        'replace': "    setHelpCards((prev) => ({ ...prev, [curAgentId ?? 0]: card }));",
        'expect': '求求助卡没渲染出来'.replace('求求', ''),
    },
    {
        'file': GLUE,
        'id': 'G5',
        'visible': True,   # 红了之后用户能直接看见的输出变了？
        'name': 'curHelp 跨对话泄漏（拿别人对话的卡来显示）',
        'anchor': "  const curHelp = curAgentId !== null ? helpCards[curAgentId] ?? null : null;",
        'replace': "  const curHelp = Object.values(helpCards)[0] ?? null;",
        'expect': '漏到 98 号对话里',
    },
    # ---- 片 4：features/projects ----
    {
        'file': PROJECTS,
        'id': 'P1',
        'visible': False,   # 红了之后用户能直接看见的输出变了？
        'name': 'switchProject 跳过服务端 activate（界面先切、后端没落地）',
        'anchor': "      await authFetchJson<ProjectUpdateResult>(`/projects/${id}/activate`, {\n        method: 'POST',\n        body: '{}',\n        headers: { authorization: `Bearer ${sess.token}` },\n      });\n      if (sessionRef.current?.token !== sess.token) return;\n",
        'replace': "",
        'expect': '发出 activate',
    },
    {
        'file': PROJECTS,
        'id': 'P2',
        'visible': True,   # 红了之后用户能直接看见的输出变了？
        'name': 'loadProjects 不把列表写进界面 state（拉回来了但不显示）',
        'anchor': "      setProjects(r.projects);\n",
        'replace': "",
        'expect': '项目行数不对',
    },
    {
        'file': PROJECTS,
        'id': 'P3',
        'visible': False,   # 红了之后用户能直接看见的输出变了？
        'name': 'createProject 的 body 少送名字',
        'anchor': "        body: JSON.stringify({ name }),",
        'replace': "        body: JSON.stringify({}),",
        'expect': '建项目的 body 不对',
    },
]


def md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def run_logic_smoke() -> tuple[int, str]:
    proc = subprocess.run(
        ['npx', 'tsx', 'scripts/verify/app-logic-smoke.mts'],
        cwd=REPO, capture_output=True, text=True, timeout=900,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    print('=== 先确认基线是绿的（否则反证无意义）===')
    rc, out = run_logic_smoke()
    m = re.search(r'(\d+) PASS / (\d+) FAIL', out)
    print(f'  基线退出码={rc}  {m.group(0) if m else "（没解析到统计）"}')
    if rc != 0:
        print('★ 基线就是红的，先修基线。')
        print(out[-2000:])
        return 2

    failures = 0
    for mut in MUTATIONS:
        print('')
        print(f"--- {mut['id']} {mut['name']}")
        target: Path = mut['file']
        original = target.read_text(encoding='utf8')
        count = original.count(mut['anchor'])
        if count != 1:
            print(f'  ★ 锚点不唯一（{count} 处），反证脚本要跟着改：{target.name}')
            failures += 1
            continue
        before = md5(target)
        try:
            target.write_text(original.replace(mut['anchor'], mut['replace']), encoding='utf8')
            rc, out = run_logic_smoke()
            # ★ 命中判定要看**两处**：✗ 那一行是断言名，紧随其后的缩进行才是失败详情
            #   （K4 的期望文案就在详情里 —— 只看 ✗ 会误判成"没命中"）
            lines = out.splitlines()
            hit = []
            for i, ln in enumerate(lines):
                if ln.strip().startswith('✗'):
                    hit.append(ln.strip())
                    for nxt in lines[i + 1:i + 4]:
                        if nxt.strip().startswith('✗') or not nxt.strip():
                            break
                        hit.append(nxt.strip())
            stats = re.search(r'(\d+) PASS / (\d+) FAIL', out)
            print(f'  注入后：退出码={rc}  {stats.group(0) if stats else ""}')
            for h in hit[:4]:
                print(f'    {h}')
            if rc == 0:
                print('  ★★ 假绿：注入缺陷之后验收网仍然全绿！')
                failures += 1
            elif not any(mut['expect'] in h for h in hit):
                print(f"  ★ 变红了，但没命中期望的断言（期望「{mut['expect']}」）")
                failures += 1
            else:
                print(f"  ✓ 变红，且命中「{mut['expect']}」")
        finally:
            target.write_text(original, encoding='utf8')
            if md5(target) != before:
                print(f'  ★★ 还原失败，{target.name} 的 md5 对不上！')
                failures += 1
            else:
                print('  ✓ 已还原，md5 逐字节一致')

    print('')
    print('=== 结论 ===')
    print(f'  {len(MUTATIONS) - failures}/{len(MUTATIONS)} 处缺陷被行为验收网咬住')
    if failures:
        print(f'  ★ {failures} 项未通过')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
