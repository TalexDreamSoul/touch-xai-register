# Continuous batch refill (ops helper)

Host-side loop that repeatedly:

1. `POST /api/start` with `{"target": N}` on a running `grok panel`
2. waits until the pipeline is no longer `running`
3. packages `/data/outputs/<run_id>/CPA/*.json` into a zip (via `docker cp` from `grok-panel`)
4. optionally uploads the zip to a **candidate-upload** HTTP API
5. cools down, then starts the next batch

This is complementary to the in-panel `REFILL_*` patrol/auto-refill (which triggers only when healthy count is low). Use this when you want **unconditional continuous production** of accounts (e.g. fill a candidate pool).

## Requirements

- Docker Compose stack already up (`grok-panel` container name as in root `docker-compose.yml`)
- `PANEL_TOKEN` if the panel has auth enabled
- `curl`, `python3`, `zip`, `docker` on the host
- Optional candidate API that accepts `multipart/form-data` field `files=@CPA.zip` with `Authorization: Bearer <token>` (leave `CANDIDATE_TOKEN` empty to only keep local zips under `WORK_DIR/runs/`)

## Quick start

```bash
# 1) private env (do not commit)
mkdir -p /tmp/touch-xai-refill
cp scripts/refill.env.example /tmp/touch-xai-refill/refill.env
chmod 600 /tmp/touch-xai-refill/refill.env
# edit PANEL_URL / PANEL_TOKEN / CANDIDATE_* / BATCH_TARGET

# 2) one-shot loop (foreground)
set -a && source /tmp/touch-xai-refill/refill.env && set +a
export WORK_DIR=/tmp/touch-xai-refill
export LOG_FILE=$WORK_DIR/continuous-refill.log
./scripts/continuous-refill.sh

# 3) or supervised (watchdog restarts the loop if it exits)
ENV_FILE=/tmp/touch-xai-refill/refill.env \
  WORK_DIR=/tmp/touch-xai-refill \
  nohup ./scripts/refill-watchdog.sh >/tmp/touch-xai-refill/watchdog.nohup 2>&1 &
```

## Stop

```bash
pkill -f 'scripts/refill-watchdog.sh' || true
pkill -f 'scripts/continuous-refill.sh' || true
```

## Notes

- Default compose maps panel to host `:8787`; if that port is taken, set `PANEL_PORT` and point `PANEL_URL` accordingly.
- `BATCH_TARGET` counts **probe-success CPA files**, same as `grok start -t N`.
- Candidate upload is optional: empty `CANDIDATE_TOKEN` skips HTTP upload and keeps `WORK_DIR/runs/<run_id>/CPA.zip`.
- Management auto-upload inside the panel (`CPA_UPLOAD_ENABLED`) is independent; you can enable both (live pool + candidate pool).
