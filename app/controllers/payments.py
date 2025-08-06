import asyncio
import json
import logging
import os
import time
import hmac
import jwt
from datetime import datetime, timezone, timedelta
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field, ValidationError

from app import db as db_module
from app.config import Settings
from app.dependencies import ErrorResponse, compute_signature, rate_limit
from app.metrics import autopay_charge_seconds, payment_fail_total
from app.models import Event, Payment, User, ErrorCode
from app.services import create_sbp_link
from app.services.hmac import verify_hmac
from app.middleware.csrf import validate_csrf

settings = Settings()
logger = logging.getLogger(__name__)
HMAC_SECRET = settings.hmac_secret
MAX_MONTHS = 12
AUTOPAY_ALLOWED_STATUSES = {"success", "fail", "cancel", "bank_error"}

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
    status: Literal["success", "fail", "cancel", "bank_error"]
    charged_at: datetime
    signature: str


class AutopayCancelRequest(BaseModel):
    user_id: int


class PaymentCreateRequest(BaseModel):
    user_id: int
    plan: Literal["pro"]
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
    except json.JSONDecodeError as exc:
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Invalid JSON payload"
        )
        raise HTTPException(status_code=400, detail=err.model_dump()) from exc

    try:
        body = PaymentCreateRequest.model_validate(payload)
    except ValidationError as exc:
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Invalid payment data"
        )
        raise HTTPException(status_code=400, detail=err.model_dump()) from exc

    if body.user_id != user_id:
        err = ErrorResponse(
            code=ErrorCode.UNAUTHORIZED, message="User ID mismatch"
        )
        raise HTTPException(status_code=401, detail=err.model_dump())

    if body.months < 1 or body.months > MAX_MONTHS:
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Invalid months value"
        )
        raise HTTPException(status_code=400, detail=err.model_dump())

    amount = 34900 * body.months
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
    x_sign: str | None = Header(None, alias="X-Sign"),
):
    raw_ip = request.headers.get(
        "X-Forwarded-For", request.client.host if request.client else ""
    )
    client_ip = raw_ip.split(",")[0].strip()
    if client_ip not in settings.tinkoff_ips:
        logger.warning("audit: forbidden ip %s", client_ip)
        err = ErrorResponse(
            code=ErrorCode.FORBIDDEN, message="IP address forbidden"
        )
        raise HTTPException(status_code=403, detail=err.model_dump())

    raw_body = await request.body()
    secure = os.getenv("SECURE_WEBHOOK")
    if secure and not verify_hmac(x_sign or "", raw_body, HMAC_SECRET):
        logger.warning("audit: invalid webhook signature")
        err = ErrorResponse(
            code=ErrorCode.FORBIDDEN, message="Invalid webhook signature"
        )
        raise HTTPException(status_code=403, detail=err.model_dump())

    try:
        data = json.loads(raw_body)
    except (json.JSONDecodeError, TypeError) as exc:
        logger.exception("failed to parse webhook body as JSON")
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Malformed JSON body"
        )
        raise HTTPException(status_code=400, detail=err.model_dump()) from exc
    if not isinstance(data, dict):
        logger.warning("audit: non-object webhook payload")
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Payload must be a JSON object"
        )
        raise HTTPException(status_code=400, detail=err.model_dump())
    provided_sign = data.pop("signature", "")
    expected_sign = compute_signature(HMAC_SECRET, data)
    if not hmac.compare_digest(provided_sign, expected_sign):
        logger.warning("audit: invalid payload signature")
        err = ErrorResponse(
            code=ErrorCode.FORBIDDEN, message="Invalid payload signature"
        )
        raise HTTPException(status_code=403, detail=err.model_dump())

    try:
        body = PaymentWebhook(**data, signature=provided_sign)
    except ValidationError as exc:
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Invalid webhook payload"
        )
        raise HTTPException(status_code=400, detail=err.model_dump()) from exc

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
    if body.status != "success":
        payment_fail_total.inc()
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
    x_sign: str | None = Header(None, alias="X-Sign"),
):
    raw_ip = request.headers.get(
        "X-Forwarded-For", request.client.host if request.client else ""
    )
    client_ip = raw_ip.split(",")[0].strip()
    if client_ip not in settings.tinkoff_ips:
        logger.warning("audit: forbidden ip %s", client_ip)
        err = ErrorResponse(
            code=ErrorCode.FORBIDDEN, message="IP address forbidden"
        )
        raise HTTPException(status_code=403, detail=err.model_dump())

    raw_body = await request.body()
    secure_env = os.getenv("SECURE_WEBHOOK", "")
    secure = secure_env.lower() in {"1", "true", "yes", "on"}
    if secure:
        if not verify_hmac(x_sign or "", raw_body, HMAC_SECRET):
            logger.warning("audit: invalid webhook signature")
            err = ErrorResponse(
                code=ErrorCode.FORBIDDEN, message="Invalid webhook signature"
            )
            raise HTTPException(status_code=403, detail=err.model_dump())

    try:
        data = json.loads(raw_body)
    except (json.JSONDecodeError, TypeError) as exc:
        logger.exception("failed to parse webhook body as JSON")
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Malformed JSON body"
        )
        raise HTTPException(status_code=400, detail=err.model_dump()) from exc
    if not isinstance(data, dict):
        logger.warning("audit: non-object webhook payload")
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Payload must be a JSON object"
        )
        raise HTTPException(status_code=400, detail=err.model_dump())
    provided_sign = data.pop("signature", "")
    expected_sign = compute_signature(HMAC_SECRET, data)
    if not hmac.compare_digest(provided_sign, expected_sign):
        logger.warning("audit: invalid payload signature")
        err = ErrorResponse(
            code=ErrorCode.FORBIDDEN, message="Invalid payload signature"
        )
        raise HTTPException(status_code=403, detail=err.model_dump())

    try:
        body = AutopayWebhook(**data, signature=provided_sign)
    except ValidationError as exc:
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Invalid webhook payload"
        )
        raise HTTPException(status_code=400, detail=err.model_dump()) from exc

    if body.status not in AUTOPAY_ALLOWED_STATUSES:
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Unsupported status value"
        )
        raise HTTPException(status_code=400, detail=err.model_dump())

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

    start_time = time.perf_counter()
    await asyncio.to_thread(_db_call)
    autopay_charge_seconds.observe(time.perf_counter() - start_time)
    if body.status != "success":
        payment_fail_total.inc()
    return {}


