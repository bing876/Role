"""#2 反证：把安全加固**改回加固前**，验证 #2 的断言会变红。

注入的是加固前的真实形态（不是随手编的坏值）：
  · 下载处理器重新接收渲染层递进来的 `tokenRaw` 并优先用它
  · 去掉 `isLoopbackBase` 地址白名单（回到"渲染层说发哪儿就发哪儿"）
  · `agent:start` 的地址也不再受限
  · preload 重新暴露 token 形参
  · 渲染层重新把 `session.token` 递给下载接口

预期变红（至少这几条）：
  ★ 处理器不再引用 tokenRaw
  ★ token 一律取自主进程内存 agentJwt
  ★ 地址经过 isLoopbackBase 白名单
  ★ downloadDoc 签名不再接收 token
  ★ 渲染层不再把 session.token 递给下载接口
  ★ agent:start 也只放行回环地址

跑完自动还原并复跑一次确认回到全绿。整个流程在**一个进程**里完成 ——
本机 agent 沙箱会在工具调用结束时回收派生进程，跨调用编排必然失败。

用法： python scripts/verify/p1-item2-revert-proof.py
"""
import os
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUTDIR = os.path.join(REPO, "docs", "acceptance", "p1-fix")
os.makedirs(OUTDIR, exist_ok=True)

MAIN_TS = os.path.join(REPO, "apps", "desktop", "electron", "main.ts")
PRELOAD_TS = os.path.join(REPO, "apps", "desktop", "electron", "preload.ts")
APP_TSX = os.path.join(REPO, "apps", "desktop", "src", "App.tsx")
SHARED_TS = os.path.join(REPO, "packages", "shared", "src", "index.ts")

# (文件, 加固后的写法, 加固前的写法)
INJECTIONS = [
    # ★ 注意这一条：共享契约里的 `downloadDoc` 也必须一起改回旧签名。
    #   第一次跑反证时**编译直接失败**了 —— 因为主进程/preload 想多接一个 token，
    #   而共享类型只声明了两个形参，tsc 报 TS2322。
    #   这本身是个好消息：**类型系统已经把这个回归堵死了**，
    #   将来谁想再把 token 加回来，必须同时改共享契约（一个显眼、可评审的改动），
    #   而不是悄悄在某个文件里加个参数就完事。
    (SHARED_TS,
     "  downloadDoc: (\n    taskId: number,\n    apiBase: string,\n  ) => Promise<{ saved: boolean; path?: string; canceled?: boolean; error?: string }>;",
     "  downloadDoc: (\n    taskId: number,\n    apiBase: string,\n    token: string,\n  ) => Promise<{ saved: boolean; path?: string; canceled?: boolean; error?: string }>;"),
    (MAIN_TS,
     "ipcMain.handle('workbench:doc:download', async (_event, taskIdRaw: unknown, apiBaseRaw: unknown) => {",
     "ipcMain.handle('workbench:doc:download', async (_event, taskIdRaw: unknown, apiBaseRaw: unknown, tokenRaw: unknown) => {"),
    (MAIN_TS,
     "  if (!isLoopbackBase(wantedBase)) {",
     "  if (false) {"),
    (MAIN_TS,
     "  const token = agentJwt;",
     "  const token = typeof tokenRaw === 'string' && tokenRaw ? tokenRaw : agentJwt;"),
    (MAIN_TS,
     "if (typeof apiBase === 'string' && apiBase && isLoopbackBase(apiBase)) agentApiBase = apiBase;",
     "if (typeof apiBase === 'string' && apiBase) agentApiBase = apiBase;"),
    (PRELOAD_TS,
     "  downloadDoc: (taskId: number, apiBase: string) =>\n    ipcRenderer.invoke('workbench:doc:download', taskId, apiBase),",
     "  downloadDoc: (taskId: number, apiBase: string, token: string) =>\n    ipcRenderer.invoke('workbench:doc:download', taskId, apiBase, token),"),
    (APP_TSX,
     "window.workbench?.downloadDoc(curTask.id, API_BASE())",
     "window.workbench?.downloadDoc(curTask.id, API_BASE(), session.token)"),
]

