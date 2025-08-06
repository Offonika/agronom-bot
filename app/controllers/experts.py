import asyncio
import json
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError

from app import db as db_module
from app.dependencies import ErrorResponse, rate_limit
from app.models import Event, ErrorCode

router = APIRouter()


class AskExpertRequest(BaseModel):
    question: str = Field(min_length=1, max_length=500)


@router.post(
    "/ask_expert",
    status_code=202,
    responses={401: {"model": ErrorResponse}, 400: {"model": ErrorResponse}},
)
async def ask_expert(
    request: Request, user_id: int = Depends(rate_limit)
):
    """Queue a question for a human expert."""

    try:
        payload = await request.json()
    except json.JSONDecodeError as exc:
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Invalid JSON payload"
        )
        raise HTTPException(status_code=400, detail=err.model_dump()) from exc

    try:
        AskExpertRequest.model_validate(payload)
    except ValidationError as exc:
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Invalid request body"
        )
        raise HTTPException(status_code=400, detail=err.model_dump()) from exc

    def _db_call() -> None:
        with db_module.SessionLocal() as db:
            db.add(Event(user_id=user_id, event="ask_expert"))
            db.commit()

    await asyncio.to_thread(_db_call)
    return JSONResponse(status_code=202, content={"status": "queued"})
