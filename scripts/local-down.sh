#!/usr/bin/env bash
# Stop local panel (+ optional clearance)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GROK_HOME="${GROK_HOME:-$ROOT/.grok-home}"
PID_FILE="$GROK_HOME/panel.pid"
STOP_CLEARANCE=0

for a in "$@"; do
  case "$a" in
    --all|-a) STOP_CLEARANCE=1 ;;
  esac
done

if [[ -f "$PID_FILE" ]]; then
  pid=$(cat "$PID_FILE" || true)
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "[*] stop panel pid=$pid"
    kill "$pid" 2>/dev/null || true
    sleep 0.3
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

# free 8787 if leftover
if command -v lsof >/dev/null 2>&1; then
  lsof -tiTCP:8787 -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
fi

if [[ $STOP_CLEARANCE -eq 1 ]]; then
  echo "[*] stop clearance docker stack"
  (cd "$ROOT/clearance" && docker compose down) || true
else
  echo "[*] clearance left running (use --all to stop)"
fi

echo "[✓] local panel stopped"
