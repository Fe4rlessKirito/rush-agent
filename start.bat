@echo off
REM ============================================================
REM  Rush Agent - dev launcher
REM  Installs deps if needed, starts Vite, opens the browser.
REM ============================================================

cd /d "%~dp0"

set "URL=http://localhost:1420"

if not exist "node_modules\" (
  echo [rush] node_modules not found - running npm install...
  call npm install
  if errorlevel 1 (
    echo [rush] npm install failed. Aborting.
    pause
    exit /b 1
  )
)

REM Open the browser after a short delay so Vite has time to bind the port.
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start "" "%URL%""

echo [rush] starting dev server at %URL%
echo [rush] press Ctrl+C in this window to stop.
call npm run dev
