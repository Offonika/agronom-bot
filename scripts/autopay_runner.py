from __future__ import annotations

import argparse
import asyncio
import os
from datetime import datetime, timedelta, timezone

from app.config import Settings
from app.controllers.payments import _apply_payment_status, _has_autopay_consent
from app.db import SessionLocal, init_db
from app.models import Event, Payment, User
from app.services.autopay import (
    autopay_cycle_key,
    max_attempts,
    next_retry_at,
    parse_retry_delays,
    retry_due,
    retryable_statuses,
)
from app.services.sbp import charge_rebill, get_sbp_status, map_tinkoff_status
from app.services.telegram import (
    notify_autopay_disabled,
    notify_autopay_failure,
    notify_autopay_success,
)
from sqlalchemy.exc import IntegrityError


def _price_cents() -> int:
    raw = os.getenv("PRO_MONTH_PRICE_CENTS", "19900")
    try:
        return int(raw)
    except ValueError:
        return 19900


def _pending_ttl_minutes() -> int:
    raw = os.getenv("AUTOPAY_PENDING_TTL_MINUTES", "15")
    try:
        value = int(raw)
    except ValueError:
        return 15
    return value if value > 0 else 15


def _ensure_utc(value: datetime | None) -> datetime | None:
    if not value:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _manual_block_hours() -> int:
    raw = os.getenv("AUTOPAY_MANUAL_BLOCK_HOURS", "24")
    try:
        value = int(raw)
    except ValueError:
        return 24
    return value if value > 0 else 0


def _due_users(cutoff: datetime) -> list[User]:
    with SessionLocal() as db:
        query = (
            db.query(User)
            .filter(User.autopay_enabled.is_(True))
            .filter(User.autopay_rebill_id.isnot(None))
            .filter(
                (User.pro_expires_at.is_(None)) | (User.pro_expires_at <= cutoff)
            )
        )
        return list(query.all())


def _pending_autopay_payments() -> list[int]:
    with SessionLocal() as db:
        rows = (
            db.query(Payment.id)
            .filter_by(status="pending", autopay=True)
            .filter(Payment.provider_payment_id.isnot(None))
            .all()
        )
        return [row[0] for row in rows]


def _has_pending_manual_payment(user_id: int, since: datetime) -> bool:
    with SessionLocal() as db:
        amount_min = _price_cents()
        return (
            db.query(Payment.id)
            .filter_by(user_id=user_id, status="pending", autopay=False)
            .filter(Payment.created_at >= since)
            .filter(Payment.prolong_months.isnot(None))
            .filter(Payment.prolong_months > 0)
            .filter(Payment.amount >= amount_min)
            .first()
            is not None
        )


def _log_pending_manual_skip(user_id: int, since: datetime) -> None:
    with SessionLocal() as db:
        exists = (
            db.query(Event.id)
            .filter_by(user_id=user_id, event="autopay_skipped_manual_pending")
            .filter(Event.ts >= since)
            .first()
        )
        if exists:
            return
        db.add(Event(user_id=user_id, event="autopay_skipped_manual_pending"))
        db.commit()


def _load_autopay_attempts(user_id: int, cycle_key: str) -> list[Payment]:
    with SessionLocal() as db:
        rows = (
            db.query(Payment)
            .filter_by(user_id=user_id, autopay=True, autopay_cycle_key=cycle_key)
            .order_by(Payment.autopay_attempt.asc())
            .all()
        )
        return list(rows)


def _reserve_autopay_payment(
    *,
    user: User,
    cycle_key: str,
    attempt: int,
    order_id: str,
    amount: int,
) -> int | None:
    with SessionLocal() as db:
        payment = Payment(
            user_id=user.id,
            amount=amount,
            currency="RUB",
            provider="tinkoff",
            external_id=order_id,
            idempotency_key=order_id,
            autopay=True,
            autopay_binding_id=user.autopay_rebill_id,
            autopay_cycle_key=cycle_key,
            autopay_attempt=attempt,
            status="pending",
            prolong_months=1,
        )
        db.add(payment)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            return None
        return payment.id


