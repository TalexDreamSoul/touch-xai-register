APP=grok
MODULE=github.com/grok-free-register/grok-reg
VERSION?=0.2.0-panel
PREFIX?=/usr/local
BINDIR=$(PREFIX)/bin

.PHONY: help build install uninstall clean test run panel panel-ui up down status docker-up docker-down docker-rebuild toolkit-up toolkit-down toolkit-status

# Resolve go even when sudo drops PATH (mise /usr/local / home installs).
GO ?= $(shell command -v go 2>/dev/null || true)
ifeq ($(GO),)
  GO := $(firstword $(wildcard \
	$(HOME)/.local/share/mise/installs/go/latest/bin/go \
	$(HOME)/.local/share/mise/installs/go/*/bin/go \
	/usr/local/go/bin/go \
	/usr/lib/go*/bin/go \
	$(HOME)/go/bin/go \
	$(HOME)/.local/go/bin/go))
endif

help:
	@echo "touch-xai-register / grok"
	@echo ""
	@echo "本机最快启动:"
	@echo "  make up              # clearance(Docker) + 宿主 panel，或复用已在跑的全家桶"
	@echo "  make down            # 停宿主 panel（clearance 保留）"
	@echo "  make down ALL=1      # 停 panel + clearance"
	@echo "  make status          # 健康检查 / 容器状态"
	@echo ""
	@echo "开发:"
	@echo "  make panel-ui        # 构建 Next+Kumo → web/out"
	@echo "  make build           # panel-ui + 编译 bin/grok"
	@echo "  make panel           # 前台跑 panel（:8787）"
	@echo "  make test            # go test ./..."
	@echo ""
	@echo "Docker 全家桶:"
	@echo "  make docker-up       # compose up -d --build"
	@echo "  make docker-rebuild  # 仅重建 panel 镜像并重启"
	@echo "  make docker-down     # compose down"
	@echo ""
	@echo "Toolkit (SMTP + mail-bridge + gateway):"
	@echo "  make toolkit-up      # 叠加 docker-compose.toolkit.yml"
	@echo "  make toolkit-down    # 停 toolkit 叠加服务"
	@echo "  make toolkit-status  # gateway/smtp/bridge 健康"
	@echo ""
	@echo "安装:"
	@echo "  make install         # 装到 $(BINDIR)/grok"
# build embeds web/out; run `make panel-ui` when UI changes
build:
	@if [ ! -f web/out/index.html ]; then \
		echo "[*] web/out missing → panel-ui"; \
		$(MAKE) panel-ui; \
	fi
	@if [ -z "$(GO)" ] || [ ! -x "$(GO)" ]; then \
		echo "错误: 找不到 go。请安装 Go 1.21+ 或把 go 加入 PATH。"; \
		echo "  例: export PATH=\$$PATH:/usr/local/go/bin"; \
		echo "  或: mise install go && mise use go@latest"; \
		exit 1; \
	fi
	@echo "[*] using $(GO)"
	$(GO) build -ldflags "-s -w -X main.version=$(VERSION)" -o bin/$(APP) ./cmd/grok
	@echo "[✓] bin/$(APP)"

# Next.js + Cloudflare Kumo → web/out (embedded by Go)
panel-ui:
	@if [ ! -d panel/node_modules ]; then \
		echo "[*] npm install (panel)"; \
		cd panel && npm install; \
	fi
	@echo "[*] next build (static export)"
	@cd panel && npm run build
	@rm -rf web/out
	@mkdir -p web
	@cp -R panel/out web/out
	@echo "[✓] web/out ready"

panel: build
	@echo "PANEL_TOKEN=$${PANEL_TOKEN:-} GROK_HOME=$${GROK_HOME:-$$HOME/.grok}"
	./bin/$(APP) panel

# 本机一键：优先 scripts/local-up.sh
up:
	@chmod +x scripts/local-up.sh scripts/local-down.sh 2>/dev/null || true
	@./scripts/local-up.sh

down:
	@chmod +x scripts/local-down.sh 2>/dev/null || true
	@if [ "$(ALL)" = "1" ]; then ./scripts/local-down.sh --all; else ./scripts/local-down.sh; fi

