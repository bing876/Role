#!/usr/bin/env python3
"""交互对齐片(2026-09-26)反证：把关键代码改回旧行为 → 对应验收必须变红 → 立刻还原。

用法： python3 scripts/verify/chat-interaction-revert.py
原理： 每条「改坏」都对应验收里的一条断言。注入后跑指定的那套验收，
       期望**恰好**那几条变红 —— 证明断言不是摆设；跑完按原始字节还原（sha256 复核）。

★ 为什么要按字节还原：本仓 *.ts 是 CRLF，`decode().replace('\\r\\n','\\n')` 之后写回会改行尾，
  上一次的教训（routines-lifecycle-revert-proof.py 的假红）就是这么来的。
"""

import hashlib
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
NODE = shutil.which('node') or 'node'
TSX_CLI = str(Path(REPO) / 'node_modules' / 'tsx' / 'dist' / 'cli.mjs')

OUTDIR = os.path.join(REPO, 'docs', 'acceptance', 'chat-interaction')

APP = os.path.join(REPO, 'apps', 'desktop', 'src', 'App.tsx')
CHAT = os.path.join(REPO, 'apps', 'desktop', 'src', 'features', 'chat', 'useChat.ts')
MD = os.path.join(REPO, 'apps', 'desktop', 'src', 'features', 'chat', 'MarkdownText.tsx')
DELTA = os.path.join(REPO, 'apps', 'server', 'src', 'chatDelta.ts')

LOGIC = ['scripts/verify/app-logic-smoke.mts']
TRACE = ['scripts/verify/chat-trace-isolation.mts']

