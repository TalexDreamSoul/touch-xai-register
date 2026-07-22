# ── build grok binary ──────────────────────────────────────────
# Prefer mirror if Docker Hub is slow: docker.m.daocloud.io/library/golang:1.24-bookworm
FROM golang:1.24-bookworm AS build
ENV GOTOOLCHAIN=auto
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags "-s -w -X main.version=0.2.0-panel" -o /out/grok ./cmd/grok

# ── runtime: panel + worker + turnstile browser ────────────────
# Mirror: docker.m.daocloud.io/library/python:3.12-bookworm
FROM python:3.12-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    GROK_HOME=/data \
    PANEL_ADDR=:8787 \
    GROK_PYTHON=/opt/venv/bin/python \
    GROK_TURNSTILE_SCRIPT=/opt/grok/turnstile_mint.py \
    CLOAKBROWSER_SUPPRESS_FONT_WARNING=1 \
    PYTHONUNBUFFERED=1

# Chromium / Playwright system libs + ca-certs + curl for health
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
      libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
      libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 \
      libx11-6 libx11-xcb1 libxcb1 libxext6 libxshmfence1 \
      fonts-liberation fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Python turnstile deps + CloakBrowser Chromium
COPY scripts/requirements-turnstile.txt /tmp/requirements-turnstile.txt
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -U pip \
    && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements-turnstile.txt \
    && /opt/venv/bin/python -m cloakbrowser install \
    && rm -f /tmp/requirements-turnstile.txt

COPY --from=build /out/grok /usr/local/bin/grok
COPY scripts/turnstile_mint.py /opt/grok/turnstile_mint.py
COPY config.env.example /opt/grok/config.env.example
RUN chmod 755 /usr/local/bin/grok /opt/grok/turnstile_mint.py \
    && mkdir -p /data

# Docker-oriented default config (service DNS names)
COPY docker/config.env.docker /opt/grok/config.env.docker
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1${PANEL_ADDR}/api/health" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
CMD ["panel"]
