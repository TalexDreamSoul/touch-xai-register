# touch-xai-register

Grok 免费号 **注册 → OAuth → CPA 可用 JSON** 二合一 CLI（Go），附带 **Web 面板 + Docker 全家桶**。

## 5 分钟启动

```bash
# 0) 依赖：Docker(OrbStack) 运行中；本机编译需要 Go（mise/go 皆可）
cd touch-xai-register

# 1) 一键（推荐 macOS / 开发机）
make up
# 打开 http://127.0.0.1:8787
# Token 见终端输出（默认 local-dev-token；Docker 旧容器可能是 local-dev-token-change-me）

# 2) 状态 / 停止
make status
make down            # 停宿主 panel
make down ALL=1      # 停 panel + clearance

# 3) 服务器 / 完整 Docker 全家桶
cp .env.example .env   # 改 PANEL_TOKEN
make docker-up         # 或 docker compose up -d --build
# 代码更新后只重建面板：
make docker-rebuild
```

| 场景 | 命令 | 说明 |
|------|------|------|
| 开发机最快 | `make up` | 已有 `grok-panel` 容器则直接复用；否则 clearance + 宿主 `bin/grok panel` |
| 只要面板不要 Turnstile | `SKIP_TURNSTILE=1 make up` | 上传/导出/巡检可用，注册 mint 可能失败 |
| 完整容器 | `make docker-up` | WARP+Privoxy+FlareSolverr+panel，数据在 volume `grok-data` |
| CLI 注册 | `make build && ./bin/grok start -t 10` | 与 panel 共用 `GROK_HOME`（默认 `~/.grok`） |
| UI 开发 | `cd panel && npm run dev` | Next+Kumo 热更；API 指向 `API_PROXY_TARGET`（默认 :8787） |

面板 UI 为 **Next.js + Cloudflare Kumo**（无自写 CSS），`make build` 会先 `panel-ui` 再嵌入 Go 二进制。

### 主从调度（联邦）

1. **主节点**：设置页 / 主从页 → 角色 `master`，设定 `号池维持数量`、单次分配 1–10、可选联邦密钥。  
   公网可读：`GET /api/federation/info`（可选 `X-Cluster-Token`）。
2. **从节点**：角色 `slave`，填主节点 URL + 同一密钥 → 自动心跳。  
   主节点按缺口分配 1–10；从节点自动 `start`，跑完后可自动上传。
3. 主节点「主从」页可看在线从节点列表、踢出节点。

```bash
# CLI 速查
grok start -t 10
grok status
grok logs -f
grok stop
grok panel     # Web 控制台 :8787
```

---

## 功能

- 临时邮箱 / 自建域名邮箱注册
- 注册成功后立刻 Device Flow OAuth
- 整备 `cli-chat-proxy` + grok-cli headers 的 CPA JSON
- 可选探活；可选自动上传到 CPA Management API
- 内置 Cloudflare 清障 compose（WARP + Privoxy + FlareSolverr）
- Turnstile：默认 **Playwright + CloakBrowser**（与原 Python 注册机同路径），可选 lite farm
- **Web 面板**（`grok panel` / Docker，:8787）五个页签一体化：
  - **注册流水线**：启动/停止、进度、实时日志、下载 CPA zip
  - **凭证上传**：多 `.json` / `.zip` / 服务端目录 / 粘贴 JSON → 分批并发上传 CPA，失败重试、本地缓存跳过重复（移植自 cpa-uploader）
  - **批量导出**：筛选远端号池 → 分批下载 → `part-00x.zip` 分卷 + `manifest.json`，支持全量打包下载
  - **号池 / 巡检**：健康/限流/死号统计、额度估算、定时巡检（轻检/深检）、巡检历史
  - **自动补号**：健康号低于阈值时自动启动注册（冷却期 + 单日上限 + 运行中三重守卫）

---

## 系统要求

| 组件 | 用途 | 不装会怎样 |
|------|------|------------|
| Go 1.21+ | 仅编译 `grok` | 无法 build |
| Python 3.10+ + venv | Turnstile Playwright mint | 拿不到 token |
| Playwright + CloakBrowser | 无头过 CF Turnstile | `timeout` / `iframes=0` |
| CloakBrowser Chromium | 指纹相对稳的无头 Chrome | mint 失败率高 |
| Docker | 清障栈（强烈推荐） | 注册/邮箱/CF 更容易挂 |
| CPA Management（可选） | `grok upload` / 自动上传 | 本地仍有 `CPA/*.json` |

