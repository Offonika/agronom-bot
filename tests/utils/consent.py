from __future__ import annotations

from datetime import datetime, timezone

from app.config import Settings
from app.models import UserConsent


def ensure_base_consents(session, user_id: int) -> None:
    settings = Settings()
    now = datetime.now(timezone.utc)
    base = [
        ("privacy", settings.privacy_version),
        ("offer", settings.offer_version),
    ]
    for doc_type, version in base:
        session.merge(
            UserConsent(
                user_id=user_id,
                doc_type=doc_type,
                doc_version=version,
                status=True,
                source="test",
                updated_at=now,
            )
        )
    session.commit()


def ensure_autopay_consent(session, user_id: int) -> None:
    settings = Settings()
    now = datetime.now(timezone.utc)
    session.merge(
        UserConsent(
            user_id=user_id,
            doc_type="autopay",
            doc_version=settings.autopay_version,
            status=True,
            source="test",
            updated_at=now,
        )
    )
    session.commit()
