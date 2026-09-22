"""定向反证：把「求助处理完**从哪来回哪去**」这个修复**撤掉**（回到"一律回全屏"的旧写法），
真机 E2E 的 `HC_MODE=back` 必须变红；恢复后必须回绿。

为什么值得单做一条：
  这个修复针对的是一条**只有真机走得通**的路径 —— 「用户自己点了『退出全屏』，
  正在聊天里看消息，这时来了一张求助卡」。无头渲染层测不到它（那里没有真实点击、
  也没有 `.browserLayer--bg` 这个由 CSS 类驱动的可见态）。
  既然只有真机能看见，那就只有真机能证明这个修复是承重的。

★ 与 revert-activate-e2e.py 的区别（两条反证打的是不同的修复，别混）：
  · revert-activate-e2e 撤的是 `activate()` 里的 `keepEmbed`（防"卡片刚弹出就被冲掉"）；
  · 本脚本撤的是 `exitEmbed()` 里的 `viewBeforeEmbedRef` 恢复（防"收卡时把用户顶成全屏"）。
  两者都表现为"视图态不对"，但发生的**时刻**相反（弹卡那一刻 vs 收卡那一刻），
  所以必须各有一条，否则其中一个坏了会被另一个的绿掩盖。

用法（必须同一次调用里先起 PG）：
  python scripts/verify/help-card/_start-pg.py && HC_MODE=back python scripts/verify/help-card/revert-back-e2e.py
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
LOG = os.path.join(HERE, 'revert-back-e2e.log')

# 旧写法：记录不看、一律回全屏（这正是修复前那一版代码）
FROM = """    const back = viewBeforeEmbedRef.current;
    viewBeforeEmbedRef.current = null;
    setView((v) => (v === 'embed' ? back ?? 'fullscreen' : v));"""
TO = """    setView((v) => (v === 'embed' ? 'fullscreen' : v)); // REVERT-INJECT: 一律回全屏的旧写法"""


def read():
    with io.open(TARGET, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def write(text):
    with io.open(TARGET, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def run_e2e():
    env = dict(os.environ)
    env['HC_MODE'] = 'back'
    r = subprocess.run([sys.executable, '-u', E2E], capture_output=True, text=True,
                       encoding='utf-8', errors='replace', cwd=HERE, env=env)
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
#    不归一化就会静默失配 —— 注入没进去，反证得出"撤掉修复也不红"的**错误结论**
#    （这个坑本仓库今天已经踩过两次）。
norm = original.replace('\r\n', '\n')
if FROM not in norm:
    print('FAIL  注入锚点找得到 —— 源码结构变了，先修本脚本')
    sys.exit(1)

print('=== 第 27 步 · 定向反证：撤掉 exitEmbed 的「从哪来回哪去」修复 ===')
print('（预期：HC_MODE=back 的"收卡后回后台"断言变红 —— 因为旧写法一律回全屏）\n')

try:
    patched = norm.replace(FROM, TO).replace('\n', eol)
    write(patched)
    # 写入后**复查**：本仓库踩过「报成功但文件没变」
    if 'REVERT-INJECT' not in read():
        print('FAIL  注入没落盘 —— 中止（否则反证结论是假的）')
        sys.exit(1)
    print('---- 已注入（复查通过），开始跑真机 E2E（HC_MODE=back，约 2 分钟）…')
    r = run_e2e()
    print('     注入后：%d PASS，%d FAIL，脚本结论=%s' % (r['pass'], len(r['reds']), '全部通过' if r['allok'] else '未通过'))
    print('     变红的断言：')
    for x in r['reds']:
        print('       - %s' % x)
    # 红的必须**正好**是"回后台"那几条 —— 只变红不够，得红在对的地方
    hit = (not r['allok']) and any('回**后台**' in x or '回后台' in x or '变成全屏' in x for x in r['reds'])
    ok('撤掉修复后 E2E 确实变红（且红的正是"收卡后回后台"那几条）', hit, 'reds=%s' % r['reds'])
finally:
    write(original)
    back = read()
    ok('已恢复且 token 复查通过', back == original and 'REVERT-INJECT' not in back, '恢复不干净！')

print('\n---- 恢复后再跑一次，应回绿（约 2 分钟）…')
r2 = run_e2e()
print('     恢复后：%d PASS，%d FAIL，脚本结论=%s' % (r2['pass'], len(r2['reds']), '全部通过' if r2['allok'] else '未通过'))
ok('恢复后真机 E2E 回到全绿', r2['allok'] and not r2['reds'], r2['reds'])

print('\n=== 定向反证结果：%s ===' % ('全部符合预期' if not FAILS else '有 %d 项不符合预期' % len(FAILS)))
sys.exit(1 if FAILS else 0)
