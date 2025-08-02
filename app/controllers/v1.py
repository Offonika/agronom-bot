from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import sqlite3
import asyncio
from datetime import datetime, timezone, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError, field_validator
from sqlalchemy import text

from app.config import Settings
from app import db as db_module
from app.models import Event, PartnerOrder, Payment, Photo
from app.services.gpt import call_gpt_vision_stub
from app.services.protocols import find_protocol
from app.services.storage import upload_photo, get_public_url
from app.services import create_sbp_link
from app.services.hmac import verify_hmac
from app.dependencies import require_api_headers, verify_hmac as verify_request_hmac, ErrorResponse

settings = Settings()
logger = logging.getLogger(__name__)

OPTIONAL_FILE = File(None)

HMAC_SECRET = settings.hmac_secret
FREE_MONTHLY_LIMIT = settings.free_monthly_limit
PAYWALL_ENABLED = settings.paywall_enabled

router = APIRouter()


# -------------------------------
# Pydantic Schemas (по OpenAPI)
# -------------------------------


class DiagnoseRequestBase64(BaseModel):
    image_base64: str
    prompt_id: str

    @field_validator("prompt_id")
    @classmethod
    def validate_prompt_id(cls, v: str) -> str:
        if v != "v1":
            raise ValueError("prompt_id must be 'v1'")
        return v


class ProtocolResponse(BaseModel):
    id: int
    product: str
    dosage_value: float
    dosage_unit: str
    phi: int


class DiagnoseResponse(BaseModel):
    crop: str
    disease: str
    confidence: float
    protocol: ProtocolResponse | None = None
    protocol_status: str | None = None


class LimitsResponse(BaseModel):
    limit_monthly_free: int
    used_this_month: int


class PhotoItem(DiagnoseResponse):
    id: int
    ts: datetime


class ListPhotosResponse(BaseModel):
    items: list[PhotoItem]
    next_cursor: str | None = None


class PaymentWebhook(BaseModel):
    external_id: str
    status: str
    paid_at: datetime
    signature: str


class PaymentCreateRequest(BaseModel):
    user_id: int
    plan: str
    months: int = 1


class PaymentCreateResponse(BaseModel):
    payment_id: str
    url: str


class PaymentStatusResponse(BaseModel):
    status: str
    pro_expires_at: datetime | None = None


class PhotoStatusResponse(BaseModel):
    status: str
    updated_at: datetime
    crop: str | None = None
    disease: str | None = None
    protocol: ProtocolResponse | None = None


class PhotoHistoryItem(BaseModel):
    photo_id: int
    ts: datetime
    crop: str
    disease: str
    status: str
    confidence: float
    thumb_url: str


class PartnerOrderRequest(BaseModel):
    order_id: str
    user_tg_id: int
    protocol_id: int
    price_kopeks: int
    signature: str


# -------------------------------
# Diagnose Endpoint
# -------------------------------


