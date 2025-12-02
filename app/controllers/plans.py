from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any, List

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from prometheus_client import Counter

from app import db as db_module
from app.dependencies import ErrorResponse, rate_limit
from app.models import ErrorCode, PlanSession
from app.services.plan_payload import PlanPayloadError, normalize_plan_payload
from app.services.plan_service import (
    PlanCreateResult,
    create_plan_from_payload,
    create_event_with_reminder,
    enqueue_autoplan,
    has_valid_options,
    is_object_owned,
)
from app.services.autoplan_queue import AutoplanQueue
from app.services.plan_session import (
    delete_plan_session,
    get_latest_plan_session,
    get_plan_session_by_plan,
    get_plan_session_by_token,
    update_plan_session_fields,
    upsert_plan_session,
)

router = APIRouter(prefix="/plans", tags=["plans"])
autoplan_queue = AutoplanQueue()

plan_create_counter = Counter("plans_create_total", "Create plan requests", ["status"])
plan_event_counter = Counter("plans_event_create_total", "Create plan event requests", ["status"])
plan_autoplan_counter = Counter("plans_autoplan_enqueue_total", "Autoplan enqueue requests", ["status"])


class PlanOptionResponse(BaseModel):
    id: int
    product_name: str | None = None
    product_code: str | None = None
    ai: str | None = None
    dose_value: float | None = None
    dose_unit: str | None = None
    method: str | None = None
    phi_days: int | None = None
    notes: str | None = None
    needs_review: bool = False
    is_selected: bool = False


class PlanStageResponse(BaseModel):
    id: int
    name: str
    kind: str | None = None
    trigger: str | None = None
    notes: str | None = None
    phi_days: int | None = None
    options: list[PlanOptionResponse]


class PlanEventResponse(BaseModel):
    id: int
    type: str
    status: str
    slot_start: datetime | None = Field(None, alias="slot_start")
    slot_end: datetime | None = None
    reason: str | None = None


class PlanResponse(BaseModel):
    plan_id: int
    object_id: int
    case_id: int | None = None
    status: str
    version: int
    hash: str | None = None
    source: str | None = None
    payload: dict[str, Any] | None = None
    plan_kind: str | None = None
    plan_errors: list[str] | None = None
    stages: list[PlanStageResponse]
    events: list[PlanEventResponse]
    diff: dict[str, Any] | None = None


class PlanAcceptRequest(BaseModel):
    stage_option_ids: list[int] | None = None
    apply_to_existing_events: str = Field("none", pattern="^(none|future|all)$")
    comment: str | None = None


class PlanAcceptResponse(BaseModel):
    plan_id: int
    status: str
    scheduled_event_ids: list[int]


class PlanRejectResponse(BaseModel):
    plan_id: int
    status: str


class SelectOptionRequest(BaseModel):
    stage_option_id: int


class PlanSessionUpsertRequest(BaseModel):
    token: str
    diagnosis: dict[str, Any]
    current_step: str = "choose_object"
    state: dict[str, Any] = Field(default_factory=dict)
    recent_diagnosis_id: int | None = None
    object_id: int | None = None
    plan_id: int | None = None
    ttl_hours: int | None = None


class PlanSessionRecord(BaseModel):
    id: int
    user_id: int
    token: str
    created_at: datetime
    updated_at: datetime
    expires_at: datetime
    expired: bool
    current_step: str
    state: dict[str, Any]
    diagnosis: dict[str, Any]
    recent_diagnosis_id: int | None = None
    object_id: int | None = None
    plan_id: int | None = None


class PlanSessionPatchRequest(BaseModel):
    diagnosis: dict[str, Any] | None = None
    current_step: str | None = None
    state: dict[str, Any] | None = None
    recent_diagnosis_id: int | None = None
    object_id: int | None = None
    plan_id: int | None = None
    ttl_hours: int | None = None


class PlanCreateStage(BaseModel):
    stage_id: int | None
    option_ids: list[int] = Field(default_factory=list)


class PlanCreateResponse(BaseModel):
    plan_id: int | None
    stages: list[PlanCreateStage] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


class PlanCreateRequest(BaseModel):
    object_id: int
    case_id: int | None = None
    source: str = "assistant"
    plan_payload: dict[str, Any]