def _store_autopay_result(
    *,
    payment_id: int,
    provider_payment_id: str | None,
    status: str,
    now: datetime,
    retry_delays: list[timedelta],
    retry_statuses: set[str],
    log_request: bool,
) -> tuple[int | None, str, datetime | None]:
    with SessionLocal() as db:
        payment = db.get(Payment, payment_id)
        if not payment:
            return None, status, None
        if provider_payment_id:
            payment.provider_payment_id = provider_payment_id
            payment.autopay_charge_id = provider_payment_id
        if log_request:
            db.add(Event(user_id=payment.user_id, event="autopay_charge_requested"))
        if status != "pending":
            _apply_payment_status(db, payment, status, now)
        if status in retry_statuses:
            payment.autopay_next_retry_at = next_retry_at(
                payment.autopay_attempt or 1,
                now,
                retry_delays,
            )
        exp = None
        tg_id = None
        if status == "success":
            user = db.get(User, payment.user_id)
            if user:
                exp = user.pro_expires_at
                tg_id = user.tg_id
        elif status in {"fail", "cancel", "bank_error"}:
            user = db.get(User, payment.user_id)
            if user:
                tg_id = user.tg_id
        db.commit()
        return tg_id, payment.status, exp


def _mark_stale_pending(payment_id: int, now: datetime) -> None:
    with SessionLocal() as db:
        payment = db.get(Payment, payment_id)
        if not payment:
            return
        payment.status = "bank_error"
        payment.autopay_next_retry_at = now
        db.add(payment)
        db.add(Event(user_id=payment.user_id, event="autopay_charge_stale"))
        db.commit()


def _disable_autopay(user_id: int, reason: str) -> int | None:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        if not user or not user.autopay_enabled:
            return None
        user.autopay_enabled = False
        db.add(user)
        db.add(Event(user_id=user_id, event=reason))
        db.commit()
        return user.tg_id


async def _charge_user(
    user: User,
    *,
    now: datetime,
    dry_run: bool,
    retry_delays: list[timedelta],
    retry_statuses: set[str],
    max_retry_attempts: int,
    pending_ttl: timedelta,
) -> None:
    if not user.autopay_rebill_id:
        return
    block_hours = _manual_block_hours()
    if block_hours:
        since = now - timedelta(hours=block_hours)
        if await asyncio.to_thread(_has_pending_manual_payment, user.id, since):
            await asyncio.to_thread(_log_pending_manual_skip, user.id, since)
            return
    due_at = user.pro_expires_at or now
    if isinstance(due_at, str):
        due_at = datetime.fromisoformat(due_at)
    if due_at.tzinfo is None:
        due_at = due_at.replace(tzinfo=timezone.utc)
    cycle_key = autopay_cycle_key(due_at)
    attempts = _load_autopay_attempts(user.id, cycle_key)
    stale_pending: Payment | None = None
    for attempt in attempts:
        if attempt.status == "success":
            return
        if attempt.status == "pending":
            if attempt.provider_payment_id:
                return
            created_at = _ensure_utc(attempt.created_at)
            if created_at and (now - created_at) < pending_ttl:
                return
            stale_pending = attempt
            break
    if stale_pending:
        await asyncio.to_thread(_mark_stale_pending, stale_pending.id, now)
        stale_pending.status = "bank_error"
        stale_pending.autopay_next_retry_at = now
    attempt_num = 1
    if attempts:
        last_attempt = attempts[-1]
        if last_attempt.status not in retry_statuses:
            return
        if not retry_due(
            attempt=last_attempt.autopay_attempt,
            created_at=last_attempt.created_at,
            next_retry_at_value=last_attempt.autopay_next_retry_at,
            now=now,
            delays=retry_delays,
        ):
            return
        attempt_num = (last_attempt.autopay_attempt or 1) + 1
        if attempt_num > max_retry_attempts:
            tg_id = await asyncio.to_thread(
                _disable_autopay, user.id, "autopay_retry_exhausted"
            )
            if tg_id:
                await notify_autopay_disabled(tg_id, "retry_exhausted")
            return

    order_id = f"AUTO-{user.id}-{cycle_key}-A{attempt_num}"
    if dry_run:
        print(f"[dry-run] charge user={user.id} order_id={order_id}")
        return

    def _consent_ok() -> bool:
        with SessionLocal() as db:
            ok = _has_autopay_consent(db, user.id)
            if not ok:
                db.add(Event(user_id=user.id, event="autopay_consent_missing"))
                db.commit()
            return ok

    if not await asyncio.to_thread(_consent_ok):
        return

    reserved_id = await asyncio.to_thread(
        _reserve_autopay_payment,
        user=user,
        cycle_key=cycle_key,
        attempt=attempt_num,
        order_id=order_id,
        amount=_price_cents(),
    )
    if not reserved_id:
        return

    payment_id, raw_status = await charge_rebill(
        order_id=order_id,
        amount=_price_cents(),
        rebill_id=user.autopay_rebill_id,
        customer_key=str(user.id),
        description=os.getenv("SBP_TINKOFF_DESCRIPTION", "Agronom Pro"),
    )
    if not payment_id:
        def _log_fail() -> None:
            with SessionLocal() as db:
                payment = db.get(Payment, reserved_id)
                if payment:
                    payment.status = "bank_error"
                    payment.autopay_next_retry_at = next_retry_at(
                        payment.autopay_attempt or 1,
                        now,
                        retry_delays,
                    )
                    db.add(payment)
                db.add(Event(user_id=user.id, event="autopay_charge_failed"))
                db.commit()

        await asyncio.to_thread(_log_fail)
        if user.tg_id:
            await notify_autopay_failure(user.tg_id, "bank_error")
        return

    mapped_status = map_tinkoff_status(raw_status)
    status = mapped_status or "pending"

    tg_id, applied_status, exp = await asyncio.to_thread(
        _store_autopay_result,
        payment_id=reserved_id,
        provider_payment_id=payment_id,
        status=status,
        now=now,
        retry_delays=retry_delays,
        retry_statuses=retry_statuses,
        log_request=True,
    )
    if applied_status in {"fail", "cancel", "bank_error"} and tg_id:
        await notify_autopay_failure(tg_id, applied_status)
    if applied_status == "success" and tg_id:
        await notify_autopay_success(tg_id, exp)


