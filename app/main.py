from fastapi import FastAPI, Header, UploadFile, File, Request, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional
from datetime import datetime

from app.db import SessionLocal
from app.models import Photo, PhotoQuota



app = FastAPI(
    title="Agronom Bot Internal API",
    version="1.2.1"
)

HMAC_SECRET = os.environ.get("HMAC_SECRET", "test-hmac-secret")

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


class LimitsResponse(BaseModel):
    limit_monthly_free: int
    used_this_month: int


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
        raise HTTPException(status_code=401, detail="Invalid API key")

async def verify_version(x_api_ver: str = Header(..., alias="X-API-Ver")):
    if x_api_ver != "v1":
        raise HTTPException(status_code=400, detail="Invalid API version")

HMAC_SECRET = "hmac-secret"

def verify_hmac(body: bytes, provided: str) -> str:
    expected = hmac.new(HMAC_SECRET.encode(), body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, provided):
        raise HTTPException(status_code=401, detail="UNAUTHORIZED")
    return expected

def compute_signature(secret: str, body: bytes) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

async def verify_hmac(request: Request, x_sign: str):
    raw_body = await request.body()
    calculated = compute_signature(HMAC_SECRET, raw_body)
    if calculated != x_sign:
        raise HTTPException(status_code=401, detail="UNAUTHORIZED")
    try:
        data = json.loads(raw_body)
    except Exception:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")
    if data.get("signature") != calculated:
        raise HTTPException(status_code=401, detail="UNAUTHORIZED")
    return data, calculated

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

    user_id = 1  # в MVP ключ привязан к одному пользователю

    db = SessionLocal()
    month = datetime.utcnow().strftime("%Y-%m")
    quota = db.query(PhotoQuota).filter_by(user_id=user_id, month_year=month).first()
    if not quota:
        quota = PhotoQuota(user_id=user_id, used_count=0, month_year=month)
        db.add(quota)
        db.commit()
        db.refresh(quota)

    if quota.used_count >= 5:
        db.close()
        raise HTTPException(status_code=429, detail="LIMIT_EXCEEDED")

    # Определяем формат (multipart vs json)
    if image:
        contents = await image.read()
        if len(contents) > 2 * 1024 * 1024:

            db.close()
            raise HTTPException(status_code=400, detail="BAD_REQUEST: image too large")

        # заглушка: обрабатываем изображение
        crop, disease, conf = "apple", "powdery_mildew", 0.92
    else:
        try:
            json_data = await request.json()
            body = DiagnoseRequestBase64(**json_data)
        except Exception:

            db.close()
            raise HTTPException(status_code=400, detail="BAD_REQUEST: invalid JSON")
        crop, disease, conf = "apple", "scab", 0.88

    photo = Photo(
        user_id=user_id,
        file_id="placeholder",
        crop=crop,
        disease=disease,
        confidence=conf,
        status="ok",
        ts=datetime.utcnow(),
        deleted=False,
    )
    db.add(photo)
    quota.used_count += 1
    db.commit()
    db.refresh(photo)
    db.close()

    return DiagnoseResponse(crop=crop, disease=disease, confidence=conf)


@app.get(
    "/v1/limits",
    response_model=LimitsResponse,
    responses={
        401: {"model": ErrorResponse}
    }
)
async def get_limits(
    x_api_key: str = Header(..., alias="X-API-Key"),
    x_api_ver: str = Header(..., alias="X-API-Ver"),
):
    await verify_headers(x_api_key, x_api_ver)

    user_id = 1
    db = SessionLocal()
    month = datetime.utcnow().strftime("%Y-%m")
    quota = db.query(PhotoQuota).filter_by(user_id=user_id, month_year=month).first()
    used = quota.used_count if quota else 0
    db.close()
    return LimitsResponse(limit_monthly_free=5, used_this_month=used)

=======
            raise HTTPException(status_code=400, detail="Invalid JSON body")
        # заглушка: обработка base64
        return DiagnoseResponse(crop="apple", disease="scab", confidence=0.88)



# -------------------------------

@app.post(
    "/v1/payments/sbp/webhook",

    responses={
        200: {"description": "Accepted"},
        401: {"model": ErrorResponse},
        400: {"model": ErrorResponse},
    },
)
async def payments_webhook(
    request: Request,
    x_api_key: str = Header(..., alias="X-API-Key"),
    x_api_ver: str = Header(..., alias="X-API-Ver"),
    x_sign: str = Header(..., alias="X-Sign"),
):
    await verify_headers(x_api_key, x_api_ver)
    data, _ = await verify_hmac(request, x_sign)
    PaymentWebhook(**data)  # validate fields
    return JSONResponse(status_code=200, content={"status": "accepted"})


# -------------------------------
# Partner Order Webhook


