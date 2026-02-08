"""add autopay rebill id

Revision ID: 2f3f2b9e0f35
Revises: ccb57d510742
Create Date: 2025-11-21 12:45:00.000000
"""

from alembic import op
import sqlalchemy as sa

revision = "2f3f2b9e0f35"
down_revision = "ccb57d510742"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("autopay_rebill_id", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "autopay_rebill_id")