FILES = [MAIN_TS, PRELOAD_TS, APP_TSX, SHARED_TS]


def build():
    # 共享契约改了就必须先构建它（desktop 的类型检查依赖它的产物）
    for ws in ("@ai-workbench/shared", "@ai-workbench/desktop"):
        cmd = ["npm", "run", "build" if ws.endswith("shared") else "build:electron", "-w", ws]
        r = subprocess.run(cmd, cwd=REPO, shell=True, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=300)
        if r.returncode != 0:
            print("    [!!] 构建失败 %s:" % ws, (r.stdout or "")[-600:], (r.stderr or "")[-300:])
            return False
    return True


def run_verify(tag):
    log = os.path.join(OUTDIR, "item2-revert-%s.log" % tag)
    with open(log, "w", encoding="utf-8", errors="replace") as f:
        subprocess.run(["node", os.path.join(HERE, "p1-item2-verify.js")], cwd=REPO,
                       stdout=f, stderr=subprocess.STDOUT, timeout=180)
    txt = open(log, encoding="utf-8", errors="replace").read()
    fails = re.findall(r"^\s*✗\s+(.+)$", txt, re.M)
    m = re.search(r"结果：(\d+) 条断言，(\d+) 条失败", txt)
    print("    [result] %s 条断言 / %s 条失败" % (m.group(1), m.group(2)) if m else "    [result] 解析失败")
    for x in fails:
        print("        ✗", x.strip())
    return int(m.group(1)) if m else -1, int(m.group(2)) if m else -1, fails


def main():
    print("=" * 70)
    print("#2 反证：改回加固前 → 断言必须变红")
    print("=" * 70)

    backups = {p: open(p, encoding="utf-8").read() for p in FILES}
    results = {}
    try:
        print("\n[0] 基线（加固后）—— 期望 0 条失败")
        if not build():
            return 1
        t, f, _ = run_verify("baseline")
        results["baseline"] = (t, f, [])
        if f != 0:
            print("    !! 基线不绿，反证无意义，先查基线")
            return 1

        print("\n[1] 注入：改回加固前形态")
        for path, cur, old in INJECTIONS:
            src = open(path, encoding="utf-8").read()
            if cur not in src:
                print("    [!!] 找不到片段:", os.path.basename(path), "::", cur[:60])
                return 1
            open(path, "w", encoding="utf-8").write(src.replace(cur, old, 1))
            print("    [patch] %s :: %s" % (os.path.basename(path), cur.strip()[:58]))

        if not build():
            return 1
        t, f, fails = run_verify("injected")
        results["injected"] = (t, f, fails)

    finally:
        print("\n[2] 还原")
        for p, s in backups.items():
            open(p, "w", encoding="utf-8").write(s)
        print("    [restore] 已还原三个文件")
        build()

    t, f, _ = run_verify("restored")
    results["restored"] = (t, f, [])

    print("\n" + "=" * 70)
    print("反证判定")
    print("=" * 70)
    ok = True

    print("基线失败数        :", results["baseline"][1], "（期望 0）")
    ok &= results["baseline"][1] == 0

    inj = results["injected"]
    expect_hits = [
        "处理器不再引用 tokenRaw",
        "token 一律取自主进程内存 agentJwt",
        "地址经过 isLoopbackBase 白名单",
        "downloadDoc 签名不再接收 token",
        "渲染层不再把 session.token 递给下载接口",
        "agent:start 也只放行回环地址",
    ]
    print("注入后失败数      :", inj[1], "（期望 >0）")
    all_hit = True
    for h in expect_hits:
        hit = any(h in x for x in inj[2])
        print("   命中 %-34s: %s" % (h, hit))
        all_hit &= hit
    ok &= (inj[1] > 0 and all_hit)

    print("还原后失败数      :", results["restored"][1], "（期望回到 0）")
    ok &= results["restored"][1] == 0

    print("\n结论：", "反证成立 ✔ 断言有效且加固可逆" if ok else "反证不成立 ✗ 需补强断言")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
