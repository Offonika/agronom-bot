import asyncio  # required for async file operations
import hmac  # required for HMAC signature checks
import io
import json
import zipfile
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app import db as db_module
from app.config import Settings
from app.dependencies import ErrorResponse, compute_signature, rate_limit
from app.models import Event, Payment, Photo, User, ErrorCode

settings = Settings()
HMAC_SECRET = settings.hmac_secret

router = APIRouter()


class PhotoExport(BaseModel):
    file_id: str
    file_unique_id: str | None = None
    width: int | None = None
    height: int | None = None
    file_size: int | None = None
    crop: str | None = None
    disease: str | None = None
    confidence: float | None = None
    roi: float | None = None
    status: str
    error_code: ErrorCode | None = None
    ts: datetime


class PaymentExport(BaseModel):
    amount: int | None = None
    currency: str | None = None
    provider: str | None = None
    external_id: str | None = None
    prolong_months: int | None = None
    autopay: bool
    status: str
    created_at: datetime
    updated_at: datetime


class EventExport(BaseModel):
    event: str
    ts: datetime


def serialize(items: list, schema: type[BaseModel]) -> list[dict]:
    return [
        schema.model_validate(obj, from_attributes=True).model_dump()
        for obj in items
    ]


@router.get(
    "/users/{user_id}/export",
    responses={401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}},
)
async def export_user(
    user_id: int,
    x_sign: str = Header(..., alias="X-Sign"),
    auth_user: int = Depends(rate_limit),
):
    payload = {"user_id": user_id}
    expected_sign = compute_signature(HMAC_SECRET, payload)
    if not hmac.compare_digest(expected_sign, x_sign):
        err = ErrorResponse(
            code=ErrorCode.UNAUTHORIZED, message="Invalid signature"
        )
        raise HTTPException(status_code=401, detail=err.model_dump())
    if auth_user != user_id:
        err = ErrorResponse(
            code=ErrorCode.FORBIDDEN, message="Cannot access other user"
        )
        raise HTTPException(status_code=403, detail=err.model_dump())

    def _db_call() -> dict:
        with db_module.SessionLocal() as db:
            photos = db.query(Photo).filter_by(user_id=user_id).all()
            payments = db.query(Payment).filter_by(user_id=user_id).all()
            events = db.query(Event).filter_by(user_id=user_id).all()

            return {
                "photos": serialize(photos, PhotoExport),
                "payments": serialize(payments, PaymentExport),
                "events": serialize(events, EventExport),
            }

    data = await asyncio.to_thread(_db_call)

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("data.json", json.dumps(data, default=str))
    buffer.seek(0)

    headers = {
        "Content-Disposition": f'attachment; filename="user_{user_id}_export.zip"'
    }
    return StreamingResponse(buffer, media_type="application/zip", headers=headers)


@router.post(
    "/dsr/delete_user",
    responses={401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}},
)
async def delete_user(
    request: Request,
    x_sign: str = Header(..., alias="X-Sign"),
    auth_user: int = Depends(rate_limit),
):
    # Only JSON decoding errors are transformed into HTTP 400 responses.
    try:
        payload = await request.json()
    except json.JSONDecodeError as err:
        raise HTTPException(
            status_code=400,
            detail=ErrorResponse(
                code=ErrorCode.BAD_REQUEST, message="Invalid JSON"
            ).model_dump(),
        ) from err

    user_id = payload.get("user_id")
    if user_id is None:
        err_resp = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Missing user_id"
        )
        raise HTTPException(status_code=400, detail=err_resp.model_dump())

    expected_sign = compute_signature(HMAC_SECRET, {"user_id": user_id})
    if not hmac.compare_digest(expected_sign, x_sign):
        err = ErrorResponse(
            code=ErrorCode.UNAUTHORIZED, message="Invalid signature"
        )
        raise HTTPException(status_code=401, detail=err.model_dump())

    if user_id != auth_user:
        err = ErrorResponse(
            code=ErrorCode.FORBIDDEN, message="Cannot delete other user"
        )
        raise HTTPException(status_code=403, detail=err.model_dump())

    def _db_delete() -> None:
        with db_module.SessionLocal() as db:
            db.query(Photo).filter_by(user_id=user_id).delete()
            db.query(Payment).filter_by(user_id=user_id).delete()
            db.query(Event).filter_by(user_id=user_id).delete()
            db.query(User).filter_by(id=user_id).delete()
            db.commit()

    await asyncio.to_thread(_db_delete)
    return {"status": "deleted"}
