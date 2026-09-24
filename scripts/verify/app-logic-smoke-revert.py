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
HOOK = REPO / 'apps' / 'desktop' / 'src' / 'features' / 'knowledge' / 'useKnowledge.ts'

MUTATIONS = [
    {
        'id': 'K1',
        'name': 'load 里删掉「切号后晚到的响应不许覆盖列表」这条守卫',
        'anchor': "      // 切号期间晚到的 A 号响应不能覆盖 B 号列表。\n      if (sessionRef.current?.token !== sess.token) return;\n",
        'replace': "",
        'expect': 'A 号请求晚到时不许覆盖 B 号列表',
    },
    {
        'id': 'K2',
        'name': '扩展名白名单放宽（把 .exe 也放进来）',
        'anchor': r"const supported = /\.(txt|md|pdf)$/i.test(file.name);",
        'replace': r"const supported = /\.(txt|md|pdf|exe)$/i.test(file.name);",
        'expect': '不支持的扩展名被挡下',
    },
    {
        'id': 'K3',
        'name': 'remove 不再本地过滤（等服务端重拉 —— 借机验证"列表立刻少一条"不是空话）',
        'anchor': "      setDocuments((prev) => prev.filter((d) => d.id !== doc.id));\n",
        'replace': "",
        'expect': 'DELETE /knowledge/11',
    },
    {
        'id': 'K4',
        'name': "DELETE 不送 body（空 body 会被 Fastify 判 400）",
        'anchor': "        // 空 body 会被 fastify 判 400，这里明确送一个 JSON 空对象。\n        body: '{}',\n",
        'replace': "",
        'expect': "DELETE 的 body",
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
        original = HOOK.read_text(encoding='utf8')
        count = original.count(mut['anchor'])
        if count != 1:
            print(f'  ★ 锚点不唯一（{count} 处），反证脚本要跟着改：{HOOK.name}')
            failures += 1
            continue
        before = md5(HOOK)
        try:
            HOOK.write_text(original.replace(mut['anchor'], mut['replace']), encoding='utf8')
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
            HOOK.write_text(original, encoding='utf8')
            if md5(HOOK) != before:
                print(f'  ★★ 还原失败，{HOOK.name} 的 md5 对不上！')
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
