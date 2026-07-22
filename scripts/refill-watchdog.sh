#!/usr/bin/env bash
# 看门狗：若 continuous-refill 不在则拉起。每 60s 检查一次。
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK_DIR="${WORK_DIR:-/tmp/touch-xai-refill}"
LOG_FILE="${LOG_FILE:-$WORK_DIR/watchdog.log}"
REFILL_LOG="${REFILL_LOG:-$WORK_DIR/continuous-refill.log}"
PID_FILE="$WORK_DIR/watchdog.pid"
REFILL_PID_FILE="$WORK_DIR/continuous-refill.pid"
CHECK_SEC="${CHECK_SEC:-60}"
ENV_FILE="${ENV_FILE:-$WORK_DIR/refill.env}"

mkdir -p "$WORK_DIR"
echo $$ > "$PID_FILE"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE" >&2
}

load_env() {
  if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    set -a
    source "$ENV_FILE"
    set +a
  fi
}

is_refill_alive() {
  if [[ -f "$REFILL_PID_FILE" ]]; then
    local pid
    pid="$(cat "$REFILL_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      # 确认是我们的脚本
      if ps -p "$pid" -o command= 2>/dev/null | grep -q 'continuous-refill.sh'; then
        return 0
      fi
    fi
  fi
  pgrep -f 'scripts/continuous-refill.sh' >/dev/null 2>&1
}

start_refill() {
  load_env
  if [[ -z "${PANEL_TOKEN:-}" ]]; then
    log "missing PANEL_TOKEN in $ENV_FILE"
    return 1
  fi
  # CANDIDATE_TOKEN optional
  export PANEL_URL="${PANEL_URL:-http://127.0.0.1:8790}"
  export BATCH_TARGET="${BATCH_TARGET:-20}"
  export CANDIDATE_UPLOAD_URL="${CANDIDATE_UPLOAD_URL:-https://ai.crosery.com/candidate-upload/api/v1/upload}"
  export BATCH_COOLDOWN_SEC="${BATCH_COOLDOWN_SEC:-45}"
  export POLL_SEC="${POLL_SEC:-15}"
  export WORK_DIR
  export LOG_FILE="$REFILL_LOG"
  export MAX_BATCHES="${MAX_BATCHES:-0}"
  export PANEL_TOKEN
  export CANDIDATE_TOKEN
  nohup bash "$ROOT/scripts/continuous-refill.sh" >>"$WORK_DIR/nohup.out" 2>&1 &
  local pid=$!
  log "started continuous-refill pid=$pid"
  sleep 2
  if kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  log "continuous-refill exited immediately; see $REFILL_LOG / $WORK_DIR/nohup.out"
  return 1
}

log "watchdog start pid=$$ check=${CHECK_SEC}s env=$ENV_FILE"
while true; do
  if is_refill_alive; then
    :
  else
    log "refill not running, restarting"
    start_refill || true
  fi
  sleep "$CHECK_SEC"
done