DEFECTS = [
    {
        'name': 'I1 把「步骤」写回聊天流（旧路径：**步骤 N** 进助手气泡）',
        'file': DELTA,
        'old': "  return null;\n",
        'new': "  if (decision.kind === 'tool') return `\\n\\n**步骤 ${decision.step}**：旧路径注入`;\n  return null;\n",
        'expect': ['tool（每一步工具调用）'],
        'cmd': TRACE,
    },
    {
        'name': 'I2 把「任务完成」写回聊天流',
        'file': DELTA,
        'old': "  return null;\n",
        'new': "  if (decision.kind === 'done') return `\\n\\n🎉 **任务完成**\\n${decision.summary}`;\n  return null;\n",
        'expect': ['done（任务收尾）'],
        'cmd': TRACE,
    },
    {
        'name': 'I3 把旧的「AI 任务执行中」横幅加回来',
        'file': APP,
        # ★ UX 收尾片之后状态行搬出了 `.chat`，所以这条注入**往 `.chat` 里**加（模拟旧位置），
        #   ⑲-1 的判据也改成了整个文档（见那里的注释）—— 两处对齐，注入到哪儿都咬得住。
        'old': '        <div className="chat">\n',
        'new': ('        <div className="chat">\n'
                '          {runningLoopId && streaming && (\n'
                '            <div className="taskState">🚀 <b>AI 任务执行中</b> · 正在自主操作浏览器</div>\n'
                '          )}\n'),
        'expect': ['⑲-1'],
        'cmd': LOGIC,
    },
    {
        'name': 'I4 步骤事件也 say 成聊天行（步骤墙从事件侧回来）',
        'file': APP,
        'old': "        trace(`· ${line}`);\n",
        'new': "        say(`· ${line}`);\n        trace(`· ${line}`);\n",
        'expect': ['⑲-2'],
        'cmd': LOGIC,
    },
    {
        'name': 'I5 摘掉「打开 XX 优先于补充指令」（用户明确指令被吞）',
        'file': CHAT,
        'old': "      if (!detectOpenUrl(value)) {\n",
        'new': "      if (true) {\n",
        'expect': ['⑲-4'],
        'cmd': LOGIC,
    },
    {
        'name': 'I6 markdown 渲染退回纯文本（raw ** 又露出来）',
        'file': MD,
        'old': "  return <>{blocks}</>;\n",
        'new': "  return <>{text}</>;\n",
        'expect': ['⑲-5'],
        'cmd': LOGIC,
    },
    {
        'name': 'I7 执行中发送键不再变「停止」',
        'file': APP,
        'old': "          {runningLoopId && streaming ? (\n",
        'new': "          {false && runningLoopId && streaming ? (\n",
        'expect': ['⑲-1'],
        'cmd': LOGIC,
    },
    {
        'name': 'I8 把补充指令的黄色横幅加回来',
        'file': CHAT,
        'old': "        void fetch(`${API_BASE()}/agent/loop/message`, {\n",
        'new': "        setChatNote(`已将补充指令注入当前任务上下文：「${value}」`);\n        void fetch(`${API_BASE()}/agent/loop/message`, {\n",
        'expect': ['⑲-3'],
        'cmd': LOGIC,
    },
    {
        'name': 'I9 「停」不再短路（控制指令被当成任务再派一次）',
        'file': CHAT,
        'old': ("      setChatNote('好，停手了——这一路不再动作。要它接着干，直接说下一步就行。');\n"
                "      return;\n"),
        'new': "      setChatNote('好，停手了——这一路不再动作。要它接着干，直接说下一步就行。');\n",
        # ★ 判据落在 ⑲-7（**非运行态**）:⑲-6 走的是「有循环」那条分支,它自带 return,测不出这处注入
        'expect': ['⑲-7'],
        'cmd': LOGIC,
    },
    # ---- 下面四条是「UX 收尾片」的 A①②③（用户 2026-09-26 拍板）----
    {
        'name': 'I10(A①) 暂停不清 loopId（界面仍画成"执行中"，输入框回不去正常发送）',
        'file': CHAT,
        'old': ("        pausedLoopIdRef.current = loopId;\n"
                "        setRunningLoopId(null);\n"
                "        setRunningLoopWcId(null);\n"),
        'new': "        pausedLoopIdRef.current = loopId;\n",
        'expect': ['⑲-9'],
        'cmd': LOGIC,
    },
    {
        'name': 'I11(A①) 暂停态不单列发送键（挂起时落进"打字中…"并被禁用）',
        'file': APP,
        'old': "          ) : pausedHere ? (\n",
        'new': "          ) : false ? (\n",
        'expect': ['⑲-9'],
        'cmd': LOGIC,
    },
    {
        'name': 'I12(A②) 状态行不渲染（不再"钉在输入框正上方"）',
        'file': APP,
        'old': "        {runBarMode && (\n",
        'new': "        {false && runBarMode && (\n",
        'expect': ['⑲-8'],
        'cmd': LOGIC,
    },
    {
        'name': 'I13(A③) 补充成功不叫状态行（瞬态提示消失，只剩静默）',
        'file': CHAT,
        'old': "        onSupplementRef.current?.();\n",
        'new': "        /* 反证注入：不叫状态行 */\n",
        'expect': ['⑲-10'],
        'cmd': LOGIC,
    },
    # ---- 下面三条是「降噪片」的 B5/B6/B3 ----
    {
        'name': 'I14(B5) 占位名「新智能体」的行照旧显示（空占位又回来）',
        'file': APP,
        'old': "  const namedAgents = agents.filter((a) => a.name !== '新智能体');\n",
        'new': "  const namedAgents = agents.filter(() => true);\n",
        'expect': ['⑳-1'],
        'cmd': LOGIC,
    },
    {
        'name': 'I15(B6) 「结束」键不再条件显示（空对话也摆一个）',
        'file': APP,
        'old': "          {messages.length > 0 && (\n            /* 第 15 步：结束这轮",
        'new': "          {true && (\n            /* 第 15 步：结束这轮",
        'expect': ['⑳-2'],
        'cmd': LOGIC,
    },
    {
        'name': 'I16(B3) 首进引导不落标记（欢迎卡每次回来）',
        'file': APP,
        'old': "      localStorage.setItem(guideKey(pid), '1');\n",
        'new': "      /* 反证注入：不落标记 */;\n",
        'expect': ['⑳-3'],
        'cmd': LOGIC,
    },
]


