import asyncio
import json
import logging
import os
import hmac
from datetime import datetime, timezone, timedelta
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import text

from app import db as db_module
from app.config import Settings
from app.dependencies import ErrorResponse, require_api_headers, compute_signature
from app.models import Event, Payment
from app.services import create_sbp_link
from app.services.hmac import verify_hmac

settings = Settings()
logger = logging.getLogger(__name__)
HMAC_SECRET = settings.hmac_secret
MAX_MONTHS = 12

router = APIRouter(prefix="/payments")


class PaymentWebhook(BaseModel):
    external_id: str
    status: str
    paid_at: datetime
    signature: str


class PaymentCreateRequest(BaseModel):
    user_id: int
    plan: str
    months: int = Field(default=1, ge=1, le=MAX_MONTHS)


class PaymentCreateResponse(BaseModel):
    payment_id: str
    url: str


class PaymentStatusResponse(BaseModel):
    status: str
    pro_expires_at: datetime | None = None


@router.post(
    "/create",
    response_model=PaymentCreateResponse,
    responses={401: {"model": ErrorResponse}},
)
async def create_payment(request: Request, user_id: int = Depends(require_api_headers)):
    try:
        body = PaymentCreateRequest.model_validate(await request.json())
    except ValidationError as err:
        raise HTTPException(status_code=400, detail="BAD_REQUEST") from err

    if body.user_id != user_id:
        err = ErrorResponse(code="UNAUTHORIZED", message="User ID mismatch")
        raise HTTPException(status_code=401, detail=err.model_dump())

    if body.plan.lower() != "pro":
        raise HTTPException(status_code=400, detail="BAD_REQUEST")

    if body.months < 1 or body.months > MAX_MONTHS:
        raise HTTPException(status_code=400, detail="BAD_REQUEST")

    amount = 19900 * body.months
    currency = "RUB"
    external_id = uuid4().hex
    url = await create_sbp_link(external_id, amount, currency)

    def _db_call() -> None:
        with db_module.SessionLocal() as db:
            payment = Payment(
                user_id=body.user_id,
                amount=amount,
                currency=currency,
                provider="sbp",
                external_id=external_id,
                prolong_months=body.months,
                status="pending",
            )
            db.add(payment)
            db.add(Event(user_id=body.user_id, event="payment_created"))
            db.commit()

    await asyncio.to_thread(_db_call)
    return PaymentCreateResponse(payment_id=external_id, url=url)


@router.get(
    "/{payment_id}",
    response_model=PaymentStatusResponse,
    responses={401: {"model": ErrorResponse}, 404: {"description": "Not found"}},
)
async def payment_status(payment_id: str, user_id: int = Depends(require_api_headers)):
    def _db_call() -> tuple[str, datetime | None]:
        with db_module.SessionLocal() as db:
            payment = db.query(Payment).filter_by(external_id=payment_id, user_id=user_id).first()
            if not payment:
                raise HTTPException(status_code=404, detail="NOT_FOUND")
            exp = db.execute(
                text("SELECT pro_expires_at FROM users WHERE id=:uid"),
                {"uid": payment.user_id},
            ).scalar()
            return payment.status, exp

    status, exp = await asyncio.to_thread(_db_call)
    return PaymentStatusResponse(status=status, pro_expires_at=exp)


@router.post(
    "/sbp/webhook",
    status_code=200,
    responses={
        401: {"model": ErrorResponse},
        400: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
    },
)
async def payments_webhook(
    request: Request,
    _: None = Depends(require_api_headers),
    x_signature: str | None = Header(None, alias="X-Signature"),
):
    raw_body = await request.body()
    secure = os.getenv("SECURE_WEBHOOK")
    if secure and not verify_hmac(x_signature or "", raw_body, HMAC_SECRET):
        logger.warning("audit: invalid webhook signature")
        raise HTTPException(status_code=403, detail="FORBIDDEN")

    try:
        data = json.loads(raw_body)
    except (json.JSONDecodeError, TypeError) as err:
        logger.exception("failed to parse webhook body as JSON")
        raise HTTPException(status_code=400, detail="BAD_REQUEST") from err
    provided_sign = data.pop("signature", "")
    expected_sign = compute_signature(HMAC_SECRET, data)
    if not hmac.compare_digest(provided_sign, expected_sign):
        logger.warning("audit: invalid payload signature")
        raise HTTPException(status_code=403, detail="FORBIDDEN")

    try:
        body = PaymentWebhook(**data, signature=provided_sign)
    except ValidationError as err:
        raise HTTPException(status_code=400, detail="BAD_REQUEST") from err

    def _db_call() -> None:
        with db_module.SessionLocal() as db:
            payment = db.query(Payment).filter_by(external_id=body.external_id).first()
            if not payment:
                raise HTTPException(status_code=404, detail="NOT_FOUND")
            payment.status = body.status
            payment.updated_at = datetime.now(timezone.utc)
            db.add(payment)

            if body.status == "success":
                months = payment.prolong_months or 0
                res = db.execute(
                    text("SELECT pro_expires_at FROM users WHERE id=:uid"),
                    {"uid": payment.user_id},
                ).scalar()
                current_exp = res or body.paid_at
                if isinstance(current_exp, str):
                    current_exp = datetime.fromisoformat(current_exp)
                if current_exp < body.paid_at:
                    current_exp = body.paid_at
                new_exp = current_exp + timedelta(days=30 * months)
                db.execute(
                    text("UPDATE users SET pro_expires_at=:exp WHERE id=:uid"),
                    {"uid": payment.user_id, "exp": new_exp},
                )
                db.add(Event(user_id=payment.user_id, event="payment_success"))
                db.add(Event(user_id=payment.user_id, event="pro_activated"))
            else:
                db.add(Event(user_id=payment.user_id, event="payment_fail"))

            db.commit()

    await asyncio.to_thread(_db_call)
    return {}