class EventCreateRequest(BaseModel):
    stage_id: int
    stage_option_id: int | None = None
    due_at: str | None = None
    slot_end: str | None = None
    reason: str | None = None


class EventCreateResponse(BaseModel):
    event_ids: list[int]
    reminder_ids: list[int]


class AutoplanRequest(BaseModel):
    stage_id: int
    stage_option_id: int
    min_hours_ahead: int = 2
    horizon_hours: int = 72


class AutoplanResponse(BaseModel):
    autoplan_run_id: int | None
    status: str


@router.post("/sessions", response_model=PlanSessionRecord)
async def upsert_plan_session_endpoint(
    body: PlanSessionUpsertRequest,
    user_id: int = Depends(rate_limit),
):
    record = await asyncio.to_thread(
        _upsert_plan_session,
        user_id,
        body,
    )
    return _build_plan_session_record(record)


@router.get("/sessions", response_model=PlanSessionRecord)
async def get_plan_session_endpoint(
    token: str | None = None,
    include_expired: bool = False,
    plan_id: int | None = None,
    user_id: int = Depends(rate_limit),
):
    record = await asyncio.to_thread(
        _fetch_plan_session,
        user_id,
        token,
        plan_id,
    )
    if not record:
        raise HTTPException(status_code=404, detail="PLAN_SESSION_NOT_FOUND")
    if not include_expired and _is_session_expired(record):
        raise HTTPException(status_code=410, detail="PLAN_SESSION_EXPIRED")
    return _build_plan_session_record(record)


@router.patch("/sessions/{session_id}", response_model=PlanSessionRecord)
async def patch_plan_session_endpoint(
    session_id: int,
    body: PlanSessionPatchRequest,
    user_id: int = Depends(rate_limit),
):
    record = await asyncio.to_thread(
        _patch_plan_session,
        user_id,
        session_id,
        body,
    )
    if not record:
        raise HTTPException(status_code=404, detail="PLAN_SESSION_NOT_FOUND")
    return _build_plan_session_record(record)


@router.delete("/sessions", status_code=204)
async def delete_plan_session_endpoint(
    token: str | None = None,
    plan_id: int | None = None,
    user_id: int = Depends(rate_limit),
):
    await asyncio.to_thread(
        _delete_plan_session,
        user_id,
        token,
        plan_id,
    )
    return Response(status_code=204)


@router.post("", response_model=PlanCreateResponse)
async def create_plan_endpoint(
    body: PlanCreateRequest,
    user_id: int = Depends(rate_limit),
):
    if not is_object_owned(user_id, body.object_id):
        err = ErrorResponse(code=ErrorCode.FORBIDDEN, message="OBJECT_NOT_OWNED")
        plan_create_counter.labels(status="forbidden").inc()
        raise HTTPException(status_code=403, detail=err.model_dump())
    try:
        normalized = normalize_plan_payload(body.plan_payload)
    except PlanPayloadError as exc:
        err = ErrorResponse(code=ErrorCode.BAD_REQUEST, message=str(exc))
        plan_create_counter.labels(status="bad_request").inc()
        raise HTTPException(status_code=400, detail=err.model_dump()) from exc
    if not has_valid_options(normalized):
        err = ErrorResponse(code=ErrorCode.BAD_REQUEST, message="NO_OPTIONS_IN_PLAN")
        plan_create_counter.labels(status="bad_request").inc()
        raise HTTPException(status_code=400, detail=err.model_dump())

    result: PlanCreateResult = create_plan_from_payload(
        user_id=user_id,
        object_id=body.object_id,
        normalized=normalized,
        raw_payload=body.plan_payload,
    )
    return PlanCreateResponse(
        plan_id=result.plan_id,
        stages=[PlanCreateStage(stage_id=s.stage_id, option_ids=s.option_ids) for s in result.stages],
        errors=normalized.errors,
    )
    plan_create_counter.labels(status="ok").inc()


