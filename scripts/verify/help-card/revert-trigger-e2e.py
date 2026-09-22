"""定向反证：把**保守触发的条件 B**（"AI 确实卡住了"）撤掉 → 真机 E2E 必须变红。

为什么单做一条：
  「保守触发」是用户点名的**核心验收点**，但它的反证之前只在**逻辑层**（revert-proof.mjs 的注入 B）。
  现在真机 E2E 跑得起来了，就在真机上再证一次 —— 撤掉条件 B 之后，
  「页面像登录页但 AI 没卡住」那两个反例场景（② / ②-b）**必须**冒出卡片。

注入方式（与逻辑层那条同构、保持可编译）：在**每一步成功之后**也无条件调 `maybeRaiseHelp`。
  原代码只在「确实卡住了」的三个点调它；这一注入把"卡住"这个条件整个抹掉。

用法（必须同一次调用里先起 PG）：
  python scripts/verify/help-card/_start-pg.py && python scripts/verify/help-card/revert-trigger-e2e.py
"""
import io
import os
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
TARGET = os.path.join(REPO, 'apps', 'desktop', 'electron', 'agent.ts')
E2E = os.path.join(HERE, 'help-card-e2e.py')
LOG = os.path.join(HERE, 'revert-trigger-e2e.log')

FROM = """      staleClicks = 0;
      fails = 0;
      result = toResult(res);
      continue;"""
TO = """      staleClicks = 0;
      fails = 0;
      maybeRaiseHelp('REVERT-INJECT: 条件 B 失效');
      result = toResult(res);
      continue;"""

FAILS = []


def ok(name, cond, extra=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('   << ' + str(extra)) if (extra and not cond) else ''))
    if not cond:
        FAILS.append(name)


def read(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def write(p, text):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def build():
    r = subprocess.run(['npm', 'run', 'build:electron', '-w', '@ai-workbench/desktop'],
                       cwd=REPO, capture_output=True, text=True, encoding='utf-8',
                       errors='replace', shell=True)
    return r.returncode == 0, (r.stdout or '') + (r.stderr or '')


def run_e2e():
    env = dict(os.environ)
    env['HC_MODE'] = 'auto'   # ② / ②-b 两个反例场景在 auto 模式下就会跑
    r = subprocess.run([sys.executable, '-u', E2E], capture_output=True, text=True,
                       encoding='utf-8', errors='replace', cwd=HERE, env=env)
    out = (r.stdout or '') + (r.stderr or '')
    with io.open(LOG, 'w', encoding='utf-8') as f:
        f.write(out)
    reds = [x.strip() for x in re.findall(r'^  \[FAIL\] (.+?)(?:  ——|$)', out, re.M)]
    passes = len(re.findall(r'^  \[PASS\]', out, re.M))
    return {'pass': passes, 'reds': reds, 'allok': '全部通过' in out}


original = read(TARGET)
eol = '\r\n' if '\r\n' in original else '\n'
norm = original.replace('\r\n', '\n')      # ★ 先归一化再匹配（CRLF 坑，本轮踩过两次）
if FROM not in norm:
    print('FAIL  注入锚点找得到 —— 源码结构变了，先修本脚本')
    sys.exit(1)

print('=== 第 27 步 · 定向反证：撤掉保守触发的「条件 B」 ===')
print('（预期：②/②-b 两个"页面像登录页但 AI 没卡住"的反例场景冒出卡片）\n')

try:
    write(TARGET, norm.replace(FROM, TO).replace('\n', eol))
    if 'REVERT-INJECT' not in read(TARGET):   # ★ 写入后复查（本仓库踩过"报成功但没变"）
        print('FAIL  注入没落盘 —— 中止（否则结论是假的）')
        sys.exit(1)
    built, blog = build()
    ok('注入后仍可编译', built, blog[-400:])
    if not built:
        raise SystemExit(1)
    print('---- 已注入并重建，开始跑真机 E2E（约 4 分钟）…')
    r = run_e2e()
    print('     注入后：%d PASS，%d FAIL，脚本结论=%s' % (r['pass'], len(r['reds']), '全部通过' if r['allok'] else '未通过'))
    for x in r['reds']:
        print('       - %s' % x)
    hit = (not r['allok']) and any(('保守触发反例' in x) or ('一次都没弹卡' in x) or ('不该弹卡' in x) for x in r['reds'])
    ok('撤掉条件 B 后，两个保守反例场景确实变红', hit, 'reds=%s' % r['reds'])
finally:
    write(TARGET, original)
    ok('已恢复且 token 复查通过', read(TARGET) == original and 'REVERT-INJECT' not in read(TARGET), '恢复不干净！')
    built2, blog2 = build()
    ok('恢复后重新构建通过', built2, blog2[-300:])

print('\n---- 恢复后再跑一次，应回绿（约 4 分钟）…')
r2 = run_e2e()
print('     恢复后：%d PASS，%d FAIL，脚本结论=%s' % (r2['pass'], len(r2['reds']), '全部通过' if r2['allok'] else '未通过'))
ok('恢复后真机 E2E 回到全绿', r2['allok'] and not r2['reds'], r2['reds'])

print('\n=== 定向反证结果：%s ===' % ('全部符合预期' if not FAILS else '有 %d 项不符合预期' % len(FAILS)))
sys.exit(1 if FAILS else 0)
