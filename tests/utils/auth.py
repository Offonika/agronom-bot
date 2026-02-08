from __future__ import annotations

import hashlib
import json
import time
import uuid

from app.config import Settings
from app.dependencies import compute_signature


def build_auth_headers(
    method: str,
    path: str,
    *,
    user_id: int | str = 1,
    api_key: str | None = None,
    api_ver: str = "v1",
    query: str | None = None,
    body: object | None = None,
    ts: int | None = None,
    nonce: str | None = None,
    sign: str | None = None,
) -> dict[str, str]:
    settings = Settings()
    secret = api_key or settings.api_key
    ts_value = int(ts if ts is not None else time.time())
    nonce_value = nonce or uuid.uuid4().hex
    payload = {
        "user_id": int(user_id),
        "ts": ts_value,
        "nonce": nonce_value,
        "method": method.upper(),
        "path": path,
        "query": query or "",
    }
    body_hash = None
    if body is not None:
        canonical = json.dumps(
            body, separators=(",", ":"), sort_keys=True, ensure_ascii=False
        ).encode()
        body_hash = hashlib.sha256(canonical).hexdigest()
        payload["body_sha256"] = body_hash
    signature = sign or compute_signature(secret, payload)
    headers = {
        "X-API-Key": secret,
        "X-API-Ver": api_ver,
        "X-User-ID": str(user_id),
        "X-Req-Ts": str(ts_value),
        "X-Req-Nonce": nonce_value,
        "X-Req-Sign": signature,
    }
    if body_hash:
        headers["X-Req-Body-Sha256"] = body_hash
    return headers
