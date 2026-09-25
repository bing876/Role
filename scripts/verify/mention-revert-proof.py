#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
批次 J · @点名换人 —— **变异反证**（mutation counter-proof）
==========================================================

为什么要它：验收全绿只证明「现在的代码能过」，证明不了「这些断言真的咬着这批改动」。
把关键逻辑一处一处改坏（每处都是**真实可能发生的写法**，不是乱删），对应断言必须变红；
跑完立刻还原，并用 **md5 逐文件核对**「还原后与注入前一字不差」，最后再用 git 确认树是干净的。

    python3 scripts/verify/mention-revert-proof.py            # 全部 6 处注入
    python3 scripts/verify/mention-revert-proof.py --only=M1,M3

注入清单（每一处都对应本批次的一条硬要求）：
  M1 解析器变成「永远没点到人」          → 点名整条功能失效，J1/J3/J5 必须红
  M2 助手消息不再写 speaker_agent_id     → 「这句话是谁说的」丢了，端到端 T1/T9 必须红
  M3 R-A 的忙碌集合清空（静默改派）      → 正忙的智能体被硬派活，J3/J5 必须红
  M4 R-C 不剥 @名字（原文直接给模型）    → 模型看到 @名字，端到端 T1.6 必须红
  M5 桌面闸门不再认「告知轮」            → busy/empty 轮被替用户发车，J4 必须红
  M7 桌面闸门把 switch 也拦掉（决策2 倒退）→ 点名轮又不发车了，J4 必须红
  M8 服务端把循环主人换成被点名者（决策2 倒退）→ 被点名者接管别人的页，端到端 T10 必须红
  M6 闲聊轮记忆检索不传 convId           → 证明「被我升级过的老断言」没改松（mem-merge-batch2 必须红）

★ 纪律：注入期间**只改产品代码，绝不动断言**（改断言让绿的就不是反证，是自欺）。
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # scripts/verify/ → 仓库根

FILES = {
    "parser": "packages/shared/src/mention.ts",
    "chat": "apps/server/src/routes/chat.ts",
    "decision": "apps/server/src/orchestrator/mention.ts",
    "gate": "apps/desktop/src/mentionGate.ts",
}


