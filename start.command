#!/bin/bash
# Double-click to start (macOS). Pass --demo to try it without a robot.
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "First run: setting things up…"
  if command -v uv >/dev/null 2>&1; then
    uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt
  else
    PY=$(command -v python3.13 || command -v python3.12 || command -v python3.11)
    if [ -z "$PY" ]; then echo "Needs Python 3.11+ (or uv). Install from python.org and try again."; read -r; exit 1; fi
    "$PY" -m venv .venv && .venv/bin/pip install -q -r requirements.txt
  fi
fi
exec .venv/bin/python server.py "$@"
