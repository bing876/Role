@echo off
chcp 65001 >nul
cd /d C:\Users\bing\workbuddy-ai\work123
start "wb-devserver" cmd /c "npm run dev:server > C:\Users\bing\workbuddy-ai\work123\docs\dev-server.log 2>&1"
