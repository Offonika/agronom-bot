from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from prometheus_client import Counter

from app.dependencies import ErrorResponse, rate_limit
from app.models import ErrorCode
from app.services import assistant as assistant_service
from app.services import assistant_orchestrator
from app.services.plan_payload import PlanPayloadError, PlanNormalizationResult, normalize_plan_payload
from app.services.plan_session import upsert_plan_session
from app.services.plan_service import (
    create_plan_from_payload,
    create_event_with_reminder,
    enqueue_autoplan,
    has_valid_options,
    is_object_owned,
)
from app.services.autoplan_queue import AutoplanQueue
from app import db as db_module
from app.config import Settings

router = APIRouter(prefix="/assistant", tags=["assistant"])
logger = logging.getLogger(__name__)
settings = Settings()
autoplan_queue = AutoplanQueue()

assistant_chat_counter = Counter(
    "assistant_chat_requests_total",
    "Assistant chat requests",
    ["status"],
)
assistant_confirm_counter = Counter(
    "assistant_confirm_total",
    "Assistant confirm requests",
    ["status"],
)


class AssistantChatMetadata(BaseModel):
    recent_diagnosis_id: int | None = None
    plan_session_id: int | None = None
    locale: str | None = None


class AssistantChatRequest(BaseModel):
    session_id: str | None = None
    object_id: int | None = None
    message: str
    metadata: AssistantChatMetadata | None = None


class AssistantProposal(BaseModel):
    proposal_id: str
    kind: str = Field(pattern="^(plan|event|clarify)$")
    plan_payload: dict[str, Any] | None = None
    suggested_actions: list[str] = Field(default_factory=list)


class AssistantChatResponse(BaseModel):
    assistant_message: str
    followups: list[str] = Field(default_factory=list)
    proposals: list[AssistantProposal] = Field(default_factory=list)


class AssistantConfirmRequest(BaseModel):
    proposal_id: str
    object_id: int
    preferred_time: str | None = None
    plan_session_id: int | None = None


class AssistantConfirmResponse(BaseModel):
    status: str
    plan_id: int | None = None
    event_ids: list[int] = Field(default_factory=list)
    reminder_ids: list[int] = Field(default_factory=list)


@router.post("/chat", response_model=AssistantChatResponse)
async def assistant_chat(
    body: AssistantChatRequest,
    user_id: int = Depends(rate_limit),
):
    message = body.message.strip()
    if not message:
        err = ErrorResponse(code=ErrorCode.BAD_REQUEST, message="message is required")
        assistant_chat_counter.labels(status="bad_request").inc()
        raise HTTPException(status_code=400, detail=err.model_dump())

    ctx = assistant_orchestrator.load_context(user_id, body.object_id)
    answer, proposals = assistant_orchestrator.build_response(message, ctx)
    prepared: list[AssistantProposal] = []
    for raw in proposals:
        if not raw.get("proposal_id"):
            raw["proposal_id"] = str(uuid.uuid4())
        await assistant_service.save_proposal(user_id, body.object_id, raw)
        prepared.append(AssistantProposal(**raw))
    response = AssistantChatResponse(
        assistant_message=answer,
        followups=[],
        proposals=prepared,
    )
    assistant_chat_counter.labels(status="ok").inc()
    return response