def sha256(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def read_raw(path):
    with open(path, encoding='utf-8', newline='') as f:
        return f.read()


def write_raw(path, text):
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def inject(path, old, new):
    raw = read_raw(path)
    nl = '\r\n' if '\r\n' in raw else '\n'
    norm = raw.replace('\r\n', '\n')
    if norm.count(old) != 1:
        return False
    patched = norm.replace(old, new, 1)
    write_raw(path, patched if nl == '\n' else patched.replace('\n', nl))
    return True


def run(cmd):
    log = os.path.join(OUTDIR, 'chat-interaction-revert-last.log')
    with open(log, 'w', encoding='utf-8', errors='replace') as f:
        r = subprocess.run([NODE, TSX_CLI, *cmd], cwd=REPO, stdout=f, stderr=subprocess.STDOUT, timeout=900)
    txt = read_raw(log)
    fails = [x.strip() for x in re.findall(r'^\s*✗\s*(.+)$', txt, re.M)]
    npass = len(re.findall(r'^\s*✓', txt, re.M))
    return r.returncode, fails, npass, log


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    print('=' * 78)
    print('反证：把「交互对齐片」的关键代码改回旧行为 → 验收必须变红 → 立刻还原')
    print('=' * 78)

    print('\n[0] 源码指纹自检（防止把上一次中断留下的"已注入"状态当基线）')
    ok_all = True
    for d in DEFECTS:
        txt = read_raw(d['file']).replace('\r\n', '\n')
        hit = txt.count(d['old']) == 1
        print('  [%s] 注入锚点唯一：%s' % ('PASS' if hit else 'FAIL', d['name']))
        if not hit:
            ok_all = False
    if not ok_all:
        print('  ✗ 锚点不全 —— 源码不是预期状态，先手工检查再跑反证')
        return 2

    files = sorted({d['file'] for d in DEFECTS})
    orig = {p: read_raw(p) for p in files}
    orig_sha = {p: sha256(p) for p in files}

    results = []
    try:
        for i, d in enumerate(DEFECTS, 1):
            print('\n' + '-' * 78)
            print('[反证 %d/%d] %s' % (i, len(DEFECTS), d['name']))
            print('  注入文件：%s' % os.path.relpath(d['file'], REPO))
            if not inject(d['file'], d['old'], d['new']):
                print('  ✗ 锚点未命中，跳过')
                results.append((d['name'], False, 'anchor miss'))
                continue
            print('  已注入。跑 %s …' % ' '.join(d['cmd']))
            try:
                rc, fails, npass, log = run(d['cmd'])
            finally:
                write_raw(d['file'], orig[d['file']])
                back = sha256(d['file'])
                restored = back == orig_sha[d['file']]
                print('  已还原（sha256 %s）：%s' % (back[:12], '一致 ✔' if restored else '不一致 ✗'))
                if not restored:
                    raise RuntimeError('还原失败，必须人工介入：%s' % d['file'])
            hit = [f for f in fails if any(k in f for k in d['expect'])]
            passed = (rc != 0) and bool(hit)
            print('  退出码 %d / PASS %d / FAIL %d' % (rc, npass, len(fails)))
            print('  期望变红：%s' % d['expect'])
            print('  实际变红：%s' % (fails or '无（仍全绿）'))
            print('  [%s] %s' % ('PASS' if passed else 'FAIL',
                                 '探针成功变红 —— 该断言有效' if passed else '没变红 —— 断言是摆设'))
            print('  日志：%s' % log)
            results.append((d['name'], passed, fails))
    finally:
        for p, t in orig.items():
            write_raw(p, t)
        for p in orig:
            if sha256(p) != orig_sha[p]:
                print('  ✗ 终检：文件未还原，必须人工介入：%s' % p)
                return 2

    print('\n' + '=' * 78)
    bad = [r for r in results if not r[1]]
    if bad:
        print('反证结果：%d/%d 有效 ✗' % (len(results) - len(bad), len(results)))
        for name, _, fails in bad:
            print('  ✗ %s（变红：%s）' % (name, fails or '无'))
        return 1
    print('反证结果：全部 %d 条探针成功变红 ✔ —— 验收断言都是真的' % len(results))
    return 0


if __name__ == '__main__':
    sys.exit(main())