async def _sync_pending_payment(
    payment_id: int,
    *,
    retry_delays: list[timedelta],
    retry_statuses: set[str],
    pending_ttl: timedelta,
) -> None:
    def _load() -> tuple[int, str | None, datetime | None]:
        with SessionLocal() as db:
            payment = db.get(Payment, payment_id)
            if not payment:
                return 0, None, None
            return payment.id, payment.provider_payment_id, payment.created_at

    pid, provider_payment_id, created_at = await asyncio.to_thread(_load)
    if not pid or not provider_payment_id:
        return
    status, paid_at, _rebill_id = await get_sbp_status(provider_payment_id)
    if not status or not paid_at:
        created_at = _ensure_utc(created_at)
        if created_at and (datetime.now(timezone.utc) - created_at) >= pending_ttl:
            await asyncio.to_thread(
                _mark_stale_pending, payment_id, datetime.now(timezone.utc)
            )
        return

    def _apply() -> tuple[int | None, str, datetime | None]:
        with SessionLocal() as db:
            payment = db.get(Payment, pid)
            if not payment:
                return None, status, None
            _apply_payment_status(db, payment, status, paid_at)
            if status in retry_statuses:
                payment.autopay_next_retry_at = next_retry_at(
                    payment.autopay_attempt or 1,
                    paid_at,
                    retry_delays,
                )
                db.add(payment)
            user = db.get(User, payment.user_id)
            exp = user.pro_expires_at if user else None
            db.commit()
            return user.tg_id if user else None, status, exp

    tg_id, applied_status, exp = await asyncio.to_thread(_apply)
    if applied_status in {"fail", "cancel", "bank_error"} and tg_id:
        await notify_autopay_failure(tg_id, applied_status)
    if applied_status == "success" and tg_id:
        await notify_autopay_success(tg_id, exp)


async def main() -> None:
    parser = argparse.ArgumentParser(description="Run recurring autopay charges.")
    parser.add_argument("--dry-run", action="store_true", help="Do not charge, log only")
    parser.add_argument("--lead-days", type=int, default=None, help="Charge before expiry")
    args = parser.parse_args()

    init_db(Settings())

    lead_days = (
        args.lead_days
        if args.lead_days is not None
        else int(os.getenv("AUTOPAY_LEAD_DAYS", "0"))
    )
    retry_delays = parse_retry_delays()
    retry_statuses = retryable_statuses()
    max_retry_attempts = max_attempts(retry_delays)
    pending_ttl = timedelta(minutes=_pending_ttl_minutes())
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(days=lead_days)
    users = _due_users(cutoff)
    for user in users:
        await _charge_user(
            user,
            now=now,
            dry_run=args.dry_run,
            retry_delays=retry_delays,
            retry_statuses=retry_statuses,
            max_retry_attempts=max_retry_attempts,
            pending_ttl=pending_ttl,
        )

    pending_ids = _pending_autopay_payments()
    for payment_id in pending_ids:
        await _sync_pending_payment(
            payment_id,
            retry_delays=retry_delays,
            retry_statuses=retry_statuses,
            pending_ttl=pending_ttl,
        )


if __name__ == "__main__":
    asyncio.run(main())
