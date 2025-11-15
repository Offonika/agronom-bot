from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import db as db_module
from app.dependencies import ErrorResponse, rate_limit
from app.models import ErrorCode

router = APIRouter(prefix="/plans", tags=["plans"])


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


def _raise_not_found(message: str) -> None:
    err = ErrorResponse(code=ErrorCode.BAD_REQUEST, message=message)
    raise HTTPException(status_code=404, detail=err.model_dump())


from sqlalchemy import text as sa_text  # noqa: E402  (placed after FastAPI defs)
