#!/usr/bin/env bash
# 持续补号：每批 target 个，完成后打 zip 上传候补池，再开下一批。
# 环境变量见下方默认值。

set -u

PANEL_URL="${PANEL_URL:-http://127.0.0.1:8790}"
BATCH_TARGET="${BATCH_TARGET:-20}"
CANDIDATE_UPLOAD_URL="${CANDIDATE_UPLOAD_URL:-https://ai.crosery.com/candidate-upload/api/v1/upload}"
BATCH_COOLDOWN_SEC="${BATCH_COOLDOWN_SEC:-45}"
POLL_SEC="${POLL_SEC:-15}"
WORK_DIR="${WORK_DIR:-/tmp/touch-xai-refill}"
LOG_FILE="${LOG_FILE:-$WORK_DIR/continuous-refill.log}"
MAX_BATCHES="${MAX_BATCHES:-0}"
STATE_FILE="$WORK_DIR/state.json"
PID_FILE="$WORK_DIR/continuous-refill.pid"

if [[ -z "${PANEL_TOKEN:-}" ]]; then
  echo "PANEL_TOKEN required" >&2
  exit 1
fi
# CANDIDATE_TOKEN optional: empty => package zip only, skip HTTP upload

mkdir -p "$WORK_DIR/runs"
echo $$ > "$PID_FILE"

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  printf '%s\n' "$msg" >> "$LOG_FILE"
  printf '%s\n' "$msg" >&2
}

write_state() {
  local batch_no="$1" run_id="$2" phase="$3"
  cat > "$STATE_FILE" <<EOF
{
  "batch_no": ${batch_no},
  "run_id": "${run_id}",
  "phase": "${phase}",
  "batch_target": ${BATCH_TARGET},
  "pid": $$,
  "updated_at": "$(date '+%Y-%m-%dT%H:%M:%S')"
}
EOF
}

api_get() {
  curl -sS --max-time 30 \
    -H "Authorization: Bearer ${PANEL_TOKEN}" \
    "${PANEL_URL}$1" 2>/dev/null || echo '{}'
}

api_post_json() {
  curl -sS --max-time 30 \
    -H "Authorization: Bearer ${PANEL_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "$2" \
    "${PANEL_URL}$1" 2>/dev/null || echo '{}'
}

status_field() {
  # usage: status_field status|run_id|done|target|...
  local field="$1"
  api_get /api/status | python3 -c '
import sys,json
field=sys.argv[1]
try:
  s=json.load(sys.stdin).get("status") or {}
except Exception:
  s={}
v=s.get(field,"")
if v is None: v=""
print(v)
' "$field" 2>/dev/null || echo ''
}

status_line() {
  api_get /api/status | python3 -c '
import sys,json
try:
  s=json.load(sys.stdin).get("status") or {}
except Exception:
  s={}
print("status={status} run={run_id} done={done}/{target} sso={sso_count} oauth={oauth_count} fail={fail_count} detail={phase_detail}".format(
  status=s.get("status",""),
  run_id=s.get("run_id",""),
  done=s.get("done",0),
  target=s.get("target",0),
  sso_count=s.get("sso_count",0),
  oauth_count=s.get("oauth_count",0),
  fail_count=s.get("fail_count",0),
  phase_detail=s.get("phase_detail",""),
))
' 2>/dev/null || echo 'status=unknown'
}

wait_panel() {
  local i
  for i in $(seq 1 60); do
    if curl -sS --max-time 5 "${PANEL_URL}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    log "wait panel health retry=$i"
    sleep 5
  done
  log "panel health failed"
  return 1
}

wait_until_stopped() {
  local last="" line st
  while true; do
    st="$(status_field status)"
    line="$(status_line)"
    if [[ "$line" != "$last" ]]; then
      log "progress: $line"
      last="$line"
    fi
    if [[ "$st" != "running" ]]; then
      log "batch not running: $line"
      return 0
    fi
    sleep "$POLL_SEC"
  done
}

