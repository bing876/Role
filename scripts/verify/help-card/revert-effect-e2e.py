"""定向反证（⚠️ 结论：**打不到**，是一条**负面证据**，不是有效的反证）：
把 `App.tsx`「切智能体时跟着切求助卡视图」effect 的修复撤掉（回到
`if (browser.view === 'embed') browser.exitEmbed()` 的旧写法），看真机 E2E 会不会变红。

★★ 实测结论（2026-09-21）：**不会变红** —— 注入后仍 46 PASS / 0 FAIL。

  为什么打不到：那条修复防的是"**闭包快照过期**"（卡片出现与切智能体落在同一 commit 批次之前）。
  而真机 E2E 里"卡片出现"和"用户点智能体"**隔着几秒**（脚本自己 sleep、真人更慢），
  中间那次渲染**必然已提交** ⇒ `browser.view` 的快照就是最新的 `'embed'` ⇒ 窗口不开
  ⇒ 旧写法也一样正确。

  所以这条脚本**不能**用来声称"该修复被反证验证过"。
  它真正的价值是**把"常规路径打不到这个时序"这件事钉成证据** ——
  免得后来人以为"注入不红 ⇒ 修复没用 ⇒ 撤掉"。

★ 该修复**真正的**验证依据是 `view-race-closure.mjs`（最小化 React 实验）：
  把这条 effect 的语义搬进最小组件、用真实 react-dom 渲染，
  用 `staleView` 入参**直接把"闭包快照过期"摆出来** ⇒
  旧写法停在 embed（bug 真实）、新写法正确退出（修复承重）。
  证据等级如实标注为"最小化实验"，不是真机。

★ 与另外两条真机反证的分工（那两条**是**有效的）：
  · `revert-activate-e2e.py` 撤 `activate()` 的 `keepEmbed`            → 出问题在**弹卡那一刻**
  · `revert-back-e2e.py`     撤 `exitEmbed()` 的 viewBeforeEmbedRef    → 出问题在**收卡那一刻**

用法（必须同一次调用里先起 PG）：
  python scripts/verify/help-card/_start-pg.py && python scripts/verify/help-card/revert-effect-e2e.py
"""
import io
import os
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
TARGET = os.path.join(REPO, 'apps', 'desktop', 'src', 'App.tsx')
E2E = os.path.join(HERE, 'help-card-e2e.py')
LOG = os.path.join(HERE, 'revert-effect-e2e.log')

# 旧写法：拿闭包快照 `browser.view` 去判，依赖数组里没有 `view` ⇒ 有时序破口
FROM = """    browser.exitEmbed();
    // browser 的方法是稳定引用（只读 ref + setState），无需进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curAgentId, helpCards]);"""
TO = """    // REVERT-INJECT: 旧写法 —— 拿闭包快照 browser.view 判，依赖不含 view
    if (browser.view === 'embed') browser.exitEmbed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curAgentId, helpCards]);"""


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
# ★★ 必须**在归一化后的文本上**做替换：本仓库 *.tsx 是 CRLF，而脚本里的锚点是 LF。
#    不归一化就会静默失配 —— 注入没进去，反证得出"撤掉修复也不红"的**错误结论**。
norm = original.replace('\r\n', '\n')
if FROM not in norm:
    print('FAIL  注入锚点找得到 —— 源码结构变了，先修本脚本')
    sys.exit(1)

print('=== 第 27 步 · 定向反证：撤掉 App.tsx「切智能体跟着切视图」effect 的修复 ===')
print('（预期：HC_MODE=back 的"切到别的对话 → 退出求助卡模式"断言变红）\n')

try:
    patched = norm.replace(FROM, TO).replace('\n', eol)
    write(patched)
    # 写入后**复查**：本仓库踩过「报成功但文件没变」
    if 'REVERT-INJECT' not in read():
        print('FAIL  注入没落盘 —— 中止（否则反证结论是假的）')
        sys.exit(1)
    print('---- 已注入（复查通过），开始跑真机 E2E（HC_MODE=back，约 2.5 分钟）…')
    r = run_e2e()
    print('     注入后：%d PASS，%d FAIL，脚本结论=%s' % (r['pass'], len(r['reds']), '全部通过' if r['allok'] else '未通过'))
    print('     变红的断言：')
    for x in r['reds']:
        print('       - %s' % x)
    # 红的必须**正好**是"切到别的对话/退出 embed"那几条 —— 只变红不够，得红在对的地方
    hit = (not r['allok']) and any(
        '退出求助卡模式' in x or '不留透明层' in x or '切走后回到后台' in x for x in r['reds'])
    ok('撤掉 effect 修复后 E2E 确实变红（且红的正是"切智能体后退出 embed"那几条）',
       hit, 'reds=%s' % r['reds'])
finally:
    write(original)
    back = read()
    ok('已恢复且 token 复查通过', back == original and 'REVERT-INJECT' not in back, '恢复不干净！')

print('\n---- 恢复后再跑一次，应回绿（约 2.5 分钟）…')
r2 = run_e2e()
print('     恢复后：%d PASS，%d FAIL，脚本结论=%s' % (r2['pass'], len(r2['reds']), '全部通过' if r2['allok'] else '未通过'))
ok('恢复后真机 E2E 回到全绿', r2['allok'] and not r2['reds'], r2['reds'])

print('\n=== 定向反证结果：%s ===' % ('全部符合预期' if not FAILS else '有 %d 项不符合预期' % len(FAILS)))
sys.exit(1 if FAILS else 0)
