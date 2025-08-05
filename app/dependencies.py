from __future__ import annotations

import hmac
import hashlib
import json
import logging

import redis.asyncio as redis
from redis.exceptions import RedisError
from fastapi import Depends, Header, HTTPException, Request
from pydantic import BaseModel

from app.config import Settings

settings = Settings()
HMAC_SECRET_PARTNER = settings.hmac_secret_partner
redis_client = redis.from_url(settings.redis_url, encoding="utf-8", decode_responses=True)


logger = logging.getLogger(__name__)


class ErrorResponse(BaseModel):
    code: str
    message: str


async def require_api_headers(
    x_api_key: str = Header(..., alias="X-API-Key"),
    x_api_ver: str | None = Header(None, alias="X-API-Ver"),
    x_user_id: int | None = Header(None, alias="X-User-ID"),
) -> int:
    if x_api_ver is None:
        err = ErrorResponse(code="UPGRADE_REQUIRED", message="Missing API version")
        raise HTTPException(status_code=426, detail=err.model_dump())

    if x_api_ver != "v1":
        err = ErrorResponse(code="UPGRADE_REQUIRED", message="Invalid API version")
        raise HTTPException(status_code=426, detail=err.model_dump())

    if x_api_key != settings.api_key:
        err = ErrorResponse(code="UNAUTHORIZED", message="Invalid API key")
        raise HTTPException(status_code=401, detail=err.model_dump())

    if x_user_id is None:
        err = ErrorResponse(code="UNAUTHORIZED", message="Missing user ID")
        raise HTTPException(status_code=401, detail=err.model_dump())

    return x_user_id


async def rate_limit(request: Request, user_id: int = Depends(require_api_headers)) -> int:
    """Throttle requests by IP and user via Redis."""
    client_host = request.client.host if request.client else ""
    ip = client_host
    xff = request.headers.get("X-Forwarded-For")
    if xff and client_host in settings.trusted_proxies:
        forwarded = [h.strip() for h in xff.split(",") if h.strip()]
        proxies = forwarded[1:] + [client_host]
        if all(p in settings.trusted_proxies for p in proxies):
            ip = forwarded[0]
    ip_key = f"rate:ip:{ip}"
    user_key = f"rate:user:{user_id}"

    try:
        pipe = redis_client.pipeline()
        pipe.incr(ip_key)
        pipe.expire(ip_key, 60)
        pipe.incr(user_key)
        pipe.expire(user_key, 60)
        ip_count, _, user_count, _ = await pipe.execute()
    except RedisError as exc:
        logger.exception("Redis unavailable for rate limiting: %s", exc)
        err = ErrorResponse(
            code="SERVICE_UNAVAILABLE", message="Rate limiter unavailable"
        )
        raise HTTPException(status_code=503, detail=err.model_dump()) from exc
    if ip_count > 30 or user_count > 120:
        err = ErrorResponse(code="TOO_MANY_REQUESTS", message="Rate limit exceeded")
        raise HTTPException(status_code=429, detail=err.model_dump())

    return user_id


def compute_signature(secret: str, payload: dict) -> str:
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


async def verify_partner_hmac(request: Request, x_sign: str):
    raw_body = await request.body()
    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError as err:
        err_payload = ErrorResponse(code="BAD_REQUEST", message="Malformed JSON")
        raise HTTPException(status_code=400, detail=err_payload.model_dump()) from err

    if not isinstance(payload, dict):
        err = ErrorResponse(code="BAD_REQUEST", message="Invalid payload")
        raise HTTPException(status_code=400, detail=err.model_dump())

    provided_sign = payload.get("signature")
    if not provided_sign:
        err = ErrorResponse(code="BAD_REQUEST", message="Missing signature")
        raise HTTPException(status_code=400, detail=err.model_dump())

    payload.pop("signature", None)
    calculated = compute_signature(HMAC_SECRET_PARTNER, payload)

    if not hmac.compare_digest(calculated, x_sign) or not hmac.compare_digest(
        calculated, provided_sign
    ):
        err = ErrorResponse(code="UNAUTHORIZED", message="Invalid signature")
        raise HTTPException(status_code=401, detail=err.model_dump())

    return payload, calculated, provided_sign


# Backward compatibility for existing imports
verify_hmac = verify_partner_hmac