@router.post(
    "/sbp/autopay/cancel",
    status_code=204,
    responses={401: {"model": ErrorResponse}, 400: {"model": ErrorResponse}},
)
async def cancel_autopay(
    request: Request,
    user_id: int = Depends(rate_limit),
    authorization: str | None = Header(None, alias="Authorization"),
    x_csrf_token: str | None = Header(None, alias="X-CSRF-Token"),
):
    if not authorization or not authorization.lower().startswith("bearer "):
        err = ErrorResponse(
            code=ErrorCode.UNAUTHORIZED, message="Missing JWT"
        )
        raise HTTPException(status_code=401, detail=err.model_dump())
    token = authorization.split(" ", 1)[1]
    try:
        payload_jwt = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=["HS256"],
            options={"verify_exp": True},
        )
    except jwt.ExpiredSignatureError as exc:
        err = ErrorResponse(
            code=ErrorCode.UNAUTHORIZED, message="Expired JWT"
        )
        raise HTTPException(status_code=401, detail=err.model_dump()) from exc
    except jwt.PyJWTError as exc:
        err = ErrorResponse(
            code=ErrorCode.UNAUTHORIZED, message="Invalid JWT"
        )
        raise HTTPException(status_code=401, detail=err.model_dump()) from exc
    if payload_jwt.get("user_id") != user_id:
        err = ErrorResponse(
            code=ErrorCode.UNAUTHORIZED, message="User ID mismatch"
        )
        raise HTTPException(status_code=401, detail=err.model_dump())

    await validate_csrf(request, x_csrf_token)

    try:
        payload = await request.json()
    except json.JSONDecodeError as exc:
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Invalid JSON payload"
        )
        raise HTTPException(status_code=400, detail=err.model_dump()) from exc

    try:
        body = AutopayCancelRequest.model_validate(payload)
    except ValidationError as exc:
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Invalid cancel request"
        )
        raise HTTPException(status_code=400, detail=err.model_dump()) from exc

    if body.user_id != user_id:
        err = ErrorResponse(
            code=ErrorCode.UNAUTHORIZED, message="User ID mismatch"
        )
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