@router.post(
    "/v1/ai/diagnose",
    response_model=DiagnoseResponse,
    responses={
        400: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        502: {"model": ErrorResponse},
    },
)
async def diagnose(
    request: Request,
    user_id: int = Depends(require_api_headers),
    image: UploadFile | None = OPTIONAL_FILE,
    prompt_id: str | None = Form(None),
):
    async def _increment_usage() -> tuple[int, datetime | None]:
        def _db() -> tuple[int, datetime | None]:
            with db_module.SessionLocal() as db:
                moscow_tz = ZoneInfo("Europe/Moscow")
                month_key = datetime.now(moscow_tz).strftime("%Y-%m")
                params = {"uid": user_id, "month": month_key}
                if sqlite3.sqlite_version_info >= (3, 35):
                    stmt = text(
                        "INSERT INTO photo_usage (user_id, month, used, updated_at) "
                        "VALUES (:uid, :month, 1, CURRENT_TIMESTAMP) "
                        "ON CONFLICT(user_id, month) DO UPDATE "
                        "SET used = photo_usage.used + 1, "
                        "updated_at = CURRENT_TIMESTAMP RETURNING used"
                    )
                    used = db.execute(stmt, params).scalar_one()
                else:
                    stmt = text(
                        "INSERT INTO photo_usage (user_id, month, used, updated_at) "
                        "VALUES (:uid, :month, 1, CURRENT_TIMESTAMP) "
                        "ON CONFLICT(user_id, month) DO UPDATE "
                        "SET used = photo_usage.used + 1, "
                        "updated_at = CURRENT_TIMESTAMP"
                    )
                    db.execute(stmt, params)
                    used = db.execute(
                        text(
                            "SELECT used FROM photo_usage WHERE user_id=:uid AND month=:month"
                        ),
                        params,
                    ).scalar_one()

                db.commit()

                pro = db.execute(
                    text("SELECT pro_expires_at FROM users WHERE id=:uid"),
                    {"uid": user_id},
                ).scalar()
                if isinstance(pro, str):
                    pro = datetime.fromisoformat(pro)
                return used, pro

        return await asyncio.to_thread(_db)

    used, pro = await _increment_usage()
    now_utc = datetime.now(timezone.utc)
    if PAYWALL_ENABLED and used > FREE_MONTHLY_LIMIT and (not pro or pro < now_utc):
        if pro and pro < now_utc:
            def _log() -> None:
                with db_module.SessionLocal() as db:
                    db.add(Event(user_id=user_id, event="pro_expired"))
                    db.commit()

            await asyncio.to_thread(_log)
        return JSONResponse(
            status_code=402,
            content={"error": "limit_reached", "limit": FREE_MONTHLY_LIMIT},
        )

    status = "ok"
    file_id = ""
    crop = ""
    disease = ""
    conf = 0.0

    if image:
        if prompt_id not in (None, "v1"):
            err = ErrorResponse(code="BAD_REQUEST", message="prompt_id must be 'v1'")
            return JSONResponse(status_code=400, content=err.model_dump())
        contents = await image.read()
        if len(contents) > 2 * 1024 * 1024:
            err = ErrorResponse(code="BAD_REQUEST", message="image too large")
            return JSONResponse(status_code=400, content=err.model_dump())
        key = await upload_photo(user_id, contents)
        file_id = key
        try:
            result = call_gpt_vision_stub(key)
            crop = result.get("crop", "")
            disease = result.get("disease", "")
            conf = result.get("confidence", 0.0)
            status = "ok"
        except Exception as exc:  # noqa: BLE001
            logger.exception("GPT error", exc_info=exc)
            crop = ""
            disease = ""
            conf = 0.0
            status = "pending"
    else:
        try:
            json_data = await request.json()
        except Exception:  # noqa: BLE001
            err = ErrorResponse(code="BAD_REQUEST", message="invalid JSON")
            return JSONResponse(status_code=400, content=err.model_dump())
        try:
            body = DiagnoseRequestBase64(**json_data)
        except ValidationError as err:
            message = "; ".join(e.get("msg", "") for e in err.errors())
            err = ErrorResponse(code="BAD_REQUEST", message=message)
            return JSONResponse(status_code=400, content=err.model_dump())
        try:
            contents = base64.b64decode(body.image_base64, validate=True)
        except binascii.Error:
            err = ErrorResponse(code="BAD_REQUEST", message="invalid base64")
            return JSONResponse(status_code=400, content=err.model_dump())
        if len(contents) > 2 * 1024 * 1024:
            err = ErrorResponse(code="BAD_REQUEST", message="image too large")
            return JSONResponse(status_code=400, content=err.model_dump())
        key = await upload_photo(user_id, contents)
        file_id = key
        try:
            result = call_gpt_vision_stub(key)
            crop = result.get("crop", "")
            disease = result.get("disease", "")
            conf = result.get("confidence", 0.0)
            status = "ok"
        except Exception as exc:  # noqa: BLE001
            logger.exception("GPT error", exc_info=exc)
            crop = ""
            disease = ""
            conf = 0.0
            status = "pending"

    def _save() -> int:
        with db_module.SessionLocal() as db:
            photo = Photo(
                user_id=user_id,
                file_id=file_id,
                crop=crop,
                disease=disease,
                confidence=conf,
                status=status,
            )
            db.add(photo)
            db.commit()
            return photo.id

    photo_id = await asyncio.to_thread(_save)
    if status != "ok":
        return JSONResponse(
            status_code=202, content={"id": photo_id, "status": "pending"}
        )

    proto = find_protocol(crop, disease)
    if proto:
        proto_resp = ProtocolResponse(
            id=proto.id,
            product=proto.product,
            dosage_value=float(proto.dosage_value or 0),
            dosage_unit=proto.dosage_unit,
            phi=proto.phi,
        )
        proto_status = None
    else:
        proto_resp = None
        proto_status = "Бета" if crop and disease else "Обратитесь к эксперту"

    return DiagnoseResponse(
        crop=crop,
        disease=disease,
        confidence=conf,
        protocol=proto_resp,
        protocol_status=proto_status,
    )


