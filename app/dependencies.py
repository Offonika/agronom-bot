from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
from ipaddress import ip_address, ip_network

import redis.asyncio as redis
from redis.exceptions import RedisError
from fastapi import Depends, Header, HTTPException, Request
from pydantic import BaseModel

from sqlalchemy import text

from app import db as db_module
from app.config import Settings
from app.models import ErrorCode

settings = Settings()
HMAC_SECRET_PARTNER = settings.hmac_secret_partner
redis_client = redis.from_url(settings.redis_url, encoding="utf-8", decode_responses=True)


logger = logging.getLogger(__name__)


async def close_redis() -> None:
    """Close the shared Redis client to avoid shutdown warnings."""
    try:
        close_fn = getattr(redis_client, "aclose", None) or getattr(redis_client, "close", None)
        if close_fn is not None:
            await close_fn()
    except Exception:
        logger.exception("Failed to close Redis client")
    try:
        pool = getattr(redis_client, "connection_pool", None)
        if pool is not None:
            await pool.disconnect()
    except Exception:
        logger.exception("Failed to disconnect Redis pool")


class ErrorResponse(BaseModel):
    code: ErrorCode
    message: str


def _strip_port(value: str) -> str:
    value = value.strip()
    if not value:
        return value
    if value.startswith("[") and "]" in value:
        return value[1:].split("]")[0]
    if value.count(":") == 1:
        return value.split(":", 1)[0]
    return value


def ip_allowed(ip: str, allowed: list[str]) -> bool:
    if not ip:
        return False
    candidate = _strip_port(ip)
    if candidate == "testclient":
        return "testclient" in allowed
    for entry in allowed:
        entry = entry.strip()
        if not entry:
            continue
        if entry == candidate:
            return True
        if entry == "testclient" and candidate == "testclient":
            return True
        try:
            if "/" in entry:
                if ip_address(candidate) in ip_network(entry, strict=False):
                    return True
            else:
                if ip_address(candidate) == ip_address(entry):
                    return True
        except ValueError:
            continue
    return False


def resolve_client_ip(request: Request, trusted_proxies: list[str]) -> str:
    client_host = request.client.host if request.client else ""
    ip = client_host
    xff = request.headers.get("X-Forwarded-For")
    if xff and ip_allowed(client_host, trusted_proxies):
        forwarded = [_strip_port(h) for h in xff.split(",") if h.strip()]
        if forwarded:
            proxies = forwarded[1:] + [_strip_port(client_host)]
            if all(ip_allowed(p, trusted_proxies) for p in proxies):
                ip = forwarded[0]
    return ip


