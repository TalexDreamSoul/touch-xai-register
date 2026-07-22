# registrar-js — xAI OAuth 自动注册（JS 版）

配合 CLIProxyAPI 管理面板，自动完成 xAI 账号注册和 Device Flow OAuth 授权。

## 两个版本

| 文件 | 说明 |
|------|------|
| `xai-oauth-v5.js` | **主入口（v5）**。精简版：DuckMail API + `puppeteer-core`，流程为 创建邮箱 → 注册 xAI → 登录 CPA → 触发 OAuth 取 user_code → Device 授权 → 回传 CPA |
| `xai-oauth.js` | 多邮箱协议兼容版。基于 `puppeteer-real-browser` + `src/mailProvider.js`，支持 `auto / legacy / cloud-mail / simple-email / duckmail` 多种临时邮箱协议 |

## 流程

1. 创建临时邮箱
2. 登录管理面板，点击「开始 xAI 登录」获取 user_code
3. 新标签页打开 xAI device 页面，输入 user_code
4. 邮箱注册 → 填写验证码 → 名/姓/密码 → 完成注册
5. 自动点击「允许」授权 → Token 落入管理面板

## 安装

```bash
npm install
cp config.example.json config.json   # 按下方说明填写
```

## 配置

| 字段 | 说明 | 示例 |
|------|------|------|
| `mailBaseUrl` | 临时邮箱服务地址 | `https://api.duckmail.sbs` |
| `mailProvider` | 邮箱协议（仅 `xai-oauth.js` 使用） | `duckmail` |
| `duckmailApiKey` | DuckMail API Key（v5 必填） | `dk_xxx` |
| `mailAdminPassword` | 邮箱服务管理密码 | `your-password` |
| `mailDomain` / `mailDomains` | 邮箱域名（列表） | `your-domain.top` |
| `registerPassword` | xAI 注册密码 | `YourP@ssw0rd` |
| `managementUrl` | CPA 管理面板地址 | `http://127.0.0.1:8317` |
| `managementKey` | 管理面板登录密钥 | `your-key` |
| `chromePath` | Chrome 路径 | macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`<br>Windows: `C:\Program Files\Google\Chrome\Application\chrome.exe`<br>Linux: `/usr/bin/google-chrome-stable` |
| `tokenOutputDir` | Token JSON 输出目录 | `tokens` |

## 使用

```bash
npm start            # v5（DuckMail 精简版，推荐）
npm run start:multi  # 多邮箱协议版
```

## 依赖

- Node.js 18+
- Google Chrome 浏览器
- 临时邮箱服务（DuckMail / simple-email 协议，如 Cloudflare Worker）
- CLIProxyAPI 管理面板

## 注意事项

- 需要图形界面环境（headless: false）
- xAI 有频率限制，短时间多次注册会触发 rate_limited
- 管理面板需在本地运行
- `config.json` 与 `tokens/` 含敏感信息，已在 `.gitignore` 中，切勿提交
