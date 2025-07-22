from fastapi import (
    FastAPI,
    Header,
    UploadFile,
    File,
    Request,
    HTTPException,
    Form,
)
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator, ValidationError
from contextlib import asynccontextmanager
from datetime import datetime
import base64
import binascii
import os
import json
import hmac
import hashlib

from app.services.storage import upload_photo
from app.services.gpt import call_gpt_vision_stub
from app.services.protocols import find_protocol, import_csv_to_db
from fastapi.concurrency import run_in_threadpool

from app.db import SessionLocal
from app.models import Photo, PhotoQuota, Payment, PartnerOrder


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Run startup tasks for the application."""
    import_csv_to_db()
    yield


app = FastAPI(
    title="Agronom Bot Internal API",
    version="1.4.0",
    lifespan=lifespan,
)

HMAC_SECRET = os.environ.get("HMAC_SECRET", "test-hmac-secret")
# Количество бесплатных запросов в месяц
FREE_MONTHLY_LIMIT = int(os.environ.get("FREE_MONTHLY_LIMIT", "5"))

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


class ErrorResponse(BaseModel):
    code: str
    message: str


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
    payment_id: str
    amount: int
    currency: str
    status: str
    signature: str


class PartnerOrderRequest(BaseModel):
    order_id: str
    user_tg_id: int
    protocol_id: int
    price_kopeks: int
    signature: str


# -------------------------------
# Middleware / Dependency
# -------------------------------


async def verify_headers(
    x_api_key: str = Header(..., alias="X-API-Key"),
    x_api_ver: str = Header(..., alias="X-API-Ver")
):
    if x_api_ver != "v1":
        raise HTTPException(status_code=400, detail="Invalid API version")
    # Validate API key against env var
    api_key = os.getenv("API_KEY", "test-api-key")
    if x_api_key != api_key:
        raise HTTPException(status_code=401, detail="Invalid API key")


async def verify_version(x_api_ver: str = Header(..., alias="X-API-Ver")):
    if x_api_ver != "v1":
        raise HTTPException(status_code=400, detail="Invalid API version")


def verify_hmac_signature(body: bytes, provided: str) -> str:
    expected = hmac.new(HMAC_SECRET.encode(), body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, provided):
        raise HTTPException(status_code=401, detail="UNAUTHORIZED")
    return expected


def compute_signature(secret: str, payload: dict) -> str:
    """Return hex HMAC-SHA256 for a JSON payload."""
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


async def verify_hmac(request: Request, x_sign: str):
    raw_body = await request.body()
    try:
        data = json.loads(raw_body)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")

    provided_sign = data.pop("signature", None)
    if not provided_sign:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")

    calculated = compute_signature(HMAC_SECRET, data)
    if calculated != x_sign or calculated != provided_sign:
        raise HTTPException(status_code=401, detail="UNAUTHORIZED")

    return data, calculated, provided_sign

# -------------------------------
# Diagnose Endpoint
# -------------------------------


@app.post(
    "/v1/ai/diagnose",
    response_model=DiagnoseResponse,
    responses={
        400: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        502: {"model": ErrorResponse}
    }
)
async def diagnose(
    request: Request,
    x_api_key: str = Header(..., alias="X-API-Key"),
    x_api_ver: str = Header(..., alias="X-API-Ver"),
    image: UploadFile | None = File(None),
    prompt_id: str | None = Form(None)
):
    await verify_headers(x_api_key, x_api_ver)

    user_id = 1  # в MVP ключ привязан к одному пользователю

    with SessionLocal() as db:
        month = datetime.utcnow().strftime("%Y-%m")
        quota = (
            db.query(PhotoQuota)
            .filter_by(user_id=user_id, month_year=month)
            .first()
        )
        if not quota:
            quota = PhotoQuota(user_id=user_id, used_count=0, month_year=month)
            db.add(quota)
            db.commit()
            db.refresh(quota)

        if quota.used_count >= FREE_MONTHLY_LIMIT:
            raise HTTPException(status_code=429, detail="LIMIT_EXCEEDED")

        # Определяем формат (multipart vs json)
        if image:
            if prompt_id not in (None, "v1"):
                err = ErrorResponse(
                    code="BAD_REQUEST",
                    message="prompt_id must be 'v1'",
                )
                return JSONResponse(
                    status_code=400,
                    content=err.model_dump(),
                )
            contents = await image.read()
            if len(contents) > 2 * 1024 * 1024:
                err = ErrorResponse(
                    code="BAD_REQUEST",
                    message="image too large",
                )
                return JSONResponse(
                    status_code=400,
                    content=err.model_dump(),
                )
            key = await run_in_threadpool(upload_photo, user_id, contents)
            result = call_gpt_vision_stub(key)
            crop = result.get("crop", "")
            disease = result.get("disease", "")
            conf = result.get("confidence", 0.0)
            file_id = key
        else:
            try:
                json_data = await request.json()
            except Exception:
                err = ErrorResponse(
                    code="BAD_REQUEST",
                    message="invalid JSON",
                )
                return JSONResponse(
                    status_code=400,
                    content=err.model_dump(),
                )
            try:
                body = DiagnoseRequestBase64(**json_data)
            except ValidationError:
                err = ErrorResponse(
                    code="BAD_REQUEST",
                    message="prompt_id must be 'v1'",
                )
                return JSONResponse(
                    status_code=400,
                    content=err.model_dump(),
                )
            try:
                contents = base64.b64decode(body.image_base64, validate=True)
            except binascii.Error:
                err = ErrorResponse(
                    code="BAD_REQUEST",
                    message="invalid base64",
                )
                return JSONResponse(
                    status_code=400,
                    content=err.model_dump(),
                )
            if len(contents) > 2 * 1024 * 1024:
                err = ErrorResponse(
                    code="BAD_REQUEST",
                    message="image too large",
                )
                return JSONResponse(
                    status_code=400,
                    content=err.model_dump(),
                )
            key = await run_in_threadpool(upload_photo, user_id, contents)
            result = call_gpt_vision_stub(key)
            crop = result.get("crop", "")
            disease = result.get("disease", "")
            conf = result.get("confidence", 0.0)
            file_id = key

        photo = Photo(
            user_id=user_id,
            file_id=file_id,
            crop=crop,
            disease=disease,
            confidence=conf,
            status="ok",
        )
        db.add(photo)
        quota.used_count += 1
        db.commit()

    proto = find_protocol(crop, disease)
    if proto:
        proto_resp = ProtocolResponse(
            id=proto.id,
            product=proto.product,
            dosage_value=float(proto.dosage_value or 0),
            dosage_unit=proto.dosage_unit,
            phi=proto.phi,
        )
        status = None
    else:
        proto_resp = None
        status = "Бета" if crop and disease else "Обратитесь к эксперту"

    return DiagnoseResponse(
        crop=crop,
        disease=disease,
        confidence=conf,
        protocol=proto_resp,
        protocol_status=status,
    )


@app.get(
    "/v1/photos",
    response_model=ListPhotosResponse,
    responses={401: {"model": ErrorResponse}},
)
async def list_photos(
    limit: int = 10,
    cursor: str | None = None,
    x_api_key: str = Header(..., alias="X-API-Key"),
    x_api_ver: str = Header(..., alias="X-API-Ver"),
):
    await verify_headers(x_api_key, x_api_ver)

    user_id = 1
    if limit <= 0:
        return ListPhotosResponse(items=[], next_cursor=None)

    with SessionLocal() as db:
        q = (
            db.query(Photo)
            .filter(Photo.user_id == user_id, Photo.deleted.is_(False))
            .order_by(Photo.id.desc())
        )
        if cursor:
            try:
                last_id = int(cursor)
                q = q.filter(Photo.id < last_id)
            except ValueError:
                raise HTTPException(status_code=400, detail="BAD_REQUEST")

        limit = min(limit, 50)
        rows = q.limit(limit).all()
        items = [
            PhotoItem(
                id=r.id,
                ts=r.ts,
                crop=r.crop or "",
                disease=r.disease or "",
                confidence=float(r.confidence or 0),
            )
            for r in rows
        ]
        next_cursor = str(rows[-1].id) if len(rows) == limit else None

    return ListPhotosResponse(items=items, next_cursor=next_cursor)


@app.get(
    "/v1/limits",
    response_model=LimitsResponse,
    responses={401: {"model": ErrorResponse}},
)
async def get_limits(
    x_api_key: str = Header(..., alias="X-API-Key"),
    x_api_ver: str = Header(..., alias="X-API-Ver"),
):
    await verify_headers(x_api_key, x_api_ver)
    user_id = 1
    with SessionLocal() as db:
        month = datetime.utcnow().strftime("%Y-%m")
        quota = (
            db.query(PhotoQuota)
            .filter_by(user_id=user_id, month_year=month)
            .first()
        )
        used = quota.used_count if quota else 0
    return LimitsResponse(
        limit_monthly_free=FREE_MONTHLY_LIMIT,
        used_this_month=used,
    )


@app.post(
    "/v1/payments/sbp/webhook",
    status_code=200,
    responses={401: {"model": ErrorResponse}, 400: {"model": ErrorResponse}},
)
async def payments_webhook(
    request: Request,
    x_api_ver: str = Header(..., alias="X-API-Ver"),
    x_sign: str = Header(..., alias="X-Sign"),
):
    await verify_version(x_api_ver)
    data, _, provided_sign = await verify_hmac(request, x_sign)
    try:
        body = PaymentWebhook(**data, signature=provided_sign)
    except ValidationError:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")

    with SessionLocal() as db:
        payment = Payment(
            user_id=1,
            amount=body.amount,
            source="sbp",
            status=body.status,
        )
        db.add(payment)
        db.commit()
    return {}


@app.post(
    "/v1/partner/orders",
    status_code=202,
    responses={401: {"model": ErrorResponse}, 400: {"model": ErrorResponse}},
)
async def partner_orders(
    request: Request,
    x_api_ver: str = Header(..., alias="X-API-Ver"),
    x_sign: str = Header(..., alias="X-Sign"),
):
    await verify_version(x_api_ver)
    data, sign, provided_sign = await verify_hmac(request, x_sign)
    try:
        body = PartnerOrderRequest(**data, signature=provided_sign)
    except ValidationError:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")

    with SessionLocal() as db:
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
    return JSONResponse(status_code=202, content={"status": "queued"})