---

## 完整部署（Debian / Ubuntu）

> 目标：系统依赖 → Go → Docker → 编译 `grok` → **无头浏览器** → 清障栈 → 配置 → 跑注册。  
> 以下以 root 或 sudo 为例；路径可按需改。

### 0. 系统依赖

```bash
sudo apt update
sudo apt install -y \
  git curl ca-certificates gnupg lsb-release \
  build-essential \
  python3 python3-pip python3-venv \
  # Chromium / Playwright 常见系统库（无头环境很重要）
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2 \
  fonts-liberation fonts-noto-cjk
```

> 若 `libasound2t64` 不存在，改成 `libasound2`。

### 1. 安装 Go（仅编译需要，建议 1.21+）

```bash
cd /tmp
# 版本号请按 https://go.dev/dl/ 更新
curl -fsSL -o go.tgz https://go.dev/dl/go1.24.4.linux-amd64.tar.gz
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf go.tgz
echo 'export PATH=$PATH:/usr/local/go/bin' | sudo tee /etc/profile.d/go.sh
export PATH=$PATH:/usr/local/go/bin
go version
```

### 2. 安装 Docker（清障栈用）

```bash
# 已有 docker 可跳过
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
docker compose version || sudo apt install -y docker-compose-plugin
```

### 3. 拉取并编译安装 Grok-Register

```bash
sudo mkdir -p /opt
cd /opt
sudo git clone https://github.com/TalexDreamSoul/touch-xai-register.git
cd /opt/touch-xai-register

export PATH=$PATH:/usr/local/go/bin
make build
sudo make install
# 安装结果：
#   /usr/local/bin/grok
#   /usr/local/share/grok-reg/turnstile_mint.py

grok help
```

`sudo make install` 在已有 `bin/grok` 时**不会**再调 `go`（避免 root PATH 里没有 go）。

### 4. 无头浏览器：Playwright + CloakBrowser（**必做**）

Turnstile 默认本机 mint，**只装 `grok` 二进制不够**。

```bash
# 独立 venv（推荐固定路径，方便 root 跑）
sudo python3 -m venv /opt/cloakbrowser-venv
sudo /opt/cloakbrowser-venv/bin/pip install -U pip
sudo /opt/cloakbrowser-venv/bin/pip install -r /opt/touch-xai-register/scripts/requirements-turnstile.txt

# 下载 CloakBrowser 自带 Chromium → ~/.cloakbrowser
# root 跑则装到 /root/.cloakbrowser
sudo /opt/cloakbrowser-venv/bin/python -m cloakbrowser install

# （可选）系统缺库时再执行
# sudo /opt/cloakbrowser-venv/bin/playwright install-deps chromium

# 写进环境（root 长期跑）
echo 'export GROK_PYTHON=/opt/cloakbrowser-venv/bin/python' | sudo tee -a /root/.bashrc
echo 'export CLOAKBROWSER_SUPPRESS_FONT_WARNING=1' | sudo tee -a /root/.bashrc
export GROK_PYTHON=/opt/cloakbrowser-venv/bin/python
export CLOAKBROWSER_SUPPRESS_FONT_WARNING=1
```

可选环境变量：

```bash
# 一般 make install 后不用改脚本路径
# export GROK_TURNSTILE_SCRIPT=/usr/local/share/grok-reg/turnstile_mint.py
# 或：/opt/touch-xai-register/scripts/turnstile_mint.py

# 强制指定 Chrome（通常自动探测 ~/.cloakbrowser）
# export CHROME_PATH=/root/.cloakbrowser/chromium-xxx/chrome
```

**冒烟测试**（清障栈起来后，应打印长 token 且 exit 0）：

```bash
export GROK_PYTHON=/opt/cloakbrowser-venv/bin/python
$GROK_PYTHON /usr/local/share/grok-reg/turnstile_mint.py \
  --site-key 0x4AAAAAAAhr9JGVDZbrZOo0 \
  --url https://accounts.x.ai/sign-up \
  --proxy http://127.0.0.1:40080 \
  --timeout 70
echo exit:$?
```

### 5. 清障栈（WARP + Privoxy + FlareSolverr，强烈推荐）

```bash
cd /opt/touch-xai-register/clearance
sudo docker compose up -d
sudo docker compose ps
# 期望：grok-clearance-warp / privoxy / flaresolverr 均为 healthy
```

端口（仅本机回环）：

