"""add provider payment id to payments

Revision ID: 20251230_add_provider_payment_id
Revises: 20251229_add_user_api_key
Create Date: 2025-12-30 10:00:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20251230_add_provider_payment_id"
down_revision = "20251229_add_user_api_key"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("payments", sa.Column("provider_payment_id", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("payments", "provider_payment_id")
