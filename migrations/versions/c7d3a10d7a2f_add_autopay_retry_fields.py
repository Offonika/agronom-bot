"""add autopay retry fields to payments

Revision ID: c7d3a10d7a2f
Revises: 9b739287971f
Create Date: 2025-11-22 00:00:00
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "c7d3a10d7a2f"
down_revision = "9b739287971f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("payments", sa.Column("autopay_cycle_key", sa.String(), nullable=True))
    op.add_column("payments", sa.Column("autopay_attempt", sa.Integer(), nullable=True))
    op.add_column(
        "payments", sa.Column("autopay_next_retry_at", sa.DateTime(), nullable=True)
    )
    op.create_unique_constraint(
        "uq_payments_autopay_cycle_attempt",
        "payments",
        ["user_id", "autopay_cycle_key", "autopay_attempt"],
    )
    op.create_index(
        "ix_payments_autopay_cycle_key",
        "payments",
        ["user_id", "autopay_cycle_key"],
    )
    op.create_index(
        "ix_payments_autopay_next_retry_at",
        "payments",
        ["autopay_next_retry_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_payments_autopay_next_retry_at", table_name="payments")
    op.drop_index("ix_payments_autopay_cycle_key", table_name="payments")
    op.drop_constraint(
        "uq_payments_autopay_cycle_attempt", "payments", type_="unique"
    )
    op.drop_column("payments", "autopay_next_retry_at")
    op.drop_column("payments", "autopay_attempt")
    op.drop_column("payments", "autopay_cycle_key")
