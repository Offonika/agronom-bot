import asyncio
import json
import logging
import os
import hmac
from datetime import datetime, timezone, timedelta
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field, ValidationError

from app import db as db_module
from app.config import Settings
from app.dependencies import ErrorResponse, compute_signature, rate_limit
from app.models import Event, Payment, User
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


class AutopayWebhook(BaseModel):
    autopay_charge_id: str
    binding_id: str
    user_id: int
    amount: int
    status: str
    charged_at: datetime
    signature: str


class AutopayCancelRequest(BaseModel):
    user_id: int


class PaymentCreateRequest(BaseModel):
    user_id: int
    plan: str
    months: int = Field(default=1, ge=1, le=MAX_MONTHS)
    autopay: bool | None = None


class PaymentCreateResponse(BaseModel):
    payment_id: str
    url: str
    autopay_binding_id: str | None = None


class PaymentStatusResponse(BaseModel):
    status: str
    pro_expires_at: datetime | None = None


@router.post(
    "/create",
    response_model=PaymentCreateResponse,
    responses={401: {"model": ErrorResponse}},
)
async def create_payment(request: Request, user_id: int = Depends(rate_limit)):
    try:
        payload = await request.json()
    except json.JSONDecodeError as err:
        raise HTTPException(status_code=400, detail="BAD_REQUEST") from err

    try:
        body = PaymentCreateRequest.model_validate(payload)
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
    url, binding_id = await create_sbp_link(
        external_id, amount, currency, autopay=bool(body.autopay)
    )

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
                autopay=bool(body.autopay),
                autopay_binding_id=binding_id,
            )
            db.add(payment)
            db.add(Event(user_id=body.user_id, event="payment_created"))
            db.commit()

    await asyncio.to_thread(_db_call)
    return PaymentCreateResponse(
        payment_id=external_id, url=url, autopay_binding_id=binding_id
    )


@router.get(
    "/{payment_id}",
    response_model=PaymentStatusResponse,
    responses={401: {"model": ErrorResponse}, 404: {"description": "Not found"}},
)
async def payment_status(payment_id: str, user_id: int = Depends(rate_limit)):
    def _db_call() -> tuple[str, datetime | None]:
        with db_module.SessionLocal() as db:
            payment = (
                db.query(Payment)
                .filter_by(external_id=payment_id, user_id=user_id)
                .first()
            )
            if not payment:
                raise HTTPException(status_code=404, detail="NOT_FOUND")
            user = db.get(User, payment.user_id)
            exp = user.pro_expires_at if user else None
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
    _: None = Depends(rate_limit),
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
                user = db.get(User, payment.user_id)
                current_exp = (
                    user.pro_expires_at if user and user.pro_expires_at else body.paid_at
                )
                if isinstance(current_exp, str):
                    current_exp = datetime.fromisoformat(current_exp)
                if current_exp.tzinfo is None:
                    current_exp = current_exp.replace(tzinfo=timezone.utc)
                if current_exp < body.paid_at:
                    current_exp = body.paid_at
                new_exp = current_exp + timedelta(days=30 * months)
                if user:
                    user.pro_expires_at = new_exp
                    db.add(user)
                db.add(Event(user_id=payment.user_id, event="payment_success"))
                db.add(Event(user_id=payment.user_id, event="pro_activated"))
            else:
                db.add(Event(user_id=payment.user_id, event="payment_fail"))

            db.commit()

    await asyncio.to_thread(_db_call)
    return {}


@router.post(
    "/sbp/autopay/webhook",
    status_code=200,
    responses={
        401: {"model": ErrorResponse},
        400: {"model": ErrorResponse},
        403: {"model": ErrorResponse},
    },
)
async def autopay_webhook(
    request: Request,
    _: None = Depends(rate_limit),
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
        body = AutopayWebhook(**data, signature=provided_sign)
    except ValidationError as err:
        raise HTTPException(status_code=400, detail="BAD_REQUEST") from err

    def _db_call() -> None:
        with db_module.SessionLocal() as db:
            payment = (
                db.query(Payment)
                .filter_by(autopay_charge_id=body.autopay_charge_id)
                .first()
            )
            if not payment:
                payment = Payment(
                    user_id=body.user_id,
                    amount=body.amount,
                    currency="RUB",
                    provider="sbp",
                    external_id=body.autopay_charge_id,
                    autopay_charge_id=body.autopay_charge_id,
                    prolong_months=1,
                    status=body.status,
                    autopay=True,
                    autopay_binding_id=body.binding_id,
                )
                db.add(payment)
            else:
                payment.status = body.status
                payment.updated_at = datetime.now(timezone.utc)
                payment.autopay = True
                payment.autopay_binding_id = body.binding_id
                payment.autopay_charge_id = body.autopay_charge_id
                db.add(payment)

            if body.status == "success":
                user = db.get(User, body.user_id)
                current_exp = (
                    user.pro_expires_at if user and user.pro_expires_at else body.charged_at
                )
                if isinstance(current_exp, str):
                    current_exp = datetime.fromisoformat(current_exp)
                if current_exp.tzinfo is None:
                    current_exp = current_exp.replace(tzinfo=timezone.utc)
                if current_exp < body.charged_at:
                    current_exp = body.charged_at
                new_exp = current_exp + timedelta(days=30)
                if user:
                    user.pro_expires_at = new_exp
                    user.autopay_enabled = True
                    db.add(user)
                db.add(Event(user_id=body.user_id, event="payment_success"))
                db.add(Event(user_id=body.user_id, event="pro_activated"))
            else:
                db.add(Event(user_id=body.user_id, event="autopay_fail"))

            db.commit()

    await asyncio.to_thread(_db_call)
    return {}


@router.post(
    "/sbp/autopay/cancel",
    status_code=204,
    responses={401: {"model": ErrorResponse}, 400: {"model": ErrorResponse}},
)
async def cancel_autopay(
    request: Request,
    user_id: int = Depends(rate_limit),
):
    try:
        payload = await request.json()
    except json.JSONDecodeError as err:
        raise HTTPException(status_code=400, detail="BAD_REQUEST") from err

    try:
        body = AutopayCancelRequest.model_validate(payload)
    except ValidationError as err:
        raise HTTPException(status_code=400, detail="BAD_REQUEST") from err

    if body.user_id != user_id:
        err = ErrorResponse(code="UNAUTHORIZED", message="User ID mismatch")
        raise HTTPException(status_code=401, detail=err.model_dump())

    def _db_call() -> None:
        with db_module.SessionLocal() as db:
            user = db.get(User, body.user_id)
            if user:
                user.autopay_enabled = False
                db.add(user)
            db.add(Event(user_id=body.user_id, event="autopay_disabled"))
            db.commit()

    await asyncio.to_thread(_db_call)
    return Response(status_code=204)
