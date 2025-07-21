from fastapi import FastAPI, Header, UploadFile, File, Request, HTTPException, Form
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator, ValidationError
from typing import Optional

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
        return DiagnoseResponse(crop="apple", disease="powdery_mildew", confidence=0.92)
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
        # заглушка: обработка base64
        return DiagnoseResponse(crop="apple", disease="scab", confidence=0.88)