@router.post("/{plan_id}/events", response_model=EventCreateResponse)
async def create_event_endpoint(
    plan_id: int,
    body: EventCreateRequest,
    user_id: int = Depends(rate_limit),
):
    if db_module.engine is None:
        err = ErrorResponse(code=ErrorCode.SERVICE_UNAVAILABLE, message="DB unavailable")
        raise HTTPException(status_code=503, detail=err.model_dump())
    # Простая валидация stage_id > 0
    if body.stage_id <= 0:
        err = ErrorResponse(code=ErrorCode.BAD_REQUEST, message="INVALID_STAGE_ID")
        plan_event_counter.labels(status="bad_request").inc()
        raise HTTPException(status_code=400, detail=err.model_dump())

    event_ids, reminder_ids = create_event_with_reminder(
        user_id=user_id,
        plan_id=plan_id,
        stage_id=body.stage_id,
        stage_option_id=body.stage_option_id,
        due_at_iso=body.due_at,
        slot_end_iso=body.slot_end,
        reason=body.reason or "Создано ассистентом",
        source="assistant",
    )
    plan_event_counter.labels(status="ok").inc()
    return EventCreateResponse(event_ids=event_ids, reminder_ids=reminder_ids)


@router.post("/{plan_id}/autoplan", response_model=AutoplanResponse, status_code=202)
async def enqueue_autoplan_endpoint(
    plan_id: int,
    body: AutoplanRequest,
    user_id: int = Depends(rate_limit),
):
    run_id = enqueue_autoplan(
        user_id=user_id,
        plan_id=plan_id,
        stage_id=body.stage_id,
        stage_option_id=body.stage_option_id,
        min_hours_ahead=body.min_hours_ahead,
        horizon_hours=body.horizon_hours,
    )
    try:
        if run_id:
            autoplan_queue.add_run(run_id)
    except Exception as exc:  # pragma: no cover
        logger.warning("autoplan_queue add failed for run %s: %s", run_id, exc)
    if run_id is None:
        err = ErrorResponse(code=ErrorCode.SERVICE_UNAVAILABLE, message="AUTOPLAN_ENQUEUE_FAILED")
        plan_autoplan_counter.labels(status="fail").inc()
        raise HTTPException(status_code=503, detail=err.model_dump())
    plan_autoplan_counter.labels(status="ok").inc()
    return AutoplanResponse(autoplan_run_id=run_id, status="pending")


@router.get("/{plan_id}", response_model=PlanResponse)
async def get_plan(
    plan_id: int,
    include_payload: bool = False,
    diff_against: str | None = None,
    user_id: int = Depends(rate_limit),
):
    return await asyncio.to_thread(
        _load_plan_response, plan_id, user_id, include_payload, diff_against
    )


@router.post("/{plan_id}/accept", response_model=PlanAcceptResponse)
async def accept_plan(
    plan_id: int,
    body: PlanAcceptRequest,
    user_id: int = Depends(rate_limit),
):
    return await asyncio.to_thread(_accept_plan, plan_id, user_id)


@router.post("/{plan_id}/reject", response_model=PlanRejectResponse)
async def reject_plan(plan_id: int, user_id: int = Depends(rate_limit)):
    return await asyncio.to_thread(_update_plan_status, plan_id, user_id, "rejected")


@router.post("/{plan_id}/select-option", response_model=PlanResponse)
async def select_option(
    plan_id: int,
    body: SelectOptionRequest,
    user_id: int = Depends(rate_limit),
):
    return await asyncio.to_thread(_select_option, plan_id, user_id, body.stage_option_id)


