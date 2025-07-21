from fastapi import FastAPI, Header, UploadFile, File, Request, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime
import hashlib
import hmac
import json

app = FastAPI(
    title="Agronom Bot Internal API",
    version="1.2.1"
)

# -------------------------------
# Pydantic Schemas (по OpenAPI)
# -------------------------------

class DiagnoseRequestBase64(BaseModel):
    image_base64: str
    prompt_id: str

class DiagnoseResponse(BaseModel):
    crop: str
    disease: str
    confidence: float

class ErrorResponse(BaseModel):
    code: str
    message: str

class PhotoItem(DiagnoseResponse):
    id: int
    ts: datetime

class ListPhotosResponse(BaseModel):
    items: List[PhotoItem]
    next_cursor: Optional[str] | None = None

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
    # Здесь можно добавить валидацию ключа
    if x_api_key != "test-api-key":
        raise HTTPException(status_code=401, detail="UNAUTHORIZED")

async def verify_version(x_api_ver: str = Header(..., alias="X-API-Ver")):
    if x_api_ver != "v1":
        raise HTTPException(status_code=400, detail="Invalid API version")

HMAC_SECRET = "hmac-secret"

def verify_hmac(body: bytes, provided: str) -> str:
    expected = hmac.new(HMAC_SECRET.encode(), body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, provided):
        raise HTTPException(status_code=401, detail="UNAUTHORIZED")
    return expected

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
    image: Optional[UploadFile] = File(None)
):
    await verify_headers(x_api_key, x_api_ver)

    # Определяем формат (multipart vs json)
    if image:
        contents = await image.read()
        if len(contents) > 2 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="BAD_REQUEST: image too large")
        # заглушка: обрабатываем изображение
        return DiagnoseResponse(crop="apple", disease="powdery_mildew", confidence=0.92)
    else:
        try:
            json_data = await request.json()
            body = DiagnoseRequestBase64(**json_data)
        except Exception:
            raise HTTPException(status_code=400, detail="BAD_REQUEST: invalid JSON")
        # заглушка: обработка base64
        return DiagnoseResponse(crop="apple", disease="scab", confidence=0.88)

# ---------------------------------
# In-memory stubs for demo purpose
# ---------------------------------

_PHOTOS: List[PhotoItem] = [
    PhotoItem(id=1, ts=datetime.utcnow(), crop="apple", disease="scab", confidence=0.9),
    PhotoItem(id=2, ts=datetime.utcnow(), crop="tomato", disease="blight", confidence=0.85),
]

# -------------------------------
# Photos history
# -------------------------------

@app.get(
    "/v1/photos",
    response_model=ListPhotosResponse,
    responses={401: {"model": ErrorResponse}},
)
async def list_photos(
    limit: int = 10,
    cursor: Optional[str] = None,
    x_api_key: str = Header(..., alias="X-API-Key"),
    x_api_ver: str = Header(..., alias="X-API-Ver"),
):
    await verify_headers(x_api_key, x_api_ver)

    start = int(cursor) if cursor else 0
    end = start + min(limit, 50)
    items = _PHOTOS[start:end]
    next_cursor = str(end) if end < len(_PHOTOS) else None
    return ListPhotosResponse(items=items, next_cursor=next_cursor)

# -------------------------------
# Limits endpoint
# -------------------------------

@app.get(
    "/v1/limits",
    responses={401: {"model": ErrorResponse}},
)
async def get_limits(
    x_api_key: str = Header(..., alias="X-API-Key"),
    x_api_ver: str = Header(..., alias="X-API-Ver"),
):
    await verify_headers(x_api_key, x_api_ver)
    used = len(_PHOTOS)
    return {"limit_monthly_free": 5, "used_this_month": used}

# -------------------------------
# SBP webhook
# -------------------------------

@app.post(
    "/v1/payments/sbp/webhook",
    status_code=200,
)
async def sbp_webhook(
    request: Request,
    x_sign: str = Header(..., alias="X-Sign"),
    x_api_ver: str = Header(..., alias="X-API-Ver"),
):
    await verify_version(x_api_ver)
    body = await request.body()
    verify_hmac(body, x_sign)
    try:
        payload = PaymentWebhook.model_validate_json(body)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")
    if payload.signature != verify_hmac(body, x_sign):
        raise HTTPException(status_code=401, detail="UNAUTHORIZED")
    # заглушка: сохранить платёж
    return JSONResponse(status_code=200, content={"status": "accepted"})

# -------------------------------
# Partner order callback
# -------------------------------

@app.post(
    "/v1/partner/orders",
    status_code=202,
    responses={
        400: {"model": ErrorResponse},
        401: {"model": ErrorResponse},
    },
)
async def partner_order(
    request: Request,
    x_sign: str = Header(..., alias="X-Sign"),
    x_api_ver: str = Header(..., alias="X-API-Ver"),
):
    await verify_version(x_api_ver)
    body = await request.body()
    verify_hmac(body, x_sign)
    try:
        data = json.loads(body.decode())
        order = PartnerOrderRequest(**data)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")
    expected = verify_hmac(body, x_sign)
    if order.signature != expected:
        raise HTTPException(status_code=401, detail="UNAUTHORIZED")
    # заглушка: сохранить заказ
    return JSONResponse(status_code=202, content={"status": "queued"})
