@echo off
chcp 936 >nul
title AI 工作台 - 一键启动（数据库 + 服务端）
cd /d "%~dp0"

echo ============================================================
echo   AI 工作台  本机一键启动
echo ============================================================
echo.

set PG_HOME=%USERPROFILE%\workbuddy-ai\pg2
set PG_BIN=%PG_HOME%\pg\bin
set PG_DATA=%PG_HOME%\data
set REPO=%~dp0
set NODE=%USERPROFILE%\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe
set DB_PING=%PG_HOME%\ping-db.mjs

REM ---------- 0) 自检 ----------
if not exist "%PG_BIN%\postgres.exe" (
  echo [错误] 找不到 PostgreSQL 便携包：
  echo        %PG_BIN%\postgres.exe
  echo        先跑：node scripts\verify\pg-bringup.mjs
  pause
  exit /b 1
)
if not exist "%NODE%" (
  echo [提示] 找不到托管 node，改用 PATH 里的 node
  set NODE=node
)

REM ---------- 1) 清掉陈旧 pid（否则 PG 拒绝启动） ----------
if not exist "%PG_DATA%\postmaster.pid" (
  echo [1/4] 无 pid 残留，直接启动
  goto PID_DONE
)
echo [1/4] 发现残留 postmaster.pid，正在检查...
setlocal enabledelayedexpansion
set OLD=
for /f "usebackq delims=" %%i in ("%PG_DATA%\postmaster.pid") do (
  if not defined OLD set OLD=%%i
)
endlocal & set OLD=%OLD%
echo       旧 PID = %OLD%
tasklist /FI "PID eq %OLD%" /NH /FO CSV 2>nul | find "%OLD%" >nul
if errorlevel 1 (
  echo       该进程已不存在，删除 pid 文件
  del /f /q "%PG_DATA%\postmaster.pid"
) else (
  echo       该进程仍在运行，先停掉它
  "%PG_BIN%\pg_ctl.exe" stop -D "%PG_DATA%" -m fast
  timeout /t 5 >nul
  if exist "%PG_DATA%\postmaster.pid" del /f /q "%PG_DATA%\postmaster.pid"
)
:PID_DONE

REM ---------- 2) 起 PostgreSQL ----------
echo.
echo [2/4] 启动 PostgreSQL（5432）...
"%PG_BIN%\pg_ctl.exe" status -D "%PG_DATA%" >nul 2>&1
if not errorlevel 1 (
  echo       PostgreSQL 已在运行，跳过
  goto PG_OK
)
start "AI工作台-PostgreSQL" /MIN "%PG_BIN%\postgres.exe" -D "%PG_DATA%"
echo       已在新窗口启动。
call :WAIT_PORT 5432 90
if errorlevel 1 (
  echo       [错误] 90 秒内 5432 没起来。日志：
  if exist "%PG_HOME%\pg.log" type "%PG_HOME%\pg.log"
  pause
  exit /b 1
)
echo       端口已就绪。

REM ★ 关键：端口通 != 数据库可用。
REM 上一次被强杀后，PG 会先做全库 fsync + WAL 回放，期间端口早已监听，
REM 但任何查询都会报 "the database system is starting up"。这段时间内启动的
REM 服务端会 migrate 失败并静默降级（/auth 回 503，登录就报「数据库连不上」）。
echo       正在等待数据库真正接受查询（首次恢复可能要 1~2 分钟）...
call :WAIT_DB 240
if errorlevel 1 (
  echo       [警告] 数据库 240 秒内没能接受查询，仍然继续。
  echo              服务端 /health 的 db 字段可能是 down，登录会失败。
)
:PG_OK

REM ---------- 2.5) 起 PG 看门狗（保活） ----------
REM ★ PG 是独立进程：被关掉/杀掉后没人拉起来的话，服务端会一直回 503
REM   （界面红字「数据库没连上」）。看门狗每 10 秒探一次 postgres.exe，
REM   不在就清掉残留 postmaster.pid 再重新拉起。
if not exist "%PG_HOME%\watchdog.cmd" (
  echo       [跳过] 没找到 %PG_HOME%\watchdog.cmd
  goto WD_DONE
)
if exist "%PG_HOME%\watchdog.lock" (
  tasklist /FI "IMAGENAME eq postgres.exe" /NH 2>nul | find /I "postgres.exe" >nul
  if not errorlevel 1 (
    echo       看门狗已在运行（锁在、PG 也在），跳过
    goto WD_DONE
  )
  echo       锁还在但 PG 没在跑 —— 看门狗已失效，重新启动
  del /f /q "%PG_HOME%\watchdog.lock"
)
echo       启动 PG 看门狗（PG 掉了会自动重启）...
start "pgwatchdog" /MIN cmd /c "%PG_HOME%\watchdog.cmd"
echo started > "%PG_HOME%\watchdog.lock"
:WD_DONE

