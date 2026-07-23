# mail-bridge

把 **Cloudflare FreeMail** / **Email Worker webhook** 适配成 touch-xai-register 的 custom 邮箱契约：

```http
GET /check/{email}  →  {"code":"ABC123"}
```

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `FREEMAIL_BASE` | FreeMail Worker 根 URL |
| `FREEMAIL_API_KEY` | Worker `JWT_TOKEN` |
| `WEBHOOK_TOKEN` | 可选；校验 `X-Webhook-Token` |
| `CODE_TTL_SEC` | 内存验证码 TTL，默认 1800 |

## 本地

```bash
pip install -r requirements.txt
export FREEMAIL_BASE=https://your-worker.example.workers.dev
export FREEMAIL_API_KEY=...
uvicorn app:app --host 0.0.0.0 --port 18431
```

Grok 配置：

```env
EMAIL_MODE=custom
EMAIL_DOMAIN=mail.example.com
EMAIL_API=http://127.0.0.1:18431
```

更多：[`docs/TOOLKIT.md`](../../docs/TOOLKIT.md)。
