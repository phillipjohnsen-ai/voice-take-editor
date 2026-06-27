@echo off
setlocal enabledelayedexpansion

echo.
echo === Voice Take Editor - Setup ===
echo.

:: ── 1. Check Python ──────────────────────────────────────────────────────────
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python not found.
    echo Please download and install Python 3.9 or newer from:
    echo https://www.python.org/downloads/
    echo.
    echo IMPORTANT: During installation, check the box that says
    echo "Add Python to PATH" before clicking Install.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('python --version 2^>^&1') do echo Found: %%v

:: ── 2. Check / install ffmpeg ─────────────────────────────────────────────────
where ffmpeg >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] ffmpeg already available
    goto :python_env
)

echo.
echo ffmpeg not found. Attempting to install via winget...
winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements
if %errorlevel% equ 0 (
    echo [OK] ffmpeg installed via winget
    echo NOTE: You may need to restart this window for ffmpeg to be recognised.
) else (
    echo.
    echo Could not auto-install ffmpeg. Please install it manually:
    echo   1. Go to https://www.gyan.dev/ffmpeg/builds/
    echo   2. Download "ffmpeg-release-essentials.zip"
    echo   3. Unzip it, find ffmpeg.exe inside the bin folder
    echo   4. Copy ffmpeg.exe to C:\Windows\System32\
    echo.
    pause
    exit /b 1
)

:python_env
:: ── 3. Create virtual environment ────────────────────────────────────────────
if exist ".venv\" (
    echo [OK] Python venv already exists
) else (
    echo.
    echo Creating Python virtual environment...
    python -m venv .venv
    echo [OK] venv created
)

:: ── 4. Install Python dependencies ───────────────────────────────────────────
echo.
echo Installing Python dependencies (this may take several minutes the first time)...
.venv\Scripts\pip install --quiet --upgrade pip setuptools wheel
.venv\Scripts\pip install --quiet --no-build-isolation openai-whisper==20231117
.venv\Scripts\pip install --quiet fastapi==0.111.0 "uvicorn[standard]==0.29.0" python-multipart==0.0.9 pydub==0.25.1 aiofiles==23.2.1
echo [OK] Python dependencies installed

echo.
echo === Setup complete! ===
echo.
echo Run start.bat to launch the tool.
echo.
pause
