import os

# GBK 编码且**不要** chcp 65001：cmd 默认按 GBK(936) 读批处理，加了 chcp 会按 UTF-8 读，
# 中文文件名 "AI 工作台.exe" 会被读坏 => "The system cannot find the file ..."
p = r'C:\Users\bing\workbuddy-ai\work123\.workbuddy-ai\_start-debug.cmd'
lines = [
    '@echo off',
    r'cd /d "C:\Users\bing\AppData\Local\Programs\@ai-workbenchdesktop"',
    'start "" "AI 工作台.exe" --no-sandbox --remote-debugging-port=9222',
]
with open(p, 'w', encoding='gbk', newline='\r\n') as f:
    f.write('\n'.join(lines) + '\n')

with open(p, encoding='gbk') as f:
    print(f.read())
print('bytes=', os.path.getsize(p))
