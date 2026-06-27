#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$DIR/.venv"

if [ ! -d "$VENV" ]; then
  echo "First-time setup needed. Run: ./setup.sh"
  exit 1
fi

echo "Starting Voice Take Editor…"
echo "Open http://127.0.0.1:8765 in your browser"
echo "Press Ctrl+C to stop."
echo ""

cd "$DIR/backend"
"$VENV/bin/python" main.py
