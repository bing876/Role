"""定向反证：把「`activate()` 在求助卡模式下不许抢视图」这个修复**撤掉**，
真机 E2E 必须变红；恢复后必须回绿。

为什么值得单做一条（而不是并进 revert-proof.mjs）：
  这个 bug 是**真机端到端才逼出来的**（无头渲染层测不到 —— 那里没有主进程发
  `workbench:browser:focus` 这条消息）。既然只有 E2E 能看见它，
  那也只有 E2E 能证明"这个修复是承重的"。
  一次 E2E 要 ~4 分钟，所以只对它做一条定向反证，不塞进那个跑 7 条注入的脚本里。

用法（必须同一次调用里先起 PG）：
  python scripts/verify/help-card/_start-pg.py && python scripts/verify/help-card/revert-activate-e2e.py
"""
import io
import os
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
TARGET = os.path.join(REPO, 'apps', 'desktop', 'src', 'browser', 'useBrowserWorkspace.ts')
E2E = os.path.join(HERE, 'help-card-e2e.py')
LOG = os.path.join(HERE, 'revert-activate-e2e.log')

FROM = """    const keepEmbed =
      embedWcIdRef.current !== null && webContentsIdOf(tabId) === embedWcIdRef.current;
    if (!keepEmbed) setView('fullscreen');"""
TO = """    setView('fullscreen'); // REVERT-INJECT: 恢复成"无条件抢视图"的旧写法"""


def read():
    with io.open(TARGET, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def write(text):
    with io.open(TARGET, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def run_e2e():
    r = subprocess.run([sys.executable, '-u', E2E], capture_output=True, text=True,
                       encoding='utf-8', errors='replace', cwd=HERE, env=dict(os.environ))
    out = (r.stdout or '') + (r.stderr or '')
    with io.open(LOG, 'w', encoding='utf-8') as f:
        f.write(out)
    reds = re.findall(r'^  \[FAIL\] (.+?)(?:  ——|$)', out, re.M)
    passes = len(re.findall(r'^  \[PASS\]', out, re.M))
    allok = '全部通过' in out
    return {'exit': r.returncode, 'pass': passes, 'reds': [x.strip() for x in reds], 'allok': allok}


FAILS = []
def ok(name, cond, extra=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('   << ' + str(extra)) if (extra and not cond) else ''))
    if not cond:
        FAILS.append(name)


original = read()
eol = '\r\n' if '\r\n' in original else '\n'
# ★★ 必须**在归一化后的文本上**做替换：本仓库 *.ts 是 CRLF，而脚本里的锚点是 LF。
#    第一版直接 `original.replace(FROM, TO)` —— 匹配不上、静默什么都不改，
#    于是"注入"其实没注入，反证得出"撤掉修复也不红"的**错误结论**。
#    （同一个坑今天已经踩过第二次了，写补丁脚本先探行尾。）
norm = original.replace('\r\n', '\n')
if FROM not in norm:
    print('FAIL  注入锚点找得到 —— 源码结构变了，先修本脚本')
    sys.exit(1)

print('=== 第 27 步 · 定向反证：撤掉 activate() 的"不抢视图"修复 ===')
print('（预期：真机 E2E 的 embed/几何断言变红 —— 因为 browser:focus 会把求助卡模式冲掉）\n')

try:
    patched = norm.replace(FROM, TO).replace('\n', eol)
    write(patched)
    # 写入后**复查**：本仓库踩过「报成功但文件没变」
    if 'REVERT-INJECT' not in read():
        print('FAIL  注入没落盘 —— 中止（否则反证结论是假的）')
        sys.exit(1)
    print('---- 已注入（复查通过），开始跑真机 E2E（约 4 分钟）…')
    r = run_e2e()
    print('     注入后：%d PASS，%d FAIL，脚本结论=%s' % (r['pass'], len(r['reds']), '全部通过' if r['allok'] else '未通过'))
    print('     变红的断言：')
    for x in r['reds']:
        print('       - %s' % x)
    hit = (not r['allok']) and any('embed' in x or '几何' in x or '占位区' in x for x in r['reds'])
    ok('撤掉修复后 E2E 确实变红（且红的正是 embed/几何那几条）', hit,
       'reds=%s' % r['reds'])
finally:
    write(original)
    back = read()
    ok('已恢复且 token 复查通过', back == original and 'REVERT-INJECT' not in back, '恢复不干净！')

print('\n---- 恢复后再跑一次，应回绿（约 4 分钟）…')
r2 = run_e2e()
print('     恢复后：%d PASS，%d FAIL，脚本结论=%s' % (r2['pass'], len(r2['reds']), '全部通过' if r2['allok'] else '未通过'))
ok('恢复后真机 E2E 回到全绿', r2['allok'] and not r2['reds'], r2['reds'])

print('\n=== 定向反证结果：%s ===' % ('全部符合预期' if not FAILS else '有 %d 项不符合预期' % len(FAILS)))
sys.exit(1 if FAILS else 0)
