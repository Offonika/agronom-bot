from __future__ import annotations

import hashlib
import hmac
import json
from fastapi import Header, HTTPException, Request
from pydantic import BaseModel

from app.config import Settings

settings = Settings()
HMAC_SECRET = settings.hmac_secret


class ErrorResponse(BaseModel):
    code: str
    message: str


async def require_api_headers(
    x_api_key: str = Header(..., alias="X-API-Key"),
    x_api_ver: str = Header(..., alias="X-API-Ver"),
    x_user_id: int | None = Header(None, alias="X-User-ID"),
) -> int:
    if x_api_ver != "v1":
        err = ErrorResponse(code="BAD_REQUEST", message="Invalid API version")
        raise HTTPException(status_code=400, detail=err.model_dump())

    if x_api_key != settings.api_key:
        err = ErrorResponse(code="UNAUTHORIZED", message="Invalid API key")
        raise HTTPException(status_code=401, detail=err.model_dump())

    return x_user_id or 1


def compute_signature(secret: str, payload: dict) -> str:
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


async def verify_hmac(request: Request, x_sign: str):
    raw_body = await request.body()
    try:
        data = json.loads(raw_body)
    except Exception as err:
        raise HTTPException(status_code=400, detail="BAD_REQUEST") from err

    provided_sign = data.pop("signature", None)
    if not provided_sign:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")

    calculated = compute_signature(HMAC_SECRET, data)
    if not hmac.compare_digest(calculated, x_sign) or not hmac.compare_digest(calculated, provided_sign):
        raise HTTPException(status_code=401, detail="UNAUTHORIZED")

    return data, calculated, provided_sign