def md5(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


def read(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def write(path: str, text: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def sh(cmd: str, timeout: int = 1200) -> tuple[int, str]:
    """跑一条命令，回 (exit code, 输出末尾若干行)。exit!=0 就是「红了」。"""
    p = subprocess.run(cmd, shell=True, cwd=REPO, capture_output=True, text=True, timeout=timeout)
    out = (p.stdout or "") + (p.stderr or "")
    tail = "\n".join([ln for ln in out.splitlines() if ln.strip()][-14:])
    return p.returncode, tail


# ---------------------------------------------------------------------------
# 每处注入：改哪个文件、把什么换成什么、跑哪条验收、期望它红
# 需要 build 的（端到端打的是 apps/server/dist）标 needs_build
# ---------------------------------------------------------------------------
MUTATIONS = [
    {
        "id": "M1",
        "why": "解析器变成「永远没点到人」——点名功能整体失效",
        "file": FILES["parser"],
        "old": """  // 拍板 2 + R-B
  const first = mentions[0] ?? null;""",
        "new": """  // 拍板 2 + R-B
  // 【反证注入 M1】把命中列表清空：解析器从此「谁都点不到」
  mentions.length = 0;
  const first = mentions[0] ?? null;""",
        "run": "npm run -s verify:mention:parse",
        "needs_build": False,
    },
    {
        "id": "M2",
        "why": "助手消息不再写 speaker_agent_id——「这句话是谁说的」在库里丢掉",
        "file": FILES["chat"],
        "old": """          "INSERT INTO messages (conversation_id, role, content_enc, sources, speaker_agent_id) VALUES ($1, 'assistant', $2, $3, $4) RETURNING id",
          [convId, cipher.encryptText(full), sources.length > 0 ? JSON.stringify(sources) : null, agentCtx.agentId ?? turnSpeakerId],""",
        "new": """          // 【反证注入 M2】发言人这一列不写了
          "INSERT INTO messages (conversation_id, role, content_enc, sources) VALUES ($1, 'assistant', $2, $3) RETURNING id",
          [convId, cipher.encryptText(full), sources.length > 0 ? JSON.stringify(sources) : null],""",
        "run": "node scripts/verify/mention-e2e.mjs --only=T1,T9",
        "needs_build": True,
    },
    {
        "id": "M3",
        "why": "R-A 的忙碌集合清空——正忙/在等的智能体被静默改派（用户明令禁止的那种）",
        "file": FILES["decision"],
        "old": """const BUSY_STATUSES: ReadonlySet<AvatarStatus> = new Set(['working', 'waiting', 'thinking']);""",
        "new": """// 【反证注入 M3】谁都不算忙 → R-A 形同废除
const BUSY_STATUSES: ReadonlySet<AvatarStatus> = new Set([]);""",
        "run": "npm run -s verify:mention:decision",
        "needs_build": False,
    },
    {
        "id": "M4",
        "why": "R-C 不剥 @名字——原文（含 @）直接喂给模型",
        "file": FILES["chat"],
        "old": """      const mentionText = mention.kind === 'none' ? message : 'text' in mention ? mention.text : message;""",
        "new": """      // 【反证注入 M4】不剥了，原样交给模型
      const mentionText = message;""",
        "run": "node scripts/verify/mention-e2e.mjs --only=T1,T2",
        "needs_build": True,
    },
    {
        # 这一处不是本批次的功能，是**证明我改过的那条老断言没有被我改松**：
        # 批次 J 动了 chat.ts 里 buildMemoryBlock 的实参（message→mentionText、agentId→这一轮发言人），
        # mem-merge-batch2.mjs 原来咬字面量的两条断言因此假红；我把它们升级成
        # 「抓出所有 buildMemoryBlock 调用、逐个看最后一个实参是不是 convId」。
        # 升级后的断言必须照样咬得住 —— 把 convId 抽掉就得红，否则那次升级就成了「改断言换绿」。
        "id": "M6",
        "why": "闲聊轮的记忆检索不再传 convId——证明升级过的老断言（mem-merge-batch2）照样咬得住",
        "file": FILES["chat"],
        "old": "      const memBlock = await buildMemoryBlock(pool, cipher, claims.sub, mentionText, turnSpeakerId ?? agentId ?? null, convId ?? null);",
        "new": "      // 【反证注入 M6】convId 不传了\n      const memBlock = await buildMemoryBlock(pool, cipher, claims.sub, mentionText, turnSpeakerId ?? agentId ?? null, null);",
        "run": "node scripts/verify/mem-merge-batch2.mjs",
        "needs_build": False,
    },
    {
        "id": "M5",
        "why": "桌面闸门不再认「告知轮」（R-A 忙 / 整条只写了 @名字）——这两种轮服务端只回一句告知、没派活，被兜底发出去就是替用户操作浏览器",
        "file": FILES["gate"],
        "old": """  return (
    Boolean(input.pendingDrive) && !input.sawLoop && !NOTICE_ROUND.has(String(input.serverMentionKind ?? ''))
  );""",
        "new": """  // 【反证注入 M5】「告知轮不发车」这半条摘掉，退回第 21 步的老兜底
  return Boolean(input.pendingDrive) && !input.sawLoop;""",
        "run": "npm run -s verify:mention:desktop",
        "needs_build": False,
    },
    {
        # ★ 用户 2026-09-24 拍板（决策2 = allow_with_owner）：点名轮**允许**发车，循环归会话主人。
        #   这条注入就是把那个拍板改回旧口径（switch 也拦掉）—— 必须红，否则 §① 那条断言是摆设。
        "id": "M7",
        "why": "决策2 倒退：桌面又把 switch/self 当告知轮拦掉——用户「@某人 + 页面任务」那一轮会凭空不发车",
        "file": FILES["gate"],
        "old": """const NOTICE_ROUND = new Set(['busy', 'empty']);""",
        "new": """const NOTICE_ROUND = new Set(['busy', 'empty', 'switch', 'self']); // 【反证注入 M7】""",
        "run": "npm run -s verify:mention:desktop",
        "needs_build": False,
    },
    {
        # ★ 决策2 的另一半：被点名者**不接管别人的页**。把循环主人换成被点名者，
        #   就等于让它去开别人的 wcId、占别人的循环名额 —— 端到端 T10 必须红。
        "id": "M8",
        "why": "决策2 倒退：服务端把循环主人换成被点名者（去接管会话主人那张页）",
        "file": FILES["chat"],
        "old": """        const loopAgentId = Number.isInteger(convAgentId) && convAgentId > 0 ? convAgentId : agentId;""",
        "new": """        // 【反证注入 M8】让被点名者接管这条循环
        const loopAgentId = mention.kind === 'switch' ? mention.agentId : (Number.isInteger(convAgentId) && convAgentId > 0 ? convAgentId : agentId);""",
        "run": "node scripts/verify/mention-e2e.mjs --only=T10",
        "needs_build": True,
    },
]


def main() -> int:
    args = sys.argv[1:]
    only = None
    for a in args:
        if a.startswith("--only="):
            only = {x.strip() for x in a[len("--only="):].split(",") if x.strip()}

    print("=== 批次 J · @点名换人：变异反证 ===")
    print(f"    仓库 {REPO}")
    before = {k: md5(os.path.join(REPO, v)) for k, v in FILES.items()}
    for k, v in before.items():
        print(f"    注入前 md5 {k:9s} {v}  ({FILES[k]})")
    # ★ 树「干净」的标准不是 git status 空 —— 本批次的改动本来就还没提交。
    #   正确的不变量是：**注入前后 git status 逐字节相同**（该改的还在、不该多的一个都没多）。
    _, git_before = sh("git status --porcelain -- " + " ".join(FILES.values()))
    print("    注入前 git status：\n" + "\n".join("      " + x for x in git_before.splitlines()))

    rows = []
    try:
        for m in MUTATIONS:
            if only and m["id"] not in only:
                continue
            path = os.path.join(REPO, m["file"])
            src = read(path)
            if src.count(m["old"]) != 1:
                rows.append((m["id"], "SKIP", f"锚点在 {m['file']} 里出现 {src.count(m['old'])} 次（应为 1 次）"))
                print(f"\n[SKIP] {m['id']} 锚点不唯一，跳过（不许糊里糊涂地注入）")
                continue
            print(f"\n----- {m['id']} 注入：{m['why']} -----")
            print(f"      文件 {m['file']}")
            t0 = time.time()
            write(path, src.replace(m["old"], m["new"], 1))
            try:
                if m["needs_build"]:
                    rc_b, out_b = sh("npm run build -w @ai-workbench/server")
                    if rc_b != 0:
                        # 注入把编译搞坏了也是「红」，但要如实说明是编译红而不是断言红
                        rows.append((m["id"], "RED(build)", "注入后编译失败（断言没跑到）\n" + out_b))
                        print("      注入后编译就失败了（记为 RED(build)）")
                        continue
                rc, tail = sh(m["run"])
                ok = rc != 0
                rows.append((m["id"], "RED" if ok else "★GREEN(不该)", f"exit={rc}\n{tail}"))
                print(f"      跑 {m['run']}")
                print(f"      → exit={rc} {'（红了，符合预期）' if ok else '（★居然还是绿的：断言没咬住这处改动！）'}")
                # 红在哪几条断言上，是反证的**内容**（只报 exit code 等于只说「有东西坏了」）
                red_lines = [x for x in tail.splitlines() if ("FAIL" in x or x.strip().startswith("- "))] or tail.splitlines()[-6:]
                print("      红在这些断言上：\n" + "\n".join("        " + x.strip()[:190] for x in red_lines[:8]))
            finally:
                write(path, src)
                if m["needs_build"]:
                    sh("npm run build -w @ai-workbench/server")
            print(f"      已还原（{time.time() - t0:.1f}s）；md5 复核 = {md5(path)}")
    finally:
        # ---- 无论如何都要还原干净：md5 逐文件核对 ----
        print("\n=== 还原核对 ===")
        dirty = []
        for k, v in FILES.items():
            p = os.path.join(REPO, v)
            now = md5(p)
            same = now == before[k]
            print(f"    {k:9s} {now}  {'一致' if same else '★不一致'}")
            if not same:
                dirty.append(v)
        _, out = sh("git status --porcelain -- " + " ".join(FILES.values()))
        clean = out == git_before
        print(f"    git status（这四个文件）与注入前：{'逐字节一致' if clean else '★不一致'}\n{out}")
        if dirty or not clean:
            rows.append(("RESTORE", "★FAIL", "还原不干净：" + (",".join(dirty) if dirty else "git status 与注入前不一致")))
        else:
            rows.append(("RESTORE", "OK", "四个文件 md5 与 git status 都回到注入前"))

    print("\n=== 反证小结 ===")
    bad = 0
    for mid, verdict, detail in rows:
        good = verdict.startswith("RED") or verdict == "OK"
        flag = "OK " if good else ("SKIP" if verdict == "SKIP" else "★BAD")
        if flag == "★BAD":
            bad += 1
        first = detail.splitlines()[0] if detail else ""
        print(f"    [{flag}] {mid:8s} {verdict:14s} {first}")
    print(f"\n    注入 {len([r for r in rows if r[0] != 'RESTORE'])} 处；不该绿而绿 / 还原不干净：{bad}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