@router.get(
    "/v1/photos",
    response_model=ListPhotosResponse,
    responses={401: {"model": ErrorResponse}},
)
async def list_photos(
    limit: int = 10,
    cursor: str | None = None,
    user_id: int = Depends(require_api_headers),
):
    if limit <= 0:
        return ListPhotosResponse(items=[], next_cursor=None)

    def _db_call() -> tuple[list[PhotoItem], str | None]:
        with db_module.SessionLocal() as db:
            q = (
                db.query(Photo)
                .filter(Photo.user_id == user_id, Photo.deleted.is_(False))
                .order_by(Photo.id.desc())
            )
            if cursor:
                try:
                    last_id = int(cursor)
                    q = q.filter(Photo.id < last_id)
                except ValueError as err:
                    raise HTTPException(status_code=400, detail="BAD_REQUEST") from err

            limit_local = min(limit, 50)
            rows = q.limit(limit_local).all()
            items_local = [
                PhotoItem(
                    id=r.id,
                    ts=r.ts,
                    crop=r.crop or "",
                    disease=r.disease or "",
                    confidence=float(r.confidence or 0),
                )
                for r in rows
            ]
            next_cur = str(rows[-1].id) if len(rows) == limit_local else None
            return items_local, next_cur

    items, next_cursor = await asyncio.to_thread(_db_call)
    return ListPhotosResponse(items=items, next_cursor=next_cursor)


@router.get(
    "/v1/photos/history",
    response_model=list[PhotoHistoryItem],
    responses={401: {"model": ErrorResponse}},
)
async def list_photos_history(
    limit: int = 10,
    offset: int = 0,
    user_id: int = Depends(require_api_headers),
):
    limit = max(0, min(limit, 50))
    offset = max(0, offset)

    def _db_call() -> list[PhotoHistoryItem]:
        with db_module.SessionLocal() as db:
            rows = (
                db.query(Photo)
                .filter(Photo.user_id == user_id, Photo.deleted.is_(False))
                .order_by(Photo.ts.desc())
                .limit(limit)
                .offset(offset)
                .all()
            )
            return [
                PhotoHistoryItem(
                    photo_id=r.id,
                    ts=r.ts,
                    crop=r.crop or "",
                    disease=r.disease or "",
                    status=r.status,
                    confidence=float(r.confidence or 0),
                    thumb_url=get_public_url(r.file_id),
                )
                for r in rows
            ]

    return await asyncio.to_thread(_db_call)


@router.get(
    "/v1/limits",
    response_model=LimitsResponse,
    responses={401: {"model": ErrorResponse}},
)
async def get_limits(user_id: int = Depends(require_api_headers)):
    def _db_call() -> int:
        with db_module.SessionLocal() as db:
            moscow_tz = ZoneInfo("Europe/Moscow")
            month_key = datetime.now(moscow_tz).strftime("%Y-%m")
            return (
                db.execute(
                    text(
                        "SELECT used FROM photo_usage WHERE user_id=:uid AND month=:month"
                    ),
                    {"uid": user_id, "month": month_key},
                ).scalar()
                or 0
            )

    used = await asyncio.to_thread(_db_call)
    return LimitsResponse(limit_monthly_free=FREE_MONTHLY_LIMIT, used_this_month=used)


@router.post(
    "/v1/payments/create",
    response_model=PaymentCreateResponse,
    responses={401: {"model": ErrorResponse}},
)
async def create_payment(body: PaymentCreateRequest, user_id: int = Depends(require_api_headers)):
    if body.user_id != user_id:
        err = ErrorResponse(code="UNAUTHORIZED", message="User ID mismatch")
        raise HTTPException(status_code=401, detail=err.model_dump())

    if body.plan.lower() != "pro":
        raise HTTPException(status_code=400, detail="BAD_REQUEST")

    amount = 19900 * body.months
    currency = "RUB"
    external_id = uuid4().hex
    url = await create_sbp_link(external_id, amount, currency)

    def _db_call() -> None:
        with db_module.SessionLocal() as db:
            payment = Payment(
                user_id=body.user_id,
                amount=amount,
                currency=currency,
                provider="sbp",
                external_id=external_id,
                prolong_months=body.months,
                status="pending",
            )
            db.add(payment)
            db.add(Event(user_id=body.user_id, event="payment_created"))
            db.commit()

    await asyncio.to_thread(_db_call)
    return PaymentCreateResponse(payment_id=external_id, url=url)


@router.get(
    "/v1/payments/{payment_id}",
    response_model=PaymentStatusResponse,
    responses={401: {"model": ErrorResponse}},
)
async def payment_status(payment_id: str, _: None = Depends(require_api_headers)):
    def _db_call() -> tuple[str, datetime | None]:
        with db_module.SessionLocal() as db:
            payment = db.query(Payment).filter_by(external_id=payment_id).first()
            if not payment:
                raise HTTPException(status_code=404, detail="NOT_FOUND")
            exp = db.execute(
                text("SELECT pro_expires_at FROM users WHERE id=:uid"),
                {"uid": payment.user_id},
            ).scalar()
            return payment.status, exp

    status, exp = await asyncio.to_thread(_db_call)
    return PaymentStatusResponse(status=status, pro_expires_at=exp)


