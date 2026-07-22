# 部署：Web 面板 + Docker 全家桶

一条命令在服务器上跑：**清障栈（WARP / Privoxy / FlareSolverr）+ 注册 worker + Web 控制面板**。

## 要求

| 项 | 建议 |
|----|------|
| 系统 | Debian / Ubuntu x86_64（优先），内存 **≥ 4GB**（推荐 8GB） |
| Docker | Docker 24+ + Compose plugin |
| 网络 | 能访问 x.ai / Cloudflare；WARP 容器需要 `NET_ADMIN` |
| 端口 | 对外只开 **8787**（或前面再挂 Nginx/Caddy） |

## 快速启动

```bash
git clone https://github.com/TalexDreamSoul/touch-xai-register.git
cd touch-xai-register

cp .env.example .env
# 务必改掉 PANEL_TOKEN
nano .env

docker compose up -d --build
docker compose ps
```

浏览器打开：`http://你的服务器IP:8787`  
用 `.env` 里的 `PANEL_TOKEN` 登录。

## 面板能做什么

- 设定目标数，**启动 / 停止**注册
- 看进度（SSO / OAuth / fail）与阶段
- **实时日志**（SSE）
- 历史 run 列表，下载 **CPA.zip / 全部产物**
- 改邮箱模式、代理、FlareSolverr 地址（写入 `/data/config.env`）

## 数据目录

容器内 `GROK_HOME=/data`，Compose 默认挂 volume `grok-data`：

```
/data/
  config.env
  state.json
  run.pid
  logs/run-*.log
  outputs/<run-id>/{SSO,CPA}/
```

备份产物：

```bash
docker run --rm -v grok-register_grok-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/grok-data.tgz -C /data .
```

或改 compose 为 bind mount：

```yaml
volumes:
  - ./data:/data
```

## 常用命令

```bash
docker compose logs -f panel
docker compose restart panel
docker compose down          # 停服务（volume 保留）
docker compose down -v       # 连数据一起删（危险）
```

CLI 仍可用（进容器）：

```bash
docker exec -it grok-panel grok status
docker exec -it grok-panel grok logs -f
```

## 反向代理（推荐）

不要裸奔公网；前面加 HTTPS + 可选 IP 限制。Caddy 示例：

```caddy
register.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

`PANEL_TOKEN` 仍要开。

## 配置说明

首次启动会从 `docker/config.env.docker` 写入 `/data/config.env`（**只写一次**，之后改面板或直接改文件）。

Docker 内默认：

| 变量 | 值 |
|------|-----|
| `REGISTER_PROXY` | `http://privoxy:8118` |
| `FLARESOLVERR_URL` | `http://flaresolverr:8191` |
| `CLEARANCE_PROXY` | `http://privoxy:8118` |
| `TURNSTILE_PROVIDER` | `browser` |

**不要**在容器里把代理写成 `127.0.0.1:40080`（那是宿主机映射口）。

## 镜像拉取困难时

若 Docker Hub / GHCR 超时，可先用镜像站拉再 tag：

```bash
docker pull dockerproxy.net/caomingjun/warp:latest
docker tag dockerproxy.net/caomingjun/warp:latest caomingjun/warp:latest

docker pull dockerproxy.net/vimagick/privoxy:latest
docker tag dockerproxy.net/vimagick/privoxy:latest vimagick/privoxy:latest

docker pull ghcr.nju.edu.cn/flaresolverr/flaresolverr:latest
docker tag ghcr.nju.edu.cn/flaresolverr/flaresolverr:latest ghcr.io/flaresolverr/flaresolverr:latest
```

## 本机开发（不 Docker 面板）

```bash
# 依赖：已 make build，且 clearance compose 已起
export GROK_HOME=$PWD/.grok-home
export GROK_PYTHON=$PWD/.venv/bin/python
export GROK_TURNSTILE_SCRIPT=$PWD/scripts/turnstile_mint.py
export PANEL_TOKEN=devtoken

./bin/grok panel --addr :8787
# open http://127.0.0.1:8787
```

## 故障排查

| 现象 | 排查 |
|------|------|
| 面板打不开 | `docker compose ps` / `logs panel`；安全组是否放行 8787 |
| 401 | `PANEL_TOKEN` 与登录不一致；改 `.env` 后 `compose up -d` |
| 清障失败 | `docker compose logs flaresolverr privoxy warp-proxy` |
| Turnstile timeout | panel 容器内存/shm；`docker logs grok-panel`；确认 CloakBrowser 已装 |
| 注册 403 | 出口 IP 质量；WARP 是否 healthy；换机器区域 |
| 进度不动 | 面板看日志；`docker exec grok-panel grok status` |

## 安全提醒

- 产物含 **access/refresh token**，volume 与下载链接等同账号权限
- 务必设置强 `PANEL_TOKEN`，并优先 HTTPS 反代
- 本工具用于自用运维面板，勿对公网开放无鉴权实例
