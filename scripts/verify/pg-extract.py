"""解压 zonky 嵌入式 PostgreSQL（.txz），并校验关键文件大小。

★ 为什么不用 Git Bash 的 `tar -xJf`：
  它在这台机器上会中途失败（"Error is not recoverable"），
  留下一个**被截断但看起来存在**的 postgres.exe（3.5MB，正常是 8.5MB）——
  然后运行报 0xC0000135（缺 DLL）/ Exec format error，排查方向完全跑偏。
  Python 的 tarfile 更稳；且这里**强制校验大小**，截断能立刻发现。
"""
import os
import sys
import tarfile

SRC = r"C:\Users\bing\workbuddy-ai\pg2\postgres-windows-x86_64.txz"
DST = r"C:\Users\bing\workbuddy-ai\pg2\pg"

expect = {
    "bin/postgres.exe": 8472064,
    "bin/initdb.exe": 207872,
    "bin/pg_ctl.exe": 122368,
    "bin/libpq.dll": 326144,
    "bin/zlib1.dll": 89600,
}

print("源:", SRC, os.path.exists(SRC), os.path.getsize(SRC) if os.path.exists(SRC) else 0)

os.makedirs(DST, exist_ok=True)
n = 0
with tarfile.open(SRC, "r:xz") as t:
    for m in t:
        # 只解 bin/ 和 lib/ 和 share/（全解也行，但省点时间）
        t.extract(m, DST)
        n += 1
print("解出条目:", n)

print("\n关键文件校验:")
bad = 0
for rel, want in expect.items():
    p = os.path.join(DST, rel)
    got = os.path.getsize(p) if os.path.exists(p) else -1
    ok = got == want
    if not ok:
        bad += 1
    print(f"  {'OK ' if ok else '★BAD'} {rel}: {got} (期望 {want})")

print("\nbin 目录文件数:", len(os.listdir(os.path.join(DST, "bin"))))
sys.exit(1 if bad else 0)