status:
	@echo "== panel health =="
	@curl -fsS "http://127.0.0.1:$${PANEL_PORT:-8787}/api/health" 2>/dev/null | (command -v python3 >/dev/null && python3 -m json.tool || cat) \
		|| echo "(panel 未响应 :$${PANEL_PORT:-8787})"
	@echo ""
	@echo "== docker =="
	@docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | (rg -i 'grok|NAMES' || true) || echo "(docker 不可用)"

docker-up:
	@test -f .env || (cp .env.example .env && echo "[*] created .env from example — 请修改 PANEL_TOKEN")
	COMPOSE_PROJECT_NAME=$${COMPOSE_PROJECT_NAME:-grok-register} docker compose up -d --build

docker-rebuild:
	@test -f .env || (cp .env.example .env && echo "[*] created .env from example — 请修改 PANEL_TOKEN")
	COMPOSE_PROJECT_NAME=$${COMPOSE_PROJECT_NAME:-grok-register} docker compose up -d --build --force-recreate panel

docker-down:
	COMPOSE_PROJECT_NAME=$${COMPOSE_PROJECT_NAME:-grok-register} docker compose down

# 不强制 rebuild：已有 bin/grok 时直接安装（避免 sudo 丢 PATH 再编一次失败）
install:
	@if [ ! -x bin/$(APP) ]; then \
		echo "[*] bin/$(APP) 不存在，先 build..."; \
		$(MAKE) build; \
	fi
	install -d $(BINDIR)
	install -m 755 bin/$(APP) $(BINDIR)/$(APP)
	# Playwright mint helper (Turnstile) — same path original project uses
	install -d /usr/local/share/grok-reg
	install -m 755 scripts/turnstile_mint.py /usr/local/share/grok-reg/turnstile_mint.py
	@echo "installed: $(BINDIR)/$(APP)"
	@echo "installed: /usr/local/share/grok-reg/turnstile_mint.py"
	@echo "try: grok help"
	@echo "Turnstile: pip install -r scripts/requirements-turnstile.txt && python -m cloakbrowser install"

uninstall:
	rm -f $(BINDIR)/$(APP)

clean:
	rm -rf bin/

test:
	@if [ -z "$(GO)" ] || [ ! -x "$(GO)" ]; then echo "go not found"; exit 1; fi
	$(GO) test ./...

run:
	@if [ -z "$(GO)" ] || [ ! -x "$(GO)" ]; then echo "go not found"; exit 1; fi
	$(GO) run ./cmd/grok help

# opctoai-toolkit overlay: gateway + smtp + mail-bridge (+ existing panel stack)
toolkit-up:
	@test -f .env || (cp .env.example .env && echo "[*] created .env from example — 请修改 PANEL_TOKEN")
	@test -f config/smtp/.env || (cp config/smtp/.env.example config/smtp/.env && echo "[*] created config/smtp/.env — 请填 FREEMAIL_/SMTP_")
	COMPOSE_PROJECT_NAME=$${COMPOSE_PROJECT_NAME:-grok-register} docker compose \
		-f docker-compose.yml -f docker-compose.toolkit.yml up -d --build

toolkit-down:
	COMPOSE_PROJECT_NAME=$${COMPOSE_PROJECT_NAME:-grok-register} docker compose \
		-f docker-compose.yml -f docker-compose.toolkit.yml down

toolkit-status:
	@echo "== gateway =="
	@curl -fsS -o /dev/null -w "panel  %{http_code}\n" "http://127.0.0.1:$${TOOLKIT_PORT:-8080}/panel/api/health" 2>/dev/null || echo "panel  (gateway 未响应)"
	@curl -fsS -o /dev/null -w "smtp   %{http_code}\n" "http://127.0.0.1:$${TOOLKIT_PORT:-8080}/smtp/" 2>/dev/null || echo "smtp   (gateway 未响应)"
	@curl -fsS "http://127.0.0.1:$${MAIL_BRIDGE_PORT:-18431}/health" 2>/dev/null | (command -v python3 >/dev/null && python3 -m json.tool || cat) \
		|| echo "(mail-bridge 未响应 :$${MAIL_BRIDGE_PORT:-18431})"

