# 用 GBK 写 .cmd —— 本机 bash 直接 start 中文名 exe 会被 shim 吞字符，
# 必须由 cmd.exe 自己解析。写成 GBK 才能让 cmd 正确认出「AI 工作台.exe」。
import pathlib

CMD = (
    "@echo off\r\n"
    "chcp 936 >nul\r\n"
    'cd /d "C:\\Users\\bing\\AppData\\Local\\Programs\\@ai-workbenchdesktop"\r\n'
    'start "" "AI 工作台.exe" --no-sandbox --remote-debugging-port=9222\r\n'
)

out = pathlib.Path(r"C:\Users\bing\workbuddy-ai\work123\.workbuddy-ai\_launch-cdp.cmd")
out.write_bytes(CMD.encode("gbk"))
print("written:", out, out.stat().st_size, "bytes")
