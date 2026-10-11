#!/bin/bash
# Double-click to start (macOS). Pass --demo to try it without a robot.
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "First run: setting up Python…"
  if command -v uv >/dev/null 2>&1; then
    uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt
  else
    PY=$(command -v python3.13 || command -v python3.12 || command -v python3.11)
    if [ -z "$PY" ]; then echo "Needs Python 3.11+ (or uv). Install from python.org and try again."; read -r; exit 1; fi
    "$PY" -m venv .venv && .venv/bin/pip install -q -r requirements.txt
  fi
fi

# The interface is TypeScript; build it (takes well under a second).
if command -v npm >/dev/null 2>&1; then
  [ -d node_modules ] || { echo "First run: installing the interface's build tools…"; npm ci --silent; }
  npm run --silent build >/dev/null || { echo "Building the interface failed."; read -r; exit 1; }
elif [ ! -f static/dist/main.js ]; then
  echo "Needs Node.js 18+ to build the interface: https://nodejs.org"; read -r; exit 1
fi

exec .venv/bin/python server.py "$@"
