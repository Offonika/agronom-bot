"""add unique constraint to partner_order

Revision ID: 0b29760ca9fa
Revises: 1f3d1a8bb6d5
Create Date: 2025-08-05 20:33:00.833890
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '0b29760ca9fa'
down_revision = '1f3d1a8bb6d5'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("partner_orders") as batch_op:
        batch_op.create_unique_constraint(
            "uq_partner_orders_order_id", ["order_id"]
        )


def downgrade() -> None:
    with op.batch_alter_table("partner_orders") as batch_op:
        batch_op.drop_constraint("uq_partner_orders_order_id", type_="unique")

