from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import hmac
import jwt
import re
from datetime import datetime, timezone, timedelta
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field, ValidationError

from app import db as db_module
from app.config import Settings
from app.dependencies import (
    ErrorResponse,
    compute_signature,
    ip_allowed,
    rate_limit,
    resolve_client_ip,
)
from app.metrics import (
    autopay_amount_mismatch_total,
    autopay_charge_seconds,
    payment_amount_mismatch_total,
    payment_fail_total,
    webhook_forbidden_total,
)
from app.models import ConsentEvent, Event, Payment, User, UserConsent, ErrorCode
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from app.services import create_sbp_link
from app.services.autopay import next_retry_at, parse_retry_delays, retryable_statuses
from app.services.sbp import (
    get_sbp_status,
    map_tinkoff_status,
    remove_sbp_customer,
    tinkoff_token,
)
from app.services.telegram import (
    notify_autopay_disabled,
    notify_autopay_failure,
    notify_autopay_success,
)
from app.services.hmac import verify_hmac
from app.middleware.csrf import validate_csrf

settings = Settings()
logger = logging.getLogger(__name__)
HMAC_SECRET = settings.hmac_secret
MAX_MONTHS = 12
AUTOPAY_ALLOWED_STATUSES = {"success", "fail", "cancel", "bank_error"}
PAYMENT_ALLOWED_STATUSES = {"pending", "success", "fail", "cancel", "bank_error"}


class _ConsentRequired(Exception):
    pass


def _secure_webhook_enabled() -> bool:
    raw = os.getenv("SECURE_WEBHOOK", "")
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _has_required_consents(
    db: db_module.SessionLocal, user_id: int, *, require_autopay: bool = False
) -> bool:
    required = {
        "privacy": settings.privacy_version,
        "offer": settings.offer_version,
    }
    if require_autopay:
        required["autopay"] = settings.autopay_version
    rows = (
        db.query(UserConsent)
        .filter(UserConsent.user_id == user_id)
        .filter(UserConsent.doc_type.in_(required.keys()))
        .all()
    )
    by_type = {row.doc_type: row for row in rows}
    for doc_type, version in required.items():
        consent = by_type.get(doc_type)
        if not consent or not consent.status or consent.doc_version != version:
            return False
    return True


def _has_autopay_consent(db: db_module.SessionLocal, user_id: int) -> bool:
    consent = (
        db.query(UserConsent)
        .filter_by(user_id=user_id, doc_type="autopay")
        .first()
    )
    if not consent:
        return False
    return bool(consent.status) and consent.doc_version == settings.autopay_version


def _binding_matches_user(
    db: db_module.SessionLocal, user_id: int, binding_id: str
) -> bool:
    if not binding_id:
        return True
    payment = (
        db.query(Payment)
        .filter_by(autopay_binding_id=binding_id)
        .order_by(Payment.id.desc())
        .first()
    )
    if payment:
        return payment.user_id == user_id
    user = db.get(User, user_id)
    if user and user.autopay_rebill_id:
        return hmac.compare_digest(user.autopay_rebill_id, binding_id)
    return True


_AUTOPAY_ORDER_RE = re.compile(r"^AUTO-(\d+)-(\d{8})(?:-A(\d+))?$")


def _parse_autopay_order_id(order_id: str) -> tuple[int, str, int] | None:
    match = _AUTOPAY_ORDER_RE.match(order_id)
    if not match:
        return None
    user_id = int(match.group(1))
    cycle_key = match.group(2)
    attempt = int(match.group(3) or 1)
    return user_id, cycle_key, attempt


def _tinkoff_token_value(data: dict) -> str | None:
    token = data.get("Token")
    if isinstance(token, str):
        return token
    token = data.get("token")
    if isinstance(token, str):
        return token
    return None


def _redact_tinkoff_payload(data: dict) -> dict:
    if not isinstance(data, dict):
        return {"_raw": str(data)}
    redacted = {}
    for key, value in data.items():
        if key.lower() in {"token", "password"}:
            if isinstance(value, str) and value:
                redacted[key] = f"{value[:6]}...{value[-6:]}"
            else:
                redacted[key] = value
            continue
        if key.lower() in {"pan", "cardid", "expdate", "rebillid"}:
            redacted[key] = "***"
            continue
        redacted[key] = value
    return redacted


