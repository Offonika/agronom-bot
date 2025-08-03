import asyncio
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app import db as db_module
from app.dependencies import ErrorResponse, rate_limit
from app.models import Event

router = APIRouter()


class AskExpertRequest(BaseModel):
    question: str


@router.post(
    "/ask_expert",
    status_code=202,
    responses={401: {"model": ErrorResponse}, 400: {"model": ErrorResponse}},
)
async def ask_expert(
    body: AskExpertRequest, user_id: int = Depends(rate_limit)
):
    """Queue a question for a human expert."""

    def _db_call() -> None:
        with db_module.SessionLocal() as db:
            db.add(Event(user_id=user_id, event="ask_expert"))
            db.commit()

    await asyncio.to_thread(_db_call)
    return JSONResponse(status_code=202, content={"status": "queued"})
