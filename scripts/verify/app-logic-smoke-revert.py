#!/usr/bin/env python3
"""阶段 1① · 逻辑抽离第 1 片（knowledge）的反证。

往**抽出去的 feature 源码**里注入「把代码搬出 App.tsx 时最可能犯的错」，
行为验收网 `verify:logic` 必须每次都变红、且命中对应断言：

  （名单已长到 K/M/G/P/A/T/F3/C/B 九组；下面只写前四条的来历）

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
AUTH = FEATURES / 'auth' / 'useAuth.ts'
TASKS = FEATURES / 'tasks' / 'useTasks.ts'
APP_TSX = REPO / 'apps' / 'desktop' / 'src' / 'App.tsx'
CHAT = FEATURES / 'chat' / 'useChat.ts'

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
    {
        'file': PROJECTS,
        'id': 'P4',
        'visible': True,   # 红了之后用户能直接看见的输出变了？—— 确认文案没了
        'name': '把 F1 打回去：刷新列表时又顺手清掉提示（用户看不见"建好了"）',
        'anchor': "      curProjectRef.current = r.currentProjectId;\n      onCurrentProject(r.currentProjectId);\n",
        'replace': "      curProjectRef.current = r.currentProjectId;\n      onCurrentProject(r.currentProjectId);\n      setProjectNote('');\n",
        'expect': '没有确认文案',
    },
    {
        'file': PROJECTS,
        'id': 'P5',
        'visible': True,   # 红了之后用户能直接看见的输出变了？—— 失败提示没有 ⚠ 了
        'name': '把 F2 打回去：切换失败的提示丢掉 ⚠ 前缀（成功/失败又长得一样）',
        'anchor': "      setProjectNote(`⚠ 切换项目没成：${(e as Error).message}`);\n",
        'replace': "      setProjectNote(`切换项目没成：${(e as Error).message}`);\n",
        'expect': '失败提示没有 ⚠ 前缀',
    },
    {
        'file': CHAT,
        'id': 'C3',
        'visible': True,   # 红了之后用户能直接看见的输出变了？—— 上一轮的任务卡回到屏幕上
        'name': '把 F5 打回去：登出不清这一轮的残留（重新登录后界面以为任务还在跑）',
        'anchor': (
            "    /** F5：这一轮的残留（见上面那段说明；顺序与 `sendChat` 的 finally 一致，便于对照） */\n"
            "    setSearchHint('');\n"
            "    setRunningLoopId(null);\n"
            "    setRunningLoopWcId(null);\n"
            "    setStreaming(false);\n"
            "    setStreamingAgentId(null);\n"
        ),
        'replace': "",  # 什么都不清（F5 原状）
        'expect': 'AI 任务执行中',
    },
    {
        'file': CHAT,
        'id': 'C4',
        'visible': True,   # 红了之后用户能直接看见的输出变了？—— 输入框被锁成「打字中…」
        'name': 'F5 只修一半：清循环号但不清流式态（输入框还锁在上一轮的「打字中」）',
        'anchor': "    setStreaming(false);\n    setStreamingAgentId(null);\n  };\n",
        'replace': "  };\n",
        'expect': '输入框按钮还停在上一轮',
    },
    # ---- 片 5：features/auth（这一片**全部**是 user-visible 注入：
    #      只让内部调用计数变红不算反证 —— 用户 2026-09-24 拍板）----
    {
        'file': AUTH,
        'id': 'A1',
        'name': '改密码时不再按「已设过密码」带原密码（服务端会挡下并显示原因）',
        'anchor': "      if (session.user.has_password) body.old_password = pwOld;",
        'replace': "      // 注入：永远不带原密码",
        'visible': True,
        'expect': '第二次改密码没成功',
    },
    {
        'file': AUTH,
        'id': 'A2',
        'name': '静默登录失败后不再退出「检查中」（界面永远停在检查中）',
        'anchor': "      .finally(() => { if (!off) setCheckingAuth(false); });",
        'replace': "      .finally(() => { void off; });",
        'visible': True,
        'expect': '回到登录页',
    },
    {
        'file': AUTH,
        'id': 'A3',
        'name': '登出不清 session（人还"登录着"）',
        'anchor': "    setSession(null);\n    setPwMsg('');\n  };",
        'replace': "    setPwMsg('');\n  };",
        'visible': True,
        'expect': '回到登录页',
    },
    {
        'file': AUTH,
        'id': 'A4',
        'name': '改密码成功后不更新本地 has_password（界面还说"未设置"）',
        'anchor': "      setSession((s) => (s ? { ...s, user: { ...s.user, has_password: true } } : s));",
        'replace': "      // 注入：本地不同步",
        'visible': True,
        'expect': 'has_password 没跟着更新',
    },
    # ---- 片 6：features/tasks ----
    {
        'file': TASKS,
        'id': 'T1',
        'name': 'refreshTask 丢掉「完成且未读」的判断（红点乱亮）',
        'anchor': "        setHasUnread(r.task.status === 'done' && r.task.unread);",
        'replace': "        setHasUnread(false);",
        'visible': True,
        'expect': '界面上却没有红点',
    },
    {
        'file': TASKS,
        'id': 'T2',
        'name': 'openTaskResult 不熄红点（看完还亮着）',
        'anchor': "        setCurTask({ ...curTask, unread: false });\n        setHasUnread(false);",
        'replace': "        void 0;",
        'visible': True,
        'expect': '红点还亮着',
    },
    {
        'file': TASKS,
        'id': 'T3',
        'name': '下载文档把「已保存」写成「已取消」（那一行文案错）',
        'anchor': "    if (r.saved) setDocNote(`已保存：${r.path}`);\n    else if (r.canceled) setDocNote('已取消保存');",
        'replace': "    if (r.saved) setDocNote('已取消保存');\n    else if (r.canceled) setDocNote(`已保存：${r.path}`);",
        'visible': True,
        'expect': '没有把保存路径写出来',
    },
    # ---- F3（提前修的那条白屏防护）----
    {
        'file': APP_TSX,
        'id': 'F3-1',
        'name': '拆掉 getTaskState 的返回值校验（桥给空值 → 白屏）',
        'anchor': "          if (isTaskState(raw)) setTask(raw);\n          else setTask((s) => ({ ...s, detail: '拿不到主进程状态（桥返回了空值），状态行保持上一次的值' }));",
        'replace': "          setTask(raw as TaskState);",
        'visible': True,
        'expect': "Cannot read properties of undefined (reading 'phase')",  # 就是白屏时用户看到的崩
    },
    {
        'file': APP_TSX,
        'id': 'F3-2',
        'name': '拆掉 state 广播的形状校验（合法 JSON 的 null → 覆盖好状态）',
        'anchor': "        if (isTaskState(parsed)) setTask(parsed);",
        'replace': "        setTask(parsed as TaskState);",
        'visible': True,
        'expect': '坏负载把好状态覆盖掉了',
    },
    # ---- 片 7a：features/chat ----
    {
        'file': CHAT,
        'id': 'C1',
        'name': 'loadAgentHistory 丢掉「切号期间晚到的响应丢掉」这条守卫（会把 A 的历史写进 B）',
        'anchor': "      if (sessionRef.current?.token !== sess.token) return; // 切号期间晚到的响应丢掉\n",
        'replace': "",
        'visible': True,
        'expect': '切号后 A 号晚到的历史写进了聊天桶',
    },
    {
        'file': CHAT,
        'id': 'C2',
        'name': 'resetChat 忘了清聊天桶（登出后还留着上一个号的对话）',
        'anchor': "    setChats({});\n    historyLoadedRef.current = new Set();",
        'replace': "    // 注入：不清聊天桶",
        'visible': True,
        'expect': 'resetChat 之后桶没清空',
    },
    # ---- 片 7b：features/chat 的「发送」那一侧 ----
    #      用户 2026-09-25 拍板：**用户看得见的四件事**（我发的消息上屏 / 流式一段段长 /
    #      步骤逐条显示 / 任务卡出现）各要一条独立反证 —— 只让内部计数变红不算。
    {
        'file': CHAT,
        'id': 'B1',
        'visible': True,
        'name': 'sendChat 不再把用户那句话落桶（我发的话不上屏）',
        'anchor': "    // 用户这句话先落桶（按发起时的智能体）\n    patchChat(myAgent, (c) => ({ ...c, messages: c.messages.concat({ id: Date.now(), role: 'user', text: value }) }));\n",
        'replace': "    // 注入：不落桶\n",
        'expect': '我发的话没出现在屏幕上',
    },
    {
        'file': CHAT,
        'id': 'B2',
        'visible': True,
        'name': '流式不再逐帧显示（整段最后一次性蹦出来）',
        'anchor': "            acc += j.delta;\n            setStreamText(acc); // 打字机：逐段追加到助手气泡\n",
        'replace': "            acc += j.delta; // 注入：不推中间态\n",
        'expect': '流式没逐帧显示',
    },
    {
        'file': CHAT,
        'id': 'B3',
        'visible': True,
        'name': '新一轮开始不清空上一轮的步骤（旧步骤糊在新任务上）',
        'anchor': "      drive = { wcId, goal, note, pageUrl };\n      setAgentSteps([]);\n      setAgentDoc(null);",
        'replace': "      drive = { wcId, goal, note, pageUrl };\n      setAgentDoc(null);",
        'expect': '上一轮的步骤还挂在可见度条上',
    },
    {
        'file': CHAT,
        'id': 'B4',
        'visible': True,
        'name': '服务端给了 loopId 却不记循环号（「AI 任务执行中」那张任务卡不出现）',
        'anchor': "            setRunningLoopId(j.loopId);\n            setRunningLoopWcId(effectiveWc ?? null);",
        'replace': "            setRunningLoopWcId(effectiveWc ?? null); // 注入：不记循环号",
        'expect': 'AI 任务执行中',
    },
    {
        'file': CHAT,
        'id': 'B5',
        'visible': True,
        'name': '回复不再按服务端裁决挂发言人（@点名换人后名字牌还写小助）',
        'anchor': (
            "        const spokenBy: ChatSpeaker | undefined = sawMention\n"
            "          ? sawMention.speakerAgentId === null\n"
            "            ? undefined\n"
            "            : { id: sawMention.speakerAgentId, name: sawMention.speakerName || nameOfAgent(sawMention.speakerAgentId) }\n"
            "          : myAgent === null\n"
            "            ? undefined\n"
            "            : { id: myAgent, name: nameOfAgent(myAgent) };"
        ),
        'replace': (
            "        const spokenBy: ChatSpeaker | undefined =\n"
            "          myAgent === null ? undefined : { id: myAgent, name: nameOfAgent(myAgent) }; // 注入：不看裁决"
        ),
        'expect': '名字牌挂到了错的智能体上',
    },
    {
        'file': CHAT,
        'id': 'B6',
        'visible': False,   # 红了的是请求体（用户看不见）；后果是把一条会话劈成两半
        'name': 'chatsRef 最新值镜像不再维护（下一轮读不到刚写回的会话号）',
        'anchor': "  chatsRef.current = chats;\n",
        'replace': "  void chats; // 注入：最新值镜像不再更新\n",
        'expect': 'chatsRef 镜像被删或变成一次性了',
    },
    {
        'file': CHAT,
        'id': 'B7',
        'visible': True,
        'name': '桌面自己拦下「建一个X」（批次 L 那侧的意图检测永远收不到这句话）',
        'anchor': "    const value = input.trim();\n    if (!value) return;\n",
        'replace': (
            "    const value = input.trim();\n"
            "    if (!value) return;\n"
            "    if (/^建一个/.test(value)) {\n"
            "      setChatNote('（注入）桌面自己拦下了建智能体那句话');\n"
            "      return;\n"
            "    }\n"
        ),
        'expect': '守卫③',
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
