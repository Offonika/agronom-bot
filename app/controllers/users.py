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
from app.models import Event, Payment, Photo, PhotoUsage, User, ErrorCode

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


BATCH_SIZE = 100


class _StreamingBuffer(io.RawIOBase):
    """Write-only buffer for incremental ZIP streaming."""

    def __init__(self) -> None:
        self._buffer = bytearray()
        self._pos = 0

    def writable(self) -> bool:  # pragma: no cover - required by IOBase
        return True

    def write(self, b: bytes) -> int:  # pragma: no cover - I/O bound
        self._buffer.extend(b)
        self._pos += len(b)
        return len(b)

    def tell(self) -> int:  # pragma: no cover - used by zipfile
        return self._pos

    def read(self) -> bytes:
        data = bytes(self._buffer)
        self._buffer.clear()
        return data


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

    def _stream() -> bytes:
        stream = _StreamingBuffer()
        with db_module.SessionLocal() as db:
            with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as zf:
                with zf.open("data.json", "w") as data_file:
                    data_file.write(b"{\"photos\":[")
                    first = True
                    for photo in (
                        db.query(Photo)
                        .filter_by(user_id=user_id)
                        .yield_per(BATCH_SIZE)
                    ):
                        if not first:
                            data_file.write(b",")
                        payload = PhotoExport.model_validate(
                            photo, from_attributes=True
                        ).model_dump()
                        data_file.write(json.dumps(payload, default=str).encode())
                        chunk = stream.read()
                        if chunk:
                            yield chunk
                        first = False
                    data_file.write(b"],\"payments\":[")
                    first = True
                    for payment in (
                        db.query(Payment)
                        .filter_by(user_id=user_id)
                        .yield_per(BATCH_SIZE)
                    ):
                        if not first:
                            data_file.write(b",")
                        payload = PaymentExport.model_validate(
                            payment, from_attributes=True
                        ).model_dump()
                        data_file.write(json.dumps(payload, default=str).encode())
                        chunk = stream.read()
                        if chunk:
                            yield chunk
                        first = False
                    data_file.write(b"],\"events\":[")
                    first = True
                    for event in (
                        db.query(Event)
                        .filter_by(user_id=user_id)
                        .yield_per(BATCH_SIZE)
                    ):
                        if not first:
                            data_file.write(b",")
                        payload = EventExport.model_validate(
                            event, from_attributes=True
                        ).model_dump()
                        data_file.write(json.dumps(payload, default=str).encode())
                        chunk = stream.read()
                        if chunk:
                            yield chunk
                        first = False
                    data_file.write(b"]}")
                chunk = stream.read()
                if chunk:
                    yield chunk
        chunk = stream.read()
        if chunk:
            yield chunk

    headers = {
        "Content-Disposition": f'attachment; filename="user_{user_id}_export.zip"'
    }
    return StreamingResponse(_stream(), media_type="application/zip", headers=headers)


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

    raw_user_id = payload.get("user_id")
    if raw_user_id is None:
        err_resp = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Missing user_id",
        )
        raise HTTPException(status_code=400, detail=err_resp.model_dump())

    try:
        user_id = int(raw_user_id)
    except (TypeError, ValueError):
        err_resp = ErrorResponse(
            code=ErrorCode.BAD_REQUEST,
            message="user_id must be an integer",
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
            db.query(PhotoUsage).filter_by(user_id=user_id).delete()
            db.query(User).filter_by(id=user_id).delete()
            db.commit()

    await asyncio.to_thread(_db_delete)
    return {"status": "deleted"}
