@echo off
title WMan Proxy
cd /d "%~dp0"

:: ── Check Python is installed ─────────────────────────────────────────────
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Install Python 3.11+ from https://python.org
    pause
    exit /b 1
)

:: ── Create .venv if it doesn't exist ─────────────────────────────────────
if not exist ".venv\Scripts\activate.bat" (
    echo [SETUP] Creating virtual environment...
    python -m venv .venv
    if errorlevel 1 (
        echo [ERROR] Failed to create virtual environment.
        pause
        exit /b 1
    )
    echo [SETUP] Virtual environment created.
)

:: ── Activate venv ────────────────────────────────────────────────────────
call .venv\Scripts\activate.bat

:: ── Install / update dependencies ────────────────────────────────────────
echo [SETUP] Installing dependencies...
pip install -r requirements.txt --quiet --disable-pip-version-check
if errorlevel 1 (
    echo [ERROR] Failed to install dependencies.
    pause
    exit /b 1
)
echo [SETUP] Dependencies ready.

:: ── Start the server ─────────────────────────────────────────────────────
echo.
echo  WMan Proxy running at http://localhost:8000
echo  Press Ctrl+C to stop.
echo.
uvicorn backend.main:app --host 0.0.0.0 --port 8000

pause
