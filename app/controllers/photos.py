from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import time
from datetime import datetime, timezone
try:  # pragma: no cover - Python < 3.9 fallback
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    from backports.zoneinfo import ZoneInfo
from typing import Any, List

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError, field_validator
from sqlalchemy import and_, or_, text

from app import db as db_module
from app.config import Settings
from app.dependencies import ErrorResponse, rate_limit
from app.metrics import (
    diag_latency_seconds,
    diag_requests_total,
    gpt_timeout_total,
    quota_reject_total,
    queue_size_pending,
    roi_calc_seconds,
)
from app.models import Event, Photo, ErrorCode
from app.services.gpt import call_gpt_vision
from app.services.protocols import async_find_protocol
from app.services.storage import get_public_url, upload_photo
from app.services.roi import calculate_roi

settings = Settings()
logger = logging.getLogger(__name__)

OPTIONAL_FILE = File(None)
FREE_MONTHLY_LIMIT = settings.free_monthly_limit
PAYWALL_ENABLED = settings.paywall_enabled

router = APIRouter()


async def _enforce_paywall(user_id: int) -> JSONResponse | None:
    """Increment usage counter and enforce paywall limits."""

    def _db() -> tuple[int, datetime | None]:
        with db_module.SessionLocal() as db:
            moscow_tz = ZoneInfo("Europe/Moscow")
            month_key = datetime.now(moscow_tz).strftime("%Y-%m")
            params = {"uid": user_id, "month": month_key}
            stmt = text(
                "INSERT INTO photo_usage (user_id, month, used, updated_at) "
                "VALUES (:uid, :month, 1, CURRENT_TIMESTAMP) "
                "ON CONFLICT(user_id, month) DO UPDATE "
                "SET used = photo_usage.used + 1, "
                "updated_at = CURRENT_TIMESTAMP"
            )
            db.execute(stmt, params)
            db.commit()
            used = db.execute(
                text(
                    "SELECT used FROM photo_usage WHERE user_id=:uid AND month=:month"
                ),
                params,
            ).scalar_one()

            pro = db.execute(
                text("SELECT pro_expires_at FROM users WHERE id=:uid"),
                {"uid": user_id},
            ).scalar()
            if isinstance(pro, str):
                pro = datetime.fromisoformat(pro)
            if pro and getattr(pro, "tzinfo", None) is None:
                pro = pro.replace(tzinfo=timezone.utc)
            return used, pro

    used, pro = await asyncio.to_thread(_db)
    now_utc = datetime.now(timezone.utc)
    if PAYWALL_ENABLED and used > FREE_MONTHLY_LIMIT and (not pro or pro < now_utc):
        if pro and pro < now_utc:
            def _log() -> None:
                with db_module.SessionLocal() as db:
                    db.add(Event(user_id=user_id, event="pro_expired"))
                    db.commit()

            await asyncio.to_thread(_log)
        quota_reject_total.inc()
        return JSONResponse(
            status_code=402,
            content={"error": "limit_reached", "limit": FREE_MONTHLY_LIMIT},
        )
    return None


class _ProcessImageError(Exception):
    def __init__(self, response: JSONResponse):
        self.response = response


async def _process_image(
    contents: bytes, user_id: int, crop_hint: str | None = None
) -> dict[str, Any]:
    if len(contents) > 2 * 1024 * 1024:
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="image too large"
        )
        raise _ProcessImageError(
            JSONResponse(status_code=413, content=err.model_dump())
        )

    if resp := await _enforce_paywall(user_id):
        raise _ProcessImageError(resp)

    key = await upload_photo(user_id, contents)
    try:
        inference = await asyncio.to_thread(
            call_gpt_vision, key, contents, crop_hint=crop_hint
        )
        crop = inference.get("crop", "")
        disease = inference.get("disease", "")
        conf = inference.get("confidence", 0.0)
    except TimeoutError as exc:
        gpt_timeout_total.inc()
        logger.exception("GPT timeout")
        err = ErrorResponse(
            code=ErrorCode.GPT_TIMEOUT, message="GPT timeout"
        )
        raise _ProcessImageError(
            JSONResponse(status_code=502, content=err.model_dump())
        ) from exc
    except (ValueError, json.JSONDecodeError) as exc:
        logger.exception("Invalid GPT response")
        err = ErrorResponse(
            code=ErrorCode.SERVICE_UNAVAILABLE,
            message="Invalid GPT response",
        )
        raise _ProcessImageError(
            JSONResponse(status_code=502, content=err.model_dump())
        ) from exc
    except Exception as exc:
        logger.exception("GPT error")
        err = ErrorResponse(
            code=ErrorCode.SERVICE_UNAVAILABLE, message="GPT error"
        )
        raise _ProcessImageError(
            JSONResponse(status_code=502, content=err.model_dump())
        ) from exc

    roi_start = time.perf_counter()
    roi = calculate_roi(crop, disease) if crop and disease else 0.0
    roi_calc_seconds.observe(time.perf_counter() - roi_start)

    return {
        "file_id": key,
        "crop": crop,
        "crop_ru": inference.get("crop_ru"),
        "disease": disease,
        "confidence": conf,
        "roi": roi,
        "disease_name_ru": inference.get("disease_name_ru"),
        "reasoning": inference.get("reasoning"),
        "treatment_plan": inference.get("treatment_plan"),
        "next_steps": inference.get("next_steps"),
        "need_reshoot": inference.get("need_reshoot"),
        "reshoot_tips": inference.get("reshoot_tips"),
        "assistant_ru": inference.get("assistant_ru"),
        "assistant_followups_ru": inference.get("assistant_followups_ru"),
        "need_clarify_crop": inference.get("need_clarify_crop"),
        "clarify_crop_variants": inference.get("clarify_crop_variants"),
    }