@router.post(
    "/v1/payments/sbp/webhook",
    status_code=200,
    responses={401: {"model": ErrorResponse}, 400: {"model": ErrorResponse}},
)
async def payments_webhook(
    request: Request,
    _: None = Depends(require_api_headers),
    x_signature: str | None = Header(None, alias="X-Signature"),
):
    raw_body = await request.body()
    secure = os.getenv("SECURE_WEBHOOK")
    if secure and not verify_hmac(x_signature or "", raw_body, HMAC_SECRET):
        logger.warning("audit: invalid webhook signature")
        raise HTTPException(status_code=403, detail="FORBIDDEN")

    try:
        data = json.loads(raw_body)
    except Exception as err:
        raise HTTPException(status_code=400, detail="BAD_REQUEST") from err
    provided_sign = data.pop("signature", "")

    try:
        body = PaymentWebhook(**data, signature=provided_sign)
    except ValidationError as err:
        raise HTTPException(status_code=400, detail="BAD_REQUEST") from err

    def _db_call() -> None:
        with db_module.SessionLocal() as db:
            payment = db.query(Payment).filter_by(external_id=body.external_id).first()
            if not payment:
                raise HTTPException(status_code=404, detail="NOT_FOUND")
            payment.status = body.status
            payment.updated_at = datetime.now(timezone.utc)
            db.add(payment)

            if body.status == "success":
                months = payment.prolong_months or 0
                res = db.execute(
                    text("SELECT pro_expires_at FROM users WHERE id=:uid"),
                    {"uid": payment.user_id},
                ).scalar()
                current_exp = res or body.paid_at
                if isinstance(current_exp, str):
                    current_exp = datetime.fromisoformat(current_exp)
                if current_exp < body.paid_at:
                    current_exp = body.paid_at
                new_exp = current_exp + timedelta(days=30 * months)
                db.execute(
                    text("UPDATE users SET pro_expires_at=:exp WHERE id=:uid"),
                    {"uid": payment.user_id, "exp": new_exp},
                )
                db.add(Event(user_id=payment.user_id, event="payment_success"))
                db.add(Event(user_id=payment.user_id, event="pro_activated"))
            else:
                db.add(Event(user_id=payment.user_id, event="payment_fail"))

            db.commit()

    await asyncio.to_thread(_db_call)
    return {}


@router.post(
    "/v1/partner/orders",
    status_code=202,
    responses={401: {"model": ErrorResponse}, 400: {"model": ErrorResponse}},
)
async def partner_orders(
    request: Request,
    _: None = Depends(require_api_headers),
    x_sign: str = Header(..., alias="X-Sign"),
):
    data, sign, provided_sign = await verify_request_hmac(request, x_sign)
    try:
        body = PartnerOrderRequest(**data, signature=provided_sign)
    except ValidationError as err:
        raise HTTPException(status_code=400, detail="BAD_REQUEST") from err

    def _db_call() -> None:
        with db_module.SessionLocal() as db:
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

    await asyncio.to_thread(_db_call)
    return JSONResponse(status_code=202, content={"status": "queued"})


@router.get(
    "/v1/photos/{photo_id}",
    response_model=PhotoStatusResponse,
    responses={401: {"model": ErrorResponse}, 404: {"description": "Not found"}},
)
async def photo_status(photo_id: int, user_id: int = Depends(require_api_headers)):
    def _db_call() -> dict:
        with db_module.SessionLocal() as db:
            photo = db.query(Photo).filter_by(
                id=photo_id, user_id=user_id, deleted=False
            ).first()
            if not photo:
                raise HTTPException(status_code=404, detail="NOT_FOUND")
            return {
                "status": photo.status,
                "updated_at": photo.ts,
                "crop": photo.crop,
                "disease": photo.disease,
            }

    photo_data = await asyncio.to_thread(_db_call)

    proto = None
    if (
        photo_data["status"] == "ok"
        and photo_data["crop"]
        and photo_data["disease"]
    ):
        p = await asyncio.to_thread(
            find_protocol, photo_data["crop"], photo_data["disease"]
        )
        if p:
            proto = ProtocolResponse(
                id=p.id,
                product=p.product,
                dosage_value=float(p.dosage_value or 0),
                dosage_unit=p.dosage_unit,
                phi=p.phi,
            )

    return PhotoStatusResponse(
        status=photo_data["status"],
        updated_at=photo_data["updated_at"],
        crop=photo_data["crop"],
        disease=photo_data["disease"],
        protocol=proto,
    )
