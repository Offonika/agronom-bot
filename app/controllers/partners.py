import asyncio  # Required for to_thread
import logging
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError
from redis.exceptions import RedisError

from app import db as db_module
from app import dependencies
from app.config import Settings
from app.dependencies import ErrorResponse, ip_allowed, resolve_client_ip, verify_partner_hmac
from app.models import PartnerOrder, ErrorCode

settings = Settings()
logger = logging.getLogger(__name__)

router = APIRouter(prefix="/partner")


class PartnerOrderRequest(BaseModel):
    order_id: str
    user_tg_id: int
    protocol_id: int
    price_kopeks: int
    signature: str


@router.post(
    "/orders",
    status_code=202,
    responses={401: {"model": ErrorResponse}, 400: {"model": ErrorResponse}},
)
async def partner_orders(
    request: Request,
    x_sign: str = Header(..., alias="X-Sign"),
):
    client_ip = resolve_client_ip(request, settings.trusted_proxies)
    if not ip_allowed(client_ip, settings.partner_ips):
        logger.warning("audit: forbidden ip %s", client_ip)
        err = ErrorResponse(code=ErrorCode.FORBIDDEN, message="IP address forbidden")
        raise HTTPException(status_code=403, detail=err.model_dump())

    ip_key = f"rate:partner-ip:{client_ip}"
    try:
        pipe = dependencies.redis_client.pipeline()
        pipe.incr(ip_key)
        pipe.expire(ip_key, 60)
        count, _ = await pipe.execute()
    except RedisError as exc:
        logger.exception("Redis unavailable for rate limiting: %s", exc)
        err = ErrorResponse(
            code=ErrorCode.SERVICE_UNAVAILABLE, message="Rate limiter unavailable"
        )
        raise HTTPException(status_code=503, detail=err.model_dump()) from exc
    if count > 30:
        err = ErrorResponse(
            code=ErrorCode.TOO_MANY_REQUESTS, message="Rate limit exceeded"
        )
        raise HTTPException(status_code=429, detail=err.model_dump())

    data, sign, provided_sign = await verify_partner_hmac(request, x_sign)
    try:
        body = PartnerOrderRequest(**data, signature=provided_sign)
    except ValidationError as exc:
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Invalid order payload"
        )
        raise HTTPException(status_code=400, detail=err.model_dump()) from exc

    def _db_call():
        with db_module.SessionLocal() as db:
            existing = (
                db.query(PartnerOrder)
                .filter_by(order_id=body.order_id)
                .first()
            )
            if existing:
                return existing.status, False
            order = PartnerOrder(
                user_id=body.user_tg_id,
                order_id=body.order_id,
                protocol_id=body.protocol_id,
                price_kopeks=body.price_kopeks,
                signature=sign,
                status="new",
            )
            db.add(order)
            db.commit()
            return order.status, True

    status, created = await asyncio.to_thread(_db_call)
    code = 202 if created else 200
    return JSONResponse(status_code=code, content={"status": status})
