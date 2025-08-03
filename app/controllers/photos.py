import asyncio
import base64
import binascii
import json
import logging
import sqlite3
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError, field_validator
from sqlalchemy import text

from app import db as db_module
from app.config import Settings
from app.dependencies import ErrorResponse, require_api_headers
from app.models import Event, Photo
from app.services.gpt import call_gpt_vision_stub
from app.services.protocols import find_protocol
from app.services.storage import get_public_url, upload_photo

settings = Settings()
logger = logging.getLogger(__name__)

OPTIONAL_FILE = File(None)
FREE_MONTHLY_LIMIT = settings.free_monthly_limit
PAYWALL_ENABLED = settings.paywall_enabled

router = APIRouter()


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


@router.post(
    "/ai/diagnose",
    response_model=DiagnoseResponse,
    responses={400: {"model": ErrorResponse}, 429: {"model": ErrorResponse}, 502: {"model": ErrorResponse}},
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

        key = await upload_photo(user_id, contents)
        file_id = key
        try:
            result = call_gpt_vision_stub(key)
            crop = result.get("crop", "")
            disease = result.get("disease", "")
            conf = result.get("confidence", 0.0)
            status = "ok"
        except (TimeoutError, ValueError, json.JSONDecodeError):
            logger.exception("GPT error")
            crop = ""
            disease = ""
            conf = 0.0
            status = "pending"
    else:
        try:
            json_data = await request.json()
        except (json.JSONDecodeError, ValueError, RuntimeError):
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

        key = await upload_photo(user_id, contents)
        file_id = key
        try:
            result = call_gpt_vision_stub(key)
            crop = result.get("crop", "")
            disease = result.get("disease", "")
            conf = result.get("confidence", 0.0)
            status = "ok"
        except (TimeoutError, ValueError, json.JSONDecodeError):
            logger.exception("GPT error")
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
        return JSONResponse(status_code=202, content={"id": photo_id, "status": "pending"})

    proto = await asyncio.to_thread(find_protocol, crop, disease)
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
    "/photos",
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
    "/photos/history",
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
    "/limits",
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
                    text("SELECT used FROM photo_usage WHERE user_id=:uid AND month=:month"),
                    {"uid": user_id, "month": month_key},
                ).scalar()
                or 0
            )

    used = await asyncio.to_thread(_db_call)
    return LimitsResponse(limit_monthly_free=FREE_MONTHLY_LIMIT, used_this_month=used)


@router.get(
    "/photos/{photo_id}",
    response_model=PhotoStatusResponse,
    responses={401: {"model": ErrorResponse}, 404: {"description": "Not found"}},
)
async def photo_status(photo_id: int, user_id: int = Depends(require_api_headers)):
    def _db_call() -> dict:
        with db_module.SessionLocal() as db:
            photo = db.query(Photo).filter_by(id=photo_id, user_id=user_id, deleted=False).first()
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
        p = await asyncio.to_thread(find_protocol, photo_data["crop"], photo_data["disease"])
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