class DiagnoseRequestBase64(BaseModel):
    image_base64: str
    prompt_id: str
    crop_hint: str | None = None

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
    category: str | None = None
    status: str | None = None
    waiting_days: int | None = None


class TreatmentPlan(BaseModel):
    product: str | None = None
    substance: str | None = None
    dosage: str | None = None
    dosage_value: float | None = None
    dosage_unit: str | None = None
    method: str | None = None
    phi: str | None = None
    phi_days: int | None = None
    safety: str | None = None
    safety_note: str | None = None


class NextSteps(BaseModel):
    reminder: str
    green_window: str
    cta: str | None = None


class DiagnoseResponse(BaseModel):
    crop: str
    crop_ru: str | None = None
    disease: str
    disease_name_ru: str | None = None
    confidence: float
    roi: float
    reasoning: list[str] | None = None
    treatment_plan: TreatmentPlan | None = None
    next_steps: NextSteps | None = None
    protocol: ProtocolResponse | None = None
    protocol_status: str | None = None
    need_reshoot: bool | None = None
    reshoot_tips: list[str] | None = None
    assistant_ru: str | None = None
    assistant_followups_ru: list[str] | None = None
    need_clarify_crop: bool | None = None
    clarify_crop_variants: list[str] | None = None
    plan_missing_reason: str | None = None


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
    responses={
        400: {"model": ErrorResponse},
        413: {"model": ErrorResponse},
        429: {"model": ErrorResponse},
        502: {"model": ErrorResponse},
    },
)
async def diagnose(
    request: Request,
    user_id: int = Depends(rate_limit),
    image: UploadFile | None = OPTIONAL_FILE,
    prompt_id: str | None = Form(None),
    crop_hint: str | None = Form(None),
):
    limit = 2 * 1024 * 1024
    hint_value: str | None = None
    if image:
        if prompt_id not in (None, "v1"):
            err = ErrorResponse(
                code=ErrorCode.BAD_REQUEST, message="prompt_id must be 'v1'"
            )
            return JSONResponse(status_code=400, content=err.model_dump())
        if getattr(image, "size", None) and image.size > limit:
            err = ErrorResponse(
                code=ErrorCode.BAD_REQUEST, message="image too large"
            )
            return JSONResponse(status_code=413, content=err.model_dump())
        contents = await image.read(limit + 1)
        if len(contents) > limit:
            err = ErrorResponse(
                code=ErrorCode.BAD_REQUEST, message="image too large"
            )
            return JSONResponse(status_code=413, content=err.model_dump())
        hint_value = (crop_hint or "").strip() or None
    else:
        try:
            json_data = await request.json()
        except (json.JSONDecodeError, ValueError, RuntimeError):
            err = ErrorResponse(
                code=ErrorCode.BAD_REQUEST, message="invalid JSON"
            )
            return JSONResponse(status_code=400, content=err.model_dump())
        try:
            body = DiagnoseRequestBase64(**json_data)
        except ValidationError as err:
            message = "; ".join(e.get("msg", "") for e in err.errors())
            err = ErrorResponse(
                code=ErrorCode.BAD_REQUEST, message=message
            )
            return JSONResponse(status_code=400, content=err.model_dump())
        b64_limit = ((limit + 2) // 3) * 4
        if len(body.image_base64) > b64_limit:
            err = ErrorResponse(
                code=ErrorCode.BAD_REQUEST, message="image too large"
            )
            return JSONResponse(status_code=413, content=err.model_dump())
        try:
            contents = base64.b64decode(body.image_base64, validate=True)
        except binascii.Error:
            err = ErrorResponse(
                code=ErrorCode.BAD_REQUEST, message="invalid base64"
            )
            return JSONResponse(status_code=400, content=err.model_dump())
        if len(contents) > limit:
            err = ErrorResponse(
                code=ErrorCode.BAD_REQUEST, message="image too large"
            )
            return JSONResponse(status_code=413, content=err.model_dump())
        hint_value = (body.crop_hint or "").strip() or None
    diag_requests_total.inc()
    start_time = time.perf_counter()
    try:
        result = await _process_image(contents, user_id, crop_hint=hint_value)
        file_id = result["file_id"]
        crop = result.get("crop", "")
        disease = result.get("disease", "")
        conf = float(result.get("confidence", 0.0))
        roi = float(result.get("roi", 0.0))
    except _ProcessImageError as err:
        diag_latency_seconds.observe(time.perf_counter() - start_time)
        return err.response
    diag_latency_seconds.observe(time.perf_counter() - start_time)
    status = "ok" if crop and disease else "pending"

    def _save() -> int:
        with db_module.SessionLocal() as db:
            photo = Photo(
                user_id=user_id,
                file_id=file_id,
                crop=crop,
                disease=disease,
                confidence=conf,
                roi=roi,
                status=status,
            )
            db.add(photo)
            db.commit()
            return photo.id

    photo_id = await asyncio.to_thread(_save)
    if status != "ok":
        queue_size_pending.inc()
        return JSONResponse(status_code=202, content={"id": photo_id, "status": "pending"})

    proto = await async_find_protocol("main", crop, disease)
    if proto:
        proto_resp = ProtocolResponse(
            id=proto.id,
            product=proto.product,
            dosage_value=float(proto.dosage_value or 0),
            dosage_unit=proto.dosage_unit,
            phi=proto.phi,
            category=proto.category,
            status=proto.status,
            waiting_days=proto.waiting_days,
        )
        proto_status = None
    else:
        proto_resp = None
        proto_status = "Бета" if crop and disease else "Обратитесь к эксперту"

    plan_payload = result.get("treatment_plan") if status == "ok" else None
    treatment_plan = None
    if isinstance(plan_payload, dict):
        def _to_float_safe(val: Any) -> float | None:
            try:
                return float(val)
            except (TypeError, ValueError):
                return None

        def _to_int_safe(val: Any) -> int | None:
            try:
                return int(float(val))
            except (TypeError, ValueError):
                return None

        plan_data = {
            "product": str(plan_payload.get("product", "") or "").strip() or None,
            "substance": str(plan_payload.get("substance", "") or "").strip() or None,
            "dosage": str(plan_payload.get("dosage", "") or "").strip() or None,
            "dosage_value": _to_float_safe(plan_payload.get("dosage_value")),
            "dosage_unit": str(plan_payload.get("dosage_unit", "") or "").strip() or None,
            "method": str(plan_payload.get("method", "") or "").strip() or None,
            "phi": str(plan_payload.get("phi", "") or "").strip() or None,
            "phi_days": _to_int_safe(plan_payload.get("phi_days")),
            "safety": str(plan_payload.get("safety", "") or "").strip() or None,
            "safety_note": str(plan_payload.get("safety_note", "") or "").strip() or None,
        }
        if plan_data["safety_note"] is None and plan_data["safety"]:
            plan_data["safety_note"] = plan_data["safety"]
        if (
            plan_data["substance"]
            or plan_data["method"]
            or plan_data["phi_days"] is not None
        ):
            treatment_plan = TreatmentPlan(**plan_data)

    plan_missing_reason = None
    if status == "ok" and treatment_plan is None:
        plan_missing_reason = (
            "Модель не прислала даже минимальный план: попросите пользователя переснять "
            "фото по подсказкам или уточнить культуру."
        )

    next_payload = result.get("next_steps") if status == "ok" else None
    next_steps = None
    if isinstance(next_payload, dict):
        cta_value = str(next_payload.get("cta", "") or "").strip()
        next_data = {
            "reminder": str(next_payload.get("reminder", "") or "").strip(),
            "green_window": str(next_payload.get("green_window", "") or "").strip(),
            "cta": cta_value or None,
        }
        if any(next_data.values()):
            next_steps = NextSteps(**next_data)

    reasoning: list[str] | None = None
    if status == "ok":
        raw_reasoning = result.get("reasoning")
        if isinstance(raw_reasoning, list):
            cleaned = [str(item).strip() for item in raw_reasoning if str(item or "").strip()]
            reasoning = cleaned or None
        else:
            text_reasoning = str(raw_reasoning or "").strip()
            reasoning = [text_reasoning] if text_reasoning else None

    disease_name_ru = str(result.get("disease_name_ru") or "").strip() or None
    crop_ru = str(result.get("crop_ru") or "").strip() or None
    need_reshoot = bool(result.get("need_reshoot")) if status == "ok" else None
    reshoot_tips = None
    raw_tips = result.get("reshoot_tips")
    if isinstance(raw_tips, list):
        cleaned_tips = [str(item).strip() for item in raw_tips if str(item or "").strip()]
        reshoot_tips = cleaned_tips or None
    else:
        text_tip = str(raw_tips or "").strip()
        if text_tip:
            reshoot_tips = [text_tip]

    assistant_ru = str(result.get("assistant_ru") or "").strip() or None
    assistant_followups: list[str] | None = None
    raw_followups = result.get("assistant_followups_ru")
    if isinstance(raw_followups, list):
        cleaned_followups = [str(item).strip() for item in raw_followups if str(item or "").strip()]
        assistant_followups = cleaned_followups or None

    need_clarify_crop = bool(result.get("need_clarify_crop"))
    clarify_crop_variants: list[str] | None = None
    raw_variants = result.get("clarify_crop_variants")
    if isinstance(raw_variants, list):
        cleaned_variants = [str(item).strip() for item in raw_variants if str(item or "").strip()]
        clarify_crop_variants = cleaned_variants or None

    return DiagnoseResponse(
        crop=crop,
        crop_ru=crop_ru,
        disease=disease,
        disease_name_ru=disease_name_ru,
        confidence=conf,
        reasoning=reasoning,
        treatment_plan=treatment_plan,
        next_steps=next_steps,
        protocol=proto_resp,
        protocol_status=proto_status,
        need_reshoot=need_reshoot,
        reshoot_tips=reshoot_tips,
        assistant_ru=assistant_ru,
        assistant_followups_ru=assistant_followups,
        need_clarify_crop=need_clarify_crop if status == "ok" else None,
        clarify_crop_variants=clarify_crop_variants if need_clarify_crop else None,
        plan_missing_reason=plan_missing_reason,
        roi=roi,
    )


@router.get(
    "/photos",
    response_model=ListPhotosResponse,
    responses={401: {"model": ErrorResponse}},
)
async def list_photos(
    limit: int = 10,
    cursor: str | None = None,
    user_id: int = Depends(rate_limit),
):
    if limit <= 0:
        return ListPhotosResponse(items=[], next_cursor=None)

    def _db_call() -> tuple[list[PhotoItem], str | None]:
        with db_module.SessionLocal() as db:
            q = (
                db.query(Photo)
                .filter(Photo.user_id == user_id, Photo.deleted.is_(False))
                .order_by(Photo.ts.desc(), Photo.id.desc())
            )
            if cursor:
                try:
                    last_id_str, last_ts_str = cursor.split(":", 1)
                    last_id = int(last_id_str)
                    last_ts = datetime.fromtimestamp(int(last_ts_str), tz=timezone.utc)
                except (ValueError, TypeError) as err:
                    raise HTTPException(
                        status_code=400, detail=ErrorCode.BAD_REQUEST
                    ) from err
                q = q.filter(
                    or_(
                        Photo.ts < last_ts,
                        and_(Photo.ts == last_ts, Photo.id < last_id),
                    )
                )

            limit_local = min(limit, 50)
            rows = q.limit(limit_local + 1).all()
            items_rows = rows[:limit_local]
            items_local = [
                PhotoItem(
                    id=r.id,
                    ts=r.ts,
                    crop=r.crop or "",
                    disease=r.disease or "",
                    confidence=float(r.confidence or 0),
                    roi=float(r.roi or 0),
                )
                for r in items_rows
            ]
            next_cur = (
                f"{items_rows[-1].id}:{int(items_rows[-1].ts.replace(tzinfo=timezone.utc).timestamp())}"
                if len(rows) > limit_local
                else None
            )
            return items_local, next_cur

    items, next_cursor = await asyncio.to_thread(_db_call)
    return ListPhotosResponse(items=items, next_cursor=next_cursor)


@router.get(
    "/photos/history",
    response_model=List[PhotoHistoryItem],
    responses={401: {"model": ErrorResponse}},
)
async def list_photos_history(
    limit: int = 10,
    offset: int = 0,
    user_id: int = Depends(rate_limit),
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
async def get_limits(user_id: int = Depends(rate_limit)):
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
async def photo_status(photo_id: int, user_id: int = Depends(rate_limit)):
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
        p = await async_find_protocol(
            "main", photo_data["crop"], photo_data["disease"]
        )
        if p:
            proto = ProtocolResponse(
                id=p.id,
                product=p.product,
                dosage_value=float(p.dosage_value or 0),
                dosage_unit=p.dosage_unit,
                phi=p.phi,
                category=p.category,
                status=p.status,
                waiting_days=p.waiting_days,
            )

    return PhotoStatusResponse(
        status=photo_data["status"],
        updated_at=photo_data["updated_at"],
        crop=photo_data["crop"],
        disease=photo_data["disease"],
        protocol=proto,
    )
