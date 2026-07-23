#!/usr/bin/env bash
set -euo pipefail

export GROK_HOME="${GROK_HOME:-/data}"
export PANEL_ADDR="${PANEL_ADDR:-:8787}"
export GROK_PYTHON="${GROK_PYTHON:-/opt/venv/bin/python}"
export GROK_TURNSTILE_SCRIPT="${GROK_TURNSTILE_SCRIPT:-/opt/grok/turnstile_mint.py}"
export CLOAKBROWSER_SUPPRESS_FONT_WARNING="${CLOAKBROWSER_SUPPRESS_FONT_WARNING:-1}"

mkdir -p "$GROK_HOME" "$GROK_HOME/logs" "$GROK_HOME/outputs"

# Seed config on first boot (never overwrite user edits)
if [[ ! -f "$GROK_HOME/config.env" ]]; then
  if [[ -f /opt/grok/config.env.docker ]]; then
    cp /opt/grok/config.env.docker "$GROK_HOME/config.env"
  else
    cp /opt/grok/config.env.example "$GROK_HOME/config.env"
  fi
  # Allow compose env overrides into the seeded file
  {
    echo ""
    echo "# injected from container env at first boot"
    [[ -n "${REGISTER_PROXY:-}" ]] && echo "REGISTER_PROXY=$REGISTER_PROXY"
    [[ -n "${FLARESOLVERR_URL:-}" ]] && echo "FLARESOLVERR_URL=$FLARESOLVERR_URL"
    [[ -n "${CLEARANCE_PROXY:-}" ]] && echo "CLEARANCE_PROXY=$CLEARANCE_PROXY"
    [[ -n "${HTTP_PROXY:-}" ]] && echo "HTTP_PROXY=$HTTP_PROXY"
    [[ -n "${HTTPS_PROXY:-}" ]] && echo "HTTPS_PROXY=$HTTPS_PROXY"
    [[ -n "${EMAIL_MODE:-}" ]] && echo "EMAIL_MODE=$EMAIL_MODE"
    [[ -n "${EMAIL_DOMAIN:-}" ]] && echo "EMAIL_DOMAIN=$EMAIL_DOMAIN"
    [[ -n "${EMAIL_API:-}" ]] && echo "EMAIL_API=$EMAIL_API"
    [[ -n "${FREEMAIL_BASE:-}" ]] && echo "FREEMAIL_BASE=$FREEMAIL_BASE"
    [[ -n "${FREEMAIL_API_KEY:-}" ]] && echo "FREEMAIL_API_KEY=$FREEMAIL_API_KEY"
    [[ -n "${CPA_MANAGEMENT_BASE:-}" ]] && echo "CPA_MANAGEMENT_BASE=$CPA_MANAGEMENT_BASE"
    [[ -n "${CPA_MANAGEMENT_KEY:-}" ]] && echo "CPA_MANAGEMENT_KEY=$CPA_MANAGEMENT_KEY"
    [[ -n "${CPA_UPLOAD_ENABLED:-}" ]] && echo "CPA_UPLOAD_ENABLED=$CPA_UPLOAD_ENABLED"
  } >> "$GROK_HOME/config.env"
  chmod 600 "$GROK_HOME/config.env"
  echo "[entrypoint] seeded $GROK_HOME/config.env"
fi

# Keep process proxy env in sync for tempmail / outbound (optional)
if [[ -n "${HTTP_PROXY:-}" ]]; then export http_proxy="$HTTP_PROXY"; fi
if [[ -n "${HTTPS_PROXY:-}" ]]; then export https_proxy="$HTTPS_PROXY"; fi
if [[ -n "${NO_PROXY:-}" ]]; then export no_proxy="$NO_PROXY"; fi

exec /usr/local/bin/grok "$@"
