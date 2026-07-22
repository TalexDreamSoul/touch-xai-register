#!/usr/bin/env bash
# Local deploy: clearance (Docker) + host panel (background)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GROK_HOME="${GROK_HOME:-$ROOT/.grok-home}"
PANEL_ADDR="${PANEL_ADDR:-:8787}"
PANEL_TOKEN="${PANEL_TOKEN:-}"
PID_FILE="$GROK_HOME/panel.pid"
LOG_FILE="$GROK_HOME/logs/panel.log"

# Load .env if present
if [[ -f "$ROOT/.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  # shellcheck source=/dev/null
  source "$ROOT/.env"
  set +a
fi
PANEL_TOKEN="${PANEL_TOKEN:-local-dev-token}"

mkdir -p "$GROK_HOME/logs" "$GROK_HOME/outputs"

# Seed config for host (127.0.0.1 proxies)
if [[ ! -f "$GROK_HOME/config.env" ]]; then
  cat > "$GROK_HOME/config.env" <<'EOF'
EMAIL_MODE=tempmail
CLEARANCE_ENABLED=1
REGISTER_PROXY=http://127.0.0.1:40080
FLARESOLVERR_URL=http://127.0.0.1:8191
CLEARANCE_PROXY=http://privoxy:8118
CLEARANCE_URLS=https://accounts.x.ai,https://x.ai,https://status.x.ai,https://console.x.ai,https://auth.x.ai
TURNSTILE_PROVIDER=browser
PROTOCOL_HTTP=1
HTTP_POOL_SIZE=8
TEMPMAIL_LOL_RETRIES=30
TEMPMAIL_LOL_MIN_INTERVAL_MS=1500
HTTPS_PROXY=http://127.0.0.1:40080
HTTP_PROXY=http://127.0.0.1:40080
NO_PROXY=127.0.0.1,localhost
PROBE_ENABLED=1
PHYSICAL_CAP=0
CPA_UPLOAD_ENABLED=0
EOF
  chmod 600 "$GROK_HOME/config.env"
  echo "[*] seeded $GROK_HOME/config.env"
fi

# Binary
if [[ ! -x "$ROOT/bin/grok" ]]; then
  echo "[*] building bin/grok..."
  if command -v mise >/dev/null 2>&1; then
    mise exec go@1.26.5 -- go build -ldflags "-s -w -X main.version=0.2.0-panel" -o bin/grok ./cmd/grok
  else
    go build -ldflags "-s -w -X main.version=0.2.0-panel" -o bin/grok ./cmd/grok
  fi
fi

# Python / CloakBrowser
if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
  echo "[*] creating venv + cloakbrowser..."
  python3 -m venv "$ROOT/.venv"
  "$ROOT/.venv/bin/pip" install -U pip
  "$ROOT/.venv/bin/pip" install -r "$ROOT/scripts/requirements-turnstile.txt"
  "$ROOT/.venv/bin/python" -m cloakbrowser install
fi

# Clearance stack
echo "[*] starting clearance (docker)..."
if ! docker info >/dev/null 2>&1; then
  echo "错误: Docker 未运行。请先启动 OrbStack / Docker Desktop。"
  exit 1
fi
(
  cd "$ROOT/clearance"
  docker compose up -d
)
echo "[*] waiting clearance healthy..."
for i in $(seq 1 30); do
  ok=1
  curl -fsS -o /dev/null http://127.0.0.1:8191/ || ok=0
  curl -fsS -o /dev/null -x http://127.0.0.1:40080 https://www.cloudflare.com/cdn-cgi/trace || ok=0
  if [[ $ok -eq 1 ]]; then
    echo "[*] clearance ready"
    break
  fi
  sleep 2
  if [[ $i -eq 30 ]]; then
    echo "[!] clearance not fully healthy yet; panel will still start"
  fi
done

port="${PANEL_ADDR##*:}"
port="${port:-8787}"

# Already healthy?
if curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
  listen_pid=""
  if command -v lsof >/dev/null 2>&1; then
    listen_pid=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)
  fi
  if [[ -n "$listen_pid" ]]; then
    echo "$listen_pid" >"$PID_FILE"
  fi
  echo "[*] panel already running on :$port (pid=${listen_pid:-?})"
else
  # Stop existing panel by pidfile / port
  if [[ -f "$PID_FILE" ]]; then
    old=$(cat "$PID_FILE" || true)
    if [[ -n "${old:-}" ]] && kill -0 "$old" 2>/dev/null; then
      echo "[*] stopping old panel pid=$old"
      kill "$old" 2>/dev/null || true
      sleep 0.4
      kill -9 "$old" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  if command -v lsof >/dev/null 2>&1; then
    for p in $(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
      kill -9 "$p" 2>/dev/null || true
    done
  fi

  export GROK_HOME
  export GROK_PYTHON="$ROOT/.venv/bin/python"
  export GROK_TURNSTILE_SCRIPT="$ROOT/scripts/turnstile_mint.py"
  export CLOAKBROWSER_SUPPRESS_FONT_WARNING=1
  export PANEL_TOKEN
  export PANEL_ADDR

  echo "[*] starting panel on $PANEL_ADDR"
  # Prefer setsid/nohup; capture real child via lsof after bind
  nohup "$ROOT/bin/grok" panel --addr "$PANEL_ADDR" --token "$PANEL_TOKEN" \
    >>"$LOG_FILE" 2>&1 &
  disown $! 2>/dev/null || true

  # Wait until port listens or fail
  ok=0
  for i in $(seq 1 25); do
    if curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 0.2
  done
  if [[ $ok -ne 1 ]]; then
    echo "错误: panel 启动失败，见 $LOG_FILE"
    tail -40 "$LOG_FILE" || true
    exit 1
  fi
  listen_pid=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)
  if [[ -n "$listen_pid" ]]; then
    echo "$listen_pid" >"$PID_FILE"
  else
    echo $! >"$PID_FILE"
  fi
fi

echo
echo "============================================"
echo "  Panel:  http://127.0.0.1:${port}"
echo "  Token:  $PANEL_TOKEN"
echo "  Home:   $GROK_HOME"
echo "  Log:    $LOG_FILE"
echo "  PID:    $(cat "$PID_FILE" 2>/dev/null || echo '?')"
echo "  Stop:   $ROOT/scripts/local-down.sh"
echo "  Stop all (incl. clearance): $ROOT/scripts/local-down.sh --all"
echo "============================================"
curl -sS "http://127.0.0.1:${port}/api/health" || true
echo