| 端口 | 服务 |
|------|------|
| `127.0.0.1:40000` | WARP SOCKS5 |
| `127.0.0.1:40080` | Privoxy HTTP（注册 / 浏览器代理） |
| `127.0.0.1:8191` | FlareSolverr |

检查：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8191/
curl -x http://127.0.0.1:40080 -sS -o /dev/null -w '%{http_code}\n' \
  https://www.cloudflare.com/cdn-cgi/trace
```

> 本机若已有其它占用 `40000/40080/8191` 的 compose，先停掉再起。

### 6. 配置 `~/.grok/config.env`

首次 `grok start` 会交互生成；也可手动：

```bash
sudo mkdir -p /root/.grok
sudo tee /root/.grok/config.env >/dev/null <<'EOF'
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

# CPA 上传：宿主机 grok 必须用 127.0.0.1，不要写 docker 服务名 cli-proxy-api
# 路径需含 /v0/management（上传会再拼 /auth-files）
CPA_UPLOAD_ENABLED=0
CPA_MANAGEMENT_BASE=http://127.0.0.1:8317/v0/management
CPA_MANAGEMENT_KEY=
CPA_UPLOAD_TIMEOUT_SEC=30
CPA_UPLOAD_RETRIES=2
CPA_UPLOAD_NAME_TEMPLATE={email}.json
EOF
```

自建邮箱（可选）：

```env
EMAIL_MODE=custom
EMAIL_DOMAIN=example.com
EMAIL_API=http://127.0.0.1:8080
```

参考 `cloudflare/email-worker.js` 配置 Cloudflare Email Routing catch-all。

临时邮箱默认公共 **tempmail.lol** + mail.tm 系 fallback，**无需私人 API Token**。

### 7. 启动与运维

```bash
export PATH=$PATH:/usr/local/go/bin
export GROK_PYTHON=/opt/cloakbrowser-venv/bin/python
export CLOAKBROWSER_SUPPRESS_FONT_WARNING=1

# 后台跑；目标 N = 探活成功写入 CPA/ 的数量
grok start -t 10
grok status
grok logs -f
grok stop

# 手动上传最近 run 的 CPA JSON 到 Management API
grok upload
```

**数据目录**（`GROK_HOME` 可覆盖，默认 `~/.grok`，root 为 `/root/.grok`）：

```text
~/.grok/
├── config.env
├── run.pid / run.lock / state.json
├── patrol-state.json      # 巡检结果 + 历史 + 补号记录
├── upload-cache.json      # 上传去重缓存（内容 hash）
├── logs/run-yyyymmdd-HHMMSS.log
├── exports/<export_id>/   # 导出分卷 part-00x.zip + manifest.json
├── tmp/                   # multipart 临时文件
└── outputs/
    └── yyyymmdd-HHMMSS/
        ├── SSO/          # accounts.txt, auth-sessions.jsonl
        ├── CPA/          # 探活成功的 CPA JSON（可导入）
        └── discarded/    # 探活失败
```

### 8. 更新版本

```bash
cd /opt/touch-xai-register
sudo git pull
export PATH=$PATH:/usr/local/go/bin
make build && sudo make install
# 若 scripts/requirements 有变：
sudo /opt/cloakbrowser-venv/bin/pip install -r scripts/requirements-turnstile.txt
```

### macOS 备注

- Go / Docker Desktop 自行安装即可  
- Turnstile：同样 `python3 -m venv` + `pip install -r scripts/requirements-turnstile.txt` + `python -m cloakbrowser install`  
- 清障栈：`cd clearance && docker compose up -d`  
- Chrome 也可使用系统 Google Chrome（`CHROME_PATH` 可选）

---

## 命令一览

| 命令 | 说明 |
|------|------|
| `grok start` | 后台启动，默认目标 10 |
| `grok start -t N` | 目标 N（1–10000）；**计数 = 探活成功写入 CPA 的数量** |
| `grok status` | 未运行 / 运行中 / 错误；进度、线程、当前步骤 |
| `grok logs` | 最近一次完整日志 |
| `grok logs -f` | 实时跟踪日志 |
| `grok stop` | 立即停止 |
| `grok upload` | 交互选择最近 10 次 run，上传其中 CPA JSON |

---

## 配置补充（`~/.grok/config.env`）

完整模板见 `config.env.example`。

### 环境变量（进程级）

| 变量 | 说明 |
|------|------|
| `GROK_HOME` | 数据根目录，默认 `~/.grok` |
| `GROK_PYTHON` | 跑 `turnstile_mint.py` 的 Python |
| `GROK_TURNSTILE_SCRIPT` | mint 脚本路径 |
| `CHROME_PATH` | 强制指定 Chromium 可执行文件 |
| `CLOAKBROWSER_SUPPRESS_FONT_WARNING` | 抑制 Linux 字体提示（可选） |

---

## 流水线

```text
清障预热 → S:Turnstile → P:邮箱+验证码 → C:注册拿 SSO
       → 立刻 OAuth (HTTP device verify/approve)
       → 整备 CPA JSON → 探活 → 写 CPA/
       → (可选) 异步上传 Management API
