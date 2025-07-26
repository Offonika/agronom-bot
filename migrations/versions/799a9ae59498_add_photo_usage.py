"""add photo_usage

Revision ID: 799a9ae59498
Revises: f2db7b89b8e4
Create Date: 2025-07-26 16:58:08.165523

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect



# revision identifiers, used by Alembic.
revision = '799a9ae59498'
down_revision = 'f2db7b89b8e4'
branch_labels = None
depends_on = None

def upgrade() -> None:
    """Add photo_usage table and pro_expires_at column."""

    op.create_table(
        "photo_usage",
        sa.Column("user_id", sa.Integer, nullable=False),
        sa.Column("month", sa.String(length=7), nullable=False),
        sa.Column("used", sa.Integer, nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("user_id", "month"),
    )
    op.create_index(
        "ix_photo_usage_user_id", "photo_usage", ["user_id"], unique=False
    )

    bind = op.get_bind()
    inspector = inspect(bind)
    if "pro_expires_at" not in [c.get("name") for c in inspector.get_columns("users")]:
        op.add_column("users", sa.Column("pro_expires_at", sa.DateTime))

def downgrade() -> None:
    """Drop photo_usage table and pro_expires_at column."""

    op.drop_index("ix_photo_usage_user_id", table_name="photo_usage")
    op.drop_table("photo_usage")

    bind = op.get_bind()
    inspector = inspect(bind)
    if "pro_expires_at" in [c.get("name") for c in inspector.get_columns("users")]:
        op.drop_column("users", "pro_expires_at")