def _normalize_tinkoff_value(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _build_tinkoff_token_debug(data: dict) -> tuple[list[str], str]:
    fields: dict[str, object] = {}
    for key, value in data.items():
        if key == "Token":
            continue
        if value is None or isinstance(value, (dict, list)):
            continue
        fields[key] = value
    fields["Password"] = "TERMINAL_PASSWORD"
    ordered = sorted(fields)
    concat = "".join(_normalize_tinkoff_value(fields[key]) for key in ordered)
    return ordered, concat


def _is_tinkoff_notification(data: dict) -> bool:
    if not isinstance(data, dict):
        return False
    if _tinkoff_token_value(data):
        return True
    return "TerminalKey" in data or "PaymentId" in data or "OrderId" in data


def _verify_tinkoff_notification(data: dict) -> None:
    token = _tinkoff_token_value(data)
    if not token:
        logger.warning("audit: tinkoff webhook missing token")
        raise HTTPException(
            status_code=403,
            detail=ErrorResponse(
                code=ErrorCode.FORBIDDEN, message="Missing Tinkoff token"
            ).model_dump(),
        )
    expected = tinkoff_token(data, settings.tinkoff_secret_key)
    logger.warning(
        "tinkoff webhook debug: payload=%s token=%s expected=%s",
        _redact_tinkoff_payload(data),
        f"{token[:6]}...{token[-6:]}" if isinstance(token, str) and len(token) > 12 else token,
        f"{expected[:6]}...{expected[-6:]}" if isinstance(expected, str) and len(expected) > 12 else expected,
    )
    if not hmac.compare_digest(token.lower(), expected.lower()):
        ordered_keys, concat = _build_tinkoff_token_debug(data)
        token_preview = (
            f"{token[:6]}...{token[-6:]}"
            if isinstance(token, str) and len(token) > 12
            else token
        )
        expected_preview = (
            f"{expected[:6]}...{expected[-6:]}"
            if isinstance(expected, str) and len(expected) > 12
            else expected
        )
        logger.warning(
            f"audit: tinkoff webhook invalid token; "
            f"payload={_redact_tinkoff_payload(data)} "
            f"token={token_preview} expected={expected_preview} "
            f"ordered_keys={ordered_keys} "
            f"concat={concat}"
        )
        raise HTTPException(
            status_code=403,
            detail=ErrorResponse(
                code=ErrorCode.FORBIDDEN, message="Invalid Tinkoff token"
            ).model_dump(),
        )
    terminal_key = data.get("TerminalKey")
    if isinstance(terminal_key, str) and terminal_key != settings.tinkoff_terminal_key:
        logger.warning(
            "audit: tinkoff webhook terminal key mismatch (got=%s expected=%s)",
            terminal_key,
            settings.tinkoff_terminal_key,
        )
        raise HTTPException(
            status_code=403,
            detail=ErrorResponse(
                code=ErrorCode.FORBIDDEN, message="Invalid TerminalKey"
            ).model_dump(),
        )


def _extract_rebill_id(data: dict) -> str | None:
    for key in ("RebillId", "RebillID"):
        value = data.get(key)
        if isinstance(value, str) and value:
            return value
    nested = data.get("Data")
    if isinstance(nested, dict):
        for key in ("RebillId", "RebillID"):
            value = nested.get(key)
            if isinstance(value, str) and value:
                return value
    return None


def _apply_tinkoff_notification(
    data: dict,
) -> tuple[int | None, str | None, datetime | None, bool, str | None, bool, str | None]:
    order_id = data.get("OrderId") or data.get("OrderID")
    payment_id = data.get("PaymentId") or data.get("PaymentID")
    status_raw = data.get("Status")
    amount = data.get("Amount")
    if isinstance(amount, str) and amount.isdigit():
        amount = int(amount)
    rebill_id = _extract_rebill_id(data)

    if order_id is not None:
        order_id = str(order_id)
    if payment_id is not None:
        payment_id = str(payment_id)
    mapped_status = map_tinkoff_status(str(status_raw) if status_raw is not None else None)
    if not mapped_status:
        return None, None, None, False, None, False, None

    retry_delays = parse_retry_delays()
    retry_statuses = retryable_statuses()
    notify_tg_id: int | None = None
    notify_status: str | None = None
    notify_expires_at: datetime | None = None
    notify_success = False
    notify_disabled = False
    disable_reason: str | None = None
    now = datetime.now(timezone.utc)

    with db_module.SessionLocal() as db:
        payment = None
        if payment_id:
            payment = (
                db.query(Payment)
                .filter_by(provider_payment_id=payment_id)
                .first()
            )
        if not payment and order_id:
            payment = db.query(Payment).filter_by(external_id=order_id).first()

        parsed = _parse_autopay_order_id(order_id) if order_id else None
        if not payment and parsed:
            user_id, cycle_key, attempt = parsed
            payment = Payment(
                user_id=user_id,
                amount=amount if isinstance(amount, int) else settings.pro_month_price_cents,
                currency="RUB",
                provider="tinkoff",
                external_id=order_id,
                provider_payment_id=payment_id,
                autopay_charge_id=payment_id,
                prolong_months=1,
                status="pending",
                autopay=True,
                autopay_binding_id=rebill_id,
                autopay_cycle_key=cycle_key,
                autopay_attempt=attempt,
            )
            if mapped_status in retry_statuses:
                payment.autopay_next_retry_at = next_retry_at(
                    attempt, now, retry_delays
                )
            db.add(payment)
        if not payment:
            logger.warning("audit: tinkoff webhook payment not found: %s", order_id)
            return None, None, None, False, None, False, None

        if payment_id and not payment.provider_payment_id:
            payment.provider_payment_id = payment_id
        if payment.autopay and payment_id:
            payment.autopay_charge_id = payment_id

        if parsed and payment.autopay:
            user_id, cycle_key, attempt = parsed
            if not payment.autopay_cycle_key:
                payment.autopay_cycle_key = cycle_key
            if not payment.autopay_attempt:
                payment.autopay_attempt = attempt

        if rebill_id and payment.autopay:
            payment.autopay_binding_id = rebill_id

        prev_status = payment.status
        if prev_status == mapped_status:
            db.commit()
            return None, None, None, False, mapped_status, False, None

        if isinstance(amount, int) and payment.amount:
            if amount != payment.amount:
                db.add(
                    Event(user_id=payment.user_id, event="payment_amount_mismatch")
                )
                payment_amount_mismatch_total.inc()
                if payment.autopay:
                    db.add(
                        Event(
                            user_id=payment.user_id,
                            event="autopay_amount_mismatch",
                        )
                    )
                    autopay_amount_mismatch_total.inc()
                    user = db.get(User, payment.user_id)
                    if user and user.autopay_enabled:
                        user.autopay_enabled = False
                        db.add(user)
                        db.add(
                            Event(
                                user_id=payment.user_id,
                                event="autopay_disabled_amount_mismatch",
                            )
                        )
                        notify_disabled = True
                        disable_reason = "amount_mismatch"
                mapped_status = "bank_error"

        _apply_payment_status(db, payment, mapped_status, now)

        if payment.autopay:
            user = db.get(User, payment.user_id)
            if mapped_status == "success":
                consent_ok = _has_autopay_consent(db, payment.user_id)
                if rebill_id and user:
                    user.autopay_rebill_id = rebill_id
                if user and consent_ok:
                    user.autopay_enabled = True
                if user:
                    notify_tg_id = user.tg_id
                    notify_expires_at = user.pro_expires_at
                    notify_success = True
                if not consent_ok:
                    db.add(Event(user_id=payment.user_id, event="autopay_consent_missing"))
            else:
                if mapped_status in retry_statuses:
                    payment.autopay_next_retry_at = next_retry_at(
                        payment.autopay_attempt or 1,
                        now,
                        retry_delays,
                    )
                db.add(Event(user_id=payment.user_id, event="autopay_fail"))
                if user:
                    notify_tg_id = user.tg_id
                    notify_status = mapped_status
        db.commit()

    return (
        notify_tg_id,
        notify_status,
        notify_expires_at,
        notify_success,
        mapped_status,
        notify_disabled,
        disable_reason,
    )

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
    sbp_url: str | None = None


class PaymentStatusResponse(BaseModel):
    status: str
    pro_expires_at: datetime | None = None


def _resolve_user_utm(user: User | None) -> tuple[str | None, str | None, str | None]:
    if not user:
        return None, None, None
    if not user.utm_source and not user.utm_medium and not user.utm_campaign:
        return "direct", "organic", None
    return user.utm_source, user.utm_medium, user.utm_campaign


def _build_utm_event(user_id: int, user: User | None, event: str) -> Event:
    utm_source, utm_medium, utm_campaign = _resolve_user_utm(user)
    return Event(
        user_id=user_id,
        event=event,
        utm_source=utm_source,
        utm_medium=utm_medium,
        utm_campaign=utm_campaign,
    )


def _apply_payment_status(
    db: db_module.SessionLocal, payment: Payment, status: str, paid_at: datetime
) -> bool:
    prev_status = payment.status
    prev_updated_at = payment.updated_at
    if prev_status == status:
        return False
    if prev_status == "success" and status not in {"cancel", "fail", "bank_error"}:
        return False
    payment.status = status
    payment.updated_at = datetime.now(timezone.utc)
    db.add(payment)

    if status == "success":
        months = payment.prolong_months or 0
        user = db.get(User, payment.user_id)
        current_exp = user.pro_expires_at if user and user.pro_expires_at else paid_at
        if isinstance(current_exp, str):
            current_exp = datetime.fromisoformat(current_exp)
        if current_exp.tzinfo is None:
            current_exp = current_exp.replace(tzinfo=timezone.utc)
        if current_exp < paid_at:
            current_exp = paid_at
        new_exp = current_exp + timedelta(days=30 * months)
        if user:
            user.pro_expires_at = new_exp
            db.add(user)
        db.add(_build_utm_event(payment.user_id, user, "payment_success"))
        db.add(Event(user_id=payment.user_id, event="pro_activated"))
    else:
        if prev_status == "success":
            user = db.get(User, payment.user_id)
            if user:
                success_at = prev_updated_at or paid_at
                if isinstance(success_at, str):
                    success_at = datetime.fromisoformat(success_at)
                if success_at.tzinfo is None:
                    success_at = success_at.replace(tzinfo=timezone.utc)
                newer_success = (
                    db.query(Payment.id)
                    .filter(
                        Payment.user_id == payment.user_id,
                        Payment.status == "success",
                        Payment.id != payment.id,
                        Payment.updated_at > success_at,
                    )
                    .first()
                )
                if not newer_success:
                    current_exp = user.pro_expires_at or paid_at
                    if isinstance(current_exp, str):
                        current_exp = datetime.fromisoformat(current_exp)
                    if current_exp.tzinfo is None:
                        current_exp = current_exp.replace(tzinfo=timezone.utc)
                    months = payment.prolong_months or 0
                    new_exp = (
                        current_exp - timedelta(days=30 * months)
                        if months
                        else paid_at
                    )
                    user.pro_expires_at = new_exp
                    db.add(user)
        db.add(Event(user_id=payment.user_id, event="payment_fail"))
    return True


@router.post(
    "/create",
    response_model=PaymentCreateResponse,
    responses={401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}},
)
async def create_payment(
    request: Request,
    user_id: int = Depends(rate_limit),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
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

    def _preflight() -> Payment | None:
        with db_module.SessionLocal() as db:
            if not _has_required_consents(
                db,
                user_id,
                require_autopay=bool(body.autopay),
            ):
                raise _ConsentRequired()
            if idempotency_key:
                existing = (
                    db.query(Payment)
                    .filter_by(user_id=user_id, idempotency_key=idempotency_key)
                    .first()
                )
                if existing and existing.payment_url:
                    return existing
        return None

    try:
        existing = await asyncio.to_thread(_preflight)
    except _ConsentRequired as exc:
        err = ErrorResponse(
            code=ErrorCode.FORBIDDEN, message="CONSENT_REQUIRED"
        )
        raise HTTPException(status_code=403, detail=err.model_dump()) from exc

    if existing:
        return PaymentCreateResponse(
            payment_id=existing.external_id,
            url=existing.payment_url,
            autopay_binding_id=existing.autopay_binding_id,
            sbp_url=existing.sbp_url,
        )

    amount = settings.pro_month_price_cents * body.months
    currency = "RUB"
    external_id = uuid4().hex
    customer_key = str(user_id) if body.autopay else None
    link = await create_sbp_link(
        external_id,
        amount,
        currency,
        autopay=bool(body.autopay),
        customer_key=customer_key,
    )

    def _db_call() -> Payment | None:
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
                autopay_binding_id=link.binding_id,
                provider_payment_id=link.provider_payment_id,
                idempotency_key=idempotency_key,
                payment_url=link.url,
                sbp_url=link.sbp_url,
            )
            db.add(payment)
            db.add(Event(user_id=body.user_id, event="payment_created"))
            try:
                db.commit()
                return None
            except IntegrityError:
                if not idempotency_key:
                    raise
                db.rollback()
                return (
                    db.query(Payment)
                    .filter_by(user_id=user_id, idempotency_key=idempotency_key)
                    .first()
                )

    existing = await asyncio.to_thread(_db_call)
    if existing and existing.payment_url:
        return PaymentCreateResponse(
            payment_id=existing.external_id,
            url=existing.payment_url,
            autopay_binding_id=existing.autopay_binding_id,
            sbp_url=existing.sbp_url,
        )
    return PaymentCreateResponse(
        payment_id=external_id,
        url=link.url,
        autopay_binding_id=link.binding_id,
        sbp_url=link.sbp_url,
    )