REM ---------- 3) 起服务端 ----------
echo.
echo [3/4] 启动服务端（8787）...
netstat -ano | findstr ":8787 " | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo       8787 已在监听，跳过
  goto SRV_OK
)
start "AI工作台-服务端" /MIN cmd /c ""%NODE%" "%REPO%node_modules\tsx\dist\cli.mjs" src\index.ts"
:SRV_OK

REM ---------- 4) 确认数据库真的通了（这才是能登录的前提） ----------
echo.
echo [4/4] 确认服务端已连上数据库...
call :WAIT_HEALTH 120
if errorlevel 1 (
  echo       [警告] /health 一直没报 db = up。
  echo              打开 http://127.0.0.1:8787/health 自己看一眼 db 字段；
  echo              若为 down，请关掉两个窗口重跑本脚本。
)

echo.
echo ============================================================
echo   启动完成
echo.
echo   现在可以打开 AI 工作台 应用登录了。
echo.
echo   数据库：127.0.0.1:5432
echo   服务端：http://127.0.0.1:8787/health
echo.
echo   验证码是 mock 的，不发短信 —— 看「AI工作台-服务端」那个窗口
echo   （里面会打印：[sms:mock]  -^> 186****xxxx  验证码 123456）
echo.
echo   两个窗口请不要关，关了服务就停了。
echo ============================================================
echo.
echo 本窗口可以关掉（服务在另外两个窗口里跑）。
echo 若要停止服务：关掉「AI工作台-PostgreSQL」和「AI工作台-服务端」两个窗口。

goto :EOF

REM ---------- 子过程：等待某个端口进入 LISTENING ----------
REM 用法：call :WAIT_PORT ^<端口^> ^<超时秒数^>   ；成功 errorlevel=0，超时=1
:WAIT_PORT
setlocal
set WP_PORT=%1
set WP_MAX=%2
set /a WP_N=0
:WP_LOOP
set /a WP_N+=1
if %WP_N% GTR %WP_MAX% endlocal & exit /b 1
netstat -ano | findstr ":%WP_PORT% " | findstr "LISTENING" >nul
if not errorlevel 1 endlocal & exit /b 0
timeout /t 1 >nul
goto WP_LOOP

REM ---------- 子过程：等待数据库真正接受查询 ----------
REM ★ 端口通不代表可用：PG 恢复期间端口已开，但查询会报
REM   "the database system is starting up"。必须真的 SELECT 1 成功才算就绪。
REM 用法：call :WAIT_DB ^<超时秒数^>
:WAIT_DB
setlocal
set WD_MAX=%1
set /a WD_N=0
if not exist "%DB_PING%" (
  echo       [跳过] 没找到 %DB_PING%，无法主动探活
  endlocal & exit /b 0
)
:WD_LOOP
set /a WD_N+=1
"%NODE%" "%DB_PING%" >nul 2>&1
if not errorlevel 1 (
  echo       数据库已可接受查询（用时 %WD_N% 秒）
  endlocal & exit /b 0
)
if %WD_N% GTR %WD_MAX% endlocal & exit /b 1
timeout /t 1 >nul
goto WD_LOOP

REM ---------- 子过程：等待服务端 /health 报 db = up ----------
REM 用法：call :WAIT_HEALTH ^<超时秒数^>
:WAIT_HEALTH
setlocal
set WH_MAX=%1
set /a WH_N=0
:WH_LOOP
set /a WH_N+=1
for /f "usebackq delims=" %%r in (`""%NODE%" -e "fetch('http://127.0.0.1:8787/health').then(r=>r.text()).then(t=>console.log(t.includes('\"db\":\"up\"')?'UP':'DOWN')).catch(()=>console.log('DOWN'))"`) do set WH_R=%%r
if "%WH_R%"=="UP" (
  echo       /health 报告 db = up，数据库已连上
  endlocal & exit /b 0
)
if %WH_N% GTR %WH_MAX% endlocal & exit /b 1
timeout /t 1 >nul
goto WH_LOOP
