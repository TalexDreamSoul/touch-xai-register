#!/usr/bin/env python3
"""Bridge FreeMail / webhook store → touch-xai-register custom EMAIL_API contract.

Grok custom mode polls:
  GET {EMAIL_API}/check/{email}  →  {"code": "ABC123"} or {"code": ""}

This service also accepts the legacy Cloudflare Worker webhook payload so
EMAIL_MODE=custom + webhook catch-all keeps working without a separate
email_server.py.
"""
from __future__ import annotations

import os
import re
import threading
import time
from typing import Any
from urllib.parse import quote, unquote

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

FREEMAIL_BASE = os.getenv("FREEMAIL_BASE", "").rstrip("/")
FREEMAIL_API_KEY = os.getenv("FREEMAIL_API_KEY", "")
WEBHOOK_TOKEN = os.getenv("WEBHOOK_TOKEN", "")
CODE_TTL_SEC = int(os.getenv("CODE_TTL_SEC", "1800"))

CODE_RES = [
    re.compile(r">([A-Z0-9]{3}-[A-Z0-9]{3})<", re.I),
    re.compile(r">([A-Z0-9]{6})<", re.I),
    re.compile(r"\b([A-Z0-9]{3}-?[A-Z0-9]{3})\b", re.I),
    re.compile(r"(?:code|验证码|verification)[^\dA-Z]{0,20}([A-Z0-9]{6})\b", re.I),
]

app = FastAPI(title="touch-xai-register mail-bridge", version="0.1.0")

_lock = threading.Lock()
# email(lower) → list[{code, ts, subject}]
_store: dict[str, list[dict[str, Any]]] = {}


def _headers() -> dict[str, str]:
    h = {"Accept": "application/json"}
    if FREEMAIL_API_KEY:
        h["Authorization"] = f"Bearer {FREEMAIL_API_KEY}"
    return h


def _extract_code(*parts: str) -> str:
    text = "\n".join(p for p in parts if p)
    if not text:
        return ""
    for rx in CODE_RES:
        m = rx.search(text)
        if m:
            return m.group(1).replace("-", "").upper()
    return ""


def _remember(email: str, code: str, subject: str = "") -> None:
    if not email or not code:
        return
    key = email.strip().lower()
    now = time.time()
    with _lock:
        items = [x for x in _store.get(key, []) if now - float(x.get("ts", 0)) < CODE_TTL_SEC]
        # de-dupe latest same code
        items = [x for x in items if str(x.get("code", "")).upper() != code.upper()]
        items.append({"code": code, "ts": now, "subject": subject})
        _store[key] = items[-20:]


def _latest_code(email: str) -> str:
    key = email.strip().lower()
    now = time.time()
    with _lock:
        items = [x for x in _store.get(key, []) if now - float(x.get("ts", 0)) < CODE_TTL_SEC]
        _store[key] = items
        if not items:
            return ""
        return str(items[-1].get("code") or "")


async def _freemail_check(email: str) -> str:
    if not FREEMAIL_BASE:
        return ""
    address = email.strip().lower()
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(
            f"{FREEMAIL_BASE}/api/emails",
            params={"mailbox": address, "limit": 10},
            headers=_headers(),
        )
        if r.status_code != 200:
            return ""
        data = r.json()
        messages = data if isinstance(data, list) else data.get("results") or data.get("emails") or []
        if not isinstance(messages, list):
            return ""
        # Prefer explicit verification_code field from FreeMail D1
        for m in messages:
            if not isinstance(m, dict):
                continue
            code = str(m.get("verification_code") or "").strip()
            if code:
                return code.replace("-", "").upper()
        # Fall back to detail body for recent messages
        for m in messages[:5]:
            if not isinstance(m, dict):
                continue
            mid = m.get("id")
            subject = str(m.get("subject") or "")
            preview = str(m.get("preview") or m.get("content") or "")
            code = _extract_code(subject, preview)
            if code:
                return code
            if not mid:
                continue
            try:
                d = await client.get(
                    f"{FREEMAIL_BASE}/api/email/{quote(str(mid))}",
                    headers=_headers(),
                )
                if d.status_code != 200:
                    continue
                detail = d.json()
                if not isinstance(detail, dict):
                    continue
                code = str(detail.get("verification_code") or "").strip()
                if code:
                    return code.replace("-", "").upper()
                code = _extract_code(
                    str(detail.get("subject") or subject),
                    str(detail.get("content") or detail.get("text") or ""),
                    str(detail.get("html_content") or detail.get("html") or ""),
                    str(detail.get("preview") or ""),
                )
                if code:
                    return code
            except Exception:
                continue
    return ""


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "mail-bridge",
        "freemail": bool(FREEMAIL_BASE),
        "store_keys": len(_store),
    }


@app.post("/webhook")
async def webhook(
    request: Request,
    x_webhook_token: str | None = Header(default=None),
) -> JSONResponse:
    if WEBHOOK_TOKEN:
        if not x_webhook_token or x_webhook_token != WEBHOOK_TOKEN:
            raise HTTPException(status_code=401, detail="invalid webhook token")
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="invalid json") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="payload must be object")

    to_raw = payload.get("to") or payload.get("recipient") or ""
    if isinstance(to_raw, list):
        to_raw = to_raw[0] if to_raw else ""
    to_addr = str(to_raw)
    # strip display name
    m = re.search(r"[\w.+\-]+@[\w.\-]+", to_addr)
    email = (m.group(0) if m else to_addr).strip().lower()
    subject = str(payload.get("subject") or "")
    text = str(payload.get("text") or payload.get("body") or "")
    html = str(payload.get("html") or "")
    code = _extract_code(subject, text, html)
    if code:
        _remember(email, code, subject)
    return JSONResponse({"ok": True, "email": email, "code": code or ""})


@app.get("/check/{email:path}")
async def check(email: str) -> dict[str, str]:
    addr = unquote(email).strip().lower()
    if "@" not in addr:
        raise HTTPException(status_code=400, detail="invalid email")
    # 1) webhook store
    code = _latest_code(addr)
    if code:
        return {"code": code}
    # 2) FreeMail remote
    code = await _freemail_check(addr)
    if code:
        _remember(addr, code)
        return {"code": code}
    return {"code": ""}


@app.post("/remember")
async def remember(request: Request) -> dict[str, Any]:
    """Manual inject for tests: {"email":"...","code":"ABC123"}."""
    body = await request.json()
    email = str(body.get("email") or "").strip().lower()
    code = str(body.get("code") or "").strip().replace("-", "").upper()
    if not email or not code:
        raise HTTPException(status_code=400, detail="email and code required")
    _remember(email, code, str(body.get("subject") or ""))
    return {"ok": True, "email": email, "code": code}
