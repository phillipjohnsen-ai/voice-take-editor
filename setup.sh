#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
BINS="$DIR/bins"
VENV="$DIR/.venv"

echo ""
echo "=== Voice Take Editor — Setup ==="
echo ""

# ── 1. ffmpeg ────────────────────────────────────────────────────────────────
if [ -f "$BINS/ffmpeg" ]; then
  echo "✓ ffmpeg already in bins/"
else
  echo "→ Downloading static ffmpeg binary for macOS…"
  mkdir -p "$BINS"
  # Detect architecture
  ARCH=$(uname -m)
  if [ "$ARCH" = "arm64" ]; then
    FFMPEG_URL="https://evermeet.cx/ffmpeg/getrelease/zip"
  else
    FFMPEG_URL="https://evermeet.cx/ffmpeg/getrelease/zip"
  fi
  TMP=$(mktemp -d)
  curl -L "$FFMPEG_URL" -o "$TMP/ffmpeg.zip"
  unzip -q "$TMP/ffmpeg.zip" -d "$TMP"
  mv "$TMP/ffmpeg" "$BINS/ffmpeg"
  chmod +x "$BINS/ffmpeg"
  rm -rf "$TMP"
  echo "✓ ffmpeg installed to bins/ffmpeg"
fi

# ── 2. Python venv ───────────────────────────────────────────────────────────
if [ -d "$VENV" ]; then
  echo "✓ Python venv already exists"
else
  echo "→ Creating Python virtual environment…"
  # Try python3.11, 3.10, 3.9 in order (whisper works best on 3.10+)
  PYTHON=""
  for cmd in python3.11 python3.10 python3.9 python3; do
    if command -v "$cmd" &>/dev/null; then
      PYTHON="$cmd"
      break
    fi
  done
  if [ -z "$PYTHON" ]; then
    echo "✗ Python 3.9+ required. Please install from python.org"
    exit 1
  fi
  echo "  Using $PYTHON ($(${PYTHON} --version))"
  "$PYTHON" -m venv "$VENV"
  echo "✓ venv created"
fi

# ── 3. Python deps ───────────────────────────────────────────────────────────
echo "→ Installing Python dependencies (this may take a few minutes on first run)…"
"$VENV/bin/pip" install --quiet --upgrade pip setuptools wheel
# openai-whisper needs --no-build-isolation on macOS system Python
"$VENV/bin/pip" install --quiet --no-build-isolation openai-whisper==20231117
"$VENV/bin/pip" install --quiet fastapi==0.111.0 "uvicorn[standard]==0.29.0" python-multipart==0.0.9 pydub==0.25.1 aiofiles==23.2.1
echo "✓ Python dependencies installed"

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Run:  ./start.sh"
echo ""
