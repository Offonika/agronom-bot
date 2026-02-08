from __future__ import annotations

import asyncio
import hmac
from datetime import datetime, timezone

from fastapi import APIRouter, Header, HTTPException
from sqlalchemy import inspect, text

from app import db as db_module
from app.config import Settings
from app.dependencies import ErrorResponse, compute_signature
from app.models import ErrorCode

settings = Settings()
HMAC_SECRET = settings.hmac_secret

router = APIRouter()


@router.get(
    "/beta_stats",
    responses={401: {"model": ErrorResponse}},
)
async def beta_stats(x_sign: str = Header(..., alias="X-Sign")):
    payload = {"scope": "beta_stats"}
    expected_sign = compute_signature(HMAC_SECRET, payload)
    if not hmac.compare_digest(expected_sign, x_sign):
        err = ErrorResponse(code=ErrorCode.UNAUTHORIZED, message="Invalid signature")
        raise HTTPException(status_code=401, detail=err.model_dump())

    def _fetch() -> dict[str, int]:
        with db_module.SessionLocal() as db:
            inspector = inspect(db.get_bind())
            has_cases = inspector.has_table("cases")
            beta_testers = db.execute(
                text("SELECT COUNT(*) FROM users WHERE is_beta = TRUE")
            ).scalar_one()
            beta_users_with_photo = db.execute(
                text(
                    "SELECT COUNT(DISTINCT p.user_id) "
                    "FROM photos p JOIN users u ON u.id = p.user_id "
                    "WHERE u.is_beta = TRUE"
                )
            ).scalar_one()
            beta_users_with_case = 0
            if has_cases:
                beta_users_with_case = db.execute(
                    text(
                        "SELECT COUNT(DISTINCT c.user_id) "
                        "FROM cases c JOIN users u ON u.id = c.user_id "
                        "WHERE u.is_beta = TRUE"
                    )
                ).scalar_one()
            beta_users_survey_completed = db.execute(
                text(
                    "SELECT COUNT(DISTINCT f.user_id) "
                    "FROM diagnosis_feedback f "
                    "JOIN users u ON u.id = f.user_id "
                    "WHERE u.is_beta = TRUE "
                    "AND f.q1_confidence_score IS NOT NULL "
                    "AND f.q2_clarity_score IS NOT NULL"
                )
            ).scalar_one()
            beta_users_followup_answered = db.execute(
                text(
                    "SELECT COUNT(DISTINCT f.user_id) "
                    "FROM followup_feedback f "
                    "JOIN users u ON u.id = f.user_id "
                    "WHERE u.is_beta = TRUE "
                    "AND f.answered_at IS NOT NULL"
                )
            ).scalar_one()
        return {
            "beta_testers": beta_testers,
            "beta_users_with_photo": beta_users_with_photo,
            "beta_users_with_case": beta_users_with_case,
            "beta_users_survey_completed": beta_users_survey_completed,
            "beta_users_followup_answered": beta_users_followup_answered,
        }

    stats = await asyncio.to_thread(_fetch)
    return {
        "stats": stats,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "scope": payload["scope"],
    }