@router.post("/confirm_plan", response_model=AssistantConfirmResponse)
async def assistant_confirm_plan(
    body: AssistantConfirmRequest,
    user_id: int = Depends(rate_limit),
):
    record = await assistant_service.fetch_proposal(body.proposal_id)
    if not record:
        err = ErrorResponse(code=ErrorCode.BAD_REQUEST, message="PROPOSAL_NOT_FOUND")
        assistant_confirm_counter.labels(status="not_found").inc()
        raise HTTPException(status_code=404, detail=err.model_dump())
    if record.get("user_id") != user_id:
        err = ErrorResponse(code=ErrorCode.UNAUTHORIZED, message="PROPOSAL_NOT_OWNED")
        assistant_confirm_counter.labels(status="unauthorized").inc()
        raise HTTPException(status_code=401, detail=err.model_dump())

    await assistant_service.delete_proposal(body.proposal_id)

    payload = record.get("payload") or {}
    if payload.get("kind") not in {"plan", "event"}:
        err = ErrorResponse(code=ErrorCode.BAD_REQUEST, message="UNSUPPORTED_PROPOSAL_KIND")
        raise HTTPException(status_code=400, detail=err.model_dump())

    plan_payload: dict[str, Any] | None = payload.get("plan_payload")
    if payload.get("object_id") and payload.get("object_id") != body.object_id:
        err = ErrorResponse(code=ErrorCode.BAD_REQUEST, message="OBJECT_MISMATCH")
        assistant_confirm_counter.labels(status="bad_request").inc()
        raise HTTPException(status_code=400, detail=err.model_dump())
    if not is_object_owned(user_id, body.object_id):
        err = ErrorResponse(code=ErrorCode.FORBIDDEN, message="OBJECT_NOT_OWNED")
        assistant_confirm_counter.labels(status="forbidden").inc()
        raise HTTPException(status_code=403, detail=err.model_dump())

    try:
        normalized: PlanNormalizationResult | None = normalize_plan_payload(plan_payload) if plan_payload else None
    except PlanPayloadError as exc:
        err = ErrorResponse(code=ErrorCode.BAD_REQUEST, message=str(exc))
        assistant_confirm_counter.labels(status="bad_request").inc()
        raise HTTPException(status_code=400, detail=err.model_dump()) from exc
    if not has_valid_options(normalized):
        err = ErrorResponse(code=ErrorCode.BAD_REQUEST, message="NO_OPTIONS_IN_PLAN")
        assistant_confirm_counter.labels(status="bad_request").inc()
        raise HTTPException(status_code=400, detail=err.model_dump())

    if db_module.engine is None:
        err = ErrorResponse(code=ErrorCode.SERVICE_UNAVAILABLE, message="Assistant persistence unavailable")
        raise HTTPException(status_code=503, detail=err.model_dump())

    if db_module.engine.dialect.name != "sqlite" and not settings.assistant_enable_stub:
        err = ErrorResponse(code=ErrorCode.SERVICE_UNAVAILABLE, message="Assistant persistence not enabled on this DB")
        raise HTTPException(status_code=503, detail=err.model_dump())

    plan_result = create_plan_from_payload(
        user_id=user_id,
        object_id=body.object_id,
        normalized=normalized,
        raw_payload=plan_payload,
    )
    plan_id = plan_result.plan_id
    event_ids: list[int] = []
    reminder_ids: list[int] = []
    # Если ассистент не получил времени — ставим автоплан для первого этапа/опции.
    if plan_result.stages and normalized and normalized.plan.stages:
        first_stage = normalized.plan.stages[0]
        first_option = first_stage.options[0] if first_stage.options else None
        if first_option:
            stage_option_id = plan_result.stages[0].option_ids[0] if plan_result.stages[0].option_ids else None
            run_id = enqueue_autoplan(
                user_id=user_id,
                plan_id=plan_id,
                stage_id=plan_result.stages[0].stage_id or 0,
                stage_option_id=stage_option_id or 0,
            )
            try:
                if run_id:
                    autoplan_queue.add_run(run_id)
            except Exception as exc:  # pragma: no cover
                logger.warning("autoplan_queue add failed for run %s: %s", run_id, exc)
            logger.info(
                "assistant_autoplan_enqueued plan=%s stage=%s run=%s",
                plan_id,
                plan_result.stages[0].stage_id,
                run_id,
            )
        # Создаём резервное событие/напоминание на ближайший час, чтобы пользователь видел запись
        event_ids, reminder_ids = create_event_with_reminder(
            user_id=user_id,
            plan_id=plan_id,
            stage_id=plan_result.stages[0].stage_id or 0,
            stage_option_id=plan_result.stages[0].option_ids[0] if plan_result.stages[0].option_ids else None,
            reason="Черновик ассистента",
        )
    logger.info(
        "assistant_confirm_plan: user=%s object=%s proposal=%s plan_id=%s events=%s reminders=%s",
        user_id,
        body.object_id,
        body.proposal_id,
        plan_id,
        event_ids,
        reminder_ids,
        )
    assistant_confirm_counter.labels(status="ok").inc()
    return AssistantConfirmResponse(
        status="accepted",
        plan_id=plan_id,
        event_ids=event_ids,
        reminder_ids=reminder_ids,
    )