```

- **TARGET**：仅 `CPA/` 探活成功计数  
- **自动上传失败**不影响账号记为成功  
- **邮箱预创建**按 target 限流，避免 target=5 时狂开邮箱  

---

## Turnstile 说明

默认 `browser`：

1. 优先调用 `scripts/turnstile_mint.py`（**Playwright + CloakBrowser 二进制**，对齐原 `register.py`）  
2. 脚本不可用时回退 chromedp（在 CF 下成功率通常更低）  

可选外接 YesCaptcha 形 farm：

```env
TURNSTILE_PROVIDER=lite
LITE_SOLVER_URL=http://127.0.0.1:5072
```

仓库**不内置** farm 镜像。

---

## CPA 上传

### 自动

`CPA_UPLOAD_ENABLED=1` 且配置了 `CPA_MANAGEMENT_KEY` 时，每个成功 CPA JSON 会异步：

- 优先 `multipart` 字段 `file` → `POST .../auth-files`  
- 失败时回退 raw JSON + `?name=`  
- Header：`Authorization: Bearer` + `X-Management-Key`  
- 日志**不打印**密钥  

### 手动

```bash
grok upload
# 列出最近 10 个 outputs/<run_id>/
# 输入 1 或 1,2,3 多选上传
```

### 宿主机 vs Docker 网络

`grok` 跑在**宿主机**时：

```env
# ✅ 正确
CPA_MANAGEMENT_BASE=http://127.0.0.1:8317/v0/management

