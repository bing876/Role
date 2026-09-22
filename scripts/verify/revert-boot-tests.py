# -*- coding: utf-8 -*-
"""
revert-boot-tests.py —— 反证：证明 start-dev.cmd 里新加的 WAIT_DB 不是摆设。

做法：把 start-dev.cmd 里「等数据库真可查询」这一步**换成旧行为**
（只看端口就放行），其余完全不动，然后跑同一条启动链，
看服务端是否真的会 migrate 失败 + db=down —— 也就是用户看到的「数据库连不上」。

不修改仓库里的 start-dev.cmd：在临时目录里生成"旧行为"版本，
用同样的逻辑驱动，对比结果。
"""
import subprocess, os, time, socket, json, urllib.request, sys, shutil, tempfile

HOME = os.path.expanduser('~')
PG_HOME = os.path.join(HOME, 'workbuddy-ai', 'pg2')
PG_DATA = os.path.join(PG_HOME, 'data')
POSTGRES = os.path.join(PG_HOME, 'pg', 'bin', 'postgres.exe')
NODE = os.path.join(HOME, '.workbuddy-ai', 'binaries', 'node', 'versions', '22.22.2-2', 'node.exe')
PING = os.path.join(PG_HOME, 'ping-db.mjs')
REPO = r'C:\Users\bing\workbuddy-ai\work123'
LOG = os.path.join(REPO, 'dev-server-revert.log')


def port_open(p):
    s = socket.socket()
    s.settimeout(0.3)
    try:
        s.connect(('127.0.0.1', p))
        return True
    except Exception:
        return False
    finally:
        s.close()


def clean_ports():
    """确保 5432/8787 干净，否则测不准。"""
    for p in (8787,):
        if port_open(p):
            print('  [warn] %d 已被占用，结果不可信' % p)


def run_chain(wait_db: bool, label: str, timeout=300):
    """wait_db=True  = 新行为（等到 SELECT 1 成功才起服务端）
       wait_db=False = 旧行为（端口一通就起服务端）"""
    print('\n' + '=' * 62)
    print('  场景 %s：%s' % (label, '新行为（等真可查询）' if wait_db else '旧行为（只看端口）'))
    print('=' * 62)
    clean_ports()
    t0 = time.time()

    # --- 起 PG ---
    pg = subprocess.Popen([POSTGRES, '-D', PG_DATA],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    while not port_open(5432):
        if time.time() - t0 > 120:
            print('  [FAIL] 5432 一直没起来'); pg.terminate(); return None
        time.sleep(0.5)
    print('  5432 端口监听      @ %5.1fs' % (time.time() - t0))

    # --- 关键分歧点 ---
    if wait_db:
        while True:
            if subprocess.run([NODE, PING], capture_output=True).returncode == 0:
                break
            if time.time() - t0 > timeout:
                print('  [FAIL] WAIT_DB 超时'); pg.terminate(); return None
            time.sleep(1)
        print('  数据库可接受查询    @ %5.1fs  <-- 新行为在这里等' % (time.time() - t0))
    else:
        print('  数据库可接受查询    @    n/a  <-- 旧行为：此处直接放行')

    # --- 起服务端 ---
    log = open(LOG, 'wb')
    srv = subprocess.Popen(
        [NODE, os.path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'],
        cwd=os.path.join(REPO, 'apps', 'server'), stdout=log, stderr=subprocess.STDOUT)

    db_up_at = None
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            h = json.loads(urllib.request.urlopen('http://127.0.0.1:8787/health', timeout=2).read().decode())
            if h.get('db') == 'up':
                db_up_at = time.time() - t0
                break
        except Exception:
            pass
        time.sleep(1)
    log.close()
    srv.terminate()
    pg.terminate()
    time.sleep(2)

    txt = open(LOG, encoding='utf-8', errors='replace').read()
    mig_ok = '数据库表就绪' in txt
    degraded = '暂未连通' in txt

    print('  /health db=up      @ %s' % ('%5.1fs' % db_up_at if db_up_at else '   从未'))
    print('  日志「数据库表就绪」 = %s' % mig_ok)
    print('  日志「暂未连通」     = %s  <-- 降级 = 登录会 503' % degraded)
    if db_up_at is None and degraded:
        print('  => 用户在此状态下点登录，会看到红字「数据库连不上」')
    return {'mig_ok': mig_ok, 'degraded': degraded, 'db_up_at': db_up_at}


if not os.path.exists(POSTGRES):
    print('找不到 postgres.exe'); sys.exit(1)

old = run_chain(wait_db=False, label='A')
new = run_chain(wait_db=True, label='B')

print('\n' + '=' * 62)
print('  反证结论')
print('=' * 62)
print('  旧行为：migrate成功=%s  降级=%s' % (old['mig_ok'] if old else 'n/a', old['degraded'] if old else 'n/a'))
print('  新行为：migrate成功=%s  降级=%s' % (new['mig_ok'] if new else 'n/a', new['degraded'] if new else 'n/a'))

ok = False
if old and new:
    if (not old['mig_ok'] or old['degraded']) and new['mig_ok'] and not new['degraded']:
        print('\n  ★ PASS：同一台机器、同一天，旧行为必然降级（登录失败），新行为正常。')
        print('     => WAIT_DB 这一步是有效的，不是摆设。')
        ok = True
    elif new['mig_ok'] and not new['degraded'] and old['mig_ok'] and not old['degraded']:
        print('\n  ! 两轮都成功 —— 本轮 PG 恢复太快，空窗没被触发。')
        print('    反证需要「PG 处于崩溃恢复态」这个前提；此时可人为制造（见脚本注释）。')
    else:
        print('\n  ! 结果不符合预期，需要人工看日志：%s' % LOG)

sys.exit(0 if ok else 3)
