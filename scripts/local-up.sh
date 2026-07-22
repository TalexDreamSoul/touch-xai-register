#!/usr/bin/env bash
# Local bring-up: reuse Docker full stack when healthy, else clearance + host panel.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GROK_HOME="${GROK_HOME:-$ROOT/.grok-home}"
PANEL_ADDR="${PANEL_ADDR:-:8787}"
PANEL_TOKEN="${PANEL_TOKEN:-}"
PID_FILE="$GROK_HOME/panel.pid"
LOG_FILE="$GROK_HOME/logs/panel.log"
SKIP_TURNSTILE="${SKIP_TURNSTILE:-0}"
SKIP_CLEARANCE="${SKIP_CLEARANCE:-0}"
FORCE_HOST_PANEL="${FORCE_HOST_PANEL:-0}"

# Load .env if present
if [[ -f "$ROOT/.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  # shellcheck source=/dev/null
  source "$ROOT/.env"
  set +a
fi
PANEL_TOKEN="${PANEL_TOKEN:-local-dev-token}"
PANEL_ADDR="${PANEL_ADDR:-:8787}"
GROK_HOME="${GROK_HOME:-$ROOT/.grok-home}"

port="${PANEL_ADDR##*:}"
port="${port:-8787}"

mkdir -p "$GROK_HOME/logs" "$GROK_HOME/outputs"

resolve_go() {
  if command -v go >/dev/null 2>&1; then
    command -v go
    return
  fi
  local c
  for c in \
    "$HOME/.local/share/mise/installs/go/latest/bin/go" \
    "$HOME/.local/share/mise/installs/go/1.26.5/bin/go" \
    /usr/local/go/bin/go \
    "$HOME/go/bin/go"; do
    if [[ -x "$c" ]]; then
      echo "$c"
      return
    fi
  done
  # last resort: any mise go
  local m
  m=$(ls -1 "$HOME"/.local/share/mise/installs/go/*/bin/go 2>/dev/null | tail -1 || true)
  if [[ -n "${m:-}" && -x "$m" ]]; then
    echo "$m"
    return
  fi
  return 1
}

ensure_binary() {
  if [[ -x "$ROOT/bin/grok" ]]; then
    return
  fi
  echo "[*] building bin/grok..."
  local go_bin
  if ! go_bin=$(resolve_go); then
    echo "错误: 找不到 go。请安装 Go 1.21+ 或: mise install go"
    exit 1
  fi
  echo "[*] using $go_bin"
  "$go_bin" build -ldflags "-s -w -X main.version=0.2.0-panel" -o "$ROOT/bin/grok" ./cmd/grok
}

seed_host_config() {
  if [[ -f "$GROK_HOME/config.env" ]]; then
    return
  fi
  cat >"$GROK_HOME/config.env" <<'EOF'
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
# CPA_MANAGEMENT_BASE=http://127.0.0.1:8317/v0/management
# CPA_MANAGEMENT_KEY=
EOF
  chmod 600 "$GROK_HOME/config.env"
  echo "[*] seeded $GROK_HOME/config.env"
}

ensure_turnstile() {
  if [[ "$SKIP_TURNSTILE" == "1" ]]; then
    echo "[*] SKIP_TURNSTILE=1 — 跳过 venv/cloakbrowser（仅面板/上传/巡检可用，注册 mint 可能失败）"
    return
  fi
  if [[ -x "$ROOT/.venv/bin/python" ]]; then
    return
  fi
  echo "[*] creating venv + cloakbrowser（首次较慢）..."
  python3 -m venv "$ROOT/.venv"
  "$ROOT/.venv/bin/pip" install -U pip
  "$ROOT/.venv/bin/pip" install -r "$ROOT/scripts/requirements-turnstile.txt"
  if ! "$ROOT/.venv/bin/python" -m cloakbrowser install; then
    echo "[!] cloakbrowser install 失败；注册 Turnstile 可能不可用，面板仍可启动"
  fi
}

panel_healthy() {
  curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1
}

docker_full_stack_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'grok-panel'
}

print_banner() {
  local mode="$1"
  local token_hint="$2"
  echo
  echo "============================================"
  echo "  Mode:   $mode"
  echo "  Panel:  http://127.0.0.1:${port}"
  echo "  Token:  $token_hint"
  echo "  Home:   $GROK_HOME"
  if [[ -f "$LOG_FILE" ]]; then
    echo "  Log:    $LOG_FILE"
  fi
  if [[ -f "$PID_FILE" ]]; then
    echo "  PID:    $(cat "$PID_FILE" 2>/dev/null || echo '?')"
  fi
  echo "  Stop:   make down          # 或 scripts/local-down.sh"
  echo "  Status: make status"
  echo "============================================"
  curl -sS "http://127.0.0.1:${port}/api/health" 2>/dev/null || true
  echo
}

# ── Prefer already-running Docker full stack (root compose) ──────────
if [[ "$FORCE_HOST_PANEL" != "1" ]] && docker info >/dev/null 2>&1 && docker_full_stack_running && panel_healthy; then
  # Sync token hint from container when possible
  ctok=$(docker inspect grok-panel --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^PANEL_TOKEN=//p' | head -1 || true)
  if [[ -n "${ctok:-}" ]]; then
    PANEL_TOKEN="$ctok"
  fi
  # Point local home note at container data (informational)
  GROK_HOME="docker:grok-panel:/data"
  print_banner "docker full-stack (已在运行)" "$PANEL_TOKEN"
  echo "[i] 代码更新后重建: make docker-rebuild"
  echo "[i] 强制宿主 panel: FORCE_HOST_PANEL=1 ./scripts/local-up.sh"
  exit 0
fi

# ── Host panel path ──────────────────────────────────────────────────
seed_host_config
ensure_binary
ensure_turnstile

if [[ "$SKIP_CLEARANCE" != "1" ]]; then
  echo "[*] starting clearance (docker)..."
  if ! docker info >/dev/null 2>&1; then
    echo "错误: Docker 未运行。请先启动 OrbStack / Docker Desktop。"
    echo "      若只要面板：SKIP_CLEARANCE=1 ./scripts/local-up.sh"
    exit 1
  fi
  # Prefer standalone clearance stack so it does not fight full compose names.
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -Eq 'grok-(warp|privoxy|flaresolverr)$'; then
    echo "[*] full-stack clearance containers already present — skip clearance compose"
  else
    (
      cd "$ROOT/clearance"
      docker compose up -d
    )
  fi
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
else
  echo "[*] SKIP_CLEARANCE=1"
fi

if panel_healthy; then
  listen_pid=""
  if command -v lsof >/dev/null 2>&1; then
    listen_pid=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)
  fi
  if [[ -n "$listen_pid" ]]; then
    echo "$listen_pid" >"$PID_FILE"
  fi
  echo "[*] panel already running on :$port (pid=${listen_pid:-?})"
else
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
      # Don't kill OrbStack proxy if it's docker-published; only host listeners.
      # If docker full stack holds 8787, user should use that or FORCE rebuild path.
      if docker_full_stack_running; then
        echo "错误: :$port 已被 docker grok-panel 占用。"
        echo "      使用已有栈: 打开 http://127.0.0.1:${port}"
        echo "      或: make docker-down && FORCE_HOST_PANEL=1 ./scripts/local-up.sh"
        exit 1
      fi
      kill -9 "$p" 2>/dev/null || true
    done
  fi

  export GROK_HOME
  if [[ -x "$ROOT/.venv/bin/python" ]]; then
    export GROK_PYTHON="$ROOT/.venv/bin/python"
  fi
  export GROK_TURNSTILE_SCRIPT="$ROOT/scripts/turnstile_mint.py"
  export CLOAKBROWSER_SUPPRESS_FONT_WARNING=1
  export PANEL_TOKEN
  export PANEL_ADDR

  echo "[*] starting host panel on $PANEL_ADDR"
  nohup "$ROOT/bin/grok" panel --addr "$PANEL_ADDR" --token "$PANEL_TOKEN" \
    >>"$LOG_FILE" 2>&1 &
  disown $! 2>/dev/null || true

  ok=0
  for i in $(seq 1 40); do
    if panel_healthy; then
      ok=1
      break
    fi
    sleep 0.25
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

print_banner "host panel + clearance" "$PANEL_TOKEN"