def _load_plan_response(
    plan_id: int,
    user_id: int,
    include_payload: bool,
    diff_against: str | None,
) -> PlanResponse:
    with db_module.SessionLocal() as session:
        plan_row = session.execute(
            sa_text(
                """
                SELECT p.id, p.object_id, p.case_id, p.status, p.version, p.hash,
                       p.source, p.payload, p.plan_kind, p.plan_errors
                FROM plans p
                WHERE p.id = :pid AND p.user_id = :uid
                """
            ),
            {"pid": plan_id, "uid": user_id},
        ).mappings().first()
        if not plan_row:
            _raise_not_found("plan_not_found")

        stages = session.execute(
            sa_text(
                """
                SELECT ps.id AS stage_id,
                       ps.kind,
                       ps.title,
                       ps.note,
                       ps.meta,
                       ps.phi_days,
                       so.id AS option_id,
                       so.product,
                       so.ai,
                       so.dose_value,
                       so.dose_unit,
                       so.method,
                       so.meta AS option_meta,
                       so.is_selected,
                       so.stage_id AS option_stage_id
                FROM plan_stages ps
                LEFT JOIN stage_options so ON so.stage_id = ps.id
                WHERE ps.plan_id = :pid
                ORDER BY ps.id ASC, so.id ASC
                """
            ),
            {"pid": plan_id},
        ).mappings().all()
        events = session.execute(
            sa_text(
                """
                SELECT id, type, status, due_at, slot_end, reason
                FROM events
                WHERE plan_id = :pid
                ORDER BY due_at ASC NULLS LAST, id ASC
                """
            ),
            {"pid": plan_id},
        ).mappings().all()

    payload = _coerce_json(plan_row["payload"]) if include_payload else None
    plan_errors = _ensure_list(plan_row["plan_errors"])

    return PlanResponse(
        plan_id=plan_row["id"],
        object_id=plan_row["object_id"],
        case_id=plan_row["case_id"],
        status=plan_row["status"],
        version=plan_row["version"],
        hash=plan_row["hash"],
        source=plan_row["source"],
        payload=payload,
        plan_kind=plan_row["plan_kind"],
        plan_errors=plan_errors,
        stages=_build_stage_tree(stages),
        events=[
            PlanEventResponse(
                id=row["id"],
                type=row["type"],
                status=row["status"],
                slot_start=row["due_at"],
                slot_end=row["slot_end"],
                reason=row["reason"],
            )
            for row in events
        ],
        diff=_build_diff_placeholder(diff_against),
    )


def _accept_plan(plan_id: int, user_id: int) -> PlanAcceptResponse:
    with db_module.SessionLocal() as session:
        result = session.execute(
            sa_text(
                """
                UPDATE plans
                SET status = 'accepted',
                    version = COALESCE(version, 1) + 1
                WHERE id = :pid AND user_id = :uid
                """
            ),
            {"pid": plan_id, "uid": user_id},
        )
        if result.rowcount == 0:
            _raise_not_found("plan_not_found")
        event_rows = session.execute(
            sa_text(
                "SELECT id FROM events WHERE plan_id = :pid AND status = 'scheduled'"
            ),
            {"pid": plan_id},
        ).scalars().all()
        session.commit()
    return PlanAcceptResponse(
        plan_id=plan_id,
        status="accepted",
        scheduled_event_ids=list(event_rows),
    )


def _update_plan_status(plan_id: int, user_id: int, status: str) -> PlanRejectResponse:
    with db_module.SessionLocal() as session:
        result = session.execute(
            sa_text(
                """
                UPDATE plans
                SET status = :status
                WHERE id = :pid AND user_id = :uid
                """
            ),
            {"pid": plan_id, "uid": user_id, "status": status},
        )
        if result.rowcount == 0:
            _raise_not_found("plan_not_found")
        session.commit()
    return PlanRejectResponse(plan_id=plan_id, status=status)


def _select_option(plan_id: int, user_id: int, option_id: int) -> PlanResponse:
    with db_module.SessionLocal() as session:
        option_row = session.execute(
            sa_text(
                """
                SELECT so.id, so.stage_id, p.user_id, ps.plan_id
                FROM stage_options so
                JOIN plan_stages ps ON ps.id = so.stage_id
                JOIN plans p ON p.id = ps.plan_id
                WHERE so.id = :option_id
                """
            ),
            {"option_id": option_id},
        ).mappings().first()
        if not option_row or option_row["plan_id"] != plan_id or option_row["user_id"] != user_id:
            _raise_not_found("option_not_found")
        session.execute(
            sa_text("UPDATE stage_options SET is_selected = FALSE WHERE stage_id = :sid"),
            {"sid": option_row["stage_id"]},
        )
        session.execute(
            sa_text(
                "UPDATE stage_options SET is_selected = TRUE WHERE id = :option_id"
            ),
            {"option_id": option_id},
        )
        session.commit()
    return _load_plan_response(plan_id, user_id, include_payload=False, diff_against=None)


