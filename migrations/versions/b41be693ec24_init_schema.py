"""init schema

Revision ID: b41be693ec24
Revises: 
Create Date: 2025-07-20 21:56:49.376862

"""
from alembic import op
import sqlalchemy as sa



# revision identifiers, used by Alembic.
revision = 'b41be693ec24'
down_revision = None
branch_labels = None
depends_on = None

def upgrade() -> None:
    payment_status = sa.Enum(
        "success",
        "fail",
        "cancel",
        "bank_error",
        name="payment_status",
    )
    photo_status = sa.Enum("pending", "ok", "retrying", name="photo_status")
    order_status = sa.Enum("new", "processed", "cancelled", name="order_status")
    error_code = sa.Enum(
        "NO_LEAF",
        "LIMIT_EXCEEDED",
        "GPT_TIMEOUT",
        "BAD_REQUEST",
        "UNAUTHORIZED",
        name="error_code",
    )

    payment_status.create(op.get_bind())
    photo_status.create(op.get_bind())
    order_status.create(op.get_bind())
    error_code.create(op.get_bind())

    op.create_table(
        "users",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("tg_id", sa.BigInteger, nullable=False),
        sa.Column("pro_expires_at", sa.DateTime),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )

    op.create_table(
        "protocols",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("crop", sa.String, nullable=False),
        sa.Column("disease", sa.String, nullable=False),
        sa.Column("product", sa.String, nullable=False),
        sa.Column("dosage_value", sa.Numeric),
        sa.Column("dosage_unit", sa.String),
        sa.Column("phi", sa.Integer),
    )

    op.create_table(
        "photos",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("file_id", sa.Text, nullable=False),
        sa.Column("crop", sa.Text),
        sa.Column("disease", sa.Text),
        sa.Column("confidence", sa.Numeric),
        sa.Column("status", photo_status, nullable=False),
        sa.Column("ts", sa.DateTime, server_default=sa.func.now()),
        sa.Column("deleted", sa.Boolean, server_default=sa.text("FALSE")),
    )

    op.create_index("photos_user_ts", "photos", ["user_id", "ts"], unique=False)

    op.create_table(
        "payments",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("amount", sa.Integer),
        sa.Column("source", sa.Text),
        sa.Column("status", payment_status, nullable=False),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
    )

    op.create_table(
        "partner_orders",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("order_id", sa.Text, nullable=False),
        sa.Column("protocol_id", sa.Integer, nullable=False),
        sa.Column("price_kopeks", sa.Integer, nullable=False),
        sa.Column("signature", sa.Text, nullable=False),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("status", order_status, nullable=False),
    )

    op.create_table(
        "photo_quota",
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("used_count", sa.Integer),
        sa.Column("month_year", sa.String(length=7)),
    )

def downgrade() -> None:
    op.drop_table("photo_quota")
    op.drop_table("partner_orders")
    op.drop_table("payments")
    op.drop_index("photos_user_ts", table_name="photos")
    op.drop_table("photos")
    op.drop_table("protocols")
    op.drop_table("users")

    for enum in ["error_code", "order_status", "photo_status", "payment_status"]:
        op.execute(sa.text(f"DROP TYPE IF EXISTS {enum}"))
