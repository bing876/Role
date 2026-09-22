"""反证（真机）：把桌面端改回**旧行为**（解挂失败 → 静默新建一轮），验证 S1 的断言真的会红。

## 为什么还要单独反一次
前两个反证验的是「服务端那半」：TTL 分档、404 带语义码。
但真正防止**重复执行**的那道闸在桌面端 —— `resumeAgentLane` 的 catch。
如果它其实没被走到（或者断言根本没看它），只验服务端会得出"全绿"的假象。
所以必须在**真机**上把它改回旧写法，看 S1 会不会红。

## 注入点
`apps/desktop/electron/main.ts` 里 `resumeAgentLane` 的 catch 块开头，插回原来那三行：

    lanes.delete(wcId);
    startAgentLoop(wcId, goal, false, { agentId: lane?.agentId ?? lastAgentByWc.get(wcId) ?? null });
    return;

= 旧的「解挂失败就退回新建一轮」。**保持可编译**，不改签名。

## 预期（只看 S1 那几条，S2/S3 不该受影响）
    变红：S1-a 出现明确提示 / S1-a2 文案 / S1-b 没有自动重跑 / S1-e 点得到「重新开始」
    不变：S2-a S2-b S2-c S3-a S3-b（这两条路根本不进 catch）

★ S1-d（服务端日志）不参与判定：它读的是服务端自己的日志，注入在桌面端，
  红不红都说明不了桌面端那道闸。别拿它凑数。

用法：
    python scripts/verify/p0-loop-ttl/p0-desktop-revert-proof.py

★ 本脚本**自己会起 PG**（调 `help-card/_start-pg.py`），不要再在外部起一遍。
  上一次翻车就是因为 PG 在两次调用之间没了：E2E 起环境时报 `db=down` 就中止，
  S1 根本没跑 ⇒ 看起来像"应该变红却没红"，其实是**测试没覆盖到**，不是断言无效。
"""
import os
import re
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
MAIN_TS = os.path.join(REPO, "apps", "desktop", "electron", "main.ts")
E2E = os.path.join(HERE, "p0-e2e.py")
PY = sys.executable

ANCHOR = """    } catch (err) {
      /**
       * ★★ P0 止血（2026-09-21）：**这里以前一律静默新建一轮。**"""
INJECT = """    } catch (err) {
      // ↓↓↓ 反证注入：退回旧行为（解挂失败就静默新建一轮）↓↓↓
      lanes.delete(wcId);
      startAgentLoop(wcId, goal, false, { agentId: lane?.agentId ?? lastAgentByWc.get(wcId) ?? null });
      return;
      /**
       * ★★ P0 止血（2026-09-21）：**这里以前一律静默新建一轮。**"""

EXPECT_RED = ["S1-a", "S1-a2", "S1-b", "S1-e"]
EXPECT_GREEN = ["S2-a", "S2-b", "S2-c", "S3-a", "S3-b"]


def ensure_pg():
    """自己把 PG 拉起来（唯一可靠启动：先全杀再起一个，然后等它真可查）。"""
    p = subprocess.run([PY, os.path.join(REPO, "scripts", "verify", "help-card", "_start-pg.py")],
                       cwd=REPO, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    out = (p.stdout or "") + (p.stderr or "")
    print(out.strip()[-800:])
    return p.returncode == 0


def build_electron():
    p = subprocess.run(
        ["npm", "run", "build:electron", "-w", "@ai-workbench/desktop"],
        cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace", shell=True,
    )
    return p.returncode == 0, (p.stdout or "") + (p.stderr or "")


def run_e2e():
    p = subprocess.run(
        [PY, E2E], cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    out = (p.stdout or "") + (p.stderr or "")
    failed = set()
    for line in out.splitlines():
        m = re.match(r"\s*\[FAIL\]\s+(\S+)", line)
        if m:
            failed.add(m.group(1))
    return failed, out


def main():
    verdict = False
    print("── 第 0 步：确保 PG 真的可查（本脚本自己起，不依赖上一次调用）──")
    if not ensure_pg():
        print("FAIL PG 起不来 —— 先修环境，再谈反证")
        return 2
    src = open(MAIN_TS, "r", encoding="utf-8").read()
    if src.count(ANCHOR) != 1:
        print("FAIL 注入点数量不对（期望 1 处）—— 先确认 main.ts 有没有被别人改过")
        return 2
    backup = MAIN_TS + ".bak-revert-proof"
    shutil.copyfile(MAIN_TS, backup)
    print("已备份源码 → %s" % os.path.basename(backup))

    try:
        open(MAIN_TS, "w", encoding="utf-8").write(src.replace(ANCHOR, INJECT, 1))
        ok, log = build_electron()
        if not ok:
            print("FAIL 构建失败：\n" + log[-1500:])
            return 2
        print("已注入旧行为（静默新建一轮），并已重新构建 dist-electron\n")

        failed, out = run_e2e()
        print("── 注入后的真机结论（只列 PASS/FAIL 行）──")
        for line in out.splitlines():
            if re.search(r"\[(PASS|FAIL)\]", line):
                print("  " + line.strip())

        verdict = True
        missing = [k for k in EXPECT_RED if k not in failed]
        if missing:
            verdict = False
            print("\n!! 应该变红却没红：%s —— 断言没打到桌面端那道闸，是摆设" % missing)
        else:
            print("\n✓ 预期变红的 %s 全部变红" % EXPECT_RED)
        extra = [k for k in EXPECT_GREEN if k in failed]
        if extra:
            verdict = False
            print("!! 不该红的却红了：%s（说明注入不精确或改动有副作用）" % extra)
        else:
            print("✓ 预期不受影响的 %s 仍然全绿" % EXPECT_GREEN)
    finally:
        shutil.copyfile(backup, MAIN_TS)
        os.remove(backup)
        restored = open(MAIN_TS, "r", encoding="utf-8").read()
        if ANCHOR not in restored or "反证注入" in restored:
            print("\n!! 恢复失败 —— 请手工检查 apps/desktop/electron/main.ts！")
            return 2
        ok2, log2 = build_electron()
        if not ok2:
            print("!! 恢复后构建失败：\n" + log2[-1200:])
            return 2
        print("\n已恢复源码并重新构建（grep 复查：注入行已不在）")

    print("\n反证结论：把桌面端改回旧行为 → %s 变红；恢复后源码已还原。" % EXPECT_RED)
    return 0 if verdict else 1


if __name__ == "__main__":
    sys.exit(main())