@router.get(
    "/{payment_id}",
    response_model=PaymentStatusResponse,
    responses={401: {"model": ErrorResponse}, 404: {"description": "Not found"}},
)
async def payment_status(payment_id: str, user_id: int = Depends(rate_limit)):
    def _db_call() -> tuple[str, datetime | None, str | None]:
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
            return payment.status, exp, payment.provider_payment_id

    status, exp, provider_payment_id = await asyncio.to_thread(_db_call)

    if status == "pending" and provider_payment_id:
        provider_status, paid_at, rebill_id = await get_sbp_status(provider_payment_id)
        if provider_status and paid_at:
            def _db_apply() -> tuple[str, datetime | None, bool]:
                with db_module.SessionLocal() as db:
                    payment = (
                        db.query(Payment)
                        .filter_by(external_id=payment_id, user_id=user_id)
                        .first()
                    )
                    if not payment:
                        raise HTTPException(status_code=404, detail="NOT_FOUND")
                    changed = _apply_payment_status(
                        db, payment, provider_status, paid_at
                    )
                    user = db.get(User, payment.user_id)
                    if (
                        changed
                        and provider_status == "success"
                        and payment.autopay
                    ):
                        if rebill_id:
                            payment.autopay_binding_id = rebill_id
                            if user:
                                user.autopay_rebill_id = rebill_id
                                if _has_autopay_consent(db, payment.user_id):
                                    user.autopay_enabled = True
                                else:
                                    db.add(
                                        Event(
                                            user_id=payment.user_id,
                                            event="autopay_consent_missing",
                                        )
                                    )
                                db.add(user)
                        else:
                            db.add(
                                Event(
                                    user_id=payment.user_id,
                                    event="autopay_rebill_missing",
                                )
                            )
                    exp = user.pro_expires_at if user else None
                    db.commit()
                    return payment.status, exp, changed

            status, exp, changed = await asyncio.to_thread(_db_apply)
            if changed and status != "success":
                payment_fail_total.inc()

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
    x_sign: str | None = Header(None, alias="X-Sign"),
):
    client_ip = resolve_client_ip(request, settings.trusted_proxies)
    if not ip_allowed(client_ip, settings.tinkoff_ips):
        logger.warning("audit: forbidden ip %s", client_ip)
        webhook_forbidden_total.inc()
        err = ErrorResponse(
            code=ErrorCode.FORBIDDEN, message="IP address forbidden"
        )
        raise HTTPException(status_code=403, detail=err.model_dump())

    raw_body = await request.body()
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

    if _is_tinkoff_notification(data):
        _verify_tinkoff_notification(data)
        (
            notify_tg_id,
            notify_status,
            notify_exp,
            notify_success,
            applied_status,
            notify_disabled,
            disable_reason,
        ) = await asyncio.to_thread(_apply_tinkoff_notification, data)
        if notify_status and notify_tg_id:
            await notify_autopay_failure(notify_tg_id, notify_status)
        if notify_success and notify_tg_id:
            await notify_autopay_success(notify_tg_id, notify_exp)
        if notify_disabled and notify_tg_id:
            await notify_autopay_disabled(notify_tg_id, disable_reason)
        if applied_status and applied_status != "success":
            payment_fail_total.inc()
        return Response(content="OK")

    secure = _secure_webhook_enabled()
    if secure and not verify_hmac(x_sign or "", raw_body, HMAC_SECRET):
        logger.warning("audit: invalid webhook signature")
        webhook_forbidden_total.inc()
        err = ErrorResponse(
            code=ErrorCode.FORBIDDEN, message="Invalid webhook signature"
        )
        raise HTTPException(status_code=403, detail=err.model_dump())

    provided_sign = data.pop("signature", "")
    expected_sign = compute_signature(HMAC_SECRET, data)
    if not hmac.compare_digest(provided_sign, expected_sign):
        logger.warning("audit: invalid payload signature")
        webhook_forbidden_total.inc()
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
    if body.status not in PAYMENT_ALLOWED_STATUSES:
        err = ErrorResponse(
            code=ErrorCode.BAD_REQUEST, message="Unsupported status value"
        )
        raise HTTPException(status_code=400, detail=err.model_dump())

    def _db_call() -> None:
        with db_module.SessionLocal() as db:
            payment = db.query(Payment).filter_by(external_id=body.external_id).first()
            if not payment:
                raise HTTPException(status_code=404, detail="NOT_FOUND")
            _apply_payment_status(db, payment, body.status, body.paid_at)

            db.commit()

    await asyncio.to_thread(_db_call)
    if body.status != "success":
        payment_fail_total.inc()
    return Response(content="OK")


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
    x_sign: str | None = Header(None, alias="X-Sign"),
):
    client_ip = resolve_client_ip(request, settings.trusted_proxies)
    if not ip_allowed(client_ip, settings.tinkoff_ips):
        logger.warning("audit: forbidden ip %s", client_ip)
        webhook_forbidden_total.inc()
        err = ErrorResponse(
            code=ErrorCode.FORBIDDEN, message="IP address forbidden"
        )
        raise HTTPException(status_code=403, detail=err.model_dump())

    raw_body = await request.body()
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

    if _is_tinkoff_notification(data):
        _verify_tinkoff_notification(data)
        (
            notify_tg_id,
            notify_status,
            notify_exp,
            notify_success,
            applied_status,
            notify_disabled,
            disable_reason,
        ) = await asyncio.to_thread(_apply_tinkoff_notification, data)
        if notify_status and notify_tg_id:
            await notify_autopay_failure(notify_tg_id, notify_status)
        if notify_success and notify_tg_id:
            await notify_autopay_success(notify_tg_id, notify_exp)
        if notify_disabled and notify_tg_id:
            await notify_autopay_disabled(notify_tg_id, disable_reason)
        if applied_status and applied_status != "success":
            payment_fail_total.inc()
        return Response(content="OK")

    secure = _secure_webhook_enabled()
    if secure and not verify_hmac(x_sign or "", raw_body, HMAC_SECRET):
        logger.warning("audit: invalid webhook signature")
        webhook_forbidden_total.inc()
        err = ErrorResponse(
            code=ErrorCode.FORBIDDEN, message="Invalid webhook signature"
        )
        raise HTTPException(status_code=403, detail=err.model_dump())

    provided_sign = data.pop("signature", "")
    expected_sign = compute_signature(HMAC_SECRET, data)
    if not hmac.compare_digest(provided_sign, expected_sign):
        logger.warning("audit: invalid payload signature")
        webhook_forbidden_total.inc()
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

    if body.binding_id:
        def _binding_check() -> bool:
            with db_module.SessionLocal() as db:
                return _binding_matches_user(db, body.user_id, body.binding_id)

        binding_ok = await asyncio.to_thread(_binding_check)
        if not binding_ok:
            logger.warning(
                "audit: autopay webhook binding mismatch user=%s binding=%s",
                body.user_id,
                body.binding_id,
            )
            err = ErrorResponse(
                code=ErrorCode.FORBIDDEN, message="Binding mismatch"
            )
            raise HTTPException(status_code=403, detail=err.model_dump())

    retry_delays = parse_retry_delays()
    retry_statuses = retryable_statuses()

    def _db_call() -> tuple[int | None, str | None, datetime | None, bool]:
        notify_tg_id: int | None = None
        notify_status: str | None = None
        notify_expires_at: datetime | None = None
        notify_success = False
        with db_module.SessionLocal() as db:
            expected_amount = settings.pro_month_price_cents
            if body.binding_id:
                binding_payment = (
                    db.query(Payment)
                    .filter_by(autopay_binding_id=body.binding_id)
                    .order_by(Payment.id.desc())
                    .first()
                )
                if binding_payment and binding_payment.amount:
                    expected_amount = binding_payment.amount
            amount_mismatch = body.amount != expected_amount
            if amount_mismatch:
                logger.warning(
                    "audit: unexpected autopay amount %s (expected %s)",
                    body.amount,
                    expected_amount,
                )
                db.add(
                    Event(
                        user_id=body.user_id,
                        event="autopay_amount_mismatch",
                    )
                )
            payment = (
                db.query(Payment)
                .filter_by(autopay_charge_id=body.autopay_charge_id)
                .first()
            )
            prev_status = payment.status if payment else None
            if payment and prev_status == body.status:
                return None, None, None, False
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
                if prev_status == "success":
                    return None, None, None, False
                payment.status = body.status
                payment.updated_at = datetime.now(timezone.utc)
                payment.autopay = True
                payment.autopay_binding_id = body.binding_id
                payment.autopay_charge_id = body.autopay_charge_id
                db.add(payment)

            if body.status == "success" and prev_status != "success":
                autopay_consent_ok = _has_autopay_consent(db, body.user_id)
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
                    if body.binding_id and not user.autopay_rebill_id:
                        user.autopay_rebill_id = body.binding_id
                    if autopay_consent_ok:
                        user.autopay_enabled = True
                    db.add(user)
                    notify_tg_id = user.tg_id
                    notify_expires_at = new_exp
                    notify_success = True
                if not autopay_consent_ok:
                    db.add(Event(user_id=body.user_id, event="autopay_consent_missing"))
                db.add(_build_utm_event(body.user_id, user, "payment_success"))
                db.add(Event(user_id=body.user_id, event="pro_activated"))
            else:
                db.add(Event(user_id=body.user_id, event="autopay_fail"))
                if body.status in retry_statuses:
                    payment.autopay_next_retry_at = next_retry_at(
                        payment.autopay_attempt or 1,
                        body.charged_at,
                        retry_delays,
                    )
                    db.add(payment)
                if prev_status != body.status:
                    user = db.get(User, body.user_id)
                    if user:
                        notify_tg_id = user.tg_id
                        notify_status = body.status

            db.commit()
        return notify_tg_id, notify_status, notify_expires_at, notify_success

    start_time = time.perf_counter()
    notify_tg_id, notify_status, notify_expires_at, notify_success = (
        await asyncio.to_thread(_db_call)
    )
    autopay_charge_seconds.observe(time.perf_counter() - start_time)
    if body.status != "success":
        payment_fail_total.inc()
        if notify_tg_id:
            await notify_autopay_failure(notify_tg_id, notify_status)
    elif notify_tg_id and notify_success:
        await notify_autopay_success(notify_tg_id, notify_expires_at)
    return Response(content="OK")


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
                user.autopay_rebill_id = None
                db.add(user)
            db.add(Event(user_id=body.user_id, event="autopay_disabled"))
            db.add(
                ConsentEvent(
                    user_id=body.user_id,
                    doc_type="autopay",
                    doc_version=settings.autopay_version,
                    action="revoke",
                    source="api",
                    meta={"reason": "cancel"},
                )
            )
            db.execute(
                text(
                    """
                    INSERT INTO user_consents
                        (user_id, doc_type, doc_version, status, source, updated_at)
                    VALUES
                        (:user_id, :doc_type, :doc_version, :status, :source, CURRENT_TIMESTAMP)
                    ON CONFLICT (user_id, doc_type)
                    DO UPDATE SET doc_version = EXCLUDED.doc_version,
                                  status = EXCLUDED.status,
                                  source = EXCLUDED.source,
                                  updated_at = EXCLUDED.updated_at
                    """
                ),
                {
                    "user_id": body.user_id,
                    "doc_type": "autopay",
                    "doc_version": settings.autopay_version,
                    "status": False,
                    "source": "api",
                },
            )
            db.commit()

    await asyncio.to_thread(_db_call)

    cancel_result = await remove_sbp_customer(str(body.user_id))
    if cancel_result is not None:

        def _log_event(event: str) -> None:
            with db_module.SessionLocal() as db:
                db.add(Event(user_id=body.user_id, event=event))
                db.commit()

        event_name = (
            "autopay_provider_cancelled"
            if cancel_result
            else "autopay_provider_cancel_failed"
        )
        await asyncio.to_thread(_log_event, event_name)
    return Response(status_code=204)
