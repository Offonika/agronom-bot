"""expand photos user id to bigint

Revision ID: ccb57d510742
Revises: 20251116_add_plan_funnel_events
Create Date: 2025-11-17 18:07:00.617970

"""
from alembic import op
import sqlalchemy as sa



# revision identifiers, used by Alembic.
revision = 'ccb57d510742'
down_revision = '20251116_add_plan_funnel_events'
branch_labels = None
depends_on = None

TABLES = ("photos", "photo_usage", "payments", "events", "partner_orders")


def upgrade() -> None:
    for table in TABLES:
        op.alter_column(
            table,
            "user_id",
            existing_type=sa.Integer(),
            type_=sa.BigInteger(),
            existing_nullable=False,
        )


def downgrade() -> None:
    for table in TABLES:
        op.alter_column(
            table,
            "user_id",
            existing_type=sa.BigInteger(),
            type_=sa.Integer(),
            existing_nullable=False,
        )
