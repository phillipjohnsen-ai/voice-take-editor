#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
BINS="$DIR/bins"
VENV="$DIR/.venv"

echo ""
echo "=== Voice Take Editor — Setup ==="
echo ""

# ── 1. ffmpeg ────────────────────────────────────────────────────────────────
OS="$(uname -s)"

if [ "$OS" = "Darwin" ]; then
  # macOS — download a self-contained static binary
  if [ -f "$BINS/ffmpeg" ]; then
    echo "✓ ffmpeg already in bins/"
  else
    echo "→ Downloading static ffmpeg binary for macOS…"
    mkdir -p "$BINS"
    TMP=$(mktemp -d)
    curl -L "https://evermeet.cx/ffmpeg/getrelease/zip" -o "$TMP/ffmpeg.zip"
    unzip -q "$TMP/ffmpeg.zip" -d "$TMP"
    mv "$TMP/ffmpeg" "$BINS/ffmpeg"
    chmod +x "$BINS/ffmpeg"
    rm -rf "$TMP"
    echo "✓ ffmpeg installed to bins/ffmpeg"
  fi
elif [ "$OS" = "Linux" ]; then
  # Linux — use the system package manager
  if command -v ffmpeg &>/dev/null; then
    echo "✓ ffmpeg already available"
  else
    echo "→ Installing ffmpeg via package manager…"
    if command -v apt-get &>/dev/null; then
      sudo apt-get update -qq && sudo apt-get install -y ffmpeg
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y ffmpeg
    elif command -v yum &>/dev/null; then
      sudo yum install -y ffmpeg
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --noconfirm ffmpeg
    else
      echo "✗ Could not find apt, dnf, yum, or pacman."
      echo "  Please install ffmpeg manually: https://ffmpeg.org/download.html"
      exit 1
    fi
    echo "✓ ffmpeg installed"
  fi
fi

# ── 2. Python venv ───────────────────────────────────────────────────────────
if [ -d "$VENV" ]; then
  echo "✓ Python venv already exists"
else
  echo "→ Creating Python virtual environment…"
  PYTHON=""
  for cmd in python3.11 python3.10 python3.9 python3; do
    if command -v "$cmd" &>/dev/null; then
      PYTHON="$cmd"
      break
    fi
  done
  if [ -z "$PYTHON" ]; then
    echo "✗ Python 3.9+ required. Please install from https://www.python.org/downloads/"
    exit 1
  fi
  echo "  Using $PYTHON ($(${PYTHON} --version))"
  "$PYTHON" -m venv "$VENV"
  echo "✓ venv created"
fi

# ── 3. Python deps ───────────────────────────────────────────────────────────
echo "→ Installing Python dependencies (this may take a few minutes on first run)…"
"$VENV/bin/pip" install --quiet --upgrade pip setuptools wheel
"$VENV/bin/pip" install --quiet --no-build-isolation openai-whisper==20231117
"$VENV/bin/pip" install --quiet fastapi==0.111.0 "uvicorn[standard]==0.29.0" python-multipart==0.0.9 pydub==0.25.1 aiofiles==23.2.1
echo "✓ Python dependencies installed"

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Run:  ./start.sh"
echo ""
