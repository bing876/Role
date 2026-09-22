@echo off
chcp 936 >nul
cd /d "C:\Users\bing\workbuddy-ai\work123\scripts\verify\help-card"
start "" /B "C://Users//bing//workbuddy-ai//work123//node_modules//electron//dist//electron.exe" . --no-sandbox --user-data-dir="C:/Users/bing/AppData/Local/Temp/wb27-p3" --remote-debugging-port=9358 --remote-allow-origins=*
