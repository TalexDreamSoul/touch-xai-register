# Third-party notices

## opctoai-toolkit (SMTP Console + Cloudflare Mail)

The following paths are vendored / adapted from
[lhq1363511234/opctoai-toolkit](https://github.com/lhq1363511234/opctoai-toolkit)
(Apache License 2.0):

- `apps/smtp/`
- `apps/cloudflare-mail/`
- configuration templates under `config/smtp/`

Upstream project is recognized by the [LINUX DO](https://linux.do) community.

Review the upstream `LICENSE` / `NOTICE` before redistribution. Deployment-specific
resource IDs, domains, and credentials are **not** copied into this repository.

## Cloudflare FreeMail (`apps/cloudflare-mail`)

Based on the Apache-2.0 project `idinging/freemail`. The Apache-2.0 license text is
preserved in `apps/cloudflare-mail/LICENSE`. See also `apps/cloudflare-mail/UPSTREAM.md`.

## mail-bridge

`apps/mail-bridge/` is original to **touch-xai-register**. It adapts FreeMail HTTP APIs
and optional Cloudflare Email Worker webhooks to this project's
`GET /check/{email}` custom email contract.

## Other dependencies

Go modules, Python packages (Turnstile / SMTP console), Chromium / CloakBrowser,
Docker base images, and Nginx remain under their respective licenses.
