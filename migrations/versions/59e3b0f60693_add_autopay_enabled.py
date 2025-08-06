"""add autopay enabled

Revision ID: 59e3b0f60693
Revises: cc9e7b060768
Create Date: 2025-08-03 15:56:05.737950

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '59e3b0f60693'
down_revision = 'cc9e7b060768'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add autopay flags and charge id."""
    conn = op.get_bind()
    inspector = sa.inspect(conn)

    user_cols = {c["name"] for c in inspector.get_columns("users")}
    if "autopay_enabled" not in user_cols:
        op.add_column(
            "users",
            sa.Column("autopay_enabled", sa.Boolean(), server_default=sa.false()),
        )

    payment_cols = {c["name"] for c in inspector.get_columns("payments")}
    with op.batch_alter_table("payments") as batch_op:
        if "autopay" not in payment_cols:
            batch_op.add_column(
                sa.Column("autopay", sa.Boolean(), server_default=sa.false())
            )
        if "autopay_charge_id" not in payment_cols:
            batch_op.add_column(sa.Column("autopay_charge_id", sa.String()))
            batch_op.create_unique_constraint(
                "uq_payments_autopay_charge_id", ["autopay_charge_id"]
            )


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)

    user_cols = {c["name"] for c in inspector.get_columns("users")}
    if "autopay_enabled" in user_cols:
        op.drop_column("users", "autopay_enabled")

    payment_cols = {c["name"] for c in inspector.get_columns("payments")}
    with op.batch_alter_table("payments") as batch_op:
        if "autopay_charge_id" in payment_cols:
            batch_op.drop_constraint(
                "uq_payments_autopay_charge_id", type_="unique"
            )
            batch_op.drop_column("autopay_charge_id")
