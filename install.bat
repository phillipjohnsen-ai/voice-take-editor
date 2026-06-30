@echo off
:: ─────────────────────────────────────────────────────────────────────────────
:: Voice Take Editor — Quick Installer (Windows)
::
:: How to use:
::   1. Open Command Prompt (press Win + R, type cmd, press Enter)
::   2. Paste this command and press Enter:
::      curl -fsSL https://raw.githubusercontent.com/phillipjohnsen-ai/voice-take-editor/main/install.bat -o "%TEMP%\vte_install.bat" && "%TEMP%\vte_install.bat"
::
:: What it does:
::   1. Checks for Python and Git, installs them if missing
::   2. Downloads Voice Take Editor to %USERPROFILE%\voice-take-editor
::   3. Installs all dependencies automatically
::   4. Creates a double-click launcher on your Desktop
:: ─────────────────────────────────────────────────────────────────────────────

setlocal EnableDelayedExpansion

set REPO_URL=https://github.com/phillipjohnsen-ai/voice-take-editor.git
set INSTALL_DIR=%USERPROFILE%\voice-take-editor
set DESKTOP=%USERPROFILE%\Desktop
set LAUNCHER=%DESKTOP%\Voice Take Editor.vbs

echo.
echo ==========================================
echo   Voice Take Editor -- Installer
echo ==========================================
echo.

:: ── 1. Python ────────────────────────────────────────────────────────────────

python --version >nul 2>&1
if %errorlevel% neq 0 (
  py --version >nul 2>&1
  if %errorlevel% neq 0 (
    echo   [!] Python not found. Attempting to install via winget...
    winget install --id Python.Python.3.11 --silent --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
      echo.
      echo   [!] Could not install Python automatically.
      echo       Please install Python manually from https://www.python.org/downloads/
      echo       Make sure to check "Add Python to PATH" during installation.
      echo       Then run this installer again.
      echo.
      pause
      exit /b 1
    )
    :: Refresh PATH
    call RefreshEnv.cmd >nul 2>&1 || set PATH=%PATH%;%LOCALAPPDATA%\Programs\Python\Python311;%LOCALAPPDATA%\Programs\Python\Python311\Scripts
  )
)
echo   [OK] Python ready
for /f "tokens=*" %%i in ('python --version 2^>^&1') do echo        %%i

:: ── 2. Git ───────────────────────────────────────────────────────────────────

git --version >nul 2>&1
if %errorlevel% neq 0 (
  echo   [!] Git not found. Attempting to install via winget...
  winget install --id Git.Git --silent --accept-package-agreements --accept-source-agreements
  if %errorlevel% neq 0 (
    echo.
    echo   [!] Could not install Git automatically.
    echo       Please install Git from https://git-scm.com/download/win
    echo       Then run this installer again.
    echo.
    pause
    exit /b 1
  )
  :: Refresh PATH
  set PATH=%PATH%;%ProgramFiles%\Git\cmd
)
echo   [OK] Git ready

:: ── 3. Clone or update the repo ──────────────────────────────────────────────

if exist "%INSTALL_DIR%\.git" (
  echo   [->] Updating Voice Take Editor to the latest version...
  git -C "%INSTALL_DIR%" pull --quiet
  echo   [OK] Updated
) else (
  echo   [->] Downloading Voice Take Editor...
  git clone %REPO_URL% "%INSTALL_DIR%" --quiet
  echo   [OK] Download complete
)

:: ── 4. Run setup ─────────────────────────────────────────────────────────────

echo   [->] Installing dependencies (3-5 minutes the first time)...
cd /d "%INSTALL_DIR%"
call setup.bat
echo   [OK] All dependencies installed

:: ── 5. Create Desktop launcher (VBScript) ────────────────────────────────────

echo   [->] Creating Desktop shortcut...

(
  echo Set WshShell = CreateObject^("WScript.Shell"^)
  echo Set fso = CreateObject^("Scripting.FileSystemObject"^)
  echo.
  echo installDir = WshShell.ExpandEnvironmentStrings^("%USERPROFILE%\voice-take-editor"^)
  echo pythonBin  = installDir ^& "\.venv\Scripts\python.exe"
  echo backendScript = installDir ^& "\backend\main.py"
  echo logFile    = WshShell.ExpandEnvironmentStrings^("%TEMP%\voice_take_editor.log"^)
  echo.
  echo ' Check if server is already running
  echo Dim http
  echo Set http = CreateObject^("MSXML2.XMLHTTP"^)
  echo On Error Resume Next
  echo http.Open "GET", "http://127.0.0.1:8765/api/health", False
  echo http.Send
  echo If Err.Number = 0 And http.Status = 200 Then
  echo   WshShell.Run "http://127.0.0.1:8765"
  echo   WScript.Quit
  echo End If
  echo On Error GoTo 0
  echo.
  echo ' Start the backend server ^(hidden window^)
  echo WshShell.Run Chr^(34^) ^& pythonBin ^& Chr^(34^) ^& " " ^& Chr^(34^) ^& backendScript ^& Chr^(34^), 0, False
  echo.
  echo ' Wait up to 20 seconds for server to be ready
  echo Dim ready
  echo ready = False
  echo Dim i
  echo For i = 1 To 20
  echo   WScript.Sleep 1000
  echo   On Error Resume Next
  echo   http.Open "GET", "http://127.0.0.1:8765/api/health", False
  echo   http.Send
  echo   If Err.Number = 0 And http.Status = 200 Then
  echo     ready = True
  echo     Exit For
  echo   End If
  echo   On Error GoTo 0
  echo Next
  echo.
  echo If ready Then
  echo   WshShell.Run "http://127.0.0.1:8765"
  echo Else
  echo   MsgBox "Voice Take Editor failed to start." ^& vbCrLf ^& vbCrLf ^& "Check the log at: " ^& logFile, 16, "Voice Take Editor"
  echo End If
) > "%LAUNCHER%"

echo   [OK] Desktop shortcut created

:: ── Done ─────────────────────────────────────────────────────────────────────

echo.
echo ==========================================
echo   Installation complete!
echo.
echo   Double-click 'Voice Take Editor'
echo   on your Desktop to launch the app.
echo.
echo   First launch: Whisper AI model
echo   downloads automatically (~145 MB).
echo ==========================================
echo.
pause