# ❌ 错误：cli-proxy-api 仅 compose 内可解析
# CPA_MANAGEMENT_BASE=http://cli-proxy-api:8317
```

新版本会自动把 `cli-proxy-api` 等服务名改写为 `127.0.0.1`，并补上 `/v0/management`（若缺失）。

---

## 凭证上传 / 批量导出（面板）

面板内置了原 [cpa-uploader](https://github.com/TalexDreamSoul/cpa-uploader) 的全部能力（Go 重写，零 Node 依赖）：

- **上传**：拖拽多 `.json` / `.zip`（自动解包）、服务端目录、粘贴 JSON → `batchSize` 分批 + `concurrency` 并行 → 失败重试；本地按内容 hash 缓存，重复导入自动跳过
- **导出**：provider / email / 文件名 / 禁用状态 / 数量上限筛选 → 分批并发下载 → 每批打成 `part-001.zip` 分卷（默认 500/卷）+ `manifest.json`；支持失败重试（续编号追加新分卷）与全分卷打包下载
- 任务进度走 **SSE** 实时推送；上传任务内存驻留 2h、导出 7d（分卷文件持久在 `~/.grok/exports/`）

### 从 cpa-uploader 迁移

- `data/config.json` → 面板「设置」页（写入 `config.env`）
- `data/upload-cache.json` → 复制为 `~/.grok/upload-cache.json`（格式兼容）
- `data/exports/` 已产出的 zip 不受影响

---

## 号池巡检与自动补号

巡检和补号**随 `grok panel` 进程运行**（面板停则停；Docker compose 中 panel 常驻）。

### 巡检（PATROL）

```env
PATROL_ENABLED=1
PATROL_INTERVAL_MIN=30
PATROL_DEEP_PROBE=0      # 1=下载凭证真实探活（慢，可识别 429/耗尽）
PATROL_CONCURRENCY=10
QUOTA_PER_ACCOUNT=60     # 单健康号估算日额度（请求数）
```

- **轻检**：仅拉远端列表，按 `disabled` / 状态字段分级（健康/死号/禁用），秒级完成
- **深检**：逐个下载凭证并真实调用探活，可识别 `429 / free-usage-exhausted`（今日耗尽）与死号
- 结果与最近 50 次历史存 `~/.grok/patrol-state.json`，面板「号池」页展示
- **额度估算** = 健康号数 × `QUOTA_PER_ACCOUNT`（CPA Management 无用量接口，估算仅供参考）

### 自动补号（REFILL）

```env
REFILL_ENABLED=1
REFILL_MIN_HEALTHY=5     # 健康号低于此值触发
REFILL_BATCH=10          # 每次补号 target
REFILL_COOLDOWN_MIN=60
REFILL_DAILY_CAP=50
```

四重守卫全部通过才触发：**阈值 + 冷却期 + 单日上限 + 当前无注册任务运行**。补号走的是与手动「启动注册」完全相同的 `ensurePipelineStart` 路径（含探活、写 CPA/、可选自动上传）。默认关闭，建议先观察巡检数据再开启。

---

## 目录结构

```text
Grok-Register/
├── cmd/grok/                 # CLI 入口
├── internal/                 # 业务包
│   ├── clearance/            # FlareSolverr prewarm
│   ├── turnstile/            # Playwright bridge + chromedp fallback + lite
│   ├── pipeline/             # S/P/C + OAuth + CPA
│   ├── cpa/                  # 落盘 + Management 客户端（上传/列表/下载/删除/探活）
│   ├── jobs/                 # 通用任务框架（状态机 + worker pool + SSE hub）
│   ├── transfer/             # 凭证批量上传 / 分批导出（移植自 cpa-uploader）
│   ├── patrol/               # 号池巡检 + 额度估算 + 自动补号
│   └── api/                  # 面板 HTTP 服务（全部路由）
├── web/                      # 面板前端（index.html + app.js + styles.css，go:embed）
├── scripts/
│   ├── turnstile_mint.py     # 与原项目同逻辑的 mint
│   └── requirements-turnstile.txt
├── clearance/                # docker compose 清障栈
├── cloudflare/email-worker.js
├── config.env.example
├── Makefile
└── README.md
```

---

## 清理限额耗尽号（正式池）

自动上传会让 CPA 正式池无限累积；`free-usage-exhausted` 等限额耗尽号通常无法继续使用，但默认不会被移除。

可选清理能力（**默认关闭**）：

| 配置 | 默认 | 说明 |
|------|------|------|
| `CLEANUP_QUOTA_ENABLED` | `0` | 允许定时清理路径 |
| `CLEANUP_ON_PATROL` | `1` | 巡检成功后自动清理 |
| `CLEANUP_BACKUP` | `1` | 删除前下载到 `GROK_HOME/pool-backups/` |
| `CLEANUP_DRY_RUN` | `0` | `1`=只报告不删除 |

- 只删 **限额/免费额度耗尽**（`free-usage-exhausted` 等）
- **不删** 纯 429 临时限流（可能恢复）
- 列表元数据无 `status_message` 时，回退 download + probe 识别
- 面板：号池页「清理限额耗尽」按钮（手动可 force，不要求总开关已开）
- 巡检/清理文字日志：号池页日志区 + `GROK_HOME/logs/patrol.log`；API `GET /api/pool/logs`

```bash
# 设置里打开，或 config.env：
CLEANUP_QUOTA_ENABLED=1
CLEANUP_ON_PATROL=1
CLEANUP_BACKUP=1
CLEANUP_DRY_RUN=1   # 先演练

# 手动
# POST /api/pool/cleanup  {"force":true}
```

与 `REFILL_*` 互补：cleanup 清废号；健康不足时 refill 再注册补号。

---

## 常见问题

**`make build` / `sudo make install` 报 go not found**

```bash
export PATH=$PATH:/usr/local/go/bin
make build
sudo make install          # 已有 bin/grok 时不再调用 go
# 或：sudo install -m 755 bin/grok /usr/local/bin/grok
```

**`turnstile timeout` / `iframes=0`**

1. 确认 `GROK_PYTHON` 指向已装 playwright 的 venv  
2. `python -m cloakbrowser install` 已完成  
3. `clearance` 容器 healthy，`REGISTER_PROXY` 可用  
4. `grok logs -f` 中是否出现 `playwright mint: ...` 具体错误  

**`lookup cli-proxy-api: no such host`**

宿主机跑 `grok`，`CPA_MANAGEMENT_BASE` 用 `http://127.0.0.1:8317/v0/management`。

**邮箱建得特别多**

新版本会按 target 限制 P/Q；请更新到最新代码并 `make build && make install`。

**只想手动导入 CPA**

看 `~/.grok/outputs/<run>/CPA/*.json`，或 `grok upload`。

---

## 开发

```bash
go test ./...
go build -o bin/grok ./cmd/grok
```