def _build_stage_tree(rows: list[dict[str, Any]]) -> list[PlanStageResponse]:
    stages: dict[int, PlanStageResponse] = {}
    for row in rows:
        stage_id = row["stage_id"]
        if stage_id not in stages:
            meta = _coerce_json(row["meta"]) or {}
            stages[stage_id] = PlanStageResponse(
                id=stage_id,
                name=row["title"],
                kind=row["kind"],
                trigger=meta.get("trigger"),
                notes=row["note"],
                phi_days=row["phi_days"],
                options=[],
            )
        if row["option_id"] is not None:
            option_meta = _coerce_json(row["option_meta"]) or {}
            stages[stage_id].options.append(
                PlanOptionResponse(
                    id=row["option_id"],
                    product_name=row["product"],
                    product_code=option_meta.get("product_code"),
                    ai=row["ai"],
                    dose_value=row["dose_value"],
                    dose_unit=row["dose_unit"],
                    method=row["method"],
                    phi_days=option_meta.get("phi_days"),
                    notes=option_meta.get("notes"),
                    needs_review=bool(option_meta.get("needs_review")),
                    is_selected=bool(row["is_selected"]),
                )
            )
    return list(stages.values())


def _build_diff_placeholder(diff_against: str | None) -> dict[str, Any] | None:
    if diff_against:
        return {"status": "not_implemented"}
    return None


def _coerce_json(value: Any) -> dict[str, Any] | list[Any] | None:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed
        except json.JSONDecodeError:
            return None
    return None


def _ensure_list(value: Any) -> list[str] | None:
    data = _coerce_json(value)
    if isinstance(data, list):
        return data
    return None


def _upsert_plan_session(user_id: int, body: PlanSessionUpsertRequest) -> PlanSession:
    with db_module.SessionLocal() as session:
        return upsert_plan_session(
            session,
            user_id=user_id,
            token=body.token,
            diagnosis_payload=body.diagnosis,
            current_step=body.current_step,
            state=body.state or {},
            recent_diagnosis_id=body.recent_diagnosis_id,
            object_id=body.object_id,
            plan_id=body.plan_id,
            ttl_hours=body.ttl_hours,
        )


def _fetch_plan_session(user_id: int, token: str | None, plan_id: int | None) -> PlanSession | None:
    with db_module.SessionLocal() as session:
        if token and plan_id:
            raise HTTPException(status_code=400, detail="PLAN_SESSION_LOOKUP_CONFLICT")
        if token:
            return get_plan_session_by_token(session, user_id=user_id, token=token)
        if plan_id:
            return get_plan_session_by_plan(session, user_id=user_id, plan_id=plan_id)
        return get_latest_plan_session(session, user_id=user_id)


def _patch_plan_session(user_id: int, session_id: int, body: PlanSessionPatchRequest) -> PlanSession | None:
    payload = body.diagnosis
    with db_module.SessionLocal() as session:
        return update_plan_session_fields(
            session,
            user_id=user_id,
            session_id=session_id,
            diagnosis_payload=payload,
            current_step=body.current_step,
            state=body.state,
            recent_diagnosis_id=body.recent_diagnosis_id,
            object_id=body.object_id,
            plan_id=body.plan_id,
            ttl_hours=body.ttl_hours,
        )


def _delete_plan_session(user_id: int, token: str | None, plan_id: int | None) -> None:
    with db_module.SessionLocal() as session:
        delete_plan_session(session, user_id=user_id, token=token, plan_id=plan_id)


def _ensure_aware(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _is_session_expired(record: PlanSession) -> bool:
    return _ensure_aware(record.expires_at) <= datetime.now(timezone.utc)


def _build_plan_session_record(record: PlanSession) -> PlanSessionRecord:
    return PlanSessionRecord(
        id=record.id,
        user_id=record.user_id,
        token=record.token,
        created_at=_ensure_aware(record.created_at),
        updated_at=_ensure_aware(record.updated_at),
        expires_at=_ensure_aware(record.expires_at),
        expired=_is_session_expired(record),
        current_step=record.current_step,
        state=record.state or {},
        diagnosis=record.diagnosis_payload,
        recent_diagnosis_id=record.recent_diagnosis_id,
        object_id=record.object_id,
        plan_id=record.plan_id,
    )


def _raise_not_found(message: str) -> None:
    err = ErrorResponse(code=ErrorCode.BAD_REQUEST, message=message)
    raise HTTPException(status_code=404, detail=err.model_dump())


from sqlalchemy import text as sa_text  # noqa: E402  (placed after FastAPI defs)