async def require_api_headers(
    request: Request,
    x_api_key: str = Header(..., alias="X-API-Key"),
    x_api_ver: str | None = Header(None, alias="X-API-Ver"),
    x_user_id: int | None = Header(None, alias="X-User-ID"),
    x_req_sign: str | None = Header(None, alias="X-Req-Sign"),
    x_req_ts: str | None = Header(None, alias="X-Req-Ts"),
    x_req_nonce: str | None = Header(None, alias="X-Req-Nonce"),
    x_req_body_sha256: str | None = Header(None, alias="X-Req-Body-Sha256"),
) -> int:
    if x_api_ver is None:
        err = ErrorResponse(
            code=ErrorCode.UPGRADE_REQUIRED, message="Missing API version"
        )
        raise HTTPException(status_code=426, detail=err.model_dump())

    if x_api_ver != "v1":
        err = ErrorResponse(
            code=ErrorCode.UPGRADE_REQUIRED, message="Invalid API version"
        )
        raise HTTPException(status_code=426, detail=err.model_dump())

    if x_user_id is None:
        err = ErrorResponse(
            code=ErrorCode.UNAUTHORIZED, message="Missing user ID"
        )
        raise HTTPException(status_code=401, detail=err.model_dump())

    user_api_key = await asyncio.to_thread(_fetch_user_api_key, x_user_id)
    if not user_api_key:
        err = ErrorResponse(
            code=ErrorCode.UNAUTHORIZED, message="User API key not found"
        )
        raise HTTPException(status_code=401, detail=err.model_dump())

    if x_api_key != user_api_key:
        err = ErrorResponse(
            code=ErrorCode.UNAUTHORIZED, message="Invalid API key"
        )
        raise HTTPException(status_code=401, detail=err.model_dump())

    if not x_req_sign:
        err = ErrorResponse(
            code=ErrorCode.UNAUTHORIZED, message="Missing request signature"
        )
        raise HTTPException(status_code=401, detail=err.model_dump())

    if not x_req_ts or not x_req_nonce:
        err = ErrorResponse(
            code=ErrorCode.UNAUTHORIZED, message="Missing request timestamp/nonce"
        )
        raise HTTPException(status_code=401, detail=err.model_dump())

    try:
        ts = int(x_req_ts)
    except (TypeError, ValueError):
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Invalid request timestamp"
        )
        raise HTTPException(status_code=400, detail=err.model_dump())

    ttl_seconds = settings.request_signature_ttl_seconds
    now = int(time.time())
    if abs(now - ts) > ttl_seconds:
        err = ErrorResponse(
            code=ErrorCode.UNAUTHORIZED, message="Request signature expired"
        )
        raise HTTPException(status_code=401, detail=err.model_dump())

    nonce_key = f"reqsig:{x_user_id}:{x_req_nonce}"
    try:
        was_set = await redis_client.set(nonce_key, "1", ex=ttl_seconds, nx=True)
    except RedisError as exc:
        logger.exception("Redis unavailable for signature validation: %s", exc)
        err = ErrorResponse(
            code=ErrorCode.SERVICE_UNAVAILABLE,
            message="Signature validator unavailable",
        )
        raise HTTPException(status_code=503, detail=err.model_dump()) from exc
    if not was_set:
        err = ErrorResponse(
            code=ErrorCode.UNAUTHORIZED, message="Request signature replayed"
        )
        raise HTTPException(status_code=401, detail=err.model_dump())

    payload = {
        "user_id": x_user_id,
        "ts": ts,
        "nonce": x_req_nonce,
        "method": request.method.upper(),
        "path": request.url.path,
        "query": request.url.query or "",
    }
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("application/json"):
        try:
            body_payload = await request.json()
        except Exception as exc:
            err = ErrorResponse(
                code=ErrorCode.BAD_REQUEST, message="Invalid JSON payload"
            )
            raise HTTPException(status_code=400, detail=err.model_dump()) from exc
        canonical = json.dumps(
            body_payload, separators=(",", ":"), sort_keys=True, ensure_ascii=False
        ).encode()
        body_hash = hashlib.sha256(canonical).hexdigest()
        if not x_req_body_sha256:
            err = ErrorResponse(
                code=ErrorCode.UNAUTHORIZED, message="Missing request body hash"
            )
            raise HTTPException(status_code=401, detail=err.model_dump())
        if not hmac.compare_digest(body_hash, x_req_body_sha256):
            err = ErrorResponse(
                code=ErrorCode.UNAUTHORIZED, message="Invalid request body hash"
            )
            raise HTTPException(status_code=401, detail=err.model_dump())
        payload["body_sha256"] = body_hash
    expected_sign = compute_signature(user_api_key, payload)
    if not hmac.compare_digest(expected_sign, x_req_sign):
        err = ErrorResponse(
            code=ErrorCode.UNAUTHORIZED, message="Invalid request signature"
        )
        raise HTTPException(status_code=401, detail=err.model_dump())

    return x_user_id


async def rate_limit(request: Request, user_id: int = Depends(require_api_headers)) -> int:
    """Throttle requests by IP and user via Redis."""
    ip = resolve_client_ip(request, settings.trusted_proxies)
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
            code=ErrorCode.SERVICE_UNAVAILABLE,
            message="Rate limiter unavailable",
        )
        raise HTTPException(status_code=503, detail=err.model_dump()) from exc
    if ip_count > 30 or user_count > 120:
        err = ErrorResponse(
            code=ErrorCode.TOO_MANY_REQUESTS, message="Rate limit exceeded"
        )
        raise HTTPException(status_code=429, detail=err.model_dump())

    return user_id


def compute_signature(secret: str, payload: dict) -> str:
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def _fetch_user_api_key(user_id: int) -> str | None:
    with db_module.SessionLocal() as session:
        return session.execute(
            text("SELECT api_key FROM users WHERE id = :uid"),
            {"uid": user_id},
        ).scalar()


async def verify_partner_hmac(request: Request, x_sign: str):
    raw_body = await request.body()
    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError as err:
        err_payload = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Malformed JSON"
        )
        raise HTTPException(status_code=400, detail=err_payload.model_dump()) from err

    if not isinstance(payload, dict):
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Invalid payload"
        )
        raise HTTPException(status_code=400, detail=err.model_dump())

    provided_sign = payload.get("signature")
    if not provided_sign:
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Missing signature"
        )
        raise HTTPException(status_code=400, detail=err.model_dump())

    payload.pop("signature", None)
    calculated = compute_signature(HMAC_SECRET_PARTNER, payload)

    if not hmac.compare_digest(calculated, x_sign) or not hmac.compare_digest(
        calculated, provided_sign
    ):
        err = ErrorResponse(
            code=ErrorCode.UNAUTHORIZED, message="Invalid signature"
        )
        raise HTTPException(status_code=401, detail=err.model_dump())

    return payload, calculated, provided_sign


# Backward compatibility for existing imports
verify_hmac = verify_partner_hmac
