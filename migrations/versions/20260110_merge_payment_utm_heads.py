"""merge payment idempotency + analytics utm heads

Revision ID: 20260110_merge_payment_utm_heads
Revises: 20260105_add_payment_idempotency, 20260110_add_analytics_events_utm
Create Date: 2026-01-10 12:30:00.000000
"""

from alembic import op  # noqa: F401
import sqlalchemy as sa  # noqa: F401


revision = "20260110_merge_payment_utm_heads"
down_revision = ("20260105_add_payment_idempotency", "20260110_add_analytics_events_utm")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
