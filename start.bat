@echo off
setlocal
title BizOrganiser server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on the PATH.
  echo Install Node.js 22.13 or newer from https://nodejs.org/ and try again.
  pause
  exit /b 1
)

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo BizOrganiser needs Node.js 22.13 or newer. You have:
  node -v
  pause
  exit /b 1
)

if not exist "node_modules\@libsql\client" (
  echo Installing required packages - first start only, needs internet access...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo Package installation failed. Check your internet or proxy settings and try again.
    pause
    exit /b 1
  )
)

rem port: PORT environment variable, else data\config.json, else 8080 (same rule as the server)
for /f %%p in ('node -e "let p=process.env.PORT;try{p=p||require('./data/config.json').port}catch(e){}console.log(p||8080)"') do set BIZPORT=%%p

echo Starting BizOrganiser on http://127.0.0.1:%BIZPORT%/
echo Close this window or press Ctrl+C to stop the server.
echo.

rem open the browser a few seconds after the server starts
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start "" http://127.0.0.1:%BIZPORT%/"

node server\server.js
echo.
echo The server has stopped.
pause
