#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Voice Take Editor — Quick Installer (Mac + Linux)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/phillipjohnsen-ai/voice-take-editor/main/install.sh | bash
#
# What it does:
#   1. Installs Python and Git if missing
#   2. Downloads Voice Take Editor to ~/voice-take-editor
#   3. Installs all dependencies automatically
#   4. Creates a double-click launcher on your Desktop
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_URL="https://github.com/phillipjohnsen-ai/voice-take-editor.git"
INSTALL_DIR="$HOME/voice-take-editor"
OS="$(uname -s)"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     Voice Take Editor — Installer        ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Helpers ──────────────────────────────────────────────────────────────────

ok()  { echo "  ✓ $1"; }
run() { echo "  → $1"; }

# ── 1. Platform-specific dependency install ───────────────────────────────────

install_deps_mac() {
  # Homebrew
  if ! command -v brew &>/dev/null; then
    run "Installing Homebrew (you may be asked for your Mac password)..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
  # Add Homebrew to PATH for this session (Apple Silicon vs Intel)
  if [[ -f /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -f /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
  ok "Homebrew ready"

  # Python
  PYTHON=""
  for cmd in python3.12 python3.11 python3.10 python3.9 python3; do
    if command -v "$cmd" &>/dev/null; then
      OK=$("$cmd" -c 'import sys; print(sys.version_info >= (3,9))' 2>/dev/null || echo False)
      if [[ "$OK" == "True" ]]; then PYTHON="$cmd"; break; fi
    fi
  done
  if [[ -z "${PYTHON:-}" ]]; then
    run "Installing Python..."
    brew install python
    PYTHON=python3
  fi
  ok "Python ready ($($PYTHON --version))"

  # Git
  if ! command -v git &>/dev/null; then
    run "Installing git..."
    brew install git
  fi
  ok "Git ready"
}

install_deps_linux() {
  # Detect package manager
  if command -v apt-get &>/dev/null; then
    PKG_INSTALL="sudo apt-get install -y"
    sudo apt-get update -qq
  elif command -v dnf &>/dev/null; then
    PKG_INSTALL="sudo dnf install -y"
  elif command -v yum &>/dev/null; then
    PKG_INSTALL="sudo yum install -y"
  elif command -v pacman &>/dev/null; then
    PKG_INSTALL="sudo pacman -S --noconfirm"
  else
    echo ""
    echo "  ✗ Could not detect a supported package manager."
    echo "    Please install Python 3.9+, git, and curl manually, then re-run this script."
    exit 1
  fi

  # Python
  PYTHON=""
  for cmd in python3.12 python3.11 python3.10 python3.9 python3; do
    if command -v "$cmd" &>/dev/null; then
      OK=$("$cmd" -c 'import sys; print(sys.version_info >= (3,9))' 2>/dev/null || echo False)
      if [[ "$OK" == "True" ]]; then PYTHON="$cmd"; break; fi
    fi
  done
  if [[ -z "${PYTHON:-}" ]]; then
    run "Installing Python..."
    $PKG_INSTALL python3 python3-pip python3-venv
    PYTHON=python3
  fi
  ok "Python ready ($($PYTHON --version))"

  # Git
  if ! command -v git &>/dev/null; then
    run "Installing git..."
    $PKG_INSTALL git
  fi
  ok "Git ready"

  # xdg-open (used to open the browser)
  if ! command -v xdg-open &>/dev/null; then
    $PKG_INSTALL xdg-utils 2>/dev/null || true
  fi
}

# ── 2. Run platform deps ──────────────────────────────────────────────────────

if [[ "$OS" == "Darwin" ]]; then
  install_deps_mac
elif [[ "$OS" == "Linux" ]]; then
  install_deps_linux
else
  echo "  ✗ Unsupported OS: $OS"
  echo "    This installer supports Mac and Linux. For Windows use install.bat."
  exit 1
fi

# ── 3. Clone or update the repo ──────────────────────────────────────────────

if [[ -d "$INSTALL_DIR/.git" ]]; then
  run "Updating Voice Take Editor to the latest version..."
  git -C "$INSTALL_DIR" pull --quiet
  ok "Updated"
else
  run "Downloading Voice Take Editor..."
  git clone "$REPO_URL" "$INSTALL_DIR" --quiet
  ok "Download complete"
fi

# ── 4. Run setup ─────────────────────────────────────────────────────────────

run "Installing Python dependencies (3–5 minutes the first time)..."
cd "$INSTALL_DIR"
chmod +x setup.sh start.sh
./setup.sh
ok "All dependencies installed"

# ── 5. Create Desktop launcher ───────────────────────────────────────────────

create_launcher_mac() {
  DESKTOP_APP="$HOME/Desktop/Voice Take Editor.app"
  TMPSCRIPT=$(mktemp /tmp/voice_launcher_XXXX.applescript)

  cat > "$TMPSCRIPT" << 'APPLESCRIPT'
on run
    set installDir to (POSIX path of (path to home folder)) & "voice-take-editor"
    set pythonBin to installDir & "/.venv/bin/python"
    set backendScript to installDir & "/backend/main.py"
    set logFile to "/tmp/voice_take_editor.log"

    -- Check if server is already running
    try
        do shell script "curl -sf --connect-timeout 1 http://127.0.0.1:8765/api/health"
        open location "http://127.0.0.1:8765"
        return
    end try

    -- Start the backend
    do shell script "nohup " & quoted form of pythonBin & " " & quoted form of backendScript & " > " & logFile & " 2>&1 &"

    -- Wait up to 20 seconds for it to be ready
    set serverReady to false
    repeat 20 times
        delay 1
        try
            do shell script "curl -sf --connect-timeout 1 http://127.0.0.1:8765/api/health"
            set serverReady to true
            exit repeat
        end try
    end repeat

    if serverReady then
        open location "http://127.0.0.1:8765"
    else
        display dialog "Voice Take Editor failed to start." & return & return & "Check the log at: /tmp/voice_take_editor.log" buttons {"OK"} default button "OK" with icon stop
    end if
end run
APPLESCRIPT

  rm -rf "$DESKTOP_APP"
  osacompile -o "$DESKTOP_APP" "$TMPSCRIPT"
  rm -f "$TMPSCRIPT"
  ok "Desktop app created → $DESKTOP_APP"
}

create_launcher_linux() {
  DESKTOP_DIR="$HOME/Desktop"
  LAUNCH_SCRIPT="$INSTALL_DIR/launch.sh"
  DESKTOP_FILE="$DESKTOP_DIR/voice-take-editor.desktop"

  # Create the launch script
  cat > "$LAUNCH_SCRIPT" << LAUNCHSCRIPT
#!/usr/bin/env bash
INSTALL_DIR="\$HOME/voice-take-editor"
LOG="/tmp/voice_take_editor.log"

# If already running, just open the browser
if curl -sf --connect-timeout 1 http://127.0.0.1:8765/api/health &>/dev/null; then
  xdg-open http://127.0.0.1:8765
  exit 0
fi

# Start the backend
nohup "\$INSTALL_DIR/.venv/bin/python" "\$INSTALL_DIR/backend/main.py" > "\$LOG" 2>&1 &

# Wait up to 20 seconds for it to be ready
for i in \$(seq 1 20); do
  sleep 1
  if curl -sf --connect-timeout 1 http://127.0.0.1:8765/api/health &>/dev/null; then
    xdg-open http://127.0.0.1:8765
    exit 0
  fi
done

echo "Server did not start in time. Check \$LOG"
exit 1
LAUNCHSCRIPT
  chmod +x "$LAUNCH_SCRIPT"

  # Create the .desktop file
  mkdir -p "$DESKTOP_DIR"
  cat > "$DESKTOP_FILE" << DESKTOPFILE
[Desktop Entry]
Version=1.0
Type=Application
Name=Voice Take Editor
Comment=AI-powered voice take editor — pick the best take from every sentence
Exec=$LAUNCH_SCRIPT
Icon=audio-headset
Terminal=false
Categories=Audio;AudioVideo;
DESKTOPFILE

  chmod +x "$DESKTOP_FILE"

  # Trust the .desktop file on GNOME (avoids "Untrusted application" dialog)
  if command -v gio &>/dev/null; then
    gio set "$DESKTOP_FILE" metadata::trusted true 2>/dev/null || true
  fi

  ok "Desktop shortcut created → $DESKTOP_FILE"
}

run "Creating Desktop shortcut..."
if [[ "$OS" == "Darwin" ]]; then
  create_launcher_mac
else
  create_launcher_linux
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Installation complete!                 ║"
echo "║                                          ║"
echo "║   Double-click 'Voice Take Editor'       ║"
echo "║   on your Desktop to launch the app.     ║"
echo "║                                          ║"
echo "║   First launch: Whisper AI model         ║"
echo "║   downloads automatically (~145 MB).     ║"
echo "╚══════════════════════════════════════════╝"
echo ""