start_or_reuse() {
  local target="$1"
  local st run_id resp
  st="$(status_field status)"
  if [[ "$st" == "running" ]]; then
    run_id="$(status_field run_id)"
    log "reuse running pipeline run_id=$run_id"
    printf '%s' "$run_id"
    return 0
  fi
  resp="$(api_post_json /api/start "{\"target\":${target}}")"
  log "start resp: $resp"
  run_id="$(printf '%s' "$resp" | python3 -c '
import sys,json
try:
  d=json.load(sys.stdin)
except Exception:
  d={}
print(d.get("run_id","") if d.get("ok") else "")
' 2>/dev/null || true)"
  if [[ -z "$run_id" ]]; then
    log "start failed"
    return 1
  fi
  printf '%s' "$run_id"
  return 0
}

package_and_upload() {
  local run_id="$1"
  if [[ -z "$run_id" ]]; then
    log "skip upload: empty run_id"
    return 0
  fi
  local out="$WORK_DIR/runs/$run_id"
  rm -rf "$out"
  mkdir -p "$out"
  if ! docker cp "grok-panel:/data/outputs/${run_id}/CPA" "$out/CPA" >>"$LOG_FILE" 2>&1; then
    log "docker cp CPA failed for run=$run_id"
    return 1
  fi
  local n
  n="$(find "$out/CPA" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
  log "CPA files for run=$run_id count=$n"
  if [[ "$n" -eq 0 ]]; then
    log "skip upload: no CPA files"
    return 0
  fi
  local zip_path="$out/CPA.zip"
  if ! (cd "$out/CPA" && zip -q "$zip_path" ./*.json); then
    log "zip failed"
    return 1
  fi
  log "zip ready: $zip_path"
  if [[ -z "${CANDIDATE_TOKEN:-}" ]]; then
    log "CANDIDATE_TOKEN empty: skip HTTP upload"
    return 0
  fi
  local upload_resp_file="$out/upload-resp.json"
  local http_code
  http_code="$(curl -sS -X POST "$CANDIDATE_UPLOAD_URL" \
    -H "Authorization: Bearer ${CANDIDATE_TOKEN}" \
    -F "files=@${zip_path}" \
    -o "$upload_resp_file" -w '%{http_code}' \
    --max-time 180 2>/dev/null || echo 000)"
  local body
  body="$(head -c 1000 "$upload_resp_file" 2>/dev/null || true)"
  log "candidate upload http=$http_code body=$body"
  python3 - "$upload_resp_file" "$http_code" <<'PY'
import json,sys
path, code = sys.argv[1], sys.argv[2]
try:
    d=json.load(open(path))
except Exception as e:
    print(f'upload parse fail: {e}', file=sys.stderr)
    sys.exit(1)
ok = d.get('ok') is True and str(code).startswith('2')
print(f"upload summary ok={ok} received={d.get('received')} saved={d.get('saved')} candidates={d.get('candidates')}")
sys.exit(0 if ok else 1)
PY
  return $?
}

main() {
  log "continuous refill start pid=$$ panel=$PANEL_URL target=$BATCH_TARGET cooldown=${BATCH_COOLDOWN_SEC}s max_batches=$MAX_BATCHES"
  if ! wait_panel; then
    exit 1
  fi
  local batch_no=0 run_id
  while true; do
    batch_no=$((batch_no + 1))
    if [[ "$MAX_BATCHES" != "0" && "$batch_no" -gt "$MAX_BATCHES" ]]; then
      log "reached MAX_BATCHES=$MAX_BATCHES, exit"
      break
    fi
    log "==== batch #$batch_no start target=$BATCH_TARGET ===="
    write_state "$batch_no" "" "starting"
    run_id="$(start_or_reuse "$BATCH_TARGET" || true)"
    if [[ -z "$run_id" ]]; then
      log "no run_id, sleep 60 and retry"
      write_state "$batch_no" "" "start_failed"
      sleep 60
      continue
    fi
    write_state "$batch_no" "$run_id" "running"
    log "tracking run_id=$run_id"
    wait_until_stopped
    write_state "$batch_no" "$run_id" "uploading"
    if package_and_upload "$run_id"; then
      write_state "$batch_no" "$run_id" "uploaded"
      log "batch #$batch_no upload ok"
    else
      write_state "$batch_no" "$run_id" "upload_failed"
      log "batch #$batch_no upload failed (continue)"
    fi
    log "cooldown ${BATCH_COOLDOWN_SEC}s before next batch"
    sleep "$BATCH_COOLDOWN_SEC"
  done
}

main "$@"
