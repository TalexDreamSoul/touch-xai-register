# touch-xai-register

xAI / Grok 账号 **注册 → OAuth → CPA 凭证入库/导出** 一体化工具箱，对接 CLIProxyAPI（简称 CPA）。

```text
注册（register）                入库 / 管理（manage）
┌──────────────────┐  CPA JSON  ┌──────────────────┐
│ grok-register    │ ─────────▶ │ CPA Management   │
│ (Go 注册机+面板)  │  自动上传   │ (CLIProxyAPI)    │
│ registrar-js     │ ─────────▶ └──────┬───────────┘
│ (Node 备选注册机) │                 │ 批量上传 / 分批导出
└──────────────────┘            ┌─────▼───────────┐
                                │ 本仓库根服务      │
                                │ (Node/Express)  │
                                └─────────────────┘
```

## 一个服务，两个路由

根目录 Node 服务是统一入口：

| 路由 | 功能 | 来源 |
|------|------|------|
| `http://127.0.0.1:8788/` | **凭证批量上传 / 分批导出**：多 `.json`/`.zip`/文件夹/粘贴 JSON → 分批并发上传；筛选远端号池 → 分批下载打多卷 zip，SSE 实时进度 | 内置 |
| `http://127.0.0.1:8788/panel/` | **Grok 注册面板**：启动/停止注册、进度、实时日志、下载 CPA zip | 反向代理 → `grok panel`（默认 `127.0.0.1:8787`，可用 `PANEL_TARGET` 改） |

## 仓库结构

| 路径 | 技术栈 | 作用 |
|------|--------|------|
| `server.js` + `public/` | Node/Express | 根服务：凭证上传/导出（`/`）+ 注册面板代理（`/panel/`） |
| `grok-register/` | Go + Playwright | 主力注册机：注册 → Device Flow OAuth → CPA JSON，自带 Web 面板与 Docker 清障栈（WARP + Privoxy + FlareSolverr） |
| `registrar-js/` | Node + Puppeteer | 轻量备选注册机：`xai-oauth-v5.js` 主入口（DuckMail），`xai-oauth.js` 支持多种临时邮箱协议 |

## 快速开始

### 1. 根服务（上传/导出 + 面板入口）

```bash
npm install
npm start            # http://127.0.0.1:8788
```

可选环境变量：`PORT`（默认 8788）、`HOST`、`PANEL_TARGET`（默认 `http://127.0.0.1:8787`）。

页内填 CPA Base URL + Management Key → 测试连接 → 拖入凭证批量上传，或按 provider/email 筛选分批导出为多卷 zip。

### 2. 注册面板（grok-register）

```bash
cd grok-register
make build                 # 产出 bin/grok
./bin/grok start -t 10     # 跑 10 个号
./bin/grok panel           # 面板 :8787（根服务 /panel/ 即代理到这里）
```

浏览器打开 `http://127.0.0.1:8788/panel/` 即可统一访问。

服务器 Docker 一键部署见 `grok-register/DEPLOY.md`。

### 3. 轻量备选注册机（registrar-js）

```bash
cd registrar-js
npm install
cp config.example.json config.json   # 填 DuckMail Key、CPA 地址与密钥、Chrome 路径
npm start                            # v5 主流程
npm run start:multi                  # 多邮箱协议兼容版
```

## 典型工作流

1. **注册**：grok-register 批量跑注册，成功即 OAuth 并产出 CPA 可用 JSON（可选自动上传到 CPA）。
2. **汇总**：凭证集中在 CPA Management 的 auth-files 号池。
3. **导出备份 / 迁移**：根服务把远端号池按条件筛选、分批导出为多卷 zip；换 CPA 实例时再批量上传回去。
4. **轻量补号**：不想起 Go 全家桶时，用 registrar-js 本地单机跑。

## 安全注意

- 所有 `config.json` / `.env` / `data/` / `tokens/` 均含密钥或账号凭证，已在 `.gitignore`，**切勿提交**。
- 根服务无登录鉴权，默认监听 `0.0.0.0:8788`，仅局域网使用；公网请套反代 + Basic Auth / VPN。
- 导出的 zip 等同于账号凭证备份，传输与存放请加密或限权。
- xAI 有注册频率限制，短时间大量注册会触发 `rate_limited`。
