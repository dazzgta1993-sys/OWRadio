@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title OWRadio - Discord Music Station and Web Radio Hub

echo ========================================================
echo        OWRADIO - DISCORD MUSIC BOT AND WEB RADIO
echo ========================================================
echo  * Mode: Discord Bot + Continuous Web Radio
echo  * Web Player: http://localhost:8091
echo  * Discord: Auto-Voice Join and Slash Commands
echo ========================================================
echo.

:: 1. Detect Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo ==========================================================
    echo [ERROR] Node.js was not detected in PATH!
    echo Please install Node.js 20+ from https://nodejs.org
    echo ==========================================================
    pause
    exit /b 1
)

:: 2. Detect FFmpeg
where ffmpeg >nul 2>nul
if errorlevel 1 (
    echo ==========================================================
    echo [WARNING] FFmpeg was not detected in PATH.
    echo High-fidelity Discord voice streaming requires FFmpeg.
    echo ==========================================================
    echo.
)

:: 3. Check .env configuration
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo [SETUP] Created .env from template.
    )
)

:: 4. Auto-install dependencies if node_modules is missing
if not exist "node_modules" (
    echo [INFO] First-time setup: Installing lightweight dependencies...
    call npm.cmd install --no-audit --no-fund
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies.
        pause
        exit /b 1
    )
    echo [SUCCESS] Dependencies installed!
    echo.
)

:start_loop
cls
echo ========================================================
echo        OWRADIO - DISCORD MUSIC BOT AND WEB RADIO
echo ========================================================
echo  * Web Player: http://localhost:8091
echo  * Live Stream: http://localhost:8091/stream.mp3
echo ========================================================
echo.
echo Launching OWRadio...
echo.

call npx.cmd tsx src/index.ts
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] OWRadio exited with code %EXIT_CODE%.
    echo Press any key to restart or close this window...
    pause
    goto start_loop
)

exit /b 0
