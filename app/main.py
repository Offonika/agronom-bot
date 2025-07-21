from fastapi import FastAPI, Header, UploadFile, File, Request, HTTPException, Form
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator, ValidationError
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

    @field_validator("prompt_id")
    @classmethod
    def validate_prompt_id(cls, v: str) -> str:
        if v != "v1":
            raise ValueError("prompt_id must be 'v1'")
        return v

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
    image: Optional[UploadFile] = File(None),
    prompt_id: Optional[str] = Form(None)
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
        if prompt_id != "v1":
            err = ErrorResponse(code="BAD_REQUEST", message="prompt_id must be 'v1'")
            return JSONResponse(status_code=400, content=err.model_dump())
        contents = await image.read()
        if len(contents) > 2 * 1024 * 1024:

            err = ErrorResponse(code="BAD_REQUEST", message="image too large")
            return JSONResponse(status_code=400, content=err.model_dump())

        # заглушка: обрабатываем изображение
        crop, disease, conf = "apple", "powdery_mildew", 0.92
    else:
        try:
            json_data = await request.json()
        except Exception:

            err = ErrorResponse(code="BAD_REQUEST", message="invalid JSON")
            return JSONResponse(status_code=400, content=err.model_dump())
        try:
            body = DiagnoseRequestBase64(**json_data)
        except ValidationError:
            err = ErrorResponse(code="BAD_REQUEST", message="prompt_id must be 'v1'")
            return JSONResponse(status_code=400, content=err.model_dump())
