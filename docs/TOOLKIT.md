# opctoai-toolkit 接入说明

本仓库已可选并入 [opctoai-toolkit](https://github.com/lhq1363511234/opctoai-toolkit) 的邮件与网关能力，**不替换**现有 Go 注册机 / 面板 / 清障栈。

| 组件 | 来源 | 作用 |
| --- | --- | --- |
| `apps/smtp` | opctoai-toolkit | SMTP 发信 + 多邮箱源控制台 |
| `apps/cloudflare-mail` | opctoai-toolkit（基于 `idinging/freemail`） | Cloudflare Workers 收信 |
| `apps/mail-bridge` | 本仓库新增 | 把 FreeMail / webhook 适配成 `EMAIL_API/check/{email}` |
| `docker/gateway` | 本仓库 | Nginx 统一入口 |
| `docker-compose.toolkit.yml` | 本仓库 | 叠加 gateway + smtp + mail-bridge |

## 架构

```text
浏览器
  → gateway :8080
      /panel/        → panel :8787   (touch-xai-register)
      /smtp/         → smtp  :18430  (SMTP Console)
      /mail-bridge/  → bridge:18431  (custom EMAIL_API)

注册流水线邮箱路径（三选一）:
  1) EMAIL_MODE=tempmail   公共 tempmail.lol（默认）
  2) EMAIL_MODE=freemail   直连 Cloudflare FreeMail Worker
  3) EMAIL_MODE=custom     EMAIL_API=http://mail-bridge:18431
                           ├─ FreeMail 远程轮询
                           └─ /webhook 接 Cloudflare Email Worker 旧链路
```

## 快速启动（叠加 compose）

```bash
cp .env.example .env
cp config/smtp/.env.example config/smtp/.env
# 编辑 config/smtp/.env：FREEMAIL_BASE / FREEMAIL_API_KEY / SMTP_*

# 完整栈：清障 + 面板 + toolkit
docker compose \
  -f docker-compose.yml \
  -f docker-compose.toolkit.yml \
  up -d --build
```

入口：

```text
http://localhost:8080/panel/
http://localhost:8080/smtp/
http://localhost:8080/mail-bridge/health
```

修改网关端口：

```bash
TOOLKIT_PORT=18080 docker compose \
  -f docker-compose.yml \
  -f docker-compose.toolkit.yml \
  up -d
```

Makefile 快捷命令：

```bash
make toolkit-up
make toolkit-down
make toolkit-status
```

## 邮箱模式配置

### A. FreeMail 直连（推荐，Go 原生）

`~/.grok/config.env` 或面板设置 / volume 内 `config.env`：

```env
EMAIL_MODE=freemail
FREEMAIL_BASE=https://your-mail-worker.example.workers.dev
FREEMAIL_API_KEY=your-worker-jwt-token
EMAIL_DOMAIN=mail.example.com
```

部署 Worker：见 [`apps/cloudflare-mail/README.md`](../apps/cloudflare-mail/README.md)。

### B. custom + mail-bridge（兼容旧 webhook）

```env
EMAIL_MODE=custom
EMAIL_DOMAIN=mail.example.com
EMAIL_API=http://mail-bridge:18431
```

- 容器内 panel 用 compose DNS：`http://mail-bridge:18431`
- 宿主 `grok panel` 用：`http://127.0.0.1:18431`

mail-bridge 能力：

| 路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查 |
| `GET /check/{email}` | 返回 `{"code":"..."}`（Grok custom 契约） |
| `POST /webhook` | 接收 Cloudflare Email Worker JSON 推送 |
| `POST /remember` | 测试注入验证码 |

环境变量（compose / `.env`）：

```env
FREEMAIL_BASE=https://your-mail-worker.example.workers.dev
FREEMAIL_API_KEY=...
WEBHOOK_TOKEN=optional-shared-secret
```

若使用仓库自带 `cloudflare/email-worker.js`，把 `WEBHOOK_URL` 指到：

```text
http://your-public-or-dns-host:18431/webhook
```

> Cloudflare Workers **不能**直连裸 IP，必须用域名。

### C. 仅 SMTP Console（不改注册邮箱）

只起 toolkit 邮件控制台，注册仍用 `tempmail`：

```bash
# .env 保持 EMAIL_MODE=tempmail
make toolkit-up
```

打开 `/smtp/` 管理发信与临时邮箱即可。

## 与 opctoai-toolkit 的差异

| 项 | opctoai-toolkit | touch-xai-register + toolkit |
| --- | --- | --- |
| Grok 实现 | Python DrissionPage 镜像 | **本仓库 Go 面板** |
| 默认入口 | `/grok/` + `/smtp/` | `/panel/` + `/smtp/` |
| 配置 | `config.json` | `config.env` |
| 清障 | 用户自备代理 | 内置 WARP + Privoxy + FlareSolverr |
| 联邦 / 巡检 / 导出 | 无 | 有 |

**不会**引入 Python Grok 注册机镜像；只复用邮件与网关层。

## 许可证与致谢

- SMTP Console / Cloudflare Mail 源码来自 opctoai-toolkit（Apache-2.0）
- `apps/cloudflare-mail` 上游为 `idinging/freemail`（Apache-2.0），许可证见 `apps/cloudflare-mail/LICENSE`
- 详见 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)

## 排障

| 现象 | 处理 |
| --- | --- |
| `/panel/` 404 静态资源 | 网关已把 `/panel/` 剥前缀反代到 panel 根路径；直接访问 `:8787` 不受影响 |
| freemail 创建失败 401 | 检查 `FREEMAIL_API_KEY` 是否等于 Worker `JWT_TOKEN` |
| custom 一直无验证码 | 先 `curl -s http://127.0.0.1:18431/health`；再 `POST /remember` 测桥；确认 Worker 已 catch-all |
| SMTP 控制台打不开 FreeMail | 填 `config/smtp/.env` 的 `FREEMAIL_*` 后重建 `smtp` 容器 |
