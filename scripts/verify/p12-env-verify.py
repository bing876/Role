"""#12 第二步验证：PHONE_PEPPER 的强制校验真的生效，且**反证**成立。

三个场景（缺一不可）：
  ① 配了 PHONE_PEPPER          → 服务端正常启动，/health db=up
  ② 把 PHONE_PEPPER 去掉        → **拒绝启动**，错误信息里点名 PHONE_PEPPER
  ③ 把 PHONE_PEPPER 设得极短     → **拒绝启动**，报"太短"

②③ 就是反证：如果去掉校验（改回 `|| dataKey` 的旧写法），
它们会变成"照常启动" → 断言变红。这一步在 p12-revert-proof 里做。

★ 为什么用**临时 .env 副本**而不是直接改 .env：
  改坏了会让用户的开发环境起不来。这里把 .env 复制到临时目录、改副本、
  用 `dotenv_config_path` 指向副本 —— 用户那份 .env 全程不动。

用法： python scripts/verify/p12-env-verify.py
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SERVER_DIR = os.path.join(REPO, "apps", "server")
ENV_FILE = os.path.join(SERVER_DIR, ".env")
NODE = "node"

fails, total = [], 0


def chk(cond, label, detail=""):
    global total
    total += 1
    if cond:
        print("  PASS  " + label)
    else:
        print("  FAIL  " + label + ("   " + detail if detail else ""))
        fails.append(label)
    return cond


def port_free(port, host="127.0.0.1"):
    s = socket.socket()
    s.settimeout(1.0)
    try:
        s.connect((host, port))
        return False
    except OSError:
        return True
    finally:
        s.close()


def run_server_with_env(env_text, port, tag):
    """用指定的 .env 内容起服务端，返回 (起来了?, 日志文本)。"""
    tmpdir = tempfile.mkdtemp(prefix="p12env_")
    env_path = os.path.join(tmpdir, ".env")
    with open(env_path, "w", encoding="utf-8") as f:
        f.write(env_text)
    log_path = os.path.join(tmpdir, "out.log")
    f = open(log_path, "w", encoding="utf-8", errors="replace")
    proc = subprocess.Popen([NODE, "dist/index.js"], cwd=SERVER_DIR,
                            env={**os.environ, "PORT": str(port), "DOTENV_CONFIG_PATH": env_path},
                            stdout=f, stderr=subprocess.STDOUT)
    started = False
    end = time.time() + 40
    while time.time() < end:
        if proc.poll() is not None:
            break
        try:
            with urllib.request.urlopen("http://127.0.0.1:%d/health" % port, timeout=3) as r:
                if r.status == 200:
                    started = True
                    break
        except Exception:
            pass
        time.sleep(1.2)
    try:
        proc.terminate()
        proc.wait(timeout=10)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    f.close()
    log = open(log_path, encoding="utf-8", errors="replace").read()
    shutil.rmtree(tmpdir, ignore_errors=True)
    return started, log


def main():
    print("=" * 70)
    print("#12 验证：PHONE_PEPPER 强制校验")
    print("=" * 70)

    base = open(ENV_FILE, encoding="utf-8").read()
    m = re.search(r"^PHONE_PEPPER=(.*)$", base, re.M)
    if not chk(bool(m), ".env 里存在 PHONE_PEPPER 行"):
        return 1
    pepper = (m.group(1) or "").strip()
    chk(len(pepper) >= 32, ".env 里的 PHONE_PEPPER 已是高熵值（≥32 字符）", "长度=%d" % len(pepper))
    data_key = re.search(r"^DATA_KEY=(.*)$", base, re.M)
    dk = (data_key.group(1) or "").strip() if data_key else ""
    chk(pepper != dk, "★ PHONE_PEPPER 与 DATA_KEY 不同（不再是密钥复用）")

    # ---- ① 配了 pepper → 正常启动 -----------------------------------------
    print("\n[1] 配了 PHONE_PEPPER → 期望正常启动")
    port1 = 8801
    if not chk(port_free(port1), "端口 %d 空闲" % port1):
        return 1
    started, log = run_server_with_env(base, port1, "with")
    chk(started, "① 服务端正常启动（/health 有响应）", log[-300:])

    # ---- ② 去掉 pepper → 拒绝启动 -----------------------------------------
    print("\n[2] 去掉 PHONE_PEPPER → 期望**拒绝启动**（这是反证要打红的点）")
    no_pepper = re.sub(r"^PHONE_PEPPER=.*$", "PHONE_PEPPER=", base, flags=re.M)
    port2 = 8802
    if not chk(port_free(port2), "端口 %d 空闲" % port2):
        return 1
    started2, log2 = run_server_with_env(no_pepper, port2, "without")
    chk(not started2, "② 缺 PHONE_PEPPER 时**拒绝启动**",
        "却起来了 —— 说明强制校验没生效（回退还在）")
    chk("PHONE_PEPPER" in log2, "② 错误信息点名 PHONE_PEPPER",
        "日志片段：%s" % log2[-200:].replace("\n", " "))
    chk('缺少环境变量' in log2, '② 用的是「缺少环境变量」这条既有错误路径')

    # ---- ③ pepper 太短 → 拒绝启动 -----------------------------------------
    print("\n[3] PHONE_PEPPER 设成 'abc' → 期望拒绝启动")
    short = re.sub(r"^PHONE_PEPPER=.*$", "PHONE_PEPPER=abc", base, flags=re.M)
    port3 = 8803
    if not chk(port_free(port3), "端口 %d 空闲" % port3):
        return 1
    started3, log3 = run_server_with_env(short, port3, "short")
    chk(not started3, "③ 过短的 PHONE_PEPPER 被拒", "却起来了")
    chk('PHONE_PEPPER 太短' in log3, '③ 报的是「太短」而不是别的错',
        "日志片段：%s" % log3[-200:].replace("\n", " "))

    # ---- ④ pepper == DATA_KEY → 起得来但必须警告 --------------------------
    print("\n[4] PHONE_PEPPER == DATA_KEY → 允许启动但必须打警告（密钥复用要显形）")
    same = re.sub(r"^PHONE_PEPPER=.*$", "PHONE_PEPPER=" + dk, base, flags=re.M)
    port4 = 8804
    if not chk(port_free(port4), "端口 %d 空闲" % port4):
        return 1
    started4, log4 = run_server_with_env(same, port4, "same")
    chk(started4, "④ 复用 DATA_KEY 时仍能启动（不硬拦，留可操作性）", log4[-250:])
    chk('仍然是密钥复用' in log4, '★ 但日志里明确警告「仍然是密钥复用」',
        "日志片段：%s" % log4[-250:].replace("\n", " "))

    print("\n" + "=" * 70)
    print("结果：%d 条断言，%d 条失败" % (total, len(fails)))
    for x in fails:
        print("   ✗", x)
    print("=" * 70)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
