#!/usr/bin/env python3
"""片⑤ 生产路径反证：钥匙/环境/React 引导与外部端口隔离，拔一处即红。"""
import hashlib
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NODE = shutil.which('node') or 'node'
TSX = str(ROOT / 'node_modules/tsx/dist/cli.mjs')
CASES = [
    (
        'electron-builder 丢弃包内 node_modules',
        ROOT / 'apps/desktop/package.json',
        '"from": "packaging/node_modules",',
        '"from": "packaging/not-the-dependencies",',
        'scripts/verify/release-runtime.mts', 'electron-builder 真实过滤器未纳入',
    ),
    (
        '缺钥匙却重新生成',
        ROOT / 'apps/desktop/electron/packaged-runtime.ts',
        "if (existsSync(databaseDir) && !existsSync(path.join(privateDir, 'local-runtime.json')))\n",
        "if (false && existsSync(databaseDir) && !existsSync(path.join(privateDir, 'local-runtime.json')))\n",
        'scripts/verify/release-runtime.mts', 'missing_key_should_fail_closed',
    ),
    (
        '拔掉打包后端密钥与数据库传参',
        ROOT / 'apps/desktop/electron/server-supervisor.ts',
        "...(runtime ? { NODE_OPTIONS: '', NODE_PATH: '', ...runtime.serverEnv } : {}),",
        "...(runtime ? { NODE_OPTIONS: '', NODE_PATH: '' } : {}),",
        'scripts/verify/release-runtime.mts', '上线运行态 FAIL',
    ),
    (
        '拔掉首跑卡接线',
        ROOT / 'apps/desktop/src/features/auth/AuthScreen.tsx',
        'if (localFirstRun) return <LocalFirstRun onSession={onSession} />;',
        'if (false && localFirstRun) return <LocalFirstRun onSession={onSession} />;',
        'scripts/verify/release-ui-smoke.mts', '空库必须露出一次性引导',
    ),
    (
        '开发假模型污染生产安装包',
        ROOT / 'apps/server/src/env.ts',
        "  if (localMode && (deepseekApiKey === 'mock' || deepseekApiKey.startsWith('mock:')))\n",
        "  if (false && localMode && (deepseekApiKey === 'mock' || deepseekApiKey.startsWith('mock:')))\n",
        'scripts/verify/release-runtime.mts', 'Missing expected exception',
    ),
    (
        '允许旧自定义地址窃取安装包凭证',
        ROOT / 'apps/desktop/src/shared/api.ts',
        "  if (typeof window !== 'undefined' && window.workbench?.isPackaged === true) return 'http://127.0.0.1:8787';",
        "  if (false && typeof window !== 'undefined' && window.workbench?.isPackaged === true) return 'http://127.0.0.1:8787';",
        'scripts/verify/release-ui-smoke.mts', '不能把密码/JWT 发往外部',
    ),
    (
        '端口被占仍探测伪造的后端',
        ROOT / 'apps/desktop/src/features/auth/AuthScreen.tsx',
        "if (!s.ownedByUs || !s.reachable) throw new Error('等待安装包自带的服务端');",
        "if (false && (!s.ownedByUs || !s.reachable)) throw new Error('等待安装包自带的服务端');",
        'scripts/verify/release-ui-smoke.mts', '端口被占用时不应请求别人的',
    ),
]


def run(script):
    result = subprocess.run([NODE, TSX, script], cwd=ROOT, capture_output=True, text=True, timeout=150)
    return result.returncode, result.stdout + result.stderr


def main():
    for script, expected in [('scripts/verify/release-runtime.mts', 'PASS 9 / FAIL 0'),
                             ('scripts/verify/release-ui-smoke.mts', 'PASS 5 / FAIL 0')]:
        code, trace = run(script)
        assert code == 0 and expected in trace, f'反证基线不绿 {script}：{trace[-1400:]}'
    print('上线反证基线：真 staging/HTTP/持久库 9/0 + React 首跑 UI 5/0')
    for idx, (name, target, anchor, replacement, script, expected) in enumerate(CASES, 1):
        original = target.read_bytes()
        assert original.count(anchor.encode()) == 1, f'反证 {idx} 生产锚点漂移/不唯一：{anchor}'
        try:
            target.write_bytes(original.replace(anchor.encode(), replacement.encode(), 1))
            code, trace = run(script)
        finally:
            target.write_bytes(original)
        assert code != 0 and expected in trace, f'反证 {idx} 未在指定断言红：{trace[-1800:]}'
        assert hashlib.sha256(original).digest() == hashlib.sha256(target.read_bytes()).digest(), '原字节未恢复'
        print(f'  ✓ 反证 {idx}「{name}」→ EXIT {code} 命中期望断言、原字节恢复')
    print(f'上线反证 PASS {len(CASES)} / FAIL 0（各拆一处生产能力，验收必红）')


if __name__ == '__main__':
    main()
