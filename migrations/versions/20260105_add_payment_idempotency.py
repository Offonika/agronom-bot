"""add payment idempotency fields

Revision ID: 20260105_add_payment_idempotency
Revises: 20251231_add_consents
Create Date: 2026-01-05 12:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260105_add_payment_idempotency"
down_revision = "20251231_add_consents"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("payments") as batch_op:
        batch_op.add_column(sa.Column("idempotency_key", sa.String(), nullable=True))
        batch_op.add_column(sa.Column("payment_url", sa.String(), nullable=True))
        batch_op.add_column(sa.Column("sbp_url", sa.String(), nullable=True))
        batch_op.create_unique_constraint(
            "uq_payments_user_idempotency", ["user_id", "idempotency_key"]
        )
        batch_op.create_index(
            "ix_payments_idempotency_key", ["idempotency_key"], unique=False
        )


def downgrade() -> None:
    with op.batch_alter_table("payments") as batch_op:
        batch_op.drop_index("ix_payments_idempotency_key")
        batch_op.drop_constraint("uq_payments_user_idempotency", type_="unique")
        batch_op.drop_column("sbp_url")
        batch_op.drop_column("payment_url")
        batch_op.drop_column("idempotency_key")
